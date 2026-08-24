#!/usr/bin/env python3
"""타종 윈도우 설치 압축파일을 만든다.

src/ 의 원본(UTF-8)을 윈도우가 그대로 읽는 인코딩으로 바꿔 담는다.
  · .bat  -> CP949 + CRLF
      한국어 윈도우 콘솔 기본 코드페이지가 949 라서, 그대로 두면 한글이 깨진다.
      chcp 65001 을 쓰는 방법도 있지만 UTF-8 배치는 파서가 첫 줄부터 어긋나는
      사고가 알려져 있어 굳이 건드리지 않는 쪽이 안전하다.
  · .txt  -> UTF-8 BOM + CRLF
      메모장이 BOM 없는 UTF-8 을 옛 윈도우에서 CP949 로 잘못 읽는다.
  · .html -> 그대로 (브라우저가 <meta charset> 을 본다)

압축 안 파일 이름은 전부 ASCII 다. 한글 이름은 윈도우 탐색기 버전에 따라
깨져 보일 수 있고, 배치가 서로를 이름으로 부르기 때문에 위험을 없앴다.
"""
import shutil, zipfile
from pathlib import Path

HERE = Path(__file__).parent
SRC  = HERE / 'src'
OUT  = HERE.parent / 'saebom-bell-setup.zip'
PAGE = HERE.parent / 'saebom_bell.html'

def conv(p: Path) -> bytes:
    raw = p.read_text(encoding='utf-8')
    body = raw.replace('\r\n', '\n').replace('\n', '\r\n')
    if p.suffix == '.bat':
        return body.encode('cp949')          # 못 바꾸는 문자가 있으면 여기서 터진다(의도한 것)
    if p.suffix == '.txt':
        return b'\xef\xbb\xbf' + body.encode('utf-8')
    return body.encode('utf-8')

files = sorted(SRC.iterdir(), key=lambda p: p.name)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.writestr(f.name, conv(f))
        print(f'  {f.name:26s} {f.suffix[1:] or "?":4s} {len(conv(f)):>7,d} bytes')
    z.write(PAGE, 'saebom_bell.html')
    print(f'  {"saebom_bell.html":26s} html {PAGE.stat().st_size:>7,d} bytes')

print(f'\n=> {OUT.name}  ({OUT.stat().st_size:,d} bytes)')
