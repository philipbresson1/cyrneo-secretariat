@echo off
rem Double-cliquer : BI du planning de demain (crees ou dates pour le panier des agents). Sinon fait seul a 16h30 et 7h.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- bons-veille
echo.
pause
