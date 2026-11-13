@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 24 LTS, then run this launcher again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto failed
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:4030 in your browser.
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo mini_LaTeX_Editor could not start. Review the error above.
pause
exit /b 1
