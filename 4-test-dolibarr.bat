@echo off
rem Double-cliquer : verifie l acces Dolibarr et affiche les societes (entites).
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- dolibarr
echo.
pause
