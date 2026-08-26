'use strict';
/*
 * 새봄면학관 — LG ThinQ 에어컨 자동/수동 제어 (입퇴실 연동).
 *
 * 실행 위치: 공용 Firebase 프로젝트 `saebom-studyhall` (면학관 Firestore가 있는 곳).
 *   ※ 수학관리앱(saebom-student-app)의 MathFlat 함수와 같은 프로젝트지만
 *     별도 codebase("studyhall")로 배포되어 서로 영향을 주지 않는다.
 *
 * 설계 핵심 — 단속운전(잦은 On/Off) 방지:
 *   · 켤 때: 재실 발생 즉시 ON
 *   · 끌 때: 재실 0이 offGraceMin 분 동안 "계속" 유지될 때만 OFF (잠깐 출입은 안 끔)
 *   · 한 번 켜지면 minOnMin 분은 유지(최소 운전시간)
 *   · 운영시간(opStart~opEnd) 밖에는 항상 OFF (평일=저녁 opStart, 주말=weekendOpStart 오전 시작)
 *   · hallAlwaysOn=true(방학 시간표)면 운영시간 동안 열람실은 무인이어도 냉방 유지 — 위 '끌 때' 유예를 건너뜀
 *   · 정식 시작 전 조기 가동 창(평일 weekdayPreOpenStart~opStart / 주말 weekendPreOpenStart~weekendOpStart)에 입실 구역만 먼저 냉방(열람실은 비어도 정식 운영과 같은 offGrace 2단 유예)
 *   · 정식 종료(opEnd) 후 lateHardOff 까지: 남은 학생 있으면 열람실 '1대만'(재실 최다·동수면 에어컨2) → lateHardOff에 전체 OFF
 *   · 끄기 직전 dryOffMin 분 송풍 건조 후 전원 차단(코일 곰팡이·냄새 방지) — 자동/수동 OFF 공통
 * 제어 단위(zone): 열람실(hall)=전체 재실 기준 / 스터디룸(studyroom)=해당 방 배정+재실 기준
 *
 * 인증 없는 면학관앱(정적 PWA)과는 Firestore 문서로 연동:
 *   · ac_config/main  — 설정(zones 매핑·운영시간·유예시간 등)  [대시보드 read/write]
 *   · ac_state/main   — 현재 상태(대시보드 표시용) + 자동화 내부상태  [서버 write, 대시보드 read]
 *   · ac_commands/*   — 대시보드에서 쓰는 수동 명령(트리거가 실행)  [대시보드 create]
 *
 * PAT(개인 액세스 토큰)는 Secret(LG_THINQ_PAT)으로만 사용 → 클라이언트에 절대 노출되지 않음.
 *   설정: `firebase functions:secrets:set LG_THINQ_PAT`
 */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { randomUUID } = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const LG_PAT = defineSecret('LG_THINQ_PAT');
const LG_API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';   // ThinQ Connect 공개 상수(비밀 아님)

// ---------- LG ThinQ Connect REST ----------
function lgBase(region) { return `https://api-${region || 'kic'}.lgthinq.com`; }   // 한국=kic, 미국=aic, 유럽=eic
function lgMsgId() { return Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url'); }

// client-id 는 계정당 고정값이어야 안전 → 서버 전용 문서(ac_state/main.clientId)에 1회 생성·재사용.
async function lgClientId() {
  const ref = db.collection('ac_state').doc('main');
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  if (cur.clientId) return cur.clientId;
  const id = randomUUID();
  await ref.set({ clientId: id }, { merge: true });
  return id;
}

function lgHeaders(pat, country, clientId, control) {
  const h = {
    'Authorization': 'Bearer ' + pat,
    'x-api-key': LG_API_KEY,
    'x-country': country || 'KR',
    'x-message-id': lgMsgId(),
    'x-client-id': clientId,
    'x-service-phase': 'OP',
    'content-type': 'application/json',
  };
  if (control) h['x-conditional-control'] = 'true';   // 제어(POST /control) 시 필수
  return h;
}

async function lgFetch(pathname, ctx, opt = {}) {
  const res = await fetch(lgBase(ctx.region) + pathname, {
    method: opt.method || 'GET',
    headers: lgHeaders(ctx.pat, ctx.country, ctx.clientId, opt.control),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  let d = null; try { d = JSON.parse(raw); } catch { d = raw; }
  if (!res.ok) {
    const msg = (d && (d.message || (d.error && d.error.message))) || String(raw).slice(0, 200);
    throw new Error(`LG ThinQ ${res.status}: ${msg}`);
  }
  return (d && d.response !== undefined) ? d.response : d;
}

// 의미명령(power/temp/mode/fan) → ThinQ AC 제어 페이로드.
function acPayload(command, value) {
  switch (command) {
    case 'power': return { operation: { airConOperationMode: value ? 'POWER_ON' : 'POWER_OFF' } };
    case 'temp':  return { temperature: { targetTemperature: Number(value) } };
    case 'mode':  return { airConJobMode: { currentJobMode: String(value) } };
    case 'fan':   return { airFlow: { windStrength: String(value) } };
    default:      return null;
  }
}

// ---------- 설정/시간 헬퍼 ----------
async function acConfig() {
  const snap = await db.collection('ac_config').doc('main').get();
  const c = snap.exists ? snap.data() : {};
  return {
    auto: c.auto !== false,                      // 기본 자동 ON
    country: c.country || 'KR', region: c.region || 'kic',
    opStart: c.opStart || '06:00', opEnd: c.opEnd || '24:00',
    // 주말(토·일) 전용: 오전부터 운영. weekendOpStart=정식 시작, weekendPreOpenStart=조기 가동(입실 구역만) 시작.
    weekendOpStart: c.weekendOpStart || '08:30',
    weekendPreOpenStart: c.weekendPreOpenStart || '08:00',
    // 평일 조기 가동 시작(~opStart). 이 창에는 입실 좌석이 있는 구역만 켠다(빈 구역은 대기). ''이면 평일 조기 가동 없음.
    weekdayPreOpenStart: c.weekdayPreOpenStart != null ? c.weekdayPreOpenStart : '08:00',
    offGraceMin: c.offGraceMin != null ? c.offGraceMin : 20,   // 무인 지속 → 절전(setback) 전환 유예
    hardOffMin: c.hardOffMin != null ? c.hardOffMin : 60,      // 무인 지속 → 완전 OFF (2단 공실 2단계)
    minOnMin: c.minOnMin != null ? c.minOnMin : 20,            // 최소 운전시간(완전 OFF 억제)
    manualHoldMin: c.manualHoldMin != null ? c.manualHoldMin : 60, // 수동조작 후 자동보류(분)
    onTemp: c.onTemp != null ? c.onTemp : 24,
    // 방학 상시 가동 — 운영시간(opStart~opEnd) 동안 열람실은 무인이어도 끄지 않고 onTemp 냉방 유지.
    //   학기 중(저녁만 운영)으로 돌아가면 false로 되돌릴 것. 스터디룸·마감 tail·조기 가동 창은 영향 없음.
    hallAlwaysOn: c.hallAlwaysOn === true,
    setbackTemp: c.setbackTemp != null ? c.setbackTemp : 28,   // 절전(무인/마감여열) 시 목표온도 — 압축기 idle
    preCloseMin: c.preCloseMin != null ? c.preCloseMin : 20,   // 마감 전 여열 coast 시작(냉방 중단)
    // 정식 종료(opEnd) 후 ~ lateHardOff 까지: 남은 학생이 있으면 열람실 에어컨 '1대만' 유지(재실 최다·동수면 에어컨2).
    //   lateHardOff 시각엔 무조건 전체 OFF — 깜빡 미퇴실 시 밤샘 가동 방지.
    lateHardOff: c.lateHardOff || '01:00',
    onMode: c.onMode || 'COOL', onFan: c.onFan || 'AUTO',
    // 끄기 전 송풍 건조 — 냉방으로 젖은 코일을 말려 곰팡이·냄새 방지(LG 자동건조와 같은 원리).
    //   ※ 기기 프로필에 AIR_CLEAN(자동건조)이 없어 FAN으로 직접 구현. AIR_DRY는 '제습'이라 코일이 오히려 젖는다.
    //   ※ 풍량은 건드리지 않는다 — 열람실은 자동화가 풍량을 관리하지 않아, 여기서 바꾸면 그 값이 그대로 굳는다.
    dryOffMin: c.dryOffMin != null ? c.dryOffMin : 15,   // 0이면 건조 없이 즉시 OFF
    // 스터디룸 예측 제어(예약 교시 기반)
    bridgeTemp: c.bridgeTemp != null ? c.bridgeTemp : 30,      // 빈 교시(뒤에 예약 있음) 브리지 온도 — 압축기 거의 정지+재냉방 상한
    srPreCoolMin: c.srPreCoolMin != null ? c.srPreCoolMin : 15,// 다음 예약 시작 N분 전부터 미리 냉방
    srBridgeMaxGap: c.srBridgeMaxGap != null ? c.srBridgeMaxGap : 45, // 다음 예약이 이보다 멀면 브리지 대신 OFF
    srTemp: c.srTemp || { '1': 26, '2': 25, '3': 24 },         // 인원수별 냉방온도(과용량 소형실 기준)
    srFan: c.srFan || { '1': 'LOW', '2': 'LOW', '3': 'MID' },  // 인원수별 풍량
    noShowGraceMin: c.noShowGraceMin != null ? c.noShowGraceMin : 15, // 교시 시작 후 이 시간까진 예약수 유지(도착 지연 배려), 이후 실입실자 수
    // 스터디룸 자동제어 스위치. false면 스터디룸 에어컨은 자동화가 일절 손대지 않고 수동 제어만 따른다
    //   (예약 기반 냉방·예냉·브리지·자동 OFF·마감 전체 OFF 모두 해제. 진행 중이던 건조만 마무리).
    srAuto: c.srAuto !== false,
    zones: c.zones || {},   // deviceId -> { name, type:'hall'|'studyroom', room? }
  };
}
function _hhmm(s) { const p = String(s).split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); }
// 요일별 정식 시작 시각 — 주말(토·일)은 오전, 평일은 저녁(기존 opStart 그대로).
//   date는 KST 시프트된 값이라 getDay()도 KST 요일(0=일 … 6=토).
function _isWeekend(date) { const d = date.getDay(); return d === 0 || d === 6; }
function _effStart(cfg, date) { return _isWeekend(date) ? cfg.weekendOpStart : cfg.opStart; }
// 조기 가동 창: 정식 시작 전(평일 weekdayPreOpenStart~opStart / 주말 weekendPreOpenStart~weekendOpStart) — 입실 구역만 켠다.
//   시작값이 비어 있으면 그 요일은 조기 가동 없음.
function _preOpenWindow(cfg, date) {
  const preStart = _isWeekend(date) ? cfg.weekendPreOpenStart : cfg.weekdayPreOpenStart;
  if (!preStart) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return now >= _hhmm(preStart) && now < _hhmm(_effStart(cfg, date));
}
function _withinOp(cfg, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = _hhmm(_effStart(cfg, date));
  let end = _hhmm(cfg.opEnd); if (end === 0) end = 24 * 60;   // '24:00'
  return start <= end ? (now >= start && now < end) : (now >= start || now < end);
}
// [start,end) 시각 범위 판정(자정 넘김 지원).
function _inWrapRange(startMin, endMin, nowMin) {
  return startMin <= endMin ? (nowMin >= startMin && nowMin < endMin) : (nowMin >= startMin || nowMin < endMin);
}
// 마감 단일가동 tail: 정식 종료(opEnd) ~ lateHardOff 구간이면 true. 이 구간엔 열람실 에어컨 1대만.
function _inLateTail(cfg, date) {
  const s = _hhmm(cfg.opEnd) || 24 * 60;
  const e = _hhmm(cfg.lateHardOff) || 24 * 60;
  return _inWrapRange(s, e, date.getHours() * 60 + date.getMinutes());
}
// 운영일(오늘 KST 03:00 시작) 기준 경과 분 — 자정을 넘겨도 단조 증가한다(03:00→0, 23:40→1240, 01:00→1320).
//   마감 시각을 '자정 이전(23:40)'으로도 '자정 이후(01:00)'로도 설정할 수 있어야 해서 필요하다.
function _opMinOf(hhmm) { const v = _hhmm(hhmm); return v >= 180 ? v - 180 : v + 1260; }
function _opMinNow(date) { const v = date.getHours() * 60 + date.getMinutes(); return v >= 180 ? v - 180 : v + 1260; }
// 마감 강제 OFF 시각(lateHardOff)을 지났는가 — 그 운영일에 한 번만 쓰인다(아래 hardOffDay 래치).
function _pastHardOff(cfg, date) { return _opMinNow(date) >= _opMinOf(cfg.lateHardOff); }
// 실제 완전 종료(lateHardOff)까지 남은 분 — 여열 coast 판정용. 운영 시작~lateHardOff를 연속으로 봄.
function _minsToHardOff(cfg, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = _hhmm(_effStart(cfg, date));
  let end = _hhmm(cfg.lateHardOff); if (end === 0) end = 24 * 60;
  if (start <= end) return (now >= start && now < end) ? end - now : null;
  if (now >= start) return (24 * 60 - now) + end;
  if (now < end) return end - now;
  return null;
}
function _kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }   // 함수 런타임 UTC → KST
// 앱들과 동일: (KST-3h)의 날짜를 zero-padded YYYY-MM-DD 로. (studyroom_requests.date 형식)
function _srDayKey(date) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 현재 운영일이 시작된 시각(=오늘 KST 03:00)의 epoch ms. 앱 전반의 세션 경계와 동일 기준이라
// 새벽 3시 이전은 전날 밤의 연장으로 본다(11교시·마감 tail이 그대로 이어짐).
function _opDayStartMs(nowMs) {
  const s = new Date((nowMs != null ? nowMs : Date.now()) + 6 * 3600 * 1000);   // KST(+9) - 경계(3h)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - 6 * 3600 * 1000;
}

// ---------- 재실/사용 판정 ----------
function _seatNum(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return Number.isNaN(n) ? null : n; }

// 현재 재실 — 이번 운영일(오늘 KST 03:00~)의 checkin_logs를 학생별 마지막 이벤트로 판정(마지막이 'in').
//   ※ 예전엔 '최근 18시간'이라, 밤에 퇴실 체크를 잊은 학생이 다음날 아침까지 재실로 남아
//     빈 열람실이 조기 가동 창(07:00~)에 켜졌다. 새벽 리셋(03:00) 이전 기록은 이제 무시한다.
//     01:00 전체 OFF·01:30~06:00 입실 차단이라 경계를 넘어 실제로 앉아 있는 학생은 없다.
//   names: 재실 학생 이름 집합(스터디룸 배정 대조용)
//   seats: 재실 학생 좌석번호 집합(열람실 좌석범위 판정용)
async function acPresence() {
  const since = _opDayStartMs();
  const snap = await db.collection('checkin_logs').where('ts', '>=', since).get();
  const last = new Map();
  snap.forEach(d => {
    const x = d.data();
    if (x.away === true || !x.studentName || typeof x.ts !== 'number') return;
    const cur = last.get(x.studentName);
    if (!cur || x.ts > cur.ts) last.set(x.studentName, { type: x.type, ts: x.ts, seat: x.seat });
  });
  const names = new Set(), seats = new Set(), missing = [];
  last.forEach((v, name) => {
    if (v.type !== 'in') return;
    names.add(name);
    const s = _seatNum(v.seat);
    if (s != null) seats.add(s); else missing.push(name);   // 로그에 좌석 없으면 아래서 보완
  });
  if (missing.length) {   // 좌석 누락 재실자만 students에서 이름으로 보완
    try {
      const byName = new Map();
      (await db.collection('students').get()).forEach(d => {
        const x = d.data() || {}; if (x.name) byName.set(x.name, _seatNum(x.seat != null ? x.seat : d.id));
      });
      for (const name of missing) { const s = byName.get(name); if (s != null) seats.add(s); }
    } catch (e) { logger.warn('acPresence 좌석 보완 실패', { message: e.message }); }
  }
  return { names, seats };
}

// 열람실(hall) 좌석 범위 — 배치도 기준(사용자 지정): 에어컨1=26~45번, 에어컨2=1~25번.
//   config zone에 seatFrom/seatTo가 있으면 그 값을 우선(이름 변경에도 안전).
const HALL_SEAT_RANGES = { '에어컨1': [26, 45], '에어컨2': [1, 25] };
function _hallSeatRange(z) {
  if (z.seatFrom != null && z.seatTo != null) return [Number(z.seatFrom), Number(z.seatTo)];
  return HALL_SEAT_RANGES[String(z.name || '').replace(/\s/g, '')] || null;
}
// 열람실 재실 인원수: 범위 지정 시 그 범위 안 좌석 수, 없으면 전체 재실 수(하위호환).
function _hallCount(z, presentSeats, totalPresent) {
  const r = _hallSeatRange(z);
  if (!r) return totalPresent;
  const lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]); let c = 0;
  for (const s of presentSeats) { if (s >= lo && s <= hi) c++; }
  return c;
}
// 마감 단일가동 동수 시 우선 켤 구역 = '에어컨2'(좌석 1~25). 이름 우선, 없으면 좌석범위 시작이 낮은 쪽.
function _isLatePreferred(z) {
  if (String(z.name || '').replace(/\s/g, '') === '에어컨2') return true;
  const r = _hallSeatRange(z);
  return !!(r && Math.min(r[0], r[1]) <= 1);
}
// 교시 시각(분, 자정 기준) — 앱 PERIODS와 동일. 평일 예약은 7~10교시(저녁)만 사용.
//   11교시(24:00~25:00)는 현재 운영시간(~24:00) 밖이라 사실상 미사용.
const PERIOD_TIMES = {
  1: [540, 600], 2: [610, 670], 3: [680, 750], 4: [810, 870], 5: [880, 940], 6: [950, 1020],
  7: [1080, 1130], 8: [1140, 1220], 9: [1230, 1320], 10: [1350, 1430], 11: [1440, 1500],
};
// 스터디룸 예약 스케줄 — 방별 { periodCounts:{교시:인원}, periodNames:{교시:[이름]}, booked:[교시...] } (오늘 approved).
async function acStudyroomSchedule(kstDate) {
  const key = _srDayKey(kstDate);
  const snap = await db.collection('studyroom_requests')
    .where('date', '==', key).where('status', '==', 'approved').get();
  const byRoom = {};
  snap.forEach(d => {
    const x = d.data(); const room = String(x.room || '').trim();
    const p = parseInt(x.period, 10);
    if (!room || Number.isNaN(p)) return;
    const r = (byRoom[room] = byRoom[room] || { seen: {}, periodCounts: {}, periodNames: {} });
    const set = (r.seen[p] = r.seen[p] || new Set());
    if (!set.has(x.name)) { set.add(x.name); r.periodCounts[p] = (r.periodCounts[p] || 0) + 1; (r.periodNames[p] = r.periodNames[p] || []).push(x.name); }   // 이름 중복 제거
  });
  const out = {};
  Object.keys(byRoom).forEach(room => {
    out[room] = { periodCounts: byRoom[room].periodCounts, periodNames: byRoom[room].periodNames, booked: Object.keys(byRoom[room].periodCounts).map(Number).sort((a, b) => a - b) };
  });
  return out;
}
function _srTemp(n, cfg) { const k = String(Math.min(Math.max(n, 1), 3)); return cfg.srTemp[k] != null ? cfg.srTemp[k] : cfg.onTemp; }
function _srFan(n, cfg) { const k = String(Math.min(Math.max(n, 1), 3)); return cfg.srFan[k] || 'LOW'; }
// 스터디룸 예측 프로파일: 예약 교시 기반 냉방/브리지/OFF. no-show 판정 = 예약자 중 실제 입실(present)자 수.
//   교시 시작 후 noShowGraceMin 이내엔 예약 인원 유지(도착 지연), 이후엔 실입실자 수(0이면 빈 것으로 처리).
function _srProfile(room, sched, nowMin, cfg, present) {
  const rs = sched[String(room)] || { periodCounts: {}, periodNames: {}, booked: [] };
  for (const p of rs.booked) {   // 현재 진행 중인 예약 교시?
    const t = PERIOD_TIMES[p];
    if (!t || nowMin < t[0] || nowMin >= t[1]) continue;
    const names = rs.periodNames[p] || [];
    const elapsed = nowMin - t[0];
    const n = elapsed < cfg.noShowGraceMin ? names.length : names.filter(x => present.has(x)).length;
    if (n > 0) return { count: n, profile: { power: true, mode: cfg.onMode, temp: _srTemp(n, cfg), fan: _srFan(n, cfg) } };
    break;   // no-show(입실 0) → 빈 것으로 간주, 아래 브리지/OFF 판정
  }
  let nextStart = Infinity, nextP = null;   // 앞으로 남은 가장 이른 예약 교시
  for (const p of rs.booked) { const t = PERIOD_TIMES[p]; if (t && t[0] > nowMin && t[0] < nextStart) { nextStart = t[0]; nextP = p; } }
  if (nextP == null) return { count: 0, profile: { power: false } };   // 오늘 남은 예약 없음 → OFF
  const lead = nextStart - nowMin;
  if (lead <= cfg.srPreCoolMin) {           // 곧 시작 → 예약 인원 기준으로 미리 냉방(도착 전이라 예약수 사용)
    const n = (rs.periodNames[nextP] || []).length || 1;
    return { count: 0, profile: { power: true, mode: cfg.onMode, temp: _srTemp(n, cfg), fan: _srFan(n, cfg) } };
  }
  if (lead <= cfg.srBridgeMaxGap) return { count: 0, profile: { power: true, mode: cfg.onMode, temp: cfg.bridgeTemp } };   // 짧은 공백 → 30 브리지
  return { count: 0, profile: { power: false } };   // 다음 예약까지 멀다 → OFF
}

