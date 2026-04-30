# =============================================================================
# Setup Windows pour accéder à la BoxIA via https://aibox.local
# =============================================================================
# Usage : ouvrir PowerShell EN ADMIN, puis :
#   .\setup-windows-aibox-local.ps1
#
# Ce script :
#   1. Ajoute les entrées DNS dans C:\Windows\System32\drivers\etc\hosts
#   2. Optionnellement, télécharge et installe le certificat racine Caddy
#      pour supprimer les warnings de sécurité du navigateur.
# =============================================================================

param(
  [string]$BoxIp = "192.168.15.210",
  [switch]$InstallRootCert = $false
)

# --- Vérification admin ----------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "❌ Ce script doit être lancé en Administrateur" -ForegroundColor Red
  Write-Host "   Clic droit sur PowerShell → 'Exécuter en tant qu'administrateur'"
  exit 1
}

$hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
$marker    = "# AI Box edge proxy"
$entries   = @(
  "$BoxIp aibox.local",
  "$BoxIp auth.aibox.local",
  "$BoxIp agents.aibox.local",
  "$BoxIp flows.aibox.local",
  "$BoxIp chat.aibox.local",
  "$BoxIp admin.aibox.local",
  "$BoxIp status.aibox.local"
)

# --- 1. Hosts file ---------------------------------------------------------
Write-Host "→ Mise à jour de $hostsFile" -ForegroundColor Cyan

$content = Get-Content $hostsFile -Raw -ErrorAction SilentlyContinue
if ($content -and $content.Contains($marker)) {
  Write-Host "  Bloc déjà présent, on remplace les IPs si elles ont changé."
  # Retire l'ancien bloc puis ajoute le nouveau
  $lines = Get-Content $hostsFile
  $newLines = @()
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match [regex]::Escape($marker)) { $skip = $true; continue }
    if ($skip -and ($line -match "aibox\.local|^\s*$")) { continue }
    if ($skip) { $skip = $false }
    $newLines += $line
  }
  $content = ($newLines -join "`r`n").TrimEnd()
}

$block = "`r`n`r`n$marker`r`n" + ($entries -join "`r`n") + "`r`n"
Set-Content -Path $hostsFile -Value ($content + $block) -Encoding ASCII
Write-Host "  ✓ Entrées ajoutées :"
foreach ($e in $entries) { Write-Host "    $e" }

# Flush DNS cache
ipconfig /flushdns | Out-Null
Write-Host "  ✓ Cache DNS Windows flushé"

# --- 2. Cert racine Caddy (optionnel) --------------------------------------
if ($InstallRootCert) {
  Write-Host "`n→ Téléchargement du certificat racine Caddy depuis $BoxIp..." -ForegroundColor Cyan
  $tmpCert = "$env:TEMP\caddy_root.crt"
  try {
    # SCP via OpenSSH client de Windows 10+
    scp -o StrictHostKeyChecking=no "clikinfo@${BoxIp}:/tmp/caddy_root.crt" $tmpCert
    if (Test-Path $tmpCert) {
      Write-Host "  ✓ Certificat téléchargé : $tmpCert"
      Write-Host "→ Installation dans le store 'Autorités de certification racines de confiance'..." -ForegroundColor Cyan
      Import-Certificate -FilePath $tmpCert -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
      Remove-Item $tmpCert
      Write-Host "  ✓ Certificat installé. Redémarre les navigateurs ouverts."
    } else {
      Write-Host "  ⚠ Téléchargement échoué. Récupère manuellement le cert via :" -ForegroundColor Yellow
      Write-Host "    ssh clikinfo@$BoxIp 'docker exec aibox-edge-caddy cat /data/caddy/pki/authorities/local/root.crt' > caddy_root.crt"
    }
  } catch {
    Write-Host "  ⚠ Erreur SCP : $_" -ForegroundColor Yellow
  }
}

# --- 3. Test ---------------------------------------------------------------
Write-Host "`n→ Test de résolution DNS..." -ForegroundColor Cyan
$resolved = (Resolve-DnsName -Name aibox.local -ErrorAction SilentlyContinue).IPAddress
if ($resolved -eq $BoxIp) {
  Write-Host "  ✓ aibox.local → $resolved"
} else {
  Write-Host "  ⚠ Résolution inattendue : $resolved" -ForegroundColor Yellow
}

Write-Host "`n✓ Setup terminé." -ForegroundColor Green
Write-Host "  Ouvre maintenant : https://aibox.local  ou  http://aibox.local"
if (-not $InstallRootCert) {
  Write-Host "`n  Note : pour supprimer le warning de cert HTTPS, relance ce script avec :"
  Write-Host "         .\setup-windows-aibox-local.ps1 -InstallRootCert"
}
