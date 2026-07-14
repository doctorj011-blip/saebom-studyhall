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
    offGraceMin: c.offGraceMin != null ? c.offGraceMin : 20,   // 재실0 지속 → OFF 유예
    minOnMin: c.minOnMin != null ? c.minOnMin : 20,            // 최소 운전시간
    manualHoldMin: c.manualHoldMin != null ? c.manualHoldMin : 90, // 수동조작 후 자동보류
    onTemp: c.onTemp != null ? c.onTemp : 24,
    onMode: c.onMode || 'COOL', onFan: c.onFan || 'AUTO',
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
function _kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }   // 함수 런타임 UTC → KST
// 앱들과 동일: (KST-3h)의 날짜를 zero-padded YYYY-MM-DD 로. (studyroom_requests.date 형식)
function _srDayKey(date) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 재실/사용 판정 ----------
// 현재 재실 학생 이름 집합 — 최근 18시간 checkin_logs를 학생별 마지막 이벤트로 판정(마지막이 'in').
async function acPresentNames() {
  const since = Date.now() - 18 * 3600 * 1000;
  const snap = await db.collection('checkin_logs').where('ts', '>=', since).get();
  const last = new Map();
  snap.forEach(d => {
    const x = d.data();
    if (x.away === true || !x.studentName || typeof x.ts !== 'number') return;
    const cur = last.get(x.studentName);
    if (!cur || x.ts > cur.ts) last.set(x.studentName, { type: x.type, ts: x.ts });
  });
  const set = new Set();
  last.forEach((v, name) => { if (v.type === 'in') set.add(name); });
  return set;
}
// 스터디룸별 사용 여부 — 오늘 배정(approved)된 학생 중 현재 재실자가 있으면 사용 중.
async function acStudyroomOccupancy(present, kstDate) {
  const key = _srDayKey(kstDate);
  const snap = await db.collection('studyroom_requests')
    .where('date', '==', key).where('status', '==', 'approved').get();
  const byRoom = {};
  snap.forEach(d => {
    const x = d.data(); const room = String(x.room || '').trim();
    if (!room) return; (byRoom[room] = byRoom[room] || new Set()).add(x.name);
  });
  const occ = {};
  Object.keys(byRoom).forEach(room => { occ[room] = [...byRoom[room]].some(n => present.has(n)); });
  return occ;
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

// ---------- 자동화 핵심 ----------
async function acEvaluate(reason) {
  const cfg = await acConfig();
  const zoneIds = Object.keys(cfg.zones || {});
  if (!zoneIds.length) return;   // 아직 에어컨↔공간 매핑 전이면 아무것도 안 함
  const now = _kstNow();
  const nowMs = Date.now();
  const present = await acPresentNames();
  const anyPresent = present.size > 0;
  const srOcc = await acStudyroomOccupancy(present, now);
  const op = _withinOp(cfg, now);

  const ref = db.collection('ac_state').doc('main');
  const stSnap = await ref.get();
  const zoneState = (stSnap.exists && stSnap.data().zones) || {};
  const out = {};

  for (const deviceId of zoneIds) {
    const z = cfg.zones[deviceId] || {};
    const zs = Object.assign({}, zoneState[deviceId]);
    const occupied = z.type === 'studyroom' ? !!srOcc[String(z.room)] : anyPresent;
    zs.occupied = occupied;

    // 자동 꺼짐 or 수동 보류 중이면 자동 전환은 건너뛰고 상태만 기록
    const held = zs.manualUntil && zs.manualUntil > nowMs;
    if (cfg.auto === false || held) { zs.emptySince = occupied ? null : (zs.emptySince || nowMs); out[deviceId] = zs; continue; }

    let desiredOn;
    if (!op) { desiredOn = false; zs.emptySince = null; }
    else if (occupied) { desiredOn = true; zs.emptySince = null; }
    else {
      if (!zs.emptySince) zs.emptySince = nowMs;
      const emptyMin = (nowMs - zs.emptySince) / 60000;
      const onMin = zs.lastOnTs ? (nowMs - zs.lastOnTs) / 60000 : 1e9;
      desiredOn = (emptyMin >= cfg.offGraceMin && onMin >= cfg.minOnMin) ? false : (zs.on === true);
    }

    if (desiredOn !== (zs.on === true)) {
      try {
        await acExecute(cfg, deviceId, { operation: { airConOperationMode: desiredOn ? 'POWER_ON' : 'POWER_OFF' } });
        if (desiredOn) {   // 켤 때 기본 모드·온도도 적용(실패해도 무시)
          await acExecute(cfg, deviceId, { airConJobMode: { currentJobMode: cfg.onMode } }).catch(() => {});
          await acExecute(cfg, deviceId, { temperature: { targetTemperature: cfg.onTemp } }).catch(() => {});
          zs.lastOnTs = nowMs;
        }
        zs.on = desiredOn;
        logger.info('AC 자동전환', { deviceId, zone: z.name, desiredOn, occupied, op, reason });
      } catch (e) {
        logger.error('AC 자동전환 실패', { deviceId, message: e.message });
        zs.error = e.message;
      }
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
        const payload = c.body || acPayload(c.command, c.value);
        if (payload) await acExecute(cfg, c.deviceId, payload);
        const holdMs = (c.holdMin != null ? c.holdMin : cfg.manualHoldMin) * 60000;
        await db.collection('ac_state').doc('main')
          .set({ zones: { [c.deviceId]: { manualUntil: Date.now() + holdMs } } }, { merge: true });
        await acRefreshState([c.deviceId]);
      }
      await snap.ref.set({ done: true, doneAt: new Date().toISOString() }, { merge: true });
    } catch (e) {
      logger.error('acOnCommand', { message: e.message });
      await snap.ref.set({ error: e.message, doneAt: new Date().toISOString() }, { merge: true });
    }
  }
);
