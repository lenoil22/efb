@echo off
chcp 65001 >nul
title EFB Bridge
cd /d "%~dp0"
rem Node suchen: erst im PATH, sonst am Standard-Installationsort (PATH ist im Explorer oft veraltet)
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not "%NODE%"=="node" if not exist "%NODE%" (
  echo Node.js nicht gefunden. Bitte von https://nodejs.org installieren ^(LTS^).
  pause
  exit /b 1
)
"%NODE%" bridge.mjs
pause
