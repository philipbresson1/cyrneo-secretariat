@echo off
rem Double-cliquer : cree dans Dolibarr le BI d une fiche (client cree s il n existe pas, BI date).
rem Exemple : INT-2026-0176 (M. Lenzini, Petit Capo).
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
set /p REF=Reference de la fiche (ex. INT-2026-0176) : 
call npm start -- essai-bon %REF%
echo.
pause
