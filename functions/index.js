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
 *   · 운영시간(opStart~opEnd) 밖에는 항상 OFF
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
    offGraceMin: c.offGraceMin != null ? c.offGraceMin : 20,   // 무인 지속 → 절전(setback) 전환 유예
    hardOffMin: c.hardOffMin != null ? c.hardOffMin : 60,      // 무인 지속 → 완전 OFF (2단 공실 2단계)
    minOnMin: c.minOnMin != null ? c.minOnMin : 20,            // 최소 운전시간(완전 OFF 억제)
    manualHoldMin: c.manualHoldMin != null ? c.manualHoldMin : 60, // 수동조작 후 자동보류(분)
    onTemp: c.onTemp != null ? c.onTemp : 24,
    setbackTemp: c.setbackTemp != null ? c.setbackTemp : 28,   // 절전(무인/마감여열) 시 목표온도 — 압축기 idle
    preCloseMin: c.preCloseMin != null ? c.preCloseMin : 20,   // 마감 전 여열 coast 시작(냉방 중단)
    lateAfter: c.lateAfter || '23:50',                         // 이 시각 이후: zone 인원 lateMinCount 미만이면 OFF
    lateMinCount: c.lateMinCount != null ? c.lateMinCount : 2, // 마감 임박 시 zone 유지 최소 인원
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
function _withinOp(cfg, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = _hhmm(cfg.opStart);
  let end = _hhmm(cfg.opEnd); if (end === 0) end = 24 * 60;   // '24:00'
  return start <= end ? (now >= start && now < end) : (now >= start || now < end);
}
// 마감(opEnd)까지 남은 분. 운영시간 밖이면 null.
function _minsUntilOpEnd(cfg, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = _hhmm(cfg.opStart);
  let end = _hhmm(cfg.opEnd); if (end === 0) end = 24 * 60;
  if (start <= end) return (now >= start && now < end) ? end - now : null;
  if (now >= start) return (24 * 60 - now) + end;   // 자정 넘김 운영: 익일 end까지
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
  const minsToClose = _minsUntilOpEnd(cfg, now);
  const preClose = minsToClose != null && minsToClose <= cfg.preCloseMin;   // ⑤ 마감 여열 coast 구간
  // 마감 임박 구간: opEnd - lateAfter 만큼 남았을 때부터. (남은시간으로 계산해 자정경계·오버나잇 안전)
  let _opEndMin = _hhmm(cfg.opEnd); if (_opEndMin === 0) _opEndMin = 24 * 60;
  const lateWinMin = Math.max(0, _opEndMin - _hhmm(cfg.lateAfter));
  const late = minsToClose != null && minsToClose <= lateWinMin;   // ⑥ 소수인원 zone OFF 구간

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
    //   [열람실]  마감 임박(late)+인원<lateMinCount → OFF · 재실 → 냉방(마감구간 setback) · 무인 2단(offGrace→setback→hardOff)
    let profile;   // { power, mode?, temp?, fan? }
    if (!op) { profile = { power: false }; zs.emptySince = null; }
    else if (isSr) { profile = srProf.profile; }
    else if (late && count < cfg.lateMinCount) { profile = { power: false }; zs.emptySince = null; }
    else if (occupied) {
      zs.emptySince = null;
      profile = preClose ? { power: true, mode: cfg.onMode, temp: cfg.setbackTemp }
                         : { power: true, mode: cfg.onMode, temp: cfg.onTemp };
    } else {
      if (!zs.emptySince) zs.emptySince = nowMs;
      const emptyMin = (nowMs - zs.emptySince) / 60000;
      const onMin = zs.lastOnTs ? (nowMs - zs.lastOnTs) / 60000 : 1e9;
      if (emptyMin >= cfg.hardOffMin && onMin >= cfg.minOnMin) profile = { power: false };
      else if (emptyMin >= cfg.offGraceMin || preClose) profile = { power: true, mode: cfg.onMode, temp: cfg.setbackTemp };
      else profile = { power: true, mode: cfg.onMode, temp: cfg.onTemp };   // 유예 중: 냉방 유지
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
  await ref.set({ zones: out, present: present.size, op, auto: cfg.auto, updatedAt: now.toISOString() }, { merge: true });
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
