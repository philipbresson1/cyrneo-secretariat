@echo off
rem Double-cliquer : ouvre le fichier des mots de passe et des cles.
cd /d "%~dp0"
if not exist .env.local copy .env.example .env.local
notepad .env.local
