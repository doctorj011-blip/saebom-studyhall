// ⚠️ 자동 생성 파일 — 손으로 고치지 말 것. functions/jobs/extract.mjs 가 관리앱에서 잘라 만든다.
// 원본: saebom_schedule_with_hours.html (생성 2026-10-08T06:36:59.734Z)
// 서버(runner.js)가 node:vm 안에서 window·db·Firestore 함수 흉내(fsCompat)를 넣고 실행한다.

// ════ saebom-common.js — 공용 헬퍼 ════
window._ymKey = function(y, m) { return y + '-' + String(m).padStart(2, '0'); };
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
window._phoneLast4 = function(phone) { return String(phone || '').replace(/\D/g, '').slice(-4); };
window._newStudentUid = function() {
  const b = new Uint8Array(4);
  (window.crypto || window.msCrypto).getRandomValues(b);
  return 's_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
};
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
window._ownsDoc = function(d, student) {
  if (!d || !student) return false;
  var su = student.uid, du = d.uid;
  if (su && du) return String(su) === String(du);
  return window._sameStudentName(d.name || d.studentName, student.name || student);
};

// ════ 클래식 — 세션 시각 헬퍼 ════
function sessIsoDate(ts){ const d=new Date(ts); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function sessMonthKey(ts){ return sessIsoDate(ts).slice(0,7); }
function sessLegacyDate(ts){ const d=new Date(ts); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function sessCapTs(inTs){ const d=new Date(inTs); d.setHours(0,0,0,0); return d.getTime() + 25*3600*1000; }
function sessDurationMin(inTs, outTs, awayMs){
  const eff = Math.min(outTs, sessCapTs(inTs));
  return Math.max(0, Math.round((eff - inTs - (awayMs||0)) / 60000));
}
function sessFmtKoTime(ts){ return new Date(ts).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}); }
window._sessHelpers = { sessIsoDate, sessMonthKey, sessLegacyDate, sessCapTs, sessDurationMin, sessFmtKoTime };

// ════ 클래식 — 테스트 계정·관리자석 ════
const TEST_STUDENTS = new Set(['이새봄', '정원혁', '손형준', '김근우', '이수연', '심사용계정']);
window.isTestStudent = function(name) {
  const base = String(name || '').replace(/\(.*?\)/g, '').replace(/\s/g, '').trim();
  return TEST_STUDENTS.has(base);
};
window.ADMIN_SEAT_MIN = 54;
window.ADMIN_SEAT_MAX = 63;
window.isAdminSeat = function(seat) {
  const n = parseInt(String(seat == null ? '' : seat).replace(/[^0-9]/g, ''), 10);
  if (!n) return false;
  if (n >= window.ADMIN_SEAT_MIN && n <= window.ADMIN_SEAT_MAX) return true;
  // 배치도 고정칸(ADMIN_FIXED)에만 있는 좌석도 관리자석으로 본다(관리자석을 늘릴 때 대비)
  return !!(window.ADMIN_FIXED && Object.values(window.ADMIN_FIXED).some(a => a.n === n));
};

// ════ 클래식 — 좌석→학생·uid ════
function _studentBySeatKey(sk){
  const digits = String(sk == null ? '' : sk).replace(/[^0-9]/g,'');
  if (!digits) return null;
  return (window.STUDENTS||[]).find(st => String(st.seat).replace(/[^0-9]/g,'') === digits) || null;
}
window._studentBySeatKey = _studentBySeatKey;
function _uidForSeat(seatKey, name) {
  const s = _studentBySeatKey(seatKey);
  if (s && s.uid && (!name || !s.name || window._sameStudentName(s.name, name))) return String(s.uid);
  if (name) {
    const hit = (window.STUDENTS || []).filter(x => x && x.uid && window._sameStudentName(x.name, name));
    if (hit.length === 1) return String(hit[0].uid);
  }
  return '';
}
window._uidForSeat = _uidForSeat;

// ════ 클래식 — 스케줄 문자열 해석 ════
window.parseScheduleStr =
function parseScheduleStr(str) {
  const empty = { absent: false, absentReason: '', periods: new Set(), partials: new Set(), partialTimes: {}, earlies: new Set(), earlyTimes: {}, absentPeriods: new Set(), absentReasons: {} };
  if (!str || str === '-') return empty;

  const periods = new Set();
  const partials = new Set();
  const partialTimes = {};
  const earlies = new Set();
  const earlyTimes = {};
  const absentPeriods = new Set();
  const absentReasons = {};

  // 쉼표로 토큰 분리
  const tokens = str.split(',').map(t => t.trim()).filter(Boolean);

  // 저장 순서에서 결석 교시 인덱스를 추적
  // 새 형식: x(사유) 토큰이 교시 인덱스에 해당
  // 유효 교시 목록을 순서대로 추출 (x포함, 숫자포함)
  let periodIdx = 6; // 평일 기본 7교시부터 시작 (인덱스 추적용)

  // 먼저 구버전 형식 체크: x(사유)로 시작하고 뒤에 숫자 범위
  // 예: "x(수학학원)7~9,10" 또는 "x(수학학원),7,8,9,10"
  const legacyMatch = str.match(/^x\(([^)]*)\)(.*)/);
  const isLegacy = legacyMatch && (tokens[0] === 'x' || tokens[0].match(/^x\([^)]*\)$/));

  if (isLegacy) {
    // 구버전: x(사유)가 전체에 적용, 뒤의 숫자는 출석
    const reason = legacyMatch ? legacyMatch[1] : '';
    tokens.forEach(token => {
      if (token.startsWith('x')) return; // x(사유) 스킵
      const rangeM = token.match(/^(\d+)~(\d+)$/);
      if (rangeM) {
        for (let i = Number(rangeM[1]); i <= Number(rangeM[2]); i++) periods.add(i);
        return;
      }
      const num = Number(token);
      if (!isNaN(num) && num >= 1 && num <= 11) periods.add(num);
    });
    // 출석이 아닌 교시 = 결석
    [7,8,9,10,11].forEach(n => {
      if (!periods.has(n)) { absentPeriods.add(n); if(reason) absentReasons[n] = reason; }
    });
  } else {
    // 새 형식: draftToStr가 validPeriods 순서대로 저장
    // "7,x(사유),9,x(사유2),11" → 토큰 i번째 = validPeriods[i]번째 교시
    // 토요일 여부: 첫 교시 번호(m/x 접두 포함)가 1~6이면 토요일
    let firstNum = null;
    for (const t of tokens) { const nm = t.match(/^[mxe]?(\d+)/i); if (nm) { firstNum = nm[1]; break; } }
    const hasSatPeriod = firstNum && Number(firstNum) >= 1 && Number(firstNum) <= 6;
    const validList = hasSatPeriod ? [1,2,3,4,5,6,7,8,9,10,11] : [7,8,9,10,11];

    tokens.forEach((token, i) => {
      // 0) 중간입실: m8 또는 m8(7:30) — 출석이면서 교시 중간 입실
      const midM = token.match(/^m(\d+)(?:\(([^)]*)\))?$/i);
      if (midM) {
        const mp = Number(midM[1]);
        periods.add(mp);
        partials.add(mp);
        if (midM[2]) partialTimes[mp] = midM[2];
        return;
      }
      // 0-1) 중간퇴실: e9 또는 e9(8:30) — 출석이면서 교시 도중 퇴실
      const earlyM = token.match(/^e(\d+)(?:\(([^)]*)\))?$/i);
      if (earlyM) {
        const ep = Number(earlyM[1]);
        periods.add(ep);
        earlies.add(ep);
        if (earlyM[2]) earlyTimes[ep] = earlyM[2];
        return;
      }
      // 1) 명시적 결석 (교시 번호 포함): x10 또는 x10(사유)
      const absNumM = token.match(/^x(\d+)(?:\(([^)]*)\))?$/i);
      if (absNumM) {
        const ap = Number(absNumM[1]);
        absentPeriods.add(ap);
        if (absNumM[2]) absentReasons[ap] = absNumM[2];
        return;
      }
      // 2) 구버전 위치기반 결석 (번호 없음): x 또는 x(사유)
      const absM = token.match(/^x(?:\(([^)]*)\))?$/i);
      if (absM) {
        const p = validList[i];
        if (p !== undefined) {
          absentPeriods.add(p);
          if (absM[1]) absentReasons[p] = absM[1];
        }
        return;
      }
      // 3) 출석 범위: a~b
      const rangeM = token.match(/^(\d+)~(\d+)$/);
      if (rangeM) {
        for (let k = Number(rangeM[1]); k <= Number(rangeM[2]); k++) periods.add(k);
        return;
      }
      // 4) 출석 단일 번호
      const num = Number(token);
      if (!isNaN(num) && num >= 1 && num <= 11) periods.add(num);
    });
  }

  const absent = absentPeriods.size > 0;
  return { absent, absentReason: '', periods, partials, partialTimes, earlies, earlyTimes, absentPeriods, absentReasons };
}

// ════ 모듈 — 세션 상수 ════
const SESS_COL = 'attendance_sessions';
const SESS_PTR_COL = 'current_sessions';
const SH = window._sessHelpers;

