// billing_notices 규칙 확인 (2026-09-28) — 확인 도장 뒤에는 할인이 '늘어나는' 수정만 된다.
// 실행법은 timer-share-rules.test.mjs 머리말과 같다.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc } from 'firebase/firestore';
import { test, after, before } from 'node:test';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-saebom-rules',
    firestore: { rules: readFileSync(process.env.RULES, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });

const ID = '2026-10__s_aaaaaaaa';
const bill = (won, extra = {}) => ({ billId: '2026-10', name: '김새봄', won, base: 300000, pay: 300000 - won, estimate: true, ...extra });

test('확인 뒤: 할인 증가는 되고 감소는 막힌다', async () => {
  await env.clearFirestore();
  const db = env.unauthenticatedContext().firestore();
  await assertSucceeds(setDoc(doc(db, 'billing_notices', ID), bill(3000)));
  await assertSucceeds(setDoc(doc(db, 'billing_notices', ID), { ackStudent: '2026-09-28 20:00' }, { merge: true }));
  await assertFails(setDoc(doc(db, 'billing_notices', ID), bill(1000)));
  await assertSucceeds(setDoc(doc(db, 'billing_notices', ID), bill(5000, { estimate: false, revisedFrom: 3000 })));
  await assertSucceeds(setDoc(doc(db, 'billing_notices', ID), { ackParent: '2026-10-01 09:00' }, { merge: true }));
});
