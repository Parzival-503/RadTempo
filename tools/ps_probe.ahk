; ============================================================
;  ps_probe.ahk - READ-ONLY reconnaissance on PowerScribe
;
;  Standalone. Not part of RadTempo.ahk. Run it, do nothing
;  else, press a hotkey, paste the result.
;
;  Why it exists: RadTempo derives IVU by fuzzy-matching the
;  free-text "EXAMINATION:" line against a CSV table, while
;  PowerScribe reports an RVU Sum it computes from the ORDER.
;  The two disagree. Before writing any reader we need to know
;  what the relevant windows are actually made of:
;
;    F9  - dump every window of Nuance.PowerScribe360.exe:
;          each control's ClassNN, position, and text.
;          Open "Dashboards -> My productivity" FIRST so the
;          productivity grid is in the dump.
;    F10 - dump only the currently ACTIVE window (use this if
;          the productivity dialog belongs to another process
;          or does not show up under F9).
;
;  It only READS. No messages are sent to PowerScribe, nothing
;  is clicked, nothing is injected. ControlGetText is a passive
;  WM_GETTEXT-class read, which is the same thing RadTempo
;  already does in ReadExamFromPS().
;
;  *** PHI WARNING ***
;  The Order Data pane and the report body contain patient name,
;  MRN, accession and DOB. The dump WILL contain them. It is
;  written to ps_probe_dump.txt next to this script and copied to
;  the clipboard. Read it before sending it anywhere. Best done on
;  a demo/test study if your system has one.
; ============================================================

#NoEnv
#SingleInstance Force
SetTitleMatchMode, 2
DetectHiddenText, On

global PS_EXE   := "ahk_exe Nuance.PowerScribe360.exe"
global OUT_FILE := A_ScriptDir . "\ps_probe_dump.txt"
global MAX_TEXT := 300

MsgBox, 48, PowerScribe probe (read-only)
    , % "This dumps the CONTROLS of PowerScribe's windows so we can see how the"
    . " productivity numbers are stored.`n`n"
    . "1. Open PowerScribe with a study loaded.`n"
    . "2. Open Dashboards -> My productivity, Time Frame = Today, click Refresh.`n"
    . "3. Press F9.`n`n"
    . "F10 dumps just the active window, if the dialog does not appear under F9.`n`n"
    . "PHI: the dump will contain patient name, MRN and accession. It is saved to`n"
    . OUT_FILE . "`nand copied to the clipboard. Review it before sharing it."
return

; ---- hotkeys live below the auto-execute return, per house rules ----

F9::
    DumpProcess()
return

F10::
    DumpActive()
return

DumpProcess() {
    global PS_EXE, OUT_FILE
    out := Header("ALL WINDOWS OF " . PS_EXE)
    WinGet, wins, List, %PS_EXE%
    if (wins = 0) {
        out .= "No window found for " . PS_EXE . "`n"
        out .= "Check the process name in Task Manager - it may differ by version.`n"
    }
    Loop, %wins%
    {
        hwnd := wins%A_Index%
        out .= DumpWindow(hwnd)
    }
    Finish(out)
}

DumpActive() {
    global OUT_FILE
    WinGet, hwnd, ID, A
    out := Header("ACTIVE WINDOW ONLY")
    out .= DumpWindow(hwnd)
    Finish(out)
}

DumpWindow(hwnd) {
    global MAX_TEXT
    WinGetTitle, wTitle, ahk_id %hwnd%
    WinGetClass, wClass, ahk_id %hwnd%
    WinGet, wExe, ProcessName, ahk_id %hwnd%
    WinGetPos, wx, wy, ww, wh, ahk_id %hwnd%

    s := "`n=== WINDOW " . hwnd . " ===`n"
    s .= "title : " . wTitle . "`n"
    s .= "class : " . wClass . "`n"
    s .= "exe   : " . wExe . "`n"
    s .= "pos   : " . wx . "," . wy . " " . ww . "x" . wh . "`n"

    WinGet, ctrls, ControlList, ahk_id %hwnd%
    if (ctrls = "") {
        s .= "controls: NONE`n"
        s .= "  ^ no child HWNDs. The window paints itself (WPF / DataGridView /`n"
        s .= "    Chromium). ControlGetText cannot reach it; accessibility can.`n"
        s .= AccSection(hwnd)
        return s
    }

    n := 0
    s .= "controls:`n"
    Loop, Parse, ctrls, `n
    {
        ctrl := A_LoopField
        if (ctrl = "")
            continue
        n++
        ControlGetPos, cx, cy, cw, ch, %ctrl%, ahk_id %hwnd%
        ControlGetText, txt, %ctrl%, ahk_id %hwnd%
        txt := Flatten(txt)
        if (StrLen(txt) > MAX_TEXT)
            txt := SubStr(txt, 1, MAX_TEXT) . " ...[cut]"
        s .= "  [" . ctrl . "]"
        s .= "  @" . cx . "," . cy . " " . cw . "x" . ch
        s .= (txt = "") ? "  <empty>" : "  = " . txt
        s .= "`n"
    }
    s .= "control count: " . n . "`n"
    s .= AccSection(hwnd)
    return s
}

