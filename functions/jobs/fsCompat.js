'use strict';
/*
 * fsCompat — Firestore 웹 모듈식 SDK(doc·getDoc·setDoc·query·where…)와 같은 모양의 함수를
 * firebase-admin 위에 얹은 얇은 어댑터.
 *
 * 왜: 관리앱(saebom_schedule_with_hours.html)이 키오스크에서 돌리던 자동 작업 코드를
 *     서버로 옮길 때 다시 짜지 않고 그대로 가져오기 위해서다(다시 짜면 벌점 유예·중간입실 같은
 *     규칙이 미묘하게 어긋난다). 그 코드가 쓰는 SDK 함수만 흉내 낸다.
 *
 * 다른 점: 관리자 권한(admin SDK)이라 보안 규칙을 거치지 않는다. 스냅샷 metadata.fromCache 는 항상 false.
 */
const admin = require('firebase-admin');
const { FieldValue, FieldPath } = require('firebase-admin/firestore');

const isRef = (x) => x && typeof x.path === 'string' && (typeof x.collection === 'function' || typeof x.doc === 'function');

function _join(base, segs) {
  const parts = [];
  if (base) parts.push(base);
  for (const s of segs) parts.push(...String(s).split('/').filter(Boolean));
  return parts.join('/');
}
// doc(db, 'a', 'b') · doc(db, 'a/b') · doc(collectionRef, 'id')
function doc(dbOrRef, ...segs) {
  if (dbOrRef && dbOrRef._isFsDb) return dbOrRef._db.doc(_join('', segs));
  if (isRef(dbOrRef) && typeof dbOrRef.doc === 'function' && !segs.length) return dbOrRef.doc();
  if (isRef(dbOrRef)) return dbOrRef.firestore.doc(_join(dbOrRef.path, segs));
  throw new Error('fsCompat.doc: 알 수 없는 인자');
}
function collection(dbOrRef, ...segs) {
  if (dbOrRef && dbOrRef._isFsDb) return dbOrRef._db.collection(_join('', segs));
  if (isRef(dbOrRef)) return dbOrRef.firestore.collection(_join(dbOrRef.path, segs));
  throw new Error('fsCompat.collection: 알 수 없는 인자');
}

// ── 스냅샷: 웹 SDK 는 exists() 가 함수, admin 은 속성 ──
function wrapDoc(s) {
  return {
    id: s.id, ref: s.ref,
    exists: () => s.exists,
    data: () => (s.exists ? s.data() : undefined),
    get: (f) => s.get(f),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}
function wrapQuery(qs) {
  const docs = qs.docs.map(wrapDoc);
  return {
    docs, size: docs.length, empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
    docChanges: () => docs.map((d) => ({ type: 'added', doc: d })),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}

// ── 쿼리 ──
const where = (field, op, value) => (q) => q.where(field, op, value);
const orderBy = (field, dir) => (q) => q.orderBy(field, dir);
const limit = (n) => (q) => q.limit(n);
const startAfter = (...v) => (q) => q.startAfter(...v.map((x) => (x && x.ref && typeof x.exists === 'function' ? x.ref : x)));
const documentId = () => FieldPath.documentId();
function query(base, ...cons) { return cons.reduce((q, c) => c(q), base); }

// 웹 SDK 의 sentinel 들 — admin FieldValue 로 바꾼다
const serverTimestamp = () => FieldValue.serverTimestamp();
const deleteField = () => FieldValue.delete();
const increment = (n) => FieldValue.increment(n);
const arrayUnion = (...v) => FieldValue.arrayUnion(...v);
const arrayRemove = (...v) => FieldValue.arrayRemove(...v);

// ── 읽기·쓰기 ──
const getDoc = async (ref) => wrapDoc(await ref.get());
const getDocFromServer = getDoc;
const getDocs = async (q) => wrapQuery(await q.get());
const getDocsFromServer = getDocs;
const setDoc = async (ref, data, opts) => { await (opts && opts.merge ? ref.set(data, { merge: true }) : ref.set(data)); };
// 웹 updateDoc(ref, {..}) 와 updateDoc(ref, 'a.b', v, ...) 둘 다
const updateDoc = async (ref, a, ...rest) => { await (typeof a === 'string' ? ref.update(a, ...rest) : ref.update(a)); };
const deleteDoc = async (ref) => { await ref.delete(); };
const addDoc = async (col, data) => col.add(data);
async function getCountFromServer(q) { const s = await q.count().get(); return { data: () => s.data() }; }

function _txWrap(tx) {
  const w = {
    get: async (ref) => wrapDoc(await tx.get(ref)),
    set: (ref, data, opts) => { tx.set(ref, data, opts && opts.merge ? { merge: true } : {}); return w; },
    update: (ref, a, ...rest) => { typeof a === 'string' ? tx.update(ref, a, ...rest) : tx.update(ref, a); return w; },
    delete: (ref) => { tx.delete(ref); return w; },
  };
  return w;
}
// admin SDK 는 콜백이 Promise 를 돌려주는지 instanceof 로 본다 — vm 안의 async 함수가 돌려준 Promise 는
// 다른 realm 이라 거부된다("You must return a Promise"). 바깥 async 로 한 번 감싸 이쪽 Promise 로 만든다.
const runTransaction = (fsdb, fn) => fsdb._db.runTransaction(async (tx) => await fn(_txWrap(tx)));
function writeBatch(fsdb) {
  const b = fsdb._db.batch();
  const w = {
    set: (ref, data, opts) => { b.set(ref, data, opts && opts.merge ? { merge: true } : {}); return w; },
    update: (ref, a, ...rest) => { typeof a === 'string' ? b.update(ref, a, ...rest) : b.update(ref, a); return w; },
    delete: (ref) => { b.delete(ref); return w; },
    commit: () => b.commit(),
  };
  return w;
}

// 실시간 구독은 서버 작업에 없다 — 부르면 한 번 읽어 넘기고 해제 함수를 돌려준다(코드 호환용).
function onSnapshot(ref, next, err) {
  const isDocRef = typeof ref.collection === 'function' && typeof ref.listCollections === 'function' && !ref.where;
  (isDocRef ? getDoc(ref) : getDocs(ref)).then(next, err || ((e) => console.error(e)));
  return () => {};
}

/** 관리앱의 `db` 자리에 넣을 값. getFirestore() 대신 쓴다. */
function makeDb(firestore) { return { _isFsDb: true, _db: firestore || admin.firestore() }; }

module.exports = {
  makeDb, doc, collection, query, where, orderBy, limit, startAfter, documentId,
  getDoc, getDocs, getDocFromServer, getDocsFromServer, setDoc, updateDoc, deleteDoc, addDoc,
  getCountFromServer, runTransaction, writeBatch, onSnapshot,
  serverTimestamp, deleteField, increment, arrayUnion, arrayRemove,
};
