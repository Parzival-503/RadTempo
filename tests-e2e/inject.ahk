; Presses F4 (start) or F12 (sign) the way a person would, for
; tests-e2e/run.js on the Windows build machine. SendLevel 1 so the helper's
; pass-through hotkeys see it, as they see RadGesture's key presses.
#NoEnv
#SingleInstance Off
SendMode Event
SendLevel, 1
SetKeyDelay, 30, 30

which := A_Args[1]
if (which = "start")
    Send, {F4}
else if (which = "stop")
    Send, {F12}
Sleep, 300
ExitApp
