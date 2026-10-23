@echo off
rem Double-cliquer : montre les rappels de rendez-vous de demain, sans rien envoyer.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- rappels apercu
echo.
pause
