// 관리앱(saebom_schedule_with_hours.html)에서 자동 작업 코드를 그대로 잘라 legacy.src.js 로 만든다.
//
//   node functions/jobs/extract.mjs        (저장소 루트·functions 어디서 돌려도 된다)
//
// 왜 손으로 옮기지 않나: 벌점·상점·퇴원 규칙이 계속 고쳐지는데, 서버 사본을 따로 두면 언젠가
// 어긋난다. 관리앱을 고친 뒤 이 스크립트를 다시 돌리면 서버 사본이 같은 코드로 갱신된다.
// 줄 번호가 아니라 '선언 이름'으로 고르므로 관리앱 줄이 밀려도 안전하다.
// 끝에 eslint no-undef 로 빠진 식별자가 없는지 검사한다(있으면 실패).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { ESLint } from 'eslint';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(here, '../../saebom_schedule_with_hours.html');
const OUT = path.join(here, 'legacy.src.js');
const html = fs.readFileSync(HTML, 'utf8');

// <script> 블록 — 클래식 본체(가장 큰 것)와 모듈 본체(가장 큰 것)
const blocks = [...html.matchAll(/<script(\s+type="module")?>([\s\S]*?)<\/script>/g)]
  .map((m) => ({ module: !!m[1], src: m[2] }));
const pickBig = (isMod) => blocks.filter((b) => b.module === isMod).sort((a, b) => b.src.length - a.src.length)[0].src;
const classic = pickBig(false), mod = pickBig(true);

function top(src, sourceType) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowAwaitOutsideFunction: true });
  return ast.body.map((n) => ({ n, src: src.slice(n.start, n.end), names: namesOf(n) }));
}
function namesOf(n) {
  if (n.type === 'FunctionDeclaration') return [n.id.name];
  if (n.type === 'VariableDeclaration') return n.declarations.map((d) => d.id.name || '?');
  if (n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression') {
    const l = n.expression.left;
    if (l.type === 'MemberExpression' && l.object.name === 'window') return ['window.' + (l.property.name || l.property.value)];
  }
  return [];
}
const C = top(classic, 'script'), M = top(mod, 'module');
const COMMON = top(fs.readFileSync(path.resolve(here, '../../saebom-common.js'), 'utf8'), 'script');

function byNames(list, names) {
  const want = new Set(names), got = new Set();
  const out = list.filter((s) => s.names.some((x) => want.has(x) && got.add(x)));
  const miss = names.filter((x) => !got.has(x));
  if (miss.length) throw new Error('관리앱에서 못 찾음: ' + miss.join(', '));
  return out;
}
// from 이름이 선언된 문장부터 to 이름이 선언된 문장까지(포함), skip 은 뺀다
function range(list, from, to, skip = []) {
  const i = list.findIndex((s) => s.names.includes(from)), j = list.findIndex((s) => s.names.includes(to));
  if (i < 0 || j < 0 || j < i) throw new Error(`범위를 못 찾음: ${from}~${to}`);
  return list.slice(i, j + 1).filter((s) => !s.names.some((x) => skip.includes(x)));
}

const parts = [
  ['saebom-common.js — 공용 헬퍼', [...byNames(COMMON, ['window._ymKey', 'window._normalizeHours', 'window._phoneLast4', 'window._newStudentUid', 'window._normStudentName', 'window._sameStudentName', 'window._ownsDoc'])]],
  ['클래식 — 세션 시각 헬퍼', byNames(C, ['sessIsoDate', 'sessMonthKey', 'sessLegacyDate', 'sessCapTs', 'sessDurationMin', 'sessFmtKoTime', 'window._sessHelpers'])],
  ['클래식 — 테스트 계정·관리자석', byNames(C, ['TEST_STUDENTS', 'window.isTestStudent', 'window.ADMIN_SEAT_MIN', 'window.ADMIN_SEAT_MAX', 'window.isAdminSeat'])],
  ['클래식 — 좌석→학생·uid', byNames(C, ['_studentBySeatKey', 'window._studentBySeatKey', '_uidForSeat', 'window._uidForSeat'])],
  ['클래식 — 스케줄 문자열 해석', byNames(C, ['window.parseScheduleStr'])],
  ['모듈 — 세션 상수', byNames(M, ['SESS_COL', 'SESS_PTR_COL', 'SH'])],
  ['모듈 — 미퇴실 세션 자동 마감', byNames(M, ['_sessCleanSeat', '_sessPtrRef', '_sessUid', '_sessFoldAway', 'recomputeMonthHours', 'autoCloseStaleSessions'])],
  ['모듈 — 새벽 스케줄 초기화', range(M, '_dailyResetAlreadyDone', 'window.resetSchedulesToBase')],
  ['모듈 — 벌점(무단결석·지각)·주간목표·주기·플래너 상점', range(M, 'NOSHOW_POINTS', '_writeCycleMerit')],
  ['모듈 — 자동 퇴원·보관함 정리', [...range(M, 'WITHDRAWN_KEEP_DAYS', 'window.autoWithdrawExpired'), ...byNames(M, ['cleanupWithdrawnStudents'])]],
];

