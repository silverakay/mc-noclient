@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

REM ============================================================
REM  Run self-tests
REM    1) System Node  (dev environment, native CFB8)
REM    2) Packaged Electron if present
REM       (BoringSSL environment - verifies the CFB8 fallback)
REM  NOTE: keep this file ASCII-only. Chinese path segment is
REM        avoided via wildcard matching on the exe name.
REM ============================================================

set NODE=
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
if "%NODE%"=="" if exist "C:/Program Files/nodejs/node.exe" set NODE=C:/Program Files/nodejs/node.exe

set FAILED=0

echo.
echo ==================================================
echo  [1/2] Dev self-test (system Node)
echo ==================================================
if "%NODE%"=="" (
  echo [SKIP] Node.js not found, skipping system self-test.
) else (
  "%NODE%" "%~dp0src\run_all_tests.js"
  if errorlevel 1 set FAILED=1
)

REM Locate the packaged Electron exe.
REM 1) win-unpacked (any *.exe whose name is not a helper tool)
REM 2) portable single-file build matching dist\*.exe
set APPEXE=
for %%F in ("%~dp0dist\win-unpacked\*.exe") do (
  echo %%~nxF | findstr /I "elevate.exe" >nul
  if errorlevel 1 if not defined APPEXE set APPEXE=%%F
)
if not defined APPEXE for %%F in ("%~dp0dist\*.exe") do (
  if not defined APPEXE set APPEXE=%%F
)

echo.
echo ==================================================
echo  [2/2] Packaged self-test (Electron/BoringSSL)
echo ==================================================
if not defined APPEXE (
  echo [SKIP] No packaged build found. Run packaging first.
) else (
  echo  Using: !APPEXE!
  set ELECTRON_RUN_AS_NODE=1
  "!APPEXE!" "%~dp0src\run_all_tests.js"
  set ELECTRON_RUN_AS_NODE=
  if errorlevel 1 set FAILED=1
)

echo.
if "%FAILED%"=="0" (
  echo [OK] All self-tests passed.
) else (
  echo [FAIL] Some tests failed. See output above.
)

pause
exit /b %FAILED%
