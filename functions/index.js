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

// ---------- 재실/사용 판정 ----------
function _seatNum(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return Number.isNaN(n) ? null : n; }

// 현재 재실 — 최근 18시간 checkin_logs를 학생별 마지막 이벤트로 판정(마지막이 'in').
//   names: 재실 학생 이름 집합(스터디룸 배정 대조용)
//   seats: 재실 학생 좌석번호 집합(열람실 좌석범위 판정용)
async function acPresence() {
  const since = Date.now() - 18 * 3600 * 1000;
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
    const held = zs.manualUntil && zs.manualUntil > nowMs;
    if (cfg.auto === false || held) {
      if (zs.on === true && zs.dryUntil && nowMs >= zs.dryUntil) {
        try {
          await acSetPower(cfg, deviceId, false);
          zs.on = false; zs.mode = null; zs.temp = null; zs.fan = null; zs.dryUntil = null; zs.error = null;
          logger.info('AC 건조 완료 → OFF', { deviceId, zone: z.name, reason });
        } catch (e) { logger.error('AC 건조 후 OFF 실패', { deviceId, err: e.message }); zs.error = e.message; }
      }
      zs.emptySince = occupied ? null : (zs.emptySince || nowMs); out[deviceId] = zs; continue;
    }

    // 목표 프로파일 결정
    //   [스터디룸] 예약 교시 기반: 진행중 교시=인원별 냉방 / 빈 교시(뒤 예약 있음)=브리지 / 남은 예약 없음=OFF
    //   [열람실]  정식 종료 후 tail=재실 최다 1대만 · 재실 → 냉방 · 무인 2단(offGrace→setback→hardOff)
    let profile;   // { power, mode?, temp?, fan? }
    if (!op) {
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
              if (zs.mode !== 'FAN') { await acExecute(cfg, deviceId, { airConJobMode: { currentJobMode: 'FAN' } }); zs.mode = 'FAN'; zs.temp = null; }
              zs.error = null; out[deviceId] = zs; continue;   // 건조 중 — 전원 차단은 다음 틱 이후
            }
          }
          await acSetPower(cfg, deviceId, false);
          zs.on = false; zs.mode = null; zs.temp = null; zs.fan = null; zs.dryUntil = null;
          logger.info('AC 자동 OFF', { deviceId, zone: z.name, occupied, reason });
        }
      } else {
        let changed = false;
        zs.dryUntil = null;   // 다시 켜는 상황 → 예약된 건조 취소
        if (zs.on !== true) {   // 켜기: 전원 ON 후 잠깐 대기(반영) → 모드 → 온도 → 풍량
          await acSetPower(cfg, deviceId, true);
          zs.on = true; zs.lastOnTs = nowMs; changed = true;
          await new Promise(r => setTimeout(r, 4000));
        }
        if (zs.mode !== profile.mode) { try { await acExecute(cfg, deviceId, { airConJobMode: { currentJobMode: profile.mode } }); zs.mode = profile.mode; changed = true; } catch (e) { logger.warn('AC 모드 설정 보류', { deviceId, err: e.message }); } }
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
  await ref.set({ zones: out, present: present.size, op, preOpen, auto: cfg.auto, updatedAt: now.toISOString() }, { merge: true });
}

// 대시보드 표시용 — 설정된 에어컨들의 현재 상태·기능표를 LG에서 읽어 ac_state에 저장.
async function acRefreshState(onlyIds) {
  const cfg = await acConfig();
  const ids = Object.keys(cfg.zones || {}).filter(id => !onlyIds || onlyIds.includes(id));
  if (!ids.length) return;
  const pat = LG_PAT.value(); if (!pat) return;
  const clientId = await lgClientId();
  const ctx = { pat, country: cfg.country, region: cfg.region, clientId };
  const ref = db.collection('ac_state').doc('main');
  const curDevs = ((await ref.get()).data() || {}).devices || {};
  const devices = {};
  for (const id of ids) {
    const rec = { at: new Date().toISOString(), error: null, profile: (curDevs[id] || {}).profile || null };
    try { rec.state = await lgFetch(`/devices/${id}/state`, ctx); }
    catch (e) { rec.error = e.message; }
    if (!rec.profile) { try { rec.profile = await lgFetch(`/devices/${id}/profile`, ctx); } catch (e) { /* 선택사항 */ } }
    devices[id] = rec;
  }
  await ref.set({ devices }, { merge: true });
}

