#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Firestore 전체 백업 (읽기 전용)
//
// 학생ID(uid) 이관 0단계. 이 저장소는 PITR이 꺼져 있어 되돌릴 수단이 이 export뿐이므로,
// 데이터를 만지는 작업 '직전'에 반드시 한 번 돌린다.
//
//   백업 : node scripts/export-firestore.js [--out <폴더>]
//   검증 : node scripts/export-firestore.js --verify <백업폴더>
//
// 특징
//   - 인증 불필요. 규칙이 대부분 개방돼 있어 미인증 REST로 그대로 읽힌다(API 키도 필요 없음).
//   - Firestore 원본 형식(typed value)을 그대로 저장한다. 평문 JSON으로 바꾸면 정수/실수,
//     타임스탬프, null 이 뭉개져 복원이 어긋난다.
//   - 컬렉션 목록은 firestore.rules 에서 뽑는다. 규칙에 컬렉션이 추가되면 백업도 따라간다.
//     (documents:listCollectionIds 는 규칙상 403이라 못 쓴다)
//   - ⚠️ 읽지 못한 컬렉션은 성공으로 넘기지 않고 manifest 에 기록하고 종료코드 1로 끝낸다.
//     "백업했다고 생각했는데 비어 있었다"가 이 스크립트에서 제일 위험한 실패다.
//
// 한계 (백업으로 안 덮이는 것)
//   - 규칙상 미인증 읽기가 막힌 컬렉션(push_tokens 등)은 못 가져온다. manifest 에 남는다.
//   - Firebase Storage(플래너 사진 planners/{좌석}/{날짜}.jpg)는 이 스크립트 범위 밖이다.
//   - 서브컬렉션은 다루지 않는다. 현재 이 프로젝트는 전부 최상위 컬렉션이다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = 'saebom-studyhall';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REPO = path.resolve(__dirname, '..');

// 규칙 파일에 안 나오지만 코드가 실제로 쓰는 컬렉션 (functions/index.js 등)
const EXTRA_COLLECTIONS = ['planner_ai_batches', 'ai_config', 'model_config'];

// ── 컬렉션 목록: firestore.rules 의 최상위 match 에서 추출 ──
function collectionsFromRules() {
  const rulesPath = path.join(REPO, 'firestore.rules');
  if (!fs.existsSync(rulesPath)) {
    throw new Error(`firestore.rules 를 찾을 수 없습니다: ${rulesPath}`);
  }
  const out = new Set();
  for (const line of fs.readFileSync(rulesPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*match\s+\/([A-Za-z_][A-Za-z0-9_]*)\s*\//);
    if (m && m[1] !== 'databases') out.add(m[1]);
  }
  for (const c of EXTRA_COLLECTIONS) out.add(c);
  return [...out].sort();
}

// ── 한 컬렉션 전건 읽기 (페이지네이션) ──
async function fetchCollection(col) {
  const docs = [];
  let token = '';
  for (;;) {
    const url = `${BASE}/${encodeURIComponent(col)}?pageSize=300` + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return { error: `network: ${e.message}`, docs };
    }
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()).error || {}).status || ''; } catch (e) { /* 본문 없음 */ }
      return { error: `HTTP ${res.status}${detail ? ' ' + detail : ''}`, docs };
    }
    const body = await res.json();
    for (const d of body.documents || []) {
      docs.push({
        id: d.name.split('/').pop(),
        fields: d.fields || {},
        createTime: d.createTime,
        updateTime: d.updateTime,
      });
    }
    token = body.nextPageToken;
    if (!token) break;
  }
  return { docs };
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