// 실제 LG 제어 (Secret 직접 사용)
async function acExecute(cfg, deviceId, payload) {
  const pat = LG_PAT.value();
  if (!pat) throw new Error('LG_THINQ_PAT Secret 미설정');
  const clientId = await lgClientId();
  return lgFetch(`/devices/${deviceId}/control`,
    { pat, country: cfg.country, region: cfg.region, clientId },
    { method: 'POST', body: payload, control: true });
}
// 전원 전환 — LG는 이미 그 전원상태면 "Command not supported in POWER ON/OFF" 400을 내므로 '이미 그 상태=성공'으로 처리.
async function acSetPower(cfg, deviceId, on) {
  try {
    await acExecute(cfg, deviceId, { operation: { airConOperationMode: on ? 'POWER_ON' : 'POWER_OFF' } });
  } catch (e) {
    if (/not supported in POWER/i.test(e.message || '')) return;   // 이미 원하는 전원상태 (중복 명령)
    throw e;
  }
}

// ---------- 자동화 핵심 ----------
// 무인 지속 시 열람실 2단 절전 프로파일 — 유예 중 냉방 유지 → offGraceMin 후 setback → hardOffMin 후 OFF(최소 운전시간 충족 시).
//   ※ zs.emptySince를 없으면 채워 넣는다(무인 시작 시각 기록). forceSetback=true면 유예 중이라도 바로 setback(마감 여열 coast).
function _emptyProfile(cfg, zs, nowMs, forceSetback) {
  if (!zs.emptySince) zs.emptySince = nowMs;
  const emptyMin = (nowMs - zs.emptySince) / 60000;
  const onMin = zs.lastOnTs ? (nowMs - zs.lastOnTs) / 60000 : 1e9;
  if (emptyMin >= cfg.hardOffMin && onMin >= cfg.minOnMin) return { power: false };
  if (emptyMin >= cfg.offGraceMin || forceSetback) return { power: true, mode: cfg.onMode, temp: cfg.setbackTemp };
  return { power: true, mode: cfg.onMode, temp: cfg.onTemp };
}

async function acEvaluate(reason) {
  const cfg = await acConfig();
  const zoneIds = Object.keys(cfg.zones || {});
  if (!zoneIds.length) return;   // 아직 에어컨↔공간 매핑 전이면 아무것도 안 함
  const now = _kstNow();
  const nowMs = Date.now();
  const { names: present, seats: presentSeats } = await acPresence();
  const totalPresent = present.size;
  const srSched = await acStudyroomSchedule(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const op = _withinOp(cfg, now);
  const preOpen = _preOpenWindow(cfg, now);   // 정식 시작 전 조기 가동 창(입실 구역만)
  const lateTail = _inLateTail(cfg, now);     // 정식 종료(opEnd)~lateHardOff: 열람실 1대만 유지
  const minsToHardOff = _minsToHardOff(cfg, now);
  const preClose = minsToHardOff != null && minsToHardOff <= cfg.preCloseMin;   // 완전 종료(lateHardOff) 직전 여열 coast

  // 마감 단일가동: 열람실 구역 중 재실 최다 1곳만 켠다(동수/재실만 있으면 에어컨2 우선). tail 구간에서만 계산.
  let lateWinnerId = null;
  if (lateTail) {
    let best = null;
    for (const id of zoneIds) {
      const z = cfg.zones[id] || {};
      if (z.type === 'studyroom') continue;
      const c = _hallCount(z, presentSeats, totalPresent);
      if (c <= 0) continue;
      const pref = _isLatePreferred(z);
      if (!best || c > best.c || (c === best.c && pref && !best.pref)) best = { id, c, pref };
    }
    lateWinnerId = best ? best.id : null;
  }

  const ref = db.collection('ac_state').doc('main');
  const stSnap = await ref.get();
  const zoneState = (stSnap.exists && stSnap.data().zones) || {};
  const out = {};
  // 제어 성공분을 대시보드용 LG 스냅샷(devices[].state)에도 겹쳐 쓴다 — 틱이 refresh→evaluate
  //   순서라 여기서 바꾼 전원·모드는 다음 refresh(최대 5분)까지 옛 스냅샷으로 남는다.
  //   마감 직후 대시보드가 '가동중·송풍'으로 굳어 보이던 원인. 온도·풍량은 기기마다
  //   응답 형태가 달라(배열/객체, windStrengthDetail) 건드리지 않고 refresh에 맡긴다.
  const devPatch = {};
  const _devMark = (id, p) => { devPatch[id] = Object.assign(devPatch[id] || {}, p); };
  // 마감 강제 OFF — lateHardOff 를 지나면 그 운영일에 '한 번' 모든 구역을 끈다.
  //   수동 보류(manualUntil)와 srAuto:false 를 무시한다 — 스터디룸을 켜 두고 퇴근하거나 마감 직전에
  //   대시보드를 만졌을 때 밤새 도는 것을 막는 최후 방어선이다.
  //   ★ '한 번'인 이유: 계속 강제하면 마감 후 조교가 일부러 켠 것까지 5분 뒤 꺼 버린다.
  //     반대로 함수가 그 시각에 죽어 있었어도, 살아난 첫 틱에서 래치가 안 찍혀 있으므로 그때 실행된다.
  const dayKey = _srDayKey(now);
  const hardOffAll = (stSnap.exists && stSnap.data().hardOffDay) !== dayKey && _pastHardOff(cfg, now);

  for (const deviceId of zoneIds) {
    const z = cfg.zones[deviceId] || {};
    const zs = Object.assign({}, zoneState[deviceId]);
    const isSr = z.type === 'studyroom';
    // 스터디룸: 예약 교시 기반 예측 프로파일을 미리 계산(인원수·on/off 판단 포함)
    const srProf = isSr ? _srProfile(z.room, srSched, nowMin, cfg, present) : null;
    const count = isSr ? srProf.count : _hallCount(z, presentSeats, totalPresent);
    const occupied = count > 0;
    zs.occupied = occupied;
    zs.count = count;   // 대시보드 참고용(현재 zone 인원수)

    // 자동 꺼짐 or 수동 보류 중이면 자동 전환은 건너뛰고 상태만 기록.
    //   단, 예약된 건조(dryUntil)는 보류 중이어도 반드시 마무리한다 — 아니면 송풍이 계속 돈다.
    //   srAuto:false면 스터디룸도 같은 경로 — 예약 인원(count)은 대시보드용으로 계속 기록하되 제어는 안 한다.
    const held = zs.manualUntil && zs.manualUntil > nowMs;
    const srOff = isSr && !cfg.srAuto;
    if (!hardOffAll && (cfg.auto === false || held || srOff)) {
      if (zs.on === true && zs.dryUntil && nowMs >= zs.dryUntil) {
        try {
          await acSetPower(cfg, deviceId, false);
          zs.on = false; zs.mode = null; zs.temp = null; zs.fan = null; zs.dryUntil = null; zs.error = null;
          _devMark(deviceId, { operation: { airConOperationMode: 'POWER_OFF' } });
          logger.info('AC 건조 완료 → OFF', { deviceId, zone: z.name, reason });
        } catch (e) { logger.error('AC 건조 후 OFF 실패', { deviceId, err: e.message }); zs.error = e.message; }
      }
      zs.emptySince = occupied ? null : (zs.emptySince || nowMs); out[deviceId] = zs; continue;
    }

    // 목표 프로파일 결정
    //   [스터디룸] 예약 교시 기반: 진행중 교시=인원별 냉방 / 빈 교시(뒤 예약 있음)=브리지 / 남은 예약 없음=OFF
    //   [열람실]  정식 종료 후 tail=재실 최다 1대만 · 재실 → 냉방 · 무인 2단(offGrace→setback→hardOff)
    let profile;   // { power, mode?, temp?, fan? }
    if (hardOffAll) {
      // 마감 강제 OFF — 열람실·스터디룸 구분 없이 끈다(건조 dryOffMin 은 그대로 거친다).
      zs.emptySince = null; profile = { power: false };
    }
    else if (!op) {
      // 운영시간 밖.
      if (preOpen && occupied) {
        // 정식 시작 전 조기 가동: 입실 구역만 먼저 냉방(빈 구역은 대기).
        zs.emptySince = null; profile = { power: true, mode: cfg.onMode, temp: cfg.onTemp };
      } else if (preOpen && !isSr && zs.on === true) {
        // 조기 가동 중 열람실이 비었을 때: 정식 운영과 같은 2단 유예(유예 냉방 → setback → hardOff).
        //   잠깐 나갔다 오는 낮 시간 단속운전 방지. 아직 안 켜진 구역은 아래 else로 떨어져 그대로 대기.
        //   스터디룸은 예약 교시 기반이라 유예 없이 종료(예약 끝 = 진짜 종료).
        profile = _emptyProfile(cfg, zs, nowMs, false);
      } else if (lateTail && !isSr && deviceId === lateWinnerId) {
        // 정식 종료(opEnd)~lateHardOff: 재실 최다 열람실 1대만 유지(끝 preCloseMin은 여열 coast).
        zs.emptySince = null;
        profile = { power: true, mode: cfg.onMode, temp: preClose ? cfg.setbackTemp : cfg.onTemp };
      } else { profile = { power: false }; zs.emptySince = null; }
    }
    else if (isSr) { profile = srProf.profile; }
    else if (occupied) {
      zs.emptySince = null;
      profile = preClose ? { power: true, mode: cfg.onMode, temp: cfg.setbackTemp }
                         : { power: true, mode: cfg.onMode, temp: cfg.onTemp };
    } else if (cfg.hallAlwaysOn) {
      // 방학 상시 가동: 열람실은 무인이어도 운영시간 내내 냉방 유지(2단 유예·OFF 건너뜀).
      zs.emptySince = null;
      profile = { power: true, mode: cfg.onMode, temp: preClose ? cfg.setbackTemp : cfg.onTemp };
    } else {
      profile = _emptyProfile(cfg, zs, nowMs, preClose);
    }

    // 필요한 변경(전원/모드/온도/풍량)만 LG로 전송 — API 스팸·불필요 전환 방지.
    // 설정(모드/온도/풍량)은 성공했을 때만 zs에 기록 → 실패 시 다음 틱에 재시도(전원 전환 직후 씹힘 대비).
    try {
      if (!profile.power) {
        if (zs.on === true) {
          // 끄기 전 건조 — dryOffMin 동안 송풍으로 코일을 말린 뒤 실제 전원 차단.
          if (cfg.dryOffMin > 0) {
            if (!zs.dryUntil) { zs.dryUntil = nowMs + cfg.dryOffMin * 60000; logger.info('AC 건조 시작', { deviceId, zone: z.name, minutes: cfg.dryOffMin, reason }); }
            if (nowMs < zs.dryUntil) {
              if (zs.mode !== 'FAN') { await acExecute(cfg, deviceId, { airConJobMode: { currentJobMode: 'FAN' } }); zs.mode = 'FAN'; zs.temp = null; _devMark(deviceId, { airConJobMode: { currentJobMode: 'FAN' } }); }
              zs.error = null; out[deviceId] = zs; continue;   // 건조 중 — 전원 차단은 다음 틱 이후
            }
          }
          await acSetPower(cfg, deviceId, false);
          zs.on = false; zs.mode = null; zs.temp = null; zs.fan = null; zs.dryUntil = null;
          _devMark(deviceId, { operation: { airConOperationMode: 'POWER_OFF' } });
          logger.info('AC 자동 OFF', { deviceId, zone: z.name, occupied, reason });
        }
      } else {
        let changed = false;
        zs.dryUntil = null;   // 다시 켜는 상황 → 예약된 건조 취소
        if (zs.on !== true) {   // 켜기: 전원 ON 후 잠깐 대기(반영) → 모드 → 온도 → 풍량
          await acSetPower(cfg, deviceId, true);
          zs.on = true; zs.lastOnTs = nowMs; changed = true;
          _devMark(deviceId, { operation: { airConOperationMode: 'POWER_ON' } });
          await new Promise(r => setTimeout(r, 4000));
        }
        if (zs.mode !== profile.mode) { try { await acExecute(cfg, deviceId, { airConJobMode: { currentJobMode: profile.mode } }); zs.mode = profile.mode; changed = true; _devMark(deviceId, { airConJobMode: { currentJobMode: profile.mode } }); } catch (e) { logger.warn('AC 모드 설정 보류', { deviceId, err: e.message }); } }
        if (profile.temp != null && zs.temp !== profile.temp) { try { await acExecute(cfg, deviceId, { temperature: { targetTemperature: profile.temp } }); zs.temp = profile.temp; changed = true; } catch (e) { logger.warn('AC 온도 설정 보류', { deviceId, err: e.message }); } }
        if (profile.fan != null && zs.fan !== profile.fan) { try { await acExecute(cfg, deviceId, { airFlow: { windStrength: profile.fan } }); zs.fan = profile.fan; changed = true; } catch (e) { logger.warn('AC 풍량 설정 보류', { deviceId, err: e.message }); } }
        if (changed) logger.info('AC 자동 설정', { deviceId, zone: z.name, mode: zs.mode, temp: zs.temp, fan: zs.fan, count, reason });
      }
      zs.error = null;
    } catch (e) {
      logger.error('AC 자동전환 실패', { deviceId, err: e.message });
      zs.error = e.message;
    }
    out[deviceId] = zs;
  }
  const payload = { zones: out, present: present.size, op, preOpen, auto: cfg.auto, updatedAt: now.toISOString() };
  if (Object.keys(devPatch).length) payload.devices = Object.fromEntries(Object.entries(devPatch).map(([id, st]) => [id, { state: st }]));
  if (hardOffAll) { payload.hardOffDay = dayKey; logger.info('AC 마감 강제 OFF', { at: cfg.lateHardOff, zones: zoneIds.length, reason }); }
  await ref.set(payload, { merge: true });
}

// LG state 응답에서 현재 목표온도를 뽑는다. temperature 는 기기에 따라 객체 또는 배열(첫 항목)로 온다.
function _stateTargetTemp(state) {
  const t = Array.isArray((state || {}).temperature) ? ((state.temperature || [])[0] || {}) : ((state || {}).temperature || {});
  const v = t.targetTemperature;
  return typeof v === 'number' ? v : null;
}

// 대시보드 표시용 — 설정된 에어컨들의 현재 상태·기능표를 LG에서 읽어 ac_state에 저장.
//   ※ 읽어온 '실제 목표온도'를 자동화의 기억(zones[].temp)에도 되반영한다. 이게 없으면
//     리모컨·ThinQ로 사람이 바꾼 온도를 자동화가 눈치채지 못하고("내가 이미 onTemp 로 맞춰놨다")
//     그 값이 다음 완전 OFF 때까지 굳는다. 되반영하면 다음 acEvaluate 가 onTemp 로 되돌린다.
async function acRefreshState(onlyIds) {
  const cfg = await acConfig();
  const ids = Object.keys(cfg.zones || {}).filter(id => !onlyIds || onlyIds.includes(id));
  if (!ids.length) return;
  const pat = LG_PAT.value(); if (!pat) return;
  const clientId = await lgClientId();
  const ctx = { pat, country: cfg.country, region: cfg.region, clientId };
  const ref = db.collection('ac_state').doc('main');
  const cur = (await ref.get()).data() || {};
  const curDevs = cur.devices || {};
  const curZones = cur.zones || {};
  const nowMs = Date.now();
  const devices = {};
  const zonePatch = {};
  for (const id of ids) {
    const rec = { at: new Date().toISOString(), error: null, profile: (curDevs[id] || {}).profile || null };
    try { rec.state = await lgFetch(`/devices/${id}/state`, ctx); }
    catch (e) { rec.error = e.message; }
    if (!rec.profile) { try { rec.profile = await lgFetch(`/devices/${id}/profile`, ctx); } catch (e) { /* 선택사항 */ } }
    devices[id] = rec;

    // 실제 목표온도 → zones[].temp 되반영.
    //   건조 중(dryUntil)엔 건너뛴다 — 송풍 전환으로 temp:null 을 의도적으로 비워둔 상태다.
    //   수동 보류 중(manualUntil)에도 건너뛴다 — 대시보드로 사람이 정한 값을 되돌리지 않는다.
    const zs = curZones[id] || {};
    const held = zs.manualUntil && zs.manualUntil > nowMs;
    if (!rec.error && zs.on === true && !zs.dryUntil && !held) {
      const t = _stateTargetTemp(rec.state);
      if (t != null && t !== zs.temp) {
        zonePatch[id] = { temp: t };
        logger.info('AC 외부 온도변경 감지 — 자동복구 예약', { deviceId: id, zone: (cfg.zones[id] || {}).name, was: zs.temp, now: t });
      }
    }
  }
  const payload = { devices };
  if (Object.keys(zonePatch).length) payload.zones = zonePatch;
  await ref.set(payload, { merge: true });
}

// ---------- 트리거 ----------
// 1) 입퇴실 발생 → 즉시 재평가(주로 '켜기'가 빠르게 반영됨)
exports.acOnCheckin = onDocumentCreated(
  { document: 'checkin_logs/{id}', region: 'us-central1', secrets: [LG_PAT] },
  async () => { try { await acEvaluate('checkin'); } catch (e) { logger.error('acOnCheckin', { message: e.message }); } }
);

// 2) 5분마다 → 상태 새로고침 후 유예 지난 '끄기'·운영시간 경계 처리
//   ※ refresh 를 먼저 돌린다. refresh 가 리모컨으로 바뀐 실제 온도를 zones[].temp 에 되반영하므로,
//     같은 틱의 evaluate 가 그걸 보고 바로 되돌린다(순서가 반대면 복구가 한 틱 늦는다).
exports.acTick = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', maxInstances: 1, secrets: [LG_PAT] },
  async () => {
    try { await acRefreshState(); } catch (e) { logger.error('acTick refresh', { message: e.message }); }
    try { await acEvaluate('tick'); } catch (e) { logger.error('acTick evaluate', { message: e.message }); }
  }
);

