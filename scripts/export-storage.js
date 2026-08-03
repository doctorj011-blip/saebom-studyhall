#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Firebase Storage 전체 백업 (읽기 전용)
//
// export-firestore.js 가 못 덮는 구멍을 메운다. Firestore 백업에는 플래너 사진의
// '주소(url)'만 들어가고 사진 자체는 안 들어간다 — 버킷이 날아가면 주소만 남는다.
//
//   백업 : node scripts/export-storage.js [--out <폴더>] [--full]
//   검증 : node scripts/export-storage.js --verify <백업폴더>
//
// 특징
//   - 인증 불필요. 규칙이 열려 있어 미인증 REST 로 목록·다운로드가 그대로 된다
//     (2026-08-04 실측). 토큰(downloadTokens)도 필요 없다.
//   - 서버가 준 md5 와 내려받은 바이트의 md5 를 대조한다. 안 맞으면 실패로 기록한다.
//   - 직전 백업을 자동으로 찾아 md5 가 같은 파일은 다시 안 받고 복사한다(--full 로 끄기).
//     플래너는 하루 40~50장씩 쌓여 매번 전량 내려받으면 금방 감당이 안 된다.
//   - ⚠️ 못 받은 객체는 성공으로 넘기지 않고 manifest 에 남기고 종료코드 1 로 끝낸다.
//
// 대상 찾는 법 (버킷 전체 목록 조회는 규칙상 403 이라 못 쓴다)
//   1) planners/{좌석}/ 를 좌석마다 목록 조회 — 폴더 단위 list 는 허용돼 있다.
//      Firestore planners 문서에 없는 사진(메타 저장만 실패한 건)도 이쪽으로 건진다.
//   2) Firestore 문서 안의 firebasestorage 주소를 긁는다 — 공지 이미지(notices/{id}/{n}.jpg)는
//      폴더 목록이 막혀 있어(notices/ list 403) 이 경로로만 찾을 수 있다.
//      --refs <firestore백업폴더> 를 주면 그 백업 JSON 전체에서 주소를 긁는다(가장 확실).
//
// 한계
//   - 위 두 경로 어디에도 안 잡히는 객체(코드가 안 쓰는 경로에 수동으로 올린 파일 등)는 못 찾는다.
//   - 버킷 메타데이터(규칙·수명주기 설정)는 대상이 아니다. 규칙은 storage.rules 참고.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT = 'saebom-studyhall';
const BUCKET = 'saebom-studyhall.firebasestorage.app';
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o`;
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REPO = path.resolve(__dirname, '..');

// 좌석 폴더 훑는 범위. 학생석 1~45 + 관리자석 54~63 + 여유
const SEAT_SCAN_MAX = 70;
// 문서 안에 Storage 주소가 들어가는 컬렉션 (--refs 를 안 줬을 때 훑는 최소 집합)
const REF_COLLECTIONS = ['notices', 'planners'];
const CONCURRENCY = 6;

const enc = encodeURIComponent;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const md5b64 = buf => crypto.createHash('md5').update(buf).digest('base64');
const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

// ── HTTP 헬퍼 (일시적 실패는 두 번까지 재시도) ──
async function req(url, asBuffer) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt));
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      lastErr = `network: ${e.message}`;
      continue;
    }
    if (res.ok) return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.json();
    lastErr = `HTTP ${res.status}`;
    // 권한/부재는 재시도해도 그대로다
    if (res.status === 403 || res.status === 404) break;
  }
  throw new Error(lastErr);
}

// ── 1) 폴더 목록 (delimiter 필수 — 없으면 재귀 목록이 되어 규칙에 막힌다) ──
async function listFolder(prefix) {
  const items = [];
  let token = '';
  for (;;) {
    const url = `${STORAGE}?prefix=${enc(prefix)}&delimiter=${enc('/')}&maxResults=1000`
      + (token ? `&pageToken=${enc(token)}` : '');
    const body = await req(url, false);
    for (const it of body.items || []) items.push(it.name);
    token = body.nextPageToken;
    if (!token) break;
  }
  return items;
}

// ── 2) Firestore 문서에서 Storage 주소 긁기 ──
const URL_RE = new RegExp(`https://firebasestorage\\.googleapis\\.com/v0/b/[^/"\\\\]+/o/([^?"\\\\\\s]+)`, 'g');
function pathsFromText(text, out) {
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    try { out.add(decodeURIComponent(m[1])); } catch (e) { /* 깨진 주소는 버린다 */ }
  }
}

async function pathsFromFirestore() {
  const out = new Set();
  const seats = new Set();
  for (const col of REF_COLLECTIONS) {
    let token = '';
    for (;;) {
      const url = `${FIRESTORE}/${enc(col)}?pageSize=300` + (token ? `&pageToken=${enc(token)}` : '');
      let body;
      try {
        body = await req(url, false);
      } catch (e) {
        console.log(`  ⚠️  ${col} 조회 실패 (${e.message}) — 이 컬렉션의 주소는 못 긁는다`);
        break;
      }
      pathsFromText(JSON.stringify(body.documents || []), out);
      for (const d of body.documents || []) {
        const seat = ((d.fields || {}).seat || {}).stringValue;
        if (seat && /^\d+$/.test(seat)) seats.add(seat);
        const id = d.name.split('/').pop();
        const mm = id.match(/^(\d+)_/);        // planners 문서 ID = {좌석}_{날짜}
        if (mm) seats.add(mm[1]);
      }
      token = body.nextPageToken;
      if (!token) break;
    }
  }
  return { paths: out, seats };
}

