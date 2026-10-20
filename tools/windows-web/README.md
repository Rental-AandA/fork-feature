# T3 Code Feature on Windows (web mode)

Runs this fork the way the official `t3` command does: the server on the signed
Node.js runtime, the UI as a Chrome/Edge app window. No unsigned executable is
involved, so endpoint protection (e.g. Bitdefender) does not block it the way it
blocks an unsigned Electron build.

## Install or update

```powershell
vp i
vp run build:desktop
powershell -ExecutionPolicy Bypass -File tools\windows-web\Install-T3Feature.ps1
```

- Installs to `C:\T3CodeFeature` (`-Root` to change): `app-<commit>` per version,
  `current.txt` points at the active one, the previous version stays for rollback.
- Creates Desktop and Start menu shortcuts "T3 Code Feature" and
  "T3 Code Feature beenden".

## Data

The server uses `~\.t3` like the desktop app. The two must never run at the same
time; the start shortcut refuses while a T3 desktop app is running. The fork adds
database migrations, so back up `~\.t3` before the first start.

## Test without touching real data

```powershell
.\Install-T3Feature.ps1 -Root <tmp>\feature-root -NoShortcuts
<tmp>\feature-root\bin\Start-T3Feature.ps1 -Root <tmp>\feature-root -Port 3792 -BaseDir <tmp>\t3iso -NoBrowser
<tmp>\feature-root\bin\Stop-T3Feature.ps1 -Root <tmp>\feature-root -Quiet
```
