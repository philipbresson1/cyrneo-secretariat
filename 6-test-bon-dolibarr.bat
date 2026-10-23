@echo off
rem Double-cliquer : cree le bon d intervention Dolibarr (brouillon) de la fiche INT-2026-0006
rem (Max Immobilier) et le signale dans la bulle Rainbow de test.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- essai-bon INT-2026-0006
echo.
pause
