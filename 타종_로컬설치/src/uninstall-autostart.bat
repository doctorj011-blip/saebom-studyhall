@echo off
setlocal

REM 시작프로그램 등록만 해제한다. 타종 파일과 설정은 그대로 남는다.
REM powershell 명령 안에는 한글을 넣지 않는다(install-autostart.bat 주석 참고).

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'saebom-bell.lnk'; if (Test-Path $p) { Remove-Item $p -Force; exit 0 } else { exit 3 }"
if errorlevel 3 goto NOTREG

echo.
echo   해제했습니다. 이제 컴퓨터를 켜도 타종이 저절로 뜨지 않습니다.
goto DONE

:NOTREG
echo.
echo   등록되어 있지 않습니다. 바꾼 것이 없습니다.

:DONE
echo   ※ 타종 파일과 설정은 지우지 않았습니다. 지금 떠 있는 타종 창도 그대로입니다
echo.
pause
