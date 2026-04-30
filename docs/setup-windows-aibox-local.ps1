# =============================================================================
# Setup Windows pour accéder à la BoxIA via aibox.local
# =============================================================================
# Usage : ouvrir PowerShell EN ADMIN, puis :
#   .\setup-windows-aibox-local.ps1                  # mode hosts (rapide)
#   .\setup-windows-aibox-local.ps1 -Mode Bonjour    # installe Bonjour Apple (mDNS, futur-proof)
#   .\setup-windows-aibox-local.ps1 -InstallRootCert # + import du cert HTTPS
#
# Mode "hosts" (par défaut) :
#   Ajoute des entrées dans C:\Windows\System32\drivers\etc\hosts.
#   Marche immédiatement, mais rigide (si l'IP de la box change, à
#   re-faire). Ne nécessite rien d'autre côté Windows.
#
# Mode "Bonjour" (recommandé long terme) :
#   Installe Bonjour Service d'Apple (10 Mo, gratuit, signé Apple).
#   Active le mDNS natif sur Windows → la box est résolue
#   automatiquement, comme avec un Synology / Mac / iPhone. Aucune
#   IP à connaître ou maintenir.
# =============================================================================

param(
  [string]$BoxIp = "192.168.15.210",
  [ValidateSet("hosts", "Bonjour")]
  [string]$Mode = "hosts",
  [switch]$InstallRootCert = $false
)

# --- Vérification admin ----------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "❌ Ce script doit être lancé en Administrateur" -ForegroundColor Red
  Write-Host "   Clic droit sur PowerShell → 'Exécuter en tant qu'administrateur'"
  exit 1
}

$aliases = @(
  "aibox.local",
  "auth.aibox.local",
  "agents.aibox.local",
  "flows.aibox.local",
  "chat.aibox.local",
  "admin.aibox.local",
  "status.aibox.local",
  "qdrant.aibox.local"
)

function Setup-Hosts {
  Write-Host "→ Mode 'hosts' : ajout dans C:\Windows\System32\drivers\etc\hosts" -ForegroundColor Cyan
  $hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
  $marker    = "# AI Box edge proxy"
  $lines     = Get-Content $hostsFile -ErrorAction SilentlyContinue

  # Retire l'ancien bloc s'il existe
  $newLines = @()
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match [regex]::Escape($marker)) { $skip = $true; continue }
    if ($skip -and ($line -match "aibox\.local|^\s*$")) { continue }
    if ($skip) { $skip = $false }
    $newLines += $line
  }
  $existing = ($newLines -join "`r`n").TrimEnd()

  # Construit le nouveau bloc
  $block = "`r`n`r`n$marker`r`n"
  foreach ($a in $aliases) { $block += "$BoxIp $a`r`n" }
  Set-Content -Path $hostsFile -Value ($existing + $block) -Encoding ASCII -Force

  Write-Host "  ✓ Entrées ajoutées :"
  foreach ($a in $aliases) { Write-Host "    $BoxIp $a" }

  ipconfig /flushdns | Out-Null
  Write-Host "  ✓ Cache DNS Windows flushé"
}

function Setup-Bonjour {
  Write-Host "→ Mode 'Bonjour' : installation de mDNS natif via Apple Bonjour" -ForegroundColor Cyan
  $existing = Get-Service -Name "Bonjour Service" -ErrorAction SilentlyContinue
  if ($existing -and $existing.Status -eq "Running") {
    Write-Host "  ✓ Bonjour Service est déjà installé et actif. Aucune action."
    return
  }

  $url = "https://download.info.apple.com/Mac_OS_X/061-7495.20120814.mEsFv/BonjourPSSetup.exe"
  $tmp = "$env:TEMP\BonjourPSSetup.exe"
  Write-Host "  → Téléchargement de Bonjour Print Services..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    Write-Host "  ✓ Téléchargé : $tmp ($([Math]::Round((Get-Item $tmp).Length/1MB, 1)) Mo)"
  } catch {
    Write-Host "  ⚠ Téléchargement direct échoué : $_" -ForegroundColor Yellow
    Write-Host "  → Téléchargez manuellement depuis https://support.apple.com/kb/dl999"
    Write-Host "    puis double-cliquez sur l'installer."
    return
  }

  Write-Host "  → Installation silencieuse..."
  Start-Process -FilePath $tmp -ArgumentList "/qn /norestart" -Wait -PassThru | Out-Null
  Remove-Item $tmp -Force
  Start-Sleep -Seconds 2

  $svc = Get-Service -Name "Bonjour Service" -ErrorAction SilentlyContinue
  if ($svc) {
    Start-Service -Name "Bonjour Service" -ErrorAction SilentlyContinue
    Write-Host "  ✓ Bonjour Service installé et démarré"
  } else {
    Write-Host "  ⚠ Bonjour Service non détecté après install. Vérifier manuellement." -ForegroundColor Yellow
  }
}

# --- 1. Setup résolution DNS ----------------------------------------------
if ($Mode -eq "hosts") {
  Setup-Hosts
} else {
  Setup-Bonjour
}

# --- 2. Cert racine Caddy (optionnel) -------------------------------------
if ($InstallRootCert) {
  Write-Host "`n→ Téléchargement du certificat racine Caddy depuis $BoxIp..." -ForegroundColor Cyan
  $tmpCert = "$env:TEMP\caddy_root.crt"
  try {
    scp -o StrictHostKeyChecking=no "clikinfo@${BoxIp}:/tmp/caddy_root.crt" $tmpCert
    if (Test-Path $tmpCert) {
      Write-Host "  ✓ Certificat téléchargé : $tmpCert"
      Write-Host "→ Installation dans 'Autorités de certification racines de confiance'..." -ForegroundColor Cyan
      Import-Certificate -FilePath $tmpCert -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
      Remove-Item $tmpCert
      Write-Host "  ✓ Certificat installé. Redémarre les navigateurs ouverts pour prendre en compte."
    } else {
      Write-Host "  ⚠ scp échoué. Récupère manuellement le cert :" -ForegroundColor Yellow
      Write-Host "    ssh clikinfo@$BoxIp 'docker exec aibox-edge-caddy cat /data/caddy/pki/authorities/local/root.crt' > caddy_root.crt"
    }
  } catch {
    Write-Host "  ⚠ Erreur SCP : $_" -ForegroundColor Yellow
  }
}

# --- 3. Test ---------------------------------------------------------------
Write-Host "`n→ Test de résolution..." -ForegroundColor Cyan
Start-Sleep -Seconds 1
$resolved = $null
try {
  $resolved = (Resolve-DnsName -Name "aibox.local" -ErrorAction Stop).IPAddress | Select-Object -First 1
} catch { }

if ($resolved) {
  Write-Host "  ✓ aibox.local → $resolved"
} else {
  $ping = ping -n 1 aibox.local 2>&1 | Out-String
  if ($ping -match "(\d+\.\d+\.\d+\.\d+)") {
    Write-Host "  ✓ aibox.local → $($matches[1])"
  } else {
    Write-Host "  ⚠ Résolution échoue. Si tu viens d'installer Bonjour, redémarre le poste." -ForegroundColor Yellow
  }
}

Write-Host "`n✓ Setup terminé." -ForegroundColor Green
Write-Host "  Ouvre maintenant : https://aibox.local  ou  http://aibox.local"
if (-not $InstallRootCert) {
  Write-Host ""
  Write-Host "  Note : pour supprimer le warning de cert HTTPS, relance avec :"
  Write-Host "         .\setup-windows-aibox-local.ps1 -InstallRootCert"
}
