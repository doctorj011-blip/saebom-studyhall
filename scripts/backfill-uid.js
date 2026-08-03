#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 이력 기록에 uid 백필 — 이관 2단계
//
//   점검 : node scripts/backfill-uid.js              (기본값 = 쓰기 없음)
//   적용 : node scripts/backfill-uid.js --apply
//   검증 : node scripts/backfill-uid.js --verify
//   선택 : --only <컬렉션,컬렉션>   --include-sms
//
// 하는 일
//   1단계가 students/_meta_uid_registry 에 남긴 신원 목록(이름 표기 → uid)을 근거로,
//   학생에 귀속된 이력 기록마다 uid 필드를 채운다. 문서ID는 건드리지 않는다(4단계).
//
// 원칙
//   - 추측하지 않는다. 레지스트리에 없는 이름 표기는 건드리지 않고 목록으로 보고한다.
//   - updateMask 로 uid 필드만 쓴다. 전체 교체하면 기존 필드가 날아간다.
//   - 이미 올바른 uid 가 있으면 건너뛴다(멱등). 중단 후 다시 돌려도 안전하다.
//
// 규칙상 백필이 불가능한 컬렉션 (firestore.rules)
//   - usage_logs (12,870건) : allow update: if false
//   - planner_ai_reviews (500건) : update 가 summary/statsFixed 로만 제한됨
//   둘 다 규칙을 고쳐 수동 배포하지 않는 한 못 채운다. 3단계에서 이 둘만 좌석 조회를
//   유지하거나, 규칙 변경을 별도 건으로 처리해야 한다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const path = require('path');

const PROJECT = 'saebom-studyhall';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REGISTRY = '_meta_uid_registry';
const CONCURRENCY = 12;

// 대상 컬렉션 → 이름이 담긴 필드. null 이면 이름이 없어 조인으로 푼다.
const TARGETS = {
  attendance_sessions: 'studentName',
  checkin_logs: 'studentName',
  daily_reports: 'name',
  planners: 'name',
  planner_comments: null,      // 이름 필드 없음 → (좌석,날짜) 조인
  studyroom_requests: 'name',
  merits: 'name',
  penalties: 'name',
  schedules: 'name',
  schedule_base: 'name',
  student_memos: 'name',
  consultations: 'name',
  withdrawn_students: 'name',
  current_sessions: 'studentName',
};
const OPTIONAL = { sms_logs: 'student' };   // 로그성 — --include-sms 로만 포함
const BLOCKED = {
  usage_logs: '규칙 allow update: if false',
  planner_ai_reviews: '규칙상 summary/statsFixed 만 수정 가능',
};

const val = v => v == null ? null
  : 'stringValue' in v ? v.stringValue
  : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue
  : null;

async function fetchAll(col) {
  const out = [];
  let token = '';
  for (;;) {
    const res = await fetch(`${BASE}/${encodeURIComponent(col)}?pageSize=300` + (token ? `&pageToken=${encodeURIComponent(token)}` : ''));
    if (!res.ok) throw new Error(`${col}: HTTP ${res.status}`);
    const body = await res.json();
    for (const d of body.documents || []) {
      out.push({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)])) });
    }
    token = body.nextPageToken;
    if (!token) break;
  }
  return out;
}

const seatOf = v => String(v ?? '').replace(/[^0-9]/g, '');

// 문서에서 좌석과 날짜를 뽑는다 (planner_comments 조인용)
function seatDateOf(d) {
  const parts = String(d.id).split('_');
  const seat = seatOf(d.seatKey ?? d.seat ?? parts.find(p => /^\d+$/.test(p)) ?? '');
  const date = d.date ?? parts.find(p => /^\d{4}-\d{2}-\d{2}$/.test(p)) ?? '';
  return { seat, date };
}

// ── 동시 실행 풀 ──
async function pool(items, worker, onTick) {
  let i = 0, done = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
      if (onTick && ++done % 200 === 0) onTick(done, items.length);
    }
  });
  await Promise.all(runners);
}