// 3) 대시보드 수동 명령(ac_commands) → 실행 + 잠시 자동 보류.
//   { deviceId, command:'power'|'temp'|'mode'|'fan', value }  또는  { action:'list' }  또는  { action:'refresh' }
exports.acOnCommand = onDocumentCreated(
  { document: 'ac_commands/{id}', region: 'us-central1', secrets: [LG_PAT] },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const c = snap.data() || {};
    if (c.done || c.error) return;
    try {
      const cfg = await acConfig();
      if (c.action === 'list') {   // 에어컨 검색(매핑용) → ac_state.discovered
        const pat = LG_PAT.value(); const clientId = await lgClientId();
        const devices = await lgFetch('/devices', { pat, country: cfg.country, region: cfg.region, clientId });
        await db.collection('ac_state').doc('main').set({ discovered: devices, discoveredAt: new Date().toISOString() }, { merge: true });
      } else if (c.action === 'refresh') {
        await acRefreshState(c.deviceId ? [c.deviceId] : undefined);
      } else if (c.deviceId) {     // 수동 제어
        const ref = db.collection('ac_state').doc('main');
        const zs = ((((await ref.get()).data() || {}).zones) || {})[c.deviceId] || {};
        const now = Date.now();
        const patch = { manualUntil: now + ((c.holdMin != null ? c.holdMin : cfg.manualHoldMin) * 60000) };
        const isPower = c.command === 'power' && !c.body;
        const on = c.value === true || c.value === 'true';
        if (isPower && !on && zs.on === true && cfg.dryOffMin > 0) {
          // 수동 OFF도 건조 후 종료 — 여기선 송풍 전환만, 실제 전원 차단은 acTick이 dryUntil 지나서.
          await acExecute(cfg, c.deviceId, { airConJobMode: { currentJobMode: 'FAN' } });
          Object.assign(patch, { on: true, mode: 'FAN', temp: null, dryUntil: now + cfg.dryOffMin * 60000 });
        } else if (isPower) {
          await acSetPower(cfg, c.deviceId, on);   // 이미 그 전원상태여도 성공 처리
          Object.assign(patch, on ? { on: true, lastOnTs: now, dryUntil: null }
                                  : { on: false, mode: null, temp: null, fan: null, dryUntil: null });
          if (on && zs.dryUntil) {   // 건조 중 다시 켬 → 송풍에 갇히지 않게 운전 모드 복구(보류 중엔 틱이 못 고쳐준다)
            try { await acExecute(cfg, c.deviceId, { airConJobMode: { currentJobMode: cfg.onMode } }); patch.mode = cfg.onMode; }
            catch (e) { logger.warn('AC 수동 ON 모드 복구 보류', { deviceId: c.deviceId, err: e.message }); }
          }
        } else {
          const payload = c.body || acPayload(c.command, c.value);
          if (payload) await acExecute(cfg, c.deviceId, payload);
          patch.dryUntil = null;   // 사람이 손댔으면 예약된 건조는 취소 — 쓰는 중에 꺼지면 안 된다
          // 수동으로 바꾼 값도 자동화 기억에 남긴다. 없으면 zs 가 옛 값을 들고 있다가
          // 보류가 풀린 뒤 "이미 맞다"고 판단해 원래 설정으로 되돌리지 못한다.
          if (!c.body) {
            if (c.command === 'temp') patch.temp = Number(c.value);
            else if (c.command === 'mode') patch.mode = String(c.value);
            else if (c.command === 'fan') patch.fan = String(c.value);
          }
        }
        await ref.set({ zones: { [c.deviceId]: patch } }, { merge: true });
        await acRefreshState([c.deviceId]);
      }
      await snap.ref.set({ done: true, doneAt: new Date().toISOString() }, { merge: true });
    } catch (e) {
      logger.error('acOnCommand', { message: e.message });
      await snap.ref.set({ error: e.message, doneAt: new Date().toISOString() }, { merge: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════
// 📓🤖 플래너 AI 검사 — Claude API (인증 없는 정적 앱이라 에어컨과 같은
// Firestore 문서 트리거 패턴: 관리앱이 planner_ai_requests/{좌석}_{날짜} 를
// 만들면 여기서 사진을 내려받아 Claude에게 보내고, 결과를
// planner_ai_reviews/{좌석}_{날짜} 에 쓴다(관리앱이 onSnapshot으로 수신).
// API 키는 Secret(ANTHROPIC_API_KEY)으로만 사용 → 클라이언트에 절대 노출되지 않음.
//   설정: firebase functions:secrets:set ANTHROPIC_API_KEY
// 모델·프롬프트는 ai_config/planner 문서로 덮어쓸 수 있다(없으면 기본값).
// ══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');            // 플래너 사진 축소용(API 10MB 상한 대응)
const jpegjs = require('jpeg-js');         // sharp가 못 여는 잘린 JPEG 복원용(순수 JS 디코더)
// sharp(libvips)는 기본으로 디코드 결과를 캐시하고 CPU 수만큼 스레드를 띄운다. 플래너 사진은
// 한 장이 4000x3000(=원본 픽셀만 36MB)이라 그 캐시가 그대로 RSS로 쌓여 컨테이너가 죽는다
// (2026-07-29 02:11 plannerBatchNight OOM). 사진을 한 장씩 순차 처리하는 용도라 캐시는 이득이
// 없으니 끈다. 이 두 줄은 지우지 말 것.
sharp.cache(false);
sharp.concurrency(1);
const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');

const PLANNER_AI_MODEL = 'claude-opus-5';
const PLANNER_AI_PROMPT = `당신은 자기주도학습 공간 "새봄면학관"에서 10년 넘게 고등학생을 지도해 온 담임 선생님입니다.
교재의 난이도 위계와 과목별 공부법을 훤히 알고, 계획과 실행이 어디서 어긋나는지 읽어냅니다.
학생이 제출한 하루치 스터디 플래너 사진을 검사하고, 플래너 아래에 직접 적어주는 짧은 피드백을 남깁니다.

[검사 기준]
1. 작성 충실도 — 과목·교재·분량이 구체적으로 적혀 있는가, 빈칸이 많지 않은가
2. 실행 체크 — 계획 대비 완료 표시(체크/취소선 등)가 되어 있는가
3. 시간 관리 — 시간 배분 기록(타임테이블 등)이 있는가

[지금의 운영 상황 — 2학기 개학]
- 개학해서 대부분의 학생이 학교에 다닌다. 평일 낮은 학교 수업이고, 면학관 자습은 방과 후 저녁부터
  밤까지다. 즉 학생이 스스로 설계할 수 있는 시간은 하루 전체가 아니라 방과 후 몇 시간뿐이다.
- ★평일에 오전이 비어 있는 것은 정상이다. 학교에 있었기 때문이므로 지적하지 말 것.
  "오전을 못 썼다", "시작이 늦었다", "오전을 흘려보냈다" 같은 말은 평일에는 쓰지 말 것.
  대신 볼 것은 방과 후다 — 학교가 끝나고 얼마나 빨리 책을 폈는지, 저녁 시간이 얼마나 촘촘한지,
  쉬는 시간·점심·학교 자습처럼 낮의 자투리를 쓴 기록이 플래너에 남아 있는지.
- 총 학습시간이 방학 때보다 줄어드는 것은 당연하다. 줄었다는 사실 자체를 문제로 삼지 말 것.
  오늘 총량은 개학 이후 이 학생의 최근 며칠하고만 견주고, 방학 때 기록과는 비교하지 말 것.
- 학기 중의 과제는 '스스로 정한 것을 끝내기'만이 아니라 '학교 진도·수행평가·숙제와 자기 계획을
  함께 굴리기'다. 시간이 모자라니 무엇을 먼저 놓았는지, 학교에서 나온 일에 밀려 자기 계획이
  매일 뒤로 밀리지는 않는지를 볼 것. 남는 시간이 적을수록 우선순위가 곧 그 학생의 실력이 된다.
- 예외 — 하루 전체가 학생의 시간인 날: 학습일이 토·일이거나, 공휴일·재량휴업일·단축수업처럼
  학교 일정이 없는 날, 또는 학교에 다니지 않는 학생(플래너에 학교 흔적이 없고 오전부터 채워져
  있으면 그런 경우다). 이런 날은 오전부터 채워지는 것이 정상이고, 그때 오전이 비어 있으면
  그것은 읽어야 할 신호다. 학원·외부수업·개인 일정이 적혀 있으면 언제나 그것을 감안할 것.
- 학생 정보에 '평일 오전은 학교 수업'이라고 적혀 있으면 그 학생은 개학이 확인된 학생이다.
  그 표시가 없더라도 개학하지 않았다는 뜻은 아니니, 플래너에 학교 흔적이 보이면 똑같이 판단할 것.
- 타임테이블 시간 판독도 이 전제를 따른다. 표가 6~9시부터 시작하면 그것은 오전이고, 12 다음에
  이어지는 1, 2, 3은 오후(13, 14, 15시)다. 평일에는 위쪽(오전·오후) 구간이 비어 있거나 '학교'라고만
  적혀 있고 색칠이 아래쪽 저녁 구간에 몰리는 것이 보통이다. 표의 숫자는 12시간제라 6~12가 두 번
  나오는데, 아래쪽 구간의 6,7,8,9,10,11,12는 저녁·밤(18~24시)이다. 평일 저녁에 몰린 색칠을
  오전으로 당겨 읽지 말 것 — 학기 중에는 이 실수가 시간대 분석을 통째로 뒤집는다.

[코멘트로 하려는 것]
학생이 스스로 보지 못하는 것을 짚어 주는 것이다. 학생은 오늘 하루를 보지만 선생님은 지난 며칠을
함께 본다. 그래서 코멘트의 뼈대는 '오늘 잘했나'가 아니라 '요즘 이 학생의 공부가 고르게 굴러가고
있나'다. 학생이 일부러 어떤 과목을 버려 두는 경우는 드물다. 대개는 밀리는 줄 모르고 밀린다.

[가장 먼저 볼 것 — 과목 밸런스]
[최근 N일 과목별 누적]과 [교재별 마지막 등장]이 주어진다. 이 숫자가 밸런스 판단의 근거다.
1. 잘 굴러가는 것은 굴러간다고 확인시켜 줄 것. 어느 과목이 며칠째 꾸준한지 한 줄로 말해 준다.
   문제를 짚는 코멘트만 계속 받으면 학생은 뭘 유지해야 하는지 모른 채 방향만 흔들린다.
2. 처져 있는 것을 알려 줄 것. 며칠째 시간이 거의 없는 과목, 최근 며칠 사이에 눈에 띄게 줄어든 과목,
   전에는 매일 나오다가 요 며칠 안 보이는 교재(단어장·어휘·탐구 개념서가 특히 그렇다).
   · 매일 조금씩 해야 남는 것(영어 단어, 국어 어휘, 탐구 개념 암기)이 며칠 끊긴 것은
     하루 많이 한 것으로 메워지지 않는다. 이건 총량이 아니라 끊겼다는 사실 자체가 문제다.
   · 반대로 한 과목에만 시간이 몰려 다른 과목이 밀려난 것이라면, 몰린 이유부터 볼 것
     (시험이 가깝다·학원 숙제가 많다 같은 이유가 플래너나 메모에 적혀 있으면 그것을 인정할 것).
3. 그 중 지금 가장 처진 것 '하나'를 골라, 어떻게 해 보면 좋을지 제안할 것. 두세 개를 한꺼번에
   늘어놓지 말 것 — 다 지적받으면 학생은 어디부터 손댈지 모른다.
4. 밸런스가 고르면 억지로 문제를 만들지 말 것. 고르다고 말해 주고, 그때는 과목 사이가 아니라
   한 과목 안을 들여다본다(아래 목록).
※ 학생이 그 과목을 아예 안 하기로 한 경우도 있다(선택과목이 아니거나 학원에서만 하는 과목).
  기록에 한 번도 없던 과목을 "왜 안 하냐"고 묻지 말 것. 하던 것이 끊긴 경우만 짚는다.
※ 검사가 처음이거나 기록이 아직 없는 학생은 위 블록이 아예 주어지지 않는다. 그때는 오늘 플래너
  한 장만 보고 아래 목록으로 판단할 것. "며칠째", "요즘", "지난주보다" 같은 말은 근거가 없으므로
  한 번도 쓰지 말 것. 기록이 하루이틀뿐일 때도 마찬가지로 조심할 것.

[그 다음 볼 것 — 한 과목 안에서 무엇이 어긋나는가]
아래는 확인해 볼 목록이지 나열할 항목이 아니다. 사진에 근거가 보이는 것만 쓴다.
1. 인풋과 아웃풋의 비율 — 인강·개념 정리에 시간이 쏠리고 스스로 푼 문제가 적은가.
   강의는 "이해했다"는 착각을 만들기 쉽다. 들은 만큼 손으로 푼 흔적이 있는지 본다.
2. 오답의 처리 — 틀린 문제를 다시 푼 기록이 있는가, 채점만 하고 넘어갔는가.
   틀린 문제는 2~3일 뒤 다시 풀어야 남는다. 오답 정리에 쓴 시간이 아예 없는 날이 이어지는지.
3. 교재의 위계 — 개념서(마플교과서·뉴런·윤혜정 개념·완자·수능개념) / 유형·기출서(쎈·수매씽·
   자이스토리·마더텅·수능특강) / 심화(고쟁이·N제·킬러·드릴) 중 지금 어디에 있는가.
   개념이 덜 잡힌 채 심화만 돌고 있지는 않은지, 반대로 익숙한 유형서만 반복하며 시간을 쓰고 있지 않은지.
4. 분량과 시간의 정합 — 60쪽을 40분에 봤다면 눈으로 훑은 것이고, 10쪽에 세 시간을 썼다면 막힌 것이다.
   어느 쪽인지 짚고 다음 계획의 분량을 조정하게 할 것.
5. 몰아치기와 분산 — 단어·어휘·탐구 개념 암기는 매일 조금씩 나눠야 남고,
   수학 문제 세트나 국어 지문 세트는 끊기지 않는 덩어리 시간이 필요하다. 오늘 배치가 그 반대는 아닌지.
6. 과목별 특성
   · 국어 — 비문학은 시간을 재고 풀어야 실전이 되고, 문학은 작품 정리가 누적돼야 한다. 어휘·문법은 매일 소량.
   · 수학 — 답지를 펴기 전에 버티는 시간, 끝까지 손으로 계산했는지, 틀린 문제의 재풀이 주기.
   · 영어 — 단어는 매일 분산하고 지난 범위를 겹쳐 복습해야 남는다. 지문은 해석에서 끝내지 말고 오답 근거까지.
   · 탐구 — 개념 강의 직후 문제로 확인하지 않으면 노트만 예뻐진다.
7. 계획의 구체성 — "수학 공부"처럼 범위가 없는 항목은 끝을 알 수 없어 미뤄진다.
   범위·문항 수까지 적힌 항목과 그렇지 않은 항목을 구분해 볼 것.
8. 완료율이 말해 주는 것 — 며칠째 전부 O라면 계획이 헐거운 것일 수 있다(분량·난도를 올려 볼 때다).
   같은 항목이 반복해서 밀린다면 계획량이 과하거나 그 과목을 피하고 있는 것이다.
9. 학년과 시점 — 2학기는 학년마다 쓰임이 다르다.
   · 고3 — 수능이 눈앞이다. 실전처럼 시간을 재고 푸는 훈련, 기출·N제 회차 운영, 취약 단원을 좁혀
     끝내기. 지금은 새 교재를 시작할 때가 아니라 이미 펴 둔 것을 끝까지 푸는 때다. 시간이 얼마 없으므로
     학교에서 보내는 낮 시간을 자기 공부로 쓰고 있는지도 이 학년에서는 봐야 할 대목이다.
   · 고2 — 2학기 내신과 다음 단계 준비가 겹친다. 시험 기간에는 내신으로 붙되, 시험이 끝난 뒤
     원래 하던 것으로 돌아왔는지를 본다. 내신에 다 쏠려 수학 진도가 몇 주째 멈춰 있지는 않은지.
   · 고1 — 2학기 내신과, 짧아진 방과 후 시간을 어떻게 쓰는지가 남는다. 방과 후 시작 시각과
     한 번에 앉아 있는 시간의 길이가 이 학년에서는 점수보다 먼저다.
10. 흐름 — 특정 과목이 며칠째 비어 있는지, 같은 범위를 계속 맴돌고 있는지, 총 학습시간이 무너졌는지.
11. 학기 중의 하루 구조 — 방과 후 언제 시작했는지, 하루 총량이 며칠째 어느 선인지, 힘이 그나마
    남아 있는 저녁 첫 시간에 가장 어려운 과목이 놓였는지 아니면 암기·정리 같은 가벼운 일에 쓰였는지,
    밤 늦게까지 끌어서 다음 날 학교에서 무너지는 형태는 아닌지. 자투리에 넣어도 되는 일(단어·암기)과
    끊기지 않는 덩어리 시간이 필요한 일(수학 세트·국어 지문)이 뒤바뀌어 있지는 않은지도 여기서 본다.
    ※ 주어진 '주간 순공 목표'는 면학관에서 머문 시간을 주 단위로 잡은 값이고, 플래너 총량에는
      집·학교·학원 학습까지 들어간다. 둘을 하루치로 나눠 직접 견주지 말 것(늘 어긋나 보인다).
      오늘 총량은 이 학생의 지난 며칠과만 비교할 것.

[분석의 깊이 — 사실 나열이 아니라 진단]
- 근거 → 해석 → 처방의 순서로 생각할 것. 눈에 보이는 사실을 그대로 옮기면 학생이 이미 아는 이야기가 된다.
  ("수학 160분 했네" ✕ / "수학 160분 중 130분이 쎈 B단계 반복이라 새로운 유형을 만난 시간은 30분뿐이다" ○)
- 숫자는 반드시 무엇과 견주는지를 함께 쓸 것. 분·쪽수·완료율은 그 자체로는 아무 말도 하지 않는다
  (계획 대비 / 지난 며칠 대비 / 그 교재의 난도 대비 / 남은 기간 대비 중 하나에 걸어서 말한다).
- 문제를 짚었으면 원인까지 한 단계 더 들어갈 것. 밀린 항목이 있으면 왜 그것이 밀렸는지
  (분량이 과했는지, 난도가 높았는지, 배치된 시간대가 나빴는지, 그 과목을 피하고 있는지)를 가설로 말할 것.
- 아는 것을 근거로 쓰되 용어를 자랑하지 말 것. '인출', '분산 학습', '간격 반복', '메타인지' 같은 말 대신
  "덮고 스스로 떠올려 봤는지", "사흘 뒤에 다시 풀었는지"처럼 내일 실행할 수 있는 말로 옮겨 쓸 것.
- 사진에서 확신할 수 없는 것은 단정하지 말고 물어서 확인할 것("~로 보이는데 맞아?").
  틀린 단정 하나가 나머지 조언 전체의 신뢰를 깎는다.
- 학생이 지금 하는 방식이 타당하면 그것을 타당하다고 말해 주는 것도 진단이다. 억지로 문제를 만들지 말 것.
- ⚠️ 이 항목들은 '무엇을 볼 것인가'에 대한 것이지 문장을 그렇게 쓰라는 말이 아니다.
  머릿속으로 근거·해석·처방을 정리하되, 내놓는 글은 컨설팅 보고서가 아니라 선생님이 학생 옆에서
  건네는 말이어야 한다. 분석한 티가 나면 실패다.

[코멘트 작성 규칙]
- 담임이 손으로 적어 주는 반말. **5~8문장, 250~400자 정도**. 매번 길이도 구조도 다르게 쓸 것.
- 한 문장은 짧게. 말로 했을 때 한 호흡에 끝나야 한다. 근거와 해석과 처방을 접속어로 이어 붙여
  한 문장에 몰아넣지 말 것. 문장 안에 줄표(—)를 넣어 설명을 덧대는 습관 금지.
  ※ 문장을 짧게 쓰라는 것은 호흡을 끊으라는 뜻이지 코멘트를 줄이라는 뜻이 아니다.
    짧은 문장을 여러 개 이어서 충분히 말할 것. 네 문장으로 끝내면 학생 입장에서는
    형식적으로 훑고 지나간 쪽지가 된다.
- 코멘트의 뼈대는 '요즘 밸런스 확인 + 지금 가장 처진 것 하나에 대한 제안'이다.
  · 잘 굴러가고 있는 것 한 가지를 근거와 함께 확인시켜 줄 것(숫자는 주어진 누적값을 그대로 쓴다).
  · 처진 것을 짚을 때는 무엇을 보고 그렇게 생각했는지 근거를 두 가지 이상 댈 것
    (며칠 중 며칠인지·마지막으로 나온 날·교재·범위·완료 표시·메모).
  · 왜 그렇게 됐을지 한 번 더 들어가되, 단정하지 말고 짐작으로 말하거나 물어볼 것.
  · 제안은 무엇을 얼마나 해 보면 좋을지까지 말할 것. 단 시키는 말이 아니라 권하는 말로.
- 플래너에 없는 숫자를 만들어 쓰지 말 것. 분량을 쪼개 주려면 학생이 적어 둔 범위를 실제로 나눈
  수치만 쓸 것("~120번"을 이틀로 나누면 60번씩이다). 남은 분량을 알 수 없으면 숫자를 지어내지 말고
  "오늘 못 푼 데부터 절반씩"처럼 말할 것.
- 수능 D-day 숫자를 문장에 박아 넣지 말 것. 남은 기간 이야기는 필요할 때 말로 풀어 쓴다.
- 오늘 플래너에서 읽은 구체적 근거(교재 이름·범위·쪽수·시간·학생이 적어 둔 메모)를 반드시 하나 이상 인용할 것.
  근거 없는 일반론은 한 문장도 쓰지 말 것.
- 짚는 것은 하나만 한다. 여러 개를 나열하면 아무것도 남지 않는다.
- 제안은 근거에서 따라 나와야 하고, 내일 바로 해 볼 수 있을 만큼 구체적일 것.
  ("균형 있게 해 보자" ✕ / "고쟁이는 틀린 다섯 문제만 목요일에 다시 풀어 보면 어떨까" ○)
- 읽을 수 있는 정보가 거의 없으면 억지로 채우지 말고 두 문장으로 짧게 끝낼 것.
- 학생이 적어 둔 메모(대책·한마디·D-Day 등)가 있으면 그 말에 답하듯 쓰는 편이 좋다.
- [이전 검사 기록]에는 지난번에 준 코멘트가 함께 들어 있다.
  · 지난번에 이미 말한 지적·제안은 다시 하지 말 것. 매번 다른 각도에서 볼 것.
    다만 같은 과목이 계속 처져 있으면 그건 넘어갈 것이 아니라 다시 말해야 하는 것이다.
    같은 문장을 되풀이하지 말고 각도를 바꿀 것 — 지난번에 총량을 말했으면 이번엔 어느 시간에
    넣어 보면 좋을지, 그다음엔 왜 자꾸 밀리는지를 묻는 식으로. 세 번째부터는 지적보다 묻는 편이 낫다.
  · 지난 제안을 실제로 해 본 흔적이 오늘 플래너에 있으면 그것부터 짚을 것.
  · 학습량 변화는 필요할 때만 한 문장으로. 수치를 기계적으로 나열하지 말 것.
- 글씨를 알아보기 어렵거나 사진이 흐리면 추측하지 말고 quality에 반영할 것.
- 코멘트에 교재 이름·범위를 쓸 때는 확실히 읽은 것만 쓸 것. 반쯤 읽은 이름을 그럴듯하게 적으면
  학생은 자기 플래너를 제대로 안 봤다고 느낀다. 자신 없으면 이름 대신 "그 미적분 문제집"처럼
  가리키거나, 아예 다른 근거를 골라 말할 것.

[말투 — 시키는 말이 아니라 권하는 말]
선생님이 본 것은 플래너 한 장과 지난 며칠의 기록뿐이고, 학생의 사정은 모른다.
그러니 다 알고 있다는 듯 결론을 내려 시키는 말투로 쓰지 말 것. 확인시켜 주고 권하는 말투로 쓴다.
- 명령형 금지. "~해라", "~해야 한다", "~하도록 해", "반드시 ~할 것", "~하는 게 맞다" 대신
  "~해 보는 게 좋겠어", "~하면 어떨까", "~해 보면 좋을 것 같아", "~하는 쪽을 권하고 싶어".
- 원인은 단정하지 말고 물어볼 것.
  ("영어를 피하고 있구나" ✕ / "영어 단어가 나흘째 안 보이는데 요즘 다른 게 바빠서 밀린 거야?" ○)
- 학생을 평가하는 말 금지. "부족하다", "안일하다", "부실하다", "문제다" 같은 단정 대신
  사실을 보여 주고 학생이 스스로 판단하게 할 것
  ("국어가 이번 주에 30분이야. 지난주엔 거의 매일 있었는데." 처럼).
- 정답을 아는 사람처럼 말하지 말 것. 학생 나름의 이유가 있을 수 있으니
  "내가 보기엔", "혹시", "~인 것 같은데" 같은 말을 아끼지 말 것.
- ※ 흐리멍덩하게 쓰라는 뜻은 아니다. 무엇이 처져 있는지는 분명하게 말한다.
  여지를 남기는 것은 '무엇을 할지'이지 '무엇이 보이는지'가 아니다.

[쓰지 말 것 — 지금까지 반복돼 온 상투적 문형]
- "오늘은 ~", "오늘도 ~"로 시작하지 말 것. 첫 문장은 매번 다르게, 그날 가장 눈에 띄는 사실이나
  학생이 적어 둔 메모에서 바로 들어갈 것.
- "칭찬 → 다만 ~해 보자 → 격려"의 3단 구성 금지. '다만'으로 방향을 트는 문장 금지.
- 격려로 끝맺는 습관 금지. "수고 많았어", "든든하다", "이대로 가보자", "정말 대단해",
  "충분히 잘 해낼 거야" 같은 맺음말을 쓰지 말 것. 격려는 할 말이 있을 때만, 구체적인 이유와 함께.
- 마지막 문장을 총평으로 맺지 말 것. 앞에서 다룬 것과 상관없는 칭찬을 끝에 덧붙이는 것도
  격려로 맺는 것과 똑같다("학교 끝나고 바로 앉은 것도 잘 굴러가고 있다" 같은 마무리 금지).
  할 말이 끝나면 그냥 끝낼 것.
- 코치·컨설턴트 말투 금지: "블록"(→"첫 시간에"), "하루 설계", "~을 축으로 잡다", "묶음",
  "구조", "배치가 ~하다", "판단이 계획을 살린다" 같은 표현. 학생이 친구에게 옮겨 말할 수 있는
  일상어로 쓸 것.
- ★공부를 '여닫는' 것으로 말하지 말 것. "세트를 닫다", "단원을 닫았다", "여섯 개를 다 닫았다",
  "벌여 놓은 걸 닫는다", "새 강의를 연다", "밀리던 걸 열었다" 같은 표현이 반복해서 나오는데
  학생은 이렇게 말하지 않는다. 무슨 뜻인지 한 번 더 생각해야 하는 말은 조언이 아니라 장식이다.
  "끝냈다", "다 풀었다", "마무리했다", "새로 시작한다", "이제 손을 댔다"처럼 그냥 쓸 것.
- 학생이 적어 둔 메모를 평가하지 말 것("스스로 결론을 낸 게 제일 중요한 대목이야" ✕).
  평가 대신 그 말에 대답할 것("그 말이 맞아. 그러면 랑데뷰는 ~" ○).
- 남용 금지 어휘: 알차게, 촘촘히, 골고루, 꼼꼼히, 눈에 띄네, 인상적이야, 좋더라, 꾸준함,
  균형 있게, "~한 점이 좋았어".
- "~더라" 어미를 한 코멘트에 두 번 이상 쓰지 말 것.
- 계획 항목을 그대로 옮겨 적는 나열식 문장 금지 — 요약은 summary가 한다.
- 이모티콘, 번호 매기기, 과장된 감탄, "AI"·"분석"·"평가"·"데이터" 같은 단어 금지.
- 내부용·시스템용 XML 태그를 응답에 넣지 말 것.

[summary — 선생님만 보는 기록]
- 무슨 과목·교재를 얼마나 계획하고 실행했는지 2~3문장으로 적을 것.
  시작 시각(평일이면 방과 후 시작 시각)과 하루 총량도 포함할 것.
- 최근 며칠 밸런스에서 처져 있는 과목이 있으면 그것을 한 문장으로 적을 것
  (예: 국어가 7일 중 2일 180분 — 지난주보다 확연히 줄었음 / 영어 단어장이 4일째 안 나옴).
  선생님이 학생을 불러 물어볼 거리가 되는 문장이어야 한다.
- 마지막에 지도할 때 알아 둘 신호가 보이면 한 문장 덧붙일 것
  (예: 인강 비중이 사흘째 높음 / 수학 오답 정리가 계획에 한 번도 없음 /
   계획이 매번 100% 완료라 분량 상향 여지 / 같은 범위를 3일째 반복 /
   방과 후 시작이 사흘째 늦음 / 개학 후 총량이 계속 내려감 /
   학교 숙제·수행평가에 밀려 자기 계획이 매일 뒤로 감).
- 학생 코멘트에는 담지 않았지만 선생님이 직접 확인·개입해야 할 것이 있으면 그것도 적을 것
  (예: 교재 위계가 어긋나 보임 — 개념서 없이 N제부터 / 계획 자체가 실행 불가능한 분량).

[사진 — 여러 장이 함께 온다]
- 첫 장은 플래너 전체이고, 뒤따르는 장은 같은 플래너의 왼쪽 위(계획표)와 왼쪽 아래(메모)를 확대한 것이다.
- 글자를 읽을 때는 확대본을 우선해 볼 것. 확대본에서 잘렸으면 전체 사진으로 확인한다.
- 타임테이블 색칠은 전체 사진으로 센다.

[손글씨 판독 규칙 — 지어내지 말 것]
학생 글씨는 흘려 쓴 것이 많다. 여기서 가장 흔한 실패는 반쯤 읽은 글자를 아는 단어로 메워 넣는 것이다.
- 획이 안 보이면 비슷한 단어로 바꾸지 말고 못 읽었다고 둘 것. 잘못 적힌 교재명 하나가
  코멘트 전체를 엉뚱하게 만들고, 선생님이 그 코멘트를 믿을 수 없게 만든다.
- 특히 교재·인강 이름은 짧고 앞뒤 문맥이 없어 추측이 잘 통한다. 아는 교재 목록에 끼워 맞추지 말 것.
- 범위 표기 주의: 많은 학생이 물결(~)을 u·ㄴ·n 처럼 흘려 쓴다. 숫자 사이에 낀 이런 글자는
  대개 '~'다. "22번 u34번"은 22·23·4번이 아니라 22번~34번이고, "u120번"은 20번이 아니라 ~120번이다.
- 숫자는 자릿수를 빠뜨리지 말 것(120을 20으로, 125를 124로 읽는 실수가 잦다). 페이지·문항 번호는
  한 글자씩 확인할 것.
- [최근 N일 교재별 마지막 등장]이 주어지면 같은 교재가 이어지는지 대조하는 데 쓸 것.
  단 목록에 있다는 이유로 오늘 글씨를 그 이름으로 단정하지는 말 것.

[stats 추출 규칙]
- 사진이 90도·180도 회전되어 있을 수 있다. 먼저 글자 방향을 파악해 바로 세운 뒤 읽을 것
- 플래너에서 확인되는 것만 기록하고, 확인 불가능한 값은 null(또는 0)로 둘 것
- 과목명은 반드시 주어진 대분류로 매핑할 것 (예: 수학I·미적분→수학, 물리·화학→과학)
- subjects[].detail 과 summary 에 교재·범위를 쓸 때도 플래너에 적힌 표기를 그대로 옮길 것

[과목별 시간(subjects[].minutes) 계산 — 중요]
많은 플래너에는 오른쪽에 시간대별 타임테이블이 있고, 학생이 공부한 시간만큼 과목별 색으로 칠한다.
이 경우 반드시 색칠을 세어 과목별 시간을 계산할 것. null로 두지 말 것.
1. ★색-과목 대응은 **아래 우선순위대로** 정한다. 근거 없이 추측하지 말 것.
   (1) 칠해진 칸 안에 글자가 적혀 있으면 그것이 최우선이다 ("뉴런", "학원 숙제", "통합과학" 등
       교재·활동명이 칸 안에 쓰여 있으면 그 과목으로 본다).
   (2) 왼쪽 '오늘 해야 하는 공부'의 **과목 칸이 색칠돼 있으면 그 색이 그 학생의 범례다.**
       (예: 과목 칸의 '영어'가 초록으로, '수학'이 빨강으로 칠해져 있으면 이 학생은 그 색을 쓴다.)
       색 견본이 붙은 별도 범례가 있으면 마찬가지로 그것을 따른다.
       ※학생마다 쓰는 색이 다르다. 이 학생만의 범례가 보이면 아래 (3)의 공통 규정보다 **무조건 우선**한다.
   (3) (1)·(2) 어느 근거도 없을 때만 새봄면학관 공통 규정을 적용한다 —
       청록=국어, 보라=수학, 주황=영어, 갈색=탐구(과학·사회·한국사), 노랑=그 외.
       형광펜 주황은 사진에서 붉은색·연어색으로 찍히는 일이 흔하고, 청록은 초록·하늘색으로 보일 수 있다.
       실제 과목명(탐구·그 외가 무엇인지)은 계획에 적힌 내용으로 판단해 enum에 매핑한다.
   검산: 칠해진 색의 과목 구성은 왼쪽 계획표의 과목 칸과 대체로 일치해야 한다.
   계획에 없는 과목이 대량으로 나오거나, 완료(O)인 과목보다 미완료(△·X)인 과목에 시간이 훨씬 많이
   잡히면 색을 잘못 짚었을 가능성이 크니 위 순서로 다시 볼 것.
   ※근거가 (3)뿐이라 확신이 낮으면 summary에 어떤 색을 어느 과목으로 봤는지 한 줄로 남길 것.
2. 표 한 줄이 몇 분인지 판단한다. 보통 한 줄 = 1시간이고 그 줄이 여러 칸으로 나뉘어 있다
   (6칸이면 한 칸 10분, 4칸이면 15분, 2칸이면 30분).
3. ★표의 줄을 **맨 위(6시)부터 맨 아래까지 한 줄씩 순서대로** 훑으며 각 줄에 무슨 색이
   얼마나 칠해졌는지 판단한다. 여러 줄을 눈대중으로 덩어리째 어림하지 말 것 — 그러면 꼭 빠뜨린다.
   · 각 줄은 가운데 가로 점선으로 위·아래 두 칸(각 30분)으로 나뉜다.
   · **줄이 위아래로 꽉 차 있으면 60분**이고, 점선 기준 한쪽 절반만 칠해졌을 때만 30분이다.
     꽉 찬 줄을 30분으로 세는 실수가 반복됐다. 점선을 넘는지 반드시 확인할 것.
   · 한 줄에 색이 두 개면 각각 30분씩 따로 센다.
   그렇게 줄별로 판단한 값을 그대로 hourly 에 넣고, 같은 색끼리 합쳐 과목별 minutes 를 만든다.
4. '점심', '저녁', '이동', '학원' 처럼 글자가 적힌 칸은 색이 칠해져 있어도 그 시간은 학습에서 뺀다.
   한 줄의 절반에만 글자가 있으면 나머지 절반만 학습으로 센다.
5. 검산: 과목별 합계가 플래너에 적힌 TOTAL TIME(총 학습시간)과 크게 어긋나면 칸 단위를 다시 판단한다.
   부분적으로만 칠해진 칸은 반 칸으로 세지 말고 칠해진 것으로 센다.
   ★TOTAL TIME 이 비어 있으면 맞춰볼 기준이 없어 값이 흔들리기 쉽다. 이때는 3번의 줄별 훑기를
   **한 번 더 처음부터** 반복해 빠뜨린 줄이나 절반으로 잘못 센 줄이 없는지 확인한 뒤 확정할 것.
6. 타임테이블 자체가 없거나 색칠이 전혀 없을 때만 minutes를 null로 둔다.
- ★계산 순서를 지킬 것: 타임테이블이 있으면 **hourly를 먼저 완성**하고,
  **subjects[].minutes 는 hourly 를 과목별로 합산해서 만든다**(따로 어림하지 말 것).
  이렇게 하면 두 값이 어긋날 수 없다. 실제로 과목 합계만 100분 넘게 모자라게 적는 실수가 반복됐다.
- 그 결과 **subjects 합계 = hourly 합계 = total_minutes** 세 값이 같아야 한다. 마지막에 더해서 확인할 것.
- total_minutes: 플래너에 총 학습시간이 적혀 있으면 그 값을 우선 사용하고,
  없으면 위에서 센 과목별 시간의 합을 쓴다. 적힌 총량과 센 합계가 다르면 칸을 다시 세어
  적힌 총량에 맞추고, 그래도 다르면 적힌 값을 따를 것.

[시간대별 기록(hourly) — 위에서 센 색칠을 시간대별로도 남길 것]
- 타임테이블의 각 줄이 몇 시인지 읽고, 그 시간대에 칠해진 과목과 분을 hourly에 넣는다.
- hour 는 24시간제 정수(오전 9시=9, 오후 1시=13, 오후 9시=21, 자정=0, 새벽 1시=1).
- ★표에 적힌 숫자는 12시간제라 **같은 숫자가 두 번 나온다**(6~12가 오전과 저녁에 각각 등장).
  숫자만 보고 hour 를 정하지 말 것. 표는 위에서 아래로 하루가 이어지는 **하나의 연속된 시간축**이고,
  굵은 가로선이 오전 / 오후 / 저녁 구간을 나눈다. 줄의 **위치(몇 번째 구간인지)** 로 판단한다.
  새봄 플래너 표준 양식은 21줄이고 다음과 같이 대응한다:
   · 첫 구간(굵은 선 위) 6,7,8,9,10,11,12 → 6,7,8,9,10,11,12 (오전 6시~정오)
   · 둘째 구간 1,2,3,4,5 → 13,14,15,16,17 (오후)
   · 셋째 구간(마지막 굵은 선 아래) 6,7,8,9,10,11,12,1,2 → 18,19,20,21,22,23,0,1,2 (저녁~새벽)
  즉 **마지막 구간의 10·11은 오전 10·11시가 아니라 밤 22·23시**다. 이걸 오전으로 넣으면
  같은 시간대에 낮 과목과 밤 과목이 겹쳐 시간대 분석이 통째로 틀어진다. 반드시 확인할 것.
  양식이 달라 구간 구분이 없으면, 첫 줄부터 순서대로 한 시간씩 늘려가며 hour 를 매긴다.
- 한 시간대에 두 과목이 칠해져 있으면 각각 따로 항목을 만든다.
- 각 항목의 minutes 합은 subjects[].minutes 합과 일치해야 한다.
- ★hourly 합계 = 플래너에 적힌 TOTAL TIME 이어야 한다. 두 값이 다르면 **hourly 쪽이 틀린 것**이니
  덜 센 구간이 없는지(특히 반 칸만 센 줄, 밤 시간대 줄) 다시 세어 맞출 것.
  총량은 hourly 합계로 확정되므로, hourly 를 적게 세면 그 학생의 총 학습시간이 그만큼 줄어든다.
- 타임테이블이 없거나 시간대를 못 읽으면 hourly 는 빈 배열로 둔다.
- materials: 플래너에 적힌 교재·인강을 각각 하나의 항목으로 뽑을 것
  · raw 에는 **그 줄에 적힌 글자를 본 그대로** 옮길 것. 페이지·범위·번호까지 포함하고,
    맞춤법을 고치거나 아는 교재 이름으로 바꾸지 말 것 ("읽생 2회"는 "읽생 2회"이지 "유닛 2회"가 아니다).
    확실히 못 읽은 글자는 그 자리에 ? 를 넣을 것 (예: "?지엄 125~248").
  · name 은 raw 에서 페이지·범위·분량만 떼어낸 이름 (예: "자이스토리 21년 3회 26~29p" → "자이스토리",
    "화이트라벨 24~31p" → "화이트라벨", "어휘끝 34~38 암기" → "어휘끝").
    ★name 은 raw 에서 글자를 **덜어내기만** 할 수 있다. 없던 글자를 넣거나 다른 글자로 바꾸지 말 것
    ("뮤지엄"이라고 읽었으면 name 도 "뮤지엄"이다. 아는 교재 이름이 떠오른다고 "뮤지컬"로 고치지 말 것).
    summary·detail·코멘트에 그 교재를 언급할 때도 raw 에서 읽은 글자를 그대로 쓸 것.
  · kind: 문제집/교재류는 "문제집", 인터넷 강의·강좌·강사명이 드러나면 "인강"(예: 메가스터디·대성마이맥·이투스·EBS 강좌),
    학원·과외 수업이나 그 숙제·교재로 보이면 "학원"(예: "OO학원 숙제", "과외 프린트"),
    그 외 학교 부교재·자체 프린트 등은 "기타"
  · 같은 교재가 여러 번 나오면 한 번만 기록할 것`;

const PLANNER_AI_SCHEMA = {
  type: 'object',
  properties: {
    quality: { type: 'string', enum: ['우수', '양호', '보통', '부실', '판독불가'], description: '플래너 작성 상태 종합 평가' },
    summary: { type: 'string', description: '플래너 내용 요약(관리자용, 2~3문장) — 무슨 과목/교재를 얼마나 계획하고 실행했는지 + 지도할 때 알아 둘 신호 한 문장' },
    comment: { type: 'string', description: '학생에게 보여줄 코멘트(반말 3~5문장) — 오늘 플래너의 구체적 근거에 기반한 학습 진단 하나' },
    stats: {
      type: 'object',
      description: '플래너에서 읽어낸 학습 데이터 — 학습 분석 그래프의 원천',
      properties: {
        total_minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: '플래너에서 확인되는 총 학습시간(분). 확인 불가면 null' },
        planned_count: { type: 'integer', description: '계획 항목 수 (확인 불가면 0)' },
        completed_count: { type: 'integer', description: '완료 체크된 항목 수 (확인 불가면 0)' },
        subjects: {
          type: 'array',
          description: '과목별 학습 내역',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', enum: ['국어', '수학', '영어', '과학', '사회', '한국사', '제2외국어', '기타'] },
              minutes: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: '해당 과목 학습시간(분). 확인 불가면 null' },
              detail: { type: 'string', description: '교재·범위 짧은 요약 (예: 자이스토리 24~31p)' }
            },
            required: ['name', 'minutes', 'detail'],
            additionalProperties: false
          }
        },
        hourly: {
          type: 'array',
          description: '시간대별 학습 기록 — 타임테이블 색칠을 시간 단위로 분해한 것. 집중 시간대·과목 배치 분석의 원천',
          items: {
            type: 'object',
            properties: {
              hour: { type: 'integer', description: '24시간제 시각 (0~23)' },
              subject: { type: 'string', enum: ['국어', '수학', '영어', '과학', '사회', '한국사', '제2외국어', '기타'] },
              minutes: { type: 'integer', description: '그 시간대에 해당 과목을 공부한 분' }
            },
            required: ['hour', 'subject', 'minutes'],
            additionalProperties: false
          }
        },
        materials: {
          type: 'array',
          description: '플래너에 등장한 교재·인강 목록(이름만 정규화). 학년별 인기 교재 추천의 원천',
          items: {
            type: 'object',
            properties: {
              raw: { type: 'string', description: '플래너에 적힌 그대로(범위·번호 포함, 못 읽은 글자는 ?)' },
              name: { type: 'string', description: '분량·페이지를 뺀 교재/강좌 이름. 못 읽었으면 읽은 그대로 두고 지어내지 말 것' },
              kind: { type: 'string', enum: ['문제집', '인강', '학원', '기타'] },
              subject: { type: 'string', enum: ['국어', '수학', '영어', '과학', '사회', '한국사', '제2외국어', '기타'] }
            },
            required: ['raw', 'name', 'kind', 'subject'],
            additionalProperties: false
          }
        }
      },
      required: ['total_minutes', 'planned_count', 'completed_count', 'subjects', 'hourly', 'materials'],
      additionalProperties: false
    }
  },
  required: ['quality', 'summary', 'comment', 'stats'],
  additionalProperties: false
};

