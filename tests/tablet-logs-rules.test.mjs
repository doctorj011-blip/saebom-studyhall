// tablet_logs 규칙 확인 (2026-10-08) — 실행법은 timer-share-rules.test.mjs 머리말과 같다.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, deleteDoc, collection, query, where, getDocs, arrayUnion } from 'firebase/firestore';
import { test, after, before } from 'node:test';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-saebom-rules',
    firestore: { rules: readFileSync(process.env.RULES, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });

const A = 's_aaaaaaaa', B = 's_bbbbbbbb';
const ID = `${A}_2026-10-08`;
const student = (sid) => env.authenticatedContext('u_' + sid, { role: 'student', sid }).firestore();
const parent = (sids) => env.authenticatedContext('p_1', { role: 'parent', sids }).firestore();
const admin = () => env.authenticatedContext('admin', { role: 'admin' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const log = (ev) => ({ uid: A, name: '김새봄', seat: '27', date: '2026-10-08', updatedAt: 1, events: arrayUnion(ev) });

test('관리자 기기만 쓰고, 문서ID 는 uid_날짜', async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(admin(), 'tablet_logs', ID), log({ type: 'out', at: 1 }), { merge: true }));
  await assertSucceeds(setDoc(doc(admin(), 'tablet_logs', ID), log({ type: 'in', at: 2 }), { merge: true }));
  await assertFails(setDoc(doc(admin(), 'tablet_logs', `${B}_2026-10-08`), log({ type: 'out', at: 1 })));
  await assertFails(setDoc(doc(admin(), 'tablet_logs', ID), { ...log({ type: 'out', at: 1 }), x: 1 }));
  await assertFails(setDoc(doc(student(A), 'tablet_logs', ID), log({ type: 'in', at: 3 }), { merge: true }));
  await assertFails(setDoc(doc(anon(), 'tablet_logs', ID), log({ type: 'in', at: 3 })));
  await assertFails(deleteDoc(doc(admin(), 'tablet_logs', ID)));
});

test('본인·그 학부모·관리자만 읽는다', async () => {
  await assertSucceeds(getDoc(doc(student(A), 'tablet_logs', ID)));
  await assertSucceeds(getDocs(query(collection(parent([B, A]), 'tablet_logs'), where('uid', '==', A))));
  await assertSucceeds(getDoc(doc(admin(), 'tablet_logs', ID)));
  await assertFails(getDoc(doc(student(B), 'tablet_logs', ID)));
  await assertFails(getDocs(query(collection(parent([B]), 'tablet_logs'), where('uid', '==', A))));
  await assertFails(getDoc(doc(anon(), 'tablet_logs', ID)));
});