function pathsFromRefsDir(dir, out) {
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    throw new Error(`--refs 폴더를 읽을 수 없습니다: ${dir}`);
  }
  for (const f of files) pathsFromText(fs.readFileSync(path.join(dir, f), 'utf8'), out);
  return files.length;
}

// ── 직전 백업 찾기 (md5 같으면 재다운로드 안 함) ──
function findPrevBackup(outRoot) {
  let dirs;
  try {
    dirs = fs.readdirSync(outRoot).filter(d => d.startsWith('storage_'));
  } catch (e) { return null; }
  dirs.sort();
  for (const d of dirs.reverse()) {
    const m = path.join(outRoot, d, 'manifest.json');
    if (fs.existsSync(m)) {
      try {
        const man = JSON.parse(fs.readFileSync(m, 'utf8'));
        const byPath = new Map();
        for (const o of man.objects || []) if (o.file && o.md5) byPath.set(o.path, o);
        return { dir: path.join(outRoot, d), byPath };
      } catch (e) { /* 깨진 매니페스트는 건너뛴다 */ }
    }
  }
  return null;
}

// ── 객체 하나 가져오기 ──
async function fetchObject(objPath, dir, prev, full) {
  const meta = await req(`${STORAGE}/${enc(objPath)}`, false);
  const dest = path.join(dir, 'objects', ...objPath.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 직전 백업에 같은 md5 가 있으면 복사로 끝낸다
  if (!full && prev) {
    const old = prev.byPath.get(objPath);
    if (old && old.md5 === meta.md5Hash) {
      const src = path.join(prev.dir, 'objects', ...objPath.split('/'));
      if (fs.existsSync(src)) {
        const buf = fs.readFileSync(src);
        if (md5b64(buf) === meta.md5Hash) {
          fs.writeFileSync(dest, buf);
          return { reused: true, meta, bytes: buf.length };
        }
      }
    }
  }

  const buf = await req(`${STORAGE}/${enc(objPath)}?alt=media`, true);
  const got = md5b64(buf);
  if (meta.md5Hash && got !== meta.md5Hash) {
    throw new Error(`md5 불일치 (서버 ${meta.md5Hash} ≠ 받은 것 ${got})`);
  }
  fs.writeFileSync(dest, buf);
  return { reused: false, meta, bytes: buf.length };
}

// ── 동시 실행 풀 ──
async function pool(items, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

const human = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;

// ── 백업 ──
async function runExport(outRoot, opts) {
  const dir = path.join(outRoot, `storage_${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`백업 위치: ${dir}`);
  console.log(`버킷: ${BUCKET}\n`);

  // 대상 수집
  console.log('대상 수집');
  const targets = new Set();

  const { paths: refPaths, seats } = await pathsFromFirestore();
  for (const p of refPaths) targets.add(p);
  console.log(`  Firestore 문서 속 주소       ${String(refPaths.size).padStart(6)}건 (좌석 ${seats.size}개 확인)`);

  if (opts.refs) {
    const before = targets.size;
    const n = pathsFromRefsDir(opts.refs, targets);
    console.log(`  --refs 백업 JSON ${n}개 스캔  +${targets.size - before}건`);
  }

  const seatList = new Set(seats);
  for (let s = 1; s <= SEAT_SCAN_MAX; s++) seatList.add(String(s));
  let listed = 0, seatFolders = 0;
  await pool([...seatList], async seat => {
    let items;
    try {
      items = await listFolder(`planners/${seat}/`);
    } catch (e) {
      if (String(e.message).includes('403')) return;   // 규칙상 못 여는 폴더는 조용히 넘긴다
      console.log(`  ⚠️  planners/${seat}/ 목록 실패: ${e.message}`);
      return;
    }
    if (items.length) seatFolders++;
    for (const it of items) { targets.add(it); listed++; }
  });
  console.log(`  planners/{좌석}/ 폴더 목록   ${String(listed).padStart(6)}건 (사진 있는 좌석 ${seatFolders}개)`);
  console.log(`  ─ 합계 ${targets.size}건\n`);

  // 내려받기
  const prev = opts.full ? null : findPrevBackup(outRoot);
  if (prev) console.log(`직전 백업 재사용: ${path.basename(prev.dir)} (--full 로 전량 재다운로드)\n`);

  const list = [...targets].sort();
  const objects = [];
  const failed = [];
  let done = 0, reusedCount = 0, totalBytes = 0;

  await pool(list, async objPath => {
    try {
      const { reused, meta, bytes } = await fetchObject(objPath, dir, prev, opts.full);
      objects.push({
        path: objPath,
        file: path.posix.join('objects', objPath),
        size: Number(meta.size || bytes),
        md5: meta.md5Hash || md5b64(fs.readFileSync(path.join(dir, 'objects', ...objPath.split('/')))),
        contentType: meta.contentType || '',
        updated: meta.updated || '',
      });
      totalBytes += bytes;
      if (reused) reusedCount++;
    } catch (e) {
      failed.push({ path: objPath, error: e.message });
    }
    done++;
    if (done % 25 === 0 || done === list.length) {
      process.stdout.write(`\r  내려받는 중 ${done}/${list.length}  (${human(totalBytes)})   `);
    }
  });
  console.log('');

  objects.sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = {
    project: PROJECT,
    bucket: BUCKET,
    exportedAt: new Date().toISOString(),
    totalObjects: objects.length,
    totalBytes,
    reusedFromPrev: reusedCount,
    prevBackup: prev ? path.basename(prev.dir) : null,
    objects,
    failed,
    notes: [
      'md5 는 서버(Storage 메타)가 준 값이며 내려받은 바이트와 대조 완료',
      '버킷 전체 목록은 규칙상 못 읽어, planners 폴더 목록 + Firestore 문서 속 주소로 대상을 모았음',
      'Firestore 데이터는 export-firestore.js 로 따로 백업할 것',
    ],
  };
  const mj = JSON.stringify(manifest, null, 1);
  fs.writeFileSync(path.join(dir, 'manifest.json'), mj, 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha256(mj), 'utf8');

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`객체 ${objects.length.toLocaleString()}건 · ${human(totalBytes)}` + (reusedCount ? ` (직전 백업 재사용 ${reusedCount}건)` : ''));
  if (failed.length) {
    console.log(`\n❌ 못 받은 객체 ${failed.length}건 — 이 백업은 완전하지 않습니다:`);
    for (const f of failed.slice(0, 20)) console.log(`   ${f.path}: ${f.error}`);
    if (failed.length > 20) console.log(`   … 외 ${failed.length - 20}건 (manifest.json 참고)`);
    return 1;
  }
  console.log(`✅ 전 객체 백업 완료`);
  return 0;
}

// ── 검증: 저장된 파일이 manifest 와 일치하는가 ──
function runVerify(dir) {
  const mPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mPath)) {
    console.error(`manifest.json 이 없습니다: ${mPath}`);
    return 1;
  }
  const raw = fs.readFileSync(mPath, 'utf8');
  const m = JSON.parse(raw);
  const sPath = path.join(dir, 'manifest.sha256');
  if (fs.existsSync(sPath) && fs.readFileSync(sPath, 'utf8').trim() !== sha256(raw)) {
    console.log('⚠️  manifest.json 자체가 변조/손상됐습니다 (manifest.sha256 불일치)');
  }
  console.log(`백업: ${m.exportedAt} · ${m.totalObjects.toLocaleString()}건 · ${human(m.totalBytes || 0)}\n`);

  let bad = 0, ok = 0;
  for (const o of m.objects || []) {
    const p = path.join(dir, ...o.file.split('/'));
    if (!fs.existsSync(p)) { console.log(`  ❌ 파일 없음      ${o.path}`); bad++; continue; }
    const buf = fs.readFileSync(p);
    if (o.md5 && md5b64(buf) !== o.md5) { console.log(`  ❌ 내용 손상      ${o.path}`); bad++; continue; }
    if (buf.length !== o.size) { console.log(`  ❌ 크기 불일치    ${o.path} (${buf.length} ≠ ${o.size})`); bad++; continue; }
    ok++;
  }
  if ((m.failed || []).length) {
    console.log(`⚠️  백업 당시 못 받은 객체 ${m.failed.length}건:`);
    for (const f of m.failed.slice(0, 20)) console.log(`   ${f.path}: ${f.error}`);
  }
  console.log(bad ? `\n❌ 손상 ${bad}건 / 정상 ${ok}건` : `\n✅ ${ok.toLocaleString()}건 전부 무결`);
  return bad ? 1 : 0;
}

// ⚠️ process.exit() 를 쓰지 않는다 — export-firestore.js 와 같은 이유(윈도우에서 소켓이 열린 채
//    강제 종료하면 종료코드가 뭉개져 "백업이 불완전하다"를 못 알린다).
(async () => {
  const argv = process.argv.slice(2);
  const val = flag => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };

  const v = val('--verify');
  if (argv.includes('--verify')) {
    if (!v) { console.error('사용법: node scripts/export-storage.js --verify <백업폴더>'); return 2; }
    return runVerify(path.resolve(v));
  }
  const out = val('--out');
  // 기본 저장 위치는 저장소 밖 — 이 저장소는 public 이라 학생 사진이 들어오면 안 된다
  const outRoot = out ? path.resolve(out) : path.resolve(REPO, '..', 'saebom-backup');
  const refs = val('--refs');
  return runExport(outRoot, { full: argv.includes('--full'), refs: refs ? path.resolve(refs) : null });
})().then(code => { process.exitCode = code || 0; })
    .catch(e => { console.error(e); process.exitCode = 1; });