// 좌석 → 학생ID(uid). 좌석은 교환·재배정되지만 uid 는 학생을 따라간다.
// 검사 결과를 쓸 때 이걸 같이 넣어야 3앱이 uid 로 조회할 수 있다 — 백필은 그 시점 문서만
// 채우므로, 쓰기 경로에서 빠뜨리면 오늘 이후 기록이 조용히 조회에서 사라진다.
// ⚠️ students/{좌석} 의 uid 를 그냥 믿으면 안 된다 — 그 사이 좌석 주인이 바뀌었을 수 있어
//    이름이 어긋나면 레지스트리(students/_meta_uid_registry)의 이름 표기로 다시 찾는다.
async function plannerUid(seat, name) {
  try {
    const s = await db.collection('students').doc(String(seat)).get();
    const v = s.exists ? (s.data() || {}) : {};
    if (v.uid && (!name || !v.name || v.name === name)) return v.uid;

    if (!name) return null;
    const reg = await db.collection('students').doc('_meta_uid_registry').get();
    if (!reg.exists) return null;
    const ids = JSON.parse((reg.data() || {}).identities || '[]');
    const hit = ids.filter(i => i && (i.name === name || (i.spellings || []).includes(name)));
    // 동명이인은 두 uid 로 갈려 있다 — 좌석으로도 못 가리면 추측하지 않는다(빈 uid 가 낫다)
    if (hit.length === 1) return hit[0].uid;
    const bySeat = hit.filter(i => String(i.currentSeat) === String(seat));
    return bySeat.length === 1 ? bySeat[0].uid : null;
  } catch (e) {
    logger.warn('plannerUid 조회 실패', { seat, name, message: e.message });
    return null;
  }
}

