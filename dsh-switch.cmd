@echo off
setlocal
set "BASE=%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%USERPROFILE%\.dsh\plugins\rea-bundle\vendor\node\node.exe"
"%NODE%" "%BASE%src\cli.mjs" %*