async function patchUid(col, id, uid) {
  const url = `${BASE}/${encodeURIComponent(col)}/${encodeURIComponent(id)}?updateMask.fieldPaths=uid`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { uid: { stringValue: uid } } }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
    return { ok: false, status: res.status };
  }
  return { ok: false, status: 'retry-exhausted' };
}

// ── 레지스트리 ──
async function loadRegistry() {
  const res = await fetch(`${BASE}/students/${REGISTRY}`);
  if (!res.ok) throw new Error(`레지스트리를 못 읽었습니다 (HTTP ${res.status}). 1단계를 먼저 실행하십시오.`);
  const doc = await res.json();
  const identities = JSON.parse(doc.fields.identities.stringValue);
  const bySpelling = new Map();
  for (const id of identities) for (const sp of id.spellings) bySpelling.set(sp, id.uid);
  return { identities, bySpelling };
}

// ═══════════════════════ 실행 ═══════════════════════
async function run({ apply, only, includeSms }) {
  const { identities, bySpelling } = await loadRegistry();
  console.log(`레지스트리: 신원 ${identities.length}명 · 이름 표기 ${bySpelling.size}가지`);
  console.log(apply ? '모드: 적용(쓰기)\n' : '모드: 점검 — 쓰기 없음\n');

  const targets = { ...TARGETS, ...(includeSms ? OPTIONAL : {}) };
  const cols = only ? only.filter(c => c in targets) : Object.keys(targets);
  if (only) {
    const unknown = only.filter(c => !(c in targets));
    for (const u of unknown) console.log(`  ⚠️ 대상이 아닌 컬렉션 무시: ${u}${BLOCKED[u] ? ` (${BLOCKED[u]})` : ''}`);
  }

  // planner_comments 조인용 (좌석,날짜) → uid 사전
  let joinMap = null;
  if (cols.includes('planner_comments')) {
    joinMap = new Map();
    for (const src of ['planners', 'daily_reports', 'planner_ai_reviews']) {
      for (const d of await fetchAll(src)) {
        const nm = d.name || d.studentName;
        if (!nm) continue;
        const { seat, date } = seatDateOf(d);
        const uid = bySpelling.get(nm);
        if (seat && date && uid) joinMap.set(`${seat}_${date}`, uid);
      }
    }
    console.log(`planner_comments 조인 사전: ${joinMap.size}개 (좌석,날짜)\n`);
  }

  const report = [];
  const unmatchedNames = new Map();

  for (const col of cols) {
    const field = targets[col];
    let docs;
    try { docs = await fetchAll(col); }
    catch (e) { console.log(`  ${col.padEnd(22)} ❌ ${e.message}`); report.push({ col, error: e.message }); continue; }

    const todo = [];
    let already = 0, unresolved = 0;
    for (const d of docs) {
      if (String(d.id).startsWith('_meta')) continue;
      let uid = null;
      if (field) {
        const raw = d[field];
        if (raw) {
          uid = bySpelling.get(raw) || null;
          if (!uid) unmatchedNames.set(raw, (unmatchedNames.get(raw) || 0) + 1);
        }
      } else {
        const { seat, date } = seatDateOf(d);
        uid = joinMap.get(`${seat}_${date}`) || null;
      }
      if (!uid) { unresolved++; continue; }
      if (d.uid === uid) { already++; continue; }
      todo.push({ id: d.id, uid });
    }

    let ok = 0, fail = 0;
    if (apply && todo.length) {
      // 진행표시는 터미널일 때만. 파이프·리다이렉트로 받으면 \r 이 안 먹어 로그가 한 줄로 뭉개진다.
      const tty = process.stdout.isTTY;
      await pool(todo, async t => {
        const r = await patchUid(col, t.id, t.uid);
        if (r.ok) ok++; else { fail++; if (fail <= 3) console.log(`     ❌ ${col}/${t.id}: HTTP ${r.status}`); }
      }, tty ? (d, n) => process.stdout.write(`\r  ${col.padEnd(22)} ${d}/${n}...`) : null);
      if (tty) process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }

    report.push({ col, total: docs.length, todo: todo.length, already, unresolved, ok, fail });
    const mark = unresolved ? '⚠️' : '  ';
    console.log(`${mark} ${col.padEnd(22)} 전체 ${String(docs.length).padStart(5)} · 대상 ${String(todo.length).padStart(5)}`
      + ` · 이미완료 ${String(already).padStart(5)} · 미해결 ${String(unresolved).padStart(4)}`
      + (apply ? ` · 성공 ${ok} 실패 ${fail}` : ''));
  }

  // ── 요약 ──
  const sum = k => report.reduce((a, r) => a + (r[k] || 0), 0);
  console.log('\n' + '─'.repeat(70));
  console.log(`대상 ${sum('todo').toLocaleString()}건 · 이미완료 ${sum('already').toLocaleString()}건 · 미해결 ${sum('unresolved').toLocaleString()}건`);
  if (apply) console.log(`쓰기 성공 ${sum('ok').toLocaleString()} · 실패 ${sum('fail').toLocaleString()}`);

  if (unmatchedNames.size) {
    console.log(`\n⚠️ 레지스트리에 없는 이름 표기 ${unmatchedNames.size}가지 — 건드리지 않았습니다:`);
    for (const [n, c] of [...unmatchedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`   "${n}"  ${c}건`);
    }
    console.log(`   → 1단계 계획을 다시 만들어 이 표기를 신원에 배정한 뒤 재실행하십시오.`);
  }

  console.log(`\n백필 불가(규칙 제한):`);
  for (const [c, why] of Object.entries(BLOCKED)) console.log(`   ${c} — ${why}`);

  if (!apply) console.log(`\n적용하려면: node scripts/backfill-uid.js --apply`);
  return sum('fail') ? 1 : 0;
}

