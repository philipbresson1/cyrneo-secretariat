@echo off
rem Double-cliquer : se place dans le dossier du secrétariat, met à jour, puis lance la commande.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- une-fois
echo.
pause
