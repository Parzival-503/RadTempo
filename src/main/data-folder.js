// Where the history lives, and bringing it over from the classic version.
//
// The app's own folder (%APPDATA%\RadTempo) always holds what belongs to
// this PC: the widget's position and the helper's bridge.ini. The DATA folder
// (the CSV files and RadTempo.ini) defaults to the same place but can be
// pointed anywhere - at the classic version's folder, so both read one
// history, or at OneDrive, so every workstation shares it.

const fs = require('fs');
const path = require('path');
const { FILES, EARLIER, earlierName } = require('../engine/store');
const { readText } = require('../engine/util');

function createDataFolder(appDir) {
  const locFile = () => path.join(appDir(), 'location.json');

  function readLoc() {
    try {
      return JSON.parse(fs.readFileSync(locFile(), 'utf8'));
    } catch (_) {
      return {};
    }
  }

  function dir() {
    if (process.env.RT_DATA_DIR) return process.env.RT_DATA_DIR;
    const loc = readLoc();
    if (loc.dataDir && fs.existsSync(loc.dataDir)) return loc.dataDir;
    return appDir();
  }

  function setDir(d) {
    const loc = readLoc();
    loc.dataDir = d && path.resolve(d) !== path.resolve(appDir()) ? d : '';
    fs.writeFileSync(locFile(), JSON.stringify(loc, null, 2));
  }

  // Has this PC been set up (welcome shown)?
  const isSetUp = () => !!readLoc().setUp || !!process.env.RT_DATA_DIR;
  function markSetUp() {
    const loc = readLoc();
    loc.setUp = new Date().toISOString();
    fs.writeFileSync(locFile(), JSON.stringify(loc, null, 2));
  }

  return { dir, setDir, isSetUp, markSetUp, appDir };
}

// A data file in d: its RadTempo name, else its earlier name, else null.
function inFolder(d, f) {
  for (const n of [f, earlierName(f)]) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
  return null;
}

// Summary of a folder that holds RadTempo files (or files under the earlier
// name, taken over when the folder is used), or null.
function describe(d) {
  const log = inFolder(d, FILES.log);
  if (!log) return null;
  const text = readText(log) || '';
  const lines = text.split(/\r?\n/).filter(Boolean);
  const last = lines.length > 1 ? lines[lines.length - 1].split(',')[1] : '';
  const files = Object.entries(FILES)
    .filter(([k]) => k !== 'dashboard')
    .filter(([, f]) => inFolder(d, f))
    .map(([, f]) => f);
  return { dir: d, studies: Math.max(0, lines.length - 1), last, files, hasIvu: files.includes(FILES.ivu) };
}

// Likely homes of the classic version's files on a workstation, plus any
// folder passed in (where the running classic copy lives).
function candidates(extra = [], env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  const roots = [];
  const add = (p) => p && roots.push(p);
  extra.forEach(add);
  if (env.PORTABLE_EXECUTABLE_DIR) add(env.PORTABLE_EXECUTABLE_DIR);
  if (home) {
    add(path.join(home, 'Documents'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents', 'Apps', 'Radiology'));
    add(path.join(home, 'Documents', 'Apps', 'Radiology', 'RadTempo'));
    add(path.join(home, 'Documents', 'Apps', 'Radiology', EARLIER));
    add(home);
    try {
      for (const d of fs.readdirSync(home)) if (/^OneDrive/i.test(d)) add(path.join(home, d));
    } catch (_) {}
  }
  const seen = new Set();
  const found = [];
  const look = (d) => {
    const k = path.resolve(d).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    const info = describe(d);
    if (info) found.push(info);
  };
  for (const r of roots) {
    look(r);
    // one and two levels down (OneDrive\Script Vault\RadTempo)
    let subs = [];
    try {
      subs = fs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    } catch (_) {}
    for (const s of subs.slice(0, 200)) {
      const p1 = path.join(r, s.name);
      look(p1);
      if (/radtempo|script|radiology|apps/i.test(s.name) || s.name.toLowerCase() === EARLIER.toLowerCase()) {
        try {
          for (const e of fs.readdirSync(p1, { withFileTypes: true })) if (e.isDirectory()) look(path.join(p1, e.name));
        } catch (_) {}
      }
    }
  }
  return found.sort((a, b) => b.studies - a.studies);
}

// Copy the classic files into dest. Never overwrites a file already there
// unless overwrite is set. Returns the names copied.
function importFrom(src, dest, overwrite = false) {
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const [k, f] of Object.entries(FILES)) {
    if (k === 'dashboard') continue;
    const a = inFolder(src, f);
    const b = path.join(dest, f);
    if (!a) continue;
    if (fs.existsSync(b) && !overwrite) continue;
    if (path.resolve(a) === path.resolve(b)) continue;
    fs.copyFileSync(a, b);
    copied.push(f);
  }
  return copied;
}

module.exports = { createDataFolder, describe, candidates, importFrom };
