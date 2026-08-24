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
// 규칙(2026-08-17 개정): 상점 1점이 벌점 1점을 지운다. 오래된 벌점부터(표시는 미구현).
//   rounds = min(M, P). netMerit=보상·순위용 잔여 상점, netDemerit=잔여 벌점.
//   개정 전은 상점3→벌점2 였다. 상계값은 저장하지 않고 원누계에서 매번 계산하므로,
//   식만 바꾸면 과거 기록도 이 자리에서 새 기준으로 다시 계산된다(소급 마이그레이션 불필요).
//   ⚠️ 단계별 조치(10/18/30)는 rawDemerit(P, 상쇄 무관 원누계)로 판단할 것.
window._computeOffset = function(M, P) {
  M = Math.max(0, Math.round(M || 0)); P = Math.max(0, Math.round(P || 0));
  const rounds = Math.min(M, P);
  return { rounds, spent: rounds, cleared: rounds,
           netMerit: M - rounds, netDemerit: P - rounds, rawMerit: M, rawDemerit: P };
};

// ══════════════════════════════════════════════════════════════════
// 월별 이용 조사 (9월 사용 희망/비희망) — 3앱 공통 로직
// ══════════════════════════════════════════════════════════════════
// 학생앱·학부모앱은 로그인 직후 이 조사를 전면으로 띄우고, 응답 전에는 앱을 쓸 수 없다.
// 컬렉션은 usage_surveys 하나이고 설정 문서도 그 안에 둔다(_config) — settings 컬렉션은
// read 화이트리스트라 문서를 새로 만들 때마다 규칙을 고쳐야 하기 때문(school_calendars 선례).
//
//   usage_surveys/_config                  설정 1개
//   usage_surveys/{surveyId}__{학생키}      응답 1인 1개
//
// ⚠️ 기본값은 active:false 다. 설정 문서가 없으면 게이트는 뜨지 않는다 —
//    배포하는 순간 전교생이 막히는 사고를 막으려고 일부러 이렇게 뒀다.
//    관리자앱 '이용조사' 탭의 [조사 시작] 이 이 문서를 만든다.
window._SURVEY_COL = 'usage_surveys';
window._SURVEY_CONFIG_ID = '_config';

window._surveyConfig = function(raw) {
  const d = raw || {};
  const num = (v, def) => (v == null || isNaN(Number(v))) ? def : Number(v);
  return {
    surveyId:  String(d.surveyId || '2026-09'),
    title:     String(d.title || '9월 면학관 이용 조사'),
    closeAt:   String(d.closeAt || '2026-08-20T23:59'),   // 로컬(KST) 'YYYY-MM-DDTHH:mm'
    active:    d.active === true,
    meritWon:  num(d.meritWon, 1000),   // 잔여 상점 1점당 할인액
    meritCap:  num(d.meritCap, 20000),  // 할인 상한(0이면 무제한)
    blockAfterClose: d.blockAfterClose === true,  // 마감 후에도 막을지(기본은 통과+배너)
    exclude: Array.isArray(d.exclude) ? d.exclude.map(String) : [],  // 조사 대상에서 뺄 학생 이름
    finalizedAt: d.finalizedAt || null
  };
};

// 앱스토어 심사용 계정(좌석 9999 · uid s_00000000, saebom-app tool/seed_review_account.mjs).
// 실제 학생이 아니라 명단·집계에서 빠져야 하고, 무엇보다 **심사자가 이 화면에 갇히면 안 된다** —
// 조사에 갇힌 채로는 앱을 못 보므로 그대로 반려 사유가 된다. 지금 게이트는 웹앱에만 있어
// 심사자와 만날 일이 없지만, 심사 통과 후 네이티브 앱에 옮길 때 이 조건이 없으면 그때 터진다.
// 설정의 exclude 명단이 아니라 코드에 두는 이유 — 매달 새 조사를 만들 때 잊으면 그만이라서.
window._surveyIsReviewAccount = function(student) {
  if (!student) return false;
  if (student.uid === 's_00000000') return true;
  return String(student.seat == null ? '' : student.seat).replace(/[^0-9]/g, '') === '9999';
};

// 조사 대상에서 빼는 학생 — 게이트도 안 뜨고 관리앱 대상 수에도 안 들어간다.
//   1) 심사용 계정 — 위 참조.
//   2) withdrawAt(예약 퇴원일)이 잡힌 학생 — 나가기로 확정된 사람에게 "9월에도 오실래요?"를
//      물으면 안 된다. 매달 이름을 다시 적지 않아도 되도록 이 조건을 먼저 둔다.
//   3) 설정의 exclude 명단 — 아직 퇴원일이 안 잡혔지만 빼야 하는 학생.
// 이름 비교는 _sameStudentName 으로 한다("박지윤(9557)"·"박지윤A" 같은 표기 편차를 흡수).
window._surveyExcluded = function(cfg, student) {
  if (!student) return false;
  if (window._surveyIsReviewAccount(student)) return true;
  if (student.withdrawAt) return true;
  const list = window._surveyConfig(cfg).exclude;
  return list.some(n => window._sameStudentName(n, student.name));
};

// 'YYYY-MM-DDTHH:mm' 을 로컬 시각으로 읽는다. new Date(문자열)은 브라우저에 따라
// UTC로 해석해 9시간이 밀리므로 직접 조립한다.
window._surveyCloseMs = function(cfg) {
  const m = String((cfg && cfg.closeAt) || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 59).getTime();
};
window._surveyIsClosed = function(cfg, nowMs) {
  const ms = window._surveyCloseMs(cfg);
  return !isNaN(ms) && (nowMs || Date.now()) > ms;
};

// 응답 문서 ID. 좌석은 교환·재배정되므로 불변 uid 를 우선한다(uid 가 없는 옛 학생만 좌석).
window._surveyDocId = function(surveyId, student) {
  const uid = student && student.uid;
  const seat = String((student && student.seat) || '').replace(/[^0-9]/g, '');
  return String(surveyId) + '__' + (uid ? uid : ('seat' + (seat || '0')));
};

