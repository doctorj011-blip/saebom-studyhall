// point_wallets · avatar_outfits 규칙 확인 (2026-10-05, 순공 포인트·아이템샵)
//
// 실행: timer-share-rules.test.mjs 머리말과 같다(파일 이름만 바꿔서).
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore';
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
const anon = () => env.unauthenticatedContext().firestore();

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, 'point_wallets', A), { balance: 300, owned: ['cap'] });
    await setDoc(doc(db, 'point_wallets', A, 'entries', 'sess_1'), { kind: 'earn', amount: 150 });
    await setDoc(doc(db, 'avatar_outfits', A), { outfit: { top: 'tee_white', hat: 'cap' } });
  });
}

test('지갑·내역: 본인과 학부모만 읽는다', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(student(A), 'point_wallets', A)));
  await assertSucceeds(getDocs(collection(student(A), 'point_wallets', A, 'entries')));
  await assertSucceeds(getDoc(doc(parent(A), 'point_wallets', A)));
  await assertFails(getDoc(doc(student(B), 'point_wallets', A)));
  await assertFails(getDocs(collection(student(B), 'point_wallets', A, 'entries')));
  await assertFails(getDoc(doc(anon(), 'point_wallets', A)));
});

test('지갑·내역·옷: 학생은 아무것도 못 쓴다(서버만)', async () => {
  await seed();
  await assertFails(updateDoc(doc(student(A), 'point_wallets', A), { balance: 99999 }));
  await assertFails(setDoc(doc(student(A), 'point_wallets', A, 'entries', 'x'), { kind: 'earn', amount: 999 }));
  await assertFails(setDoc(doc(student(A), 'avatar_outfits', A), { outfit: { aura: 'aura_gold' } }));
});

test('입은 옷은 누구나 읽는다(시상대)', async () => {
  await seed();
  await assertSucceeds(getDoc(doc(student(B), 'avatar_outfits', A)));
  await assertSucceeds(getDoc(doc(anon(), 'avatar_outfits', A)));
});
