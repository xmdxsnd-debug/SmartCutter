@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if errorlevel 1 (
  echo.
  echo SmartCutter stopped. Check .smartcutter-local logs for details.
  pause
  exit /b 1
)
endlocal