// 상벌점 상계 → 재등록 할인액.
// 상계 규칙 자체는 _computeOffset(상점1 → 벌점1 소거)을 그대로 쓴다.
// 상계하고도 벌점이 남으면(netDemerit > 0) 할인은 0원이다 — 남은 벌점만큼 더 받지는 않는다.
window._surveyDiscount = function(cfg, M, P) {
  const c = window._surveyConfig(cfg);
  const off = window._computeOffset(M, P);
  let won = 0;
  if (off.netDemerit <= 0) {
    won = off.netMerit * c.meritWon;
    if (c.meritCap > 0) won = Math.min(won, c.meritCap);
  }
  return { rawMerit: off.rawMerit, rawDemerit: off.rawDemerit,
           cleared: off.cleared, netMerit: off.netMerit, netDemerit: off.netDemerit,
           won: won, capped: c.meritCap > 0 && off.netDemerit <= 0 && off.netMerit * c.meritWon > c.meritCap };
};

// 응답 병합 — "먼저 낸 쪽 우선(first-wins)".
// 정본(want)은 처음 응답한 주체(firstBy)의 값이고, 뒤에 다른 쪽이 다르게 답해도 값은 바뀌지 않는다.
// 다만 conflict 를 세워 관리자앱이 따로 뽑아볼 수 있게 한다(전화로 확정할 명단).
// 같은 주체가 마감 전에 마음을 바꾸면 그건 불일치가 아니라 '변경'이므로 정본이 따라 바뀐다.
window._surveyApply = function(existing, role, want, nowISO) {
  const prev = existing || {};
  const r = (role === 'parent') ? 'parent' : 'student';
  const out = {
    student: prev.student ? { want: prev.student.want === true, at: prev.student.at || '' } : null,
    parent:  prev.parent  ? { want: prev.parent.want  === true, at: prev.parent.at  || '' } : null
  };
  out[r] = { want: want === true, at: nowISO };

  const firstBy = (prev.firstBy === 'student' || prev.firstBy === 'parent') ? prev.firstBy : r;
  const src = out[firstBy] || out[r];
  const both = !!(out.student && out.parent);
  return {
    want: src.want,
    firstBy: firstBy,
    student: out.student,
    parent: out.parent,
    conflict: both && out.student.want !== out.parent.want
  };
};

// ── 이번 주기 상점·벌점 합계 (조사 화면의 할인 계산용) ──
// 상벌점 카드와 같은 규칙으로 센다: 취소된 건 빼고, penalties 는 periods 맵을 펼쳐 교시별로,
// merits 는 문서의 points 를 더한다. docs 는 이미 '내 것'만 걸러진 배열이어야 한다.
window._surveyCycleTotals = function(meritDocs, penaltyDocs) {
  const cyc = window._meritCycle();
  let M = 0, P = 0;
  (meritDocs || []).forEach(d => {
    if (!d || d.canceled) return;
    const pts = Number(d.points) || 0;
    if (pts > 0 && window._inMeritCycle(d.date, cyc)) M += pts;
  });
  (penaltyDocs || []).forEach(d => {
    if (!d || !window._inMeritCycle(d.date, cyc)) return;
    Object.keys(d.periods || {}).forEach(k => {
      const p = d.periods[k];
      if (p && !p.canceled) P += (p.points || 1);
    });
  });
  return { M: M, P: P, cycle: cyc };
};

