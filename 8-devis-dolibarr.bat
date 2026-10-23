@echo off
rem Double-cliquer : relie maintenant les devis a faire aux propositions Dolibarr et met a jour les devis acceptes. Sinon fait tous les quarts d heure.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- devis
echo.
pause
