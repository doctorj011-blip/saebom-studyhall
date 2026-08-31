# -*- coding: utf-8 -*-
"""관리앱(saebom_schedule_with_hours.html)에 OS 다크모드를 입힌다.

방식: 코드에 박힌 색을 '쓰이는 자리(배경/글자/테두리)'별로 토큰화하고,
      :root 에 원래 색을, @media (prefers-color-scheme: dark) 에 어두운 짝을 정의한다.
      → 밝은 화면은 지금과 픽셀 단위로 같고, 다크에서만 값이 갈린다.
"""
import re, io, sys, colorsys, collections

SRC = sys.argv[1]
DST = sys.argv[2] if len(sys.argv) > 2 else SRC

s = io.open(SRC, encoding='utf-8').read()

# ── 색 유틸 ──────────────────────────────────────────────
def parse(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16)/255 for i in (0, 2, 4))
def fmt(r, g, b):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(v*255))) for v in (r, g, b))
def hls(h):  r,g,b = parse(h); return colorsys.rgb_to_hls(r,g,b)   # (h, l, s)
def unhls(hh, l, ss): return fmt(*colorsys.hls_to_rgb(hh, max(0,min(1,l)), max(0,min(1,ss))))
def clamp(v, lo, hi): return max(lo, min(hi, v))

def dark_bg(hex_):
    hh, l, ss = hls(hex_)
    if ss <= 0.45 and l >= 0.985:                   # 순백 = 카드 — 페이지보다 한 단 밝게 띄운다
        return unhls(hh, 0.175, min(ss, 0.06))
    if ss <= 0.45 and l >= 0.90:                    # 아주 옅은 회색/틴트 = 페이지·표 바탕
        return unhls(hh, 0.125, min(ss, 0.10))
    if ss <= 0.14:                                  # 회색 계열 — 밝기를 뒤집되 새까매지지 않게
        return unhls(hh, clamp(0.55 - 0.42*l, 0.20, 0.36), 0.03)
    if l >= 0.86:                                   # 파스텔 틴트 (#EEF2FF 등) → 색 밴 어두운 면
        return unhls(hh, 0.18, min(ss, 0.22))
    if l >= 0.60:
        return unhls(hh, 0.25, min(ss, 0.32))
    return unhls(hh, clamp(l*0.78, 0.20, 0.52), ss*0.88)   # 진한 색(버튼 등)은 살짝만 죽인다
def dark_text(hex_):
    hh, l, ss = hls(hex_)
    if l >= 0.93 and ss <= 0.10: return hex_        # 유채색 버튼 위의 흰 글자 — 그대로 둔다
    if ss <= 0.12:                                  # 검정~회색 글자 → 밝은 회색
        return unhls(hh, clamp(1.02 - l*0.78, 0.55, 0.93), 0.02)
    # 유채색 글자 — 어두울수록 더 밝게 올린다(짙은 남색 제목이 다크에서 묻히지 않도록)
    return unhls(hh, clamp(0.72 + (0.5 - l)*0.45, 0.66, 0.90), clamp(ss, 0.30, 0.62))
def dark_border(hex_):
    hh, l, ss = hls(hex_)
    if ss <= 0.14: return unhls(hh, clamp(0.44 - 0.20*l, 0.20, 0.36), 0.03)
    return unhls(hh, clamp(l*0.50 + 0.14, 0.30, 0.52), min(ss, 0.55))
def dark_shadow(hex_):
    hh, l, ss = hls(hex_); return unhls(hh, clamp(l*0.35, 0.0, 0.25), ss)

MAKE = {'bg': dark_bg, 'fg': dark_text, 'bd': dark_border, 'sh': dark_shadow}

# ── 속성 → 버킷 ─────────────────────────────────────────
def bucket(prop):
    p = prop.lower()
    if 'shadow' in p: return 'sh'
    if 'border' in p or p in ('outline', 'outline-color', 'stroke'): return 'bd'
    if p.startswith('background') or p in ('bg','cardbg','badgebg','hbg','fill','accentsoft'): return 'bg'
    if p == 'color' or p.endswith('color') and 'border' not in p and 'background' not in p: return 'fg'
    if p in ('hcolor','text','ink','accent'): return 'fg'
    return 'bg'

def var_bucket(name):
    n = name.lower()
    if 'shadow' in n: return 'sh'
    if 'border' in n or 'line' in n: return 'bd'
    if any(k in n for k in ('bg','card','surface','pale','panel','fill')): return 'bg'
    if any(k in n for k in ('text','ink','muted')): return 'fg'
    return 'bg'

HEX = re.compile(r'#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b')
PROP = re.compile(r'([-a-zA-Z]+)\s*:\s*[^;{}]*$')

tokens = {}          # (bucket, hex) -> 토큰명
varlight = {}        # 기존 CSS 변수 -> 원래 색 (다크 짝을 따로 정의)
varbucket = {}
def token(b, hx):
    hx = hx.lower()
    if len(hx) == 4: hx = '#' + ''.join(c*2 for c in hx[1:])
    k = (b, hx)
    if k not in tokens: tokens[k] = '--k%s-%s' % (b, hx[1:])
    return tokens[k]