// ══════════════════════════════════════════════════════════════════
// 이용 조사 게이트 UI — 학생앱·학부모앱 공용
// ══════════════════════════════════════════════════════════════════
// 두 앱이 같은 화면을 쓰도록 UI까지 여기 둔다. 문구·색만 role 로 갈린다.
//
// 호출: window._surveyGate.start({ role, student, db, fs, fetchMine })
//   role      'student' | 'parent'
//   student   { name, seat, uid }
//   db        Firestore 인스턴스
//   fs        { doc, getDoc, setDoc }        — 앱마다 이름이 달라 어댑터로 받는다
//   fetchMine async (col, seatField) => [data...]  — 좌석/uid 폴백과 이름 검증까지 끝난 배열
//
// 게이트가 뜨는 조건: 설정이 active 이고, **아무도(학생·학부모 누구도) 응답하지 않았을 때**.
// 한쪽이 이미 응답했으면 그 값이 정본으로 반영된 상태이므로 막지 않고 배너로만 알린다.
//
// 확인 시점은 셋이다(하나만으로는 새는 자리가 있었다 — recheck 주석 참조):
//   ① start()   로그인·새로고침
//   ② recheck() 화면 복귀(각 앱 visibilitychange) + 10분 주기
//   ③ guard()   저장 직전 — true 면 호출부가 쓰기를 중단한다
window._surveyGate = (function() {
  const S = { cfg: null, resp: null, opt: null, busy: false, timer: null };

  const PALETTE = {
    student: { grad: 'linear-gradient(150deg,#1E1B4B 0%,#4338A8 45%,#6C5DD3 100%)', key: '#6C5DD3' },
    parent:  { grad: 'linear-gradient(150deg,#7A5610 0%,#C8900A 45%,#E0B020 100%)', key: '#C8900A' }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const won = n => Number(n || 0).toLocaleString('ko-KR');
  const roleLabel = r => (r === 'parent' ? '학부모님' : '학생');

  function nowISO() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function closeLabel(cfg) {
    const m = String(cfg.closeAt || '').match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return m ? `${+m[1]}월 ${+m[2]}일 ${m[3]}:${m[4]}` : cfg.closeAt;
  }

  // 설정·응답을 다시 읽어 S 를 갱신한다.
  // 반환: 'block'(막아야 함) | 'pass'(통과·배너) | 'idle'(조사 없음/대상 아님) | 'error'(상태 유지)
  async function load() {
    const opt = S.opt;
    if (!opt) return 'idle';
    let cfg = null, resp = null;
    try {
      const snap = await opt.fs.getDoc(opt.fs.doc(opt.db, window._SURVEY_COL, window._SURVEY_CONFIG_ID));
      if (!snap || !snap.exists || !snap.exists()) { S.cfg = null; S.resp = null; return 'idle'; }
      cfg = window._surveyConfig(snap.data());
      if (!cfg.active) { S.cfg = null; S.resp = null; return 'idle'; }
      if (window._surveyExcluded(cfg, opt.student)) { S.cfg = null; S.resp = null; return 'idle'; }
      const id = window._surveyDocId(cfg.surveyId, opt.student);
      const rs = await opt.fs.getDoc(opt.fs.doc(opt.db, window._SURVEY_COL, id));
      resp = (rs && rs.exists && rs.exists()) ? rs.data() : null;
    } catch (e) {
      // 읽기 실패로 이미 떠 있는 게이트를 내리지는 않는다(호출부가 'error'를 보고 상태를 유지한다).
      // 단 한 번도 읽지 못한 상태에서의 실패는 그대로 통과시킨다 — 조사 때문에 앱 전체가
      // 막히는 사고를 막으려는 원래 방침(fail-open)은 유지.
      console.warn('이용 조사 확인 실패:', e);
      return 'error';
    }
    S.cfg = cfg; S.resp = resp;
    const answered = !!(resp && (resp.student || resp.parent));
    const closed = window._surveyIsClosed(cfg);
    return (!answered && (!closed || cfg.blockAfterClose)) ? 'block' : 'pass';
  }

  function isBlocking() {
    return document.getElementById('survey-gate')?.dataset.blocking === '1';
  }

  async function start(opt) {
    S.opt = opt;
    const r = await load();
    if (r === 'block') open(true);
    else if (r === 'pass') renderBanner();
    watch();
    return r;
  }

  // ── 복귀·주기 재확인 ──
  // 게이트는 원래 로그인·새로고침(enterApp) 때 한 번만 검사했다. 그래서 조사를 켜기 전에
  // 열어 둔 탭·홈화면 앱은 세션이 살아있는 한 게이트를 한 번도 만나지 않았다
  // (2026-08-19 확인: 좌석 6 김태현이 미응답 상태로 8/17~8/18 시간표를 계속 저장했다.
  //  같은 세션이 8/18 17:48 에 꺼진 '주간 시간표 수정 허용'도 22:06 까지 켜진 줄 알고 있었다).
  // → 화면 복귀 때(각 앱의 visibilitychange)와 10분마다 다시 확인한다.
  async function recheck() {
    if (!S.opt || S.busy) return;
    const r = await load();
    if (r === 'error') return;                                  // 상태 유지
    if (r === 'block') { if (!isBlocking()) open(true); return; }
    if (isBlocking()) document.getElementById('survey-gate')?.remove();  // 반대쪽이 응답함 등
    if (r === 'pass') renderBanner();
    else document.getElementById('survey-banner')?.remove();
  }

  function watch() {
    if (S.timer) return;
    S.timer = setInterval(() => { if (!document.hidden) recheck(); }, 10 * 60 * 1000);
  }

  // 저장 직전 방어선 — 화면은 오버레이로 막지만, 오버레이가 뜨기 전에 눌린 쓰기까지
  // 흘려보내지 않는다. true 를 돌려주면 호출부는 저장을 중단한다.
  async function guard() {
    if (!S.opt) return false;
    if (!S.cfg) await recheck();          // 조사를 아직 모르는(=오래된) 세션이면 지금 확인한다
    if (isBlocking()) return true;
    if (!S.cfg || !S.cfg.active) return false;
    if (window._surveyExcluded(S.cfg, S.opt.student)) return false;
    const answered = !!(S.resp && (S.resp.student || S.resp.parent));
    if (answered) return false;
    if (window._surveyIsClosed(S.cfg) && !S.cfg.blockAfterClose) return false;
    open(true);
    return true;
  }

  // 배너 — 응답 후(변경 가능), 또는 마감 후 미응답자에게.
  function renderBanner() {
    document.getElementById('survey-banner')?.remove();
    if (!S.cfg || !S.cfg.active) return;
    const closed = window._surveyIsClosed(S.cfg);
    const mine = S.resp && S.resp[S.opt.role];
    const other = S.resp && S.resp[S.opt.role === 'parent' ? 'student' : 'parent'];
    const pal = PALETTE[S.opt.role] || PALETTE.student;

    let text, tone = pal.key;
    if (!S.resp) {
      if (!closed) return;                                    // 미응답인데 마감 전이면 게이트가 떠 있다
      text = `📋 ${esc(S.cfg.title)} 회수가 끝났어요. 아직 응답하지 않으셨습니다 — 면학관으로 연락 주세요.`;
      tone = '#C62828';
    } else if (mine) {
      text = `📋 ${esc(S.cfg.title)} — <b>${S.resp.want ? '이용 희망' : '이용 안 함'}</b>으로 접수됐어요.`;
    } else {
      text = `📋 ${esc(S.cfg.title)} — ${roleLabel(S.resp.firstBy)}이 <b>${S.resp.want ? '이용 희망' : '이용 안 함'}</b>으로 응답하셨어요.`;
    }
    const canEdit = !closed;
    const bar = document.createElement('div');
    bar.id = 'survey-banner';
    bar.style.cssText = `position:sticky;top:0;z-index:900;background:${tone}12;border-bottom:1px solid ${tone}40;` +
      'padding:9px 14px;font-size:12px;line-height:1.5;color:#333;display:flex;gap:10px;align-items:center';
    bar.innerHTML = `<span style="flex:1">${text}</span>` +
      (canEdit ? `<button type="button" id="survey-banner-btn" style="flex:0 0 auto;padding:6px 12px;border:none;border-radius:8px;background:${tone};color:#fff;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer">${S.resp && S.resp[S.opt.role] ? '변경' : '응답'}</button>` : '');
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('survey-banner-btn')?.addEventListener('click', () => open(false));
  }

  // blocking=true 면 닫기 버튼이 없다(응답해야 앱으로 들어간다).
  function open(blocking) {
    document.getElementById('survey-gate')?.remove();
    const pal = PALETTE[S.opt.role] || PALETTE.student;
    const ov = document.createElement('div');
    ov.id = 'survey-gate';
    ov.dataset.blocking = blocking ? '1' : '0';
    ov.style.cssText = 'position:fixed;inset:0;z-index:20000;background:' + pal.grad +
      ';display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
    ov.innerHTML = '<div id="survey-gate-card" style="background:#fff;border-radius:20px;padding:24px 20px;width:100%;max-width:380px;box-shadow:0 18px 50px rgba(0,0,0,0.28);color:#1F2937"></div>';
    document.body.appendChild(ov);
    render();
    loadDiscount();
  }
  function close() {
    document.getElementById('survey-gate')?.remove();
    renderBanner();
  }

  let _pick = null;      // 이번에 고른 값(저장 전)
  let _disc = null;      // 할인 계산 결과(비동기로 채워짐)

  function render() {
    const card = document.getElementById('survey-gate-card');
    if (!card) return;
    const cfg = S.cfg, pal = PALETTE[S.opt.role] || PALETTE.student;
    const st = S.opt.student || {};
    const blocking = document.getElementById('survey-gate')?.dataset.blocking === '1';
    const mine = S.resp && S.resp[S.opt.role];
    const other = S.resp && S.resp[S.opt.role === 'parent' ? 'student' : 'parent'];
    if (_pick === null && mine) _pick = mine.want === true;

    const btn = (val, emoji, title, desc) => {
      const on = _pick === val;
      return `<button type="button" data-want="${val}" style="width:100%;text-align:left;display:flex;gap:11px;align-items:flex-start;
        padding:14px 15px;margin-bottom:9px;border-radius:13px;cursor:pointer;font-family:inherit;
        border:2px solid ${on ? pal.key : '#E5E7EB'};background:${on ? pal.key + '10' : '#fff'}">
        <span style="font-size:20px;line-height:1.1">${emoji}</span>
        <span style="flex:1">
          <span style="display:block;font-size:14.5px;font-weight:800;color:${on ? pal.key : '#1F2937'}">${title}</span>
          <span style="display:block;font-size:11.5px;color:#6B7280;margin-top:2px;line-height:1.5">${desc}</span>
        </span>
        <span style="font-size:15px;color:${on ? pal.key : '#D1D5DB'}">${on ? '●' : '○'}</span>
      </button>`;
    };

    card.innerHTML = `
      <div style="font-size:19px;font-weight:900;letter-spacing:-0.4px">${esc(cfg.title)}</div>
      <div style="font-size:12.5px;color:#6B7280;margin-top:5px;line-height:1.6">
        ${esc(st.name || '')}${st.seat ? ' · ' + esc(String(st.seat)) + '번' : ''}<br>
        회수 마감 <b style="color:#374151">${closeLabel(cfg)}</b>
      </div>
      ${blocking ? `<div style="margin-top:12px;background:#FEF3C7;border-radius:10px;padding:10px 12px;font-size:12px;color:#92400E;line-height:1.6">
        9월 좌석과 시간표를 짜기 위한 조사예요. <b>응답하셔야 앱을 이용할 수 있어요.</b>
      </div>` : ''}
      ${other ? `<div style="margin-top:12px;background:#EFF6FF;border-radius:10px;padding:10px 12px;font-size:12px;color:#1D4ED8;line-height:1.6">
        ${roleLabel(S.opt.role === 'parent' ? 'student' : 'parent')}은 <b>${other.want ? '이용 희망' : '이용 안 함'}</b>으로 응답하셨어요.
      </div>` : ''}
      <div id="survey-discount"></div>
      <div style="margin:16px 0 4px;font-size:13px;font-weight:800">9월에도 면학관을 이용하시겠어요?</div>
      <div id="survey-opts" style="margin-top:9px">
        ${btn(true,  '🙋', '네, 계속 이용할게요', '지금 자리와 시간표 그대로 다닐게요~')}
        ${btn(false, '👋', '아니요, 이용하지 않을게요', '8월까지만 이용하고 9월엔 쉴게요~')}
      </div>
      <button type="button" id="survey-submit" ${_pick === null ? 'disabled' : ''}
        style="width:100%;margin-top:14px;padding:14px;border:none;border-radius:12px;font-family:inherit;
        font-size:14.5px;font-weight:800;color:#fff;cursor:${_pick === null ? 'default' : 'pointer'};
        background:${_pick === null ? '#D1D5DB' : pal.key}">${mine ? '변경 저장' : '제출하기'}</button>
      ${blocking ? '' : `<button type="button" id="survey-close" style="width:100%;margin-top:8px;padding:11px;border:1px solid #E5E7EB;border-radius:12px;background:#fff;color:#6B7280;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">닫기</button>`}
      <div style="margin-top:12px;font-size:11px;color:#9CA3AF;line-height:1.6">
        마감 전까지는 언제든 바꿀 수 있어요. 학생과 학부모님 응답이 다를 경우 <b>먼저 하신 응답</b>이 반영되고,
        면학관에서 따로 확인 전화를 드립니다.
      </div>`;

    card.querySelectorAll('[data-want]').forEach(b => b.addEventListener('click', () => {
      _pick = b.dataset.want === 'true';
      render(); paintDiscount();
    }));
    document.getElementById('survey-submit')?.addEventListener('click', submit);
    document.getElementById('survey-close')?.addEventListener('click', close);
    paintDiscount();
  }

  async function loadDiscount() {
    try {
      const [merits, penalties] = await Promise.all([
        S.opt.fetchMine('merits', 'seatKey'),
        S.opt.fetchMine('penalties', 'seatKey')
      ]);
      const t = window._surveyCycleTotals(merits, penalties);
      _disc = window._surveyDiscount(S.cfg, t.M, t.P);
      paintDiscount();
    } catch (e) { console.warn('상벌점 조회 실패(할인 안내 생략):', e); }
  }

  // 할인 안내는 **고르기 전부터** 보여준다 — 재등록 유인이라 결정한 뒤에 보여주면 늦다.
  // 상벌점 기록이 아예 없는 학생에게는 띄우지 않는다(0원은 유인이 아니라 역효과).
  // '이용 안 함'을 고른 뒤에도 지우지 않고 문구만 바꾼다 — 사라지면 뺏는 것처럼 읽힌다.
  function paintDiscount() {
    const el = document.getElementById('survey-discount');
    if (!el) return;
    if (!_disc) { el.innerHTML = ''; return; }
    const d = _disc;
    if (d.rawMerit === 0 && d.rawDemerit === 0) { el.innerHTML = ''; return; }
    const leaving = _pick === false;
    const line = (l, r, c) => `<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:3px"><span style="color:#6B7280">${l}</span><span style="font-weight:700;color:${c || '#374151'}">${r}</span></div>`;
    el.innerHTML = `
      <div style="background:#F0FDF4;border:1.5px solid #BBF7D0;border-radius:12px;padding:12px 14px;margin-top:8px;${leaving ? 'opacity:.62' : ''}">
        <div style="font-size:12.5px;font-weight:800;color:#047857">🎁 9월에 계속 다니면 받는 할인</div>
        ${line('상점', d.rawMerit + '점', '#059669')}
        ${line('벌점', d.rawDemerit + '점', '#C62828')}
        ${d.cleared ? line('상점으로 상쇄', '벌점 −' + d.cleared + '점', '#6B7280') : ''}
        ${line('잔여', '상점 ' + d.netMerit + '점 · 벌점 ' + d.netDemerit + '점')}
        <div style="border-top:1px dashed #BBF7D0;margin-top:8px;padding-top:8px">
          ${d.netDemerit > 0
            ? `<div style="font-size:12px;color:#92400E;line-height:1.6">벌점이 <b>${d.netDemerit}점</b> 남아 이번 할인은 없어요. 8월 31일까지 상점을 받으면 1점당 벌점 1점이 지워집니다.</div>`
            : `<div style="display:flex;justify-content:space-between;align-items:center">
                 <span style="font-size:12.5px;color:#047857;font-weight:700">9월 이용료 할인</span>
                 <span style="font-size:17px;font-weight:900;color:#047857">${won(d.won)}원</span>
               </div>${d.capped ? '<div style="font-size:11px;color:#6B7280;margin-top:3px">할인 상한이 적용된 금액이에요.</div>' : ''}`}
        </div>
        <div style="font-size:11px;color:#6B7280;margin-top:8px;line-height:1.6">
          ${leaving
            ? '9월에도 계속 다니시면 받을 수 있는 할인이에요.'
            : '지금 기준 <b>예상 금액</b>이에요. 8월 31일까지의 상벌점으로 최종 확정됩니다.'}
        </div>
      </div>`;
  }

  async function submit() {
    if (S.busy || _pick === null) return;
    const btn = document.getElementById('survey-submit');
    S.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }
    try {
      const opt = S.opt, st = opt.student || {};
      const id = window._surveyDocId(S.cfg.surveyId, st);
      const ref = opt.fs.doc(opt.db, window._SURVEY_COL, id);
      // 저장 직전에 한 번 더 읽는다 — 게이트가 열려 있는 동안 반대쪽에서 답했을 수 있다.
      let cur = null;
      try {
        const s = await opt.fs.getDoc(ref);
        if (s && s.exists && s.exists()) cur = s.data();
      } catch (e) {}
      const merged = window._surveyApply(cur, opt.role, _pick, nowISO());
      const payload = {
        surveyId: S.cfg.surveyId,
        name: st.name || '', seat: String(st.seat || ''), uid: st.uid || '',
        want: merged.want, firstBy: merged.firstBy, conflict: merged.conflict,
        student: merged.student, parent: merged.parent,
        updatedAt: nowISO()
      };
      if (_disc) payload.snapshot = {
        merit: _disc.rawMerit, demerit: _disc.rawDemerit,
        netMerit: _disc.netMerit, netDemerit: _disc.netDemerit, won: _disc.won, at: nowISO()
      };
      await opt.fs.setDoc(ref, payload, { merge: true });
      S.resp = Object.assign({}, cur || {}, payload);
      close();
    } catch (e) {
      console.error('이용 조사 저장 실패:', e);
      alert('저장에 실패했어요. 잠시 후 다시 눌러 주세요.');
      if (btn) { btn.disabled = false; btn.textContent = '제출하기'; }
    } finally { S.busy = false; }
  }

  // 로그아웃 때 흔적을 지운다(다른 자녀로 로그인하면 앞 아이 응답이 남으면 안 된다).
  function reset() {
    document.getElementById('survey-gate')?.remove();
    document.getElementById('survey-banner')?.remove();
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    S.cfg = null; S.resp = null; S.opt = null; _pick = null; _disc = null;
  }

  return { start, reset, open, recheck, guard };
})();

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

