@echo off
setlocal

REM 컴퓨터를 켤 때 타종이 저절로 뜨도록, 시작프로그램 폴더에 바로 가기를 만든다.
REM 창은 최소화(WindowStyle 7)로 떠서 검은 콘솔이 화면을 가리지 않는다.
REM
REM 주의: 아래 powershell 명령 안에는 한글을 넣지 않는다. 이 배치는 CP949 인데
REM       powershell 로 넘어가는 문자열은 콘솔 코드페이지를 타서 깨질 수 있다.
REM       사람에게 보여줄 한글은 전부 배치의 echo 로 낸다.

set "DIR=%~dp0"
set "TARGET=%DIR%start-bell.bat"

if exist "%TARGET%" goto MAKE
echo.
echo   [오류] start-bell.bat 을 같은 폴더에서 찾을 수 없습니다.
echo          압축을 푼 폴더 안에서 실행해 주세요.
echo.
pause
exit /b 1

:MAKE
powershell -NoProfile -ExecutionPolicy Bypass -Command "$sp=[Environment]::GetFolderPath('Startup'); $sc=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $sp 'saebom-bell.lnk')); $sc.TargetPath='%TARGET%'; $sc.WorkingDirectory='%DIR%'; $sc.WindowStyle=7; $sc.Description='saebom studyhall bell'; $sc.Save()"
if errorlevel 1 goto FAIL

echo.
echo   등록했습니다. 이제 컴퓨터를 켜면 타종 창이 저절로 뜹니다.
echo   해제하려면 uninstall-autostart.bat 을 실행하세요.
echo.
echo   ※ 등록된 곳을 직접 보려면 Win+R 에서 shell:startup
echo.
pause
exit /b 0

:FAIL
echo.
echo   [오류] 바로 가기를 만들지 못했습니다.
echo          수동 등록 방법: Win+R - shell:startup 을 실행한 뒤,
echo          열린 폴더에 start-bell.bat 의 바로 가기를 넣으세요.
echo.
pause
exit /b 1