; ---- MSAA ----------------------------------------------------
; The deciding question for the productivity grid: if ControlGetText
; comes back empty, does the accessibility layer see the numbers?
; Same reader the app uses, so what shows up here is what it will get.

AccSection(hwnd) {
    s := "accessibility (MSAA):`n"
    txt := ""
    cnt := 0
    try {
        acc := AccFromHwnd(hwnd)
        if (IsObject(acc))
            AccWalk(acc, txt, cnt, 0)
    }
    if (cnt = 0) {
        s .= "  NOTHING - MSAA exposed no text for this window`n"
        return s
    }
    Loop, Parse, txt, `n
    {
        t := Trim(A_LoopField)
        if (t = "")
            continue
        if (StrLen(t) > 120)
            t := SubStr(t, 1, 120) . " ...[cut]"
        s .= "  > " . t . "`n"
    }
    s .= "  (" . cnt . " strings)`n"
    return s
}

AccFromHwnd(hwnd) {
    static IID_ACC := "{618736E0-3C3D-11CF-810C-00AA00389B71}"
    VarSetCapacity(g, 16, 0)
    if (DllCall("ole32\CLSIDFromString", "wstr", IID_ACC, "ptr", &g) != 0)
        return ""
    pacc := 0
    if (DllCall("oleacc\AccessibleObjectFromWindow", "ptr", hwnd, "uint", 0xFFFFFFFC, "ptr", &g, "ptr*", pacc) != 0)
        return ""
    if (!pacc)
        return ""
    return ComObject(9, pacc, 1)
}

AccChildren(acc) {
    out := []
    try cc := acc.accChildCount
    catch e
        return out
    if (cc < 1)
        return out
    if (cc > 512)
        cc := 512
    vSize := A_PtrSize * 2 + 8      ; VARIANT: 16 bytes x86, 24 bytes x64
    VarSetCapacity(varr, cc * vSize, 0)
    got := 0
    if (DllCall("oleacc\AccessibleChildren", "ptr", ComObjValue(acc), "int", 0, "int", cc, "ptr", &varr, "int*", got) != 0)
        return out
    Loop, %got%
    {
        off := (A_Index - 1) * vSize
        vt := NumGet(varr, off, "ushort")
        if (vt = 9) {
            pd := NumGet(varr, off + 8, "ptr")
            if (pd)
                out.Push(ComObject(9, pd, 1))
        } else if (vt = 3) {
            out.Push(NumGet(varr, off + 8, "int"))
        }
    }
    return out
}

AccWalk(acc, ByRef out, ByRef cnt, depth) {
    if (depth > 12 || cnt > 3000)
        return
    nm := ""
    try nm := acc.accName(0)
    catch e
        nm := ""
    if (nm != "") {
        out .= nm . "`n"
        cnt++
    }
    vl := ""
    try vl := acc.accValue(0)
    catch e
        vl := ""
    if (vl != "" && vl != nm) {
        out .= vl . "`n"
        cnt++
    }
    kids := AccChildren(acc)
    kn := kids.MaxIndex()
    if (kn = "")
        return
    Loop, %kn% {
        k := kids[A_Index]
        if (IsObject(k)) {
            AccWalk(k, out, cnt, depth + 1)
        } else {
            nm2 := ""
            try nm2 := acc.accName(k)
            catch e
                nm2 := ""
            if (nm2 != "") {
                out .= nm2 . "`n"
                cnt++
            }
        }
    }
}

; One control per line: newlines and tabs would break the layout of the dump.
Flatten(t) {
    StringReplace, t, t, `r`n, %A_Space%|%A_Space%, All
    StringReplace, t, t, `n, %A_Space%|%A_Space%, All
    StringReplace, t, t, `r, %A_Space%|%A_Space%, All
    StringReplace, t, t, %A_Tab%, %A_Space%, All
    t := RegExReplace(t, "\s+", " ")
    return Trim(t)
}

Header(what) {
    FormatTime, stamp,, yyyy-MM-dd HH:mm:ss
    s := "ps_probe " . stamp . "`n"
    s .= what . "`n"
    s .= "AHK " . A_AhkVersion . (A_Is64bitOS ? "  (64-bit OS)" : "") . "`n"
    s .= "CONTAINS PHI - review before sharing`n"
    return s
}

Finish(out) {
    global OUT_FILE
    FileDelete, %OUT_FILE%
    FileAppend, %out%, %OUT_FILE%
    Clipboard := out
    lines := StrSplit(out, "`n").MaxIndex()
    MsgBox, 64, ps_probe
        , % "Captured " . lines . " lines.`n`nSaved to:`n" . OUT_FILE
        . "`n`nAlso on the clipboard.`n`nIt contains PHI - read it before sending it."
}
