// ═══════════════════════════════════════════════════════════════
// saebom-common.js — 새봄면학관 3앱(관리자/학생/학부모) 공용 유틸
// ⚠️ 반드시 세 HTML 파일과 같은 폴더에 함께 배포할 것.
//    (각 HTML에 비상용 폴백이 있어 이 파일이 없어도 죽지는 않지만,
//     세 앱의 동작 불일치를 막으려면 수정은 항상 이 파일에서만 한다)
// ═══════════════════════════════════════════════════════════════

// ── 누적시간 key 헬퍼 (YYYY-MM) ──
// hours 객체의 key를 "월번호(1~12)"에서 "연-월(YYYY-MM)"로 전환.
// 이번달/미래 달은 신형식만 읽어 매달 자동 0부터 시작(리셋 보장), 과거 달은 구형식(2026 숫자키)도 폴백 표시.
window._ymKey = function(y, m) { return y + '-' + String(m).padStart(2, '0'); };
window._curYm = function() { const d = new Date(); return _ymKey(d.getFullYear(), d.getMonth() + 1); };
window._prevYm = function(key) { const p = String(key).split('-').map(Number); const d = new Date(p[0], p[1] - 2, 1); return _ymKey(d.getFullYear(), d.getMonth() + 1); };
window._recentMonths = function(n) { const out = [], d = new Date(); for (let i = n - 1; i >= 0; i--) { const t = new Date(d.getFullYear(), d.getMonth() - i, 1); const key = _ymKey(t.getFullYear(), t.getMonth() + 1); out.push({ k: key, key: key, label: (t.getMonth() + 1) + '월', y: t.getFullYear(), m: t.getMonth() + 1 }); } return out; };
window._ymLabel = function(key) { return parseInt(String(key).split('-')[1], 10) + '월'; };
window._readHour = function(hours, key) { return (hours && hours[key] != null) ? hours[key] : 0; };

