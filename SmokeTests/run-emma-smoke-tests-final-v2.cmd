@echo off
setlocal
chcp 65001 >nul

title EMMA Final Smoke Tests
cd /d "C:\Users\pawel\Documents\GitHub\Emma-notify"

set "WINDOW_DAYS=%~1"
if "%WINDOW_DAYS%"=="" set "WINDOW_DAYS=5"

echo.
echo ==========================================
echo  EMMA - FINAL SMOKE TESTS
echo  RANDOM LAST %WINDOW_DAYS% DAYS
echo ==========================================
echo.
echo Usage:
echo   run-emma-smoke-tests-final-v2.cmd
echo   run-emma-smoke-tests-final-v2.cmd 5
echo   run-emma-smoke-tests-final-v2.cmd 30
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0emma-smoke-tests-final-v2.ps1" -WindowDays %WINDOW_DAYS%

set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo ==========================================
if "%EXIT_CODE%"=="0" (
  echo  KONIEC - PASS
) else (
  echo  KONIEC - FAIL / PARTIAL
)
echo  Exit code: %EXIT_CODE%
echo ==========================================
echo.

pause
exit /b %EXIT_CODE%
