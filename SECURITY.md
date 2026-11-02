# What RadTempo does on a PC

A plain account for IT and security reviewers. Every statement below can be
checked against the source in this repository; the file that does it is named.

## What is installed

| Part | What it is |
|---|---|
| `RadTempo.exe` | The app (Electron). Draws the timer, menus and dashboard, keeps the history. Source: `src/` |
| `resources\helper\RadTempoHelper.exe` | A small helper compiled from `helper/RadTempoHelper.ahk` (AutoHotkey v1.1). Only the compiled helper ships, never a loose script |

- **Setup** installs for the current Windows user only, in
  `%LOCALAPPDATA%\Programs\RadTempo`. No administrator rights, no
  services, no drivers, nothing for other users.
- **Portable** installs nothing; Windows unpacks it to `%TEMP%\RadTempo`
  each time it runs.
- Both are built from this source by `.github/workflows/build-windows.yml`.
  Publisher in the file details: Avecina Studio. The files are not
  code-signed.

## What it watches

- **Three keys: F4, Ctrl+Alt+F4 and F12**, through a keyboard hook in the
  helper. The keys are passed through unchanged (F4 is PowerScribe's
  microphone, F12 its sign button); the helper only notes that they were
  pressed. **No other key is seen, recorded or stored.**
- **How long since the mouse or keyboard was last used** (Windows'
  idle timer, `A_TimeIdlePhysical`), to tell reading time from time away.
  It is a number of milliseconds; it holds no keystrokes.
- **Text in PowerScribe's window**, read only: the exam title and procedure
  code of the open study. The accession number is read to tell one study from
  the next and is kept in memory only, never written anywhere.
- **The selected rows of the PACS worklist**, read only, when asked for an IVU
  forecast.

`tools/helper_check.py` fails the build if the helper ever sends keys or
messages to another program, shows a window, or catches F4/F12 without
passing them through.

## What it stores

All in one folder, by default `%APPDATA%\RadTempo` (the user can choose
another, e.g. OneDrive, in Settings > Data):

- CSV files: one row per study read (date, time, seconds, modality, exam
  title, workload value), daily goals, breaks, rewards. **No patient names,
  MRNs or accession numbers.**
- `RadTempo.ini`: the user's settings, including their own QGenda
  calendar link if they set one.
- `radtempo.log`: app events (started, helper connected, errors). No exam
  text.
- `bridge.ini`: the port and random token of the local connection below.

## Network

| Connection | When | Code |
|---|---|---|
| `127.0.0.1` (this PC only) between the app and its helper, with a random token | Always, while running | `src/main/bridge.js` |
| The user's own QGenda calendar link (iCal), to show their shift | Only if the user pastes their link in Settings > Schedule | `src/main/main.js` `fetchText` |
| A gift-card web page, opened in the user's browser | Only when the user clicks it | `src/engine/settings.js` |

Nothing else: no analytics, no telemetry, no update checks, no cloud service,
no AI. The local connection listens on `127.0.0.1` only, so other computers
cannot reach it.

## Other things a scan will notice

- **Start with Windows** is optional and per user (the standard
  `HKCU\...\Run` entry Electron writes).
- **The installer** runs `build/rt-close.ps1` with PowerShell (execution
  policy bypassed for that one script) to close a running copy before it
  updates or uninstalls: it asks the app to quit, then ends any process
  still running from the install folder.
- `tools/ps_probe.ahk` is a developer diagnostic that lists PowerScribe's
  window contents. It is not part of the installed app, and its output can
  contain patient information.
- `RadTempo.ahk` is the older single-script version, kept in the
  repository for reference.

## Reporting a problem

Open an issue on this repository, or contact Avecina Studio.
