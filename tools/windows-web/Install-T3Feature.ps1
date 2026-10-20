# Installs or updates "T3 Code Feature" (web mode) from a built checkout.
# Build first in the checkout:  vp i ; vp run build:desktop
# Result:
#   <Root>\app-<commit>  self-contained server bundle (pnpm deploy --prod of apps/server)
#   <Root>\current.txt   name of the active app-<commit> folder (previous one kept for rollback)
#   <Root>\bin   start/stop scripts + icon
#   Desktop and Start menu shortcuts "T3 Code Feature" and "T3 Code Feature beenden"
param(
  [string]$Checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Root = 'C:\T3CodeFeature',
  [string]$PnpmVersion = '11.10.0',
  [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'

$bin = Join-Path $Checkout 'apps\server\dist\bin.mjs'
if (-not (Test-Path $bin)) { throw "Kein Build gefunden ($bin). Erst 'vp run build:desktop' im Checkout ausfuehren." }
if (-not (Test-Path (Join-Path $Checkout 'apps\server\dist\client\index.html'))) { throw 'Web-Client fehlt im Server-Build.' }

$pidFile = Join-Path $Root 'server.pid'
if (Test-Path $pidFile) {
  $running = Get-Process -Id ([int](Get-Content $pidFile -Raw)) -ErrorAction SilentlyContinue
  if ($running) { throw 'T3 Code Feature laeuft noch. Erst mit "T3 Code Feature beenden" stoppen.' }
}

New-Item -ItemType Directory -Force $Root | Out-Null
$commit = (& git -C $Checkout rev-parse --short HEAD).Trim()
# Each version gets its own folder and is never moved: pnpm links node_modules with
# absolute junctions, which break if the folder is renamed after the deploy.
$app = Join-Path $Root "app-$commit"
if (Test-Path $app) { cmd /c rmdir /s /q "$app" }

Push-Location $Checkout
try {
  & npx -y "pnpm@$PnpmVersion" --filter t3 deploy --prod --legacy $app
  if ($LASTEXITCODE -ne 0) { throw "pnpm deploy fehlgeschlagen ($LASTEXITCODE)" }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $app 'dist\bin.mjs'))) { throw "Deploy unvollstaendig: $app" }

# current.txt points the start script at the active version; the previous one stays for rollback.
$currentFile = Join-Path $Root 'current.txt'
$previous = if (Test-Path $currentFile) { (Get-Content $currentFile -Raw).Trim() } else { '' }
Set-Content -Path $currentFile -Value "app-$commit" -Encoding ascii -NoNewline
Get-ChildItem $Root -Directory -Filter 'app-*' | Where-Object { $_.Name -ne "app-$commit" -and $_.Name -ne $previous } |
  ForEach-Object { cmd /c rmdir /s /q "$($_.FullName)" }
Set-Content -Path (Join-Path $Root 'VERSION.txt') -Value "commit $commit, installiert $(Get-Date -Format 'yyyy-MM-dd HH:mm'), vorher: $previous" -Encoding utf8

$binDir = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'Start-T3Feature.ps1') $binDir -Force
Copy-Item (Join-Path $PSScriptRoot 'Stop-T3Feature.ps1') $binDir -Force
Copy-Item (Join-Path $Checkout 'apps\server\dist\client\favicon.ico') (Join-Path $binDir 't3.ico') -Force

if ($NoShortcuts) { Write-Host "T3 Code Feature installiert (ohne Verknuepfungen): $Root (commit $commit)"; exit 0 }
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  @{ Name = 'T3 Code Feature'; Script = 'Start-T3Feature.ps1' },
  @{ Name = 'T3 Code Feature beenden'; Script = 'Stop-T3Feature.ps1' }
)
$folders = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'T3 Code Feature'))
foreach ($folder in $folders) {
  New-Item -ItemType Directory -Force $folder | Out-Null
  foreach ($t in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $folder "$($t.Name).lnk"))
    $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $binDir $t.Script)`""
    $lnk.WorkingDirectory = $binDir
    $lnk.IconLocation = (Join-Path $binDir 't3.ico')
    $lnk.WindowStyle = 7
    $lnk.Save()
  }
}
Write-Host "T3 Code Feature installiert: $Root (commit $commit)"