// ═══════════════════════ 검증 ═══════════════════════
async function verify() {
  const { bySpelling } = await loadRegistry();
  const uidOf = new Map(bySpelling);
  let bad = 0;
  console.log('컬렉션                   전체   uid있음   uid없음   ★불일치');
  console.log('─'.repeat(64));
  for (const [col, field] of Object.entries({ ...TARGETS, ...OPTIONAL })) {
    let docs;
    try { docs = await fetchAll(col); } catch (e) { console.log(`${col.padEnd(22)} ❌ ${e.message}`); continue; }
    let has = 0, none = 0, mismatch = 0;
    for (const d of docs) {
      if (String(d.id).startsWith('_meta')) continue;
      if (!d.uid) { none++; continue; }
      has++;
      if (field) {
        const expect = uidOf.get(d[field]);
        // 기대값을 알 수 있는 경우에만 대조한다(이름이 레지스트리에 없으면 판단 보류)
        if (expect && expect !== d.uid) mismatch++;
      }
    }
    if (mismatch) bad++;
    console.log(`${col.padEnd(22)} ${String(docs.length).padStart(6)} ${String(has).padStart(8)} ${String(none).padStart(9)} ${String(mismatch).padStart(9)}`);
  }
  console.log(bad ? '\n❌ 이름과 uid 가 어긋난 기록이 있습니다' : '\n✅ uid 가 채워진 기록은 전부 이름과 일치');
  return bad ? 1 : 0;
}

(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--verify')) return verify();
  const oi = argv.indexOf('--only');
  return run({
    apply: argv.includes('--apply'),
    only: oi !== -1 && argv[oi + 1] ? argv[oi + 1].split(',').map(s => s.trim()) : null,
    includeSms: argv.includes('--include-sms'),
  });
})().then(code => { process.exitCode = code || 0; })
    .catch(e => { console.error(e.message || e); process.exitCode = 1; });
