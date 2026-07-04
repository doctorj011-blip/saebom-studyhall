# 새봄 면학관 학생 앱 (PWA)

스마트폰 홈 화면에 앱으로 설치할 수 있는 학생 전용 앱입니다

## 📁 파일 구조

```
/
├── saebom_student.html     ← 학생 앱 메인
├── manifest.json           ← PWA 설정
├── service-worker.js       ← 오프라인 캐시
└── icons/
    ├── icon-192.png        ← 앱 아이콘 (소)
    └── icon-512.png        ← 앱 아이콘 (대)
```

## 🚀 GitHub Pages 배포 방법

1. 이 파일들을 GitHub 저장소에 업로드
2. 저장소 Settings → Pages → Branch: `main` / `(root)` 선택 → Save
3. 배포 완료 후 주소 확인:  
   `https://[사용자명].github.io/[저장소명]/saebom_student.html`

## 📱 학생 설치 방법

### 안드로이드 (Chrome)
1. 위 주소를 Chrome으로 접속
2. 하단에 **"홈 화면에 앱으로 설치하기"** 배너 → **설치** 탭
3. 홈 화면에 앱 아이콘 생성 완료 ✅

### 아이폰 (Safari)
1. Safari로 접속
2. 하단 공유 버튼(□↑) → **"홈 화면에 추가"**
3. 홈 화면에 앱 아이콘 생성 완료 ✅

## 🔗 관련 파일
- 관리자 앱: `saebom_schedule_with_hours.html`
- 시작 배치파일: `새봄면학관_시작.bat`
