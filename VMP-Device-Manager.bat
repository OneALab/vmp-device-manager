@echo off
:: Self-elevate to Administrator (required for XCenter service control)
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

title VMP Device Manager
echo.
echo   Starting VMP Device Manager...
echo.

:: Try compiled exe first, then fall back to node
if exist "%~dp0dist\VMP-Device-Manager.exe" (
    "%~dp0dist\VMP-Device-Manager.exe"
) else if exist "%~dp0VMP-Device-Manager.exe" (
    "%~dp0VMP-Device-Manager.exe"
) else (
    where node >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        node "%~dp0server.js"
    ) else (
        echo   ERROR: Could not find VMP-Device-Manager.exe or Node.js.
        echo.
        echo   Either:
        echo     1. Build the exe:  npm install ^&^& npm run build
        echo     2. Install Node.js from https://nodejs.org
        echo.
        pause
    )
)
