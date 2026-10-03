'use strict';
// 이용조사 '희망' → 이용기간(students.expiry) 한 달 연장 — 판정만 하는 순수 함수.
// 트리거(index.js surveyAutoExtend)가 응답 문서와 학생의 지금 expiry 를 넘기면,
// 무엇을 써야 하는지만 돌려준다. 실행: node functions/surveyExtend.js (자체 검사)
//
// 규칙
//   · 희망(want:true)  → expiry 를 조사한 달 말일로. 이미 그보다 뒤면(고3 수능일 등) 줄이지 않는다.
//     무엇을 바꿨는지 응답 문서에 extended{from,to} 로 남긴다 — 되돌릴 때 쓴다.
//   · 이용 안 함으로 바뀜(want:false) + extended 있음 → 원래 expiry 로 되돌린다.
//     단 그 사이 관리앱에서 expiry 를 손으로 고쳤으면(to 와 다르면) 건드리지 않는다.
//   · 그 밖(이미 연장함, 응답 없음)은 null.

function monthEnd(sid) {
  const m = String(sid || '').match(/^(\d{4})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return `${m[1]}-${m[2]}-${String(new Date(+m[1], +m[2], 0).getDate()).padStart(2, '0')}`;
}

// → null | { expiry: 'YYYY-MM-DD'|'', extended: {from,to}|null(지움) }
function plan(resp, expiry) {
  const r = resp || {};
  const cur = String(expiry || '');
  if (r.want === true && !r.extended) {
    const to = monthEnd(r.surveyId);
    if (!to || cur >= to) return null;
    return { expiry: to, extended: { from: cur, to } };
  }
  if (r.want === false && r.extended && r.extended.to) {
    return { expiry: cur === r.extended.to ? String(r.extended.from || '') : null, extended: null };
  }
  return null;
}

module.exports = { monthEnd, plan };

if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(monthEnd('2026-11'), '2026-11-30');
  assert.strictEqual(monthEnd('2027-02'), '2027-02-28');
  assert.strictEqual(monthEnd('bad'), '');
  // 희망 → 말일까지
  assert.deepStrictEqual(plan({ surveyId: '2026-11', want: true }, '2026-10-31'),
    { expiry: '2026-11-30', extended: { from: '2026-10-31', to: '2026-11-30' } });
  // 이미 더 길면 그대로
  assert.strictEqual(plan({ surveyId: '2026-11', want: true }, '2026-12-15'), null);
  // 이미 연장했으면 다시 안 함(자기 쓰기로 다시 불려도 멈춘다)
  assert.strictEqual(plan({ surveyId: '2026-11', want: true, extended: { from: 'x', to: '2026-11-30' } }, '2026-11-30'), null);
  // 안 함으로 바뀜 → 되돌림
  assert.deepStrictEqual(plan({ surveyId: '2026-11', want: false, extended: { from: '2026-10-31', to: '2026-11-30' } }, '2026-11-30'),
    { expiry: '2026-10-31', extended: null });
  // 그 사이 손으로 고쳤으면 expiry 는 두고 표시만 지운다
  assert.deepStrictEqual(plan({ surveyId: '2026-11', want: false, extended: { from: '2026-10-31', to: '2026-11-30' } }, '2026-11-20'),
    { expiry: null, extended: null });
  assert.strictEqual(plan({ surveyId: '2026-11', want: false }, '2026-10-31'), null);
  console.log('surveyExtend ok');
}
