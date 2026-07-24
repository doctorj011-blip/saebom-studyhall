#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# [일회성 복원] 사진은 Storage에 있는데 Firestore 문서가 없는 플래너 2건 복원
#
# 전수 조사(2026-07-25)에서 발견: 학생앱 업로드는 성공했지만 직후 메타 저장
# (savePlannerMeta)이 실패해 관리앱·집계에서 미제출로 보이던 건.
#   - 18번 김리원 2026-07-24 학습분 (업로드 7/25 00:00 KST — 정시)
#   - 24번 우지효 2026-07-21 학습분 (업로드 7/22 00:07 KST — 정시)
# submittedAt은 Storage 파일의 실제 업로드 시각(timeCreated)을 쓴다.
# 재실행해도 이미 문서가 있으면 생성이 409로 거부되어 안전하다.
#
# 실행: python3 scripts/restore-planner-docs.py
# ─────────────────────────────────────────────────────────────────────────────
import json, ssl, urllib.request, urllib.parse, urllib.error, os

ctx = ssl.create_default_context()
ca = os.environ.get('SSL_CERT_FILE')
if ca: ctx = ssl.create_default_context(cafile=ca)
handlers = [urllib.request.HTTPSHandler(context=ctx)]
proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
if proxy: handlers.insert(0, urllib.request.ProxyHandler({'https': proxy, 'http': proxy}))
op = urllib.request.build_opener(*handlers)

FS = 'https://firestore.googleapis.com/v1/projects/saebom-studyhall/databases/(default)/documents'
ST = 'https://firebasestorage.googleapis.com/v0/b/saebom-studyhall.firebasestorage.app/o'

# 두 건 모두 KST 익일 02:00(정시 마감) 전 업로드라 ontime
TARGETS = [('18', '2026-07-24', '김리원'), ('24', '2026-07-21', '우지효')]

for seat, date, name in TARGETS:
    path = urllib.parse.quote(f'planners/{seat}/{date}.jpg', safe='')
    meta = json.loads(op.open(f'{ST}/{path}').read())
    token = meta['downloadTokens'].split(',')[0]
    url = f'{ST}/{path}?alt=media&token={token}'
    ts = meta['timeCreated']
    fields = {
        'seat': {'stringValue': seat}, 'date': {'stringValue': date},
        'url': {'stringValue': url}, 'name': {'stringValue': name},
        'submittedAt': {'stringValue': ts}, 'status': {'stringValue': 'ontime'},
        'updatedAt': {'stringValue': ts},
    }
    req = urllib.request.Request(f'{FS}/planners?documentId={seat}_{date}',
        data=json.dumps({'fields': fields}).encode(), method='POST',
        headers={'Content-Type': 'application/json'})
    try:
        op.open(req)
        print(f'복원: {seat}_{date} {name} (제출 {ts}, ontime)')
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print(f'건너뜀: {seat}_{date} 문서가 이미 있음')
        else:
            raise

# 검증
for seat, date, name in TARGETS:
    d = json.loads(op.open(f'{FS}/planners/{seat}_{date}').read())
    size = len(op.open(d['fields']['url']['stringValue']).read())
    print(f'검증 OK: {seat}_{date} {name} — 문서 존재, 사진 {size:,} bytes 로드됨')
print('끝')
