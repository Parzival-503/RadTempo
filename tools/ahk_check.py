#!/usr/bin/env python3
"""
Static structural checker for RadTempo.ahk (AutoHotkey v1.1).

Catches the classes of bugs that bite this project before it ever reaches
Ahk2Exe / a live Windows run:

  1. Every `SetTimer, Target[, ...]` target resolves to a label or function.
  2. Every `Menu, ..., Add, Name, gLabel` handler resolves to a label or function,
     and every `:SubMenu` reference names a menu built EARLIER in the file.
  3. No duplicate labels.
  4. Brace balance (open == close), ignoring braces inside strings/comments.
  5. Quote-escaping inside a(f, "...") / <obj>.Write("...") string literals:
     AHK v1.1 expressions escape a literal double-quote as "" (doubled),
     NOT \" (backslash). A stray \" silently terminates the string early.

Exit code 0 = clean, 1 = problems found.

Usage: python3 tools/ahk_check.py [path/to/RadTempo.ahk]
"""
import re
import sys

def load(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read().splitlines()

# ---- Line classification helpers ------------------------------------------

def strip_line_comment(line):
    """Remove a trailing ` ; comment` and full-line `; comment`.
    Honors the AHK rule that a `;` only starts a comment at start-of-line or
    when preceded by whitespace, and not inside a string. This is a heuristic
    good enough for structural checking."""
    in_str = False
    i = 0
    n = len(line)
    out = []
    while i < n:
        c = line[i]
        if c == '"':
            # doubled quote inside string => literal, consume both
            if in_str and i + 1 < n and line[i + 1] == '"':
                out.append('""')
                i += 2
                continue
            in_str = not in_str
            out.append(c)
            i += 1
            continue
        if c == ';' and not in_str:
            prev = line[i - 1] if i > 0 else ' '
            if i == 0 or prev in ' \t':
                break
        out.append(c)
        i += 1
    return ''.join(out)

# ---- Label / function collection ------------------------------------------

LABEL_RE = re.compile(r'^\s*([A-Za-z0-9_@#$?\[\]]+):\s*$')
FUNC_RE = re.compile(r'^\s*([A-Za-z0-9_]+)\s*\(')

def collect_labels_and_funcs(lines):
    labels = {}          # name(lower) -> line number
    dup_labels = []
    funcs = set()
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        code = strip_line_comment(raw)
        m = LABEL_RE.match(code)
        if m:
            name = m.group(1)
            # exclude things that look like hotkeys (contain modifiers) — still a label though
            key = name.lower()
            if key in labels:
                dup_labels.append((name, labels[key], idx))
            else:
                labels[key] = idx
            continue
        mf = FUNC_RE.match(code)
        if mf:
            # crude: a function definition line usually ends with `{` or the
            # next non-empty line is `{`. Accept as a candidate function name.
            funcs.add(mf.group(1).lower())
    return labels, dup_labels, funcs

# AHK built-in Menu handler / timer specials that are not user labels
TIMER_SPECIALS = {'on', 'off', 'delete'}

def check_settimer(lines, labels, funcs):
    problems = []
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        code = strip_line_comment(raw)
        m = re.match(r'^\s*SetTimer\s*,?\s*([^,]+)', code, re.IGNORECASE)
        if not m:
            continue
        target = m.group(1).strip()
        if not target or target.lower() in TIMER_SPECIALS:
            continue
        # dynamic target (contains %var% or expression) — skip, can't resolve
        if '%' in target or target.startswith('"'):
            continue
        key = target.lower()
        if key not in labels and key not in funcs:
            problems.append((idx, target, raw.strip()))
    return problems

def check_menu(lines, labels, funcs):
    problems = []
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        code = strip_line_comment(raw)
        # Menu, MenuName, Add, ItemName, LabelOrFunc [, options]
        m = re.match(r'^\s*Menu\s*,\s*[^,]+,\s*Add\s*,\s*(.*)$', code, re.IGNORECASE)
        if not m:
            continue
        rest = m.group(1)
        # rest = ItemName, Handler [, ...] ; ItemName may contain nothing tricky
        parts = split_top_commas(rest)
        if len(parts) < 2:
            continue  # separator line (Menu, X, Add) with no handler
        handler = parts[1].strip()
        if not handler or handler == '':
            continue
        if '%' in handler or handler.startswith('"'):
            continue
        # submenu references (:SubMenuName) are valid
        if handler.startswith(':'):
            continue
        key = handler.lower()
        if key not in labels and key not in funcs:
            problems.append((idx, handler, raw.strip()))
    return problems

def check_submenus(lines):
    """`Menu, Parent, Add, Text, :Sub` needs Sub to ALREADY exist, so the
    referenced menu must have been built by an earlier `Menu, Sub, Add ...`.
    A typo, or a submenu attached before it is populated, is a load-time
    "Menu does not exist" - which the handler check waves through because a
    `:Name` target is not a label."""
    problems = []
    created = set()
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        code = strip_line_comment(raw)
        m = re.match(r'^\s*Menu\s*,\s*([^,]+),\s*Add\s*,?\s*(.*)$', code, re.IGNORECASE)
        if not m:
            continue
        parent = m.group(1).strip().lower()
        parts = split_top_commas(m.group(2))
        handler = parts[1].strip() if len(parts) >= 2 else ''
        if handler.startswith(':'):
            sub = handler[1:].strip().lower()
            # A submenu built inside a loop/function still shows up as a
            # `Menu, Sub, Add` line, so ordering is all that is checked.
            if sub and '%' not in sub and sub not in created:
                problems.append((idx, handler, raw.strip()))
        created.add(parent)
    return problems


def split_top_commas(s):
    """Split on commas not preceded by an escape backtick and not inside quotes."""
    out = []
    cur = []
    in_str = False
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == '"':
            in_str = not in_str
            cur.append(c)
        elif c == '`' and i + 1 < n:
            cur.append(c); cur.append(s[i+1]); i += 2; continue
        elif c == ',' and not in_str:
            out.append(''.join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    out.append(''.join(cur))
    return out

def check_braces(lines):
    depth = 0
    in_block_comment = False
    detail = []
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        code = strip_line_comment(raw)
        # walk chars honoring strings (with "" escaping)
        in_str = False
        i = 0
        n = len(code)
        while i < n:
            c = code[i]
            if c == '"':
                if in_str and i + 1 < n and code[i+1] == '"':
                    i += 2; continue
                in_str = not in_str
            elif not in_str and c == '`' and i + 1 < n:
                i += 2; continue
            elif not in_str and c == '{':
                depth += 1
            elif not in_str and c == '}':
                depth -= 1
                if depth < 0:
                    detail.append((idx, 'unbalanced } (depth<0)', raw.strip()))
                    depth = 0
            i += 1
    return depth, detail

def check_quote_escaping(lines):
    """Find a(f, "...") and <obj>.Write("...") calls whose string literal
    contains a backslash-escaped quote \" which is invalid in AHK expressions.
    We walk the string honoring "" doubling; a lone backslash immediately
    followed by a quote that terminates the string is the smell."""
    problems = []
    call_re = re.compile(r'\b(?:a\s*\(\s*f\s*,|\w+\.Write\s*\()', re.IGNORECASE)
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        if not call_re.search(raw):
            continue
        # find first opening quote after the call
        code = raw
        for mm in call_re.finditer(code):
            start = code.find('"', mm.end())
            if start == -1:
                continue
            i = start + 1
            n = len(code)
            while i < n:
                c = code[i]
                if c == '"':
                    if i + 1 < n and code[i+1] == '"':
                        i += 2; continue
                    break  # string end
                if c == '\\' and i + 1 < n and code[i+1] == '"':
                    # backslash directly before a quote inside AHK string literal
                    problems.append((idx, raw.strip()))
                    break
                i += 1
    return problems

FORCED_EXPR_RE = re.compile(r'[A-Za-z0-9_]+:%\s')

def check_forced_expr(lines):
    """AHK v1: a forced-expression parameter must START with '% '.

    Writing `GuiControl, Main:% "+c" . x, Ctl` puts the Gui-name prefix before
    the percent, so AHK parses it in literal mode and dies with
    "This parameter contains a variable name missing its ending percent sign"
    -- at load time, i.e. only on Windows. Cheap to catch here.

    Matches the exact signature (identifier, colon, percent, space); a normal
    %var% deref never looks like this, so false positives are essentially nil.
    """
    problems = []
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        if stripped.startswith(';'):
            continue
        code = strip_line_comment(raw)
        if FORCED_EXPR_RE.search(code):
            problems.append((idx, raw.strip()))
    return problems

# First words that make a line an expression / declaration, not a command.
NON_COMMAND_WORDS = {'if', 'while', 'return', 'global', 'static', 'local',
                     'else', 'for', 'until', 'try', 'catch', 'finally',
                     'throw', 'class', 'new'}
COMMAND_LINE_RE = re.compile(r'^\s*([A-Za-z][A-Za-z0-9]*)(\s*,|\s+)(.*)$')
COMPOUND_ASSIGN_RE = re.compile(r'^\s*[A-Za-z_#@$][A-Za-z0-9_#@$]*\s*(\.|\+|-|\*|//|/|\||&|\^|<<|>>)=')
DEREF_NAME_RE = re.compile(r'^[A-Za-z_#@$][A-Za-z0-9_#@$]*$')

def check_percent_derefs(lines):
    """AHK v1 command parameters treat every unescaped % as a variable deref.

    So a URL like `Run, chrome.exe "https://x/?id=%7Babc%7D"` is read as the
    variable `7Babc`, and the script refuses to load with "The following
    variable name contains an illegal character". A literal percent in a
    command parameter must be written `%. (Rad_Optimizer_merged.ahk shipped
    this way: a OneDrive link in OpenChromeTabs().)

    Only command-syntax lines are checked; expressions (`:=`, if/return, a
    forced-expression `% ` parameter) treat % inside quotes as literal.
    """
    problems = []
    in_block_comment = False
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith('/*'):
            in_block_comment = True
        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue
        if stripped.startswith(';'):
            continue
        code = strip_line_comment(raw)
        m = COMMAND_LINE_RE.match(code)
        if not m or m.group(1).lower() in NON_COMMAND_WORDS:
            continue
        if ':=' in code or code.rstrip().endswith('{') and '(' in code:
            continue
        # Compound assignment (x .= ..., x += ...) is an expression too.
        if COMPOUND_ASSIGN_RE.match(code):
            continue
        # A `Name(` right after the first word is a function call, not a command.
        if m.group(2).strip() == '' and m.group(3).lstrip().startswith('('):
            continue
        for param in m.group(3).split(','):
            if param.lstrip().startswith('% ') or param.strip() == '%':
                continue  # forced expression: % in quotes is literal
            body = param.replace('`%', '')
            parts = body.split('%')
            if len(parts) % 2 == 0:
                problems.append((idx, 'odd number of % signs', raw.strip()))
                break
            bad = [p for p in parts[1::2] if not DEREF_NAME_RE.match(p)]
            if bad:
                problems.append((idx, f"'%{bad[0]}%' is not a variable name "
                                      "(write a literal percent as `%)",
                                 raw.strip()))
                break
    return problems

IDENT_RE = re.compile(r'\b[A-Za-z_][A-Za-z0-9_]*\b')

def check_undeclared_globals(lines):
    """AHK v1 functions treat any undeclared variable as LOCAL.

    So a function that reads a script global without a matching `global` line
    silently sees an empty string -- no error, just wrong behaviour at runtime.
    (Real example this caught: UpdateActivityUI() using GUI_H without
    declaring it, which placed the accent bar 3px above the widget instead of
    at its bottom edge.)

    Only script-level `global NAME := ...` names are considered, and functions
    using bare `global` (assume-global mode) are skipped.
    """
    globals_ = set()
    for raw in lines:
        m = re.match(r'^\s*global\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=', raw)
        if m:
            globals_.add(m.group(1))

    problems = []
    mixed = []
    i = 0
    n = len(lines)
    while i < n:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$', lines[i])
        if not m:
            i += 1
            continue
        fname, params = m.group(1), m.group(2)
        # collect the body by brace depth
        depth = 1
        body = []
        j = i + 1
        while j < n and depth > 0:
            code = strip_line_comment(lines[j])
            depth += code.count('{') - code.count('}')
            if depth > 0:
                body.append(lines[j])
            j += 1
        declared = set()
        for p in params.split(','):
            p = p.strip().split(':=')[0].strip().lstrip('&')
            if p:
                declared.add(p)
        assume_global = False
        explicit_global_lines = []
        for b in body:
            # strip the comment first: `global  ; assume-global mode` is still
            # bare global, and missing that produced false positives
            s = strip_line_comment(b).strip()
            if re.match(r'^global\s*$', s):
                assume_global = True
            gm = re.match(r'^global\s+(.+)$', strip_line_comment(b).strip())
            if gm and ':=' not in gm.group(1):
                explicit_global_lines.append(strip_line_comment(b).strip())
                for nm in gm.group(1).split(','):
                    declared.add(nm.strip())
        if assume_global and explicit_global_lines:
            mixed.append((i + 1, fname, explicit_global_lines))
        if not assume_global:
            used = set()
            for b in body:
                code = strip_line_comment(b)
                if re.match(r'^\s*global\b', code):
                    continue
                # crude string strip so quoted text doesn't create identifiers
                code = re.sub(r'"(?:[^"]|"")*"', '""', code)
                used.update(IDENT_RE.findall(code))
            missing = sorted((used & globals_) - declared)
            if missing:
                problems.append((i + 1, fname, missing))
        i = j
    return problems, mixed

GUI_VNAME_RE = re.compile(r'^\s*Gui\s*,[^,]*Add\s*,[^,]*,\s*(.*)$', re.IGNORECASE)


def check_gui_control_vars(lines):
    """`Gui, Add, <Type>, v<Name> ...` inside a function is a LOAD-TIME error
    unless <Name> resolves to a global or static variable:

        Error:  A control's variable must be global or static.
        Specifically: vWellAccent

    A function that adds controls therefore has to be assume-global (a bare
    `global`), which is what BuildGUI() does. BuildWellnessCard() declared
    specific globals instead - enough for the theme constants it read, but the
    v-names were still function-locals, so the card built empty and every entry
    point into it died. This shipped.

    Controls added at script level (labels, the auto-execute section) are fine
    and are not scanned.
    """
    problems = []
    i, n = 0, len(lines)
    while i < n:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*$', lines[i])
        if not m:
            i += 1
            continue
        fname = m.group(1)
        depth, body, j = 1, [], i + 1
        while j < n and depth > 0:
            code = strip_line_comment(lines[j])
            depth += code.count('{') - code.count('}')
            if depth > 0:
                body.append((j + 1, lines[j]))
            j += 1
        assume_global = False
        declared = set()
        for _, b in body:
            s = strip_line_comment(b).strip()
            if re.match(r'^global\s*$', s):
                assume_global = True
            gm = re.match(r'^(?:global|static)\s+(.+)$', s)
            if gm:
                for nm in gm.group(1).split(','):
                    declared.add(nm.split(':=')[0].strip())
        if not assume_global:
            for ln, b in body:
                gm = GUI_VNAME_RE.match(strip_line_comment(b))
                if not gm:
                    continue
                vm = re.search(r'\bv([A-Za-z_][A-Za-z0-9_]*)', gm.group(1))
                if vm and vm.group(1) not in declared:
                    problems.append((ln, fname, 'v' + vm.group(1), b.strip()[:70]))
        i = j
    return problems


HOTKEY_DEF_RE = re.compile(r'^(?:#If\b|#IfWin\w*\b|[^\s;][^\n]*::)')

def check_autoexec_truncated(lines):
    """AHK v1's auto-execute section ends at the FIRST hotkey/hotstring
    definition, not at the first `return`.

    So a hotkey placed above the startup code silently kills everything after
    it: the script loads and the hotkeys work, but BuildGUI() never runs and no
    window ever appears. (This exact mistake shipped once - the par wheel
    hotkeys were inserted above BuildGUI().)

    Flags a top-level hotkey/#If that appears before the auto-execute `return`
    while executable startup code still follows it.
    """
    autoexec_end = None
    for idx, raw in enumerate(lines):
        if raw == 'return':
            autoexec_end = idx
            break
    if autoexec_end is None:
        return []

    first_hk = None
    for idx in range(autoexec_end):
        raw = lines[idx]
        if not raw.strip() or raw.lstrip().startswith(';'):
            continue
        if HOTKEY_DEF_RE.match(raw):
            first_hk = idx
            break
    if first_hk is None:
        return []

    stranded = []
    for idx in range(first_hk + 1, autoexec_end):
        raw = lines[idx]
        st = raw.strip()
        if not st or st.startswith(';') or st.startswith('#If') or '::' in st:
            continue
        stranded.append((idx + 1, st[:70]))
    if not stranded:
        return []
    return [(first_hk + 1, lines[first_hk].strip()[:60], stranded)]

def _join_continuations(lines, idx):
    """Return (text, next_idx) for the statement starting at idx, joining AHK
    v1 continuation lines - a line whose successor begins with an operator or
    a comma is one statement."""
    text = lines[idx]
    j = idx + 1
    while j < len(lines):
        nxt = lines[j].lstrip()
        if not nxt or nxt.startswith(';'):
            break
        if nxt[0] in ',.' or nxt[:2] in ('&&', '||') or nxt[:3].lower() in ('and', 'or '):
            text += ' ' + nxt
            j += 1
            continue
        break
    return text, j


def _split_params(text):
    """Split an AHK command line into its comma-separated parameters, ignoring
    commas inside quotes, parentheses/brackets and %derefs% are irrelevant
    here because we only care about positions."""
    out, buf, depth, instr = [], '', 0, False
    i = 0
    while i < len(text):
        c = text[i]
        if instr:
            if c == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    buf += '""'
                    i += 2
                    continue
                instr = False
            buf += c
        elif c == '"':
            instr = True
            buf += c
        elif c in '([{':
            depth += 1
            buf += c
        elif c in ')]}':
            depth -= 1
            buf += c
        elif c == ',' and depth == 0:
            out.append(buf.strip())
            buf = ''
        else:
            buf += c
        i += 1
    out.append(buf.strip())
    return out


def check_inputbox_timeout(lines):
    """InputBox's parameters are
    OutputVar, Title, Prompt, Hide, Width, Height, X, Y, Locale, Timeout, Default

    Miss one comma before the default value and it lands in Timeout instead:
    the box then closes itself after that many seconds, which for a default of
    "1" looks exactly like the dialog refusing to open. Nothing about it is a
    syntax error, and it only shows up at runtime on Windows.

    A real Timeout is always a small literal number. Anything else there - a
    %variable%, an expression, a decimal - is this bug.
    """
    bad = []
    idx = 0
    while idx < len(lines):
        raw = lines[idx]
        if not re.match(r'^\s*InputBox\s*[,\s]', raw, re.I):
            idx += 1
            continue
        text, nxt = _join_continuations(lines, idx)
        params = _split_params(re.sub(r'^\s*InputBox\s*,?', '', text, flags=re.I))
        if len(params) >= 10:
            timeout = params[9]
            if timeout and not re.fullmatch(r'\d{1,4}', timeout):
                bad.append((idx + 1, timeout[:30], text.strip()[:70]))
        idx = max(nxt, idx + 1)
    return bad


def check_log_header_sync(lines):
    """The CSV header is written from more than one place (the normal path and
    the fallback after a failed write to a read-only folder). If those drift,
    a log created down the fallback path gets a header that does not match the
    rows every other path writes - silent, and only visible much later when a
    column is read by index.

    Every literal that starts with the log's first column must be identical.
    """
    per_file = {}
    for idx, raw in enumerate(lines):
        m = re.search(r'FileAppend,\s*(Timestamp`,[^\n]*?)\s*,\s*%(\w+)%', raw)
        if m:
            # Grouped by TARGET FILE: two different CSVs are supposed to have
            # different headers. Only one file with two headers is a bug.
            per_file.setdefault(m.group(2), {}).setdefault(
                m.group(1).strip(), []).append(idx + 1)
    bad = []
    for target, headers in per_file.items():
        if len(headers) > 1:
            for hdr, lns in headers.items():
                bad.append((target, hdr[:70], lns))
    return bad


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'RadTempo.ahk'
    lines = load(path)
    labels, dup_labels, funcs = collect_labels_and_funcs(lines)

    ok = True
    print(f"[ahk_check] {path}: {len(lines)} lines, "
          f"{len(labels)} labels, {len(funcs)} function candidates")

    st = check_settimer(lines, labels, funcs)
    if st:
        ok = False
        print(f"\n[FAIL] SetTimer targets with no matching label/function ({len(st)}):")
        for ln, tgt, src in st:
            print(f"  L{ln}: target '{tgt}'  |  {src}")
    else:
        print("[ok] all SetTimer targets resolve")

    mn = check_menu(lines, labels, funcs)
    if mn:
        ok = False
        print(f"\n[FAIL] Menu Add handlers with no matching label/function ({len(mn)}):")
        for ln, h, src in mn:
            print(f"  L{ln}: handler '{h}'  |  {src}")
    else:
        print("[ok] all Menu Add handlers resolve")

    pd = check_percent_derefs(lines)
    if pd:
        ok = False
        print(f"\n[FAIL] % in a command parameter that is not a %var% deref ({len(pd)}):")
        for ln, msg, src in pd:
            print(f"  L{ln}: {msg}  |  {src}")
    else:
        print("[ok] every % in command parameters is a valid %var% or escaped")

    sm = check_submenus(lines)
    if sm:
        ok = False
        print(f"\n[FAIL] submenu attached before it exists ({len(sm)}):")
        for ln, h, src in sm:
            print(f"  L{ln}: '{h}' has no earlier `Menu, ..., Add`  |  {src}")
    else:
        print("[ok] all submenu references exist before use")

    gv = check_gui_control_vars(lines)
    if gv:
        ok = False
        print(f"\n[FAIL] Gui control v-names not global/static ({len(gv)}):")
        for ln, fn, v, src in gv:
            print(f"  L{ln}: {v} in {fn}() - needs a bare `global`  |  {src}")
    else:
        print("[ok] all Gui control v-names are global or static")

    if dup_labels:
        ok = False
        print(f"\n[FAIL] duplicate labels ({len(dup_labels)}):")
        for name, first, second in dup_labels:
            print(f"  '{name}' at L{first} and L{second}")
    else:
        print("[ok] no duplicate labels")

    depth, detail = check_braces(lines)
    if depth != 0 or detail:
        ok = False
        print(f"\n[FAIL] brace imbalance: final depth {depth}")
        for ln, msg, src in detail[:20]:
            print(f"  L{ln}: {msg}  |  {src}")
    else:
        print("[ok] braces balanced")

    ug, mixedg = check_undeclared_globals(lines)
    if ug:
        print(f"\n[warn] functions using a script global without declaring it ({len(ug)}):")
        for ln, fn, names in ug:
            print(f"  L{ln} {fn}(): {', '.join(names)}")
        print("  (AHK v1 treats these as empty LOCALS - silent wrong behaviour)")
    else:
        print("[ok] no undeclared global usage in functions")

    if mixedg:
        ok = False
        print(f"\n[FAIL] `global X` declared inside an assume-global function ({len(mixedg)}):")
        for ln, fn, decls in mixedg:
            print(f"  {fn}() at L{ln}: {decls}")
        print("  AHK v1: a function with a bare `global` cannot also declare"
              " specific globals -> load-time error")
    else:
        print("[ok] no global decls inside assume-global functions")

    ax = check_autoexec_truncated(lines)
    if ax:
        ok = False
        for ln, hk, stranded in ax:
            print(f"\n[FAIL] hotkey at L{ln} truncates the auto-execute section: {hk}")
            print(f"  {len(stranded)} startup line(s) after it never run, e.g.:")
            for sl, txt in stranded[:6]:
                print(f"    L{sl}: {txt}")
            print("  fix: move hotkey/#If definitions BELOW the auto-execute `return`")
    else:
        print("[ok] auto-execute section not truncated by a hotkey")

    fe = check_forced_expr(lines)
    if fe:
        ok = False
        print(f"\n[FAIL] forced-expression '%' not at start of parameter ({len(fe)}):")
        for ln, src in fe:
            print(f"  L{ln}: {src}")
        print("  fix: build the whole option into a variable first, then"
              " `GuiControl, % opt, Ctl`")
    else:
        print("[ok] no misplaced forced-expression parameters")

    qe = check_quote_escaping(lines)
    if qe:
        ok = False
        print(f"\n[FAIL] backslash-escaped quotes in a()/Write() strings ({len(qe)}):")
        for ln, src in qe:
            print(f"  L{ln}: {src}")
    else:
        print("[ok] no backslash-escaped quotes in a()/Write() strings")

    ib = check_inputbox_timeout(lines)
    if ib:
        ok = False
        print(f"\n[FAIL] InputBox default value landed in the Timeout slot ({len(ib)}):")
        for ln, tmo, src in ib:
            print(f"  L{ln}: Timeout = '{tmo}'  |  {src}")
        print("  fix: params are OutputVar, Title, Prompt, Hide, W, H, X, Y,"
              " Locale, Timeout, Default - count the commas")
    else:
        print("[ok] no InputBox default in the Timeout slot")

    lh = check_log_header_sync(lines)
    if lh:
        ok = False
        print(f"\n[FAIL] CSV log headers disagree ({len(lh)} distinct):")
        for target, hdr, lns in lh:
            print(f"  {target} L{','.join(str(x) for x in lns)}: {hdr}")
        print("  fix: every log-header FileAppend must write the same columns")
    else:
        print("[ok] CSV log headers agree")

    print("\n" + ("PASS" if ok else "PROBLEMS FOUND"))
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
