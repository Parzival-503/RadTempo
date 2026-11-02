;@Ahk2Exe-SetCompanyName Avecina Studio
;@Ahk2Exe-SetProductName RadTempo
;@Ahk2Exe-SetDescription RadTempo keyboard and PowerScribe helper
;@Ahk2Exe-SetCopyright Copyright (c) Avecina Studio
;@Ahk2Exe-SetOrigFilename RadTempoHelper.exe
;@Ahk2Exe-SetVersion 3.0.0
; ============================================================================
;  RadTempo helper (AutoHotkey v1.1)
;
;  The Windows-only half of RadTempo. The app (Electron) draws everything
;  and keeps the logic; this helper does the four things only AutoHotkey can:
;
;    1. watches F4 / Ctrl+Alt+F4 / F12 with a PASS-THROUGH hook (~), so
;       PowerScribe still gets the key (F4 toggles its microphone);
;    2. reads PowerScribe's EXAMINATION line and Order Data pane, read-only;
;    3. reads the rows selected in the PACS worklist (the IVU forecast);
;    4. reports physical idle time (A_TimeIdlePhysical ignores keys that
;       other scripts send).
;
;  It talks to the app over http://127.0.0.1 with the token in bridge.ini
;  (in %RT_HUB_DIR%, set by the app). It is compiled into the app and started
;  and restarted by it; it has no tray icon and never shows a window or a
;  message box: it runs during dictation, and anything that took focus would
;  put keystrokes in the wrong place.
;
;  PowerScribe rules (learned in the classic RadTempo): only ever READ
;  PowerScribe's controls - ControlGetText / ControlGetPos - never send it
;  messages, and never touch its report editor. Every read is wrapped in try.
; ============================================================================

#Requires AutoHotkey v1.1.33+
#Persistent
#SingleInstance Force
#NoEnv
#UseHook On
#InstallKeybdHook
; A_TimeIdlePhysical only ignores artificial input for hooks that are
; installed: without the mouse hook, scrolling a stack would look idle.
#InstallMouseHook
SetBatchLines, -1

global g_Dir := ""
global g_Port := 0
global g_Token := ""
global g_LastPACS := 0
global g_LastFg := 0
global g_PS := "ahk_exe Nuance.PowerScribe360.exe"
global g_SelfTest := false
global g_Fails := 0

for i, a in A_Args
    if (a = "--selftest")
        g_SelfTest := true

EnvGet, g_Dir, RT_HUB_DIR
if (g_Dir = "")
    g_Dir := A_AppData . "\RadTempo"
Menu, Tray, NoIcon

ReadBridge()

