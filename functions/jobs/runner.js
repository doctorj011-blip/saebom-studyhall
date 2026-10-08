'use strict';
/*
 * 관리앱 자동 작업을 서버에서 돌리는 실행기.
 *
 * legacy.src.js(관리앱에서 그대로 잘라 온 코드, extract.mjs 가 만든다)를 node:vm 안에서 실행한다.
 * 브라우저 대신 넣어 주는 것: window(=vm 전역)·db·Firestore 함수(fsCompat, admin 권한)·
 * 명부(STUDENTS)·재실자(PRESENT)·화면 함수 빈껍데기·메모리 localStorage.
 *
 * 서버는 '늘 켜져 있는 기기 하나'로 끼어드는 것이다. 이 작업들은 원래 키오스크 2대와 가끔 켜는
 * 관리 PC 가 동시에 돌려도 되게 만들어져 있다(완료 표시·고정 문서 ID·트랜잭션). 그래서 기기 쪽
 * 코드를 끄지 않아도 중복 부과가 생기지 않고, 키오스크가 꺼져 있던 밤에도 작업이 돈다.
 *
 * ⚠️ 관리앱 시각 계산이 전부 '기기 현지 시각'이라 한국 시각으로 맞춘다(process.env.TZ).
 *    함수마다 따로 뜨는 인스턴스라 다른 함수(에어컨 등)의 시각 계산에는 영향이 없다.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const fsc = require('./fsCompat');

const SCRIPT = new vm.Script(fs.readFileSync(path.join(__dirname, 'legacy.src.js'), 'utf8'), { filename: 'legacy.src.js' });
const FS_FUNCS = ['doc', 'collection', 'query', 'where', 'orderBy', 'limit', 'startAfter', 'getDoc', 'getDocs', 'setDoc', 'updateDoc',
  'deleteDoc', 'runTransaction', 'writeBatch', 'serverTimestamp', 'deleteField', 'increment', 'getCountFromServer', 'onSnapshot'];

/** 작업 하나를 돌릴 새 환경. 매번 새로 만든다(관리앱 탭 하나를 새로 연 것과 같다). */
async function makeEnv(firestore, log = console) {
  process.env.TZ = 'Asia/Seoul';
  const store = new Map();
  const fsFns = Object.fromEntries(FS_FUNCS.map((k) => [k, fsc[k]]));
  const db = fsc.makeDb(firestore || admin.firestore());
  const ctx = {
    console: log, setTimeout, clearTimeout, setInterval: () => 0, crypto: globalThis.crypto, TextEncoder,
    ...fsFns, db,
    STUDENTS: [], PRESENT: [], DOOR_DEVICE_ID: 'cloud-fn',
    showAdminToast: (m) => log.log('[관리앱 알림]', m),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: { getElementById: () => null },
    buildFloorplan() {}, buildDashboard() {}, buildHoursTable() {}, _resetLocalAfterDailyReset() {},
  };
  ctx.window = ctx;
  ctx._adminDb = db;
  ctx._fs = fsFns;
  ctx.waitDb = async () => db;
  vm.createContext(ctx);
  SCRIPT.runInContext(ctx);
  await vm.runInContext('__loadStudents()', ctx);
  // 재실 중인 학생 = current_sessions 포인터(문서 ID 가 학생 이름). 자동 퇴원이 재실자를 건너뛰는 데 쓴다.
  const ptr = await (firestore || admin.firestore()).collection('current_sessions').get();
  ptr.forEach((d) => ctx.PRESENT.push((d.data() || {}).studentName || d.id));
  return ctx;
}

/** 이름 순서대로 하나씩 돌린다 — 하나가 실패해도 나머지는 돈다. 결과를 이름별로 돌려준다. */
async function runJobs(names, { firestore, log = console } = {}) {
  const env = await makeEnv(firestore, log);
  const out = {};
  for (const name of names) {
    const fn = env[name] || env.window[name];
    if (typeof fn !== 'function') { out[name] = 'missing'; log.error('[자동작업] 없음:', name); continue; }
    const t0 = Date.now();
    try {
      const r = await fn.call(env);
      out[name] = { ok: true, ms: Date.now() - t0, ...(r !== undefined ? { result: r } : {}) };
    } catch (e) {
      out[name] = { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
      log.error('[자동작업] 실패:', name, e);
    }
  }
  return out;
}

// 당일 벌점 판정 시점: 교시 끝 + 15분(입력 지연 여유) + 20분(중간입실 유예) — 관리앱 assessNoShowIntraday 와 같은 값.
// 5분마다 깨어나되, 방금(지난 6분 안에) 판정 가능해진 교시가 있을 때만 실제로 돌린다.
// 몇 번 놓쳐도 새벽 2시 최종 판정(assessNoShowPenalties)이 그날 전체를 다시 본다.
const PERIOD_END_MIN = [600, 670, 750, 870, 940, 1020, 1130, 1220, 1320, 1430, 1500];
function intradayDue(now = Date.now()) {
  process.env.TZ = 'Asia/Seoul';
  const d = new Date(now);
  if (d.getHours() < 2) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  if (d.getDay() === 0) return false;                     // 일요일 휴관
  const mins = (now - d.getTime()) / 60000;
  return PERIOD_END_MIN.some((e) => { const r = e + 15 + 20; return mins >= r && mins < r + 6; });
}

module.exports = { makeEnv, runJobs, intradayDue };
