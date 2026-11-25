@echo off
if exist "%~dp0host.exe" (
    "%~dp0host.exe"
) else (
    powershell.exe -ExecutionPolicy Bypass -NoLogo -NoProfile -NonInteractive -File "%~dp0host.ps1"
)