if (g_SelfTest) {
    ; Run every reader once (no PowerScribe, no PACS on a build machine) so a
    ; load-time or call-time error shows up here rather than at the desk.
    selfExam := PSFields()
    selfRows := WorklistRows()
    selfDiag := PacsDiagnostic()
    selfIdle := A_TimeIdlePhysical
    FileAppend, SELFTEST OK`n, *
    ExitApp, 0
}

SetTimer, HubPoll, 300
SetTimer, TrackWindows, 1000
return

; ============================================================================
;  KEYS - all hotkeys live below the auto-execute section (a hotkey above it
;  would end it early and nothing after it would run).
; ============================================================================

~^!F4::
~F4::
    HubRequest("POST", "/key?k=start", "", 800)
return

; F12 signs in PowerScribe. Read the exam and the order NOW, before the sign
; completes and PowerScribe moves on, and hand them over with the key.
~F12::
    stopBody := PSFields()
    HubRequest("POST", "/key?k=stop", stopBody, 1500)
return

; ============================================================================
;  BRIDGE
; ============================================================================

ReadBridge() {
    global g_Dir, g_Port, g_Token
    f := g_Dir . "\bridge.ini"
    IniRead, p, %f%, Bridge, Port, 0
    IniRead, t, %f%, Bridge, Token, %A_Space%
    g_Port := p + 0
    g_Token := Trim(t)
}

; Returns the reply text, or "" when the app is not there.
HubRequest(method, path, body := "", timeoutMs := 600) {
    global g_Port, g_Token, g_Fails
    if (g_Token = "" || g_Port = 0)
        ReadBridge()
    if (g_Token = "" || g_Port = 0)
        return ""
    reply := ""
    try {
        http := ComObjCreate("WinHttp.WinHttpRequest.5.1")
        ; A hospital WinHTTP proxy must not swallow calls to localhost.
        http.SetProxy(1)
        http.Open(method, "http://127.0.0.1:" . g_Port . path, false)
        http.SetRequestHeader("X-RT-Token", g_Token)
        http.SetRequestHeader("Content-Type", "text/plain; charset=utf-8")
        http.SetTimeouts(250, 250, timeoutMs, timeoutMs)
        http.Send(body)
        if (http.Status = 403) {
            ; The app restarted with a new token.
            ReadBridge()
            return ""
        }
        reply := http.ResponseText
        g_Fails := 0
    } catch e {
        g_Fails += 1
        if (Mod(g_Fails, 20) = 0)
            ReadBridge()
        reply := ""
    }
    return reply
}

; The heartbeat: idle time out, commands back (one per line).
HubPoll:
    pollClassic := ClassicWindow() ? 1 : 0
    pollReply := HubRequest("GET", "/poll?idle=" . A_TimeIdlePhysical . "&classic=" . pollClassic, "", 600)
    Loop, Parse, pollReply, `n, `r
    {
        if (A_LoopField != "")
            RunCommand(A_LoopField)
    }
return

RunCommand(cmd) {
    global g_LastFg
    name := cmd
    id := ""
    p := InStr(cmd, ":")
    if (p) {
        name := SubStr(cmd, 1, p - 1)
        id := SubStr(cmd, p + 1)
    }
    if (name = "read") {
        HubRequest("POST", "/reply?id=" . id, PSFields(), 1500)
    } else if (name = "rows") {
        HubRequest("POST", "/reply?id=" . id, WorklistRows(), 3000)
    } else if (name = "diag") {
        HubRequest("POST", "/reply?id=" . id, "text=" . FieldEsc(PacsDiagnostic()), 3000)
    } else if (name = "classic") {
        HubRequest("POST", "/reply?id=" . id, "dir=" . FieldEsc(ClassicDir()), 1500)
    } else if (name = "activate") {
        ; Give the keyboard back to whatever had it before the menu or a
        ; dialog opened (PowerScribe, usually).
        if (g_LastFg && WinExist("ahk_id " . g_LastFg))
            WinActivate, ahk_id %g_LastFg%
    } else if (name = "closeclassic") {
        CloseClassic()
    } else if (name = "quit") {
        ExitApp
    }
}

; One field value on one line: newline and tab written as \n and \t,
; backslash and anything outside printable ASCII as \u{XXXX}.
FieldEsc(s) {
    out := ""
    Loop, Parse, s
    {
        c := A_LoopField
        o := Ord(c)
        if (o = 10)
            out .= "\n"
        else if (o = 9)
            out .= "\t"
        else if (o = 13)
            continue
        else if (o = 92)
            out .= "\u{5C}"
        else if (o < 32 || o > 126)
            out .= "\u{" . Format("{:X}", o) . "}"
        else
            out .= c
    }
    return out
}

; ============================================================================
;  WINDOWS: the last window that had the keyboard, and the PACS worklist
; ============================================================================

TrackWindows:
    WinGet, fgHwnd, ID, A
    if (!fgHwnd)
        return
    WinGetClass, fgClass, ahk_id %fgHwnd%
    WinGet, fgExe, ProcessName, ahk_id %fgHwnd%
    if (fgExe = "" || fgExe = "RadTempo.exe" || fgExe = "RadTempoHelper.exe" || fgExe = "electron.exe" || fgExe = "AutoHotkey.exe")
        return
    if (fgClass = "Shell_TrayWnd" || fgClass = "WorkerW" || fgClass = "Progman" || fgClass = "NotifyIconOverflowWindow")
        return
    g_LastFg := fgHwnd
    WinGet, fgCtrls, ControlList, ahk_id %fgHwnd%
    if InStr(fgCtrls, "SysListView32")
        g_LastPACS := fgHwnd
return

; ============================================================================
;  POWERSCRIBE (read-only)
; ============================================================================

; exam=, code=, desc= lines for the app. Empty values when PowerScribe is
; closed or has nothing.
PSFields() {
    exam := ""
    code := ""
    desc := ""
    try exam := ReadExamFromPS()
    try {
        o := ReadOrderFromPS()
        code := o.code
        desc := o.desc
    }
    return "exam=" . FieldEsc(exam) . "`ncode=" . FieldEsc(code) . "`ndesc=" . FieldEsc(desc)
}

; The report's EXAMINATION line, dates and commas stripped.
ReadExamFromPS() {
    global g_PS
    if !WinExist(g_PS)
        return ""
    examText := ""
    WinGet, ctrlList, ControlList, %g_PS%
    Loop, Parse, ctrlList, `n
    {
        ctrl := A_LoopField
        if (ctrl = "")
            continue
        if (InStr(ctrl, "RICHEDIT") || InStr(ctrl, "Edit") || InStr(ctrl, "Static") || InStr(ctrl, "STATIC")) {
            ControlGetText, ctrlText, %ctrl%, %g_PS%
            if (ctrlText != "") {
                StringUpper, ctrlTextU, ctrlText
                if (InStr(ctrlTextU, "EXAMINATION") || InStr(ctrlTextU, " CT ") || InStr(ctrlTextU, " MR") || InStr(ctrlTextU, "X-RAY") || InStr(ctrlTextU, "PET") || InStr(ctrlTextU, "NM ") || InStr(ctrlTextU, "ULTRASOUND")) {
                    examText .= ctrlText . "`n"
                    if (InStr(ctrlTextU, "EXAMINATION"))
                        break
                }
            }
        }
    }
    if (examText = "")
        return ""
    StringUpper, examUpper, examText
    examPos := InStr(examUpper, "EXAMINATION")
    if (examPos) {
        line := SubStr(examText, examPos + 11)
        line := RegExReplace(line, "^[\s:]+", "")
    } else {
        line := examText
    }
    nlPos := InStr(line, "`n")
    if (nlPos > 0)
        line := SubStr(line, 1, nlPos - 1)
    if (StrLen(line) > 300)
        line := SubStr(line, 1, 300)
    StringReplace, line, line, `,, %A_Space%, All
    line := RegExReplace(line, "\s+\d{1,2}/\d{1,2}/\d{4}.*$", "")
    return Trim(line)
}

; One pass over a window's controls: name, geometry and text.
ScanControls(winSpec) {
    out := []
    if !WinExist(winSpec)
        return out
    WinGet, ctrls, ControlList, %winSpec%
    Loop, Parse, ctrls, `n
    {
        c := A_LoopField
        if (c = "")
            continue
        ControlGetPos, cx, cy, cw, ch, %c%, %winSpec%
        ControlGetText, ct, %c%, %winSpec%
        ct := RegExReplace(Trim(ct), "\s+", " ")
        out.Push({n: c, x: cx, y: cy, w: cw, h: ch, t: ct})
    }
    return out
}