// ── 백업 ──
async function runExport(outRoot) {
  const dir = path.join(outRoot, stamp());
  fs.mkdirSync(dir, { recursive: true });
  const cols = collectionsFromRules();
  console.log(`백업 위치: ${dir}`);
  console.log(`대상 컬렉션 ${cols.length}개 (firestore.rules 기준 + 코드 전용 ${EXTRA_COLLECTIONS.length}개)\n`);

  const entries = [];
  let totalDocs = 0;
  const failed = [];

  for (const col of cols) {
    process.stdout.write(`  ${col.padEnd(24)}`);
    const { docs, error } = await fetchCollection(col);
    if (error) {
      // 부분 수신이라도 건진 건 저장한다 — 없는 것보다 낫다
      failed.push({ col, error, partial: docs.length });
      entries.push({ collection: col, count: docs.length, error, file: null });
      console.log(`❌ ${error}${docs.length ? ` (부분 ${docs.length}건 수신)` : ''}`);
      continue;
    }
    const file = `${col}.json`;
    const json = JSON.stringify(docs, null, 1);
    fs.writeFileSync(path.join(dir, file), json, 'utf8');
    entries.push({ collection: col, count: docs.length, file, bytes: Buffer.byteLength(json), sha256: sha256(json) });
    totalDocs += docs.length;
    console.log(`${String(docs.length).padStart(6)}건`);
  }

  const manifest = {
    project: PROJECT,
    exportedAt: new Date().toISOString(),
    totalDocs,
    collections: entries,
    failed,
    notes: [
      'Firestore 원본 typed value 형식 그대로 저장됨',
      'Storage(플래너 사진)는 이 백업에 포함되지 않음',
      '서브컬렉션은 다루지 않음',
    ],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`총 ${totalDocs.toLocaleString()}건 저장`);
  if (failed.length) {
    console.log(`\n❌ 읽지 못한 컬렉션 ${failed.length}개 — 이 백업은 완전하지 않습니다:`);
    for (const f of failed) console.log(`   ${f.col}: ${f.error}`);
    console.log(`\n규칙상 미인증 읽기가 막힌 컬렉션은 콘솔에서 따로 내려받아야 합니다.`);
    return 1;
  }
  console.log(`✅ 전 컬렉션 백업 완료`);
  return 0;
}

// ── 검증: 저장된 파일이 manifest 와 일치하는가 ──
function runVerify(dir) {
  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) {
    console.error(`manifest.json 이 없습니다: ${mPath}`);
    return 1;
  }
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  console.log(`백업: ${m.exportedAt} · ${m.totalDocs.toLocaleString()}건\n`);
  // 무결성 실패(bad)와 애초에 못 받은 컬렉션(gap)을 구분한다.
  // 403 컬렉션은 규칙이 바뀌지 않는 한 영구적이라, 이걸 실패로 세면 검증이 늘 빨간불이 되어
  // 아무도 안 보게 된다. 종료코드는 무결성만 본다.
  let bad = 0;
  const gaps = [];
  for (const e of m.collections) {
    if (!e.file) { gaps.push(`${e.collection}: ${e.error}`); continue; }
    const p = path.join(dir, e.file);
    if (!fs.existsSync(p)) { console.log(`  ${e.collection.padEnd(24)} ❌ 파일 없음`); bad++; continue; }
    const raw = fs.readFileSync(p, 'utf8');
    if (sha256(raw) !== e.sha256) { console.log(`  ${e.collection.padEnd(24)} ❌ 내용 변조/손상`); bad++; continue; }
    const n = JSON.parse(raw).length;
    if (n !== e.count) { console.log(`  ${e.collection.padEnd(24)} ❌ 건수 불일치 ${n} ≠ ${e.count}`); bad++; continue; }
    console.log(`  ${e.collection.padEnd(24)} ✔ ${String(e.count).padStart(6)}건`);
  }
  if (gaps.length) {
    console.log(`\n⚠️  백업에 애초에 담기지 못한 컬렉션 ${gaps.length}개 (규칙상 미인증 읽기 불가):`);
    for (const g of gaps) console.log(`   ${g}`);
    console.log(`   → 이 데이터가 필요하면 Firebase 콘솔에서 따로 내려받을 것`);
  }
  console.log(bad ? `\n❌ 저장된 파일 중 손상 ${bad}건` : `\n✅ 저장된 파일 ${m.collections.length - gaps.length}개 전부 무결`);
  return bad ? 1 : 0;
}

(async () => {
  const argv = process.argv.slice(2);
  const vi = argv.indexOf('--verify');
  if (vi !== -1) {
    const dir = argv[vi + 1];
    if (!dir) { console.error('사용법: node scripts/export-firestore.js --verify <백업폴더>'); process.exit(2); }
    process.exit(runVerify(path.resolve(dir)));
  }
  const oi = argv.indexOf('--out');
  // 기본 저장 위치는 저장소 밖 — 이 저장소는 public 이라 운영 데이터가 들어오면 안 된다
  const outRoot = oi !== -1 && argv[oi + 1] ? path.resolve(argv[oi + 1]) : path.resolve(REPO, '..', 'saebom-backup');
  process.exit(await runExport(outRoot));
})().catch(e => { console.error(e); process.exit(1); });
