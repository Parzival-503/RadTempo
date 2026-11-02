# Installer / uninstaller test on the Windows build machine: a fresh
# per-user install (no admin), installing over a running copy, and
# uninstalling while it runs - the cases where Setup used to say "cannot be
# closed". The silent installer's default answer to that dialog is Cancel, so
# a failure shows as "did not finish" instead of hanging.
$ErrorActionPreference = 'Continue'
$setup = (Resolve-Path 'dist\RadTempo-Setup.exe').Path
$dir = Join-Path $env:LOCALAPPDATA 'Programs\RadTempo'
$exe = Join-Path $dir 'RadTempo.exe'
$fail = 0
function Check($name, $ok, $detail = '') {
  if ($ok) { Write-Host "PASS  $name  $detail" } else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function Ours { Get-CimInstance Win32_Process | ? { $_.Path -and $_.Path.StartsWith($dir, 'CurrentCultureIgnoreCase') } | % { "$($_.ProcessId) $($_.Path)" } }
function RunFor($file, $argList, $secs) {
  $p = Start-Process -FilePath $file -ArgumentList $argList -PassThru
  if (-not $p.WaitForExit($secs * 1000)) { $p.Kill(); return 'timeout' }
  return $p.ExitCode
}

# 1. Fresh install.
$r = RunFor $setup '/S' 120
Check 'fresh install' (Test-Path $exe) "exit=$r"

# 2. Start it; wait for the helper too.
Start-Process $exe
Start-Sleep 8
$running = @(Ours)
Write-Host "running from the install folder:`n  $($running -join "`n  ")"
Check 'app and helper running' ($running.Count -ge 2)

# 3. The polite way the installer now closes it: POST /quit over the bridge.
#    (Works even when RadTempo runs as administrator and Setup does not,
#    which is what produced "RadTempo cannot be closed" on a workstation.)
$ini = Get-Content (Join-Path $env:APPDATA 'RadTempo\bridge.ini')
$port = (($ini | ? { $_ -like 'Port=*' }) -replace 'Port=', '').Trim()
$tok = (($ini | ? { $_ -like 'Token=*' }) -replace 'Token=', '').Trim()
try { $q = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 3 -Headers @{ 'x-rt-token' = $tok } -Uri "http://127.0.0.1:$port/quit" } catch { $q = $_ }
Start-Sleep 4
Check 'the app quits when asked over the bridge (helper too)' (@(Ours).Count -eq 0) "reply=$($q.Content) left: $(@(Ours) -join ' | ')"
Start-Process $exe
Start-Sleep 8

# 4. Install again over the running copy.
Remove-Item (Join-Path $env:TEMP 'RadTempo-Setup.log') -ErrorAction SilentlyContinue
$before = (Get-Item $exe).LastWriteTimeUtc
Start-Sleep 2
(Get-Item $exe).LastWriteTimeUtc = [datetime]'2000-01-01'
$r = RunFor $setup '/S' 120
$after = (Get-Item $exe -ErrorAction SilentlyContinue).LastWriteTimeUtc
Check 'install over a running copy finishes' ($r -eq 0 -and $after -gt [datetime]'2001-01-01') "exit=$r left: $(@(Ours) -join ' | ')"
$slog = Get-Content (Join-Path $env:TEMP 'RadTempo-Setup.log') -ErrorAction SilentlyContinue
Write-Host "setup log:`n  $($slog -join "`n  ")"
Check 'Setup ran our close step (build/rg-close.ps1) and it ended clear' (($slog -join ' ') -match ' clear') ''

# 5. Start it again, then uninstall while it runs.
Start-Process $exe
Start-Sleep 8
$un = Join-Path $dir 'Uninstall RadTempo.exe'
$r = RunFor $un '/S' 120
Start-Sleep 5
Check 'uninstall while running removes it' (-not (Test-Path $exe)) "exit=$r left: $(@(Ours) -join ' | ')"
Check 'nothing left running' (@(Ours).Count -eq 0) "$(@(Ours) -join ' | ')"

if ($fail) { exit 1 }
