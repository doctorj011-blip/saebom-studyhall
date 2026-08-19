@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  새봄 면학관 타종 - 시작 스크립트 (윈도우)
REM ============================================================
REM  하는 일
REM   1) 인터넷이 되면 최신 타종 페이지를 내려받는다 (실패하면 있던 파일로 그냥 진행)
REM   2) 크롬을 '타종 전용' 창으로 띄운다
REM
REM  옵션 두 개가 이 스크립트의 핵심이다. 둘 다 빼면 안 된다.
REM
REM   --autoplay-policy=no-user-gesture-required
REM       사람이 화면을 클릭하지 않아도 소리가 나게 한다. 이게 없으면 컴퓨터를 켤 때마다
REM       빨간 '소리가 잠겨 있습니다' 줄을 사람이 눌러 줘야 하고, 안 누르면 종이 안 울린다.
REM       (2026-08-17 09:03 사고가 이 잠금 때문에 났다)
REM
REM   --user-data-dir=...
REM       업무용 크롬과 분리된 전용 프로필. 이걸 안 주면, 이미 크롬이 떠 있을 때
REM       위 정책 옵션이 통째로 무시된다 - 새 프로세스가 뜨는 게 아니라 기존 크롬에
REM       탭만 하나 더 열리기 때문이다. 분리해 두면 조교가 업무용 크롬을 다 닫아도
REM       타종 창은 살아 있고, 정책 옵션이 업무용 크롬에 영향을 주지도 않는다.
REM ============================================================

set "DIR=%~dp0"
set "PAGE=%DIR%saebom_bell.html"
set "SRC=https://raw.githubusercontent.com/doctorj011-blip/saebom-studyhall/main/saebom_bell.html"

echo.
echo  [1/2] 최신 타종 페이지를 확인합니다...
curl -fsSL --connect-timeout 5 --max-time 20 -o "%DIR%_bell.tmp" "%SRC%" 2>nul
if exist "%DIR%_bell.tmp" (
  REM 내려받은 게 진짜 타종 페이지인지 확인한다. 공유기 로그인 페이지 같은 게
  REM 대신 내려오는 일이 있어서, 멀쩡한 파일을 쓰레기로 덮어쓰면 안 된다.
  findstr /C:"saebomBellSpeaker" "%DIR%_bell.tmp" >nul 2>&1
  if not errorlevel 1 (
    move /Y "%DIR%_bell.tmp" "%PAGE%" >nul
    echo        최신본으로 갱신했습니다.
  ) else (
    del /Q "%DIR%_bell.tmp" >nul 2>&1
    echo        받은 파일이 타종 페이지가 아니라 무시합니다. 있던 파일로 진행합니다.
  )
) else (
  echo        인터넷이 없습니다. 있던 파일로 진행합니다.
)

if not exist "%PAGE%" (
  echo.
  echo  [오류] 타종 페이지 파일이 없습니다.
  echo         %PAGE%
  echo         인터넷이 되는 곳에서 최소 한 번은 받아야 합니다.
  echo.
  pause
  exit /b 1
)

REM 윈도우 경로를 file:// 주소로 (역슬래시 -> 슬래시)
set "URLPATH=%PAGE:\=/%"

REM 크롬을 찾는다. 없으면 엣지로 대신한다(같은 크로미움이라 옵션이 통한다).
set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo.
  echo  [오류] 크롬도 엣지도 찾지 못했습니다. 크롬을 설치해 주세요.
  echo.
  pause
  exit /b 1
)

echo  [2/2] 타종 창을 엽니다...
start "" "%BROWSER%" --app="file:///%URLPATH%" --autoplay-policy=no-user-gesture-required --user-data-dir="%DIR%_profile" --window-size=920,780
exit /b 0
