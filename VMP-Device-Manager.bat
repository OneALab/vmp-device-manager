@echo off
:: Self-elevate to Administrator
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

:: Run the exe from the same directory as this bat file
if exist "%~dp0dist\VMP-Device-Manager.exe" (
    "%~dp0dist\VMP-Device-Manager.exe"
) else if exist "%~dp0VMP-Device-Manager.exe" (
    "%~dp0VMP-Device-Manager.exe"
) else (
    echo   ERROR: VMP-Device-Manager.exe not found!
    echo   Make sure it is in the same folder or in the dist\ subfolder.
    pause
)
