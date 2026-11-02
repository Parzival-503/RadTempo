#!/usr/bin/env python3
"""
Static checks for helper/RadTempoHelper.ahk (AutoHotkey v1.1).

AutoHotkey cannot run in the cloud or on the Mac, and the helper runs during
dictation, so these catch at the desk-free stage what would otherwise ship:

  * every check of tools/ahk_check.py that applies (labels, timers, braces,
    forced expressions, % derefs, undeclared globals, assume-global rules,
    hotkeys truncating the auto-execute section);
  * F4 / F12 hotkeys must be pass-through (~): without it PowerScribe never
    sees the key - F4 is its microphone toggle and F12 its sign;
  * the helper only READS PowerScribe: no SendMessage / PostMessage /
    ControlSend / ControlClick / ControlSetText / Send at all;
  * no windows, message boxes, input boxes, tooltips or tray tips: anything
    that appears can take focus mid-dictation;
  * a top-level `global x := v` after the auto-execute section never runs;
  * Hotkey targets resolve; the file is pure ASCII.

Usage: python3 tools/helper_check.py [helper/RadTempoHelper.ahk]
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ahk_check as A  # noqa: E402

UI_RE = re.compile(r'^\s*(Gui\b|MsgBox\b|InputBox\b|ToolTip\b|TrayTip\b|SplashText|Progress\b)', re.IGNORECASE)
WRITE_RE = re.compile(r'\b(SendMessage|PostMessage|ControlSend|ControlSendRaw|ControlClick|ControlSetText|SendInput|SendEvent|SendPlay|SendRaw)\b|^\s*Send\b|"\s*(?:user32\\)?(?:Send|Post)Message', re.IGNORECASE)
KEY_RE = re.compile(r'^([~*$!^+#<>]*)(F4|F12)\s*::', re.IGNORECASE)


def check_passthrough(lines):
    bad = []
    for i, raw in enumerate(lines, 1):
        m = KEY_RE.match(raw.strip())
        if m and '~' not in m.group(1):
            bad.append((i, raw.strip()))
    return bad


def check_no_ui(lines):
    return [(i, raw.strip()[:80]) for i, raw in enumerate(lines, 1) if UI_RE.match(A.strip_line_comment(raw))]


def check_read_only(lines):
    return [(i, raw.strip()[:80]) for i, raw in enumerate(lines, 1) if WRITE_RE.search(A.strip_line_comment(raw))]


def check_late_global_init(lines):
    end = None
    for idx, raw in enumerate(lines):
        if raw.strip() == 'return' or A.HOTKEY_DEF_RE.match(raw):
            end = idx
            break
    if end is None:
        return []
    return [(i + 1, lines[i].strip()[:70]) for i in range(end + 1, len(lines)) if re.match(r'^global\s+[A-Za-z_]\w*\s*:=', lines[i])]


def check_hotkey_targets(lines, labels, funcs):
    out = []
    for i, raw in enumerate(lines, 1):
        m = re.match(r'^\s*(?:try\s+)?Hotkey\s*,\s*(.*)$', A.strip_line_comment(raw), re.IGNORECASE)
        if not m:
            continue
        parts = A.split_top_commas(m.group(1))
        if len(parts) < 2:
            continue
        t = parts[1].strip()
        if t and t.lower() not in ('on', 'off', 'toggle') and '%' not in t and t.lower() not in labels and t.lower() not in funcs:
            out.append((i, t))
    return out


def check_ascii(lines):
    return [(i, raw.strip()[:70]) for i, raw in enumerate(lines, 1) if any(ord(c) > 127 for c in raw)]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'helper', 'RadTempoHelper.ahk')
    lines = A.load(path)
    labels, dups, funcs = A.collect_labels_and_funcs(lines)
    ok = True
    print(f"[helper_check] {path}: {len(lines)} lines, {len(labels)} labels, {len(funcs)} functions")

    def rep(items, title, okmsg, fmt=lambda x: f"L{x[0]}: {x[1]}"):
        nonlocal ok
        if items:
            ok = False
            print(f"\n[FAIL] {title} ({len(items)}):")
            for it in items:
                print("  " + fmt(it))
        else:
            print(f"[ok] {okmsg}")

    rep(A.check_settimer(lines, labels, funcs), 'SetTimer targets that do not resolve', 'all SetTimer targets resolve', lambda x: f"L{x[0]}: {x[1]}")
    rep(A.check_menu(lines, labels, funcs), 'Menu handlers that do not resolve', 'all Menu handlers resolve', lambda x: f"L{x[0]}: {x[1]}")
    rep(A.check_percent_derefs(lines), '% in a command parameter that is not a deref', 'every % in command parameters is valid', lambda x: f"L{x[0]}: {x[1]} | {x[2]}")
    rep([(d[1], d[0]) for d in dups], 'duplicate labels', 'no duplicate labels')
    depth, detail = A.check_braces(lines)
    rep(detail if depth == 0 else detail + [(0, f'final depth {depth}', '')], 'brace imbalance', 'braces balanced', lambda x: f"L{x[0]}: {x[1]}")
    ug, mixed = A.check_undeclared_globals(lines)
    rep(ug, 'functions using a script global without declaring it', 'no undeclared globals in functions', lambda x: f"L{x[0]} {x[1]}(): {', '.join(x[2])}")
    rep(mixed, '`global X` inside an assume-global function', 'no global decls inside assume-global functions', lambda x: f"L{x[0]} {x[1]}(): {x[2]}")
    rep(A.check_autoexec_truncated(lines), 'a hotkey truncates the auto-execute section', 'auto-execute section not truncated', lambda x: f"L{x[0]}: {x[1]}")
    rep(A.check_forced_expr(lines), "forced-expression '%' not at the start of a parameter", 'no misplaced forced expressions')
    rep(check_late_global_init(lines), 'top-level `global x := v` after auto-execute (never runs)', 'globals are initialised at the top')
    rep(check_hotkey_targets(lines, labels, funcs), 'Hotkey targets that do not resolve', 'all Hotkey targets resolve')
    rep(check_passthrough(lines), 'F4/F12 hotkey without ~ (PowerScribe would never get the key)', 'F4 and F12 pass through to PowerScribe')
    rep(check_read_only(lines), 'the helper sends input or messages (it must only read)', 'read-only: no Send/PostMessage/ControlSend')
    rep(check_no_ui(lines), 'the helper shows UI (it runs during dictation)', 'no windows, message boxes or tooltips')
    rep(check_ascii(lines), 'non-ASCII characters', 'pure ASCII')
    print("\n" + ("PASS" if ok else "PROBLEMS FOUND"))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
