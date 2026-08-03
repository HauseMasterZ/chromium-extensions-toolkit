@echo off
set "TARGET_DIR=C:\Windows\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy"
set "ORIGINAL=%TARGET_DIR%\SearchHost.exe"
set "DISABLED=%TARGET_DIR%\SearchHost_disabled.exe"

taskkill /f /im SearchHost.exe >nul 2>&1
taskkill /f /im msedgewebview2.exe >nul 2>&1

if exist "%ORIGINAL%" (
    echo Disabling Windows Search...
    takeown /f "%ORIGINAL%" >nul 2>&1
    icacls "%ORIGINAL%" /grant:r %username%:F >nul 2>&1
    ren "%ORIGINAL%" SearchHost_disabled.exe
    echo Windows Search disabled.
) else if exist "%DISABLED%" (
    echo Enabling Windows Search...
    takeown /f "%DISABLED%" >nul 2>&1
    icacls "%DISABLED%" /grant:r %username%:F >nul 2>&1
    ren "%DISABLED%" SearchHost.exe
    echo Windows Search enabled.
) else (
    echo Error: SearchHost executable not found in either state!
)
pause