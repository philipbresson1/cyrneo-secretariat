@echo off
rem Double-cliquer : relit les posts des 90 derniers jours de la bulle SUD Travaux et en tire les devis a faire.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- reprise-rainbow "SUD Travaux" 90
echo.
pause