// ── 상·벌점 집계 주기 ──
// 1주기는 7/20~8/31 '한 주기'로 연속 집계(8/1에 초기화되지 않음). 그 외 날짜는 해당 달력월.
// (당초 7/22 시작이었으나 신규생 7/20 등원에 맞춰 시범기간 없이 7/20 정식 시작으로 앞당김)
// 상·벌점 카드/모달의 '이번 주기/이번 달' 합계와 누적조치 판정 기준. 날짜는 ISO(YYYY-MM-DD) 문자열 비교.
window._meritCycle = function(refISO) {
  const today = refISO || (function () { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  if (today >= '2026-07-20' && today <= '2026-08-31') return { start: '2026-07-20', end: '2026-08-31', label: '이번 주기' };
  const ym = today.slice(0, 7), y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: ym + '-01', end: ym + '-' + String(lastDay).padStart(2, '0'), label: '이번 달' };
};
window._inMeritCycle = function(dateISO, cyc) { return !!dateISO && dateISO >= cyc.start && dateISO <= cyc.end; };

// ── 벌점 자동 상쇄(계산식) ──
// 주기 상점총합 M, 벌점총합 P(둘 다 미취소 기준)로 상쇄를 그때그때 계산(원장 없음, 멱등).
// 규칙: 벌점 잔여 2점 이상 + 상점 3점 모이면 상점3→벌점2 소거, 무제한 반복. 오래된 벌점부터(표시는 미구현).
//   rounds = min(⌊M/3⌋, ⌊P/2⌋). netMerit=보상·순위용 잔여 상점, netDemerit=잔여 벌점.
//   ⚠️ 단계별 조치(10/18/30)는 rawDemerit(P, 상쇄 무관 원누계)로 판단할 것.
window._computeOffset = function(M, P) {
  M = Math.max(0, Math.round(M || 0)); P = Math.max(0, Math.round(P || 0));
  const rounds = Math.min(Math.floor(M / 3), Math.floor(P / 2));
  return { rounds, spent: rounds * 3, cleared: rounds * 2,
           netMerit: M - rounds * 3, netDemerit: P - rounds * 2, rawMerit: M, rawDemerit: P };
};

// 구형식 숫자키(1~12, 2026년 데이터)를 신형식 "2026-MM"으로 정규화(로드 시 1회 적용, 폴백 대체)
window._normalizeHours = function(hours) {
  if (!hours || typeof hours !== 'object') return {};
  const out = {};
  // 신형식(YYYY-MM) 우선 복사
  for (const k of Object.keys(hours)) { if (/^\d{4}-\d{2}$/.test(k)) out[k] = Number(hours[k]) || 0; }
  // 구형식 숫자키(1~12)는 같은 달의 신형식이 없을 때만 보완 (중복 합산 방지)
  for (const k of Object.keys(hours)) {
    if (/^\d{1,2}$/.test(k)) {
      const m = parseInt(k, 10);
      if (m >= 1 && m <= 12) { const nk = _ymKey(2026, m); if (out[nk] == null) out[nk] = Number(hours[k]) || 0; }
    }
  }
  return out;
};

// ── 공지 날짜 표기·정렬 (3앱 공통) ──
// 저장된 date는 "2026.07.10." 형식이 정상이지만, 옛 공지는 관리자앱 저장 버그로
// "202607.10." (첫 점이 지워짐)로 들어가 있다. 표시할 때 숫자만 뽑아 다시 조립하므로
// 옛 데이터를 건드리지 않아도 화면에는 항상 올바르게 나온다.
window._noticeDateLabel = function(date) {
  const d = String(date || '').replace(/\D/g, '');
  if (d.length < 8) return String(date || '');   // 형식을 못 읽으면 원문 그대로
  return d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8) + '.';
};
// 오늘 날짜를 저장용 형식("2026.07.10.")으로
window._noticeToday = function() {
  const t = new Date();
  return t.getFullYear() + '.' + String(t.getMonth() + 1).padStart(2, '0') + '.' + String(t.getDate()).padStart(2, '0') + '.';
};
// 정렬키: 날짜 앞 8자리 숫자(YYYYMMDD). 날짜가 없으면 id(생성 타임스탬프)로 대체해 맨 뒤로.
window._noticeSortKey = function(n) {
  const d = String((n && n.date) || '').replace(/\D/g, '');
  if (d.length >= 8) return Number(d.slice(0, 8));
  return (n && n.id) ? Number(String(n.id).slice(0, 8)) : 0;
};
// 최신 공지가 앞으로 오도록 날짜 내림차순 정렬(원본 배열은 건드리지 않음).
// 같은 날짜끼리는 id(생성 시각) 최신순.
window._sortNoticesDesc = function(items) {
  return [...(items || [])].sort((a, b) =>
    (window._noticeSortKey(b) - window._noticeSortKey(a)) || ((b.id || 0) - (a.id || 0)));
};

// ── 전화번호 뒷 4자리 (입실 키오스크·학생앱 로그인 검색 색인) ──
// students 문서에 phoneLast4 필드로 저장해 where('phoneLast4','==',...) 한 번으로 검색.
window._phoneLast4 = function(phone) { return String(phone || '').replace(/\D/g, '').slice(-4); };

// ── 로그인/입실에 실제로 누르는 4자리 (loginPin 우선) ──
// 기본은 전화 뒷 4자리지만, 뒷 4자리가 다른 학생과 겹치는 경우 loginPin(예: 가운데 4자리)을
// 지정해 충돌을 피한다. 지정된 학생은 그 값'만' 통하고 뒷 4자리로는 검색되지 않으므로,
// 원래 그 뒷 4자리를 쓰던 학생은 아무 영향 없이 기존대로 로그인/입실한다.
// ★ phoneLast4 색인 필드는 여전히 '진짜 뒷 4자리'를 담는다(백필·저장 로직과 충돌 방지).
//   그래서 loginPin 학생은 where 색인에 안 걸리고 전체 스캔 폴백으로 찾힌다(문서 수십 개라 무해).
window._loginKey = function(s) {
  if (!s) return '';
  if (s.loginPin) return String(s.loginPin).replace(/\D/g, '').slice(0, 4);
  return window._phoneLast4(s.phone);
};
// 가운데 4자리 (010-6823-5626 → '6823')
window._phoneMid4 = function(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 11 ? d.slice(3, 7) : '';
};
