#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 학생ID(uid) 부여 — 이관 1단계
//
//   계획 : node scripts/assign-uid.js [--out <폴더>]
//   적용 : node scripts/assign-uid.js --apply <계획파일.json>
//
// 하는 일 (1단계 범위)
//   - 현재 명부 + 이력에 등장하는 모든 이름 표기를 모아 '사람' 단위 신원 목록을 만든다
//   - 신원마다 불변 uid 를 붙인다
//   - students/{좌석} 문서에 uid 필드를 추가한다 (문서ID는 건드리지 않는다)
//   - 전체 신원 목록을 students/_meta_uid_registry 에 저장한다 (2단계 백필이 이걸 쓴다)
//
// 안 하는 일
//   - 이력 기록에 uid 를 채우지 않는다 (2단계)
//   - 문서ID를 바꾸지 않는다 (4단계)
//   → 이 단계는 필드가 하나 늘 뿐이라 기존 코드에 아무 영향이 없다. 원복은 uid 필드 삭제.
//
// 왜 계획파일을 거치는가
//   uid 는 한 번 정하면 바꾸기 어렵다. 계획을 파일로 뽑아 사람이 눈으로 확인한 뒤
//   그 파일 그대로 적용해야, 확인한 것과 적용된 것이 같음을 보장할 수 있다.
//
// 왜 새 컬렉션(student_identities)을 안 쓰는가
//   firestore.rules 맨 아래 catch-all 이 신규 컬렉션을 전부 차단한다. 규칙 배포는 수동이라
//   단계가 늘어난다. students 는 이미 열려 있고 _meta_* 문서 관례가 있으므로 그걸 쓴다.
//   ⚠️ 레지스트리 문서에 최상위 name 필드를 두면 안 된다. 3앱·Functions 전부
//      `if (!v.name) return` 으로 메타 문서를 걸러내므로, name 이 있으면 유령 학생이 된다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = 'saebom-studyhall';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REPO = path.resolve(__dirname, '..');
const REGISTRY_DOC = '_meta_uid_registry';

// 이력에서 이름을 긁어올 컬렉션 → 이름이 담긴 필드명
// (sms_logs 만 필드명이 student 다. checkin_logs·attendance_sessions 는 studentName)
const NAME_SOURCES = {
  daily_reports: 'name', planners: 'name', penalties: 'name', merits: 'name',
  planner_ai_reviews: 'name', studyroom_requests: 'name', usage_logs: 'name',
  consultations: 'name', student_memos: 'name', schedules: 'name', schedule_base: 'name',
  attendance_sessions: 'studentName', checkin_logs: 'studentName', sms_logs: 'student',
  withdrawn_students: 'name',
};

// ── 이름 정규화·동일인 판정 (saebom-common.js 와 같은 규칙) ──
const norm = n => String(n == null ? '' : n).trim().replace(/\s+/g, '').replace(/\(\d+\)$/, '');
function sameName(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const lo = x.length < y.length ? x : y, hi = x.length < y.length ? y : x;
  return hi.indexOf(lo) === 0 && /^[A-Za-z0-9]$/.test(hi.slice(lo.length));
}
const seatOf = v => String(v ?? '').replace(/[^0-9]/g, '');

// ── REST ──
const val = v => v == null ? null
  : 'stringValue' in v ? v.stringValue
  : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue
  : 'timestampValue' in v ? v.timestampValue
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

const newUid = () => 's_' + crypto.randomBytes(4).toString('hex');
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

