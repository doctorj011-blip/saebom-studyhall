#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 개학 학생 오전 교시 일괄 면제
//
// 학기가 시작된 학생은 평일 오전(1~6교시)에 학교에 있으므로 면학관 의무참석 대상이
// 아니다. 그런데 방학 시간표(settings/vacation_mode)가 켜져 있는 동안은 평일도 1교시부터
// 운영되므로, 그대로 두면 assessNoShowPenalties가 오전 교시마다 무단결석 2점을 매긴다.
// 이 스크립트는 대상 학생의 월~금 1~6교시를 x(개학)으로 바꿔 판정에서 빼준다.
//
//   미리보기 : node scripts/apply-school-start.js --seats 1,2,4
//   실제적용 : node scripts/apply-school-start.js --seats 1,2,4 --go
//   사유변경 : --reason "개학"      (기본값 개학)
//
// 규칙
//   - 7교시(18:00) 이후는 손대지 않는다. 학원·특강 표기가 학생마다 달라 그대로 보존해야 한다.
//   - 토요일도 손대지 않는다. 학교는 토요일에 안 간다.
//   - 쓰기 직전에 문서를 다시 읽으므로, 관리자가 그 사이 고친 7교시 이후 값은 유지된다.
//   - schedule_base(고정)·schedules(현재적용)·students(명단)·daily_reports(오늘) 네 곳에 함께 쓴다.
//     한 곳만 쓰면 새벽 2시 자동복귀나 학생앱 재접속 때 원래대로 돌아간다.
//   - 이미 1~6교시가 전부 x인 학생은 건너뛴다(멱등).
//
// 인증 불필요 — students/schedules/schedule_base/daily_reports 는 규칙이 열려 있다.
// ⚠️ 운영 DB에 직접 쓴다. 돌리기 전에 scripts/export-firestore.js 로 백업할 것.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const PROJECT = 'saebom-studyhall';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const WEEKDAYS = ['월', '화', '수', '목', '금'];
const MORNING_LAST = 6;   // 6교시(~17:00)까지가 오전. 7교시가 18:00 시작이다.

// ── 인자 ──
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const GO = argv.includes('--go');
const REASON = flag('--reason') || '개학';
const SEATS = String(flag('--seats') || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SEATS.length) {
  console.error('사용법: node scripts/apply-school-start.js --seats 1,2,4 [--reason 개학] [--go]');
  process.exit(1);
}

// ── 교시 문자열 변환 ──
// '1,2,3,x4(대수특강),...' 처럼 교시 토큰이 콤마로 이어진 형식. 접두사 x(불참)·m(중간입실)·
// e(중간퇴실) 뒤에 교시 번호가 온다. 1~6교시만 x{n}(사유)로 바꾸고 나머지는 원문 그대로 둔다.
function periodOf(token) {
  const m = String(token).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function morningsOff(schedule, reason) {
  const toks = String(schedule || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!toks.length) return null;
  return toks.map(t => {
    const n = periodOf(t);
    return (n >= 1 && n <= MORNING_LAST) ? `x${n}(${reason})` : t;
  }).join(',');
}
function alreadyOff(schedule) {
  const toks = String(schedule || '').split(',').map(t => t.trim()).filter(Boolean);
  const morn = toks.filter(t => { const n = periodOf(t); return n >= 1 && n <= MORNING_LAST; });
  return morn.length > 0 && morn.every(t => t.startsWith('x'));
}

// ── Firestore REST ──
const S = v => ({ stringValue: v });
// 한글 필드명(월·화…)은 백틱으로 감싸야 한다. 안 감싸면 400 Invalid property path.
const quote = k => /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(k) ? k : '`' + k + '`';

async function readDoc(col, id) {
  const r = await fetch(`${BASE}/${col}/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`읽기 실패 ${col}/${id}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function patchDoc(col, id, fields) {
  const mask = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(quote(k))}`).join('&');
  const r = await fetch(`${BASE}/${col}/${id}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`쓰기 실패 ${col}/${id}: ${r.status} ${await r.text()}`);
}

// 운영일 기준 날짜 — 11교시가 자정을 넘기므로 02시 이전은 아직 전날로 본다(관리자앱과 동일 규칙).
function operatingDay(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 2) d.setDate(d.getDate() - 1);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { iso, day: ['일', '월', '화', '수', '목', '금', '토'][d.getDay()] };
}

(async () => {
  const { iso: today, day: todayDay } = operatingDay();
  console.log(`대상 ${SEATS.length}명 · 사유 "${REASON}" · 오늘 ${today}(${todayDay}) · ${GO ? '실제 적용' : '미리보기'}`);

  let changed = 0, skipped = 0, failed = 0;

  for (const seat of SEATS) {
    try {
      const baseDoc = await readDoc('schedule_base', seat);
      if (!baseDoc) { console.log(`\n[${seat}] schedule_base 문서 없음 — 건너뜀`); skipped++; continue; }
      const f = baseDoc.fields || {};
      const name = (f.name && f.name.stringValue) || '';

      const next = {};
      for (const d of WEEKDAYS) {
        const cur = (f[d] && f[d].stringValue) || '';
        if (!cur) continue;
        if (alreadyOff(cur)) continue;
        const v = morningsOff(cur, REASON);
        if (v && v !== cur) next[d] = v;
      }

      if (!Object.keys(next).length) {
        console.log(`\n[${seat}] ${name} — 이미 오전 면제 상태, 건너뜀`);
        skipped++; continue;
      }

      console.log(`\n[${seat}] ${name}`);
      for (const d of WEEKDAYS) {
        if (!next[d]) continue;
        console.log(`   ${d}  ${f[d].stringValue}`);
        console.log(`       → ${next[d]}`);
      }
      if (!GO) { changed++; continue; }

      const payload = {};
      for (const [d, v] of Object.entries(next)) payload[d] = S(v);
      payload.updatedAt = S(new Date().toISOString());

      await patchDoc('schedule_base', seat, payload);
      await patchDoc('schedules', seat, { ...payload, changedBy: S('admin') });
      await patchDoc('students', seat, payload);

      // 오늘 요일이 평일이고 그 요일을 바꿨다면 당일 리포트도 맞춰준다.
      // (안 하면 오늘치 판정은 예전 값 그대로라 오전 무단결석이 계속 붙는다)
      if (next[todayDay]) {
        await patchDoc('daily_reports', `${today}_${seat}`, {
          name: S(name), seat: S(seat), date: S(today), day: S(todayDay),
          schedule: S(next[todayDay]), changedBy: S('admin'),
          updatedAt: S(new Date().toISOString()),
        });
      }
      console.log('   ✅ 저장 완료');
      changed++;
    } catch (e) {
      console.error(`   ❌ ${seat} 실패: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n── 완료: ${GO ? '적용' : '적용 예정'} ${changed}명 · 건너뜀 ${skipped}명 · 실패 ${failed}명`);
  if (!GO) console.log('   실제로 반영하려면 --go 를 붙여 다시 실행하세요.');
  if (failed) process.exit(1);
})();
