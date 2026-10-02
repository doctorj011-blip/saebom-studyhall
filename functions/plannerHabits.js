'use strict';
// 최근 4주 플래너 검사 기록 → 습관 지표 블록(프롬프트용 문자열).
// 모델에게 날짜별 숫자를 주고 "습관을 찾아라"고 하면 합계·평균을 틀린다. 그래서 숫자는
// 여기서 계산해 주고, 모델은 이걸 읽고 해석만 한다. list 는 최근순, stats 는 교정본 우선.
const DOW = '일월화수목금토';
const isWeekend = d => { const w = new Date(d).getDay(); return w === 0 || w === 6; };
const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const hh = h => (h >= 24 ? `새벽 ${h - 24}시` : `${h}시`);

function plannerHabitBlock(list, beforeDate) {
  const stOf = h => h.statsFixed || h.stats || {};
  const base = Date.parse(beforeDate);
  const rows = list
    .map(h => ({ h, st: stOf(h), ago: Math.round((base - Date.parse(h.date)) / 86400000) }))
    .filter(r => r.ago >= 1 && r.ago <= 28);
  if (rows.length < 5) return '';   // 대여섯 날도 안 되면 '습관'이라 부를 근거가 없다

  const wd = rows.filter(r => !isWeekend(r.h.date)), we = rows.filter(r => isWeekend(r.h.date));
  const tot = rs => rs.map(r => r.st.total_minutes).filter(v => v != null);
  const out = [`- 기록 ${rows.length}일 (평일 ${wd.length} · 주말 ${we.length})`];
  out.push(`- 하루 총량 평균: 평일 ${avg(tot(wd)) ?? '?'}분 / 주말 ${avg(tot(we)) ?? '?'}분`);

  // 주별 추이 — 4주 전 → 지난주. 기록이 있는 날만 평균 낸다(제출 안 한 날을 0으로 치지 않는다)
  const weeks = [3, 2, 1, 0].map(w => avg(tot(rows.filter(r => Math.floor((r.ago - 1) / 7) === w))));
  if (weeks.filter(v => v != null).length >= 2) {
    out.push(`- 주별 하루 평균(4주 전→지난주): ${weeks.map(v => (v == null ? '-' : v + '분')).join(' → ')}`);
  }

  // 평일 시작·마감 — 타임테이블(hourly)이 있는 날만. 15시 이후 첫 칸을 방과 후 시작으로 본다.
  // 0~5시는 전날 밤의 연장이라 24~29로 올려서 비교한다.
  const starts = [], ends = [];
  let lateNights = 0, ttDays = 0;
  for (const r of rows) {
    const hs = (r.st.hourly || []).filter(x => x && x.minutes > 0).map(x => (x.hour < 6 ? x.hour + 24 : x.hour));
    if (!hs.length) continue;
    ttDays++;
    const end = Math.max(...hs);
    ends.push(end);
    if (end >= 24) lateNights++;
    const after = hs.filter(h => h >= 15);
    if (!isWeekend(r.h.date) && after.length) starts.push(Math.min(...after));
  }
  if (starts.length >= 3) out.push(`- 평일 방과 후 시작(중앙값): ${hh(median(starts))} (${starts.length}일 기준, 가장 늦은 날 ${hh(Math.max(...starts))})`);
  if (ends.length >= 3) out.push(`- 마지막 공부 시각(중앙값): ${hh(median(ends))} / 자정 넘긴 날 ${lateNights}일 (타임테이블 있는 ${ttDays}일 중)`);

  // 완료율
  const rates = rows.filter(r => r.st.planned_count > 0).map(r => Math.min(1, r.st.completed_count / r.st.planned_count));
  if (rates.length >= 3) {
    out.push(`- 계획 완료율 평균 ${Math.round(avg(rates.map(x => x * 100)))}% (전부 완료 ${rates.filter(x => x >= 1).length}일 · 절반 미만 ${rates.filter(x => x < 0.5).length}일, ${rates.length}일 중)`);
  }

  // 과목 비중과 등장 일수
  const subj = {};
  let all = 0;
  for (const r of rows) for (const s of (r.st.subjects || [])) {
    if (!s || !s.name) continue;
    const a = subj[s.name] || (subj[s.name] = { min: 0, days: 0 });
    a.min += s.minutes || 0; a.days++; all += s.minutes || 0;
  }
  const subjLine = Object.entries(subj).sort((a, b) => b[1].min - a[1].min)
    .map(([n, a]) => `${n} ${all ? Math.round(a.min * 100 / all) : 0}%(${a.days}일)`).join(' · ');
  if (subjLine) out.push(`- 과목 비중(시간 %, 등장 일수): ${subjLine}`);

  // 요일별 — 특정 요일마다 무너지는 패턴(학원 가는 날 등)을 보려고
  const byDow = {};
  for (const r of rows) {
    if (r.st.total_minutes == null) continue;
    (byDow[new Date(r.h.date).getDay()] ||= []).push(r.st.total_minutes);
  }
  const dowLine = [1, 2, 3, 4, 5, 6, 0].filter(d => byDow[d]).map(d => `${DOW[d]} ${avg(byDow[d])}`).join(' · ');
  if (dowLine) out.push(`- 요일별 하루 평균(분): ${dowLine}`);

  // 인강·학원 비중 — 듣기만 하고 손으로 푸는 시간이 적은지 가늠하는 단서
  const has = k => rows.filter(r => (r.st.materials || []).some(m => m && m.kind === k)).length;
  out.push(`- 인강이 적힌 날 ${has('인강')}일 · 학원 숙제·교재가 적힌 날 ${has('학원')}일 (${rows.length}일 중)`);

  return `\n\n[최근 4주 습관 지표 — 코드가 계산한 값, 오늘치 제외]\n` + out.join('\n') +
    '\n※ 이미 계산된 값이니 다시 더하지 말고 그대로 쓸 것. 타임테이블이 없는 날은 시각 지표에서 빠져 있다.';
}

module.exports = { plannerHabitBlock };

if (require.main === module) {
  const mk = (date, total, hourly, extra = {}) => ({ date, stats: { total_minutes: total, planned_count: 4, completed_count: 2, subjects: [{ name: '수학', minutes: total }], hourly, materials: [], ...extra } });
  const list = [
    mk('2026-10-02', 200, [{ hour: 19, subject: '수학', minutes: 60 }, { hour: 0, subject: '수학', minutes: 60 }]),
    mk('2026-10-01', 180, [{ hour: 18, subject: '수학', minutes: 60 }, { hour: 23, subject: '수학', minutes: 60 }]),
    mk('2026-09-30', 160, [{ hour: 20, subject: '수학', minutes: 60 }, { hour: 9, subject: '수학', minutes: 30 }]),
    mk('2026-09-27', 400, []),   // 일요일
    mk('2026-09-25', 100, []),
  ];
  const b = plannerHabitBlock(list, '2026-10-03');
  console.log(b);
  console.assert(b.includes('평일 4 · 주말 1'), 'weekday split');
  console.assert(b.includes('방과 후 시작(중앙값): 19시'), 'start median ignores 9am');
  console.assert(b.includes('자정 넘긴 날 1일'), 'late night');
  console.assert(plannerHabitBlock(list.slice(0, 4), '2026-10-03') === '', 'needs 5 days');
}
