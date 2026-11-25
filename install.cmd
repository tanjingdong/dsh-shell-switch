@echo off
rem Double-click entry: run the JavaScript wizard with whichever runtime exists.
rem All the work (checks, prompts, cutover, plugin install) lives in setup\wizard.mjs.
setlocal
set "HERE=%~dp0"
set "APP=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if defined DSH_APP set "APP=%DSH_APP%"
where node >nul 2>nul
if not errorlevel 1 (
  node "%HERE%setup\wizard.mjs"
  goto done
)
if not exist "%APP%" goto noruntime
set ELECTRON_RUN_AS_NODE=1
"%APP%" "%HERE%setup\wizard.mjs"
goto done
:noruntime
echo DeepSeek Harness was not found, and node is not on PATH.
echo Install the desktop app, or set DSH_APP to its DeepSeek Harness.exe path.
:done
echo.
pause