// ════ 모듈 — 미퇴실 세션 자동 마감 ════
const _sessCleanSeat = s => String(s == null ? '' : s).replace('번','').trim();
function _sessUid(student){
  if (student && student.uid) return String(student.uid);
  const s = window._studentBySeatKey ? window._studentBySeatKey(_sessCleanSeat(student && student.seat)) : null;
  return (s && s.uid) ? String(s.uid) : '';
}
function _sessFoldAway(sess, endTs){
  let away = sess.awayMs || 0;
  if (sess.awayStartTs) away += Math.max(0, Math.min(endTs, SH.sessCapTs(sess.inTs)) - sess.awayStartTs);
  return away;
}
function _sessPtrRef(name){ return doc(db, SESS_PTR_COL, String(name)); }
async function recomputeMonthHours(student, monthKey){
  const name = student.name, seat = _sessCleanSeat(student.seat);
  if (!name || !monthKey) return null;
  // 집계 기준을 이름에서 불변 학생ID(uid)로 올린다 — 이름은 개명·동명이인 정리로 바뀌고,
  // 그때마다 지난 기록이 끊겨 공부시간이 사라졌다(그래서 이름 변경 시 수동 이관이 필요했다).
  // uid 가 없는 학생(구 세션·신규)만 이름으로 내려간다.
  //
  // uid + monthKey 는 둘 다 '같음(==)' 조건이라 복합 색인이 필요 없다. Firestore 가 두 단일
  // 필드 색인을 병합(zigzag merge join)해서 처리한다 — 이 프로젝트에 복합 색인이 하나도 없는데도
  // studentName+date·studentName+monthKey 조회가 계속 돌아온 이유가 이것이다(2026-08-04 실측 확인).
  const _rcStu = (window._studentBySeatKey ? window._studentBySeatKey(seat) : null) || {};
  const _rcUid = student.uid || _rcStu.uid;
  const snap = await getDocs(query(collection(db, SESS_COL),
    _rcUid ? where('uid','==', _rcUid) : where('studentName','==', name),
    where('monthKey','==', monthKey)));
  // 오프라인 캐시 결과는 불완전할 수 있음 → 과소집계 값을 쓰지 않도록 보류
  // (다음 퇴실·재계산 버튼·자동마감 어디서든 온라인 상태에서 다시 맞춰진다)
  if (snap.metadata && snap.metadata.fromCache) {
    console.warn('[세션] 오프라인 캐시 조회 — hours 재계산 보류:', name, monthKey);
    return null;
  }
  let totalMin = 0;
  snap.forEach(d => {
    const v = d.data();
    if (v.monthKey !== monthKey) return;   // 쿼리로 이미 걸러지지만, 값이 어긋난 문서를 섞지 않도록 한 번 더
    if (v.status === 'closed' && typeof v.durationMin === 'number') totalMin += v.durationMin;
  });
  const hrs = Math.round(totalMin / 60 * 10) / 10;
  try {
    await updateDoc(doc(db, 'students', seat), { ['hours.' + monthKey]: hrs, updatedAt: serverTimestamp() });
  } catch(e) {
    console.warn('[세션] hours 저장 실패(문서 없음?):', seat, e);
    return null;
  }
  // 로컬 즉시 반영 (students onSnapshot도 곧 같은 값을 전달)
  if (!student.hours) student.hours = {};
  student.hours[monthKey] = hrs;
  const local = (window.STUDENTS || []).find(s => s.name === name);
  if (local) { if (!local.hours) local.hours = {}; local.hours[monthKey] = hrs; }
  try { if (typeof window.buildHoursTable === 'function') window.buildHoursTable(); } catch(e){}
  return hrs;
}
async function autoCloseStaleSessions(){
  try {
    const now = Date.now();
    const snap = await getDocs(query(collection(db, SESS_COL), where('status','==','open')));
    for (const d of snap.docs) {
      const o = d.data();
      if (now < SH.sessCapTs(o.inTs) + 3600*1000) continue; // 아직 입실 다음날 02:00 전
      try {
        await runTransaction(db, async tx => {
          const ref = doc(db, SESS_COL, d.id);
          const s = await tx.get(ref);
          if (!s.exists() || s.data().status !== 'open') return; // 다른 기기가 먼저 마감
          const v = s.data();
          const ptrRef = _sessPtrRef(v.studentName);
          const ptrSnap = await tx.get(ptrRef); // 읽기는 반드시 모든 쓰기보다 먼저
          const cap = SH.sessCapTs(v.inTs);
          const away = _sessFoldAway(v, cap);
          tx.update(ref, { outTs: cap, awayMs: away, awayStartTs: null,
            durationMin: SH.sessDurationMin(v.inTs, cap, away),
            status:'closed', closedBy:'auto', updatedAt: now });
          if (ptrSnap.exists() && ptrSnap.data().sessionId === d.id) tx.delete(ptrRef);
        });
        recomputeMonthHours({ name: o.studentName, seat: o.seat }, o.monthKey).catch(console.error);
        console.log(`[세션] 미퇴실 자동 마감: ${o.studentName} (${o.inDate} 입실 → 01:00 상한)`);
      } catch(e){ console.warn('[세션] 자동 마감 실패(다음 기회에 재시도):', o.studentName, e); }
    }
  } catch(e){ console.warn('[세션] 자동 마감 스캔 실패:', e); }
}