// ── 불변 학생ID(uid) 발급 (이관 1단계) ──
// 좌석·이름과 달리 절대 바뀌지 않는 식별자. 이력 기록이 전부 이 값으로 묶여 있으므로
// 학생 문서를 만드는 모든 경로에서 반드시 하나씩 발급돼야 한다(없으면 그 학생은 조회에서 사라진다).
// 순번을 쓰지 않는 이유: 학원이 늘어날 때 충돌하지 않아야 하고, 사람이 손으로 잘못 적기 쉽다.
window._newStudentUid = function() {
  const b = new Uint8Array(4);
  (window.crypto || window.msCrypto).getRandomValues(b);
  return 's_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
};

// ── 좌석 기준 기록의 소유자 판별 (3앱 공통) ──
// penalties·merits·planners·planner_ai_reviews·daily_reports 는 문서키·조회키가 모두 '좌석번호'다.
// 그런데 좌석은 교환·재배정되고, 좌석 교환은 students/schedules/schedule_base 세 개만 옮긴다.
// 그래서 좌석만으로 조회하면 그 자리에 앉았던 이전 학생의 기록이 지금 주인에게 딸려온다.
//   2026-08-04 운영 데이터 실측: daily_reports 34건 · planners 3건이 실제로 뒤섞여 있었다
//   (좌석 13·27·36·37·40). 상벌점이 0건인 건 실운영이 7/20 시작이라 아직 안 겹쳤을 뿐이다.
// → 좌석으로 긁어온 기록은 반드시 이름으로 한 번 더 거른다.
//
// 이름은 표기 편차가 있어 단순 문자열 비교를 하면 본인 기록을 잘못 숨긴다. 흡수해야 하는 두 가지:
//   - 뒤에 붙은 전화 4자리 : "박지윤(9557)" 과 "박지윤"  → 같은 사람
//   - 동명이인 구분자 1글자 : "박지윤" 과 "박지윤A"      → 같은 사람(구 기록이 접미사 전 이름)
// 위 규칙을 운영 데이터 1,827건에 대조해 오염 37건만 걸러지고 동명이인 12건은 통과함을 확인했다.
window._normStudentName = function(n) {
  return String(n == null ? '' : n).trim().replace(/\s+/g, '').replace(/\(\d+\)$/, '');
};
window._sameStudentName = function(a, b) {
  const x = window._normStudentName(a), y = window._normStudentName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const lo = x.length < y.length ? x : y, hi = x.length < y.length ? y : x;
  return hi.indexOf(lo) === 0 && /^[A-Za-z0-9]$/.test(hi.slice(lo.length));
};
// 좌석으로 긁어온 문서 배열에서 '이 학생 것'만 남긴다.
// student 는 학생 객체({name}) 또는 이름 문자열. 이름 필드가 없는 기록은 주인을 확정할 수 없어
// 보수적으로 제외한다(2026-08-04 기준 해당 컬렉션 1,827건 중 0건이라 실제 손실은 없다).
window._onlyMine = function(docs, student) {
  const me = student && (student.name || student);
  return (docs || []).filter(function(d) {
    return window._sameStudentName(d && (d.name || d.studentName), me);
  });
};