// ═══════════════════════ 계획 수립 ═══════════════════════
async function buildPlan(outRoot) {
  console.log('운영 데이터 수집 중...\n');

  const students = (await fetchAll('students')).filter(s => !s.id.startsWith('_meta') && s.name);
  console.log(`현재 명부: ${students.length}명`);

  // 1) 현재 명부를 신원의 뼈대로 삼는다. 좌석이 곧 지금 자리이므로 신원 구분에 쓸 수 있다.
  const identities = students.map(s => ({
    uid: newUid(),
    name: s.name,
    normName: norm(s.name),
    currentSeat: seatOf(s.seat ?? s.id),
    status: 'active',
    spellings: new Set([s.name]),
  }));

  // 2) 이력에 등장하는 모든 이름 표기를 (표기 → 함께 나온 좌석들) 로 모은다
  const rawSeen = new Map(); // 원문표기 -> { seats:Map<좌석,건수>, total, cols:Set }
  for (const [col, field] of Object.entries(NAME_SOURCES)) {
    let docs;
    try { docs = await fetchAll(col); }
    catch (e) { console.log(`  ⚠️ ${col} 건너뜀: ${e.message}`); continue; }
    for (const d of docs) {
      const raw = d[field];
      if (!raw) continue;
      if (!rawSeen.has(raw)) rawSeen.set(raw, { seats: new Map(), total: 0, cols: new Set() });
      const e = rawSeen.get(raw);
      e.total++;
      e.cols.add(col);
      const st = seatOf(d.seatKey ?? d.seat ?? (typeof d.id === 'string' && d.id.includes('_') ? d.id.split('_').find(p => /^\d+$/.test(p)) : ''));
      if (st) e.seats.set(st, (e.seats.get(st) || 0) + 1);
    }
  }
  console.log(`이력에 등장하는 이름 표기: ${rawSeen.size}가지\n`);

  // 3) 각 표기를 신원에 배정
  const decisions = [];   // 사람 확인이 필요한 건
  const assigned = [];    // 표기 -> uid

  for (const [raw, info] of [...rawSeen.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const cands = identities.filter(id => sameName(raw, id.name));

    if (cands.length === 1) {
      cands[0].spellings.add(raw);
      assigned.push({ raw, uid: cands[0].uid, name: cands[0].name, docs: info.total, by: 'name' });
      continue;
    }

    if (cands.length === 0) {
      // 이력에만 있는 사람(퇴원생 등). 같은 이력 표기끼리는 합친다.
      let hist = identities.find(id => id.status === 'history' && sameName(raw, id.name));
      if (!hist) {
        hist = { uid: newUid(), name: raw, normName: norm(raw), currentSeat: null, status: 'history', spellings: new Set() };
        identities.push(hist);
      }
      hist.spellings.add(raw);
      assigned.push({ raw, uid: hist.uid, name: hist.name, docs: info.total, by: 'history' });
      continue;
    }

    // 후보가 여럿 — 이름만으로는 못 가른다(동명이인).
    // 좌석 동시등장을 근거로 후보를 좁혀 '제안'은 하되, 자동 확정하지 않는다.
    // 이름이 겹치는 두 사람의 기록을 잘못 붙이면 되돌리기가 매우 어렵기 때문이다.
    const seats = [...info.seats.keys()];
    const bySeat = cands.filter(c => c.currentSeat && seats.includes(c.currentSeat));
    decisions.push({
      raw,
      docs: info.total,
      seats: [...info.seats.entries()].map(([s, n]) => `${s}번(${n}건)`),
      collections: [...info.cols],
      candidates: cands.map(c => ({ uid: c.uid, name: c.name, currentSeat: c.currentSeat })),
      suggested: bySeat.length === 1 ? bySeat[0].uid : null,
      suggestedReason: bySeat.length === 1
        ? `이 표기가 등장한 좌석과 현재 좌석이 일치하는 후보가 하나뿐`
        : `좌석으로도 못 가름 — 직접 지정 필요`,
      chosenUid: null,   // ← 사람이 채워야 하는 칸
    });
  }

  // 4) 계획 파일
  const plan = {
    project: PROJECT,
    stage: 1,
    createdAt: new Date().toISOString(),
    summary: {
      activeStudents: identities.filter(i => i.status === 'active').length,
      historyOnly: identities.filter(i => i.status === 'history').length,
      totalIdentities: identities.length,
      spellings: rawSeen.size,
      needsDecision: decisions.length,
    },
    identities: identities.map(i => ({
      uid: i.uid, name: i.name, currentSeat: i.currentSeat, status: i.status,
      spellings: [...i.spellings],
    })),
    seatToUid: Object.fromEntries(identities.filter(i => i.currentSeat).map(i => [i.currentSeat, i.uid])),
    assigned,
    decisions,
  };

  fs.mkdirSync(outRoot, { recursive: true });
  const file = path.join(outRoot, `uid-plan_${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');

  // ── 보고 ──
  console.log('─'.repeat(70));
  console.log(`신원 ${plan.summary.totalIdentities}명 = 재적 ${plan.summary.activeStudents} + 이력전용 ${plan.summary.historyOnly}`);
  console.log(`이름 표기 ${plan.summary.spellings}가지를 신원에 배정`);
  console.log('─'.repeat(70));

  if (decisions.length) {
    console.log(`\n❗ 사람이 정해야 하는 건 ${decisions.length}개 — 이름만으로 구분이 안 됩니다\n`);
    for (const d of decisions) {
      console.log(`  표기 "${d.raw}"  (${d.docs}건, 좌석 ${d.seats.join(' ')})`);
      for (const c of d.candidates) console.log(`     후보 ${c.uid}  ${c.name} (현재 ${c.currentSeat}번)`);
      console.log(`     제안: ${d.suggested || '없음'} — ${d.suggestedReason}`);
      console.log('');
    }
    console.log(`계획파일의 decisions[].chosenUid 에 uid 를 적어 넣은 뒤 --apply 하십시오.`);
  } else {
    console.log('\n✅ 모호한 표기 없음 — 바로 적용 가능합니다');
  }

  console.log(`\n계획파일: ${file}`);
  console.log(`적용    : node scripts/assign-uid.js --apply "${file}"`);
  return 0;
}

// ═══════════════════════ 적용 ═══════════════════════
async function applyPlan(planFile) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (plan.stage !== 1) throw new Error('1단계 계획파일이 아닙니다');

  const unresolved = (plan.decisions || []).filter(d => !d.chosenUid);
  if (unresolved.length) {
    console.error(`❌ 아직 정해지지 않은 건이 ${unresolved.length}개 있습니다:`);
    for (const d of unresolved) console.error(`   "${d.raw}" → chosenUid 가 비어 있음`);
    console.error(`\n계획파일을 열어 chosenUid 를 채운 뒤 다시 실행하십시오.`);
    return 1;
  }
  // 지정된 uid 가 실재하는 신원인지 확인 — 오타로 엉뚱한 값이 들어가는 걸 막는다
  const known = new Set(plan.identities.map(i => i.uid));
  for (const d of plan.decisions || []) {
    if (!known.has(d.chosenUid)) { console.error(`❌ "${d.raw}" 의 chosenUid(${d.chosenUid})가 신원 목록에 없습니다`); return 1; }
  }

  // 결정 사항을 신원의 표기 목록에 반영
  for (const d of plan.decisions || []) {
    const id = plan.identities.find(i => i.uid === d.chosenUid);
    if (!id.spellings.includes(d.raw)) id.spellings.push(d.raw);
  }

  console.log(`적용 대상: 재적 학생 ${plan.summary.activeStudents}명의 students 문서 + 레지스트리 1개\n`);

  // 1) 각 students/{좌석} 문서에 uid 필드만 추가 (updateMask 로 부분 수정 — 문서 전체를 덮지 않는다)
  let ok = 0, fail = 0;
  for (const id of plan.identities.filter(i => i.status === 'active' && i.currentSeat)) {
    const url = `${BASE}/students/${encodeURIComponent(id.currentSeat)}?updateMask.fieldPaths=uid`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { uid: { stringValue: id.uid } } }),
    });
    if (res.ok) { ok++; process.stdout.write(`  ${id.currentSeat}번 ${id.name} → ${id.uid}\n`); }
    else { fail++; console.log(`  ❌ ${id.currentSeat}번 ${id.name}: HTTP ${res.status}`); }
  }

  // 2) 레지스트리 — ⚠️ 최상위 name 필드를 두지 않는다(두면 유령 학생이 된다)
  const registry = {
    fields: {
      kind: { stringValue: 'uid_registry' },
      stage: { integerValue: '1' },
      updatedAt: { stringValue: new Date().toISOString() },
      identities: { stringValue: JSON.stringify(plan.identities) },
      seatToUid: { stringValue: JSON.stringify(plan.seatToUid) },
    },
  };
  const rres = await fetch(`${BASE}/students/${REGISTRY_DOC}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registry),
  });

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`students 문서: 성공 ${ok} / 실패 ${fail}`);
  console.log(`레지스트리    : ${rres.ok ? '저장 완료' : `❌ HTTP ${rres.status}`}`);
  if (fail || !rres.ok) { console.log(`\n❌ 일부 실패 — 다시 실행하면 성공한 건은 같은 값으로 덮어써지므로 안전합니다.`); return 1; }
  console.log(`\n✅ 1단계 완료. 검증: node scripts/assign-uid.js --verify`);
  return 0;
}

