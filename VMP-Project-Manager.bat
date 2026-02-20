@echo off
title VMP Project Manager
echo.
echo   Starting VMP Project Manager...
echo.

:: Try to find node.exe
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    node "%~dp0server.js"
) else (
    echo   ERROR: Node.js is not installed.
    echo.
    echo   Either:
    echo     1. Install Node.js from https://nodejs.org
    echo     2. Or use the standalone VMP-Project-Manager.exe instead
    echo.
    pause
)