// ══════════════════════════════════════════════════════════════════
// 안드로이드 테스터 등록 게이트 (2026-08-24)
// ══════════════════════════════════════════════════════════════════
// 왜 필요한가: 플레이스토어 개인 계정은 **비공개 테스터 12명이 14일 연속**
// 유지돼야 프로덕션 출시를 신청할 수 있다. "테스트 좀 해줘"로는 안 모여서
// (실제로 8/15~8/24 사이 7명에서 멈췄다) 9월 이용 조사가 통했던 방식 —
// 로그인 전면 게이트 — 을 그대로 쓴다(원장 지시).
//
// ⚠️ **이용 조사(_surveyGate)와 별개 모듈이다.** 그쪽은 운영 중이라 렌더를
//    분기시키면 9월 조사가 깨질 위험이 있다. 수명주기(start/recheck/watch)만
//    같은 모양으로 맞췄다. 조사 게이트가 떠 있으면 이 게이트는 나중에 뜬다.
//
// ⚠️ **아이폰 학생에게 지메일을 묻지 않는다.** 테스터는 안드로이드만 가능하다.
//    아이폰은 앱스토어에 이미 출시돼 있으니(1.0, 2026-08-19) 링크를 주고
//    통과시킨다 — 게이트가 "쓸데없이 막는 것"이 아니라 양쪽을 앱으로 보내는
//    장치가 되게.
//
//   android_testers/_config              설정 1개
//   android_testers/{uid|seatN}          응답 1인 1개
//
// 기본은 active:false — 설정 문서가 없으면 아무것도 뜨지 않는다(조사 게이트와
// 같은 방침. 배포하는 순간 전교생이 막히는 사고 방지).
window._TESTER_COL = 'android_testers';