; A labelled field's value: "Procedure: CTAABPEWWO" in one control, or the
; label and value in two controls on the same row. A value can WRAP, so it
; pairs on the label's midpoint falling inside the value's vertical span.
FieldFromScan(ctrls, label) {
    lx := -1, ly := 0, lh := 0
    n := ctrls.MaxIndex()
    if (n = "")
        return ""
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = "")
            continue
        if (RegExMatch(c.t, "i)^\s*" . label . "\s*:\s*(.*)$", fm)) {
            v := Trim(fm1)
            if (v != "")
                return v
            lx := c.x, ly := c.y, lh := c.h
            break
        }
    }
    if (lx < 0)
        return ""
    lmid := ly + lh / 2
    best := "", bestDx := 99999
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = "" || c.x <= lx)
            continue
        if (lmid < c.y - 6 || lmid > c.y + c.h + 6)
            continue
        dx := c.x - lx
        if (dx < bestDx) {
            bestDx := dx
            best := c.t
        }
    }
    return Trim(best)
}

; "Procedure:" appears twice in PowerScribe (the order's, and an AutoText
; Manager filter reading "All"), so reads are clipped to the Order Data panel.
ClipToPanel(ctrls, panelText) {
    n := ctrls.MaxIndex()
    if (n = "")
        return ctrls
    px := -1, py := 0, pw := 0, ph := 0
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.t = panelText && c.w > 40 && c.h > 40) {
            px := c.x, py := c.y, pw := c.w, ph := c.h
            break
        }
    }
    if (px < 0)
        return ctrls
    out := []
    Loop, %n% {
        c := ctrls[A_Index]
        if (c.x >= px - 4 && c.y >= py - 4 && c.x <= px + pw + 4 && c.y <= py + ph + 4)
            out.Push(c)
    }
    if (out.MaxIndex() = "")
        return ctrls
    return out
}

; The order's procedure CODE (what PowerScribe bills against, never
; truncated) and its description when it is not elided. The accession is
; deliberately not read: it identifies a patient.
ReadOrderFromPS() {
    global g_PS
    res := {code: "", desc: ""}
    if !WinExist(g_PS)
        return res
    ctrls := ClipToPanel(ScanControls(g_PS), "Order Data")
    code := FieldFromScan(ctrls, "Procedure")
    desc := FieldFromScan(ctrls, "Description")
    code := RegExReplace(code, "[^A-Za-z0-9]", "")
    StringUpper, code, code
    if (StrLen(code) < 4 || StrLen(code) > 24)
        code := ""
    if (code = "ALL" || code = "NONE" || code = "ANY" || code = "NA")
        code := ""
    res.code := code
    if (desc != "" && !InStr(desc, "..."))
        res.desc := desc
    return res
}

