@echo off
rem Double-cliquer : releve maintenant les devis Dolibarr (brouillons = devis a faire). Sinon fait tous les quarts d heure.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- devis
echo.
pause