window._testerConfig = function(raw) {
  const d = raw || {};
  return {
    active:  d.active === true,
    title:   String(d.title || '앱 설치 안내'),
    // 옵트인 링크 — 콘솔에 등록되기 **전에** 누르면 "테스터가 아닙니다"가 뜨므로,
    // 등록을 마친 뒤에 이 값을 채운다. 비어 있으면 "곧 안내" 문구만 보여 준다.
    playLink: String(d.playLink || ''),
    iosLink:  String(d.iosLink || 'https://apps.apple.com/kr/app/id6800415075'),
    exclude:  Array.isArray(d.exclude) ? d.exclude.map(String) : []
  };
};

window._testerExcluded = function(cfg, student) {
  if (!student) return false;
  // 심사용 계정은 어떤 게이트에도 갇히면 안 된다(_surveyIsReviewAccount 주석 참조).
  if (window._surveyIsReviewAccount(student)) return true;
  if (student.withdrawAt) return true;
  const list = window._testerConfig(cfg).exclude;
  return list.some(n => window._sameStudentName(n, student.name));
};

// 역할을 문서 ID 에 넣는다. 학부모와 학생은 **각자 등록해야 한다** — 플레이
// 테스터는 계정(이메일) 단위이고, 학부모 폰과 학생 폰은 다른 기기다.
// 자녀가 둘인 학부모는 어느 자녀로 로그인해도 같은 문서가 되게(번호가 신원)
// 좌석·uid 가 아니라 로그인 번호를 쓰면 좋겠지만, 웹앱 학부모 로그인은 자녀를
// 골라 들어오는 구조라 여기서는 자녀 기준으로 둔다 — 중복 등록돼도 이메일이
// 같으면 콘솔에서 한 명으로 합쳐진다(무해).
window._testerDocId = function(student, role) {
  const uid = student && student.uid;
  const seat = String((student && student.seat) || '').replace(/[^0-9]/g, '');
  const base = uid ? uid : ('seat' + (seat || '0'));
  return (role === 'parent' ? 'p__' : '') + base;
};

