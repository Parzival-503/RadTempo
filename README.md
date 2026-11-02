# RadTempo

A per-study reading timer for the radiology workstation: F4 starts a study,
F12 signs it. It reads the exam from PowerScribe, shows your focus "par",
counts today's IVU against your goal, nudges you to take breaks, and keeps a
CSV history with an analytics dashboard.

## Get it

From the **[radtempo-latest](https://github.com/Parzival-503/radtempo/releases/tag/radtempo-latest)** release. Each is one file:

- **RadTempo-Setup.exe** - installs for your Windows user only. No
  administrator rights, a Start menu entry, starts with Windows.
- **RadTempo-Portable.exe** - nothing is installed. Put it somewhere
  permanent (Documents) and double-click it. For PCs that block installers.

The first time it runs it looks for the history of the classic AutoHotkey
version (Documents, Desktop, OneDrive) and offers to keep using it. History
and settings live in `%APPDATA%\RadTempo` unless you point it elsewhere
(Settings > Data); a OneDrive folder lets every workstation share one history.

Right-click the timer (or click the tray icon) for everything else. To show
your shift, paste your own QGenda calendar link in Settings > Schedule; your
hourly rate (for the dollar figures) goes in Settings > Money. Both stay on
your PC, in your settings file.

For IT and security reviewers: [SECURITY.md](SECURITY.md) lists exactly what
the app watches, stores and connects to.

## Develop

```
npm install
npm start                                        # run the app (Windows; elsewhere without the helper)
npm test                                         # logic unit tests
python3 tools/helper_check.py                    # helper static checks
xvfb-run -a node tests-e2e/run.js                # the real app end to end, screenshots in e2e-shots/
```

`.github/workflows/build-windows.yml` compiles the helper, builds both exes,
tests them on Windows with real key presses, and publishes the release.

- `src/engine/` - the study-timer logic (pure JS, tested)
- `src/main/` - the Electron app: windows, tray, menu, the helper bridge
- `src/ui/` - the timer widget, menu, dialogs, toast, wellness card
- `helper/RadTempoHelper.ahk` - the AutoHotkey v1.1 helper (keys, PowerScribe, PACS, idle time)
- `tools/dashboard/` - the analytics dashboard (shared with the classic)
- `RadTempo.ahk` - the classic single-script version, kept working

See `CLAUDE.md` for how it fits together and the rules it follows.
