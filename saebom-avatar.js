// saebom-avatar.js — 면학시상대 캐릭터를 키오스크 입실 화면에 그린다(2026-10-08).
// 앞부분: 앱 lib/widgets/cutout_avatar.dart 의 drawAvatar 를 웹 캔버스로 옮긴 것.
// 뒷부분: KioskAvatar — 입실 화면 무대(번호 입력 실루엣·등장·응원 말풍선·연달아 온 학생끼리 인사).
// 좌표·색은 앱과 같다(가로 10 × 세로 14 칸, 한 칸 = px). 앱에서 옷을 고치면 여기도 고친다.
// 키오스크에서 쓰는 동작만 옮겼다: stand·walk·wave·cheer·hop·chat·shock.
// ponytail: 시상대 전용(왕관·망토·지팡이)·히어로 동작·소품 동작은 안 옮김 — 키오스크에 필요해지면 추가.
(function (global) {
  'use strict';
  const PI = Math.PI;

  // Flutter Color(0xAARRGGBB) → CSS
  const C = (n) => `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${(((n >>> 24) & 255) / 255).toFixed(3)})`;
  const shade = (n, t) => {
    const r = ((n >>> 16) & 255) * (1 - t), g = ((n >>> 8) & 255) * (1 - t), b = (n & 255) * (1 - t);
    return `rgba(${r | 0},${g | 0},${b | 0},${(((n >>> 24) & 255) / 255).toFixed(3)})`;
  };
  const withAlpha = (n, a) => `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${a})`;

  const INK = 0xFF1E1C19, WHITE = 0xFFF7F6F2, GOLD = 0xFFF4C430, PUMPKIN = 0xFFF08A24;
  const SP_RED = 0xFFD9262B, SP_BLUE = 0xFF1F4FB0, STEEL = 0xFFB3202A, AGOLD = 0xFFF2C14E, AGLOW = 0xFFBFF4FF, GOWN = 0xFFF7A8C8;

  const SKINS = [0xFFFCE0C4, 0xFFF2C9A0, 0xFFD9A273, 0xFF9A6240];
  const HAIR_COLORS = [0xFF2B2321, 0xFF6B4027, 0xFFF2CF5B, 0xFFD9532B, 0xFFBDB8B1];
  const HAIRS = ['short', 'buzz', 'spiky', 'curly', 'bald', 'long', 'bob', 'ponytail', 'twin', 'bun', 'wavy', 'braid', 'updo'];
  const FACES = ['plain', 'lashes', 'blush', 'freckles', 'sleepy'];

  const topSpec = (id) => ({
    tee_stripe: [WHITE, false], gym: [0xFF1F3A6B, true], hawaii: [0xFF1FA7A0, false], check: [0xFFC0392B, true],
    soccer: [0xFF2F5BD0, false], hoodie: [0xFF9AA3AD, true], vest: [0xFF243A73, true], suit: [0xFF2A2D35, true],
    padding: [0xFF26272D, true], staff: [0xFF243A73, false],
  }[id] || [WHITE, false]);
  const bottomSpec = (id) => ({
    training: [0xFF2B2D33, 'long'], jeans: [0xFF3B5B92, 'long'], chino: [0xFFC9B48A, 'long'],
    skirt: [0xFFB8333A, 'skirt'], slacks: [0xFF2B2D33, 'long'],
  }[id] || [0xFF4A5A78, 'short']);
  const shoeColor = (id) => ({ red_sneaker: 0xFFE0443C, boots: 0xFFF4D02F, loafer: 0xFF7A4A2A, slipper: 0xFF243A73 }[id] || WHITE);

  // Dart VM 의 math.Random(seed) 를 그대로 옮긴 것 — 앱(네이티브)과 같은 수열이 나와야
  // 안 꾸민 학생의 기본 캐릭터가 시상대와 똑같다. (2026-10-08 dart 실행 결과 5건과 대조 일치)
  function dartRandom(seed) {
    const M64 = (1n << 64n) - 1n, A = 0xffffda61n;
    let n = BigInt(seed) & M64;
    n = (~n + (n << 21n)) & M64; n ^= n >> 24n; n = (n * 265n) & M64;
    n ^= n >> 14n; n = (n * 21n) & M64; n ^= n >> 28n; n = (n + (n << 31n)) & M64;
    let s = n === 0n ? 0x5a17n : n;
    const next = () => { s = (A * (s & 0xffffffffn) + (s >> 32n)) & M64; };
    for (let i = 0; i < 4; i++) next();
    return {
      nextInt(max) {
        const m = BigInt(max);
        if ((max & -max) === max) { next(); return Number(s & (m - 1n)); }
        let r, res;
        do { next(); r = s & 0xffffffffn; res = r % m; } while (r - res + m > (1n << 32n));
        return Number(res);
      },
    };
  }
  // Look.starter(gender, 학생이름) — 앱과 같은 FNV-1a 씨앗 + Dart Random.
  function starter(gender, key) {
    let h = 0x811C9DC5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    const r = dartRandom(h);
    const male = gender === 'm';
    const hairs = male ? ['short', 'buzz', 'spiky', 'curly'] : ['long', 'bob', 'ponytail', 'twin'];
    return { skin: SKINS[r.nextInt(2)], hair: hairs[r.nextInt(hairs.length)], hairColor: HAIR_COLORS[r.nextInt(2)], face: male ? 'plain' : 'lashes', outfit: {} };
  }
  // avatar_profiles/{sid} 문서 + avatar_outfits/{sid}.outfit → Look (앱 podium_screen _lookOf 와 같은 순서)
  function fromDocs(gender, key, profile, outfit) {
    const l = starter(gender, key);
    if (profile) {
      if (SKINS[profile.skin] != null) l.skin = SKINS[profile.skin];
      if (HAIRS.includes(profile.hair)) l.hair = profile.hair;
      if (HAIR_COLORS[profile.hairColor] != null) l.hairColor = HAIR_COLORS[profile.hairColor];
      if (FACES.includes(profile.face)) l.face = profile.face;
    }
    l.outfit = Object.assign({}, outfit || {});
    return l;
  }

  class Pen {
    constructor(ctx, px) { this.c = ctx; this.px = px; }
    o(x, y) { return [x * this.px, y * this.px]; }
    path(p, col, line = true) {
      const c = this.c;
      c.fillStyle = C(col); c.fill(p);
      if (line) { c.lineWidth = this.px * .17; c.lineJoin = 'round'; c.strokeStyle = C(INK); c.stroke(p); }
    }
    outline(p) { const c = this.c; c.lineWidth = this.px * .17; c.lineJoin = 'round'; c.strokeStyle = C(INK); c.stroke(p); }
    poly(pts) { const p = new Path2D(), s = this.px; pts.forEach(([x, y], i) => i ? p.lineTo(x * s, y * s) : p.moveTo(x * s, y * s)); p.closePath(); return p; }
    oval(x, y, w, h) { const p = new Path2D(), s = this.px; p.ellipse((x + w / 2) * s, (y + h / 2) * s, Math.abs(w / 2 * s), Math.abs(h / 2 * s), 0, 0, 2 * PI); return p; }
    circ([cx, cy], r) { const p = new Path2D(); p.arc(cx, cy, r, 0, 2 * PI); return p; }
    round(x, y, w, h, r) { const p = new Path2D(), s = this.px; p.roundRect(x * s, y * s, w * s, h * s, r * s); return p; }
    rect(x, y, w, h) { const p = new Path2D(), s = this.px; p.rect(x * s, y * s, w * s, h * s); return p; }
    stick(a, b, w, col) {
      const c = this.c;
      c.lineCap = 'round'; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      c.lineWidth = (w + .34) * this.px; c.strokeStyle = C(INK); c.stroke();
      c.lineWidth = w * this.px; c.strokeStyle = C(col); c.stroke();
    }
    thin(a, b, col, w = .17) {
      const c = this.c;
      c.lineCap = 'round'; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      c.lineWidth = w * this.px; c.strokeStyle = typeof col === 'string' ? col : C(col); c.stroke();
    }
    strokePath(p, col, w) { const c = this.c; c.lineWidth = w * this.px; c.strokeStyle = C(col); c.lineCap = 'round'; c.stroke(p); }
    clipped(clip, fn) { this.c.save(); this.c.clip(clip); fn(); this.c.restore(); }
    // 겹친 도형을 한 덩어리처럼(Path.combine union 대신): 테두리 두 배 굵기로 먼저, 채우기를 위에.
    union(paths, col) {
      const c = this.c;
      c.lineWidth = this.px * .34; c.lineJoin = 'round'; c.strokeStyle = C(INK);
      for (const p of paths) c.stroke(p);
      c.fillStyle = C(col);
      for (const p of paths) c.fill(p);
    }
  }

  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  function star(g, cx, cy, r, col) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -PI / 2 + i * PI / 5, rr = i % 2 === 0 ? r : r * .45;
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    g.path(g.poly(pts), col);
  }

  function web(g, cx, cy, r) {
    const col = 0xAA1E1C19;
    for (let i = 0; i < 10; i++) {
      const a = i * PI / 5;
      g.thin(g.o(cx, cy), g.o(cx + Math.cos(a) * r, cy + Math.sin(a) * r), col, .14);
    }
    for (const k of [.3, .55, .8]) {
      const p = g.oval(cx - r * k, cy - r * k * .85, r * k * 2, r * k * 1.7);
      g.c.lineWidth = g.px * .14; g.c.strokeStyle = C(col); g.c.stroke(p);
    }
  }

  function flame(g, cx, bottom, half, top, clock, tongues = 5, speed = 9, phase = 0) {
    const s = g.px, h = bottom - top, p = new Path2D();
    p.moveTo((cx - half * .7) * s, bottom * s);
    const x0 = cx - half;
    p.quadraticCurveTo((x0 - half * .1) * s, (bottom - h * .4) * s, x0 * s, (top + h * .45) * s);
    for (let i = 0; i < tongues; i++) {
      const a = x0 + 2 * half * i / tongues, b = x0 + 2 * half * (i + 1) / tongues, mid = (a + b) / 2;
      const wob = Math.sin(clock * speed + i * 1.9 + phase);
      const edge = Math.abs((mid - cx) / half);
      const tipY = top + h * (.28 * edge) + wob * .55;
      const tipX = mid + Math.sin(clock * speed * .7 + i + phase) * .35;
      const valley = top + h * (.32 + .28 * edge);
      p.quadraticCurveTo((a + (mid - a) * .3) * s, (tipY + h * .12) * s, tipX * s, tipY * s);
      p.quadraticCurveTo((b - (b - mid) * .3) * s, (tipY + h * .12) * s, b * s, (i === tongues - 1 ? top + h * .45 : valley) * s);
    }
    p.quadraticCurveTo((cx + half * 1.1) * s, (bottom - h * .4) * s, (cx + half * .7) * s, bottom * s);
    p.quadraticCurveTo(cx * s, (bottom + .8) * s, (cx - half * .7) * s, bottom * s);
    p.closePath();
    return p;
  }

  // ponytail: 앱의 MaskFilter.blur 는 키오스크 성능 때문에 반투명 겹으로만 흉내 낸다.
  function aura(g, clock, outer, mid, inner) {
    const c = g.c;
    c.fillStyle = withAlpha(outer, .25); c.fill(flame(g, 5, 14.6, 6.6, -4.4, clock, 7, 8));
    c.fillStyle = withAlpha(outer, .6); c.fill(flame(g, 5, 14.4, 6.0, -3.6, clock, 7, 8));
    c.fillStyle = withAlpha(mid, .7); c.fill(flame(g, 5, 14.2, 5.0, -2.2, clock, 6, 10, 1.3));
    c.fillStyle = withAlpha(inner, .6); c.fill(flame(g, 5, 14.0, 3.8, -.8, clock, 5, 12, 2.6));
    for (let i = 0; i < 6; i++) {
      const y = 14 - ((clock * 4 + i * 2.7) % 17), x = 5 + Math.sin(i * 2.1 + clock) * 5.8;
      star(g, x, y, .35, inner);
    }
  }

  function fire(g, clock, level) {
    const l = Math.max(1, Math.min(5, level));
    const spec = [[5.3, 1.8, 4, 11], [5.8, -1.6, 5, 12], [5.8, -4.8, 5, 13], [6.8, -7.4, 6, 14], [7.8, -10.4, 7, 15]];
    const [half, top, tongues, speed] = spec[l - 1];
    const bottom = 11.6, h = bottom - top;
    if (l >= 4) { g.c.fillStyle = C(0x66FF6A1A); g.c.fill(flame(g, 5, bottom + .4, half * 1.12, top - h * .08, clock, tongues, speed)); }
    if (l === 5) g.path(flame(g, 5, bottom + .2, half * 1.05, top - h * .05, clock, tongues + 1, speed * 1.1, .6), 0xFF9E1B12);
    g.path(flame(g, 5, bottom, half, top, clock, tongues, speed), 0xFFE5391E);
    g.path(flame(g, 5, bottom - .3, half * .78, top + h * .22, clock, Math.max(2, tongues - 1), speed + 2, 1.1), 0xFFF7931E, false);
    g.path(flame(g, 5, bottom - .5, half * .52, top + h * .42, clock, Math.max(2, tongues - 2), speed + 4, 2.2), 0xFFFFD23F, false);
    if (l >= 3) g.path(flame(g, 5, bottom - .7, half * .3, top + h * .58, clock, 2, speed + 6, 3.3), 0xFFFFF6D6, false);
    const embers = 2 + l * 2;
    for (let i = 0; i < embers; i++) {
      const t = (clock * (1.2 + l * .2) + i / embers) % 1;
      const x = 5 + Math.sin(i * 2.4 + clock * 3) * half * .85, y = top + h * .3 - t * (2 + l * 1.4);
      g.c.fillStyle = C(0xFFF7931E); g.c.fill(g.circ(g.o(x, y), g.px * (.18 + l * .04) * (1 - t)));
    }
  }

  function charm(g, id, ax, ay, swing, clock) {
    const s = 1.25, px = g.px, c = g.c, suneung = id === 'charm_suneung', red = 0xFFC81E1E;
    const paper = suneung ? 0xFFE8B83A : 0xFFF6D86A;
    c.save();
    c.translate(ax * px, ay * px); c.rotate(swing); c.scale(s, s); c.translate(-ax * px, -ay * px);
    const w = 1.9, h = 2.6, x = ax - w / 2, y = ay + .3;
    g.thin(g.o(ax, ay - .2), g.o(ax, y), red, .18);
    const sheet = g.round(x, y, w, h, .12);
    g.path(sheet, paper);
    g.clipped(sheet, () => {
      if (suneung) g.thin(g.o(x - .2, y + 1.6), g.o(x + 1.2, y - .2), 0x99FFF6D0, .35);
      c.lineWidth = px * .12; c.strokeStyle = C(red); c.strokeRect((x + .2) * px, (y + .2) * px, (w - .4) * px, (h - .4) * px);
    });
    const cx = ax, cy = y + h / 2 + .05;
    const st = (x0, y0, x1, y1) => g.thin(g.o(cx + x0, cy + y0), g.o(cx + x1, cy + y1), red, .17);
    if (suneung) {
      st(0, -.85, -.7, -.25); st(0, -.85, .7, -.25); st(-.32, -.2, .32, -.2);
      c.lineWidth = px * .17; c.strokeStyle = C(red); c.strokeRect((cx - .42) * px, (cy + .05) * px, .84 * px, .65 * px);
      g.path(g.oval(ax - .45, ay - .05, .9, .7), red);
      for (const dx of [-.3, 0, .3]) g.thin(g.o(ax + dx, y + h), g.o(ax + dx * 1.3, y + h + 1.0), red, .16);
      if (Math.sin(clock * 3) > .3) star(g, x + w + .2, y + .2, .45, WHITE);
    } else {
      c.lineWidth = px * .16; c.strokeStyle = C(red); c.stroke(g.circ(g.o(cx, cy), .75 * px));
      st(0, -.42, 0, .42); st(-.22, -.24, 0, -.42); st(-.22, .42, .22, .42);
    }
    c.restore();
  }

  /**
   * 캔버스 원점(그림 칸 왼쪽 위)에 아바타를 그린다.
   * opts: pose('stand'|'walk'|'wave'|'cheer'|'hop'|'chat'|'shock'), px, frame(0|1), clock(초), fireLevel, eyesClosed
   */
  function drawAvatar(ctx, look, opts) {
    const pose = opts.pose || 'stand', px = opts.px, f = opts.frame || 0, clock = opts.clock || 0;
    const fireLevel = opts.fireLevel || 0, eyesClosed = !!opts.eyesClosed;
    const g = new Pen(ctx, px);
    const o = Object.assign({ top: 'tee_white', bottom: 'shorts', shoes: 'sneaker' }, look.outfit || {});

    if (o.aura === 'aura_gold') aura(g, clock, 0xFFFFC21A, 0xFFFFE36B, 0xFFFFF8D0);
    else if (o.aura === 'aura_blue') aura(g, clock, 0xFF2E9BEA, 0xFF7FD0FF, 0xFFE2F6FF);
    if (fireLevel > 0) fire(g, clock, fireLevel);

    const costume = o.costume || null;
    const frank = costume === 'frank', pumpkin = costume === 'pumpkin', ghost = costume === 'ghost';
    const spider = costume === 'spider', armor = costume === 'armor', gown = costume === 'gown';
    const masked = spider || armor;
    const topId = costume == null ? o.top : '', bottomId = costume == null ? o.bottom : '';
    const skin = frank ? 0xFF9CC37A : spider ? SP_RED : armor ? AGOLD : look.skin;
    const hair = frank ? INK : look.hairColor;
    const hairStyle = frank ? 'buzz' : masked ? 'bald' : look.hair;
    const [tc, tlong] = ({ frank: [0xFF3B3A36, true], pumpkin: [PUMPKIN, false], spider: [SP_RED, true], armor: [STEEL, false], gown: [GOWN, false] })[costume] || topSpec(o.top);
    const sleeve = topId === 'vest' ? WHITE : tc;
    const [bc, bcut] = ({ frank: [0xFF2B2D33, 'long'], pumpkin: [0xFF2E6B3A, 'long'], spider: [SP_BLUE, 'long'], armor: [STEEL, 'long'], gown: [GOWN, 'none'] })[costume] || bottomSpec(o.bottom);

    const head = g.oval(.6, .2, 8.8, 8.2);
    const padded = topId === 'padding';
    const body = new Path2D();
    body.moveTo(2.4 * px, 7.6 * px); body.lineTo(7.6 * px, 7.6 * px);
    body.quadraticCurveTo(8.4 * px, 7.7 * px, 8.5 * px, 9 * px);
    body.lineTo((padded ? 8.9 : 8.6) * px, (padded ? 13 : 12.4) * px);
    body.lineTo((padded ? 1.1 : 1.4) * px, (padded ? 13 : 12.4) * px);
    body.lineTo(1.5 * px, 9 * px);
    body.quadraticCurveTo(1.6 * px, 7.7 * px, 2.4 * px, 7.6 * px); body.closePath();

    // ── 등 ──
    const flap = f === 0 ? 0 : -.35;
    if (o.back === 'backpack') g.path(g.round(.8, 8.2, 8.4, 4.2, 1), 0xFFE67E22);
    else if (o.back === 'wings') {
      for (const [x, y, w] of [[-2.3, 7.5, 3.4], [-2.9, 8.7, 3.9], [-2.2, 9.9, 3.2]]) {
        g.path(g.oval(x, y + flap, w, 1.4), 0xFFFFFFFF); g.path(g.oval(10 - x - w, y + flap, w, 1.4), 0xFFFFFFFF);
      }
    } else if (o.back === 'batwings') {
      const col = 0xFF5B3A8C;
      g.path(g.poly([[2, 8.4], [-2.6, 7.2 + flap], [-1.8, 9 + flap], [-2.8, 10.4 + flap], [-.6, 10], [1.6, 11]]), col);
      g.path(g.poly([[8, 8.4], [12.6, 7.2 + flap], [11.8, 9 + flap], [12.8, 10.4 + flap], [10.6, 10], [8.4, 11]]), col);
    }

    // 뒤로 늘어진 긴 머리
    switch (ghost ? null : hairStyle) {
      case 'long': g.path(g.round(.3, 2.6, 9.4, 7.4, 2.2), hair); break;
      case 'bob': g.path(g.round(.1, 2.2, 9.8, 5.6, 2.4), hair); break;
      case 'twin': g.path(g.oval(-1.6, 4.0, 2.6, 4.6), hair); g.path(g.oval(9.0, 4.0, 2.6, 4.6), hair); break;
      case 'ponytail': g.path(g.oval(7.2, .2, 3.6, 6.4), hair); break;
      case 'wavy': {
        const parts = [g.round(-.2, 2.0, 10.4, 9.0, 3)];
        for (let i = 0; i < 5; i++) parts.push(g.oval(-.6 + i * 2.2, 10.2 + (i % 2 === 0 ? .4 : 0), 2.4, 1.8));
        g.union(parts, hair);
        for (const x of [.6, 9.4]) {
          const w = new Path2D();
          w.moveTo(x * px, 6 * px);
          w.quadraticCurveTo((x + (x < 5 ? -.5 : .5)) * px, 7.6 * px, x * px, 9 * px);
          w.quadraticCurveTo((x + (x < 5 ? .5 : -.5)) * px, 10 * px, x * px, 11 * px);
          ctx.lineWidth = px * .16; ctx.strokeStyle = shade(hair, .3); ctx.stroke(w);
        }
        break;
      }
      case 'braid': g.path(g.round(.3, 2.4, 9.4, 5.4, 2.2), hair); break;
      case 'updo': g.path(g.oval(1.6, -2.4, 6.8, 4.2), hair); break;
    }
    if (topId === 'hoodie') { ctx.fillStyle = shade(tc, .15); ctx.fill(g.oval(1.8, 6.6, 6.4, 2.4)); g.outline(g.oval(1.8, 6.6, 6.4, 2.4)); }

    // ── 다리·신발 ──
    const walking = pose === 'walk';
    const shoesId = masked ? '' : o.shoes;
    const shoe = spider ? SP_RED : armor ? STEEL : shoeColor(shoesId);
    for (const [x, lift] of [[2.3, walking && f === 0 ? .5 : 0], [5.4, walking && f === 1 ? .5 : 0]]) {
      const legTop = 12, foot = 13.2 - lift;
      if (bcut === 'long') {
        g.path(g.rect(x, legTop, 2.3, foot - legTop), bc);
        if (bottomId === 'training') { const lx = x < 5 ? x + .3 : x + 2.0; g.thin(g.o(lx, legTop), g.o(lx, foot), WHITE, .25); }
      } else if (bcut === 'short') {
        g.path(g.rect(x + .3, legTop, 1.7, foot - legTop), skin);
        g.path(g.rect(x, legTop, 2.3, .7), bc);
      } else g.path(g.rect(x + .3, legTop, 1.7, foot - legTop), skin);
      if (shoesId === 'boots' || masked) g.path(g.round(x - .1, foot - 1.0, 2.5, 1.6, .4), shoe);
      g.path(g.oval(x - .5, foot - .1, 3.2, 1.1), shoesId === 'slipper' ? skin : shoe);
      if (shoesId === 'slipper') {
        g.path(g.round(x - .3, foot - .1, 2.8, .55, .25), shoe);
        for (let i = 0; i < 3; i++) g.thin(g.o(x + .2 + i * .7, foot - .05), g.o(x + .2 + i * .7, foot + .4), WHITE, .15);
      } else if (shoesId === 'sneaker' || shoesId === 'red_sneaker') {
        g.thin(g.o(x - .3, foot + .75), g.o(x + 2.5, foot + .75), shade(shoe, .25), .2);
      } else if (shoesId === 'loafer') g.thin(g.o(x + .5, foot + .2), g.o(x + 1.4, foot + .2), GOLD, .2);
    }
    if (bcut === 'skirt') {
      const sk = g.poly([[1.6, 11.4], [8.4, 11.4], [9.0, 12.9], [1.0, 12.9]]);
      g.path(sk, bc);
      g.clipped(sk, () => {
        for (let i = 0; i < 5; i++) g.thin(g.o(1.8 + i * 1.6, 11.4), g.o(1.4 + i * 1.8, 12.9), 0x55000000, .3);
        g.thin(g.o(0, 12.2), g.o(10, 12.2), 0x55FFFFFF, .3);
      });
    }

    // ── 몸통·상의 ──
    g.path(body, tc);
    g.clipped(body, () => {
      switch (topId) {
        case 'tee_white': g.path(g.oval(4.0, 7.2, 2.0, 1.0), 0xFFDAD6CC, false); break;
        case 'tee_stripe': g.path(g.rect(0, 9.2, 10, .7), 0xFFE0443C, false); g.path(g.rect(0, 10.8, 10, .7), 0xFFE0443C, false); break;
        case 'gym': g.thin(g.o(5, 7.6), g.o(5, 12.4), WHITE, .22); g.thin(g.o(1.5, 9.4), g.o(8.5, 9.4), WHITE, .3); break;
        case 'hawaii':
          for (const [x, y, c] of [[2.6, 8.9, 0xFFF59AA6], [6.4, 9.1, 0xFFF4D02F], [3.9, 10.8, 0xFFF59AA6], [7.1, 11.3, 0xFFF4D02F], [2.3, 11.6, 0xFFF4D02F]]) g.path(g.oval(x, y, .9, .9), c, false);
          g.path(g.poly([[4.0, 7.6], [5.0, 8.8], [6.0, 7.6]]), WHITE); break;
        case 'check':
          for (let i = 0; i < 10; i++) { g.thin(g.o(i * 1.2, 7), g.o(i * 1.2, 13), 0x55000000, .45); g.thin(g.o(0, 7.6 + i * 1.2), g.o(10, 7.6 + i * 1.2), 0x55000000, .45); }
          break;
        case 'soccer':
          g.path(g.oval(4.0, 7.2, 2.0, 1.0), WHITE, false);
          ctx.fillStyle = C(WHITE); ctx.font = `700 ${px * 2.4}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText('8', 5 * px, 9.1 * px); break;
        case 'hoodie':
          ctx.fillStyle = shade(tc, .12); ctx.fill(g.round(3, 10.2, 4, 1.5, .5)); g.outline(g.round(3, 10.2, 4, 1.5, .5));
          g.thin(g.o(4.3, 7.8), g.o(4.3, 9.4), WHITE, .2); g.thin(g.o(5.7, 7.8), g.o(5.7, 9.4), WHITE, .2); break;
        case 'vest':
          g.path(g.rect(0, 7, 10, 7), WHITE, false);
          g.path(g.poly([[1.3, 8.6], [3.6, 8.2], [5, 10], [6.4, 8.2], [8.7, 8.6], [8.8, 12.6], [1.2, 12.6]]), tc); break;
        case 'suit':
          g.path(g.poly([[3.8, 7.6], [6.2, 7.6], [5, 10.6]]), WHITE);
          g.path(g.poly([[4.7, 8.0], [5.3, 8.0], [5.5, 10.2], [5, 10.7], [4.5, 10.2]]), 0xFFC0392B); break;
        case 'padding':
          for (const y of [9.2, 10.6, 12.0]) g.thin(g.o(0, y), g.o(10, y), 0xFF44464F, .2);
          g.thin(g.o(5, 7.6), g.o(5, 13), 0xFF8E9AA6, .2); break;
      }
    });
    if (frank) {
      g.path(g.poly([[1.4, 12.2], [2.4, 13.1], [3.2, 12.3], [4.4, 13.2], [5.4, 12.3], [6.6, 13.1], [7.6, 12.3], [8.6, 13.0], [8.6, 12.2]]), tc);
      g.path(g.rect(5.8, 9.6, 1.6, 1.4), 0xFF6B5B45);
      g.thin(g.o(5.8, 9.6), g.o(7.4, 11.0), INK, .12);
    }
    if (spider) {
      g.clipped(body, () => {
        g.clipped(g.poly([[0, 7], [10, 7], [10, 8.8], [7.2, 9.6], [6.6, 11.6], [3.4, 11.6], [2.8, 9.6], [0, 8.8]]), () => web(g, 5, 7.4, 6.0));
        g.path(g.poly([[0, 8.8], [2.8, 9.6], [3.4, 11.6], [3.4, 13], [0, 13]]), SP_BLUE, false);
        g.path(g.poly([[10, 8.8], [7.2, 9.6], [6.6, 11.6], [6.6, 13], [10, 13]]), SP_BLUE, false);
        g.path(g.rect(0, 11.6, 10, 2), SP_BLUE, false);
      });
      g.outline(body);
      g.path(g.oval(4.6, 8.5, .8, 1.5), INK, false);
      for (const side of [-1, 1]) for (const [y0, dx, dy] of [[8.8, .9, -.7], [9.1, 1.1, -.1], [9.5, 1.1, .4], [9.8, .8, 1.0]]) {
        g.thin(g.o(5 + side * .3, y0), g.o(5 + side * (.3 + dx), y0 + dy), INK, .16);
      }
    }
    if (armor) {
      g.clipped(body, () => {
        g.path(g.poly([[3.2, 10.4], [6.8, 10.4], [6.4, 12.6], [3.6, 12.6]]), AGOLD);
        g.thin(g.o(3.2, 11.5), g.o(6.8, 11.5), shade(AGOLD, .3), .18);
        g.thin(g.o(1.6, 8.4), g.o(3.6, 9.8), shade(STEEL, .3), .2);
        g.thin(g.o(8.4, 8.4), g.o(6.4, 9.8), shade(STEEL, .3), .2);
      });
      g.outline(body);
      ctx.fillStyle = withAlpha(AGLOW, .35 + .2 * Math.sin(clock * 4)); ctx.fill(g.circ(g.o(5, 9.1), px * 1.6));
      g.path(g.oval(4.15, 8.25, 1.7, 1.7), 0xFF9AA3AD);
      g.path(g.oval(4.45, 8.55, 1.1, 1.1), AGLOW);
      g.path(g.oval(4.7, 8.8, .6, .6), 0xFFFFFFFF, false);
    }
    if (gown) {
      const sk = new Path2D();
      sk.moveTo(2 * px, 10.4 * px); sk.lineTo(8 * px, 10.4 * px);
      sk.quadraticCurveTo(9.6 * px, 11.8 * px, 10.6 * px, 13.9 * px);
      sk.quadraticCurveTo(5 * px, 14.7 * px, -.6 * px, 13.9 * px);
      sk.quadraticCurveTo(.4 * px, 11.8 * px, 2 * px, 10.4 * px); sk.closePath();
      g.path(sk, GOWN);
      g.clipped(sk, () => {
        for (const x of [2.6, 5.0, 7.4]) g.thin(g.o(x, 10.6), g.o(x + (x - 5) * .7, 14.2), shade(GOWN, .12), .3);
        g.path(g.rect(-1, 13.2, 12, 1.6), 0xFFFFF0F6, false);
      });
      g.outline(sk);
      g.clipped(body, () => g.path(g.poly([[2.6, 7.6], [5, 9.8], [7.4, 7.6], [7.4, 7.2], [2.6, 7.2]]), 0xFFFFF0F6, false));
      g.path(g.round(2.2, 10.0, 5.6, .8, .3), 0xFFF06A9A);
      g.path(g.poly([[5, 10.4], [3.8, 9.8], [3.8, 11.0]]), 0xFFF06A9A);
      g.path(g.poly([[5, 10.4], [6.2, 9.8], [6.2, 11.0]]), 0xFFF06A9A);
    }
    if (pumpkin) {
      const ball = g.oval(-.6, 7.0, 11.2, 6.5);
      g.path(ball, PUMPKIN);
      g.clipped(ball, () => {
        for (const [x, w] of [[1.6, 6.8], [3.4, 3.2]]) { ctx.lineWidth = px * .22; ctx.strokeStyle = shade(PUMPKIN, .22); ctx.stroke(g.oval(x, 7.0, w, 6.5)); }
      });
      g.outline(ball);
      const glow = 0xFFFFD34D;
      g.path(g.poly([[2.2, 9.9], [3.2, 8.4], [4.2, 9.9]]), glow);
      g.path(g.poly([[5.8, 9.9], [6.8, 8.4], [7.8, 9.9]]), glow);
      g.path(g.poly([[1.8, 10.6], [8.2, 10.6], [7.4, 12.0], [6.6, 11.4], [5.8, 12.2], [5.0, 11.4], [4.2, 12.2], [3.4, 11.4], [2.6, 12.0]]), glow);
      g.path(g.poly([[3.6, 7.3], [5, 6.5], [6.4, 7.3], [5, 8.1]]), 0xFF3E8E4A);
    }
    if (o.back === 'backpack') { g.stick(g.o(3, 7.9), g.o(3.2, 11), .45, 0xFFC0651B); g.stick(g.o(7, 7.9), g.o(6.8, 11), .45, 0xFFC0651B); }

    // ── 팔 ──
    const lower = tlong ? sleeve : skin;
    let rightHand = null;
    const arm = (s, e, right) => {
      g.stick(s, e, 1.2, lower);
      g.stick(s, lerp(s, e, tlong ? 1 : .45), 1.25, sleeve);
      if (gown) g.path(g.circ(s, 1.15 * px), sleeve);
      g.path(g.circ(e, .62 * px), skin);
      if (right) rightHand = e;
    };
    const ls = g.o(2.0, 8.6), rs = g.o(8.0, 8.6);
    const down = (r) => arm(r ? rs : ls, r ? g.o(8.9, 11.0) : g.o(1.1, 11.0), r);
    const up = (r, w = 0) => arm(r ? rs : ls, r ? g.o(9.9, 6.4 + w) : g.o(.1, 6.4 + w), r);
    const forward = () => arm(rs, g.o(10.7, 8.2), true);
    const armsUp = pose === 'cheer' || pose === 'wave' || pose === 'shock';
    const arms = () => {
      switch (pose) {
        case 'cheer': up(false, f * .6); up(true, (1 - f) * .6); break;
        case 'shock': up(false); up(true); break;
        case 'wave': down(false); up(true, f * .9); break;
        case 'chat': down(false); if (f === 0) forward(); else down(true); break;
        default: down(false); down(true);
      }
    };
    if (!armsUp) arms();

    // ── 머리 ──
    g.path(head, skin);
    if (hairStyle === 'bald') g.thin(g.o(2.6, 1.6), g.o(3.6, 1.0), 0x66FFFFFF, .35);
    else if (hairStyle === 'curly') {
      for (let i = 0; i < 7; i++) {
        const a = PI * (1.08 + i * .14);
        g.path(g.circ(g.o(5 + Math.cos(a) * 4.0, 4.3 + Math.sin(a) * 3.8), 1.15 * px), hair);
      }
      g.clipped(head, () => g.path(g.rect(0, 0, 10, 2.3), hair, false));
    } else {
      let fringe;
      if (hairStyle === 'bob' || hairStyle === 'ponytail') fringe = g.rect(0, 0, 10, 2.85);
      else if (hairStyle === 'buzz') fringe = g.rect(0, 0, 10, 1.5);
      else if (hairStyle === 'wavy' || hairStyle === 'braid' || hairStyle === 'updo') {
        fringe = new Path2D();
        fringe.moveTo(0, 0); fringe.lineTo(10 * px, 0); fringe.lineTo(10 * px, 3.4 * px);
        fringe.quadraticCurveTo(6.5 * px, 1.0 * px, 3.0 * px, 2.0 * px);
        fringe.quadraticCurveTo(1.4 * px, 2.6 * px, .6 * px, 4.6 * px);
        fringe.lineTo(0, 4.6 * px); fringe.closePath();
      } else {
        fringe = new Path2D();
        fringe.moveTo(0, 0); fringe.lineTo(10 * px, 0); fringe.lineTo(10 * px, 3.0 * px);
        for (let i = 8; i >= 0; i--) fringe.lineTo((i + .5) * px + .6 * px, (i % 2 === 0 ? 2.2 : 2.9) * px);
        fringe.lineTo(0, 3.0 * px); fringe.closePath();
      }
      g.clipped(head, () => g.path(fringe, hair));
      g.outline(head);
      if (hairStyle === 'bun') g.path(g.oval(4, -1.5, 2, 2), hair);
      if (hairStyle === 'twin') { g.path(g.oval(-.1, 3.9, .9, .9), 0xFFE0443C); g.path(g.oval(9.2, 3.9, .9, .9), 0xFFE0443C); }
      if (hairStyle === 'ponytail') g.path(g.oval(8.2, .6, .9, .9), 0xFFE0443C);
      if (hairStyle === 'updo') {
        ctx.fillStyle = shade(hair, .12); ctx.fill(g.oval(3.0, -2.9, 4.0, 2.0)); g.outline(g.oval(3.0, -2.9, 4.0, 2.0));
        g.path(g.oval(6.6, -1.6, 1.2, 1.2), 0xFF8FD0F0);
        for (const x of [.5, 9.5]) {
          const p = new Path2D();
          p.moveTo(x * px, 3.2 * px); p.quadraticCurveTo((x + (x < 5 ? -.8 : .8)) * px, 5 * px, x * px, 6.6 * px);
          g.strokePath(p, hair, .45);
        }
      }
      if (hairStyle === 'spiky') g.path(g.poly([[1.6, 1.6], [2.2, -.6], [3.4, .6], [4.4, -1.2], [5.4, .4], [6.6, -.9], [7.4, .6], [8.6, -.2], [8.4, 1.6]]), hair);
    }

    // ── 얼굴 ──
    const eyeL = g.oval(2.5, 3.0, 2.6, 3.0), eyeR = g.oval(4.9, 3.0, 2.6, 3.0);
    if (eyesClosed) {
      g.path(eyeL, skin); g.path(eyeR, skin);
      g.thin(g.o(2.8, 4.7), g.o(4.9, 4.7), INK, .22); g.thin(g.o(5.1, 4.7), g.o(7.2, 4.7), INK, .22);
    } else {
      g.path(eyeL, 0xFFFFFFFF); g.path(eyeR, 0xFFFFFFFF);
      const r = pose === 'shock' ? .2 : .34;
      ctx.fillStyle = C(INK);
      ctx.fill(g.circ(g.o(4.3, 4.6), r * px)); ctx.fill(g.circ(g.o(5.7, 4.6), r * px));
    }
    if (look.face === 'lashes' && !eyesClosed) {
      for (const [x0, y0, x1, y1] of [[2.7, 3.6, 2.0, 3.0], [3.3, 3.2, 2.9, 2.5], [7.3, 3.6, 8.0, 3.0], [6.7, 3.2, 7.1, 2.5]]) g.thin(g.o(x0, y0), g.o(x1, y1), INK, .22);
    } else if (look.face === 'sleepy' && !eyesClosed) {
      for (const eye of [eyeL, eyeR]) g.clipped(eye, () => g.path(g.rect(0, 2.8, 10, 1.55), skin));
      g.thin(g.o(2.6, 4.35), g.o(5.0, 4.35), INK, .2); g.thin(g.o(5.0, 4.35), g.o(7.4, 4.35), INK, .2);
    } else if (look.face === 'blush') {
      ctx.fillStyle = C(0x66F06A8A);
      for (const x of [1.6, 7.0]) ctx.fill(g.oval(x, 5.9, 1.4, .8));
    } else if (look.face === 'freckles') {
      ctx.fillStyle = C(0xAA8C5A3C);
      for (const [x, y] of [[2.0, 6.0], [2.6, 6.4], [1.8, 6.6], [7.9, 6.0], [7.3, 6.4], [8.1, 6.6]]) ctx.fill(g.circ(g.o(x, y), px * .14));
    }
    if (fireLevel > 0 && !eyesClosed) { g.stick(g.o(2.7, 3.0), g.o(4.7, 3.8), .45, INK); g.stick(g.o(7.3, 3.0), g.o(5.3, 3.8), .45, INK); }
    const mouthDark = 0xFF5A1F1C;
    if (pose === 'cheer' || pose === 'hop') {
      const m = new Path2D();
      m.moveTo(3.8 * px, 6.7 * px); m.quadraticCurveTo(5 * px, 8.6 * px, 6.2 * px, 6.7 * px); m.closePath();
      g.path(m, mouthDark);
      g.clipped(m, () => g.path(g.rect(3.6, 6.6, 3, .45), 0xFFFFFFFF, false));
    } else if (pose === 'shock') g.path(g.oval(4.5, 6.6, 1.0, 1.2), mouthDark);
    else if (pose === 'chat') g.path(g.oval(4.4, 6.8, 1.2, f === 0 ? 1.0 : .45), mouthDark);
    else {
      const m = new Path2D();
      m.moveTo(4.3 * px, 7.0 * px); m.quadraticCurveTo(5 * px, 7.35 * px, 5.7 * px, 7.0 * px);
      g.strokePath(m, INK, .2);
    }

    switch (o.face) {
      case 'glasses':
        ctx.lineWidth = px * .3; ctx.strokeStyle = C(INK);
        ctx.stroke(g.oval(2.3, 2.8, 3.0, 3.4)); ctx.stroke(g.oval(4.7, 2.8, 3.0, 3.4)); break;
      case 'sunglasses':
        g.path(g.round(2.3, 3.6, 2.8, 1.9, .8), INK); g.path(g.round(4.9, 3.6, 2.8, 1.9, .8), INK);
        g.thin(g.o(2.8, 4.0), g.o(3.5, 4.0), 0x99FFFFFF, .25); g.thin(g.o(5.4, 4.0), g.o(6.1, 4.0), 0x99FFFFFF, .25); break;
      case 'mask':
        g.path(g.round(2.8, 6.1, 4.4, 2.2, .7), 0xFFF2F2F2);
        g.thin(g.o(2.8, 6.6), g.o(1.0, 5.6), 0xFFCFCFCF, .2); g.thin(g.o(7.2, 6.6), g.o(9.0, 5.6), 0xFFCFCFCF, .2);
        g.thin(g.o(3.0, 7.2), g.o(7.0, 7.2), 0xFFD5D5D5, .15); break;
      case 'mustache': {
        ctx.fillStyle = shade(hair, .15);
        for (const pts of [[[5, 6.3], [3.4, 6.2], [2.8, 6.9], [4.0, 6.7], [5, 6.9]], [[5, 6.3], [6.6, 6.2], [7.2, 6.9], [6.0, 6.7], [5, 6.9]]]) { const p = g.poly(pts); ctx.fill(p); g.outline(p); }
        break;
      }
    }
    if (hairStyle === 'braid' && !ghost) {
      for (let i = 0; i < 5; i++) g.path(g.oval(7.3 + (i % 2 === 0 ? 0 : .35) + i * .12, 5.6 + i * 1.25, 1.9, 1.6), hair);
      g.path(g.oval(7.9, 11.6, 1.0, .8), 0xFF8FD0F0);
      g.path(g.poly([[8.0, 12.3], [8.9, 12.3], [9.2, 13.3], [7.7, 13.3]]), hair);
    }

    // ── 코스튬 머리 ──
    if (spider) {
      g.path(head, SP_RED);
      g.clipped(head, () => web(g, 5, 4.4, 6.5));
      g.outline(head);
      const sq = eyesClosed ? .45 : 1;
      for (const side of [-1, 1]) {
        const cx = 5 + side * 1.9, p = new Path2D();
        p.moveTo((5 + side * .5) * px, (4.4 + .3 * sq) * px);
        p.quadraticCurveTo((cx + side * 1.4) * px, (4.4 - 2.2 * sq) * px, (cx + side * 1.6) * px, 4.6 * px);
        p.quadraticCurveTo((cx + side * .2) * px, (4.6 + 1.6 * sq) * px, (5 + side * .5) * px, (4.4 + .3 * sq) * px);
        p.closePath();
        ctx.fillStyle = '#fff'; ctx.fill(p);
        ctx.lineWidth = px * .45; ctx.lineJoin = 'round'; ctx.strokeStyle = C(INK); ctx.stroke(p);
      }
    }
    if (armor) {
      g.path(head, STEEL);
      g.path(g.poly([[2.6, 2.0], [7.4, 2.0], [8.2, 3.2], [8.0, 5.8], [6.8, 7.6], [3.2, 7.6], [2.0, 5.8], [1.8, 3.2]]), AGOLD);
      g.thin(g.o(5, .3), g.o(5, 2.0), shade(STEEL, .3), .25);
      for (const side of [-1, 1]) g.path(g.poly([[5 + side * .6, 4.3], [5 + side * 2.4, 3.9], [5 + side * 2.3, 4.6], [5 + side * .7, 4.8]]), eyesClosed ? shade(AGOLD, .4) : 0xFFFFFFFF);
      g.thin(g.o(3.8, 6.5), g.o(6.2, 6.5), shade(AGOLD, .45), .22);
      g.thin(g.o(2.4, 5.6), g.o(3.4, 6.8), shade(AGOLD, .3), .16);
      g.thin(g.o(7.6, 5.6), g.o(6.6, 6.8), shade(AGOLD, .3), .16);
    }
    if (gown) {
      g.path(g.poly([[3.2, 1.2], [3.6, .1], [4.3, .7], [5, -.6], [5.7, .7], [6.4, .1], [6.8, 1.2]]), 0xFFDDE3EA);
      g.path(g.oval(4.6, -.1, .8, .8), 0xFFF06A9A);
    }
    if (frank) {
      g.path(g.poly([[.9, 2.3], [.9, -.6], [9.1, -.6], [9.1, 2.3], [8.1, 1.7], [7.1, 2.4], [6.1, 1.7], [5.0, 2.4], [3.9, 1.7], [2.9, 2.4], [1.9, 1.7]]), hair);
      g.thin(g.o(7.4, 5.6), g.o(8.4, 7.0), INK, .16);
      for (const t of [.25, .5, .75]) {
        const c = lerp(g.o(7.4, 5.6), g.o(8.4, 7.0), t);
        g.thin([c[0] - .3 * px, c[1] + .2 * px], [c[0] + .3 * px, c[1] - .2 * px], INK, .12);
      }
      for (const x of [-.6, 9.3]) g.path(g.round(x, 6.2, 1.3, .9, .2), 0xFF9AA0A8);
    }
    if (pumpkin) { g.path(g.round(4.5, -1.7, 1.0, 2.1, .3), 0xFF6B4A2A); g.path(g.oval(5.3, -1.5, 2.4, 1.1), 0xFF3E8E4A); }

    // ── 머리 장식 ──
    const hatClip = (h) => g.rect(-1, -2, 12, h);
    switch (costume != null ? null : o.hat) {
      case 'cap': {
        const col = 0xFF2F5BD0;
        g.clipped(hatClip(4.4), () => g.path(g.oval(.5, -.3, 9, 6), col));
        ctx.fillStyle = shade(col, .25); ctx.fill(g.oval(0, 1.7, 6.8, 1.2)); g.outline(g.oval(0, 1.7, 6.8, 1.2));
        g.path(g.oval(4.5, -.5, 1, .7), WHITE); break;
      }
      case 'beanie': {
        const col = 0xFFD9453B;
        g.clipped(hatClip(4), () => g.path(g.oval(.6, -.8, 8.8, 6), col));
        ctx.fillStyle = shade(col, .15); ctx.fill(g.round(.3, 1.4, 9.4, 1.4, .6)); g.outline(g.round(.3, 1.4, 9.4, 1.4, .6));
        g.path(g.circ(g.o(5, -1.0), .95 * px), WHITE); break;
      }
      case 'straw': {
        const col = 0xFFE8C77A;
        g.path(g.oval(-1.4, .5, 12.8, 2.0), col); g.path(g.round(2.6, -1.8, 4.8, 3.0, .9), col);
        g.path(g.rect(2.6, .2, 4.8, .6), 0xFFC0392B); break;
      }
      case 'headphones':
        ctx.beginPath(); ctx.ellipse(5 * px, 3.7 * px, 4.9 * px, 4.5 * px, 0, PI * 1.05, PI * 1.95);
        ctx.lineWidth = px * .6; ctx.strokeStyle = C(INK); ctx.stroke();
        g.path(g.round(-.5, 3.2, 1.6, 2.8, .6), 0xFF2FB5A6); g.path(g.round(8.9, 3.2, 1.6, 2.8, .6), 0xFF2FB5A6); break;
      case 'ribbon': {
        const col = 0xFFE0443C;
        g.path(g.poly([[7.4, .7], [5.9, -.3], [6.0, 1.7]]), col); g.path(g.poly([[7.4, .7], [8.9, -.3], [8.8, 1.7]]), col);
        ctx.fillStyle = shade(col, .25); ctx.fill(g.oval(7.0, .3, .8, .8)); g.outline(g.oval(7.0, .3, .8, .8)); break;
      }
      case 'bunny':
        for (const x of [2.0, 6.4]) { g.path(g.oval(x, -4.3, 1.6, 4.8), WHITE); g.path(g.oval(x + .45, -3.6, .7, 3.4), 0xFFF59AA6, false); }
        break;
      case 'cat':
        g.path(g.poly([[1.4, 1.6], [2.0, -1.4], [4.0, .5]]), INK); g.path(g.poly([[8.6, 1.6], [8.0, -1.4], [6.0, .5]]), INK);
        g.path(g.poly([[2.2, 1.0], [2.4, -.4], [3.4, .5]]), 0xFFF59AA6, false); g.path(g.poly([[7.8, 1.0], [7.6, -.4], [6.6, .5]]), 0xFFF59AA6, false); break;
      case 'gradcap':
        g.path(g.round(2.2, -.6, 5.6, 1.8, .3), INK);
        g.path(g.poly([[5, -2.6], [10.2, -1.3], [5, 0], [-.2, -1.3]]), 0xFF2B2D33);
        g.thin(g.o(5, -1.3), g.o(8.8, -.2), GOLD, .2); g.thin(g.o(8.8, -.2), g.o(8.8, 1.6), GOLD, .3); break;
    }

    if (armsUp) arms();

    // ── 유령 ──
    if (ghost) {
      const sheet = new Path2D();
      sheet.moveTo(-.8 * px, 13.2 * px); sheet.lineTo(-.3 * px, 5.2 * px);
      sheet.ellipse(5 * px, 5.2 * px, 5.3 * px, 6.1 * px, 0, PI, 2 * PI);
      sheet.lineTo(10.8 * px, 13.2 * px);
      for (let i = 0; i < 5; i++) {
        const x1 = 10.8 - (i + 1) * 11.6 / 5;
        sheet.quadraticCurveTo((x1 + 11.6 / 10) * px, (i % 2 === 0 ? 14.4 : 12.6) * px, x1 * px, 13.2 * px);
      }
      sheet.closePath();
      g.path(sheet, 0xFFF6F6F2);
      const shocked = pose === 'shock' || pose === 'cheer';
      g.path(g.oval(2.7, 3.4, 1.7, eyesClosed ? .4 : 2.2), INK); g.path(g.oval(5.6, 3.4, 1.7, eyesClosed ? .4 : 2.2), INK);
      g.path(g.oval(4.4, 6.9, 1.2, shocked ? 1.6 : .8), INK);
    }

    // ── 손에 든 것 ──
    if (rightHand && !ghost) {
      const x = rightHand[0] / px, y = rightHand[1] / px;
      switch (o.hand) {
        case 'pencil':
          g.path(g.round(x - .35, y - 4.4, .7, 4.0, .1), 0xFFF4D02F);
          g.path(g.poly([[x - .35, y - 4.4], [x + .35, y - 4.4], [x, y - 5.3]]), 0xFFE8C77A);
          g.path(g.round(x - .35, y - .6, .7, .7, .1), 0xFFF59AA6); break;
        case 'vocab': g.path(g.round(x + .1, y - 1.0, 1.8, 2.2, .2), 0xFF2E7D4F); g.thin(g.o(x + .4, y - .6), g.o(x + 1.6, y - .6), WHITE, .2); break;
        case 'tumbler': g.path(g.round(x - .1, y - 1.9, 1.3, 2.6, .3), 0xFFB9C3CC); g.path(g.round(x - .1, y - 2.2, 1.3, .5, .2), INK); break;
        case 'balloon':
          g.thin(g.o(x, y), g.o(x + 1.2, y - 5.4), 0x99000000, .12);
          g.path(g.oval(x + .1, y - 8.6, 2.4, 3.2), 0xFFE0443C);
          g.thin(g.o(x + .6, y - 7.9), g.o(x + .8, y - 8.2), 0xAAFFFFFF, .3); break;
      }
    }
    if (o.charm) charm(g, o.charm, 7.2, 10.9, Math.sin(clock * 2.6) * .12 + (walking ? (f === 0 ? .1 : -.1) : 0), clock);
  }

  // 실루엣(누구인지 드러나지 않는 그림자) — 번호 입력 중에 쓴다. fill 0~1 만큼 아래에서 위로 채워진다.
  function drawSilhouette(ctx, px, fill, clock) {
    const g = new Pen(ctx, px);
    const shape = [g.oval(.6, .2, 8.8, 8.2), g.poly([[2.4, 7.6], [7.6, 7.6], [8.6, 12.4], [1.4, 12.4]]), g.rect(2.6, 12, 1.7, 1.2), g.rect(5.7, 12, 1.7, 1.2)];
    ctx.fillStyle = 'rgba(108,93,211,.14)';
    for (const p of shape) ctx.fill(p);
    if (fill > 0) {
      const topY = 13.4 - 13.4 * fill;
      ctx.save();
      ctx.beginPath(); ctx.rect(-px, topY * px, 12 * px, 16 * px); ctx.clip();
      ctx.fillStyle = 'rgba(108,93,211,.55)';
      for (const p of shape) ctx.fill(p);
      ctx.restore();
    }
    ctx.fillStyle = '#fff'; ctx.font = `800 ${px * 4.2}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = .9 + .1 * Math.sin(clock * 5);
    ctx.fillText('?', 5 * px, 4.5 * px);
    ctx.globalAlpha = 1;
  }

  global.SaebomAvatar = { drawAvatar, drawSilhouette, starter, fromDocs, star: (ctx, px, x, y, r, col) => star(new Pen(ctx, px), x, y, r, col), SKINS, HAIR_COLORS, HAIRS, FACES };
})(window);

// ══════════════════════════════════════════════════════════════
// KioskAvatar — 입실·퇴실 화면의 캐릭터 무대
// ══════════════════════════════════════════════════════════════
// 관리앱(saebom_schedule_with_hours.html)의 입실 흐름이 부르는 다섯 함수만 바깥에 연다:
//   typing(n) · reveal(student) · done(student, kind, info) · reset() · idle()
// 이 파일이 없거나 오류가 나도 입실 처리에는 영향이 없어야 한다 — 호출하는 쪽은 전부
// window.KioskAvatar?.x() 로 부르고, 여기서는 모든 진입점을 try 로 감싼다.
//
// 🔒 4자리를 다 누르기 전에는 누구인지 드러내지 않는다. 학생 60명이면 2~3자리로 한 명이
//    특정돼, 미리 캐릭터를 보여 주면 남의 번호를 추측하기 쉬워진다(뒷4자리 로그인 사건).
//    입력 중에는 누가 누르든 같은 실루엣이 한 칸씩 채워질 뿐이다.
// 데이터: avatar_profiles/{sid}(꾸미기)·avatar_outfits/{sid}(입은 옷) — 둘 다 공개 읽기.
//   sid = students.uid. 처음 한 번 받고 실시간 구독(학생이 옷을 바꾸면 새로고침 없이 반영).
// 성적·순위 같은 정보는 말풍선에 넣지 않는다 — 줄 선 학생 모두가 보는 화면이다.
(function (global) {
  'use strict';
  const A = global.SaebomAvatar;
  const PX = 6, AV_W = 10 * PX, AV_H = 14 * PX;
  const WAIT_SEC = 20;               // 앞 학생이 옆에서 기다리는 시간(다음 학생과 인사하려고)
  const CSAT = new Date('2026-11-19T00:00:00+09:00');

  let wrap, cv, ctx, W = 0, H = 0, GROUND = 0, scale = 1;
  const profiles = {}, outfits = {};
  const actors = [];
  let typed = 0, burst = null, clap = null, cur = null, raf = 0, last = 0;

  const now = () => performance.now() / 1000;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  function lookOf(s) {
    const sid = s.uid || '';
    const p = profiles[sid] || null;
    const gender = (p && (p.gender === 'm' || p.gender === 'f')) ? p.gender : (s.gender === 'm' ? 'm' : 'f');
    return A.fromDocs(gender, s.name || '', p, (outfits[sid] && outfits[sid].outfit) || null);
  }

  // ── 말풍선 문구 (AI 없이 상황별 목록) ──
  function lineFor(s, kind, info) {
    const h = new Date().getHours();
    if (kind === 'out') {
      const m = info && info.durationMin;
      const pool = ['오늘도 수고했어!', '푹 쉬고 내일 또 보자'];
      if (m >= 10) pool.push(`이번에 ${Math.floor(m / 60) ? Math.floor(m / 60) + '시간 ' : ''}${m % 60}분 집중했어!`);
      return pick(pool);
    }
    if (kind === 'away') return h >= 11 && h < 14 || h >= 17 && h < 19 ? '맛있게 먹고 와!' : '잘 다녀와!';
    if (kind === 'return') return pick(['어서 와, 다시 집중!', '돌아왔다! 이어서 가자']);
    if (kind === 'reentry') return '다시 집중 모드!';
    const pool = [h < 12 ? '좋은 아침! 오늘도 한 걸음' : h < 18 ? '오후 집중 타임 시작!' : '저녁 몰입 시간이다!', '오늘도 왔네! 시상대 노려보자', '자리 가서 바로 집중!'];
    const dday = Math.ceil((CSAT - Date.now()) / 864e5);
    if ((s.grade === '고3' || /N/.test(s.grade || '')) && dday > 0 && dday <= 100) pool.push(`수능 D-${dday}, 오늘도 쌓자`);
    const o = outfits[s.uid || ''];
    if (o && o.outfit && o.outfit.charm) pool.push('부적 챙겼지? 대박 기운!');
    return pick(pool);
  }

  // ── 무대 준비 ──
  function setup() {
    wrap = document.getElementById('ci-stage');
    if (!wrap || !A) return false;
    cv = document.createElement('canvas');
    wrap.appendChild(cv);
    ctx = cv.getContext('2d');
    new ResizeObserver(resize).observe(wrap);
    resize();
    subscribe();
    return true;
  }
  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth; H = wrap.clientHeight; GROUND = H - 8;
    // 키오스크 모드는 CSS zoom 으로 키운다 — 화면에 보이는 크기만큼 픽셀을 잡아야 선명하다.
    const r = wrap.getBoundingClientRect();
    const dpr = global.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    scale = W ? cv.width / W : 1;
    wake();
  }
  async function subscribe() {
    try {
      const db = await global.waitDb();
      if (!db || !global._fs) return;
      const { onSnapshot, collection } = global._fs;
      onSnapshot(collection(db, 'avatar_profiles'), (snap) => snap.docChanges().forEach((c) => {
        if (c.type === 'removed') delete profiles[c.doc.id]; else profiles[c.doc.id] = c.doc.data();
      }), (e) => console.warn('[캐릭터] avatar_profiles 구독 실패', e));
      onSnapshot(collection(db, 'avatar_outfits'), (snap) => snap.docChanges().forEach((c) => {
        if (c.type === 'removed') delete outfits[c.doc.id]; else outfits[c.doc.id] = c.doc.data();
      }), (e) => console.warn('[캐릭터] avatar_outfits 구독 실패', e));
    } catch (e) { console.warn('[캐릭터] 구독 실패', e); }
  }

  // ── 배우 ──
  function addActor(s, x, facing) {
    const a = { s, look: lookOf(s), x, facing, pose: 'stand', hop: 0, tasks: [], taskT: now(), born: now(), blinkAt: now() + 1 + Math.random() * 2, bubbleEl: null, bubbleUntil: 0 };
    actors.push(a); wake(); return a;
  }
  function removeActor(a) { if (a.bubbleEl) a.bubbleEl.remove(); const i = actors.indexOf(a); if (i >= 0) actors.splice(i, 1); if (cur === a) cur = null; }
  function say(a, text, sec) {
    if (!a.bubbleEl) { a.bubbleEl = document.createElement('div'); a.bubbleEl.className = 'ci-bubble'; wrap.appendChild(a.bubbleEl); }
    a.bubbleEl.textContent = text;
    a.bubbleEl.style.animation = 'none'; void a.bubbleEl.offsetWidth; a.bubbleEl.style.animation = '';
    a.bubbleUntil = now() + (sec || 2.4);
    wake();
  }
  // 할 일: walk(x) · pose(이름, 초) · call(fn) · exit
  function queue(a, ...t) { if (!a.tasks.length) a.taskT = now(); a.tasks.push(...t); wake(); }
  function clearTasks(a) { a.tasks.length = 0; a.pose = 'stand'; a.hop = 0; a.taskT = now(); }
  function leave(a) { a.waiting = false; a.leaving = true; clearTasks(a); queue(a, { k: 'walk', x: -AV_W }, { k: 'exit' }); }

  function step(a, t, dt) {
    const task = a.tasks[0];
    if (!task) { a.pose = 'stand'; a.hop = 0; return; }
    const el = t - a.taskT;
    let done = false;
    if (task.k === 'walk') {
      const d = task.x - a.x, mv = 170 * dt;
      a.facing = d >= 0 ? 1 : -1; a.pose = 'walk'; a.hop = 0;
      if (Math.abs(d) <= mv) { a.x = task.x; done = true; } else a.x += Math.sign(d) * mv;
    } else if (task.k === 'pose') {
      a.pose = task.pose; if (task.face) a.facing = task.face;
      a.hop = task.pose === 'hop' || task.pose === 'cheer' ? Math.abs(Math.sin(el * 9)) * 6 : 0;
      done = el >= task.sec;
    } else if (task.k === 'call') { task.fn(); done = true; }
    else if (task.k === 'exit') { removeActor(a); return; }
    if (done) { a.tasks.shift(); a.taskT = t; }
  }

  // ── 그리기: 움직일 게 있을 때만 돈다 (아무도 없으면 멈춤) ──
  function busy() { return actors.length || typed > 0 || burst || clap; }
  function wake() { if (!raf && ctx) { last = now(); raf = requestAnimationFrame(loop); } }
  function loop() {
    raf = -1; // 도는 중 — 이 사이 wake() 가 루프를 하나 더 만들지 않게
    try {
      const t = now(), dt = Math.min(.05, t - last); last = t;
      for (const a of actors.slice()) step(a, t, dt);
      draw(t);
    } catch (e) { console.warn('[캐릭터] 그리기 오류', e); actors.slice().forEach(removeActor); typed = 0; burst = clap = null; }
    if (busy()) raf = requestAnimationFrame(loop);
    else { raf = 0; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); }
  }
  function draw(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const a of actors) { ctx.fillStyle = 'rgba(30,27,75,.12)'; ctx.beginPath(); ctx.ellipse(a.x, GROUND + 2, Math.max(8, 22 - a.hop), 4, 0, 0, Math.PI * 2); ctx.fill(); }
    if (typed > 0) {
      ctx.save(); ctx.translate(W / 2 - AV_W / 2, GROUND - AV_H); A.drawSilhouette(ctx, PX, typed / 4, t); ctx.restore();
    }
    for (const a of actors.slice().sort((p, q) => p.born - q.born)) {
      const frame = a.pose === 'walk' ? Math.floor(t / .18) % 2 : (a.pose === 'cheer' || a.pose === 'chat') ? Math.floor(t / .25) % 2 : (a.pose === 'wave' && !a.hi5) ? Math.floor(t / .3) % 2 : 0;
      if (t > a.blinkAt + .13) a.blinkAt = t + 2 + Math.random() * 3;
      ctx.save();
      ctx.translate(a.x, GROUND - AV_H - a.hop);
      if (a.facing < 0) ctx.scale(-1, 1);
      ctx.translate(-AV_W / 2, 0);
      A.drawAvatar(ctx, a.look, { pose: a.pose, px: PX, frame, clock: t, eyesClosed: a.pose === 'stand' && t > a.blinkAt });
      ctx.restore();
      if (a.bubbleEl) {
        if (t > a.bubbleUntil) { a.bubbleEl.remove(); a.bubbleEl = null; }
        else {
          // 말풍선이 둘이면 왼쪽 학생 것은 왼쪽 위로, 오른쪽 학생 것은 오른쪽으로 비켜 겹치지 않게
          const others = actors.filter((b) => b !== a && b.bubbleEl);
          const side = !others.length ? 0 : others.every((b) => b.x > a.x) ? -1 : others.every((b) => b.x < a.x) ? 1 : 0;
          a.bubbleEl.style.setProperty('--bx', side < 0 ? '-88%' : side > 0 ? '-12%' : '-50%');
          a.bubbleEl.style.setProperty('--tail', side < 0 ? '88%' : side > 0 ? '12%' : '50%');
          a.bubbleEl.style.left = (side ? a.x : Math.max(70, Math.min(W - 70, a.x))) + 'px';
          a.bubbleEl.style.top = Math.max(26, GROUND - AV_H - a.hop - (side < 0 ? 22 : 4)) + 'px';
        }
      }
    }
    if (burst) {
      const e = t - burst.t;
      if (e > .6) burst = null;
      else for (let i = 0; i < 10; i++) {
        const ang = i * Math.PI / 5, r = 10 + e * 100;
        A.star(ctx, 1, burst.x + Math.cos(ang) * r, burst.y + Math.sin(ang) * r * .7, 6 * (1 - e / .6) + 1, i % 2 ? 0xFFF4C430 : 0xFFFFFFFF);
      }
    }
    if (clap) {
      const e = t - clap.t;
      if (e > .9) clap = null;
      else {
        for (let i = 0; i < 8; i++) { const ang = i * Math.PI / 4, r = 8 + e * 36; A.star(ctx, 1, clap.x + Math.cos(ang) * r, clap.y + Math.sin(ang) * r, 4, 0xFFF4C430); }
        ctx.font = '900 18px sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#e0443c';
        const y = clap.y - 12 - e * 10;
        ctx.strokeText('짝!', clap.x, y); ctx.fillText('짝!', clap.x, y);
      }
    }
  }

  // ── 입실 흐름에서 부르는 함수 ──
  function typing(n) { typed = Math.max(0, Math.min(4, n | 0)); if (typed && cur && !cur.done) { removeActor(cur); } wake(); }

  function reveal(s) {
    typed = 0;
    if (cur && !cur.done) removeActor(cur);
    burst = { t: now(), x: W / 2, y: GROUND - AV_H / 2 };
    cur = addActor(s, W / 2, 1);
    queue(cur, { k: 'pose', pose: 'hop', sec: .45 }, { k: 'pose', pose: 'stand', sec: .05, face: 1 });
  }

  // kind: 'in' | 'out' | 'away' | 'return' | 'reentry'
  function done(s, kind, info) {
    let a = cur;
    if (!a || a.s.name !== s.name) { if (a && !a.done) removeActor(a); a = cur = addActor(s, W / 2, 1); }
    a.done = true; a.kind = kind;
    const goingOut = kind === 'out' || kind === 'away';
    const prev = actors.filter((x) => x !== a && x.waiting && !x.leaving).pop();
    clearTasks(a);
    if (!prev) {
      queue(a, { k: 'call', fn: () => say(a, lineFor(s, kind, info), 2.6) },
        { k: 'pose', pose: goingOut ? 'wave' : 'cheer', sec: 1.6 }, { k: 'pose', pose: 'stand', sec: 99, face: 1 });
      return;
    }
    // 앞 학생과 만남 — 둘 다 들어오면 하이파이브, 한쪽이 나가면 손 흔들어 인사
    prev.waiting = false; prev.leaving = true; clearTasks(prev);
    const prevOut = prev.kind === 'out' || prev.kind === 'away';
    const hi5 = goingOut === prevOut;
    queue(a, { k: 'pose', pose: 'stand', sec: 99, face: -1 });
    queue(prev,
      { k: 'walk', x: a.x - 9.8 * PX },   // 오른손끼리 닿는 거리(팔 끝 9.9칸 × 2 − 몸 10칸)
      { k: 'pose', pose: 'stand', sec: .05, face: 1 },
      { k: 'call', fn: () => {
        clearTasks(a);
        if (hi5) {
          prev.hi5 = a.hi5 = true;
          say(prev, goingOut ? '오늘도 수고했어!' : pick(['어서 와!', '같이 하자!', '오늘도 파이팅!']), 1.6);
          setTimeout(() => { clap = { t: now(), x: (prev.x + a.x) / 2, y: GROUND - AV_H + 6.4 * PX }; wake(); }, 250);
          queue(a, { k: 'pose', pose: 'wave', sec: .7, face: -1 }, { k: 'call', fn: () => { a.hi5 = false; say(a, lineFor(s, kind, info), 2.6); } },
            { k: 'pose', pose: goingOut ? 'wave' : 'cheer', sec: 1.2 }, { k: 'pose', pose: 'stand', sec: 99, face: 1 });
        } else {
          say(prev, goingOut ? '내일 봐!' : '열공해!', 1.8);
          say(a, lineFor(s, kind, info), 2.6);
          queue(a, { k: 'pose', pose: 'wave', sec: 1.4, face: -1 }, { k: 'pose', pose: 'stand', sec: 99, face: 1 });
        }
      } },
      { k: 'pose', pose: 'wave', sec: hi5 ? .7 : 1.2, face: 1 },
      { k: 'call', fn: () => { prev.hi5 = false; } },
      { k: 'pose', pose: 'hop', sec: .4 },
      { k: 'walk', x: -AV_W }, { k: 'exit' });
  }

  // checkinReset 이 부른다 — 처리를 마친 학생은 옆으로 비켜 기다리고, 취소한 학생은 나간다.
  function reset() {
    typed = 0;
    const a = cur; cur = null;
    if (a && actors.includes(a)) {
      if (a.done) {
        for (const w of actors.filter((x) => x.waiting)) leave(w);   // 무대엔 많아야 2~3명
        clearTasks(a); a.waiting = true;
        queue(a, { k: 'walk', x: AV_W * .6 }, { k: 'pose', pose: 'stand', sec: WAIT_SEC, face: 1 },
          { k: 'call', fn: () => { a.waiting = false; a.leaving = true; } }, { k: 'walk', x: -AV_W }, { k: 'exit' });
      } else {
        clearTasks(a); a.leaving = true;
        queue(a, { k: 'pose', pose: 'shock', sec: .4 }, { k: 'walk', x: W + AV_W }, { k: 'exit' });
      }
    }
    wake();
  }

  const safe = (fn) => function () { try { return fn.apply(null, arguments); } catch (e) { console.warn('[캐릭터]', e); } };
  let ready = false;
  const init = () => { if (!ready) ready = setup(); return ready; };
  const guard = (fn) => safe(function () { if (!init()) return; return fn.apply(null, arguments); });
  global.KioskAvatar = {
    typing: guard(typing), reveal: guard(reveal), done: guard(done), reset: guard(reset),
    idle: () => !actors.length && !typed,   // 자동 새로고침이 끼어들어도 되는 순간인가
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
