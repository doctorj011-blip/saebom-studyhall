// penalty_appeals 규칙 확인 (2026-10-08) — 실행법은 timer-share-rules.test.mjs 머리말과 같다.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore';
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
const ID = '2026-10-08_27_3';
const student = (sid) => env.authenticatedContext('u_' + sid, { role: 'student', sid }).firestore();
const parent = (sids) => env.authenticatedContext('p_1', { role: 'parent', sids }).firestore();
const admin = () => env.authenticatedContext('admin', { role: 'admin' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const appeal = { uid: A, name: '김새봄', reason: '병원', status: 'pending', decisionNote: '' };

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'penalty_appeals', ID), appeal));
}

test('본인·그 학부모·관리자만 읽는다', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(student(A), 'penalty_appeals', ID)));
  await assertSucceeds(getDoc(doc(parent([B, A]), 'penalty_appeals', ID)));
  await assertSucceeds(getDoc(doc(admin(), 'penalty_appeals', ID)));
  await assertSucceeds(getDocs(query(collection(student(A), 'penalty_appeals'), where('uid', '==', A))));
  await assertFails(getDoc(doc(student(B), 'penalty_appeals', ID)));
  await assertFails(getDoc(doc(anon(), 'penalty_appeals', ID)));
  await assertFails(getDocs(collection(student(A), 'penalty_appeals')));
});

test('앱은 못 쓰고, 관리자는 판정 필드만 고친다', async () => {
  await seed();
  await assertFails(setDoc(doc(student(A), 'penalty_appeals', 'x'), appeal));
  await assertFails(updateDoc(doc(student(A), 'penalty_appeals', ID), { status: 'accepted' }));
  await assertSucceeds(updateDoc(doc(admin(), 'penalty_appeals', ID), { status: 'rejected', decisionNote: '증빙 부족' }));
  await assertFails(updateDoc(doc(admin(), 'penalty_appeals', ID), { reason: '바꿈' }));
  await assertFails(updateDoc(doc(admin(), 'penalty_appeals', ID), { status: 'weird' }));
  await assertFails(deleteDoc(doc(admin(), 'penalty_appeals', ID)));
});