// 같은 학생의 이전 검사 기록(최근 7건) — 코멘트의 뼈대가 '오늘 하루'가 아니라 '요즘 밸런스'라
// 여기서 주는 며칠치가 곧 코멘트의 근거다. 4건이던 것을 7건으로 늘린 이유는 "국어가 며칠째
// 뜸하다"를 말하려면 한 주가 보여야 하기 때문이다(주말이 끼면 4건은 이틀치나 마찬가지다).
// ★최근 3건은 그때 준 '코멘트'까지 함께 넣는다. 이게 없으면 모델은 매번 처음 보는 학생처럼
//   같은 지적("저녁 초반에 배치해 보자")을 무한 반복한다 — 코멘트가 형식적으로 느껴진 주된 원인.
// uid 가 있으면 uid 로 찾는다 — 좌석으로 찾으면 좌석을 물려받은 학생이 이전 주인의 학습이력을
// 자기 것으로 프롬프트에 받게 된다(모델이 남의 기록과 비교하며 코멘트를 쓴다).
async function plannerAiHistory(seat, beforeDate, uid) {
  try {
    const hs = uid
      ? await db.collection('planner_ai_reviews').where('uid', '==', uid).get()
      : await db.collection('planner_ai_reviews').where('seat', '==', seat).get();
    const list = hs.docs.map(d => d.data())
      .filter(v => v.status === 'done' && v.date && v.date < beforeDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 7);
    if (!list.length) return '';
    // 선생님이 교정한 수치(statsFixed)가 있으면 그걸 쓴다 — 틀린 판독으로 "어제보다 줄었다"는
    // 엉뚱한 비교를 하지 않도록, 이력의 기준도 분석 화면과 같은 교정본이어야 한다.
    const stOf = h => h.statsFixed || h.stats || {};
    const lines = list.map((h, i) => {
      const st = stOf(h);
      const subj = (st.subjects || []).map(s => s.name + (s.minutes != null ? ` ${s.minutes}분` : '')).join(', ');
      const parts = [h.quality || ''];
      if (st.total_minutes != null) parts.push(`총 ${st.total_minutes}분`);
      if (subj) parts.push(subj);
      // 요일을 붙인다 — 평일은 학교에 있어 총량이 적은 게 정상이라, 요일 없이 숫자만 보면
      // 주말과 평일을 같은 선에서 비교하며 "줄었다"고 말한다.
      const dow = '일월화수목금토'[new Date(h.date).getDay()] || '';
      // 날짜별 교재 목록은 일부러 넣지 않는다 — 아래 [교재별 마지막 등장] 블록이 같은 정보를
      // 훨씬 짧게 담고 있어서, 여기 또 적으면 매 요청 400자쯤을 중복으로 돈 내고 보내게 된다.
      // "며칠째 안 보인다" 판정에 필요한 건 마지막 등장일이지 날짜별 전체 목록이 아니다.
      // 오래된 날은 summary 도 뺀다. 4일 전보다 이전 기록은 밸런스 누적에만 쓰이는데,
      // summary 가 한 건에 300자를 넘어 7일치를 다 넣으면 매 요청 user 메시지가 5천 자를 넘는다
      // (시스템 프롬프트와 달리 여기는 캐시가 안 걸려 전액 과금된다).
      let line = `- ${h.date}(${dow}): ${parts.filter(Boolean).join(', ')}`;
      if (i < 4 && h.summary) line += ` — ${h.summary}`;
      if (i < 3 && h.comment) line += `\n  · 그날 준 코멘트: "${String(h.comment).slice(0, 400)}"`;
      return line;
    });

    // ── 과목별 누적 — 밸런스 판단의 근거 ──
    // 날짜별 숫자만 주고 모델에게 더하게 하면 틀린다(합계를 잘못 세는 실수가 반복돼 왔다).
    // 여기서 계산해 준 이 값이 "요즘 국어가 뜸하다" 같은 말의 유일한 근거다.
    const agg = {};
    for (const h of list) {
      for (const s of (stOf(h).subjects || [])) {
        if (!s || !s.name) continue;
        const a = agg[s.name] || (agg[s.name] = { min: 0, days: 0, last: '' });
        a.min += (s.minutes || 0);
        a.days += 1;
        if (h.date > a.last) a.last = h.date;
      }
    }
    // 국·수·영은 안 한 것도 정보이므로 0이어도 반드시 적는다. 탐구·제2외국어는 학생마다 선택이라
    // 한 번이라도 나온 것만 적는다 — 아예 안 하는 과목을 "며칠째 없다"고 짚으면 헛다리다.
    const CORE = ['국어', '수학', '영어'];
    const aggLines = [...CORE, ...Object.keys(agg).filter(n => !CORE.includes(n))].map(n => {
      const a = agg[n];
      return a
        ? `- ${n}: 총 ${a.min}분 / ${list.length}일 중 ${a.days}일, 마지막 ${a.last}`
        : `- ${n}: 최근 ${list.length}일 기록 없음`;
    });

    // ── 교재별 마지막 등장일 ── "그 단어장이 며칠째 안 보인다"를 말하려면 이게 있어야 한다.
    // 같은 교재라도 날마다 표기가 흔들린다("문학체화서" / "문학 체화서" / "수완 윤사" / "윤사 수완").
    // 그대로 세면 한 교재가 여러 줄로 갈라져 매일 쓴 교재가 "1일, 마지막 8-07"처럼 보이고,
    // 그걸 근거로 "며칠째 안 보인다"고 하면 학생 눈에는 틀린 말이 된다. 공백·쉼표·중점을 지운
    // 키로 묶고, 표시 이름은 가장 최근에 쓴 표기를 쓴다. 오탈자(체화/체회)까지는 못 묶으므로
    // 프롬프트에서 "비슷한 이름은 같은 교재로 볼 것"이라고 한 번 더 일러 둔다.
    const matKey = n => String(n).replace(/[\s,·、]/g, '').toLowerCase();
    const matAgg = {};
    for (const h of list) {
      for (const m of (stOf(h).materials || [])) {
        if (!m || !m.name) continue;
        const k = matKey(m.name);
        if (!k) continue;
        const a = matAgg[k] || (matAgg[k] = { days: 0, last: '', label: m.name, subject: m.subject || '' });
        a.days += 1;
        if (h.date > a.last) { a.last = h.date; a.label = m.name; }   // 최근 표기를 대표로
        if (!a.subject && m.subject) a.subject = m.subject;
      }
    }
    const matLines = Object.values(matAgg)
      .sort((a, b) => (a.last < b.last ? 1 : -1))
      .slice(0, 15)
      .map(a => `- ${a.label}${a.subject ? `(${a.subject})` : ''}: ${a.days}일, 마지막 ${a.last}`);

    return '\n\n[이전 검사 기록 — 최근순]\n' + lines.join('\n') +
      '\n※ 위 코멘트에서 이미 한 지적·제안은 되풀이하지 말 것. 그 제안을 오늘 실행한 흔적이 보이면 그것부터 짚을 것.' +
      `\n\n[최근 ${list.length}일 과목별 누적 — 밸런스 판단의 근거]\n` + aggLines.join('\n') +
      '\n※ 오늘치는 여기 안 들어 있다. 이미 계산해 둔 값이니 다시 더하지 말고 그대로 쓸 것.' +
      (matLines.length
        ? `\n\n[최근 ${list.length}일 교재별 마지막 등장]\n` + matLines.join('\n') +
          '\n※ 며칠째 안 보이는 교재를 찾는 데 쓸 것. 다만 학생이 날마다 이름을 조금씩 다르게 적어서' +
          ' 같은 교재가 두 줄로 갈라져 있을 수 있다("문학체화서"와 "문학 체화서"는 같은 책이다).' +
          ' 이름이 비슷하면 같은 교재로 보고, 갈라져 보이는 것을 근거로 "며칠째 안 했다"고 하지 말 것.' +
          '\n※ 글씨 대조용 단서이기도 하다 — 다만 목록에 있다는 이유로 오늘 글씨를 그 이름으로 단정하지는 말 것.'
        : '');
  } catch (e) {
    logger.warn('plannerAiHistory 조회 실패', { seat, message: e.message });
    return '';
  }
}

// 학년(students.grade)은 조언의 방향을 가른다 — 고3의 7월과 고1의 7월에 할 말은 다르다.
// 좌석키가 곧 students 문서 ID다(seatKey = 좌석 숫자).
const SUNEUNG_DATE = '2026-11-19';   // 2027학년도 수능 — 해마다 갱신할 것
async function plannerAiStudentCtx(seat, dateStr) {
  const bits = [];
  try {
    const s = await db.collection('students').doc(String(seat)).get();
    const v = s.exists ? (s.data() || {}) : {};
    if (v.grade) bits.push(`학년: ${v.grade}`);
    if (v.grade === '고3') {
      const dday = Math.round((new Date(SUNEUNG_DATE) - new Date(dateStr)) / 86400000);
      if (dday > 0) bits.push(`수능까지 D-${dday}`);
    }
    if (v.weeklyGoalH) bits.push(`주간 순공 목표: ${v.weeklyGoalH}시간`);
    // 개학한 학생은 평일 오전(1~6교시)이 x(개학)으로 면제돼 있다(scripts/apply-school-start.js가
    // schedule_base·schedules·students 세 곳에 같이 쓴다). 이 표식이 있으면 평일 낮에 학교에 있는
    // 것이 확실하므로 모델에게 알려 준다 — 안 알려 주면 빈 오전을 "시작이 늦었다"고 지적한다.
    // 표식이 없다고 미개학이라는 뜻은 아니다(아직 면제 처리를 안 했을 수 있다). 그래서 있을 때만
    // 넣고, 없을 때는 프롬프트가 플래너 근거로 판단하게 둔다.
    if (['월', '화', '수', '목', '금'].some(d => /개학/.test(String(v[d] || '')))) {
      bits.push('평일 오전은 학교 수업(면학관 오전 면제) — 자습은 방과 후부터');
    }
  } catch (e) {
    logger.warn('plannerAiStudentCtx 조회 실패', { seat, message: e.message });
  }
  return bits.length ? ' / ' + bits.join(' / ') : '';
}

// 모델은 타임테이블 칸은 제대로 세면서도 subjects[].minutes 합계를 작게 적는 일이 반복된다
// (11번 7/23 실측: hourly 750분인데 subjects 합 510분, 재검사해도 재발).
// 프롬프트로 "합을 맞춰라"는 안 먹혀서, 색칠에서 직접 센 hourly를 기준으로 코드에서 맞춘다.
// 학습분석 탭의 과목별 시간·총량이 전부 subjects에서 나오므로 여기가 어긋나면 그래프가 통째로 틀어진다.
function reconcilePlannerStats(st, ctx) {
  if (!st || !Array.isArray(st.hourly) || !st.hourly.length) return st;
  const byS = {};
  for (const h of st.hourly) {
    const m = Number(h && h.minutes) || 0;
    if (!h || !h.subject || m <= 0) continue;
    byS[h.subject] = (byS[h.subject] || 0) + m;
  }
  if (!Object.keys(byS).length) return st;

  // ⚠️모델이 같은 과목을 여러 줄로 쪼개 내놓는 일이 있다(계획 항목이 여러 개일 때).
  // 아래에서 이름이 같은 항목마다 그 과목의 '전체 합계'를 넣으므로, 중복을 안 합치면
  // 총량이 과목 수만큼 곱해진다(2026-07-24 정시우 7/23: 국어 3줄 → 570분이 1530분으로).
  const merged = [];
  for (const s of (Array.isArray(st.subjects) ? st.subjects : [])) {
    const hit = merged.find(x => x.name === s.name);
    if (!hit) { merged.push({ ...s }); continue; }
    hit.minutes = (Number(hit.minutes) || 0) + (Number(s.minutes) || 0);
    if (s.detail && hit.detail !== s.detail) hit.detail = [hit.detail, s.detail].filter(Boolean).join(' / ');
  }
  const subs = merged;
  const before = subs.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  for (const s of subs) if (byS[s.name] != null) s.minutes = byS[s.name];
  // 색칠에는 있는데 과목 목록에서 빠진 과목도 살려 둔다(그래프에서 통째로 사라지는 것 방지)
  for (const [name, m] of Object.entries(byS)) {
    if (!subs.some(s => s.name === name)) subs.push({ name, minutes: m, detail: '' });
  }
  const after = subs.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  st.subjects = subs;
  st.total_minutes = after;          // 총량도 과목 합계와 항상 같게 둔다
  if (Math.abs(after - before) > 30) {
    logger.warn('stats 합계 보정', { ...ctx, before, after });
  }
  return st;
}

// ── 검사 요청 구성·결과 기록 공용 헬퍼 ──
// 실시간 검사(plannerAiReview)와 밤 배치 검사가 이 헬퍼들을 똑같이 쓴다.
// 검사 품질을 결정하는 건 모델·프롬프트·사진 구성 셋뿐이므로, 여기가 같으면
// 배치 검사도 실시간과 정확도가 동일하다 — 다른 건 Batch API 반값 요금뿐.

async function plannerAiConfig() {
  const cfgSnap = await db.collection('ai_config').doc('planner').get();
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  return { model: cfg.model || PLANNER_AI_MODEL, sysPrompt: cfg.prompt || PLANNER_AI_PROMPT };
}

// 실시간·배치 공통 요청 옵션.
// max_tokens 2048 이면 hourly 항목이 20개를 넘는 날 응답이 중간에 잘려
// "Unterminated string in JSON" 으로 검사 자체가 실패한다(2026-07-24 윤지호 7/23).
// 생성한 만큼만 과금되므로 넉넉히 잡는다.
// max_tokens 를 16000으로 둔 것은 상한일 뿐이라 안 쓰면 과금되지 않는다. 사고를 켜면
//   max_tokens 는 사고와 답변의 합에 걸리므로 이 여유가 필요해진다(4096이면 사고하다
//   JSON 이 잘려 위 사고가 재현된다). 지금은 사고가 꺼져 있지만 켤 때를 대비해 남겨 둔다.
// thinking: ★반드시 명시할 것. Opus 4.8 은 이 필드를 빼면 사고를 안 했지만 Opus 5 는
//   빼면 사고를 한다. 빼 두면 모델 문자열만 바꿔도 사고 토큰이 출력 요금($25/1M)으로
//   붙어 비용이 조용히 오른다. 여기서 끈 이유는 비용을 Opus 4.8 과 똑같이 유지하기
//   위해서다 — 끈 상태의 Opus 5 는 토큰 단가가 4.8 과 같아서 모델 업그레이드 자체는
//   추가 비용이 0이다.
//   ※켜려면 { type: 'adaptive' }. 타임테이블 색칠 칸을 잘못 세는 고질적 오류에는 사고가
//     도움이 될 가능성이 크지만, 사고 토큰이 얼마나 나오는지 usage 필드로 실측한 뒤에
//     판단할 것. 켜면 effort 도 함께 내려야 값이 안 튄다('medium' 부터).
// effort: disabled 와 함께 쓸 때는 'high' 이하여야 한다 — Opus 5 는 disabled + xhigh/max
//   조합을 400으로 거부한다. 'high' 가 기본값이라 동작은 그대로지만 명시해 둔다.
// 시스템 프롬프트(1만4천자 남짓)는 매 건 완전히 동일해서 캐싱하면 1/10 값이 된다
// (실시간 검사는 concurrency:1 순차 실행이라 앞 건이 5분 캐시를 데워 주고,
//  배치도 같은 프롬프트가 몰리므로 적중 가능성이 있다 — 50% 할인과 별도로 겹쳐 적용).
// ※system 은 문자열이면 cache_control 을 못 붙이므로 블록 배열로 넘긴다.
function plannerAiRequestParams(model, sysPrompt, content) {
  return {
    model,
    max_tokens: 16000,
    thinking: { type: 'disabled' },
    system: [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: PLANNER_AI_SCHEMA } },
    messages: [{ role: 'user', content }]
  };
}

// sharp(libvips)가 failOn:'none'으로도 못 여는 잘린 JPEG를 순수 JS 디코더로 복원한다.
// 폰 카메라 JPEG는 재시작(RST) 마커 구간이라, 업로드가 중간에 끊기면 libvips는 어느
// 지점에서 잘라도 디코드를 거부한다(2026-07-30 좌석 28 실파일로 확인 — PIL·jpeg-js는 성공).
// 마지막 RST 마커에서 잘라 EOI를 붙이면 jpeg-js 관용 모드가 디코드된 부분까지 살린다
// (못 받은 아랫부분만 회색으로 남고 나머지는 온전 — 같은 실파일에서 3000x4000 전체 복원).
async function salvageTruncatedJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG가 아님');
  let i = buf.length - 2;
  while (i > 2 && !(buf[i] === 0xff && buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7)) i--;
  if (i <= 2) throw new Error('복원 지점(RST 마커)이 없음');
  const cut = Buffer.concat([buf.subarray(0, i), Buffer.from([0xff, 0xd9])]);
  const raw = jpegjs.decode(cut, { tolerantDecoding: true, useTArray: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 100 });
  // jpeg-js는 EXIF 방향 태그를 무시한다 — 헤더는 잘린 파일에서도 온전하므로 sharp로 읽어 반영
  let orientation = 1;
  try { orientation = (await sharp(buf).metadata()).orientation || 1; } catch (_) { /* 태그 없으면 그대로 */ }
  const angle = { 3: 180, 6: 90, 8: 270 }[orientation] || 0;
  return sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.length),
      { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .rotate(angle).jpeg({ quality: 92 }).toBuffer();
}

