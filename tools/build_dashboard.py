#!/usr/bin/env python3
"""
Regenerate the dashboard emission block inside RadTempo.ahk from the
editable web sources in tools/dashboard/.

Why this exists: the dashboard is a ~700-line web app that AHK emits one
string literal at a time. Editing it *as* AHK string literals is how the
`\" vs ""` bug class and quote-mangling creep in. Instead the dashboard is
authored as ordinary tpl.html + app.js (which can be linted, run headlessly,
and screenshotted), and this script mechanically converts them into
`a(f, "...")` lines and splices them between the sentinels in the .ahk.

  tools/dashboard/tpl.html  - page shell; `<!--DATA-->` marks where the AHK
                              runtime data <script> blocks are injected, and
                              `/*JS*/` marks where app.js is injected.
  tools/dashboard/app.js    - the dashboard logic.

RadTempo.ahk remains the shipped artifact and the thing the checkers
validate; this script only rewrites the fenced region.

Safety properties:
  * `"` is escaped to `""` (AHK v1 expression rule) - never `\"`.
  * Non-ASCII is converted to JS \\uXXXX escapes (surrogate pairs for astral
    chars) so the .ahk stays pure ASCII and Unicode can't be mangled by the
    editor/Ahk2Exe encoding round-trip on Windows.
  * A literal backtick (AHK's escape char) is doubled.
  * Refuses to run if the sources contain a construct it can't safely encode.

Usage: python3 tools/build_dashboard.py [--check]
       --check verifies the .ahk block is up to date without writing.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TPL = os.path.join(HERE, 'dashboard', 'tpl.html')
APP = os.path.join(HERE, 'dashboard', 'app.js')
AHK = os.path.join(ROOT, 'RadTempo.ahk')

BEGIN = '    ; ==== BEGIN generated dashboard (tools/build_dashboard.py) ===='
END = '    ; ==== END generated dashboard ===='

# Fixed AHK that injects the runtime data blocks. Emitted verbatim in the
# middle of the page, where tpl.html has its <!--DATA--> marker.
DATA_BLOCK = r'''    ; --- runtime data blocks (written with FileOpen to dodge %-expansion) ---
    fObj := FileOpen(f, "a", "UTF-8-RAW")
    fObj.Write("<script>const CSV_RAW='")
    fObj.Write(csvEsc)
    fObj.Write("';</script>" . "`n")
    shNow := todayShift
    StringReplace, shNow, shNow, \, \\, All
    StringReplace, shNow, shNow, ', \', All
    fObj.Write("<script>const TODAY_SHIFT='")
    fObj.Write(shNow)
    fObj.Write("';</script>" . "`n")
    shJson := "{"
    shFirst := true
    for sk, sv in shiftByDate {
        v := sv
        StringReplace, v, v, \, \\, All
        StringReplace, v, v, ", \", All
        if (!shFirst)
            shJson .= ","
        shJson .= """" . sk . """:""" . v . """"
        shFirst := false
    }
    shJson .= "}"
    fObj.Write("<script>const SHIFTS=")
    fObj.Write(shJson)
    fObj.Write(";</script>" . "`n")
    clsJson := "{mod:" . CsvToJsonArr(CLS_MOD_KEYS)
    clsJson .= ",off:" . CsvToJsonArr(CLS_OFF_KEYS)
    clsJson .= ",noise:" . CsvToJsonArr(CLS_NOISE_KEYS)
    onsiteEsc := StrReplace(CLS_ONSITE_RE, "\", "\\")
    clsJson .= ",onsite:""" . onsiteEsc . """"
    clsJson .= ",am:[" . WIN_AM_S . "," . WIN_AM_E . "],pm:[" . WIN_PM_S . "," . WIN_PM_E . "]}"
    fObj.Write("<script>const CLS=")
    fObj.Write(clsJson)
    fObj.Write(";</script>" . "`n")
    gv := (forecastGoal != "" && forecastGoal + 0 > 0) ? forecastGoal + 0 : 0
    fObj.Write("<script>const DAILY_GOAL=" . gv . ";</script>" . "`n")
    adjJson := "{"
    adjFirst := true
    for ak, av in adjByDate {
        if (Abs(av) < 0.001)
            continue
        if (!adjFirst)
            adjJson .= ","
        adjJson .= """" . ak . """:" . Format("{:.4f}", av)
        adjFirst := false
    }
    adjJson .= "}"
    fObj.Write("<script>const IVU_ADJ=")
    fObj.Write(adjJson)
    fObj.Write(";</script>" . "`n")
    fObj.Write("<script>const HOURLY_RATE=" . HOURLY_RATE . ";</script>" . "`n")
    goalJson := "{"
    goalFirst := true
    for gk, gv in goalByDate {
        if (!goalFirst)
            goalJson .= ","
        goalJson .= """" . gk . """:" . gv
        goalFirst := false
    }
    goalJson .= "}"
    fObj.Write("<script>const GOALS=")
    fObj.Write(goalJson)
    fObj.Write(";</script>" . "`n")
    fillN := FILLER_NAME
    StringReplace, fillN, fillN, \, \\, All
    StringReplace, fillN, fillN, ", \", All
    fillR := FILLER_MATCH
    StringReplace, fillR, fillR, \, \\, All
    StringReplace, fillR, fillR, ", \", All
    fObj.Write("<script>const FILLER={n:""" . fillN . """,re:""" . fillR . """,ivu:")
    fObj.Write(Format("{:.4f}", FillerIVU()) . "};</script>" . "`n")
    fObj.Write("<script>const LADDER={b:" . Format("{:.4f}", GOAL_BASE))
    fObj.Write(",s:" . Format("{:.4f}", GOAL_STEP) . "};</script>" . "`n")
    rw := "{on:" . (REWARD_ENABLED ? "1" : "0")
    rw .= ",per:" . Format("{:.4f}", REWARD_PER_POINT)
    rw .= ",rung:" . Format("{:.4f}", REWARD_RUNG_PTS)
    rw .= ",every:" . REWARD_STREAK_EVERY
    rw .= ",bonus:" . Format("{:.4f}", REWARD_STREAK_BONUS)
    rw .= ",cap:" . Format("{:.4f}", REWARD_WEEK_CAP)
    rwStart := REWARD_START
    if (StrLen(rwStart) = 8)
        rwStart := SubStr(rwStart, 1, 4) . "-" . SubStr(rwStart, 5, 2) . "-" . SubStr(rwStart, 7, 2)
    rw .= ",start:""" . rwStart . """}"
    fObj.Write("<script>const REWARD=" . rw . ";</script>" . "`n")
    coJson := "["
    coFirst := true
    if FileExist(REWARD_FILE) {
        FileRead, coData, %REWARD_FILE%
        Loop, Parse, coData, `n, `r
        {
            if (A_Index = 1 || A_LoopField = "")
                continue
            cp := StrSplit(A_LoopField, ",")
            if (cp.MaxIndex() < 2)
                continue
            cnote := (cp.MaxIndex() >= 3) ? Trim(cp[3]) : ""
            StringReplace, cnote, cnote, \, \\, All
            StringReplace, cnote, cnote, ", \", All
            if (!coFirst)
                coJson .= ","
            coJson .= "{d:""" . Trim(cp[1]) . """,a:" . (Trim(cp[2]) + 0.0)
                    . ",n:""" . cnote . """}"
            coFirst := false
        }
    }
    coJson .= "]"
    fObj.Write("<script>const CASHOUTS=" . coJson . ";</script>" . "`n")
    fObj.Close()
'''


def js_escape_nonascii(s):
    """Replace every non-ASCII char with a JS \\uXXXX escape (surrogate pair
    when astral). Valid only inside JS/CSS/HTML string contexts, which is
    where all of ours live - verified by check_nonascii_context()."""
    out = []
    for ch in s:
        o = ord(ch)
        if o < 128:
            out.append(ch)
        elif o <= 0xFFFF:
            out.append('\\u%04X' % o)
        else:
            v = o - 0x10000
            out.append('\\u%04X\\u%04X' % (0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF)))
    return ''.join(out)


def check_nonascii_context(src, name):
    """Every non-ASCII char must sit inside a quoted JS string, otherwise a
    \\uXXXX escape would be a syntax error rather than the same character."""
    bad = []
    for lineno, line in enumerate(src.split('\n'), 1):
        if all(ord(c) < 128 for c in line):
            continue
        in_s = False
        q = ''
        i = 0
        while i < len(line):
            c = line[i]
            if in_s:
                if c == '\\':
                    i += 2
                    continue
                if c == q:
                    in_s = False
            elif c in '"\'':
                in_s = True
                q = c
            elif ord(c) > 127:
                bad.append((lineno, c, line.strip()[:70]))
            i += 1
    if bad:
        print('[build_dashboard] non-ASCII outside a string literal in %s:' % name)
        for ln, c, ctx in bad:
            print('  L%d: %r  |  %s' % (ln, c, ctx))
        sys.exit(1)


def ahk_line(text):
    """One AHK a(f, "...") emission line."""
    t = text.replace('`', '``')      # AHK escape char must be doubled
    t = t.replace('"', '""')          # AHK v1 expression string escape
    return '    a(f, "%s")' % t


def build_lines():
    with open(TPL, encoding='utf-8') as fh:
        tpl = fh.read()
    with open(APP, encoding='utf-8') as fh:
        app = fh.read()

    if '<!--DATA-->' not in tpl or '/*JS*/' not in tpl:
        print('[build_dashboard] tpl.html missing <!--DATA--> or /*JS*/ marker')
        sys.exit(1)
    check_nonascii_context(app, 'app.js')

    head, rest = tpl.split('<!--DATA-->', 1)
    mid, tail = rest.split('/*JS*/', 1)

    out = [BEGIN]
    for ln in head.rstrip('\n').split('\n'):
        out.append(ahk_line(ln))
    out.append(DATA_BLOCK.rstrip('\n'))
    for ln in mid.strip('\n').split('\n'):
        out.append(ahk_line(ln))
    for ln in js_escape_nonascii(app).strip('\n').split('\n'):
        out.append(ahk_line(ln))
    for ln in tail.strip('\n').split('\n'):
        out.append(ahk_line(ln))
    out.append(END)
    return '\n'.join(out)


def main():
    check = '--check' in sys.argv
    block = build_lines()
    with open(AHK, encoding='utf-8') as fh:
        src = fh.read()
    if BEGIN not in src or END not in src:
        print('[build_dashboard] sentinels not found in RadTempo.ahk')
        sys.exit(1)
    pre = src.split(BEGIN)[0]
    post = src.split(END, 1)[1]
    new = pre + block + post
    if new == src:
        print('[build_dashboard] up to date (%d emission lines)' % block.count('\n    a(f,'))
        return
    if check:
        print('[build_dashboard] OUT OF DATE - run: python3 tools/build_dashboard.py')
        sys.exit(1)
    with open(AHK, 'w', encoding='utf-8') as fh:
        fh.write(new)
    n = block.count('\n    a(f,')
    print('[build_dashboard] wrote %d emission lines into RadTempo.ahk' % n)
    if any(ord(c) > 127 for c in block):
        print('[build_dashboard] WARNING: generated block still contains non-ASCII')


if __name__ == '__main__':
    main()
