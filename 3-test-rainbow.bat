@echo off
rem Double-cliquer : verifie la connexion Rainbow et liste les bulles visibles par le bot.
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- bulles
echo.
pause
