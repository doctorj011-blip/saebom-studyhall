#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 플래너 AI 검사 — 실제 모델·토큰·비용·교정률 집계 (읽기 전용)
//
//   node scripts/planner-ai-usage.js            최근 300건
//   node scripts/planner-ai-usage.js --days 7   최근 7일치만
//
// 쓰는 데가 세 군데다.
//  1) 배포한 모델이 실제로 쓰이는지 — ai_config/planner 에 model 오버라이드가 들어 있으면
//     코드의 PLANNER_AI_MODEL 이 무시된다. 그 문서는 규칙상 클라이언트에서 못 읽으므로,
//     결과 문서의 model 필드로 역추적하는 게 유일한 확인 방법이다.
//  2) 사고(thinking)를 켤지 판단 — 켜면 사고 토큰이 출력 요금으로 붙는다. 켜기 전/후로
//     이걸 돌려 output 평균과 건당 비용이 얼마나 오르는지 실측한다.
//  3) 캐시 적중률 — 적중률이 81%를 넘게 만들 수 있으면 cache_control 의 ttl 을 '1h' 로
//     올리는 게 이득이고, 그 아래면 5분 그대로가 싸다(쓰기 단가가 1.25배→2배가 되므로).
//
// 인증 불필요 — planner_ai_reviews 는 규칙이 열려 있다. 아무것도 쓰지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const PROJECT = 'saebom-studyhall';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// Opus 4.8 / Opus 5 공통 단가($/1M). 모델을 바꾸면 여기도 확인할 것.
const PRICE_IN = 5 / 1e6;
const PRICE_OUT = 25 / 1e6;
const KRW = 1400;               // 환율은 어림값이다. 정확한 청구액은 콘솔에서 볼 것.

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DAYS = parseInt(flag('--days') || '0', 10);

// Firestore REST 값 → 평범한 JS 값
function un(v) {
  const k = Object.keys(v)[0];
  if (k === 'integerValue') return parseInt(v[k], 10);
  if (k === 'doubleValue') return Number(v[k]);
  if (k === 'nullValue') return null;
  if (k === 'arrayValue') return (v[k].values || []).map(un);
  if (k === 'mapValue') return Object.fromEntries(Object.entries(v[k].fields || {}).map(([a, b]) => [a, un(b)]));
  return v[k];
}

async function fetchAll() {
  const out = [];
  let token = '';
  do {
    const url = `${BASE}/planner_ai_reviews?pageSize=300${token ? `&pageToken=${token}` : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`읽기 실패: ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const d of (j.documents || [])) out.push(un({ mapValue: { fields: d.fields } }));
    token = j.nextPageToken || '';
  } while (token);
  return out;
}

(async () => {
  let all = (await fetchAll()).filter(r => r.usage && r.usage.input != null);
  if (DAYS) {
    const cut = new Date(Date.now() - DAYS * 86400e3).toISOString().slice(0, 10);
    all = all.filter(r => r.date && r.date >= cut);
  }
  if (!all.length) { console.log('집계할 기록이 없습니다.'); return; }

  const avg = (f) => all.reduce((s, r) => s + (f(r) || 0), 0) / all.length;
  const num = (x, w = 7) => String(Math.round(x)).padStart(w);

  // ── 어떤 모델이 실제로 쓰였나 ──
  const models = {};
  for (const r of all) models[r.model || '(기록없음)'] = (models[r.model || '(기록없음)'] || 0) + 1;
  const recent = [...all].sort((a, b) => (a.doneAt < b.doneAt ? 1 : -1))[0];

  console.log(`\n집계 대상 ${all.length}건${DAYS ? ` (최근 ${DAYS}일)` : ''}\n`);
  console.log('── 실제 사용된 모델 ──');
  for (const [m, n] of Object.entries(models).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${m}  ${n}건`);
  }
  console.log(`   가장 최근 검사: ${recent.date} · ${recent.model}`);
  console.log('   ※ 배포한 모델과 다르면 ai_config/planner 의 model 오버라이드를 지워야 한다.\n');

  // ── 토큰 ──
  console.log('── 건당 토큰(평균) ──');
  console.log(`   비캐시 입력(사진+이력) ${num(avg(r => r.usage.input))}`);
  console.log(`   캐시 읽기              ${num(avg(r => r.usage.cacheRead))}   (정가의 0.1배)`);
  console.log(`   캐시 쓰기              ${num(avg(r => r.usage.cacheWrite))}   (정가의 1.25배)`);
  console.log(`   출력                   ${num(avg(r => r.usage.output))}   ★사고를 켜면 여기 사고 토큰이 포함된다\n`);

  // ── 비용 ──
  const cost = r => r.usage.input * PRICE_IN
    + (r.usage.cacheRead || 0) * PRICE_IN * 0.1
    + (r.usage.cacheWrite || 0) * PRICE_IN * 1.25
    + r.usage.output * PRICE_OUT;
  const per = avg(cost);
  const dates = [...new Set(all.map(r => r.date).filter(Boolean))];
  const perDay = all.length / Math.max(dates.length, 1);
  console.log('── 비용(정가 기준) ──');
  console.log(`   건당      $${per.toFixed(4)}`);
  console.log(`   하루 평균 ${perDay.toFixed(1)}건 → 월 $${(per * perDay * 30).toFixed(2)} (약 ${Math.round(per * perDay * 30 * KRW).toLocaleString()}원)`);
  console.log('   ※ 밤 배치로 나간 건은 Batch API 50% 할인이라 실제 청구는 이보다 적다.\n');

  // ── 캐시 ──
  const hit = all.filter(r => (r.usage.cacheRead || 0) > 0).length;
  const rate = hit / all.length;
  const mult = (rate * 0.1 + (1 - rate) * 1.25);
  console.log('── 프롬프트 캐시 ──');
  console.log(`   적중 ${hit}/${all.length}건 (${(rate * 100).toFixed(0)}%) · 현재 실효 계수 ${mult.toFixed(3)}배`);
  console.log(`   ttl '1h' 로 올리면 계수는 (적중률×0.1 + 미적중×2.0). 손익분기 적중률 ≈ ${((2 - mult) / 1.9 * 100).toFixed(0)}%`);
  console.log(`   → 지금 적중률이 그 위로 올라갈 수 있을 때만 이득이다.\n`);

  // ── 판독 정확도(선생님 교정률) ──
  const fixed = all.filter(r => r.statsFixed);
  const diffs = fixed
    .map(r => [(r.stats || {}).total_minutes, (r.statsFixed || {}).total_minutes])
    .filter(([a, b]) => a != null && b != null && a !== b)
    .map(([a, b]) => Math.abs(b - a));
  console.log('── 판독 정확도 (사고를 켤지 판단하는 근거) ──');
  console.log(`   선생님이 수치를 교정한 검사: ${fixed.length}/${all.length}건 (${(100 * fixed.length / all.length).toFixed(1)}%)`);
  if (diffs.length) {
    console.log(`   총량이 바뀐 건 ${diffs.length}건 · 평균 오차 ${Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length)}분 · 최대 ${Math.max(...diffs)}분`);
  }
  console.log('   ※ 사고를 켜고 일주일 뒤 이 비율이 내려가면 켠 값을 한 것이다.\n');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