// ---------- 트리거 ----------
// 1) 입퇴실 발생 → 즉시 재평가(주로 '켜기'가 빠르게 반영됨)
exports.acOnCheckin = onDocumentCreated(
  { document: 'checkin_logs/{id}', region: 'us-central1', secrets: [LG_PAT] },
  async () => { try { await acEvaluate('checkin'); } catch (e) { logger.error('acOnCheckin', { message: e.message }); } }
);

// 2) 5분마다 → 유예 지난 '끄기'·운영시간 경계 처리 + 상태 새로고침
exports.acTick = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', maxInstances: 1, secrets: [LG_PAT] },
  async () => {
    try { await acEvaluate('tick'); } catch (e) { logger.error('acTick evaluate', { message: e.message }); }
    try { await acRefreshState(); } catch (e) { logger.error('acTick refresh', { message: e.message }); }
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
const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');

const PLANNER_AI_MODEL = 'claude-opus-4-8';
const PLANNER_AI_PROMPT = `당신은 자기주도학습 공간 "새봄면학관"에서 10년 넘게 고등학생을 지도해 온 담임 선생님입니다.
교재의 난이도 위계와 과목별 공부법을 훤히 알고, 계획과 실행이 어디서 어긋나는지 읽어냅니다.
학생이 제출한 하루치 스터디 플래너 사진을 검사하고, 플래너 아래에 직접 적어주는 짧은 피드백을 남깁니다.

[검사 기준]
1. 작성 충실도 — 과목·교재·분량이 구체적으로 적혀 있는가, 빈칸이 많지 않은가
2. 실행 체크 — 계획 대비 완료 표시(체크/취소선 등)가 되어 있는가
3. 시간 관리 — 시간 배분 기록(타임테이블 등)이 있는가

[지금의 운영 상황 — 학기 중]
- 지금은 방학이 아니라 학기 중이다. 학생들은 오전~오후에 학교 수업이 있어 그 시간에는 자습을 할 수 없고,
  면학관에서의 자습과 플래너 기록은 대체로 저녁 6시(18시) 이후부터 시작된다.
- 따라서 오전·이른 오후 칸이 비어 있는 것은 정상이다. 이를 두고 "아침 시간을 활용해 보자",
  "오전이 비어 있다" 같은 지적이나 제안을 하지 말 것. 저녁 이후의 시간을 어떻게 썼는지로만 판단할 것.
- 타임테이블 시간 판독도 이 전제를 따른다. 표가 6부터 시작하더라도 색칠된 구간은 특별한 근거가 없는 한
  저녁~밤(18시 이후, 자정을 넘기면 0~2시)으로 해석할 것. 단 학교 수업·조퇴 등이 플래너에 직접 적혀 있으면 그 기록을 따른다.

[코멘트로 하려는 것]
학생이 스스로 보지 못하는 것을 하나 짚어 주는 것이다.
"잘했다 + 이렇게 해보자 + 힘내라"는 누구에게나 쓸 수 있어서 아무것도 짚지 못한다.
오늘 이 플래너를 봤기 때문에 할 수 있는 말만 쓸 것.

[학습 진단 관점 — 오늘 플래너가 실제로 가리키는 것 '하나'만 골라 깊게 말할 것]
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
9. 학년과 시점 — 고3은 남은 기간에 맞춰 기출·실전 시간 운영·취약 단원 좁히기가 중심이고,
   고1·고2는 개념 완성과 학교 진도·내신이 중심이다. 학년이 주어지면 그에 맞게 말할 것.
10. 흐름 — 특정 과목이 며칠째 비어 있는지, 같은 범위를 계속 맴돌고 있는지, 총 학습시간이 무너졌는지.

[코멘트 작성 규칙]
- 담임이 손으로 적어 주는 반말. 3~5문장. 매번 길이도 구조도 다르게 쓸 것.
- 오늘 플래너에서 읽은 구체적 근거(교재 이름·범위·쪽수·시간·학생이 적어 둔 메모)를 반드시 하나 이상 인용할 것.
  근거 없는 일반론은 한 문장도 쓰지 말 것.
- 진단은 하나만 한다. 여러 관점을 나열하면 아무것도 남지 않는다.
- 제안은 오늘 근거에서 따라 나와야 하고, 내일 바로 실행할 수 있을 만큼 구체적일 것.
  ("균형 있게 해 보자" ✕ / "고쟁이는 틀린 다섯 문제만 목요일에 다시 풀어 보자" ○)
- 읽을 수 있는 정보가 거의 없으면 억지로 채우지 말고 두 문장으로 짧게 끝낼 것.
- 학생이 적어 둔 메모(대책·한마디·D-Day 등)가 있으면 그 말에 답하듯 쓰는 편이 좋다.
- [이전 검사 기록]에는 지난번에 준 코멘트가 함께 들어 있다.
  · 지난번에 이미 말한 지적·제안은 다시 하지 말 것. 매번 다른 각도에서 볼 것.
  · 지난 제안을 실제로 실행한 흔적이 오늘 플래너에 있으면 그것부터 짚을 것.
  · 학습량 변화는 필요할 때만 한 문장으로. 수치를 기계적으로 나열하지 말 것.
- 글씨를 알아보기 어렵거나 사진이 흐리면 추측하지 말고 quality에 반영할 것.

[쓰지 말 것 — 지금까지 반복돼 온 상투적 문형]
- "오늘은 ~", "오늘도 ~"로 시작하지 말 것. 첫 문장은 매번 다르게, 그날 가장 눈에 띄는 사실이나
  학생이 적어 둔 메모에서 바로 들어갈 것.
- "칭찬 → 다만 ~해 보자 → 격려"의 3단 구성 금지. '다만'으로 방향을 트는 문장 금지.
- 격려로 끝맺는 습관 금지. "수고 많았어", "든든하다", "이대로 가보자", "정말 대단해",
  "충분히 잘 해낼 거야" 같은 맺음말을 쓰지 말 것. 격려는 할 말이 있을 때만, 구체적인 이유와 함께.
- 남용 금지 어휘: 알차게, 촘촘히, 골고루, 꼼꼼히, 눈에 띄네, 인상적이야, 좋더라, 꾸준함,
  균형 있게, "~한 점이 좋았어".
- "~더라" 어미를 한 코멘트에 두 번 이상 쓰지 말 것.
- 계획 항목을 그대로 옮겨 적는 나열식 문장 금지 — 요약은 summary가 한다.
- 이모티콘, 번호 매기기, 과장된 감탄, "AI"·"분석"·"평가"·"데이터" 같은 단어 금지.

[summary — 선생님만 보는 기록]
- 무슨 과목·교재를 얼마나 계획하고 실행했는지 2~3문장으로 적을 것.
- 마지막에 지도할 때 알아 둘 신호가 보이면 한 문장 덧붙일 것
  (예: 인강 비중이 사흘째 높음 / 수학 오답 정리가 계획에 한 번도 없음 /
   계획이 매번 100% 완료라 분량 상향 여지 / 같은 범위를 3일째 반복).

[stats 추출 규칙]
- 사진이 90도·180도 회전되어 있을 수 있다. 먼저 글자 방향을 파악해 바로 세운 뒤 읽을 것
- 플래너에서 확인되는 것만 기록하고, 확인 불가능한 값은 null(또는 0)로 둘 것
- 과목명은 반드시 주어진 대분류로 매핑할 것 (예: 수학I·미적분→수학, 물리·화학→과학)

[과목별 시간(subjects[].minutes) 계산 — 중요]
많은 플래너에는 오른쪽에 시간대별 타임테이블이 있고, 학생이 공부한 시간만큼 과목별 색으로 칠한다.
이 경우 반드시 색칠을 세어 과목별 시간을 계산할 것. null로 두지 말 것.
1. 색상 범례를 먼저 찾는다 — 보통 표 옆이나 아래에 "수학·영어·국어" 같은 과목명과 색 견본이 함께 있다.
   범례가 없으면 계획 항목 옆에 칠해진 색으로 과목-색 대응을 추정한다.
2. 표 한 줄이 몇 분인지 판단한다. 보통 한 줄 = 1시간이고 그 줄이 여러 칸으로 나뉘어 있다
   (6칸이면 한 칸 10분, 4칸이면 15분, 2칸이면 30분).
3. 색깔별로 칠해진 칸 수를 세어 분으로 환산하고, 같은 색끼리 합쳐 과목별 minutes에 넣는다.
4. 검산: 과목별 합계가 플래너에 적힌 TOTAL TIME(총 학습시간)과 크게 어긋나면 칸 단위를 다시 판단한다.
   부분적으로만 칠해진 칸은 반 칸으로 세지 말고 칠해진 것으로 센다.
5. 타임테이블 자체가 없거나 색칠이 전혀 없을 때만 minutes를 null로 둔다.
- total_minutes: 플래너에 총 학습시간이 적혀 있으면 그 값을 우선 사용하고,
  없으면 위에서 센 과목별 시간의 합을 쓴다.

[시간대별 기록(hourly) — 위에서 센 색칠을 시간대별로도 남길 것]
- 타임테이블의 각 줄이 몇 시인지 읽고, 그 시간대에 칠해진 과목과 분을 hourly에 넣는다.
- hour 는 24시간제 정수(오후 6시=18, 오후 9시=21, 자정=0, 새벽 1시=1).
  오전/오후 표기가 없으면 [지금의 운영 상황]에 따라 저녁 이후로 판단한다
  (표가 6부터 시작해도 실제 자습은 18시 이후이며, 12 다음에 1,2가 이어지면 그것은 자정·새벽 1,2시다).
- 한 시간대에 두 과목이 칠해져 있으면 각각 따로 항목을 만든다.
- 각 항목의 minutes 합은 subjects[].minutes 합과 일치해야 한다.
- 타임테이블이 없거나 시간대를 못 읽으면 hourly 는 빈 배열로 둔다.
- materials: 플래너에 적힌 교재·인강을 각각 하나의 항목으로 뽑을 것
  · name 은 페이지·범위·분량을 뺀 순수 이름으로 정규화 (예: "자이스토리 21년 3회 26~29p" → "자이스토리",
    "화이트라벨 24~31p" → "화이트라벨", "어휘끝 34~38 암기" → "어휘끝")
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
              name: { type: 'string', description: '분량·페이지를 뺀 교재/강좌 이름' },
              kind: { type: 'string', enum: ['문제집', '인강', '학원', '기타'] },
              subject: { type: 'string', enum: ['국어', '수학', '영어', '과학', '사회', '한국사', '제2외국어', '기타'] }
            },
            required: ['name', 'kind', 'subject'],
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

// 같은 학생의 이전 검사 기록(최근 4건) — "지난번보다 늘었다/줄었다" 비교 근거로 프롬프트에 넣는다.
// ★최근 3건은 그때 준 '코멘트'까지 함께 넣는다. 이게 없으면 모델은 매번 처음 보는 학생처럼
//   같은 지적("저녁 초반에 배치해 보자")을 무한 반복한다 — 코멘트가 형식적으로 느껴진 주된 원인.
async function plannerAiHistory(seat, beforeDate) {
  try {
    const hs = await db.collection('planner_ai_reviews').where('seat', '==', seat).get();
    const list = hs.docs.map(d => d.data())
      .filter(v => v.status === 'done' && v.date && v.date < beforeDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 4);
    if (!list.length) return '';
    const lines = list.map((h, i) => {
      const st = h.stats || {};
      const subj = (st.subjects || []).map(s => s.name + (s.minutes != null ? ` ${s.minutes}분` : '')).join(', ');
      const parts = [h.quality || ''];
      if (st.total_minutes != null) parts.push(`총 ${st.total_minutes}분`);
      if (subj) parts.push(subj);
      let line = `- ${h.date}: ${parts.filter(Boolean).join(', ')} — ${h.summary || ''}`;
      if (i < 3 && h.comment) line += `\n  · 그날 준 코멘트: "${String(h.comment).slice(0, 400)}"`;
      return line;
    });
    return '\n\n[이전 검사 기록 — 최근순]\n' + lines.join('\n') +
      '\n※ 위 코멘트에서 이미 한 지적·제안은 되풀이하지 말 것. 그 제안을 오늘 실행한 흔적이 보이면 그것부터 짚을 것.';
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
  } catch (e) {
    logger.warn('plannerAiStudentCtx 조회 실패', { seat, message: e.message });
  }
  return bits.length ? ' / ' + bits.join(' / ') : '';
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

      await reviewRef.set({ seat, date: dateStr, name: req.name || null, status: 'running', startedAt: new Date().toISOString() }, { merge: true });

      const res = await fetch(url);
      if (!res.ok) throw new Error(`사진 다운로드 실패 (HTTP ${res.status})`);
      let buf = Buffer.from(await res.arrayBuffer());
      let mediaType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];

      // 요즘 폰 사진은 10MB를 예사로 넘는데 Claude API 이미지 상한이 10MB다(2026-07-21 23번 실패).
      // 어차피 긴 변 1568px를 넘으면 API가 내부적으로 축소하므로 미리 줄여도 판독 품질 손해가
      // 없고, 용량·메모리·비용·지연이 모두 줄어든다.
      // ⚠️ .rotate()는 생략 금지 — sharp는 출력 시 EXIF를 버리므로, 방향 태그를 미리 픽셀에
      //    반영해 두지 않으면 오히려 눕거나 뒤집힌 사진이 모델에 전달된다.
      try {
        const meta = await sharp(buf).metadata();
        if (Math.max(meta.width || 0, meta.height || 0) > 1568 || buf.length > 4 * 1024 * 1024) {
          buf = await sharp(buf).rotate()
            .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 }).toBuffer();
          mediaType = 'image/jpeg';
        }
      } catch (e) {
        logger.warn('사진 축소 실패 — 원본으로 진행', { seat, date: dateStr, message: e.message });
      }
      // 상한 10MB는 base64 문자열 길이 기준이다(원본 7.9MB가 base64로 10.5MB가 되어 거부됐음).
      // 원본 바이트로 재면 통과할 것처럼 보이니 주의.
      const b64 = buf.toString('base64');
      if (b64.length > 10 * 1024 * 1024) throw new Error('사진이 너무 큽니다 — 축소 후에도 10MB를 넘습니다');

      // 모델/프롬프트 덮어쓰기(선택) — ai_config/planner { model, prompt }
      const cfgSnap = await db.collection('ai_config').doc('planner').get();
      const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
      const model = cfg.model || PLANNER_AI_MODEL;
      const sysPrompt = cfg.prompt || PLANNER_AI_PROMPT;

      const [history, stuCtx] = await Promise.all([
        plannerAiHistory(seat, dateStr),
        plannerAiStudentCtx(seat, dateStr)
      ]);

      const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
      const msg = await client.messages.create({
        model,
        max_tokens: 2048,
        system: sysPrompt,
        output_config: { format: { type: 'json_schema', schema: PLANNER_AI_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: `학생: ${req.name || seat + '번'}${stuCtx} / 학습일: ${dateStr}(${'일월화수목금토'[new Date(dateStr).getDay()]})\n이 플래너를 검사하고 결과를 작성해 주세요.${history}` }
          ]
        }]
      });

      if (msg.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 못했습니다(refusal)');
      const text = (msg.content.find(b => b.type === 'text') || {}).text || '';
      const out = JSON.parse(text);

      await reviewRef.set({
        seat, date: dateStr, name: req.name || null,
        status: 'done',
        quality: out.quality, summary: out.summary, comment: out.comment,
        stats: out.stats || null,
        model,
        usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
        doneAt: new Date().toISOString()
      });
      logger.info('plannerAiReview 완료', { seat, date: dateStr, quality: out.quality });
    } catch (e) {
      logger.error('plannerAiReview', { seat, date: dateStr, message: e.message });
      await reviewRef.set({ seat: seat || null, date: dateStr || null, status: 'error', error: e.message, doneAt: new Date().toISOString() }, { merge: true });
    } finally {
      await snap.ref.delete().catch(() => {});   // 요청 문서는 1회용 — 처리 후 정리
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
async function fetchGatewayDns(minutes, debug) {
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
  const hourly = (acct.byHour || []).map(row => ({
    hour: row.dimensions && row.dimensions.datetimeHour,
    count: row.count
  }));

  // 진단용: 도메인×판정 원본(상위 60행). resolverDecision 숫자의 의미를 실측할 때 쓴다.
  const rawRows = !debug ? undefined : (acct.byDomain || []).slice(0, 60).map(row => ({
    domain: unreverseDomain(row.dimensions && row.dimensions.queryNameReversed),
    decision: row.dimensions && row.dimensions.resolverDecision,
    count: row.count
  }));

  return {
    minutes,
    domains,
    decisions,
    unknownDecisions,
    rawRows,
    hourly,
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
      const out = await fetchGatewayDns(minutes, !!b.debug);
      res.json({ ok: true, ...out });
    } catch (e) {
      logger.error('[Gateway] 조회 실패', e);
      res.status(e.graphql ? 502 : 500).json({ error: String((e && e.message) || e) });
    }
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