// ════ 모듈 — 새벽 스케줄 초기화·예약 좌석 적용 ════
async function _dailyResetAlreadyDone(dateStr) {
  try {
    const snap = await getDoc(doc(db, 'students', '_meta_daily_reset'));
    return snap.exists() && snap.data().date === dateStr;
  } catch(e) {
    console.warn('리셋 완료여부 확인 실패 — 이 기기에서 진행:', e);
    return false; // 확인 실패 시 진행(멱등이라 중복돼도 안전)
  }
}
async function _markDailyResetDone(dateStr) {
  try {
    await setDoc(doc(db, 'students', '_meta_daily_reset'),
      { name: '', date: dateStr, by: DOOR_DEVICE_ID, at: Date.now() });
  } catch(e) { console.warn('리셋 완료 표시 실패:', e); }
}
window.resetSchedulesToBase = async function() {
  const RDAYS = ['월','화','수','목','금','토'];
  let count = 0;
  const _dateStr = new Date().toLocaleDateString('ko-KR');
  // 다른 기기가 이미 오늘 리셋을 끝냈으면 Firestore 쓰기는 건너뛰고 로컬 정리만 한다.
  if (await _dailyResetAlreadyDone(_dateStr)) { _resetLocalAfterDailyReset(0); return; }
  // ── '오늘'의 당일변경은 지우면 안 된다 ──
  // 학생앱은 자정이 지나면 곧바로 그날을 '오늘'로 보고 수정을 허용하는데(학생앱 todayDay는
  // 달력 요일 기준), 이 리셋은 02시에 돈다. 그래서 00:00~02:00 사이에 들어온 '오늘' 변경까지
  // 어제 것과 함께 지워지던 버그가 있었다(학생·학부모는 변경 알림톡을 이미 받은 뒤라
  // 관리자 화면만 고정 시간표로 되돌아감 → 미입실 알림 오발송).
  // 학생앱 applyBaseAndRevert()와 동일하게, 오늘 날짜의 daily_reports를 오늘 요일에 다시 얹는다.
  // ※ 여기서는 getTodayDayName()(새벽 3시 경계)이 아니라 달력 요일을 쓴다 — daily_reports를
  //   기록하는 학생앱이 달력 요일 기준이라 그쪽과 키를 맞춰야 한다.
  const _now = new Date();
  const _todayIso = SH.sessIsoDate(_now.getTime());
  const _todayDay = ['일','월','화','수','목','금','토'][_now.getDay()];
  try {
    // 오늘자 당일변경: seatKey → 오늘 요일 스케줄 문자열
    const _todayOverrides = {};
    if (RDAYS.includes(_todayDay)) {
      const rptSnap = await getDocs(query(collection(db, 'daily_reports'), where('date', '==', _todayIso)));
      rptSnap.forEach(rdoc => {
        const rd = rdoc.data();
        if (typeof rd.schedule !== 'string') return;
        const sk = rdoc.id.startsWith(_todayIso + '_') ? rdoc.id.slice(_todayIso.length + 1) : null;
        if (sk) _todayOverrides[sk] = rd.schedule;
      });
    }
    const baseSnap = await getDocs(collection(db, 'schedule_base'));
    const writes = [];
    baseSnap.forEach(bdoc => {
      const seatKey = bdoc.id;
      const bd = bdoc.data();
      // 이 좌석의 리셋 목표값 = 고정 시간표, 단 오늘 요일은 오늘자 당일변경이 있으면 그 값
      const _val = d => (d === _todayDay && _todayOverrides[seatKey] != null)
        ? _todayOverrides[seatKey] : (bd[d] || '-');
      // schedules를 원본값으로 덮어씀. changedBy:'admin' → schedules onSnapshot이
      // 이 되돌림을 '학생발 변경'으로 오인해 알림을 만들지 않도록 표시한다.
      const payload = { name: bd.name || '', seat: bd.seat || seatKey, updatedAt: serverTimestamp(), changedBy: 'admin' };
      RDAYS.forEach(d => { payload[d] = _val(d); });
      writes.push(setDoc(doc(db, 'schedules', seatKey), payload));
      // 실재하는 학생일 때만: students 컬렉션 요일 필드도 원본으로 되돌리고(새로고침 후에도
      // 고정 시간표가 보이도록), 로컬 STUDENTS 배열도 동기화(관리자 스케줄 표 즉시 반영).
      // (STUDENTS에 없는 좌석에 students 문서를 새로 만들어 유령 학생이 생기는 것을 방지)
      const st = (window.STUDENTS || []).find(s =>
        (s.seat || '').replace(/[^0-9]/g,'') === seatKey || s.seat === bd.seat);
      if (st) {
        if (st.schedule) RDAYS.forEach(d => { st.schedule[d] = _val(d); });
        const stuPayload = {};
        RDAYS.forEach(d => { stuPayload[d] = _val(d); });
        writes.push(setDoc(doc(db, 'students', seatKey), stuPayload, { merge: true }));
      }
      count++;
    });
    await Promise.all(writes);
  } catch(e) {
    // 쓰기 실패 시 완료 표시를 남기지 않는다 → 다른 기기(또는 다음 기회)가 다시 시도.
    console.error('스케줄 원본 복구 실패:', e);
    return;
  }
  // 리셋을 끝냈으니 이제 완료 표시 → 시차 두고 도는 다른 기기는 중복 쓰기를 건너뛴다.
  await _markDailyResetDone(_dateStr);
  // 어제의 알림 내용·처리상태·미입실 발송기록을 메타 문서에서 정리 (무한 성장 방지 겸
  // 하루 지난 알림이 새로 켜지는 기기에 다시 나타나지 않도록).
  try { await updateDoc(doc(db, 'students', '_meta_schedule_alerts'), { alerts: {}, states: {} }); } catch(e) {}
  try { await updateDoc(doc(db, 'students', '_meta_absent_sms'), { keys: {} }); } catch(e) {}
  try { await updateDoc(doc(db, 'students', '_meta_auto_sms'), { keys: {} }); } catch(e) {}
  _resetLocalAfterDailyReset(count);
};
async function commitPendingSeatsIfDue(forceAll) {
  const _db = window._adminDb || db;
  if (!_db) return 0;
  let psnap;
  try { psnap = await getDocs(collection(_db, 'pendingSeats')); } catch(e) { return 0; }
  if (!psnap || psnap.empty) return 0;
  const todayIso = SH.sessIsoDate(Date.now());
  const due = [];
  psnap.forEach(pd => {
    const p = pd.data();
    const eff = p.effectiveDate || '';
    if (forceAll || !eff || eff <= todayIso) {
      due.push({ id: pd.id, name: p.name || '', fromSeat: p.fromSeat || '', toSeat: String(p.toSeat || pd.id), studentData: p.studentData || null });
    }
  });
  if (!due.length) return 0;
  let done = 0;
  for (const res of due) {
    try { await _commitOneReservation(_db, res); done++; }
    catch(e) { console.error('예약 반영 실패:', res, e); }
  }
  // 남은 예약이 없으면 설정의 effectiveDate도 비워 둔다(다음 학생 선택은 즉시 적용).
  try {
    const remain = await getDocs(collection(_db, 'pendingSeats'));
    if (remain.empty) await setDoc(doc(_db, 'settings', 'seatSelection'), { effectiveDate: '' }, { merge: true });
  } catch(e) {}
  // 화면 반영
  try { if (window.loadStudentsFromFirebase) await window.loadStudentsFromFirebase(); } catch(e) {}
  try { if (window.buildFloorplan) buildFloorplan(); } catch(e) {}
  try { if (window.buildDashboard) buildDashboard(); } catch(e) {}
  if (done) showAdminToast(`🪑 예약된 자리변경 ${done}건이 적용됐습니다`);
  return done;
}
async function _commitOneReservation(_db, res) {
  const to = String(res.toSeat);
  const from = res.fromSeat ? String(res.fromSeat) : '';
  await runTransaction(_db, async (tx) => {
    const resRef = doc(_db, 'pendingSeats', res.id);
    const rs = await tx.get(resRef);
    if (!rs.exists()) return; // 다른 기기가 이미 처리함
    const toRef = doc(_db, 'students', to);
    const toSnap = await tx.get(toRef);
    // 원본 좌석 데이터(관리자 관리 필드 보존) — 없으면 예약에 담긴 스냅샷 사용(랜덤 예약)
    let base = res.studentData || {};
    const fromRef = (from && from !== to) ? doc(_db, 'students', from) : null;
    if (fromRef) { const fs = await tx.get(fromRef); if (fs.exists()) base = fs.data(); }
    // 대상이 이미 다른 학생 점유면(이론상 없음 — 예약은 빈자리만) 이동 없이 예약만 정리
    if (toSnap.exists() && toSnap.data().name && toSnap.data().name !== res.name) { tx.delete(resRef); return; }
    tx.set(toRef, { ...base, seat: to, name: res.name, updatedAt: serverTimestamp() });
    if (fromRef) tx.delete(fromRef);
    tx.delete(resRef);
  });
  // schedules / schedule_base 이동 (본인 데이터라 경합 낮음 → 트랜잭션 밖, 멱등)
  if (from && from !== to) {
    for (const col of ['schedules', 'schedule_base']) {
      try {
        const snap = await getDoc(doc(_db, col, from));
        if (snap.exists()) await setDoc(doc(_db, col, to), { ...snap.data(), seat: to, name: res.name, updatedAt: serverTimestamp() });
      } catch(e) {}
    }
    for (const col of ['schedules', 'schedule_base']) {
      for (const id of [from, from + '번']) {
        try { await deleteDoc(doc(_db, col, id)); } catch(e) {}
      }
    }
    try { await deleteDoc(doc(_db, 'students', from + '번')); } catch(e) {}
  }
}
window.commitPendingSeatsIfDue = commitPendingSeatsIfDue;