// 사진 다운로드 → 전처리(축소·확대본) → 메시지 content 조립
async function buildPlannerAiUserContent(seat, dateStr, name, url, uid) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`사진 다운로드 실패 (HTTP ${res.status})`);
  let buf = Buffer.from(await res.arrayBuffer());
  let mediaType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];

  // 요즘 폰 사진은 10MB를 예사로 넘는데 Claude API 이미지 상한이 10MB다(2026-07-21 23번 실패).
  // 미리 줄이면 용량·메모리·비용·지연이 모두 줄어든다.
  // ⚠️ .rotate()는 생략 금지 — sharp는 출력 시 EXIF를 버리므로, 방향 태그를 미리 픽셀에
  //    반영해 두지 않으면 오히려 눕거나 뒤집힌 사진이 모델에 전달된다.
  const tiles = [];   // 계획표·메모 확대본(전체 사진 뒤에 함께 보낸다)
  try {
    // failOn:'none' — 업로드가 중간에 끊겨 잘린 JPEG도 디코드된 부분까지 살려서 진행한다.
    // 손상 원본이 그대로 API로 가면 API가 디코드하지 못해 배치 검사가 영구 실패한다
    // (2026-07-30 좌석 28, "VipsJpeg: Premature end of input file").
    // 그래도 못 열면(재시작 마커 JPEG의 절단은 libvips가 아예 거부) jpeg-js로 복원한다.
    let norm;   // EXIF 반영한 고해상 원본
    try {
      norm = await sharp(buf, { failOn: 'none' }).rotate().toBuffer();
    } catch (e1) {
      norm = await salvageTruncatedJpeg(buf);
      logger.warn('사진 손상 — jpeg-js로 복원해 진행', { seat, date: dateStr, message: e1.message });
    }
    const meta = await sharp(norm).metadata();
    const W = meta.width || 0, H = meta.height || 0;

    // 세로로 긴 A4 플래너일 때만 확대본을 만든다(양식이 고정: 왼쪽 위 계획표, 왼쪽 아래 메모).
    // 왜 굳이 잘라 보내나: API는 긴 변을 1568px로 맞추므로 세로로 긴 전체 사진을 보내면
    // 가로 해상도가 1176px밖에 안 남아 작은 손글씨(교재명·문항번호)가 뭉갠다.
    // 가로세로 비가 1에 가까운 조각으로 자르면 같은 1568px 안에 글자가 2배 크게 담긴다.
    if (W > 1600 && H > 1600 && H > W) {
      const cut = async (x0, y0, x1, y1) => sharp(norm, { failOn: 'none' })
        .extract({
          left: Math.round(W * x0), top: Math.round(H * y0),
          width: Math.round(W * (x1 - x0)), height: Math.round(H * (y1 - y0))
        })
        .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 }).toBuffer();
      tiles.push(await cut(0.02, 0.12, 0.62, 0.62));   // 계획표(과목·내용·확인)
      tiles.push(await cut(0.02, 0.50, 0.62, 0.92));   // 못한 것·메모·한마디
    }

    // 전체 사진은 모델이 그대로 받는 최대 해상도(긴 변 2576px)로 보낸다.
    // 예전엔 상한이 1568px이라 그 값으로 줄였는데, 지금 모델은 2576px까지 축소 없이 본다.
    // 타임테이블은 확대본이 따로 없어(확대본 2장은 왼쪽 계획표·메모 전용, 그것도 세로 사진일 때만)
    // 이 전체 사진 한 장으로 칸을 세야 한다. 1568px로 줄이면 표가 작아져 30분/60분 칸 구분이
    // 뭉개지고, 같은 플래너를 재검사할 때마다 총량이 100분씩 달라지는 원인이 됐다(2026-07-24).
    // 크기와 무관하게 항상 이 재인코딩본을 보낸다 — 예전엔 2576px·4MB 이하면 원본을
    // 그대로 보냈는데, 그 구멍으로 '작은' 손상 파일이 재인코딩 없이 나가면 위의 관용
    // 디코드가 무의미해진다(withoutEnlargement라 작은 사진 해상도는 그대로다).
    buf = await sharp(norm, { failOn: 'none' })
      .resize({ width: 2576, height: 2576, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer();
    mediaType = 'image/jpeg';
  } catch (e) {
    logger.warn('사진 전처리 실패 — 원본으로 진행', { seat, date: dateStr, message: e.message });
  }
  // 상한 10MB는 base64 문자열 길이 기준이다(원본 7.9MB가 base64로 10.5MB가 되어 거부됐음).
  // 원본 바이트로 재면 통과할 것처럼 보이니 주의.
  const b64 = buf.toString('base64');
  if (b64.length > 10 * 1024 * 1024) throw new Error('사진이 너무 큽니다 — 축소 후에도 10MB를 넘습니다');

  const [history, stuCtx] = await Promise.all([
    plannerAiHistory(seat, dateStr, uid),
    plannerAiStudentCtx(seat, dateStr)
  ]);

  return [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
    ...tiles.map(t => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: t.toString('base64') } })),
    { type: 'text', text: `학생: ${name || seat + '번'}${stuCtx} / 학습일: ${dateStr}(${'일월화수목금토'[new Date(dateStr).getDay()]})` +
      (tiles.length ? `\n사진 ${tiles.length + 1}장: 1) 플래너 전체 2) 왼쪽 위(계획표) 확대 3) 왼쪽 아래(메모) 확대 — 글자는 확대본으로 읽을 것.` : '') +
      `\n이 플래너를 검사하고 결과를 작성해 주세요.${history}` }
  ];
}

// 모델 응답 → planner_ai_reviews 문서 기록 (extra: 배치가 billing 표식·uid 등을 얹는다)
// ⚠️ 이 함수는 문서를 통째로 교체(set)한다 — extra.uid 를 안 넘기면 '검사 중'에 넣어 둔 uid 가
//    결과 기록에서 날아간다. 그래서 이전 문서의 uid 를 항상 이월한다(아래 keep).
async function writePlannerAiResult(reviewRef, seat, dateStr, name, model, msg, extra) {
  if (msg.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 못했습니다(refusal)');
  const text = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const out = JSON.parse(text);
  // 사람이 교정한 수치(statsFixed)는 재검사가 와도 지우지 않는다 — 교정은 사진을 직접
  // 본 사람의 확정값이라, 새 판독이 그걸 덮으면 학습분석이 도로 틀어진다.
  // (문서 전체를 교체(set)하는 방식은 유지하되 이 필드만 이월한다)
  let keep = {}, prevComment = '';
  try {
    const prev = await reviewRef.get();
    if (prev.exists) {
      const p = prev.data() || {};
      if (p.statsFixed) keep = { statsFixed: p.statsFixed, statsFixedAt: p.statsFixedAt || null };
      if (p.uid) keep.uid = p.uid;
      prevComment = p.comment || '';
    }
  } catch (e) { logger.warn('statsFixed 이월 실패 — 새 결과만 기록', { seat, date: dateStr, message: e.message }); }

  // 스키마가 comment를 required로 걸어도 모델이 빈 문자열을 내는 일이 실제로 있다
  // (2026-07-29 확인: 실산출 253건 중 5건, 전부 실시간 경로). 이걸 그대로 쓰면 문서를 통째
  // 교체(set)하는 구조라 **직전에 잘 나온 코멘트가 빈 값으로 지워진다** — 재검사를 눌렀다가
  // 코멘트만 사라지는 게 이 경로다(백도윤 7/27 실사례). 새 코멘트가 비면 이전 것을 남긴다.
  let comment = (out.comment || '').trim();
  if (!comment) {
    comment = prevComment;
    logger.warn('코멘트가 비어서 나옴', { seat, date: dateStr, 이전코멘트유지: !!prevComment, output: msg.usage.output_tokens });
  }

  await reviewRef.set({
    ...keep,
    seat, date: dateStr, name: name || null,
    status: 'done',
    quality: out.quality, summary: out.summary, comment,
    stats: reconcilePlannerStats(out.stats, { seat, date: dateStr }) || null,
    model,
    // cacheRead 가 0 이면 캐싱이 안 먹고 있는 것(프롬프트가 바뀌었거나 캐시가 식은 뒤 온 요청)
    usage: {
      input: msg.usage.input_tokens, output: msg.usage.output_tokens,
      cacheWrite: msg.usage.cache_creation_input_tokens || 0,
      cacheRead: msg.usage.cache_read_input_tokens || 0
    },
    doneAt: new Date().toISOString(),
    ...(extra || {})
  });
  return out;
}

exports.plannerAiReview = onDocumentCreated(
  // concurrency:1 필수 — 기본값 80이면 "전체 검사" 20여건이 한 인스턴스에 몰려
  // 사진 Buffer+base64가 겹쳐 OOM으로 컨테이너가 통째로 죽는다(catch/finally도 못 돌아
  // 요청 문서가 남고 리뷰가 running에서 멈춤). 2026-07-21 실제 사고.
  { document: 'planner_ai_requests/{id}', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 300, memory: '1GiB', concurrency: 1 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const req = snap.data() || {};
    const seat = req.seat, dateStr = req.date;
    const reviewRef = db.collection('planner_ai_reviews').doc(`${seat}_${dateStr}`);
    try {
      if (!seat || !dateStr) throw new Error('seat/date 누락');

      // 사진 URL은 학생앱이 planners/{좌석}_{날짜} 문서에 넣어둔 다운로드 URL을 그대로 쓴다(Storage SDK 불필요)
      const pSnap = await db.collection('planners').doc(`${seat}_${dateStr}`).get();
      const url = pSnap.exists ? (pSnap.data() || {}).url : null;
      if (!url) throw new Error('제출된 플래너 사진이 없습니다');

      const uid = await plannerUid(seat, req.name);
      await reviewRef.set({ seat, date: dateStr, name: req.name || null, ...(uid ? { uid } : {}), status: 'running', startedAt: new Date().toISOString() }, { merge: true });

      // 모델/프롬프트 덮어쓰기(선택) — ai_config/planner { model, prompt }
      const { model, sysPrompt } = await plannerAiConfig();
      const content = await buildPlannerAiUserContent(seat, dateStr, req.name, url, uid);

      const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
      const msg = await client.messages.create(plannerAiRequestParams(model, sysPrompt, content));

      const out = await writePlannerAiResult(reviewRef, seat, dateStr, req.name, model, msg, uid ? { uid } : null);
      logger.info('plannerAiReview 완료', { seat, date: dateStr, quality: out.quality });
    } catch (e) {
      logger.error('plannerAiReview', { seat, date: dateStr, message: e.message });
      await reviewRef.set({ seat: seat || null, date: dateStr || null, status: 'error', error: e.message, doneAt: new Date().toISOString() }, { merge: true });
    } finally {
      await snap.ref.delete().catch(() => {});   // 요청 문서는 1회용 — 처리 후 정리
    }
  }
);

// ══════════════════════════════════════
// 📓🌙 플래너 밤 배치 검사 — Batch API (토큰 요금 50%)
// ══════════════════════════════════════
// 전원 자동 검사는 아침에 결과만 있으면 되는 작업이라 실시간일 필요가 없다.
// Batch API는 같은 모델·프롬프트·사진 구성(위 공용 헬퍼)으로 요금만 절반이고
// 보통 1시간 내 완료된다(최대 24시간 보장). 관리앱의 개별 '다시 검사' 버튼은
// 기존 실시간 경로(plannerAiReview) 그대로라 급한 재검사도 여전히 가능하다.
//
// 흐름: 접수(02:10·12:10 KST) → planner_ai_batches/{batchId} 문서로 추적
//       → 수거(10분마다 폴링, 완료되면 학생별 리뷰 문서 기록).
//   · 02:10 — 정시 마감(02:00) 직후, 어제 학습분 전체 접수
//   · 12:10 — 지각 마감(12:00) 직후, 그 사이 새로 낸 지각 제출분만 추가 접수
//   · 이미 done인 검사는 건너뛰되, 검사 후 사진이 교체됐으면(updatedAt > doneAt) 다시 검사

function kstYesterday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);   // KST 벽시계
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function runPlannerBatchSubmit(label) {
  const ds = kstYesterday();
  const { model, sysPrompt } = await plannerAiConfig();
  const psnap = await db.collection('planners').where('date', '==', ds).get();
  if (psnap.empty) { logger.info('plannerBatch 접수 — 제출 없음', { ds, label }); return; }

  // 검사 대상 선별 — 진행 중이거나 이미 현재 사진으로 검사된 학생은 제외
  const targets = [];
  for (const doc of psnap.docs) {
    const v = doc.data() || {};
    if (!v.seat || !v.url) continue;
    const rSnap = await db.collection('planner_ai_reviews').doc(`${v.seat}_${ds}`).get();
    if (rSnap.exists) {
      const r = rSnap.data() || {};
      if (r.status === 'running') continue;
      if (r.status === 'done' && !(v.updatedAt && r.doneAt && v.updatedAt > r.doneAt)) continue;
    }
    targets.push(v);
  }
  if (!targets.length) { logger.info('plannerBatch 접수 — 새 대상 없음', { ds, label }); return; }

  // ★한 번에 몇 명씩 묶어 보내는가 = 이 함수의 메모리 상한이다.
  // 사진 한 장을 준비하면 base64 문자열이 요청 배열에 그대로 남는데(플래너 1건당 확대본까지
  // 3장, 1~2MB), 전원을 한 배치에 담으면 그 배열 + 그걸 직렬화한 요청 본문이 동시에 메모리에
  // 올라간다. 2026-07-29 02:11 실제로 37명분에서 1034MiB로 OOM이 나 그날 검사가 통째로 날아갔다
  // (43명이던 전날은 아슬아슬하게 통과 — 한계선에서 돌고 있었던 것).
  // → 조각으로 나눠 "준비 → 전송 → 배열 비우기"를 반복한다. 학생 수가 늘어도 상한이 안 오른다.
  // 수거(plannerBatchCollect)는 원래 pending 배치를 여러 건 처리하므로 그대로 동작한다.
  const CHUNK = 10;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
  let submitted = 0, skipped = 0;
  const batchIds = [];

  for (let i = 0; i < targets.length; i += CHUNK) {
    let requests = [], names = {}, uids = {};
    for (const v of targets.slice(i, i + CHUNK)) {
      try {
        const cid = `${v.seat}_${ds}`;
        // uid 는 접수 시점에 확정해 배치 문서에 함께 남긴다 — 수거는 몇 시간 뒤라
        // 그 사이 좌석이 바뀌면 그때 좌석으로 다시 찾은 uid 는 남의 것일 수 있다.
        const uid = await plannerUid(v.seat, v.name);
        const content = await buildPlannerAiUserContent(v.seat, ds, v.name, v.url, uid);
        requests.push({ custom_id: cid, params: plannerAiRequestParams(model, sysPrompt, content) });
        names[cid] = v.name || null;
        if (uid) uids[cid] = uid;
      } catch (e) {
        skipped++;
        logger.warn('plannerBatch 대상 준비 실패 — 건너뜀', { seat: v.seat, ds, message: e.message });
      }
    }
    if (!requests.length) continue;

    try {
      const batch = await client.messages.batches.create({ requests });
      await db.collection('planner_ai_batches').doc(batch.id).set({
        status: 'pending', date: ds, label, model, count: requests.length, names, uids,
        createdAt: new Date().toISOString()
      });
      // 관리앱에 '검사 중' 표시
      await Promise.all(requests.map(r => {
        const cut = r.custom_id.lastIndexOf('_');
        const uid = uids[r.custom_id];
        return db.collection('planner_ai_reviews').doc(r.custom_id).set(
          { seat: r.custom_id.slice(0, cut), date: ds, name: names[r.custom_id], ...(uid ? { uid } : {}), status: 'running', startedAt: new Date().toISOString() },
          { merge: true });
      }));
      submitted += requests.length;
      batchIds.push(batch.id);
    } catch (e) {
      // 한 조각이 실패해도 나머지는 보낸다 — 전원이 통째로 날아가는 게 제일 나쁘다
      skipped += requests.length;
      logger.error('plannerBatch 조각 전송 실패', { ds, label, from: i, count: requests.length, message: e.message });
    }
    requests = null; names = null; uids = null;   // 다음 조각을 준비하기 전에 사진 데이터를 놓아준다
  }

  if (!submitted) { logger.error('plannerBatch 접수 실패 — 보낸 건이 없음', { ds, label, skipped }); return; }
  logger.info('plannerBatch 접수 완료', { ds, label, count: submitted, skipped, batches: batchIds.length, batchIds });
}

