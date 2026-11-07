@echo off
rem Desktop-shortcut entry: same launcher, but keep the window open so the
rem output of a menu choice (status, an error message) can be read.
setlocal
call "%~dp0dsh-switch.cmd" %*
echo.
pause
