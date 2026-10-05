// avatar_profiles 규칙 확인 (2026-10-05, 면학시상대 캐릭터 꾸미기)
//
// 실행: timer-share-rules.test.mjs 머리말과 같다(파일 이름만 바꿔서).
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
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
const student = (sid) => env.authenticatedContext('u_' + sid, { role: 'student', sid }).firestore();
const parent = (sid) => env.authenticatedContext('p_1', { role: 'parent', sid }).firestore();
const look = (extra = {}) => ({ gender: 'f', skin: 0, hair: 'ponytail', hairColor: 1, face: 'blush', updatedAt: serverTimestamp(), ...extra });

test('본인 것만 쓸 수 있다', async () => {
  await env.clearFirestore();
  await assertSucceeds(setDoc(doc(student(A), 'avatar_profiles', A), look()));
  await assertFails(setDoc(doc(student(A), 'avatar_profiles', B), look()));
  await assertFails(setDoc(doc(parent(A), 'avatar_profiles', A), look()));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'avatar_profiles', A), look()));
  // sid 가 빈 학생(본인 미확정 계정)
  await assertFails(setDoc(doc(student(''), 'avatar_profiles', 's_x'), look()));
});

test('정해진 값만 들어간다', async () => {
  await env.clearFirestore();
  const db = student(A);
  await assertFails(setDoc(doc(db, 'avatar_profiles', A), look({ gender: 'x' })));
  await assertFails(setDoc(doc(db, 'avatar_profiles', A), look({ skin: '0' })));
  await assertFails(setDoc(doc(db, 'avatar_profiles', A), look({ name: '김새봄' })));
  await assertFails(setDoc(doc(db, 'avatar_profiles', A), look({ hair: 'x'.repeat(21) })));
});

test('읽기는 누구나(시상대에 다른 학생 캐릭터가 보인다)', async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => { await setDoc(doc(c.firestore(), 'avatar_profiles', A), look()); });
  await assertSucceeds(getDoc(doc(student(B), 'avatar_profiles', A)));
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'avatar_profiles', A)));
});