window._testerGate = (function() {
  const S = { cfg: null, resp: null, opt: null, busy: false, timer: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = '#1E9E5A';   // 플레이스토어 초록 — 조사 게이트(보라·금색)와 구분된다

  let _platform = null;    // 이번에 고른 값(저장 전)

  async function load() {
    const opt = S.opt;
    if (!opt) return 'idle';
    try {
      const snap = await opt.fs.getDoc(opt.fs.doc(opt.db, window._TESTER_COL, '_config'));
      if (!snap || !snap.exists || !snap.exists()) { S.cfg = null; return 'idle'; }
      const cfg = window._testerConfig(snap.data());
      if (!cfg.active) { S.cfg = null; return 'idle'; }
      if (window._testerExcluded(cfg, opt.student)) { S.cfg = null; return 'idle'; }
      const rs = await opt.fs.getDoc(
        opt.fs.doc(opt.db, window._TESTER_COL,
                   window._testerDocId(opt.student, opt.role)));
      S.cfg = cfg;
      S.resp = (rs && rs.exists && rs.exists()) ? rs.data() : null;
    } catch (e) {
      console.warn('테스터 등록 확인 실패:', e);
      return 'error';                       // 이미 떠 있는 게이트를 내리지 않는다
    }
    return S.resp ? 'pass' : 'block';
  }

  function isBlocking() {
    return document.getElementById('tester-gate')?.dataset.blocking === '1';
  }

  async function start(opt) {
    S.opt = opt;
    const r = await load();
    if (r === 'block') open();
    watch();
    return r;
  }

  async function recheck() {
    if (!S.opt || S.busy) return;
    const r = await load();
    if (r === 'error') return;
    if (r === 'block') { if (!isBlocking()) open(); return; }
    if (isBlocking()) document.getElementById('tester-gate')?.remove();
  }

  function watch() {
    if (S.timer) return;
    S.timer = setInterval(() => { if (!document.hidden) recheck(); }, 10 * 60 * 1000);
  }

  function open() {
    // 이용 조사가 떠 있으면 그쪽을 먼저 끝내게 둔다 — 게이트 두 장이 겹치면
    // 어느 쪽을 답해야 하는지 알 수 없다. 조사가 내려가는 순간 이어서 뜨도록
    // 몇 초 간격으로 다시 본다(10분 주기만 믿으면 조사 답한 학생이 이 게이트를
    // 다음 접속에서야 만난다).
    if (document.getElementById('survey-gate')) {
      setTimeout(() => { if (S.cfg && !S.resp) open(); }, 3000);
      return;
    }
    document.getElementById('tester-gate')?.remove();
    const ov = document.createElement('div');
    ov.id = 'tester-gate';
    ov.dataset.blocking = '1';
    ov.style.cssText = 'position:fixed;inset:0;z-index:20000;padding:20px;overflow-y:auto' +
      ';background:linear-gradient(150deg,#0B3D22 0%,#12703E 45%,#1E9E5A 100%)' +
      ';display:flex;align-items:center;justify-content:center';
    // 색은 역할과 무관하게 플레이스토어 초록으로 둔다 — 이용 조사(보라·금색)와
    // 다른 성격의 게이트라는 걸 색으로 구분하는 편이 낫다.
    ov.innerHTML = '<div id="tester-gate-card" style="background:#fff;border-radius:20px;padding:24px 20px;width:100%;max-width:380px;box-shadow:0 18px 50px rgba(0,0,0,0.28);color:#1F2937"></div>';
    document.body.appendChild(ov);
    render();
  }

  function render() {
    const card = document.getElementById('tester-gate-card');
    if (!card) return;
    const st = S.opt.student || {};
    const cfg = S.cfg;

    const btn = (val, emoji, title, desc) => {
      const on = _platform === val;
      return `<button type="button" data-plat="${val}" style="width:100%;text-align:left;display:flex;gap:11px;align-items:flex-start;
        padding:14px 15px;margin-bottom:9px;border-radius:13px;cursor:pointer;font-family:inherit;
        border:2px solid ${on ? KEY : '#E5E7EB'};background:${on ? KEY + '10' : '#fff'}">
        <span style="font-size:20px;line-height:1.1">${emoji}</span>
        <span style="flex:1">
          <span style="display:block;font-size:14.5px;font-weight:800;color:${on ? KEY : '#1F2937'}">${title}</span>
          <span style="display:block;font-size:11.5px;color:#6B7280;margin-top:2px;line-height:1.5">${desc}</span>
        </span>
        <span style="font-size:15px;color:${on ? KEY : '#D1D5DB'}">${on ? '●' : '○'}</span>
      </button>`;
    };

    card.innerHTML = `
      <div style="font-size:19px;font-weight:900;letter-spacing:-0.4px">📱 ${esc(cfg.title)}</div>
      <div style="font-size:12.5px;color:#6B7280;margin-top:5px;line-height:1.6">
        ${esc(st.name || '')}${st.seat ? ' · ' + esc(String(st.seat)) + '번' : ''}
      </div>
      <div style="margin-top:12px;background:#ECFDF5;border-radius:10px;padding:11px 13px;font-size:12px;color:#065F46;line-height:1.7">
        ${S.opt.role === 'parent'
          ? '이제 면학관은 <b>앱</b>으로 안내드립니다. 자녀의 등·하원과 학습현황을 앱에서 보세요.<br><b>쓰시는 기기를 알려주시면 설치 방법을 안내해 드려요.</b>'
          : '이제 면학관은 <b>앱</b>으로 이용합니다. 시간표·플래너·상벌점을 앱에서 보세요.<br><b>쓰는 기기를 알려주시면 설치 방법을 안내해 드려요.</b>'}
      </div>
      <div style="margin:16px 0 4px;font-size:13px;font-weight:800">${S.opt.role === 'parent' ? '어떤 폰을 쓰시나요?' : '어떤 폰을 쓰세요?'}</div>
      <div id="tester-opts" style="margin-top:9px">
        ${btn('android', '🤖', '안드로이드', '삼성·LG 등. 구글 계정이 필요해요')}
        ${btn('ios', '🍎', '아이폰', '앱스토어에서 바로 설치할 수 있어요')}
      </div>
      <div id="tester-detail"></div>`;

    card.querySelectorAll('[data-plat]').forEach(b => {
      b.onclick = () => { _platform = b.dataset.plat; render(); };
    });
    if (_platform) renderDetail();
  }

  function renderDetail() {
    const box = document.getElementById('tester-detail');
    if (!box) return;
    const cfg = S.cfg;

    if (_platform === 'ios') {
      box.innerHTML = `
        <div style="margin-top:6px;background:#F9FAFB;border-radius:12px;padding:13px 14px;font-size:12.5px;color:#374151;line-height:1.7">
          앱스토어에서 <b>새봄 면학관</b>을 검색하거나 아래 버튼으로 설치하세요.
        </div>
        <a href="${esc(cfg.iosLink)}" target="_blank" rel="noopener"
           style="display:block;margin-top:9px;padding:13px;border-radius:12px;background:#111827;color:#fff;
                  text-align:center;font-size:14px;font-weight:800;text-decoration:none">앱스토어에서 설치하기</a>
        <button type="button" id="tester-save" style="width:100%;margin-top:9px;padding:14px;border:0;border-radius:12px;
          background:${KEY};color:#fff;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">설치했어요 · 계속</button>
        <div id="tester-err" style="margin-top:9px;font-size:12px;color:#B91C1C"></div>`;
      document.getElementById('tester-save').onclick = () => save({ platform: 'ios' });
      return;
    }

    // 안드로이드 — 구글 계정 이메일을 받는다. 플레이 테스터 목록은 **이메일**로
    // 등록되므로 전화번호로는 아무것도 못 한다.
    box.innerHTML = `
      <div style="margin-top:6px;background:#FFFBEB;border-radius:12px;padding:13px 14px;font-size:12.5px;color:#92400E;line-height:1.7">
        안드로이드는 <b>구글 계정(지메일)</b>을 등록해야 설치할 수 있어요.<br>
        폰의 <b>플레이스토어에 로그인된 계정</b>을 적어 주세요.
        <span style="color:#B45309">학교 계정(@goedu.kr)은 안 됩니다.</span>
      </div>
      <input id="tester-gmail" type="email" inputmode="email" autocomplete="email"
        placeholder="예: hong@gmail.com"
        style="width:100%;margin-top:10px;padding:13px 14px;border:2px solid #E5E7EB;border-radius:12px;
               font-size:15px;font-family:inherit;box-sizing:border-box">
      ${cfg.playLink ? `<a href="${esc(cfg.playLink)}" target="_blank" rel="noopener"
          style="display:block;margin-top:9px;padding:12px;border-radius:12px;background:#F3F4F6;color:#374151;
                 text-align:center;font-size:13px;font-weight:700;text-decoration:none">등록을 마쳤다면 여기서 설치</a>` : ''}
      <button type="button" id="tester-save" style="width:100%;margin-top:9px;padding:14px;border:0;border-radius:12px;
        background:${KEY};color:#fff;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit">제출하기</button>
      <div id="tester-err" style="margin-top:9px;font-size:12px;color:#B91C1C"></div>`;

    const input = document.getElementById('tester-gmail');
    input.oninput = () => { document.getElementById('tester-err').textContent = ''; };
    document.getElementById('tester-save').onclick = () => {
      const gmail = String(input.value || '').trim().toLowerCase();
      const err = document.getElementById('tester-err');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail)) {
        err.textContent = '이메일 형식을 확인해 주세요.'; return;
      }
      if (/@goedu\.kr$/i.test(gmail)) {
        err.textContent = '학교 계정은 등록할 수 없어요. 개인 지메일을 적어 주세요.'; return;
      }
      save({ platform: 'android', gmail });
    };
  }

  async function save(extra) {
    if (S.busy) return;
    S.busy = true;
    const err = document.getElementById('tester-err');
    const btn = document.getElementById('tester-save');
    if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
    try {
      const st = S.opt.student || {};
      const now = new Date();
      const p = n => String(n).padStart(2, '0');
      await S.opt.fs.setDoc(
        S.opt.fs.doc(S.opt.db, window._TESTER_COL,
                     window._testerDocId(st, S.opt.role)),
        Object.assign({
          role: S.opt.role || 'student',
          name: st.name || '',
          seat: String(st.seat == null ? '' : st.seat),
          uid: st.uid || '',
          at: now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) +
              ' ' + p(now.getHours()) + ':' + p(now.getMinutes())
        }, extra),
        { merge: true }
      );
      S.resp = extra;
      document.getElementById('tester-gate')?.remove();
    } catch (e) {
      console.error('테스터 등록 저장 실패:', e);
      if (err) err.textContent = '저장에 실패했어요. 잠시 후 다시 시도해 주세요.';
      if (btn) { btn.disabled = false; btn.textContent = '제출하기'; }
    } finally {
      S.busy = false;
    }
  }

  return { start, recheck, isBlocking };
})();
