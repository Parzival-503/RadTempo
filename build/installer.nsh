; RadTempo's own "close the running app" step for the installer and the
; uninstaller (electron-builder runs customCheckAppRunning in both). The work
; is in build/rt-close.ps1 (kept as a file: a long inline command can be cut
; off by NSIS's string limit). See its header for the order of attempts.
; Only if RadTempo is still running afterwards does Setup show a message,
; and it says what to do. tests-e2e/installer.ps1 installs over and
; uninstalls a running copy on the Windows build machine.

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\rt-close.ps1 "${BUILD_RESOURCES_DIR}\rt-close.ps1"
  rgCloseLoop:
    DetailPrint "Closing RadTempo..."
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rt-close.ps1" -Dir "$INSTDIR"`
    Pop $R0
    ${if} $R0 == "error"
      ; PowerShell blocked on this PC: close them by name instead.
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM RadTempo.exe /IM RadTempoHelper.exe /FI "USERNAME eq %USERNAME%"`
      Pop $R0
      Sleep 1500
      StrCpy $R0 0
    ${endIf}
    ${if} $R0 == 1
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "RadTempo is still running and Setup is not allowed to close it (it was probably started as administrator).$\r$\n$\r$\nRight-click the RadTempo icon near the clock and choose Quit RadTempo, then click Retry.$\r$\n$\r$\nDetails: %TEMP%\RadTempo-Setup.log" /SD IDCANCEL IDRETRY rgCloseLoop
      Quit
    ${endIf}
!macroend
