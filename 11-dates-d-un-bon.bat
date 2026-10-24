@echo off
rem Double-cliquer : affiche ou un BI porte sa date (ligne, debut prevu, champ complementaire).
cd /d "%~dp0"
set /p REF=Reference du BI (ex. I-SA-260430) : 
call npm start -- dates-bon %REF%
echo.
pause
