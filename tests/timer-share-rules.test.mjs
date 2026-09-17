// timer_share · timer_daily 규칙 확인 (2026-09-17)
//
// 실행(에뮬레이터 필요 — Java 21, @firebase/rules-unit-testing + firebase 가 설치된 node_modules):
//   export JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH
//   RULES=$PWD/firestore.rules NODE_PATH=~/새봄/saebom-grader/node_modules \
//     firebase emulators:exec --project demo-saebom-rules --only firestore \
//     "node --test tests/timer-share-rules.test.mjs"
// (ESM 은 NODE_PATH 를 안 보므로 실제로는 이 파일을 node_modules 가 있는 폴더 옆에 두거나
//  tests/node_modules 를 그 폴더로 링크해서 돌린다: ln -s ~/새봄/saebom-grader/node_modules tests/node_modules)
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
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
const parentOne = (sid) => env.authenticatedContext('p_1', { role: 'parent', sid }).firestore();
const parentMany = (sids) => env.authenticatedContext('p_2', { role: 'parent', students: sids.map(s => ({ sid: s })), sids }).firestore();
const oldParentMany = () => env.authenticatedContext('p_3', { role: 'parent', students: [{ sid: A }, { sid: B }] }).firestore();
const day = (sid, date, extra = {}) => ({ sid, name: '김새봄', date, totalMin: 95, bySubject: { 수학: 60, 영어: 35 }, updatedAt: serverTimestamp(), ...extra });

async function reset() { await env.clearFirestore(); }

test('공유를 켜기 전에는 기록을 못 올린다', async () => {
  await reset();
  const db = student(A);
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17')));
  await assertSucceeds(setDoc(doc(db, 'timer_share', A), { sid: A, on: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17')));
});

test('남의 sid·틀린 문서ID·이상한 값은 막힌다', async () => {
  await reset();
  await env.withSecurityRulesDisabled(async c => {
    await setDoc(doc(c.firestore(), 'timer_share', A), { sid: A, on: true });
    await setDoc(doc(c.firestore(), 'timer_share', B), { sid: B, on: true });
  });
  const db = student(A);
  await assertFails(setDoc(doc(db, 'timer_share', B), { sid: B, on: false }));
  await assertFails(setDoc(doc(db, 'timer_daily', `${B}_2026-09-17`), day(B, '2026-09-17')));
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_2026-09-18`), day(A, '2026-09-17')));
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17', { totalMin: 2000 })));
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17', { totalMin: 1.5 })));
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17', { note: 'x' })));
  await assertFails(setDoc(doc(db, 'timer_daily', `${A}_17-09-2026`), day(A, '17-09-2026')));
  // sid 가 빈 학생(본인 미확정 계정)
  await assertFails(setDoc(doc(student(''), 'timer_share', 's_x'), { sid: 's_x', on: true }));
});

test('학부모는 자기 자녀 것만 읽고, 아무것도 못 쓴다', async () => {
  await reset();
  await env.withSecurityRulesDisabled(async c => {
    const f = c.firestore();
    await setDoc(doc(f, 'timer_share', A), { sid: A, on: true });
    await setDoc(doc(f, 'timer_share', B), { sid: B, on: true });
    await setDoc(doc(f, 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17', { updatedAt: 1 }));
    await setDoc(doc(f, 'timer_daily', `${B}_2026-09-17`), day(B, '2026-09-17', { updatedAt: 1 }));
  });
  const one = parentOne(A);
  await assertSucceeds(getDoc(doc(one, 'timer_share', A)));
  await assertSucceeds(getDocs(query(collection(one, 'timer_daily'), where('sid', '==', A), where('date', '>=', '2026-09-10'))));
  await assertFails(getDoc(doc(one, 'timer_share', B)));
  await assertFails(getDocs(query(collection(one, 'timer_daily'), where('sid', '==', B))));
  await assertFails(getDocs(collection(one, 'timer_daily'))); // 전체 목록
  await assertFails(setDoc(doc(one, 'timer_share', A), { sid: A, on: false }));
  await assertFails(deleteDoc(doc(one, 'timer_daily', `${A}_2026-09-17`)));

  const many = parentMany([A, B]);
  await assertSucceeds(getDocs(query(collection(many, 'timer_daily'), where('sid', '==', B))));
  await assertSucceeds(getDoc(doc(many, 'timer_share', A)));
  // sids 클레임이 없는 옛 형제 학부모 토큰 — 다시 로그인하기 전까지는 못 읽는다(안전한 쪽).
  await assertFails(getDocs(query(collection(oldParentMany(), 'timer_daily'), where('sid', '==', A))));
});

test('학생은 자기 기록을 지울 수 있고(공유 끄기), 스위치 문서는 못 지운다', async () => {
  await reset();
  await env.withSecurityRulesDisabled(async c => {
    await setDoc(doc(c.firestore(), 'timer_share', A), { sid: A, on: true });
    await setDoc(doc(c.firestore(), 'timer_daily', `${A}_2026-09-17`), day(A, '2026-09-17', { updatedAt: 1 }));
  });
  const db = student(A);
  await assertSucceeds(getDocs(query(collection(db, 'timer_daily'), where('sid', '==', A))));
  await assertSucceeds(setDoc(doc(db, 'timer_share', A), { sid: A, on: false, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, 'timer_daily', `${A}_2026-09-17`)));
  await assertFails(deleteDoc(doc(db, 'timer_share', A)));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'timer_share', A)));
});

test('기존 컬렉션은 그대로 — push_tokens 는 여전히 읽기 불가', async () => {
  await reset();
  await assertFails(getDoc(doc(student(A), 'push_tokens', 'x')));
});
