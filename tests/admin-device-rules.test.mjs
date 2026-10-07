// 관리자 기기 잠금 규칙 확인 (2026-10-07) — 돈·설정은 원장 기기(role:director), 공지·냉난방은 조교 기기(admin)도.
// 실행법은 timer-share-rules.test.mjs 머리말과 같다.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, deleteDoc, addDoc, collection } from 'firebase/firestore';
import { test, after, before } from 'node:test';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-saebom-rules',
    firestore: { rules: readFileSync(process.env.RULES, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });

const admin = () => env.authenticatedContext('admin_device', { role: 'admin' }).firestore();
const director = () => env.authenticatedContext('director_device', { role: 'director' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const parent = () => env.authenticatedContext('p_1', { role: 'parent', sid: 's_1' }).firestore();
const pay = { ym: '2026-10', key: '01012345678', amount: 300000, name: '김새봄' };

test('payments: 쓰기·삭제는 원장 기기만, 읽기는 그대로', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(anon(), 'payments', '2026-10_01012345678'), pay));
  await assertFails(setDoc(doc(admin(), 'payments', '2026-10_01012345678'), pay));
  await assertFails(setDoc(doc(parent(), 'payments', '2026-10_01012345678'), pay));
  await assertSucceeds(setDoc(doc(director(), 'payments', '2026-10_01012345678'), pay));
  await assertSucceeds(getDoc(doc(anon(), 'payments', '2026-10_01012345678')));
  await assertFails(deleteDoc(doc(anon(), 'payments', '2026-10_01012345678')));
  await assertFails(setDoc(doc(director(), 'payments', '2026-10_x'), { ...pay, amount: 0 }));
  await assertFails(deleteDoc(doc(admin(), 'payments', '2026-10_01012345678')));
  await assertSucceeds(deleteDoc(doc(director(), 'payments', '2026-10_01012345678')));
});

test('notices/list: 쓰기는 관리자 기기만', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(anon(), 'notices', 'list'), { items: [{ title: '<img src=x onerror=alert(1)>' }] }));
  await assertFails(setDoc(doc(parent(), 'notices', 'list'), { items: [] }));
  await assertSucceeds(setDoc(doc(admin(), 'notices', 'list'), { items: [] }, { merge: true }));
  await assertSucceeds(setDoc(doc(director(), 'notices', 'list'), { items: [] }, { merge: true }));
  await assertFails(setDoc(doc(admin(), 'notices', 'other'), { items: [] }));
  await assertSucceeds(getDoc(doc(anon(), 'notices', 'list')));
});

test('냉난방: 명령·설정 쓰기는 관리자 기기만', async () => {
  await env.clearFirestore();
  await assertFails(addDoc(collection(anon(), 'ac_commands'), { op: 'power', on: true }));
  await assertSucceeds(addDoc(collection(admin(), 'ac_commands'), { op: 'power', on: true }));
  await assertFails(setDoc(doc(anon(), 'ac_config', 'main'), { x: 1 }));
  await assertSucceeds(setDoc(doc(admin(), 'ac_config', 'main'), { x: 1 }));
  await assertSucceeds(getDoc(doc(anon(), 'ac_config', 'main')));
});

test('settings: 설정 탭 문서는 원장 기기만, 타종·좌석 예약 비우기는 예외', async () => {
  await env.clearFirestore();
  for (const id of ['billing', 'vacation_mode', 'schedule_edit', 'planner_privacy', 'meal_away_sms', 'day_break_door', 'weather', 'solapi']) {
    await assertFails(setDoc(doc(anon(), 'settings', id), { enabled: true }));
    await assertFails(setDoc(doc(admin(), 'settings', id), { enabled: true }));
    await assertSucceeds(setDoc(doc(director(), 'settings', id), { enabled: true }));
  }
  await assertSucceeds(getDoc(doc(anon(), 'settings', 'billing')));
  await assertSucceeds(setDoc(doc(anon(), 'settings', 'bell_schedule'), { times: [] }));
  // 좌석 예약: 원장이 날짜를 걸고, 아무 기기(키오스크)나 반영 뒤 비울 수만 있다
  await assertFails(setDoc(doc(anon(), 'settings', 'seatSelection'), { effectiveDate: '2026-10-10' }));
  await assertSucceeds(setDoc(doc(director(), 'settings', 'seatSelection'), { effectiveDate: '2026-10-10', open: true }));
  await assertFails(setDoc(doc(anon(), 'settings', 'seatSelection'), { open: false }, { merge: true }));
  await assertFails(setDoc(doc(anon(), 'settings', 'seatSelection'), { effectiveDate: '2026-12-01' }, { merge: true }));
  await assertSucceeds(setDoc(doc(anon(), 'settings', 'seatSelection'), { effectiveDate: '' }, { merge: true }));
});

test('자동문은 키오스크가 써야 하므로 그대로 열려 있다', async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(anon(), 'door_commands', 'current'), { action: 'open', seconds: 3 }));
});
