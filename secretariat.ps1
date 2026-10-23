# Lance le démon de secrétariat, le met à jour et le relance s'il s'arrête (plantage, coupure réseau, redémarrage de nuit).
# Journal : secretariat.log à la racine du dépôt.
Set-Location $PSScriptRoot
while ($true) {
  $debut = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path "secretariat.log" -Value "[$debut] démarrage du secrétariat" -Encoding utf8
  # Récupère la dernière version avant chaque démarrage (le démon redémarre chaque nuit à 3 h).
  cmd /c "git pull 2>&1" | Add-Content -Path "secretariat.log" -Encoding utf8
  cmd /c "npm install --no-audit --no-fund 2>&1" | Add-Content -Path "secretariat.log" -Encoding utf8
  cmd /c "npm start 2>&1" | Add-Content -Path "secretariat.log" -Encoding utf8
  $fin = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path "secretariat.log" -Value "[$fin] arrêt (code $LASTEXITCODE), redémarrage dans 30 s" -Encoding utf8
  Start-Sleep -Seconds 30
}
