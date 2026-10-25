@echo off
chcp 65001 >nul
cd /d "%~dp0"
set NODE=
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
if "%NODE%"=="" if exist "C:/Program Files/nodejs/node.exe" set NODE=C:/Program Files\nodejs\node.exe
if "%NODE%"=="" (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)
"%NODE%" "%~dp0src\status.js"
pause
