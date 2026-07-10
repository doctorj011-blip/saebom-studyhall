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

// ── 전화번호 뒷 4자리 (입실 키오스크·학생앱 로그인 검색 색인) ──
// students 문서에 phoneLast4 필드로 저장해 where('phoneLast4','==',...) 한 번으로 검색.
window._phoneLast4 = function(phone) { return String(phone || '').replace(/\D/g, '').slice(-4); };