// ════ 모듈 — 벌점(무단결석·지각)·주간목표·주기·플래너 상점 ════
const NOSHOW_POINTS = 2;
const NOSHOW_LOOKBACK_DAYS = 3;
const NOSHOW_WEEKDAY_MORNING_FROM = '2026-07-22';
const NOSHOW_PERIOD_TIMES = {
  1:[540,600], 2:[610,670], 3:[680,750], 4:[810,870], 5:[880,940], 6:[950,1020],
  7:[1080,1130], 8:[1140,1220], 9:[1230,1320], 10:[1350,1430], 11:[1440,1500]
};
const NOSHOW_MID_ENTRY_GRACE_MIN = 20;
const LATE_POINTS = 1;
const LATE_GRACE_MIN = 5;
const LATE_FROM = '2026-07-28';
async function _noshowDoneMap() {
  try {
    const snap = await getDoc(doc(db, 'students', '_meta_noshow_done'));
    return snap.exists() ? (snap.data().dates || {}) : {};
  } catch(e) { return {}; } // 확인 실패 시 진행(멱등이라 중복돼도 안전)
}
async function _markNoshowDone(dateIso, info) {
  // merge:true 중첩 병합 — 다른 기기가 다른 날짜를 동시에 기록해도 서로 덮어쓰지 않는다.
  try {
    await setDoc(doc(db, 'students', '_meta_noshow_done'),
      { name: '', dates: { [dateIso]: info } }, { merge: true });
  } catch(e) { console.warn('무단결석 완료표시 실패:', e); }
}
window.assessNoShowPenalties = async function() {
  // 학생 목록·parseScheduleStr(classic 스크립트)이 준비될 때까지 대기 (최대 30초)
  for (let i = 0; i < 100 && !(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr); i++) {
    await new Promise(r => setTimeout(r, 300));
  }
  if (!(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr)) return;
  const now = Date.now();
  const done = await _noshowDoneMap();
  for (let ago = NOSHOW_LOOKBACK_DAYS; ago >= 1; ago--) {
    const d = new Date(); d.setDate(d.getDate() - ago); d.setHours(0, 0, 0, 0);
    const d0 = d.getTime();
    const dIso = SH.sessIsoDate(d0);
    if (done[dIso]) continue;
    if (now < d0 + 26 * 3600 * 1000) continue; // D+1 02:00 이전 — 11교시가 아직 안 끝났을 수 있음
    const dayName = ['일','월','화','수','목','금','토'][d.getDay()];
    if (dayName === '일') {
      await _markNoshowDone(dIso, { skipped: '일요일', at: now, by: DOOR_DEVICE_ID });
      continue;
    }
    await _assessNoShowForDate(dIso, d0, dayName);
  }
};
const NOSHOW_INTRADAY_GRACE_MIN = 15;
const _intradayNoShowDone = {};
let _intradayNoShowNextTs = 0;
window.assessNoShowIntraday = async function() {
  if (!(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr)) return;
  const now = Date.now();
  if (now < _intradayNoShowNextTs) return;

  // 운영일 기준: 00:00~01:59는 아직 전날(11교시가 익일 새벽에 걸침)
  const d = new Date(now);
  if (d.getHours() < 2) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  const d0 = d.getTime();
  const dayName = ['일','월','화','수','목','금','토'][d.getDay()];
  if (dayName === '일') return;
  const dIso = SH.sessIsoDate(d0);

  const mins = (now - d0) / 60000; // 그날 자정 기준 경과 분 (11교시는 1440~1500)
  const done = (_intradayNoShowDone[dIso] = _intradayNoShowDone[dIso] || new Set());
  const ready = new Set();
  Object.keys(NOSHOW_PERIOD_TIMES).forEach(k => {
    const pn = Number(k);
    if (done.has(pn)) return;
    // 중간입실 유예까지 지난 뒤에 판정한다 — 유예 중에 찍으면 늦게 온 학생이 이미 앉아 있는데도
    // 무단결석이 부과된다(그 교시가 중간입실인지는 학생별이라 여기서는 알 수 없으므로 일괄 적용).
    if (mins >= NOSHOW_PERIOD_TIMES[pn][1] + NOSHOW_INTRADAY_GRACE_MIN + NOSHOW_MID_ENTRY_GRACE_MIN) ready.add(pn);
  });
  if (!ready.size) return;

  const ok = await _assessNoShowForDate(dIso, d0, dayName, ready);
  if (ok) ready.forEach(pn => done.add(pn));
  else _intradayNoShowNextTs = now + 30 * 60000; // 아직 세션 0건(휴관 등) — 30분 뒤 재시도
};
async function _awayIntervalsByName(dIso, d0) {
  const toLegacy = iso => { const [y, m, dd] = iso.split('-').map(Number); return `${y}-${m}-${dd}`; };
  const nextIso = SH.sessIsoDate(d0 + 24 * 3600 * 1000);
  const endTs = d0 + 26 * 3600 * 1000; // 익일 02:00 — 11교시(01:00) 종료 이후
  const byName = {};
  try {
    const snap = await getDocs(query(collection(db, 'checkin_logs'),
      where('date', 'in', [toLegacy(dIso), toLegacy(nextIso)])));
    const evs = {};
    snap.forEach(x => {
      const l = x.data();
      if (l.away !== true || !l.studentName || typeof l.ts !== 'number') return;
      (evs[l.studentName] = evs[l.studentName] || []).push(l);
    });
    Object.keys(evs).forEach(name => {
      const list = evs[name].sort((a, b) => a.ts - b.ts);
      const out = [];
      let open = null;
      list.forEach(e => {
        if (e.type === 'out') {
          if (open !== null) out.push([open, e.ts]); // 복귀 없이 또 외출 — 끊지 않고 이어 붙인다
          open = e.ts;
        } else if (e.type === 'in' && open !== null) {
          out.push([open, e.ts]); open = null;
        }
      });
      if (open !== null) out.push([open, endTs]);
      byName[name] = out;
    });
  } catch(e) {
    // 조회 실패 시 외출 없음으로 진행 — 판정이 종전(외출 미반영)과 같아질 뿐 오판정은 아니다
    console.warn('[지각] 외출 구간 조회 실패 — 외출 미반영으로 진행:', e);
  }
  return byName;
}
function _firstPresentTs(sessions, aways, ps, pe) {
  let pieces = sessions.map(iv => [iv[0], iv[1]]);
  (aways || []).forEach(a => {
    const next = [];
    pieces.forEach(p => {
      if (a[1] <= p[0] || a[0] >= p[1]) { next.push(p); return; } // 안 겹침
      if (a[0] > p[0]) next.push([p[0], a[0]]);   // 나가기 전 조각
      if (a[1] < p[1]) next.push([a[1], p[1]]);   // 복귀 후 조각
    });
    pieces = next;
  });
  const hit = pieces.filter(p => p[0] < pe && p[1] > ps);
  return hit.length ? Math.min.apply(null, hit.map(p => p[0])) : null;
}
async function _assessNoShowForDate(dIso, d0, dayName, onlyPeriods) {
  try {
    // 1) 그날 입실 세션 (11교시가 익일 새벽에 걸치므로 다음날 inDate도 함께 조회)
    const nextIso = SH.sessIsoDate(d0 + 24 * 3600 * 1000);
    const sessSnap = await getDocs(query(collection(db, SESS_COL), where('inDate', 'in', [dIso, nextIso])));
    let dayCount = 0;
    const sessByName = {};
    sessSnap.forEach(x => {
      const s = x.data();
      if (!s.studentName || typeof s.inTs !== 'number') return;
      if (s.inDate === dIso) dayCount++;
      (sessByName[s.studentName] = sessByName[s.studentName] || [])
        .push([s.inTs, typeof s.outTs === 'number' ? s.outTs : Date.now()]);
    });
    if (dayCount === 0) {
      // 당일 부분판정은 아직 아무도 안 온 이른 시간일 수 있으므로 완료표시 없이 물러난다(나중에 재시도).
      if (onlyPeriods) return false;
      console.log(`[무단결석] ${dIso}: 입실 세션 없음(휴관/미가동 추정) — 판정 건너뜀`);
      await _markNoshowDone(dIso, { skipped: '세션 없음', at: Date.now(), by: DOOR_DEVICE_ID });
      return true;
    }

    // 1-b) 그날 외출 구간 — 지각 판정에서 '자리에 없던 시간'으로 뺀다(무단결석 판정은 종전대로 세션 기준)
    const awayByName = await _awayIntervalsByName(dIso, d0);

    // 2) 그날 유효 스케줄 = 고정 시간표(base)에 그날의 당일변경(daily_reports)을 덮어쓴 값
    const [baseSnap, rptSnap] = await Promise.all([
      getDocs(collection(db, 'schedule_base')),
      getDocs(query(collection(db, 'daily_reports'), where('date', '==', dIso)))
    ]);
    const rptBySeat = {};
    rptSnap.forEach(x => {
      const r = x.data();
      if (typeof r.schedule !== 'string') return;
      const sk = x.id.slice(x.id.lastIndexOf('_') + 1);
      rptBySeat[sk] = r.schedule;
    });

    // 3) 학생별로 출석 예정 교시 vs 세션 겹침 검사
    const writes = [];
    baseSnap.forEach(bdoc => {
      const seatKey = bdoc.id;
      const bd = bdoc.data();
      if ((parseInt(seatKey) || 0) >= 54) return; // 관리자석
      const st = (window.STUDENTS || []).find(s => (s.seat || '').replace(/[^0-9]/g, '') === seatKey);
      if (!st) return; // 실재 학생만(퇴원 잔재·유령 문서 방지)
      const schedStr = (rptBySeat[seatKey] !== undefined) ? rptBySeat[seatKey] : (bd[dayName] || '-');
      const parsed = window.parseScheduleStr(schedStr);
      if (!parsed || !parsed.periods || !parsed.periods.size) return; // 출석 예정 교시 없음(전일 불참·'-'·근무 등)
      // 세션·포인터는 students 컬렉션 이름(st.name)으로 저장되므로 그것을 우선한다.
      // schedule_base의 name(bd.name)은 개명(동명이인 구분자 등) 시 갱신되지 않아 stale일 수 있고,
      // stale 이름으로 sessByName을 조회하면 출석했는데도 세션 0건→전 교시 무단결석 오판이 난다.
      const name = st.name || bd.name;
      if (window.isTestStudent && window.isTestStudent(name)) return; // 테스트 계정 — 무단결석 벌점 없음
      const sessions = sessByName[name] || [];
      const missed = [], late = [];
      parsed.periods.forEach(pn => { // periods = o + △(중간입실) + ▽(중간퇴실) 모두 '출석 예정'
        if (onlyPeriods && !onlyPeriods.has(pn)) return; // 당일 부분판정 — 끝난 교시만
        // 방학 평일 오전(1~6교시) 무단결석 판정은 2026-07-22부터 적용(사용자 확정).
        // 그 전 날짜는 오전 교시가 운영되지 않았거나 전환 과도기라 소급 판정하지 않는다.
        // ※토요일 오전은 원래부터 판정 대상이므로 제외하지 않는다.
        if (pn <= 6 && dayName !== '토' && dIso < NOSHOW_WEEKDAY_MORNING_FROM) return;
        const w = NOSHOW_PERIOD_TIMES[pn];
        if (!w) return;
        // 중간입실(△) 신고 교시는 교시 종료 후 유예까지 인정 — 위 NOSHOW_MID_ENTRY_GRACE_MIN 참고
        const isPartial = !!(parsed.partials && parsed.partials.has(pn));
        const grace = isPartial ? NOSHOW_MID_ENTRY_GRACE_MIN : 0;
        const ps = d0 + w[0] * 60000, pe = d0 + (w[1] + grace) * 60000;
        const hit = sessions.filter(iv => iv[0] < pe && iv[1] > ps); // 일부라도 겹치면 출석
        if (!hit.length) { missed.push(pn); return; }
        // 지각 — 교시 시작 유예를 넘겨 처음 '자리에 있게 된' 경우. 외출 중이던 구간은 재실로 치지
        // 않으므로 식사 등으로 나갔다 늦게 복귀한 것도 예외 없이 지각이다(2026-08-01 원장 지시).
        // 교시 시작 전부터 앉아 있었으면 조각 시작이 ps보다 앞이라 자동으로 지각이 아니게 된다.
        if (dIso >= LATE_FROM && !isPartial) {
          const firstIn = _firstPresentTs(hit, awayByName[name], ps, pe);
          if (firstIn !== null && firstIn > ps + LATE_GRACE_MIN * 60000) {
            // 실제 입실 시각과 늦은 분을 함께 남긴다 — changedAt은 '판정한 시각'이라
            // 학생·학부모에게 근거를 보여줄 수 없다(새벽 2시로 찍힌다).
            // byAway: 처음 온 게 아니라 외출에서 늦게 복귀한 경우 — 표시 문구를 '복귀'로 바꾼다.
            const byAway = (awayByName[name] || []).some(a => a[1] === firstIn);
            late.push({ pn, inAt: firstIn, lateMin: Math.round((firstIn - ps) / 60000), byAway });
          }
        }
      });
      if (missed.length || late.length) writes.push(_writeAttendPenalty(dIso, dayName, seatKey, bd.seat || st.seat, name, missed, late));
    });
    await Promise.all(writes);
    if (onlyPeriods) {
      console.log(`[무단결석] ${dIso}(${dayName}) ${[...onlyPeriods].join('·')}교시 즉시판정 — 벌점 대상 ${writes.length}명`);
      return true;
    }
    await _markNoshowDone(dIso, { at: Date.now(), by: DOOR_DEVICE_ID, students: writes.length });
    console.log(`[무단결석] ${dIso}(${dayName}) 판정 완료 — 벌점 대상 ${writes.length}명`);
    return true;
  } catch(e) {
    // 완료표시를 남기지 않는다 → 다음 시작/리셋 때 재시도(판정은 멱등)
    console.error('무단결석 판정 실패:', dIso, e);
    return false;
  }
}
async function _writeAttendPenalty(dIso, dayName, seatKey, seat, name, missed, late) {
  const ref = doc(db, 'penalties', `${dIso}_${seatKey}`);
  let prevData = {};
  try {
    const s = await getDoc(ref);
    if (s.exists()) prevData = s.data();
  } catch(e) {}
  const periods = { ...(prevData.periods || {}) };
  const at = Date.now();
  missed.forEach(pn => {
    const k = String(pn);
    const prev = periods[k];
    if (prev && prev.type === 'noshow') return; // 이미 기록됨 — 취소 상태 포함 그대로 유지
    // (드문 경우) 늦은변경 1점 기록 후 다시 출석으로 되돌리고 안 온 학생은
    // 최종 상태가 '통보 없는 결석'이므로 무단결석 2점으로 대체한다.
    periods[k] = {
      type: 'noshow', points: NOSHOW_POINTS,
      from: 'attend', to: 'noshow', reason: '',
      changedAt: at, canceled: !!(prev && prev.canceled)
    };
  });
  (late || []).forEach(it => {
    const k = String(it.pn);
    // 이미 무엇이든 기록된 교시는 건드리지 않는다 — 무단결석(2점)·늦은변경(1점)이 지각보다 무겁거나
    // 같은 사안이고, 이미 부과된 지각을 재판정에서 다시 쓰면 관리자의 취소가 풀린다.
    if (periods[k]) return;
    periods[k] = {
      type: 'late', points: LATE_POINTS,
      from: 'attend', to: 'late', reason: '',
      inAt: it.inAt, lateMin: it.lateMin,   // 실제 입실 시각 · 늦은 분 (표시·이의제기 근거)
      ...(it.byAway ? { byAway: true } : {}),  // 외출에서 늦게 복귀한 지각
      changedAt: at, canceled: false
    };
  });
  const _uid = prevData.uid || (window._uidForSeat ? window._uidForSeat(seatKey, name) : '');
  await setDoc(ref, {
    name: name, seat: seat, seatKey: seatKey,
    date: dIso, day: dayName, periods: periods,
    ...(_uid ? { uid: _uid } : {}),
    updatedAt: serverTimestamp()
  });
}
const WEEKLY_START_ISO = '2026-07-20';
const WEEKLY_END_ISO = '2026-12-31';
const WEEKLY_MERIT_POINTS = 2;
const WEEKLY_CHALLENGES = {
  '2026-07-27': { goalH: 45, points: 10, label: '주간 순공 챌린지(45시간) 달성' },
  '2026-08-03': { goalH: 65, points: 15, label: '주간 순공 챌린지(65시간) 달성' },
  '2026-08-09': { goalH: 45, points: 10, label: '주간 순공 챌린지(45시간) 달성' },
};
const PLANNER_WEEKLY_POINTS = 2;
const PLANNER_SUBMIT_RATE = 0.8;
const PLANNER_MIN_ATTEND = 3;
const _WEEKLY_DN = ['일','월','화','수','목','금','토'];
function _periodDurMin(pn){ const w = NOSHOW_PERIOD_TIMES[pn]; return w ? (w[1] - w[0]) : 0; }
function _mondayOf(dateLike){ const x = new Date(dateLike); x.setHours(0,0,0,0); x.setDate(x.getDate() - ((x.getDay()+6)%7)); return x; }
async function _weeklyDoneMap(){
  try { const s = await getDoc(doc(db, 'students', '_meta_weekly_goal_done')); return s.exists() ? (s.data().weeks || {}) : {}; }
  catch(e){ return {}; }
}
async function _markWeeklyDone(weekIso, info){
  try { await setDoc(doc(db, 'students', '_meta_weekly_goal_done'), { name:'', weeks:{ [weekIso]: info } }, { merge:true }); }
  catch(e){ console.warn('주간 판정 완료표시 실패:', e); }
}
window.assessWeeklyGoals = async function(){
  for (let i = 0; i < 100 && !(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr); i++) await new Promise(r => setTimeout(r, 300));
  if (!(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr)) return;
  const now = Date.now();
  const done = await _weeklyDoneMap();
  const startMon = _mondayOf(WEEKLY_START_ISO + 'T00:00:00');
  const thisMon  = _mondayOf(new Date());
  for (let wk = new Date(startMon); wk < thisMon; wk.setDate(wk.getDate() + 7)) {
    const weekIso = SH.sessIsoDate(wk.getTime()); // 주 키 = 그 주 월요일 ISO
    if (done[weekIso]) continue;
    if (SH.sessIsoDate(wk.getTime() + 5*24*3600*1000) > WEEKLY_END_ISO) continue; // 그 주 토요일이 주기 종료 이후면 판정 안 함
    if (now < wk.getTime() + 7*24*3600*1000 + 2*3600*1000) continue; // 다음 월요일 02:00 이후에만(11교시 자정넘김 여유)
    await _assessWeekGoals(new Date(wk), weekIso);
  }
};
async function _assessWeekGoals(monDate, weekIso){
  try {
    // dayIsos = 월~토. 교시가 있는 날이라 '승인변경 차감'과 플래너 성실 판정은 이 6일만 본다.
    // sumIsos = 월~일. 순공 합계는 일요일(자율등원)까지 더한다 — 토요일 11교시 자정넘김도 이 날짜로 들어온다.
    const dayIsos = [], dayNames = [];
    for (let i = 0; i < 6; i++){ const d = new Date(monDate); d.setDate(d.getDate()+i); dayIsos.push(SH.sessIsoDate(d.getTime())); dayNames.push(_WEEKLY_DN[d.getDay()]); }
    const satDate = new Date(monDate); satDate.setDate(satDate.getDate()+5);
    const satIso = dayIsos[5];
    const sun = new Date(monDate); sun.setDate(sun.getDate()+6);
    const sunIso = SH.sessIsoDate(sun.getTime());
    const sumIsos = [...dayIsos, sunIso];

    // 1) 순공 집계 (inDate 'in' 30개 청크)
    const chunks = []; for (let i = 0; i < sumIsos.length; i += 30) chunks.push(sumIsos.slice(i, i+30));
    const snaps = await Promise.all(chunks.map(c => getDocs(query(collection(db, SESS_COL), where('inDate', 'in', c)))));
    let sessCount = 0; const minByName = {}; const attendDaysByName = {};
    snaps.forEach(snap => snap.forEach(x => {
      const s = x.data(); if (!s.studentName || typeof s.inTs !== 'number') return;
      if (sumIsos.includes(s.inDate)) sessCount++;   // 휴관주 판정 — 일요일만 나온 주도 판정 대상이다
      if (dayIsos.includes(s.inDate)) (attendDaysByName[s.studentName] = attendDaysByName[s.studentName] || new Set()).add(s.inDate); // 플래너 성실 분모는 교시가 있는 월~토만
      let m = 0;
      if (s.status === 'closed' && typeof s.durationMin === 'number') m = s.durationMin;
      else if (s.status === 'open') { let away = s.awayMs || 0; if (s.awayStartTs) away += Math.max(0, Math.min(Date.now(), sessCapTs(s.inTs)) - s.awayStartTs); m = sessDurationMin(s.inTs, Date.now(), away); }
      minByName[s.studentName] = (minByName[s.studentName] || 0) + m;
    }));
    if (sessCount === 0) { await _markWeeklyDone(weekIso, { skipped:'세션 없음', at: Date.now() }); return; } // 휴관주 추정

    // 2) base 스케줄 + 그 주 daily_reports (승인변경 차감용)
    const [baseSnap, ...rptSnaps] = await Promise.all([
      getDocs(collection(db, 'schedule_base')),
      ...chunks.map(c => getDocs(query(collection(db, 'daily_reports'), where('date', 'in', c))))
    ]);
    const rptMap = {}; // seatKey → { dateIso: scheduleStr }
    rptSnaps.forEach(snap => snap.forEach(x => {
      const r = x.data(); if (typeof r.schedule !== 'string') return;
      const id = x.id, cut = id.lastIndexOf('_');
      const seatKey = id.slice(cut+1), date = id.slice(0, cut);
      (rptMap[seatKey] = rptMap[seatKey] || {})[date] = r.schedule;
    }));

    // 플래너 제출일 집계(성실 상점용) — planners.seat(학생앱 _plSeatKey 규칙) → 그 주 제출 날짜 Set
    const plSnaps = await Promise.all(chunks.map(c => getDocs(query(collection(db, 'planners'), where('date', 'in', c)))));
    // 플래너 문서는 '제출 당시 좌석'으로 저장된다 — 그 주에 자리를 옮긴 학생은 두 좌석에 걸쳐 있고,
    // 옛 좌석엔 이전 주인의 제출이 남아 있다(2026-09-02 실측). 그래서 좌석이 아니라 주인(uid, 없으면
    // 이름 — saebom-common.js _ownsDoc)으로 모은다.
    const plDocs = [];
    plSnaps.forEach(snap => snap.forEach(x => {
      const v = x.data(); if (!v || !v.date || !dayIsos.includes(v.date)) return;
      plDocs.push(v);
    }));
    const subDatesFor = st => { const set = new Set(); plDocs.forEach(v => { if (window._ownsDoc(v, st)) set.add(v.date); }); return set; };

    // 3) 학생별 판정
    const writes = [], plWrites = [];
    baseSnap.forEach(bdoc => {
      const seatKey = bdoc.id;
      if ((parseInt(seatKey) || 0) >= 54) return; // 관리자석
      const st = (window.STUDENTS || []).find(s => (s.seat || '').replace(/[^0-9]/g, '') === seatKey);
      if (!st) return;
      if (window.isTestStudent && window.isTestStudent(st.name)) return;

      // 플래너 성실 상점(목표 순공과 독립 — 목표 미설정 학생도 대상)
      const attDates = attendDaysByName[st.name] || new Set();
      if (attDates.size >= PLANNER_MIN_ATTEND) {
        const subDates = subDatesFor(st);
        const onAttend = [...attDates].filter(dd => subDates.has(dd)).length;
        if (onAttend / attDates.size >= PLANNER_SUBMIT_RATE) plWrites.push(_writePlannerWeeklyMerit(st, seatKey, weekIso, satIso, onAttend, attDates.size));
      }

      const chal = WEEKLY_CHALLENGES[weekIso];
      const goalH = chal ? chal.goalH : (Number(st.weeklyGoalH) || 0);
      if (goalH <= 0) return; // 목표 미설정 → 순공 판정 제외
      const bd = bdoc.data();
      // 차감: base 출석예정이었으나 effective(daily_reports)에서 빠진 교시의 예정분
      // (챌린지 주간은 전원 고정 목표라 차감 없음 — 실순공이 goalH 이상이어야 달성)
      let deductMin = 0;
      if (!chal) for (let i = 0; i < 6; i++){
        const baseStr = bd[dayNames[i]] || '-';
        const bp = window.parseScheduleStr(baseStr);
        if (!bp || !bp.periods || !bp.periods.size) continue;
        const effStr = (rptMap[seatKey] && rptMap[seatKey][dayIsos[i]] !== undefined) ? rptMap[seatKey][dayIsos[i]] : baseStr;
        const ep = window.parseScheduleStr(effStr);
        const effPeriods = (ep && ep.periods) ? ep.periods : new Set();
        bp.periods.forEach(pn => { if (!effPeriods.has(pn)) deductMin += _periodDurMin(pn); });
      }
      const adjGoalMin = Math.max(0, goalH*60 - deductMin);
      if (adjGoalMin <= 0) return; // 그 주 예정이 전부 승인결석 → 대상 아님
      const actualMin = minByName[st.name] || 0;
      if (actualMin >= adjGoalMin) writes.push(_writeWeeklyMerit(st, seatKey, weekIso, satIso, adjGoalMin, actualMin, chal)); // 달성만 보상, 미달 벌점 없음
    });
    await Promise.all([...writes, ...plWrites]);
    await _markWeeklyDone(weekIso, { at: Date.now(), students: writes.length, planner: plWrites.length });
    console.log(`[주간목표] ${weekIso} 판정 완료 — 목표 ${writes.length}명 · 플래너성실 ${plWrites.length}명`);
  } catch(e){ console.error('주간 목표 판정 실패:', weekIso, e); } // 완료표시 안 남김 → 다음 시작 때 재시도(멱등)
}
const _meritUid = (st, seatKey, prev) =>
  (prev && prev.uid) || (st && st.uid) ||
  (window._uidForSeat ? window._uidForSeat(seatKey, st && st.name) : '') || '';
