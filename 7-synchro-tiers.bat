@echo off
rem Double-cliquer : recopie maintenant la liste complete des tiers Dolibarr (sinon fait chaque semaine).
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- tiers
echo.
pause
