@echo off
setlocal
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup-host.ps1" %*
if errorlevel 1 (
    echo.
    echo Setup encountered an error.
)
pause