async function _writeWeeklyMerit(st, seatKey, weekIso, satIso, adjGoalMin, actualMin, chal){
  const ref = doc(db, 'merits', `auto_wk_${weekIso}_${seatKey}`);
  let prev = {}; try { const s = await getDoc(ref); if (s.exists()) prev = s.data(); } catch(e){}
  const uid = _meritUid(st, seatKey, prev);
  await setDoc(ref, {
    name: st.name, seatKey, date: satIso, day: _WEEKLY_DN[new Date(satIso + 'T00:00:00').getDay()],
    points: (chal && chal.points) || WEEKLY_MERIT_POINTS, type: 'auto',
    reason: `${(chal && chal.label) || '주간 목표순공 달성'} (${(actualMin/60).toFixed(1)}/${(adjGoalMin/60).toFixed(1)}h)`,
    ...(uid ? { uid } : {}),
    canceled: !!prev.canceled, createdAt: new Date().toISOString()
  });
}
async function _writePlannerWeeklyMerit(st, seatKey, weekIso, satIso, sub, att){
  const ref = doc(db, 'merits', `auto_plwk_${weekIso}_${seatKey}`);
  let prev = {}; try { const s = await getDoc(ref); if (s.exists()) prev = s.data(); } catch(e){}
  const uid = _meritUid(st, seatKey, prev);
  await setDoc(ref, {
    name: st.name, seatKey, date: satIso, day: _WEEKLY_DN[new Date(satIso + 'T00:00:00').getDay()],
    points: PLANNER_WEEKLY_POINTS, type: 'auto',
    reason: `플래너 성실 (${sub}/${att}일 제출)`,
    ...(uid ? { uid } : {}),
    canceled: !!prev.canceled, createdAt: new Date().toISOString()
  });
}
const CYCLE1 = { start:'2026-07-20', end:'2026-08-31', id:'2026-C1', label2:'7/20~8/31' };
const CYCLE_ATTEND_MIN_RATE = 0.8;
function _nextCycle(cyc){
  let y, m;
  if (cyc.id === '2026-C1') { y = 2026; m = 9; } // 1주기 다음은 9월
  else { const p = cyc.start.split('-').map(Number); if (p[1] === 12) { y = p[0]+1; m = 1; } else { y = p[0]; m = p[1]+1; } }
  const ym = `${y}-${String(m).padStart(2,'0')}`, last = new Date(y, m, 0).getDate();
  return { start:`${ym}-01`, end:`${ym}-${String(last).padStart(2,'0')}`, id: ym, label2:`${m}월` };
}
function _prevCycleOf(cyc){
  if (cyc.id === '2026-C1') return null;
  if (cyc.start === '2026-09-01') return CYCLE1; // 9월의 직전 주기 = 1주기
  const p = cyc.start.split('-').map(Number); let py = p[0], pm = p[1]-1; if (pm === 0) { py = p[0]-1; pm = 12; }
  const ym = `${py}-${String(pm).padStart(2,'0')}`, last = new Date(py, pm, 0).getDate();
  return { start:`${ym}-01`, end:`${ym}-${String(last).padStart(2,'0')}`, id: ym, label2:`${pm}월` };
}
async function _cycleDoneMap(){
  try { const s = await getDoc(doc(db, 'students', '_meta_cycle_merit_done')); return s.exists() ? (s.data().cycles || {}) : {}; }
  catch(e){ return {}; }
}
async function _markCycleDone(id, info){
  try { await setDoc(doc(db, 'students', '_meta_cycle_merit_done'), { name:'', cycles:{ [id]: info } }, { merge:true }); }
  catch(e){ console.warn('주기 상점 완료표시 실패:', e); }
}
async function _sumStudyMin(startISO, endISO){
  const dates = []; const d = new Date(startISO+'T00:00:00'), end = new Date(endISO+'T00:00:00');
  while (d <= end) { dates.push(SH.sessIsoDate(d.getTime())); d.setDate(d.getDate()+1); }
  const chunks = []; for (let i = 0; i < dates.length; i += 30) chunks.push(dates.slice(i, i+30));
  const snaps = await Promise.all(chunks.map(c => getDocs(query(collection(db, SESS_COL), where('inDate', 'in', c)))));
  const byName = {};
  snaps.forEach(snap => snap.forEach(x => {
    const s = x.data(); if (!s.studentName || typeof s.inTs !== 'number') return;
    let m = 0;
    if (s.status === 'closed' && typeof s.durationMin === 'number') m = s.durationMin;
    else if (s.status === 'open') { let away = s.awayMs || 0; if (s.awayStartTs) away += Math.max(0, Math.min(Date.now(), sessCapTs(s.inTs)) - s.awayStartTs); m = sessDurationMin(s.inTs, Date.now(), away); }
    byName[s.studentName] = (byName[s.studentName] || 0) + m;
  }));
  return byName;
}
async function _noshowCountByName(startISO, endISO){
  const dates = []; const d = new Date(startISO+'T00:00:00'), end = new Date(endISO+'T00:00:00');
  while (d <= end) { dates.push(SH.sessIsoDate(d.getTime())); d.setDate(d.getDate()+1); }
  const chunks = []; for (let i = 0; i < dates.length; i += 30) chunks.push(dates.slice(i, i+30));
  const snaps = await Promise.all(chunks.map(c => getDocs(query(collection(db, 'penalties'), where('date', 'in', c)))));
  const cnt = {};
  snaps.forEach(snap => snap.forEach(x => {
    const dd = x.data(); if (!dd.name) return;
    Object.values(dd.periods || {}).forEach(p => { if (p.type === 'noshow' && !p.canceled) cnt[dd.name] = (cnt[dd.name] || 0) + 1; });
  }));
  return cnt;
}
function _cycleOpDays(cyc){
  let n = 0; const d = new Date(cyc.start+'T00:00:00'), e = new Date(cyc.end+'T00:00:00');
  while (d <= e) { if (d.getDay() !== 0) n++; d.setDate(d.getDate()+1); }
  return n;
}
async function _cycleScheduleLoad(cyc){
  const dates = [], dayNames = [];
  const d = new Date(cyc.start+'T00:00:00'), end = new Date(cyc.end+'T00:00:00');
  while (d <= end) { if (d.getDay() !== 0) { dates.push(SH.sessIsoDate(d.getTime())); dayNames.push(_WEEKLY_DN[d.getDay()]); } d.setDate(d.getDate()+1); }
  const chunks = []; for (let i = 0; i < dates.length; i += 30) chunks.push(dates.slice(i, i+30));
  const [baseSnap, ...rptSnaps] = await Promise.all([
    getDocs(collection(db, 'schedule_base')),
    ...chunks.map(c => getDocs(query(collection(db, 'daily_reports'), where('date', 'in', c))))
  ]);
  const rptMap = {}; // seatKey → { dateIso: scheduleStr }
  rptSnaps.forEach(snap => snap.forEach(x => {
    const r = x.data(); if (typeof r.schedule !== 'string') return;
    const id = x.id, cut = id.lastIndexOf('_');
    const seatKey = id.slice(cut+1), date = id.slice(0, cut);
    (rptMap[seatKey] = rptMap[seatKey] || {})[date] = r.schedule;
  }));
  const out = {};
  baseSnap.forEach(bdoc => {
    const seatKey = bdoc.id, bd = bdoc.data();
    let base = 0, dropped = 0;
    for (let i = 0; i < dates.length; i++){
      const baseStr = bd[dayNames[i]] || '-';
      const bp = window.parseScheduleStr(baseStr);
      if (!bp || !bp.periods || !bp.periods.size) continue;
      const effStr = (rptMap[seatKey] && rptMap[seatKey][dates[i]] !== undefined) ? rptMap[seatKey][dates[i]] : baseStr;
      const ep = window.parseScheduleStr(effStr);
      const effPeriods = (ep && ep.periods) ? ep.periods : new Set();
      bp.periods.forEach(pn => { base++; if (!effPeriods.has(pn)) dropped++; });
    }
    out[seatKey] = { base, dropped };
  });
  return out;
}
const PLANNER_EXCELLENCE_PER = 5;
window.assessPlannerExcellence = async function(){
  try {
    const db = await window.waitDb(); if (!db) return;
    const { collection, doc, getDoc, getDocs, setDoc } = window._fs;
    const snap = await getDocs(collection(db, 'planner_ai_reviews'));
    const cntBySeat = {};
    snap.forEach(x => {
      const v = x.data();
      if (!v || v.status !== 'done' || v.quality !== '우수' || !v.date) return;
      if (v.date < CYCLE1.start || v.date > CYCLE1.end) return; // 주기 내만
      const seatNum = String(v.seat || '').replace(/[^0-9]/g, '');
      if (!seatNum) return;
      if (window.isAdminSeat(seatNum)) return; // 관리자석(54~63번) — 상점 대상 아님
      cntBySeat[seatNum] = (cntBySeat[seatNum] || 0) + 1;
    });
    const todayIso = SH.sessIsoDate(Date.now());
    for (const [seatNum, cnt] of Object.entries(cntBySeat)) {
      const pts = Math.floor(cnt / PLANNER_EXCELLENCE_PER);
      if (pts <= 0) continue; // 아직 5회 미만
      const st = (window.STUDENTS || []).find(s => (s.seat || '').replace(/[^0-9]/g, '') === seatNum);
      const name = st ? st.name : (seatNum + '번');
      if (st && window.isTestStudent && window.isTestStudent(name)) continue;
      const ref = doc(db, 'merits', `auto_plexc_${CYCLE1.id}_${seatNum}`);
      let prev = {}; try { const s = await getDoc(ref); if (s.exists()) prev = s.data(); } catch(e){}
      if (prev.type === 'auto' && prev.points === pts) continue; // 변화 없으면 재기록 생략
      const dISO = prev.date || todayIso;
      const uid = _meritUid(st || { name }, seatNum, prev);
      await setDoc(ref, {
        name, seatKey: seatNum, date: dISO,
        day: _WEEKLY_DN[new Date(dISO + 'T00:00:00').getDay()],
        points: pts, type: 'auto', reason: `플래너 우수 ${cnt}회`,
        ...(uid ? { uid } : {}),
        canceled: !!prev.canceled, createdAt: new Date().toISOString()
      });
    }
    console.log('[플래너우수] 판정 완료 —', Object.keys(cntBySeat).length, '명 집계');
  } catch(e){ console.error('플래너 우수 판정 실패:', e); }
};
window.assessCycleMerits = async function(){
  for (let i = 0; i < 100 && !(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr); i++) await new Promise(r => setTimeout(r, 300));
  if (!(window.STUDENTS && window.STUDENTS.length && window.parseScheduleStr)) return;
  const todayISO = SH.sessIsoDate(Date.now());
  const done = await _cycleDoneMap();
  let cyc = { ...CYCLE1 };
  for (let guard = 0; guard < 24; guard++) {
    if (cyc.end >= todayISO) break; // 아직 안 끝난(현재/미래) 주기 — 판정 안 함
    if (!done[cyc.id]) await _assessCycleMerits(cyc);
    cyc = _nextCycle(cyc);
  }
};
async function _assessCycleMerits(cyc){
  try {
    const studyMin = await _sumStudyMin(cyc.start, cyc.end);
    const noshowCnt = await _noshowCountByName(cyc.start, cyc.end);
    const schedLoad = await _cycleScheduleLoad(cyc);
    const prev = _prevCycleOf(cyc);
    const prevMin = prev ? await _sumStudyMin(prev.start, prev.end) : null;
    // 주기 길이가 다르면(1주기 6주 vs 9월 4주) 총량 비교는 무의미 → 운영일당 평균으로 정규화
    const curDays = _cycleOpDays(cyc), prevDays = prev ? _cycleOpDays(prev) : 0;
    // 현재 명부(실재·비테스트·비관리자)만 대상
    const roster = (window.STUDENTS || []).filter(s => s.name && (parseInt(s.seat)||0) < 54 && !(window.isTestStudent && window.isTestStudent(s.name)));
    // 순공 상위 25% (순공>0 학생 기준). 경계값 동점자는 모두 포함 — 정렬 우연으로 2점이 갈리지 않게.
    const active = roster.map(s => ({ s, min: studyMin[s.name] || 0 })).filter(o => o.min > 0).sort((a, b) => b.min - a.min);
    const topK = Math.ceil(active.length * 0.25);
    const cutoffMin = topK > 0 ? active[topK-1].min : Infinity;
    const topSet = new Set(active.filter(o => o.min >= cutoffMin).map(o => o.s.name));
    const writes = [];
    roster.forEach(s => {
      const seatKey = (s.seat || '').replace(/[^0-9]/g, '');
      const mine = studyMin[s.name] || 0;
      // 개근: 무단결석 0건 AND 실제 이용(순공>0) AND base 예정 교시 이수율 80%↑
      //   이수율 = (base 예정 − 승인변경으로 뺀 것 − 무단결석) / base 예정.
      //   base가 0(고정 시간표 자체가 빈 좌석)이면 판정 대상 아님 — 빈 스케줄로 개근 따먹기 차단.
      const sl = schedLoad[seatKey] || { base: 0, dropped: 0 };
      const attRate = sl.base > 0 ? (sl.base - sl.dropped - (noshowCnt[s.name] || 0)) / sl.base : 0;
      if ((noshowCnt[s.name] || 0) === 0 && mine > 0 && sl.base > 0 && attRate >= CYCLE_ATTEND_MIN_RATE)
        writes.push(_writeCycleMerit(s, seatKey, cyc, 'attend', 3, `${cyc.label2} 개근 (이수율 ${Math.round(attRate*100)}%)`));
      // 순공 우수: 상위25% OR 직전 주기 대비 향상(운영일당 평균 기준)
      const improved = (prevMin && prevDays > 0 && curDays > 0)
        ? ((mine / curDays) > ((prevMin[s.name] || 0) / prevDays)) : false;
      const isTop = topSet.has(s.name);
      if (isTop || improved) {
        const why = (isTop && improved) ? '상위25%·전월대비 향상' : (isTop ? '상위25%' : '전월대비 향상');
        writes.push(_writeCycleMerit(s, seatKey, cyc, 'study', 2, `${cyc.label2} 순공 우수 (${why})`));
      }
    });
    await Promise.all(writes);
    await _markCycleDone(cyc.id, { at: Date.now(), students: writes.length });
    console.log(`[주기상점] ${cyc.id} 판정 완료 — ${writes.length}건`);
  } catch(e){ console.error('주기 상점 판정 실패:', cyc.id, e); } // 완료표시 안 남김 → 다음 시작 때 재시도(멱등)
}
async function _writeCycleMerit(s, seatKey, cyc, kind, points, reason){
  const ref = doc(db, 'merits', `auto_${kind}_${cyc.id}_${seatKey}`);
  let prev = {}; try { const x = await getDoc(ref); if (x.exists()) prev = x.data(); } catch(e){}
  const uid = _meritUid(s, seatKey, prev);
  await setDoc(ref, {
    name: s.name, seatKey, date: cyc.end, day: _WEEKLY_DN[new Date(cyc.end + 'T00:00:00').getDay()],
    points, type: 'auto', reason, ...(uid ? { uid } : {}),
    canceled: !!prev.canceled, createdAt: new Date().toISOString()
  });
}

