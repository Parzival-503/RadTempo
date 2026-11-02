; A stand-in PowerScribe window for the Windows build machine: compiled as
; Nuance.PowerScribe360.exe so the helper finds it exactly as it finds the
; real one. It shows an invented report line and an Order Data panel with a
; procedure code. Nothing in it is real.
#NoEnv
#SingleInstance Force
Gui, +AlwaysOnTop
Gui, Font, s10, Segoe UI
Gui, Add, Edit, x10 y10 w460 h70 ReadOnly, EXAMINATION: CT CHEST WITH CONTRAST 10/29/2026`nCLINICAL HISTORY: invented test case
Gui, Add, GroupBox, x10 y90 w460 h110, Order Data
Gui, Add, Text, x24 y116 w90 h22, Procedure:
Gui, Add, Text, x120 y116 w200 h22, CTCHW
Gui, Add, Text, x24 y150 w90 h22, Description:
Gui, Add, Text, x120 y150 w320 h22, CT CHEST WITH CONTRAST
Gui, Show, x40 y40 w480 h210, PowerScribe 360 - test stand-in
return

GuiClose:
ExitApp