def convert(css, in_style_block):
    """CSS 선언 덩어리 안의 hex를 토큰으로 바꾼다."""
    out = []; last = 0
    for m in HEX.finditer(css):
        head = css[last:m.start()]
        # 이 hex 앞의 가장 가까운 'prop:' 을 찾는다 (선언 경계는 ; { })
        seg = css[:m.start()]
        cut = max(seg.rfind(';'), seg.rfind('{'), seg.rfind('}'))
        pm = PROP.search(seg[cut+1:])
        prop = pm.group(1) if pm else 'background'
        if prop.startswith('--') and in_style_block:
            varlight[prop] = m.group(0).lower()
            varbucket[prop] = var_bucket(prop)
            out.append(head + m.group(0))            # 변수 정의는 그대로 두고 다크에서 덮는다
        else:
            out.append(head + 'var(%s)' % token(bucket(prop), m.group(0)))
        last = m.end()
    out.append(css[last:])
    return ''.join(out)

# ── 치환 대상: <style> 블록 + style="" 속성 ──────────────
pieces = []; pos = 0; n_style = n_attr = 0
spans = []
for m in re.finditer(r'(<style[^>]*>)(.*?)(</style>)', s, re.S):
    spans.append((m.start(2), m.end(2), True))
for m in re.finditer(r'style\s*=\s*"([^"]*)"', s):
    spans.append((m.start(1), m.end(1), False))
for m in re.finditer(r"style\s*=\s*'([^']*)'", s):
    spans.append((m.start(1), m.end(1), False))
spans.sort()
# style 블록 안의 style="" 은 없다고 보고 겹침만 제거
clean = []
for sp in spans:
    if clean and sp[0] < clean[-1][1]: continue
    clean.append(sp)
for b, e, isblk in clean:
    pieces.append(s[pos:b])
    body = s[b:e]
    before = len(HEX.findall(body))
    pieces.append(convert(body, isblk))
    if isblk: n_style += before
    else: n_attr += before
    pos = e
pieces.append(s[pos:])
s = ''.join(pieces)


# ── 2차 패스: JS 안의 색 리터럴 (style.prop=, cssText, 색 변수) ─────────
#   SVG의 fill="…"·stroke="…" 속성과 <meta theme-color>는 var()를 못 읽으므로 건드리지 않는다.
JSPROP = re.compile(r"""(\.style\.([A-Za-z]+)\s*=\s*['"])(#[0-9A-Fa-f]{3,6})(['"])""")
def _p1(m):
    return m.group(1) + 'var(%s)' % token(bucket(m.group(2)), m.group(3)) + m.group(4)
s, n1 = JSPROP.subn(_p1, s)

CSSTEXT = re.compile(r"""(cssText\s*=\s*)(['"`])(.*?)\2""", re.S)
def _p2(m):
    return m.group(1) + m.group(2) + convert(m.group(3), False) + m.group(2)
s, n2 = CSSTEXT.subn(_p2, s)

NAMES = ('color','bg','background','backgroundColor','border','borderColor','bd',
         'cardBg','cardBorder','badgeBg','hColor','hBg','accent','accentSoft','line','ink','text')
JSVAR = re.compile(r"""\b(%s)(\s*[:=]\s*)(['"])(#[0-9A-Fa-f]{3,6})\3""" % '|'.join(NAMES))
def _p3(m):
    return m.group(1) + m.group(2) + m.group(3) + 'var(%s)' % token(bucket(m.group(1)), m.group(4)) + m.group(3)
s, n3 = JSVAR.subn(_p3, s)
print('2차 패스: style.prop %d · cssText %d · 색 변수 %d' % (n1, n2, n3))

# ── 다크 팔레트 블록 만들기 ─────────────────────────────
lines_light, lines_dark = [], []
for (b, hx), name in sorted(tokens.items(), key=lambda kv: kv[1]):
    lines_light.append('  %s:%s;' % (name, hx))
    lines_dark.append('  %s:%s;' % (name, MAKE[b](hx)))
for v, hx in sorted(varlight.items()):
    lines_dark.append('  %s:%s;' % (v, MAKE[varbucket[v]](hx)))

block = """
/* ══ OS 다크모드 ═══════════════════════════════════════════════
   코드에 박혀 있던 색을 쓰이는 자리(배경 kbg · 글자 kfg · 테두리 kbd · 그림자 ksh)별로
   토큰화한 것이다. :root 값은 원래 색 그대로라 밝은 화면은 조금도 달라지지 않고,
   아래 @media 안에서만 어두운 짝으로 갈린다. 맥·아이폰·안드로이드의 '자동(일몰)'
   설정을 그대로 따라간다 — 앱이 시각을 따로 보지 않는다.
   ⚠️ 색을 새로 넣을 때는 hex를 직접 쓰지 말고 여기 토큰을 쓰거나, 이 파일을 다시
      darkify 스크립트에 통과시킬 것. 직접 쓴 hex는 다크에서 밝은 채로 남는다. */
:root{
  color-scheme: light;
%s
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme: dark;
%s
  }
  html,body{background:var(--kbg-f5f6fa,#12161c)}
  img,video{filter:brightness(.92)}
}
""" % ('\n'.join(lines_light), '\n'.join('  '+l for l in lines_dark))

# 첫 <style> 블록 맨 앞에 넣는다 (뒤 규칙이 덮어쓰지 않도록 변수는 최상단)
s = re.sub(r'(<style[^>]*>)', lambda m: m.group(1) + block, s, count=1)

io.open(DST, 'w', encoding='utf-8').write(s)
print('치환: style블록 %d개 · style속성 %d개' % (n_style, n_attr))
print('토큰 %d개 (배경 %d · 글자 %d · 테두리 %d · 그림자 %d)' % (
    len(tokens),
    sum(1 for b,_ in tokens if b=='bg'), sum(1 for b,_ in tokens if b=='fg'),
    sum(1 for b,_ in tokens if b=='bd'), sum(1 for b,_ in tokens if b=='sh')))
print('기존 CSS 변수 다크 오버라이드 %d개' % len(varlight))