// 명부 불러오기 — loadStudentsFromFirebase 안의 STUDENTS.push({...}) 객체를 그대로 쓴다
const loader = M.find((s) => s.names.includes('loadStudentsFromFirebase'));
const at = loader.src.indexOf('STUDENTS.push({');
let depth = 0, k = at + 'STUDENTS.push('.length, end = -1;
for (; k < loader.src.length; k++) {
  const ch = loader.src[k];
  if (ch === '{') depth++;
  else if (ch === '}' && --depth === 0) { end = k + 1; break; }
}
const literal = loader.src.slice(at + 'STUDENTS.push('.length, end);
acorn.parseExpressionAt(literal, 0, { ecmaVersion: 'latest' }); // 문법 확인

const header = `// ⚠️ 자동 생성 파일 — 손으로 고치지 말 것. functions/jobs/extract.mjs 가 관리앱에서 잘라 만든다.
// 원본: saebom_schedule_with_hours.html (생성 ${new Date().toISOString()})
// 서버(runner.js)가 node:vm 안에서 window·db·Firestore 함수 흉내(fsCompat)를 넣고 실행한다.
`;
let out = header;
for (const [title, list] of parts) out += `\n// ════ ${title} ════\n` + list.map((s) => s.src).join('\n') + '\n';
out += `\n// ════ 명부 불러오기 (loadStudentsFromFirebase 의 학생 객체 그대로) ════
async function __loadStudents() {
  const snap = await getDocs(collection(db, 'students'));
  STUDENTS.length = 0;
  snap.forEach(d => {
    const v = d.data();
    if (!v.name) return;
    STUDENTS.push(${literal});
  });
  STUDENTS.sort((a,b) => parseInt(a.seat) - parseInt(b.seat));
}
`;
fs.writeFileSync(OUT, out);

// 빠진 식별자 검사 — runner.js 가 넣어 주는 이름만 허용
// window = vm 전역이라 window.X 로 정의된 것도 맨 이름으로 보인다(브라우저와 같다).
const PROVIDED = ['window', 'db', 'STUDENTS', 'PRESENT', 'DOOR_DEVICE_ID', 'showAdminToast', 'localStorage',
  'doc', 'collection', 'query', 'where', 'orderBy', 'limit', 'startAfter', 'getDoc', 'getDocs', 'setDoc', 'updateDoc',
  'deleteDoc', 'runTransaction', 'writeBatch', 'serverTimestamp', 'deleteField', 'increment', 'getCountFromServer', 'onSnapshot',
  '_resetLocalAfterDailyReset', '_ymKey', '_normalizeHours', 'document', 'buildFloorplan', 'buildDashboard', 'buildHoursTable', 'console', 'setTimeout', 'clearTimeout', 'crypto'];
const eslint = new ESLint({
  useEslintrc: false,
  overrideConfig: {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'script' },
    env: { es2022: true },
    globals: Object.fromEntries(PROVIDED.map((g) => [g, 'writable'])),
    rules: { 'no-undef': 'error' },
  },
});
const [res] = await eslint.lintText(out, { filePath: OUT });
const undef = [...new Set(res.messages.map((m) => m.message))];
console.log(`legacy.src.js ${out.split('\n').length}줄 생성`);
if (undef.length) { console.error('빠진 식별자:\n  ' + undef.join('\n  ')); process.exit(1); }
console.log('빠진 식별자 없음');