// ════ 모듈 — 자동 퇴원·보관함 정리 ════
const WITHDRAWN_KEEP_DAYS = 90;
async function _getDocData(col, id) {
  try { const s = await getDoc(doc(db, col, id)); return s.exists() ? s.data() : null; } catch(e) { return null; }
}
async function archiveAndRemoveStudent(seat, name, sid) {
  let stu = await _getDocData('students', seat);
  if (!stu && sid && sid !== seat) stu = await _getDocData('students', sid);
  const base = await _getDocData('schedule_base', seat);
  const cur  = await _getDocData('schedules', seat);
  if (!stu && !base) throw new Error('보관할 학생 데이터를 찾을 수 없습니다');
  const archiveId = `${seat}_${Date.now()}`; // 좌석 재사용 대비 타임스탬프 포함
  await setDoc(doc(db, 'withdrawn_students', archiveId), {
    seat, name,
    withdrawnAt: serverTimestamp(),
    student: stu || null, base: base || null, current: cur || null
  });
  await deleteDoc(doc(db, 'students', seat));
  try { await deleteDoc(doc(db, 'schedules', seat)); } catch(e) {}
  try { await deleteDoc(doc(db, 'schedule_base', seat)); } catch(e) {}
  if (sid && sid !== seat) { try { await deleteDoc(doc(db, 'students', sid)); } catch(e) {} }
  return archiveId;
}
async function autoWithdrawExpired() {
  try {
    const todayStr = sessIsoDate(Date.now()); // 'YYYY-MM-DD'
    const snap = await getDocs(collection(db, 'students'));
    if (snap.metadata && snap.metadata.fromCache) return; // 오프라인 캐시면 보류(오판 방지)
    for (const d of snap.docs) {
      const v = d.data();
      const w = v.withdrawAt;
      if (!w || typeof w !== 'string') continue;
      if (todayStr <= w) continue;              // 아직 그날 전 — 오늘 > withdrawAt 이어야 퇴원
      const name = v.name;
      if (!name || String(d.id).startsWith('_meta')) continue;
      if (Array.isArray(PRESENT) && PRESENT.includes(name)) {
        console.log(`[자동퇴원] ${name}(${d.id}번) 입실 중 — 이번엔 건너뜀`);
        continue;
      }
      const next = v.nextStudent && v.nextStudent.name ? v.nextStudent : null;
      await archiveAndRemoveStudent(d.id, name, v.sid);
      const si = STUDENTS.findIndex(s => String(s.seat).replace('번','').trim() === String(d.id));
      if (si !== -1) STUDENTS.splice(si, 1);
      console.log(`[자동퇴원] ${name}(${d.id}번) withdrawAt=${w} 경과 → 보관함 이동`);
      if (window.showAdminToast) showAdminToast(`📦 ${name}(${d.id}번) 예약 퇴원 처리됨 — 보관함에서 복구 가능`);

      // 신규생이 이 자리를 미리 예약해 뒀으면(학생앱 자가등록) 실제 좌석으로 승계한다.
      if (next) {
        const { nextStudent: _drop, ...clean } = next; // 예약 안에 예약이 중첩되는 것 방지
        // 예약으로 들어온 신규생은 uid가 없다 — 여기서 발급해야 이후 기록이 이 학생에게 묶인다.
        if (!clean.uid) clean.uid = window._newStudentUid();
        await setDoc(doc(db, 'students', d.id), { ...clean, seat: String(d.id), updatedAt: serverTimestamp() });
        // students onSnapshot이 added를 무시하므로 로컬 배열에 직접 넣어야 화면에 뜬다.
        if (!STUDENTS.some(s => s.name === clean.name)) {
          STUDENTS.push({
            uid: clean.uid || '',   // 바로 위에서 발급한 uid를 메모리에도 반영
            seat: String(d.id) + '번', name: clean.name, phone: clean.phone || '', parent: clean.parent || '',
            gender: clean.gender || 'f', expiry: clean.expiry || '', startDate: clean.startDate || '',
            loginPin: clean.loginPin || '',
            schedule: { 월:'-', 화:'-', 수:'-', 목:'-', 금:'-', 토:'-' },
            hours: {}, fee: 0, feeMemo: '',
          });
        }
        console.log(`[자동퇴원] ${d.id}번 예약 승계 → ${clean.name} 배정 완료`);
        if (window.showAdminToast) showAdminToast(`🪑 ${d.id}번 → ${clean.name} 자동 배정됨 (신규 예약)`);
      }
    }
    try { if (typeof buildDashboard === 'function') buildDashboard(); } catch(e) {}
    try { if (document.getElementById('fp-room')) buildFloorplan(); } catch(e) {}
    try { if (typeof buildHoursTable === 'function') buildHoursTable(); } catch(e) {}
  } catch(e) { console.error('예약 자동퇴원 오류:', e); }
}
window.autoWithdrawExpired = autoWithdrawExpired;
async function cleanupWithdrawnStudents() {
  try {
    const today = new Date().toDateString();
    if (localStorage.getItem('saebom_withdrawn_cleanup') === today) return;
    const cutoff = Date.now() - WITHDRAWN_KEEP_DAYS * 86400000;
    const snap = await getDocs(collection(db, 'withdrawn_students'));
    for (const d of snap.docs) {
      const w = d.data().withdrawnAt;
      const t = w?.toDate ? w.toDate().getTime() : null;
      if (t && t < cutoff) {
        try { await deleteDoc(doc(db, 'withdrawn_students', d.id)); console.log('[퇴원보관함] 90일 경과 정리:', d.id); } catch(e) {}
      }
    }
    localStorage.setItem('saebom_withdrawn_cleanup', today);
  } catch(e) { console.warn('[퇴원보관함] 자동정리 실패:', e); }
}

