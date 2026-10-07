// 관리자 기기 잠금 규칙 확인 (2026-10-07) — 결제·공지·냉난방·원비 설정 쓰기는 isAdminDevice() 만.
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
const director = () => env.authenticatedContext('director_device', { role: 'admin' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const parent = () => env.authenticatedContext('p_1', { role: 'parent', sid: 's_1' }).firestore();
const pay = { ym: '2026-10', key: '01012345678', amount: 300000, name: '김새봄' };

test('payments: 쓰기·삭제는 관리자 기기만, 읽기는 그대로', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(anon(), 'payments', '2026-10_01012345678'), pay));
  await assertFails(setDoc(doc(parent(), 'payments', '2026-10_01012345678'), pay));
  await assertSucceeds(setDoc(doc(director(), 'payments', '2026-10_01012345678'), pay));
  await assertSucceeds(getDoc(doc(anon(), 'payments', '2026-10_01012345678')));
  await assertFails(deleteDoc(doc(anon(), 'payments', '2026-10_01012345678')));
  await assertFails(setDoc(doc(admin(), 'payments', '2026-10_x'), { ...pay, amount: 0 }));
  await assertSucceeds(deleteDoc(doc(admin(), 'payments', '2026-10_01012345678')));
});

test('notices/list: 쓰기는 관리자 기기만', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(anon(), 'notices', 'list'), { items: [{ title: '<img src=x onerror=alert(1)>' }] }));
  await assertFails(setDoc(doc(parent(), 'notices', 'list'), { items: [] }));
  await assertSucceeds(setDoc(doc(admin(), 'notices', 'list'), { items: [] }, { merge: true }));
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

test('settings/billing(defaultFee): 쓰기는 관리자 기기만, 다른 settings 는 그대로', async () => {
  await env.clearFirestore();
  await assertFails(setDoc(doc(anon(), 'settings', 'billing'), { defaultFee: 100 }));
  await assertSucceeds(setDoc(doc(admin(), 'settings', 'billing'), { defaultFee: 300000 }));
  await assertSucceeds(getDoc(doc(anon(), 'settings', 'billing')));
  await assertSucceeds(setDoc(doc(anon(), 'settings', 'vacation_mode'), { on: false }));
});

test('자동문은 키오스크가 써야 하므로 그대로 열려 있다', async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(anon(), 'door_commands', 'current'), { action: 'open', seconds: 3 }));
});
