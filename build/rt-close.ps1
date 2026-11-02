# Closes the running RadTempo before Setup or the uninstaller touches its
# files. Called by build/installer.nsh with the install folder.
#
#   1. ask it to quit over its local bridge (POST /quit with the token from
#      %APPDATA%\RadTempo\bridge.ini): allowed even when RadTempo runs as
#      administrator and Setup does not, where a kill is refused;
#   2. wait up to 6 s;
#   3. force-close whatever still runs from the install folder: the same rule
#      electron-builder's own check and an older version's uninstaller use,
#      so nothing is left for them to trip over ("cannot be closed");
#   4. wait until its files can be opened for writing (antivirus or a dying
#      process can hold them a moment).
# Exit 0 = clear, 1 = something is still running. Writes
# %TEMP%\RadTempo-Setup.log so a failure can be diagnosed.
param([string]$Dir)
$log = Join-Path $env:TEMP 'RadTempo-Setup.log'
function Log($m) { Add-Content -Path $log -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $m) -ErrorAction SilentlyContinue }
$Dir = $Dir.TrimEnd('\')
Log "---- close RadTempo in $Dir"
function Running {
  @(Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($Dir + '\', 'CurrentCultureIgnoreCase') })
}
$r = Running
if ($r.Count -eq 0) { Log 'nothing running'; exit 0 }
$r | ForEach-Object { Log ("running: {0} {1}" -f $_.ProcessId, $_.Path) }

$ini = Join-Path $env:APPDATA 'RadTempo\bridge.ini'
if (Test-Path $ini) {
  $c = Get-Content $ini
  $port = (($c | Where-Object { $_ -like 'Port=*' }) -replace 'Port=', '').Trim()
  $tok = (($c | Where-Object { $_ -like 'Token=*' }) -replace 'Token=', '').Trim()
  try {
    $q = Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 3 -Headers @{ 'x-rt-token' = $tok } -Uri "http://127.0.0.1:$port/quit"
    Log "asked to quit: $($q.Content)"
  } catch { Log "quit request failed: $($_.Exception.Message)" }
}
for ($i = 0; $i -lt 20 -and (Running).Count -gt 0; $i++) { Start-Sleep -Milliseconds 300 }

Running | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Log "force-closed $($_.ProcessId)" }
  catch { Log "could not close $($_.ProcessId) $($_.Path): $($_.Exception.Message)" }
}
Start-Sleep -Milliseconds 800
$left = Running
if ($left.Count -gt 0) {
  $left | ForEach-Object { Log ("still running: {0} {1}" -f $_.ProcessId, $_.Path) }
  exit 1
}

# Files still held open (antivirus scan, a process on its way out)?
$exes = @(Get-ChildItem -Path $Dir -Recurse -Include *.exe, *.dll, *.asar -File -ErrorAction SilentlyContinue)
for ($i = 0; $i -lt 10; $i++) {
  $held = @($exes | Where-Object {
    try { $s = [IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'None'); $s.Close(); $false } catch { $true }
  })
  if ($held.Count -eq 0) { break }
  if ($i -eq 0) { $held | Select-Object -First 5 | ForEach-Object { Log "file in use: $($_.FullName)" } }
  Start-Sleep -Milliseconds 500
}
Log 'clear'
exit 0