// ════ 명부 불러오기 (loadStudentsFromFirebase 의 학생 객체 그대로) ════
async function __loadStudents() {
  const snap = await getDocs(collection(db, 'students'));
  STUDENTS.length = 0;
  snap.forEach(d => {
    const v = d.data();
    if (!v.name) return;
    STUDENTS.push({
          // 불변 학생ID(이관 1단계). 좌석·이름과 달리 절대 바뀌지 않으므로 조회의 기준이 된다.
          // ★여기서 안 읽으면 메모리 객체에 uid가 없고, 저장 시 문서에서 uid가 사라진다.
          uid: v.uid || '',
          seat: String(v.seat).replace('번',''), name: v.name,
          phone: v.phone || '', parent: v.parent || '',
          gender: v.gender || 'f', expiry: v.expiry || '', startDate: v.startDate || '',
          joinedAt: v.joinedAt || '',   // 이번 등록일(이용조사 대상 판정) — 안 읽으면 저장 때 사라진다
          schedule: { 월:v['월']||'-', 화:v['화']||'-', 수:v['수']||'-', 목:v['목']||'-', 금:v['금']||'-', 토:v['토']||'-' },
          hours: _normalizeHours(v.hours), fee: v.fee||0, feeMemo: v.feeMemo||'',
          weeklyGoalH: Number(v.weeklyGoalH) || 0, // 주간 목표순공(시간) — 관리자가 설정한 값, 자동판정 기준
          weeklyGoalReq: (typeof v.weeklyGoalReq === 'number' ? v.weeklyGoalReq : null), // 과거 승인제 잔여값(신규 발생 없음)
          awayAt: v.awayAt || '',
          // 저장(setDoc)이 문서를 통째로 덮어쓰므로, 앱이 직접 쓰지 않는 필드도 들고 있어야
          // 관리자 편집 시 유실되지 않는다. loginPin=지정 로그인번호, withdrawAt=예약 퇴원일,
          // nextStudent=그 자리를 예약한 신규생.
          loginPin: v.loginPin || '', withdrawAt: v.withdrawAt || '',
          nextStudent: v.nextStudent || null,
          grade: v.grade || '',   // 학년 — 학습분석의 또래 교재 추천 기준
          school: v.school || '', // 학교 — 상세 모달에서 입력·표시
          // 식사 외출 알림 수신 희망 — 학부모앱에서 학부모가 직접 고른다.
          // null = 아직 응답 안 함(= 발송 안 함). true/false 만 응답으로 본다.
          mealAwaySms: (typeof v.mealAwaySms === 'boolean' ? v.mealAwaySms : null),
          // 태블릿 보관 관리 동의(학부모앱) — true인 학생만 태블릿 보관함 카드에 표시
          tabletConsent: (typeof v.tabletConsent === 'boolean' ? v.tabletConsent : null),
          // 플래너 학부모 비공개(학생앱에서 학생 본인이 켠다) — ★여기서 안 읽으면 관리자가
          // 학생 정보를 한 번 저장하는 순간 설정이 지워져 학생 몰래 학부모에게 다시 공개된다.
          plannerHidden: v.plannerHidden === true,
          plannerHiddenAt: v.plannerHiddenAt || ''
        });
  });
  STUDENTS.sort((a,b) => parseInt(a.seat) - parseInt(b.seat));
}
