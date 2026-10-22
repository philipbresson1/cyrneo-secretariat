# Installe la tâche planifiée qui fait tourner le secrétariat en continu :
# démarrage à l'ouverture de session, sans limite de durée, relancé en cas d'échec.
# À lancer une fois, dans un PowerShell administrateur.
$repo = Split-Path $PSScriptRoot -Parent
$nom = 'CYRNEO secretariat'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$repo\secretariat.ps1`"" `
  -WorkingDirectory $repo
$declencheur = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$parametres = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $nom -Confirm:$false -ErrorAction SilentlyContinue
try {
  Register-ScheduledTask -TaskName $nom -Action $action -Trigger $declencheur -Settings $parametres -ErrorAction Stop | Out-Null
  Write-Host "Tâche '$nom' installée : démarre à l'ouverture de session et tourne en continu."
  Start-ScheduledTask -TaskName $nom
  Write-Host "Secrétariat lancé. Écran d'accueil : http://localhost:3939/ecran"
} catch {
  Write-Host "ÉCHEC de l'installation de '$nom' : $($_.Exception.Message)"
}

# Ouvre le port de l'écran d'accueil sur le réseau du bureau (profil privé uniquement).
New-NetFirewallRule -DisplayName 'CYRNEO secretariat ecran' -Direction Inbound -Protocol TCP -LocalPort 3939 -Profile Private -Action Allow -ErrorAction SilentlyContinue | Out-Null