; ============================================================================
;  PACS WORKLIST (the forecast)
; ============================================================================

; rows=<selected rows, tab-separated columns> or error=nopacs|noctrl|nosel
WorklistRows() {
    global g_LastPACS
    if (!g_LastPACS || !WinExist("ahk_id " . g_LastPACS))
        return "error=nopacs"
    pacsWin := "ahk_id " . g_LastPACS
    selectedRows := ""
    listCtrl := ""
    bestRows := -1
    try {
        WinGet, ctrlList, ControlList, %pacsWin%
        Loop, Parse, ctrlList, `n
        {
            ctrl := A_LoopField
            if !InStr(ctrl, "SysListView32")
                continue
            ControlGet, sel, List, Selected, %ctrl%, %pacsWin%
            ControlGet, cnt, List, Count, %ctrl%, %pacsWin%
            if (sel != "") {
                listCtrl := ctrl
                break
            }
            if (cnt > bestRows) {
                bestRows := cnt
                listCtrl := ctrl
            }
        }
        if (listCtrl = "")
            return "error=noctrl"
        ControlGet, selectedRows, List, Selected, %listCtrl%, %pacsWin%
    } catch e {
        return "error=noctrl"
    }
    if (selectedRows = "")
        return "error=nosel"
    return "rows=" . FieldEsc(selectedRows)
}

; What the last PACS window holds, for when the forecast reads nothing.
PacsDiagnostic() {
    global g_LastPACS
    if (!g_LastPACS || !WinExist("ahk_id " . g_LastPACS))
        return "No PACS window detected yet.`nClick on your PACS worklist, wait 2 seconds, then try again."
    pacsWin := "ahk_id " . g_LastPACS
    info := ""
    try {
        WinGet, pacsExe, ProcessName, %pacsWin%
        WinGetTitle, pacsTitle, %pacsWin%
        WinGet, ctrlList, ControlList, %pacsWin%
        info := "PACS WINDOW DIAGNOSTIC`n"
        info .= "Process: " . pacsExe . "`nTitle: " . pacsTitle . "`n`nSysListView32 controls:`n"
        listCount := 0
        Loop, Parse, ctrlList, `n
        {
            if (A_LoopField = "" || !InStr(A_LoopField, "SysListView32"))
                continue
            listCount++
            ControlGet, sel, List, Selected, %A_LoopField%, %pacsWin%
            ControlGet, allCount, List, Count, %A_LoopField%, %pacsWin%
            selRows := (sel = "") ? 0 : StrSplit(sel, "`n").MaxIndex()
            info .= "  " . A_LoopField . "  rows: " . allCount . "  selected: " . selRows . "`n"
        }
        info .= (listCount = 0) ? "No SysListView32 controls found.`n" : "Found " . listCount . " list control(s).`n"
    } catch e {
        info .= "Could not read the window: " . e.Message
    }
    return info
}

; ============================================================================
;  THE CLASSIC RADTEMPO (the old AutoHotkey version)
; ============================================================================

; Its widget is an AutoHotkey window titled exactly "RadTempo". Running
; both would time and log every study twice.
ClassicWindow() {
    SetTitleMatchMode, 3
    return WinExist("RadTempo ahk_class AutoHotkeyGUI")
}

; The folder its files live in: the .exe's folder, or the .ahk script's
; (read from AutoHotkey's hidden main window title).
ClassicDir() {
    h := ClassicWindow()
    if (!h)
        return ""
    WinGet, pid, PID, ahk_id %h%
    WinGet, path, ProcessPath, ahk_id %h%
    SplitPath, path, exeName, exeDir
    if (exeName = "AutoHotkey.exe" || exeName = "AutoHotkeyU64.exe" || exeName = "AutoHotkeyU32.exe" || exeName = "AutoHotkeyA32.exe") {
        DetectHiddenWindows, On
        WinGetTitle, mainTitle, ahk_class AutoHotkey ahk_pid %pid%
        DetectHiddenWindows, Off
        if RegExMatch(mainTitle, "^(.*\.ahk)\s+-\s+AutoHotkey", m) {
            SplitPath, m1,, scriptDir
            return scriptDir
        }
    }
    return exeDir
}

; Close it the way its own Exit does (it saves its position and quits).
CloseClassic() {
    h := ClassicWindow()
    if (h)
        WinClose, ahk_id %h%
}
