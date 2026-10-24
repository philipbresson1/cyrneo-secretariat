@echo off
rem Double-cliquer : relit les factures emises et prepare les contrats d entretien a proposer (sinon fait seul chaque matin).
cd /d "%~dp0"
git pull
call npm install --no-audit --no-fund
call npm start -- contrats
echo.
pause
