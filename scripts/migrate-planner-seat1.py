#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# [일회성 데이터 이전] 1번 박지윤 플래너 좌석키 교정: '1번' → '1'
#
# 배경: 학생앱 로그인이 로컬 하드코딩 명단을 먼저 검색하던 시절, 명단에 전화번호가
# 있던 유일한 학생(1번 박지윤)만 옛 데이터(seat='1번')로 로그인됐다. 그래서
# 2026-07-20 ~ 07-24 플래너가 planners/1번_{날짜} 문서와 Storage planners/1번/ 경로에
# 저장돼, 좌석 '1'로 매칭하는 관리앱·학부모앱·성실상점 집계에서 안 보였다.
#
# 이 스크립트는 그 5건을 표준 키('1')로 옮긴다:
#   - Storage: planners/1번/{날짜}.jpg → planners/1/{날짜}.jpg (복사 후 원본 삭제)
#   - Firestore: planners/1번_{날짜} → planners/1_{날짜} (제출시각·정시/지각 상태 그대로)
#
# 실행: python3 scripts/migrate-planner-seat1.py
# (Firestore 규칙상 planners는 개방돼 있어 별도 인증 없이 실행된다.
#  코드 수정 배포와 무관하게 언제 실행해도 안전하고, 재실행해도 이미 옮긴 날짜는
#  원본이 없어 건너뛴다.)
# ─────────────────────────────────────────────────────────────────────────────
import json, ssl, urllib.request, urllib.parse, os, sys

PROJECT = 'saebom-studyhall'
BUCKET = 'saebom-studyhall.firebasestorage.app'
FS = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents'
ST = f'https://firebasestorage.googleapis.com/v0/b/{BUCKET}/o'

ctx = ssl.create_default_context()
ca = os.environ.get('SSL_CERT_FILE')
if ca: ctx = ssl.create_default_context(cafile=ca)
handlers = [urllib.request.HTTPSHandler(context=ctx)]
proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
if proxy: handlers.insert(0, urllib.request.ProxyHandler({'https': proxy, 'http': proxy}))
opener = urllib.request.build_opener(*handlers)

def req(url, method='GET', data=None, headers=None):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with opener.open(r) as resp:
        return resp.read()

DATES = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']
OLD_SEAT, NEW_SEAT = '1번', '1'

for d in DATES:
    old_id = urllib.parse.quote(f'{OLD_SEAT}_{d}')
    # 1) 기존 문서 읽기 (없으면 이미 이전됐거나 미제출 → 건너뜀)
    try:
        doc = json.loads(req(f'{FS}/planners/{old_id}'))
    except urllib.error.HTTPError as e:
        print(f'[{d}] 원본 문서 없음 — 건너뜀 ({e.code})')
        continue
    f = doc['fields']
    old_url = f['url']['stringValue']

    # 2) 사진을 새 경로로 복사
    img = req(old_url)
    up = json.loads(req(f'{ST}?name=planners/{NEW_SEAT}/{d}.jpg', method='POST', data=img,
                        headers={'Content-Type': 'image/jpeg'}))
    new_path = urllib.parse.quote(f'planners/{NEW_SEAT}/{d}.jpg', safe='')
    new_url = f'{ST}/{new_path}?alt=media&token={up["downloadTokens"]}'

    # 3) 표준 키로 새 문서 생성 — seat·url만 교정, submittedAt/status(정시·지각)는 원본 유지
    nf = dict(f)
    nf['seat'] = {'stringValue': NEW_SEAT}
    nf['url'] = {'stringValue': new_url}
    req(f'{FS}/planners?documentId={urllib.parse.quote(f"{NEW_SEAT}_{d}")}', method='POST',
        data=json.dumps({'fields': nf}).encode(), headers={'Content-Type': 'application/json'})

    # 4) 원본 문서·사진 삭제
    req(f'{FS}/planners/{old_id}', method='DELETE')
    try:
        req(f'{ST}/{urllib.parse.quote(f"planners/{OLD_SEAT}/{d}.jpg", safe="")}', method='DELETE')
    except Exception as e:
        print(f'[{d}] 원본 사진 삭제 실패(무시 가능): {e}')
    print(f'[{d}] 이전 완료 (status={f["status"]["stringValue"]}, 제출 {f["submittedAt"]["stringValue"]})')

print('끝 — 관리앱 플래너 탭에서 1번 박지윤 제출이 보이는지 확인하세요.')
