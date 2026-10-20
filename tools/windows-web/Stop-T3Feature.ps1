# Stops the "T3 Code Feature" server started by Start-T3Feature.ps1.
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [switch]$Quiet)
Add-Type -AssemblyName PresentationFramework
$pidFile = Join-Path $Root 'server.pid'
$stopped = $false
if (Test-Path $pidFile) {
  $serverPid = [int](Get-Content $pidFile -Raw)
  $p = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    # Ctrl+C is not available for a hidden process; stop the process tree so provider sessions end too.
    & taskkill.exe /PID $serverPid /T 2>$null | Out-Null
    if (-not $p.WaitForExit(15000)) { & taskkill.exe /PID $serverPid /T /F 2>$null | Out-Null }
    $stopped = $true
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
$text = if ($stopped) { 'T3 Code Feature wurde beendet.' } else { 'T3 Code Feature lief nicht.' }
if ($Quiet) { Write-Output $text; exit 0 }
[void][System.Windows.MessageBox]::Show($text, 'T3 Code Feature', 'OK', 'Information')