// memory 2GiB — 조각내기(CHUNK)로 상한은 잡았지만, 사진 한 장 디코드가 수십 MB라 여유가
// 필요하다. 1GiB에서 OOM으로 하루치 검사가 통째로 날아간 적이 있다(2026-07-29).
exports.plannerBatchNight = onSchedule(
  { schedule: '10 2 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 540, memory: '2GiB', maxInstances: 1 },
  async () => { try { await runPlannerBatchSubmit('night'); } catch (e) { logger.error('plannerBatchNight', { message: e.message }); } }
);
exports.plannerBatchNoon = onSchedule(
  { schedule: '10 12 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 540, memory: '2GiB', maxInstances: 1 },
  async () => { try { await runPlannerBatchSubmit('noon'); } catch (e) { logger.error('plannerBatchNoon', { message: e.message }); } }
);

// ══════════════════════════════════════
// 📓🚨 검사 누락 감시 — 예약 배치가 통째로 실패해도 스스로 메운다
// ══════════════════════════════════════
// 2026-07-29에 밤 배치가 OOM으로 죽어 하루치 37명 검사가 전부 날아갔는데, 아무도 몰랐다.
// 원장이 다음 날 특정 학생 코멘트가 없는 걸 보고서야 발견했다. OOM 자체는 막았지만
// (조각 접수), '조용히 실패하는 구조'가 남아 있으면 다른 원인으로 같은 일이 반복된다.
// 그래서 마감이 다 지난 뒤 한 번 더 대조해서 ①메우고 ②상태를 밖에서 보이게 남긴다.
//
//  · 13:10 / 16:10 KST — 지각 마감(12:00)과 낮 배치(12:10)가 끝난 뒤라 그날 제출은 확정
//  · 'running'에 3시간 넘게 멈춘 리뷰는 풀어 준다 — 안 풀면 재접수 대상에서 영구 제외된다
//    (runPlannerBatchSubmit이 running을 건너뛰므로)
//  · 결과는 settings/planner_ai_health 에 남긴다. settings는 규칙상 read 개방이라
//    관리앱이 규칙 수정 없이 바로 읽을 수 있다(rules 배포는 수동이라 피하고 싶은 작업).
const PLANNER_STUCK_MS = 3 * 3600 * 1000;

async function runPlannerAiWatchdog(label) {
  const ds = kstYesterday();
  const healthRef = db.collection('settings').doc('planner_ai_health');

  const [psnap, rsnap] = await Promise.all([
    db.collection('planners').where('date', '==', ds).get(),
    db.collection('planner_ai_reviews').where('date', '==', ds).get()
  ]);

  const status = {};   // 좌석 → 검사 상태
  const startedAt = {};
  rsnap.forEach(d => { const v = d.data() || {}; if (v.seat) { status[String(v.seat)] = v.status || null; startedAt[String(v.seat)] = v.startedAt || null; } });

  // ① 멈춘 'running' 해제 — 접수는 됐는데 결과가 끝내 안 온 건
  let unstuck = 0;
  for (const seat of Object.keys(status)) {
    if (status[seat] !== 'running') continue;
    const t = Date.parse(startedAt[seat] || '');
    if (!t || Date.now() - t < PLANNER_STUCK_MS) continue;
    await db.collection('planner_ai_reviews').doc(`${seat}_${ds}`).set(
      { status: 'error', error: '검사가 시간 안에 끝나지 않았습니다 — 다시 접수합니다', doneAt: new Date().toISOString() },
      { merge: true });
    status[seat] = 'error';
    unstuck++;
  }

  // ② 제출했는데 done이 아닌 학생 세기
  const seats = [];
  psnap.forEach(d => { const v = d.data() || {}; if (v.seat && v.url) seats.push(String(v.seat)); });
  const missing = seats.filter(s => status[s] !== 'done');

  // ③ 먼저 기록한다 — 아래 재접수가 또 죽더라도 "몇 건이 비었는지"는 남아야 한다
  const base = {
    date: ds, checkedAt: new Date().toISOString(), label,
    submitted: seats.length, done: seats.length - missing.length,
    missing: missing.length, missingSeats: missing.slice(0, 60), unstuck
  };
  await healthRef.set(base);

  if (!missing.length) {
    logger.info('plannerAiWatchdog 이상 없음', { ds, label, submitted: seats.length });
    return;
  }

  logger.warn('plannerAiWatchdog 검사 누락 — 재접수', { ds, label, missing: missing.length, unstuck, seats: missing });
  try {
    await runPlannerBatchSubmit(`watchdog-${label}`);
    await healthRef.set({ ...base, resubmittedAt: new Date().toISOString() });
  } catch (e) {
    await healthRef.set({ ...base, resubmitError: e.message });
    logger.error('plannerAiWatchdog 재접수 실패', { ds, label, message: e.message });
  }
}

exports.plannerAiWatchdog = onSchedule(
  { schedule: '10 13,16 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 540, memory: '2GiB', maxInstances: 1 },
  async () => { try { await runPlannerAiWatchdog('watchdog'); } catch (e) { logger.error('plannerAiWatchdog', { message: e.message }); } }
);

// 수거 — pending 배치가 있을 때만 API를 조회하므로 평상시 비용은 Firestore 읽기 1회뿐
exports.plannerBatchCollect = onSchedule(
  { schedule: 'every 10 minutes', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 300, maxInstances: 1 },
  async () => {
    // 접수가 조각으로 나뉘므로(CHUNK=10) 하루치가 여러 건이다 — 한 번에 다 수거되게 넉넉히
    const pend = await db.collection('planner_ai_batches').where('status', '==', 'pending').limit(20).get();
    if (pend.empty) return;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    for (const bdoc of pend.docs) {
      const b = bdoc.data() || {};
      try {
        const batch = await client.messages.batches.retrieve(bdoc.id);
        if (batch.processing_status !== 'ended') {
          // 보장 시한(24h)을 훌쩍 넘기면 포기 처리 — 학생들이 '검사 중'에 멈춰 있지 않게
          if (Date.now() - Date.parse(b.createdAt) > 26 * 3600 * 1000) {
            await bdoc.ref.set({ status: 'error', error: 'timeout' }, { merge: true });
            for (const cid of Object.keys(b.names || {})) {
              const cut = cid.lastIndexOf('_');
              await db.collection('planner_ai_reviews').doc(cid).set(
                { seat: cid.slice(0, cut), date: cid.slice(cut + 1), status: 'error', error: '배치 시간 초과 — 다시 검사해 주세요', doneAt: new Date().toISOString() },
                { merge: true });
            }
          }
          continue;
        }
        let ok = 0, fail = 0;
        for await (const r of await client.messages.batches.results(bdoc.id)) {
          const cid = r.custom_id;
          const cut = cid.lastIndexOf('_');
          const seat = cid.slice(0, cut), rds = cid.slice(cut + 1);
          const reviewRef = db.collection('planner_ai_reviews').doc(cid);
          try {
            if (r.result.type !== 'succeeded') throw new Error(`배치 처리 실패 (${r.result.type})`);
            // uid 는 접수 때 확정한 값을 쓴다(결과 기록은 문서를 통째 교체하므로 반드시 같이 넣어야 한다)
            const uid = (b.uids || {})[cid] || null;
            await writePlannerAiResult(reviewRef, seat, rds, (b.names || {})[cid], b.model, r.result.message,
              { billing: 'batch', ...(uid ? { uid } : {}) });
            ok++;
          } catch (e) {
            fail++;
            await reviewRef.set({ seat, date: rds, status: 'error', error: e.message, doneAt: new Date().toISOString() }, { merge: true });
          }
        }
        await bdoc.ref.set({ status: 'done', ok, fail, doneAt: new Date().toISOString() }, { merge: true });
        logger.info('plannerBatch 수거 완료', { batchId: bdoc.id, ok, fail });
      } catch (e) {
        logger.error('plannerBatchCollect', { batchId: bdoc.id, message: e.message });
      }
    }
  }
);

// ══════════════════════════════════════
// 📓🩹 플래너 제출 자동 대조 — 사진은 올라갔는데 제출 기록이 없는 건 복원
// ══════════════════════════════════════
// 학생앱은 ①Storage에 사진 업로드 → ②planners 문서 저장 순으로 낸다. ②는 Firestore
// SDK 특성상 네트워크가 끊기면 '실패'가 아니라 '대기'로 멈춘다 — 그래서 앱의
// try/catch·재시도가 아예 발동하지 않고 조용히 유실된다. 학생 화면(달력)에는 사진이
// 보이는데 관리앱·상점 집계에는 미제출로 남는다. 실제 4건 발생했고(7/21 우지효,
// 7/24 김리원, 7/26 권세나·신유담) 전부 사람이 눈치채고 수동 복원했다.
// → 서버가 매일 두 번 Storage와 문서를 대조해 누락분을 자동으로 메운다.
//
//  · 실행 02:05 / 12:05 = 검사 배치(02:10·12:10) 5분 전 → 복원된 제출이 그 배치에 바로 실린다
//  · submittedAt = Storage 파일의 실제 업로드 시각이라 정시/지각 판정이 정확하다
//  · create()만 쓴다 — 이미 있는 기록은 절대 건드리지 않는다(사람 수정분 보호)
const PLANNER_BUCKET = 'saebom-studyhall.firebasestorage.app';   // 클라이언트 firebaseConfig.storageBucket과 같아야 함
const PL_DUE_HOUR = 2;   // 정시 마감 = 학습일 다음날 02:00 KST (학생앱 PL_DUE_HOUR와 같은 값)

// 학습일 ds의 정시 마감 시각(epoch ms)
function plannerDueMs(ds) {
  return Date.parse(`${ds}T0${PL_DUE_HOUR}:00:00+09:00`) + 24 * 3600 * 1000;
}

async function runPlannerReconcile(label) {
  const ds = kstYesterday();
  const bucket = admin.storage().bucket(PLANNER_BUCKET);

  const [psnap, ssnap] = await Promise.all([
    db.collection('planners').where('date', '==', ds).get(),
    db.collection('students').get()
  ]);
  const have = new Set(psnap.docs.map(d => String((d.data() || {}).seat)));

  const restored = [];
  for (const sdoc of ssnap.docs) {
    const s = sdoc.data() || {};
    if (!s.name) continue;                                       // name 없는 문서 = _meta_* 설정 문서
    const seat = String(s.seat || sdoc.id).replace(/[^0-9]/g, '');
    if (!seat || have.has(seat)) continue;

    const file = bucket.file(`planners/${seat}/${ds}.jpg`);
    const [exists] = await file.exists();
    if (!exists) continue;                                       // 사진도 없으면 진짜 미제출

    try {
      const [meta] = await file.getMetadata();
      let token = (meta.metadata || {}).firebaseStorageDownloadTokens;
      if (!token) {                                              // 토큰 없이 올라온 파일이면 발급해 URL을 만들 수 있게
        token = randomUUID();
        await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
      }
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}`
                + `/o/${encodeURIComponent(file.name)}?alt=media&token=${String(token).split(',')[0]}`;
      const ts = meta.timeCreated;                               // 사진이 실제로 올라온 시각 = 제출 시각
      const status = Date.parse(ts) < plannerDueMs(ds) ? 'ontime' : 'late';

      await db.collection('planners').doc(`${seat}_${ds}`).create({
        seat, date: ds, url, name: s.name,
        submittedAt: ts, status, updatedAt: ts,
        restoredBy: 'reconcile'                                  // 학생앱이 쓴 기록과 구분 — 재발 추적용
      });
      restored.push({ seat, name: s.name, status, submittedAt: ts });
    } catch (e) {
      if (e.code === 6) continue;                                // ALREADY_EXISTS — 그 사이 학생앱 저장이 도착함
      logger.warn('plannerReconcile 복원 실패', { seat, ds, message: e.message });
    }
  }

  // 복원이 있었다는 건 앱에서 유실이 또 일어났다는 뜻 → 로그 레벨을 올려 눈에 띄게
  if (restored.length) logger.warn('plannerReconcile 누락 제출 복원', { ds, label, count: restored.length, restored });
  else logger.info('plannerReconcile 이상 없음', { ds, label, submitted: have.size });
}

exports.plannerReconcile = onSchedule(
  { schedule: '5 2,12 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', timeoutSeconds: 300, maxInstances: 1 },
  async () => { try { await runPlannerReconcile('daily'); } catch (e) { logger.error('plannerReconcile', { message: e.message }); } }
);


// ══════════════════════════════════════════════════════════════════════════
// 📄🤖 학부모 리포트 '선생님 의견' — 기간 학습기록을 읽고 담임 의견을 쓴다
//
// 플래너 검사와 같은 문서 트리거 패턴이다. 다른 점은 사진을 안 본다는 것 —
// 관리앱이 이미 집계해 둔 숫자(순공시간·과목·교재·플래너 실행률·상벌점)를
// JSON 문자열로 실어 보내고, 여기서는 그 숫자만 읽고 문장을 만든다.
//   요청: report_ai_requests/{키}_{타임스탬프}  (관리앱이 생성, 처리 후 삭제)
//   결과: report_comments/{키}                  (관리앱이 onSnapshot으로 수신)
//   키 = (uid 있으면 uid, 없으면 좌석)_시작일_종료일
//
// payload 를 문자열로 받는 이유: Firestore 는 배열 안의 배열을 못 담고
// undefined 필드에서 쓰기가 통째로 실패한다. 집계 결과는 중첩이 깊어 그대로
// 넣으면 걸린다 — JSON.stringify 한 덩어리면 그 제약을 전부 피한다.
// 모델·프롬프트는 ai_config/report 문서로 덮어쓸 수 있다(없으면 기본값).
// ══════════════════════════════════════════════════════════════════════════
const REPORT_AI_MODEL = 'claude-opus-5';
const REPORT_AI_PROMPT = `당신은 자기주도학습 공간 "새봄면학관"에서 10년 넘게 고등학생을 지도해 온 담임 선생님입니다.
학생 한 명의 일정 기간 학습 기록을 정리한 자료를 받아, 학부모께 보내는 리포트 맨 끝에 실릴
**선생님 의견**을 씁니다. 학부모가 리포트에서 숫자와 그래프를 다 본 뒤 마지막으로 읽는 글입니다.

[주어지는 자료]
- 순공시간: 입·퇴실 기록에서 외출을 뺀 실제 공부시간. 하루평균·주차별·날짜별·또래평균 대비
- 플래너: 매일 제출한 학습 플래너를 검사한 결과 — 계획 개수와 완료 개수, 작성 품질, 과목별 시간, 교재와 진도
- 생활: 평균 등원 시각(기간 전반/후반 비교), 외출 합계, 상점·벌점 내역
- 최근 담임 코멘트: 학생에게 직접 써 준 최근 피드백

[쓰려는 것]
학부모는 집에서 아이의 공부를 다 보지 못합니다. 그래서 이 글의 역할은 '점수 통보'가 아니라
**면학관에서 본 아이의 모습을 옮겨 드리는 것**입니다. 숫자가 이미 위에 다 나와 있으므로,
같은 숫자를 다시 나열하지 말고 그 숫자가 무엇을 뜻하는지를 말합니다.
근거(주어진 자료의 구체적 수치·교재명·날짜) → 해석 → 제안의 순서로 생각하되,
내놓는 글은 분석 보고서가 아니라 상담 자리에서 선생님이 건네는 말이어야 합니다.

[네 부분]
1. overall — 총평. 2~4문장. 이 기간 이 학생이 어떻게 지냈는지를 한 덩어리로.
   첫 문장은 매번 다르게. "OO 학생은" 으로 시작하는 상투적인 틀을 반복하지 말 것.
2. praise — 칭찬할 점. 1~3개. 반드시 자료에 있는 근거를 함께 댈 것.
   근거 없는 칭찬("성실합니다", "열심히 합니다")은 한 줄도 쓰지 말 것.
   눈에 잘 안 띄지만 유지할 가치가 있는 것을 골라 주는 편이 좋습니다
   (예: 총량은 그대로인데 등원 시각이 20분 빨라진 것, 한 과목이 하루도 안 끊긴 것).
3. improve — 보완이 필요한 부분. 1~3개. 학생을 평가하는 말이 아니라 **사실**로 씁니다.
   ("부족합니다", "안일합니다", "문제입니다" ✕ / "국어가 3주 동안 2일뿐이었습니다" ○)
   왜 그렇게 됐을지 한 단계 더 들어가되 단정하지 말고 짐작으로 말할 것.
   자료에 근거가 없으면 억지로 만들지 말 것. 정말 보완할 것이 없으면
   지금 방식을 유지하며 다음 단계로 무엇을 볼지를 적습니다.
4. advice — 개선 방향과 학습법 추천. 2~4개. 다음 기간에 실제로 해 볼 수 있는 것.
   과목·교재·시간대·분량까지 구체적으로. 집에서 학부모가 도울 수 있는 것이 있으면 그것도.
   ("균형 있게 시켜 주세요" ✕ / "영어 단어는 하루 30개씩 나눠 보는 쪽을 권합니다.
     한 번에 몰아서 외운 날은 다음 날 기억이 거의 남지 않습니다" ○)

각 항목은 title(6~16자 정도의 짧은 문구)과 body(2~4문장)로 씁니다.
title 은 그 항목이 무엇에 대한 이야기인지 한눈에 알 수 있게. 번호나 이모지를 붙이지 말 것.

[지금의 운영 상황]
- 2학기 개학 후에는 대부분 학교에 다닙니다. 평일 낮은 학교 수업이고 면학관 자습은 방과 후입니다.
  평일 총량이 방학 때보다 줄어드는 것은 당연하므로 그 자체를 문제 삼지 말 것.
- 일요일은 자율 등원입니다. 일요일에 안 나온 것을 결석으로 말하지 말 것.
- '하루 평균'은 등원 예정일(월~토)을 분모로 한 성실도 기준입니다. 결석이 있으면 평균이 내려갑니다.
- 플래너에 적힌 학습시간에는 집·학교·학원 공부가 함께 들어가므로 면학관 순공시간과 다릅니다.
  둘을 직접 견주어 "기록이 안 맞는다"고 말하지 말 것.
- 또래 평균은 같은 학년 재원생 평균입니다. 인원이 적으면 흔들리므로 크게 벌어졌을 때만 언급할 것.

[말투]
- 학부모께 드리는 존댓말. 학생은 이름으로 부릅니다(예: "민지가", "민지는").
- 담백하게. 과장된 감탄, 영업하는 말투, 상담 광고 문구 같은 표현 금지.
- 확신할 수 없는 것은 단정하지 말고 "~로 보입니다", "~인 듯합니다"로.
- 학원 자랑이나 시설 이야기를 넣지 말 것. 학생 이야기만 합니다.
- 이모지, 번호 매기기, 굵은 글씨 표시(**), 마크다운 문법을 쓰지 말 것.
- "AI", "분석", "데이터", "지표", "인사이트" 같은 단어를 쓰지 말 것.
- 남용 금지 어휘: 알차게, 촘촘히, 골고루, 꼼꼼히, 눈에 띄네요, 인상적입니다, 꾸준함,
  균형 있게, "~한 점이 좋았습니다", "앞으로가 기대됩니다".
- 격려로 맺는 습관 금지. 할 말이 끝나면 그냥 끝냅니다.

[지어내지 말 것]
주어진 자료에 없는 숫자·과목·교재·사건을 만들어 쓰지 말 것.
자료가 빈약하면(플래너 검사가 며칠뿐이거나 출석이 적으면) 억지로 채우지 말고
각 항목을 하나씩만, 짧게 씁니다. 무엇을 못 봤는지 솔직히 적는 편이 낫습니다.
"며칠째", "요즘", "지난달보다" 같은 말은 자료로 확인되는 경우에만 씁니다.`;

const REPORT_AI_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '6~16자 정도의 짧은 문구' },
    body:  { type: 'string', description: '2~4문장, 존댓말' }
  },
  required: ['title', 'body'],
  additionalProperties: false
};
// ⚠️ minItems·maxItems 를 넣지 말 것. 구조화 출력 스키마는 배열 개수 제약을 안 받는다
//    (2026-08-13 실제로 400 "For 'array' type, property 'maxItems' is not supported").
//    개수는 프롬프트에서 말한다 — 칭찬 1~3, 보완 1~3, 제안 2~4.
const REPORT_AI_SCHEMA = {
  type: 'object',
  properties: {
    overall: { type: 'string', description: '총평 2~4문장' },
    praise:  { type: 'array', items: REPORT_AI_ITEM, description: '칭찬할 점 1~3개' },
    improve: { type: 'array', items: REPORT_AI_ITEM, description: '보완이 필요한 부분 1~3개' },
    advice:  { type: 'array', items: REPORT_AI_ITEM, description: '개선 방향·학습법 2~4개' }
  },
  required: ['overall', 'praise', 'improve', 'advice'],
  additionalProperties: false
};

// 비어 있는 항목 이름들. required 가 잡아 주지 못하는 '키는 있는데 배열이 빈' 경우를 본다.
const REPORT_AI_LISTS = ['praise', 'improve', 'advice'];
const reportOpinionEmptyKeys = (o) =>
  REPORT_AI_LISTS.filter(k => !Array.isArray((o || {})[k]) || !(o || {})[k].length);

async function reportAiConfig() {
  const snap = await db.collection('ai_config').doc('report').get();
  const cfg = snap.exists ? (snap.data() || {}) : {};
  return { model: cfg.model || REPORT_AI_MODEL, sysPrompt: cfg.prompt || REPORT_AI_PROMPT };
}

exports.reportAiOpinion = onDocumentCreated(
  // concurrency:1 — 사진이 없어 가볍지만, 선생님이 여러 명분을 연달아 누르면 같은 시스템
  // 프롬프트가 줄지어 들어온다. 순차로 돌려야 앞 건이 프롬프트 캐시를 데워 준다.
  { document: 'report_ai_requests/{id}', region: 'us-central1', secrets: [ANTHROPIC_KEY], timeoutSeconds: 300, memory: '512MiB', concurrency: 1 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const req = snap.data() || {};
    const key = req.key;
    if (!key) { logger.error('reportAiOpinion — key 누락'); await snap.ref.delete().catch(() => {}); return; }
    const ref = db.collection('report_comments').doc(key);
    try {
      if (!req.payload) throw new Error('집계 자료가 없습니다');
      const data = JSON.parse(req.payload);

      // 사람이 고친 의견(editedAt)은 '다시 생성'(force)을 누르지 않는 한 건드리지 않는다.
      // 리포트를 다시 '만들기' 하다가 손본 문장이 날아가는 게 제일 나쁘다 —
      // API를 부르기 전에 확인해서 헛돈도 쓰지 않는다.
      const prev = await ref.get();
      if (prev.exists && (prev.data() || {}).editedAt && !req.force) {
        await ref.set({ status: 'done' }, { merge: true });
        logger.info('reportAiOpinion — 사람이 고친 의견이 있어 건너뜀', { key });
        return;
      }

      await ref.set({
        key, uid: req.uid || null, seat: req.seat || null, name: req.name || null,
        startISO: req.startISO || null, endISO: req.endISO || null,
        status: 'running', startedAt: new Date().toISOString()
      }, { merge: true });

      const { model, sysPrompt } = await reportAiConfig();
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
      const userContent =
        `아래는 ${data.학생 && data.학생.이름 ? data.학생.이름 : '한 학생'}의 학습 기록입니다. 선생님 의견을 써 주세요.\n\n` +
        '```json\n' + JSON.stringify(data, null, 1) + '\n```';

      const askOnce = async (note) => {
        const m = await client.messages.create({
          model,
          max_tokens: 16000,   // 적응형 사고 + 본문. 사고가 길어져도 잘리지 않게 넉넉히
          system: [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }],
          output_config: { effort: 'high', format: { type: 'json_schema', schema: REPORT_AI_SCHEMA } },
          messages: [{ role: 'user', content: note ? `${userContent}\n\n${note}` : userContent }]
        });
        if (m.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 못했습니다(refusal)');
        return { m, o: JSON.parse((m.content.find(b => b.type === 'text') || {}).text || '') };
      };

      let { m: msg, o: out } = await askOnce(null);
      let usage = { in: msg.usage.input_tokens, out: msg.usage.output_tokens };

      // ── 빈 항목 가드 ────────────────────────────────────────────────────────
      // 스키마로는 못 막는다 — required 는 키가 있는지만 보고, 개수 제약(minItems)은
      // 구조화 출력이 400 으로 거부한다(REPORT_AI_SCHEMA 위 주석).
      // 2026-08-13 김지후 건이 overall 만 채우고 세 배열이 전부 빈 채 저장돼 리포트에
      // 총평 한 문단만 나갔다(출력 268토큰, 같은 날 다른 16건은 2,000~6,400).
      // 플래너가 5일치뿐인 학생이라 '자료가 빈약하면 하나씩만 짧게' 지침을
      // '아예 안 씀'으로 과하게 적용한 것으로 보인다.
      // 다시 부르는 건 한 번뿐. 두 번째도 비면 받은 대로 저장한다 — 에러로 만들면
      // 멀쩡한 총평까지 버려지고 선생님은 빈 화면을 보게 되어 더 나쁘다.
      let missing = reportOpinionEmptyKeys(out);
      if (missing.length) {
        logger.warn('reportAiOpinion — 빈 항목이 있어 한 번 다시 부른다', { key, missing });
        const note = `앞선 시도에서 ${missing.join('·')} 항목이 비어 있었습니다.`
          + ` praise·improve·advice 는 자료가 적더라도 각각 최소 하나씩은 반드시 채워 주세요.`
          + ` 근거로 쓸 기록이 얇으면 그 사실 자체를 적으면 됩니다`
          + ` (예: 플래너가 며칠치뿐이라 무엇을 확인하지 못했는지).`;
        const retry = await askOnce(note);
        usage = { in: usage.in + retry.m.usage.input_tokens,
                  out: usage.out + retry.m.usage.output_tokens, retried: true };
        // 덜 빈 쪽을 고른다 — 재시도가 또 비면 첫 결과를 그대로 둔다
        if (reportOpinionEmptyKeys(retry.o).length < missing.length) { msg = retry.m; out = retry.o; }
        missing = reportOpinionEmptyKeys(out);
        if (missing.length) logger.error('reportAiOpinion — 재시도 후에도 빈 항목이 남았다', { key, missing });
      }

      await ref.set({
        key, uid: req.uid || null, seat: req.seat || null, name: req.name || null,
        startISO: req.startISO || null, endISO: req.endISO || null,
        opinion: out, status: 'done', model,
        editedAt: null,
        doneAt: new Date().toISOString(),
        usage
      }, { merge: true });
      logger.info('reportAiOpinion 완료', { key, out: usage.out, retried: !!usage.retried });
    } catch (e) {
      logger.error('reportAiOpinion', { key, message: e.message });
      await ref.set({ key, status: 'error', error: e.message, doneAt: new Date().toISOString() }, { merge: true });
    } finally {
      await snap.ref.delete().catch(() => {});   // 요청 문서는 1회용
    }
  }
);


// ══════════════════════════════════════════════════════════════════════════
//  Cloudflare Zero Trust — Gateway DNS 로그 조회 프록시
//
//  왜 서버를 거치나: 이 저장소는 public 이라 관리앱 HTML에 Cloudflare 토큰을
//  넣을 수 없다. 토큰은 Secret 으로만 두고, 브라우저는 이 함수를 호출한다.
//
//  설정(둘 다 필요):
//     firebase functions:secrets:set CF_API_TOKEN     ← Account > Zero Trust > Read 권한 토큰
//     firebase functions:secrets:set CF_ACCOUNT_ID    ← Cloudflare 대시보드 우측의 Account ID
//
//  인증: 관리앱이 보낸 기기 토큰이 settings/admin_auth.hash 와 같을 때만 응답한다
//        (관리앱의 기존 '관리자 기기 등록제'와 같은 신뢰 수준).
//
//  주의: Gateway 로그는 '기기(=면학관 공유기)' 단위다. 학생 개인은 특정되지 않는다.
// ══════════════════════════════════════════════════════════════════════════
const CF_API_TOKEN = defineSecret('CF_API_TOKEN');
const CF_ACCOUNT_ID = defineSecret('CF_ACCOUNT_ID');

// Cloudflare는 도메인을 뒤집어서 준다("com.youtube.www") → 사람이 읽는 순서로 되돌린다.
function unreverseDomain(s) {
  return String(s || '').replace(/^\.+|\.+$/g, '').split('.').reverse().join('.');
}

// resolverDecision 해석.
//  Cloudflare는 이 값을 '문서화되지 않은 숫자'로 준다(문서엔 blockedByCategory 같은
//  문자열로 적혀 있지만 실제 응답은 5·9·10 같은 정수). 그래서 /^blocked/ 같은 문자열
//  검사는 절대 걸리지 않고 차단 집계가 조용히 0이 된다 — 실제로 그 버그를 겪었다.
//
//  2026-07-23 실측(면학관 24시간 6.3만건)으로 확인한 매핑:
//    5  = 허용    (구글·애플·카카오톡·유튜브 등 50개 도메인)
//    9  = 차단    (페이스북·인스타그램 9개 도메인에만 붙음 = 실제 차단정책과 일치)
//    10 = 허용    (별도 규칙으로 통과된 것으로 보임)
//  다시 확인하려면 debug:true 로 호출해 rawRows(도메인×판정)를 보면 된다.
//  모르는 값은 blocked 로 세지 않고 unknownDecisions 에 담아 드러낸다 —
//  조용히 허용으로 처리했다가 차단을 놓치는 것보다 눈에 보이게 두는 편이 낫다.
const DECISION_BLOCKED = new Set([9]);
const DECISION_ALLOWED = new Set([5, 10]);
function isBlockedDecision(d) {
  if (typeof d === 'number') return DECISION_BLOCKED.has(d);
  return /^blocked/i.test(String(d || ''));   // 문자열로 바뀌어 올 경우 대비
}
function isKnownDecision(d) {
  if (typeof d === 'number') return DECISION_BLOCKED.has(d) || DECISION_ALLOWED.has(d);
  return /^(blocked|allowed|override)/i.test(String(d || ''));
}

// Cloudflare Gateway DNS 집계를 가져온다. HTTP 조회와 야간 스냅샷이 함께 쓴다.
async function fetchGatewayDns(minutes, debug, hourly) {
  const start = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  // 도메인별 집계와 시간대별 집계를 한 요청에 담는다(별칭 2개).
  const query = `
    query GatewayDns($accountTag: string!, $start: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          byDomain: gatewayResolverQueriesAdaptiveGroups(
            filter: { datetime_gt: $start }
            limit: 200
            orderBy: [count_DESC]
          ) {
            count
            dimensions { queryNameReversed resolverDecision }
          }
          byHour: gatewayResolverQueriesAdaptiveGroups(
            filter: { datetime_gt: $start }
            limit: 800
            orderBy: [datetimeHour_ASC]
          ) {
            count
            dimensions { datetimeHour }
          }
          ${hourly ? `byDomainHour: gatewayResolverQueriesAdaptiveGroups(
            filter: { datetime_gt: $start }
            limit: 5000
            orderBy: [count_DESC]
          ) {
            count
            dimensions { queryNameReversed datetimeHour resolverDecision }
          }` : ''}
        }
      }
    }`;

  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN.value()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { accountTag: CF_ACCOUNT_ID.value(), start } })
  });
  const j = await r.json();
  if (j.errors && j.errors.length) {
    const msg = j.errors.map(e => e.message).join(' / ');
    logger.error('[Gateway] GraphQL 오류', j.errors);
    const err = new Error(msg); err.graphql = true; throw err;
  }
  const acct = ((j.data && j.data.viewer && j.data.viewer.accounts) || [])[0] || {};

  // 같은 도메인이 여러 판정으로 쪼개져 오므로 도메인 기준으로 합친다.
  const map = new Map();
  (acct.byDomain || []).forEach(row => {
    const d = unreverseDomain(row.dimensions && row.dimensions.queryNameReversed);
    if (!d) return;
    const decision = row.dimensions && row.dimensions.resolverDecision;
    const blocked = isBlockedDecision(decision);
    const cur = map.get(d) || { domain: d, total: 0, blocked: 0, allowed: 0 };
    cur.total += row.count;
    if (blocked) cur.blocked += row.count; else cur.allowed += row.count;
    map.set(d, cur);
  });
  const domains = Array.from(map.values()).sort((a, b) => b.total - a.total);

  // 판정(resolverDecision) 분포 — 차단이 왜 0인지 같은 진단에 쓴다.
  //  allowedOnNoPolicyMatch = 정책에 안 걸림 / allowedOnNoLocation = 위치 미매칭이라
  //  정책 자체가 적용 안 됨(필터링 무력화) → 둘의 구분이 중요하다.
  const decisions = {};
  const unknownDecisions = {};
  (acct.byDomain || []).forEach(row => {
    const d = row.dimensions && row.dimensions.resolverDecision;
    const k = (d === undefined || d === null) ? '(none)' : String(d);
    decisions[k] = (decisions[k] || 0) + row.count;
    if (!isKnownDecision(d)) unknownDecisions[k] = (unknownDecisions[k] || 0) + row.count;
  });
  const hourlyTotals = (acct.byHour || []).map(row => ({
    hour: row.dimensions && row.dimensions.datetimeHour,
    count: row.count
  }));

  // 진단용: 도메인×판정 원본(상위 60행). resolverDecision 숫자의 의미를 실측할 때 쓴다.
  const rawRows = !debug ? undefined : (acct.byDomain || []).slice(0, 60).map(row => ({
    domain: unreverseDomain(row.dimensions && row.dimensions.queryNameReversed),
    decision: row.dimensions && row.dimensions.resolverDecision,
    count: row.count
  }));

  // 도메인×시각 — 서비스별 시간대 분포용. 분류는 클라이언트가 하므로 원본을 그대로 넘긴다.
  // hour 는 UTC라 화면에서 KST(+9)로 바꿔야 한다. 응답이 커지므로 hourly:true 일 때만 실린다.
  const domainHour = !hourly ? undefined : (acct.byDomainHour || []).map(row => ({
    domain: unreverseDomain(row.dimensions && row.dimensions.queryNameReversed),
    hour: row.dimensions && row.dimensions.datetimeHour,
    blocked: isBlockedDecision(row.dimensions && row.dimensions.resolverDecision),
    count: row.count
  }));

  return {
    minutes,
    domains,
    domainHour,
    decisions,
    unknownDecisions,
    rawRows,
    hourly: hourlyTotals,
    total: domains.reduce((s, d) => s + d.total, 0),
    blocked: domains.reduce((s, d) => s + d.blocked, 0)
  };
}

exports.gatewayLogs = onRequest(
  {
    region: 'us-central1',
    secrets: [CF_API_TOKEN, CF_ACCOUNT_ID],
    cors: ['https://saebom-studyhall.web.app', 'https://doctorj011-blip.github.io', 'http://localhost:8961', 'http://127.0.0.1:8961'],
    maxInstances: 3
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 허용' }); return; }
    try {
      // ── 관리자 기기 확인 ──
      const token = (req.body && req.body.token) || '';
      const authSnap = await db.doc('settings/admin_auth').get();
      const want = authSnap.exists ? (authSnap.data() || {}).hash : null;
      if (!want || token !== want) { res.status(403).json({ error: '관리자 기기가 아닙니다' }); return; }

      // 실시간 모드는 분 단위 창을 쓴다. hours 는 이전 호출 호환용.
      const b = req.body || {};
      let minutes = parseInt(b.minutes, 10);
      if (!minutes || isNaN(minutes)) minutes = (parseInt(b.hours, 10) || 24) * 60;
      minutes = Math.min(Math.max(minutes, 1), 43200);   // 1분 ~ 30일
      const out = await fetchGatewayDns(minutes, !!b.debug, !!b.hourly);
      res.json({ ok: true, ...out });
    } catch (e) {
      logger.error('[Gateway] 조회 실패', e);
      res.status(e.graphql ? 502 : 500).json({ error: String((e && e.message) || e) });
    }
  }
);

// ── 기기 감사 로그 (스케줄 무단변경 조사) ──────────────────────────────────
// 학생앱 로그인·저장 시점의 기기ID(localStorage UUID)·IP·User-Agent 를 남긴다.
// 목적: 누군가 남의 뒷4자리로 로그인해 스케줄을 조작하는 사건(2026-08 김태현 6번)의
//   범인 특정. Firestore 규칙 대부분이 'if true'라 IP 같은 민감정보를 문서로 쌓으면
//   미인증 REST 로 전교생 IP 가 새므로, 일부러 DB 에 안 쓰고 Cloud Logging 에만 남긴다.
// 조회: firebase functions:log --only deviceAudit -n 400 --project saebom-studyhall
//   같은 deviceId 가 서로 다른 학생 이름으로 로그인/저장했으면 그 기기가 범인이다.
// 학생앱에 어떤 에러도 노출하지 않는다(항상 200) — 감사 중임을 눈치채지 못하게.
exports.deviceAudit = onRequest(
  {
    region: 'us-central1',
    cors: ['https://saebom-studyhall.web.app', 'https://doctorj011-blip.github.io', 'http://localhost:8961', 'http://127.0.0.1:8961'],
    maxInstances: 5
  },
  async (req, res) => {
    try {
      const b = (req.body && typeof req.body === 'object') ? req.body : {};
      // Cloud Run(2세대 함수)은 클라이언트 IP 를 x-forwarded-for 맨 앞에 넣는다.
      const fwd = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      logger.info('[DeviceAudit]', {
        event: String(b.event || '').slice(0, 24),
        name:  String(b.name  || '').slice(0, 40),
        seat:  String(b.seat  || '').slice(0, 8),
        deviceId: String(b.deviceId || '').slice(0, 64),
        ip: fwd,
        ua: String(req.headers['user-agent'] || '').slice(0, 300)
      });
    } catch (e) {
      // 조사용 로깅이 학생앱 동작을 절대 방해하면 안 되므로 조용히 삼킨다.
    }
    res.status(200).json({ ok: true });
  }
);

// ── 하루치 스냅샷 ────────────────────────────────────────────────────────
// Cloudflare 무료 플랜은 로그를 24시간만 보관한다. 매일 밤 그날 집계를 우리
// Firestore(net_daily/{YYYY-MM-DD})에 남겨 장기 추이를 볼 수 있게 한다.
// 23:55에 도는 이유: 그 시점 '최근 24시간'이 사실상 그날 하루와 겹치기 때문.
// 저장 용량을 아끼려고 도메인은 상위 50개만 남긴다(꼬리는 거의 잡음).
exports.netDailySnapshot = onSchedule(
  {
    schedule: '55 23 * * *',
    timeZone: 'Asia/Seoul',
    region: 'us-central1',
    secrets: [CF_API_TOKEN, CF_ACCOUNT_ID],
    maxInstances: 1
  },
  async () => {
    const now = new Date(Date.now() + 9 * 3600 * 1000);   // KST 기준 날짜 키
    const date = now.toISOString().slice(0, 10);
    try {
      const out = await fetchGatewayDns(1440);   // 24시간
      await db.doc(`net_daily/${date}`).set({
        date,
        total: out.total,
        blocked: out.blocked,
        domainCount: out.domains.length,
        domains: out.domains.slice(0, 50),
        updatedAt: new Date().toISOString()
      });
      logger.info(`[Gateway] ${date} 스냅샷 저장 — 조회 ${out.total}건, 차단 ${out.blocked}건`);
    } catch (e) {
      logger.error(`[Gateway] ${date} 스냅샷 실패`, e);
      throw e;   // 실패를 삼키면 조용히 비는 날이 생기므로 재시도되게 던진다
    }
  }
);

// ── 서비스별 차단 토글 (유튜브·카카오톡) ──────────────────────────────
// 관리앱 와이파이 탭의 버튼이 호출한다. Cloudflare DNS 정책 중 서비스별 전용
// 규칙(block-*-toggle)의 enabled만 켜고 끈다. 인스타·넷플릭스 등을 막는
// block-youtube-instagram 정책은 여기서 절대 손대지 않는다.
// 주의: CF_API_TOKEN에 Zero Trust "Edit" 권한이 있어야 변경(PUT)이 된다.
//       (2026-07-26 saebom-studyhall-functions 토큰으로 교체 완료)
const NETBLOCK_RULES = {
  youtube: '8e796b54-049a-411d-8da3-3b0322f67fb6',   // block-youtube-toggle (YouTube·Kids·Music)
  kakao: 'be1c5d78-81ed-4c06-8275-8b2cf4211ddd'      // block-kakaotalk-toggle (Kakao Talk)
};

async function cfToggleRule(ruleId, method, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID.value()}/gateway/rules/${ruleId}`;
  const r = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN.value()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
    throw new Error(`Cloudflare ${method} 실패: ${msg}`);
  }
  return j.result;
}

// 규칙의 enabled를 원하는 값으로 맞춘다. Gateway 규칙 갱신은 PUT(전체 교체)뿐이라
// 기존 내용을 그대로 되돌려 보내면서 enabled만 바꾼다. 읽기전용 필드(id 등)는 추린다.
async function cfSetRuleEnabled(ruleId, enabled) {
  const cur = await cfToggleRule(ruleId, 'GET');
  if (!!cur.enabled === enabled) return { changed: false, rule: cur };
  const upd = await cfToggleRule(ruleId, 'PUT', {
    name: cur.name,
    description: cur.description || '',
    action: cur.action,
    traffic: cur.traffic || '',
    identity: cur.identity || '',
    device_posture: cur.device_posture || '',
    precedence: cur.precedence,
    filters: cur.filters,
    rule_settings: cur.rule_settings,
    enabled
  });
  return { changed: true, rule: upd };
}

// 카카오 자동연동 플래그 — settings/netblock.kakaoAuto. 문서/필드가 없으면 켜진 것(기본 자동).
async function _kakaoAutoOn() {
  const snap = await db.doc('settings/netblock').get();
  return (snap.exists ? snap.data() : {}).kakaoAuto !== false;
}

const _netBlockHandler = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 허용' }); return; }
  try {
    const b = req.body || {};
    const authSnap = await db.doc('settings/admin_auth').get();
    const want = authSnap.exists ? (authSnap.data() || {}).hash : null;
    if (!want || (b.token || '') !== want) { res.status(403).json({ error: '관리자 기기가 아닙니다' }); return; }

    const target = b.target || 'youtube';   // 구버전 클라이언트(target 없음)는 유튜브
    const ruleId = NETBLOCK_RULES[target];
    if (!ruleId) { res.status(400).json({ error: `모르는 대상: ${target}` }); return; }

    // 자동연동 플래그 변경(카카오만 의미 있음) — 규칙이 아니라 스케줄러 동작 여부를 바꾼다.
    if (target === 'kakao' && typeof b.auto === 'boolean') {
      await db.doc('settings/netblock').set({ kakaoAuto: b.auto, updatedAt: new Date().toISOString() }, { merge: true });
      logger.info(`[NetBlock] 카카오 교시 자동연동 ${b.auto ? 'ON' : 'OFF'}`);
    }
    const auto = target === 'kakao' ? await _kakaoAutoOn() : undefined;

    if (typeof b.enabled !== 'boolean') {
      const cur = await cfToggleRule(ruleId, 'GET');
      res.json({ ok: true, target, blocked: !!cur.enabled, auto });
      return;
    }
    const { rule } = await cfSetRuleEnabled(ruleId, b.enabled);
    logger.info(`[NetBlock] ${target} 차단 ${rule.enabled ? 'ON' : 'OFF'} (규칙 v${rule.version})`);
    res.json({ ok: true, target, blocked: !!rule.enabled, auto, version: rule.version });
  } catch (e) {
    logger.error('[NetBlock] 토글 실패', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

const _netBlockOpts = {
  region: 'us-central1',
  secrets: [CF_API_TOKEN, CF_ACCOUNT_ID],
  cors: ['https://saebom-studyhall.web.app', 'https://doctorj011-blip.github.io', 'http://localhost:8961', 'http://127.0.0.1:8961'],
  maxInstances: 3
};

exports.netBlockToggle = onRequest(_netBlockOpts, _netBlockHandler);
// 이전 이름 — 배포 시점에 열려 있던 옛 관리앱 페이지가 아직 부를 수 있어 남겨둔다.
exports.youtubeBlockToggle = onRequest(_netBlockOpts, _netBlockHandler);

// ── 카카오톡 교시 자동연동 ────────────────────────────────────────────
// 교시 중엔 차단, 쉬는 시간(교시 사이·식사)과 운영 전후엔 허용 (2026-07-27 원장 지시).
// 매분 현재 교시 여부를 판정해 규칙 상태와 다르면 바꾼다(같으면 GET만 하고 끝).
// settings/netblock.kakaoAuto=false면 아무것도 안 함(수동 모드 — 와이파이 탭 체크박스).
// 교시표는 위 PERIOD_TIMES(앱 PERIODS와 동일). 요일 구성은 앱 periodsForDay()와 같은 규칙:
//   토요일 또는 방학(settings/vacation_mode.enabled)=1~11교시, 그 외 평일=7~11교시,
//   방학은 11교시 제외. 크론이 08~23시(KST)만 돌므로 학기 11교시(자정~새벽1시)는
//   연동 대상 밖(허용 상태로 남음) — 자정 넘어 선택자습까지 막을 필요는 없다고 봤다.
exports.kakaoScheduleTick = onSchedule(
  {
    schedule: '* 8-23 * * *',
    timeZone: 'Asia/Seoul',
    region: 'us-central1',
    secrets: [CF_API_TOKEN, CF_ACCOUNT_ID],
    maxInstances: 1
  },
  async () => {
    if (!(await _kakaoAutoOn())) return;

    const vacSnap = await db.doc('settings/vacation_mode').get();
    const vacation = !!(vacSnap.exists && (vacSnap.data() || {}).enabled);

    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const satLike = kst.getUTCDay() === 6 || vacation;
    const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    let periods = satLike ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [7, 8, 9, 10, 11];
    if (vacation) periods = periods.filter(p => p !== 11);

    const inClass = periods.some(p => {
      const t = PERIOD_TIMES[p];
      return t && nowMin >= t[0] && nowMin < t[1];
    });
    const { changed } = await cfSetRuleEnabled(NETBLOCK_RULES.kakao, inClass);
    if (changed) logger.info(`[NetBlock] 카카오 교시연동 → ${inClass ? '차단(교시 중)' : '허용(쉬는 시간)'}`);
  }
);
