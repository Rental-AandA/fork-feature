# Starts "T3 Code Feature" as a local web app: the fork's server on the signed
# Node.js runtime (OpenJS Foundation) plus a Chrome/Edge app window. No unsigned
# executable is involved, so endpoint protection does not block it.
#
# Layout (created by Install-T3Feature.ps1):
#   <root>\app-<commit> server bundle (pnpm deploy of apps/server, includes the web client)
#   <root>\current.txt  active app-<commit> folder
#   <root>\logs        server output, one file per start
#   <root>\server.pid  PID of the running server
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 3780,
  # Separate data directory (tests). Empty = ~\.t3, shared with the desktop app.
  [string]$BaseDir = '',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework

function Show-Message([string]$text, [string]$icon = 'Information') {
  # -NoBrowser is the unattended/test mode: never block on a dialog there.
  if ($NoBrowser) { Write-Output "[$icon] $text"; return }
  [void][System.Windows.MessageBox]::Show($text, 'T3 Code Feature', 'OK', $icon)
}

function Find-Browser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Test-ServerReady {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/.well-known/t3/environment"
    return $r.StatusCode -eq 200
  } catch { return $false }
}

$currentFile = Join-Path $Root 'current.txt'
$app = if (Test-Path $currentFile) { Join-Path $Root ((Get-Content $currentFile -Raw).Trim()) } else { Join-Path $Root 'app' }
$logs = Join-Path $Root 'logs'
$pidFile = Join-Path $Root 'server.pid'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$browser = Find-Browser
if (-not $node) { Show-Message 'Node.js wurde nicht gefunden. Bitte Node.js 24 installieren.' 'Error'; exit 1 }
if (-not $browser) { Show-Message 'Weder Chrome noch Edge gefunden.' 'Error'; exit 1 }
if (-not (Test-Path (Join-Path $app 'dist\bin.mjs'))) { Show-Message "Installation unvollstaendig: $app" 'Error'; exit 1 }

# The official desktop app and this server share ~\.t3 and must never run together.
$official = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\Programs\t3code\*' -or $_.Path -like '*\Programs\t3code-feature\*' }
if ($official -and -not $BaseDir) {
  Show-Message "Das T3-Desktop-Programm laeuft noch.`nBitte zuerst ganz beenden (auch das Tray-Symbol) und dann erneut starten." 'Warning'
  exit 1
}

New-Item -ItemType Directory -Force $logs | Out-Null
$pairingUrl = $null

if (-not (Test-ServerReady)) {
  $log = Join-Path $logs ("server-" + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss') + '.log')
  $errLog = $log -replace '\.log$', '.err.log'
  $proc = Start-Process -FilePath $node -WorkingDirectory $HOME -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError $errLog `
    -ArgumentList (@("`"$app\dist\bin.mjs`"", 'serve', '--mode', 'web', '--host', '127.0.0.1', '--port', "$Port", '--no-browser') + $(if ($BaseDir) { @('--base-dir', "`"$BaseDir`"") } else { @() }))
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    if (Test-Path $log) {
      $m = Select-String -Path $log -Pattern 'Pairing URL:\s*(\S+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($m -and (Test-ServerReady)) { $pairingUrl = $m.Matches[0].Groups[1].Value; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if ($proc.HasExited -or -not (Test-ServerReady)) {
    Show-Message "Der Server ist nicht gestartet.`nProtokoll: $log" 'Error'
    exit 1
  }
}

# A fresh pairing link signs this browser in once; later starts reuse the session.
$target = if ($pairingUrl) { $pairingUrl } else { "http://127.0.0.1:$Port/" }
if ($NoBrowser) { Write-Output "ready $Port"; exit 0 }
Start-Process -FilePath $browser -ArgumentList @("--app=$target", '--new-window')