// ═══════════════════════ 검증 ═══════════════════════
async function verify() {
  const students = await fetchAll('students');
  const reg = students.find(s => s.id === REGISTRY_DOC);
  const real = students.filter(s => !s.id.startsWith('_meta') && s.name);

  console.log(`재적 학생 ${real.length}명`);
  const missing = real.filter(s => !s.uid);
  const dup = new Map();
  for (const s of real) if (s.uid) dup.set(s.uid, (dup.get(s.uid) || 0) + 1);
  const collisions = [...dup.entries()].filter(([, n]) => n > 1);

  console.log(`  uid 있음   : ${real.length - missing.length}`);
  console.log(`  uid 없음   : ${missing.length}${missing.length ? ' → ' + missing.map(s => `${s.seat}번 ${s.name}`).join(', ') : ''}`);
  console.log(`  uid 중복   : ${collisions.length}${collisions.length ? ' → ' + collisions.map(([u, n]) => `${u}×${n}`).join(', ') : ''}`);
  console.log(`  레지스트리 : ${reg ? '있음' : '❌ 없음'}`);
  if (reg && reg.name) console.log(`  ⚠️ 레지스트리 문서에 name 필드가 있습니다 — 유령 학생으로 잡힙니다. 제거 필요.`);
  if (reg) {
    try { console.log(`  신원 수     : ${JSON.parse(reg.identities).length}명`); }
    catch (e) { console.log(`  ❌ 레지스트리 파싱 실패: ${e.message}`); }
  }
  const bad = missing.length || collisions.length || !reg || (reg && reg.name);
  console.log(bad ? '\n❌ 문제 있음' : '\n✅ 1단계 정상');
  return bad ? 1 : 0;
}

// ⚠️ process.exit() 를 쓰지 않는다. Windows 에서 fetch 소켓이 열린 채로 강제 종료하면
//    libuv 가 assertion 으로 죽어(UV_HANDLE_CLOSING) 종료코드가 127로 뭉개진다.
//    실패를 종료코드로 알리는 게 이 스크립트의 목적이므로 exitCode 만 세팅하고 자연 종료시킨다.
(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--verify')) return verify();
  const ai = argv.indexOf('--apply');
  if (ai !== -1) {
    if (!argv[ai + 1]) { console.error('사용법: node scripts/assign-uid.js --apply <계획파일.json>'); return 2; }
    return applyPlan(path.resolve(argv[ai + 1]));
  }
  const oi = argv.indexOf('--out');
  const outRoot = oi !== -1 && argv[oi + 1] ? path.resolve(argv[oi + 1]) : path.resolve(REPO, '..', 'saebom-backup');
  return buildPlan(outRoot);
})().then(code => { process.exitCode = code || 0; })
    .catch(e => { console.error(e); process.exitCode = 1; });
