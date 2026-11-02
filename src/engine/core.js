// The study timer itself: one study at a time, F4 to start, F12 to sign.
//
// This is the classic AutoHotkey script's logic, moved into plain JavaScript
// so it can be tested without Windows. It owns no windows: it keeps state,
// writes the CSV files, and hands the UI a snapshot (view()) whenever
// something changes. PowerScribe is read by the helper; idle time comes from
// the helper too (physical keyboard/mouse only), passed in as idleMs().
//
// Rules carried over (see CLAUDE.md for the reasons):
//  - par is median ENGAGED time per exam type, locked once the exam is known;
//  - the bet is scored against the par that was on screen;
//  - a study open for hours was never signed: the next F4 drops it, unlogged;
//  - exam detection searches early and backs off, then verifies twice;
//  - a typed exam title stops PowerScribe being read for that study.

const U = require('./util');
const A = require('./analytics');
const M = require('./maintenance');
const F = require('./forecast');
const { createIvuTable, parseIvuCsv, srcTag, isShaky } = require('./ivu');
const { MODS, MOD_COLORS, modFromExamText } = require('./modality');
const { createShifts, shiftStats } = require('./shifts');
const { createWellness } = require('./wellness');

const DET_FIND_GAPS = [2, 2, 3, 4, 5, 7, 10, 12]; // seconds between search attempts
const DET_VER_GAPS = [20, 40]; // verify passes after the first capture
const PAR_STEP = 15;
const UNDO_MS = 10000;

const COLORS = {
  good: '#0CA30C',
  run: '#C98500',
  warn: '#FF9DB0',
  away: '#D03B3B',
};

function createCore(deps) {
  const {
    store,
    settings,
    idleMs = () => 0,
    now = Date.now,
    readPS = async () => ({ exam: '', code: '', desc: '' }),
    fetchText = async () => {
      throw new Error('offline');
    },
    onChange = () => {},
    notify = () => {},
    onWellness = () => {},
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  } = deps;
  const cfg = settings.cfg;

  // ------------------------------------------------------------ state
  const s = {
    running: false,
    stopping: false,
    startAt: 0,
    mod: 'CT',
    exam: '',
    procCode: '',
    procDesc: '',
    examManual: false,
    det: { findIdx: 0, verIdx: 0, captured: false, text: '', timer: null, gen: 0 },
    activeMs: 0,
    awayMs: 0,
    actLast: 0,
    awayRunMs: 0,
    parSec: 0,
    parBase: 0,
    parLocked: false,
    parAdjust: 0,
    warnThreshold: 0,
    warnLocked: false,
    warnActive: false,
    today: { count: 0, ivu: 0, byMod: { CR: 0, CT: 0, MR: 0, US: 0, PET: 0 } },
    lastIVU: 0,
    lastNumExams: 1,
    lastSrc: '',
    lastScore: 0,
    undo: false,
    undoTimer: null,
    signed: null, // { clock, status, tone } shown after a sign until the next start
    banner: null, // { text, ivu, shaky }
    bannerTimer: null,
    parWinsToday: 0,
    parRunToday: 0,
    parBestToday: 0,
    lastDate: U.ymd(new Date(now())),
    block: '',
    extras: '',
    staleNote: '',
  };

  let ivu = createIvuTable([]);
  let parMaps = { exam: new Map(), mod: new Map() };
  let goals = new Map();
  let adjust = new Map();
  let cashed = 0;
  const shifts = createShifts(cfg);
  let stats = shiftStats([], shifts);
  let tickTimer = null;

  const wellness = createWellness({ cfg, idleMs, now, onCard: (ev, view) => onWellness(ev, view) });

  const today = () => U.mdy(new Date(now()));
  const rows = () => store.logRows();
  const changed = () => onChange(view());

  // ------------------------------------------------------------ loading

  function loadIvu() {
    ivu = createIvuTable(parseIvuCsv(store.readLines('ivu')));
  }
  function loadGoals() {
    goals = A.parseGoals(store.readLines('goals'));
  }
  function loadAdjust() {
    adjust = A.parseAdjust(store.readLines('adjust'));
  }
  function loadCashouts() {
    cashed = A.parseCashouts(store.readLines('rewards')).reduce((a, c) => a + c.a, 0);
  }
  function loadShiftCache() {
    shifts.loadCache(store.readLines('shifts') || []);
  }
  function refreshStats() {
    parMaps = A.parMaps(rows());
    stats = shiftStats(rows(), shifts, today());
  }
  function recountToday() {
    const t = A.todayTotals(rows(), today());
    s.today = { count: t.count, ivu: Math.max(0, t.ivu + todayAdjust()), byMod: t.byMod };
  }
  const todayAdjust = () => adjust.get(today()) || 0;
  const todayGoal = () => goals.get(today()) || 0;

  function updateBlock() {
    const a = shifts.attribute(today(), U.hourDec(new Date(now())));
    s.block = a.shift;
    s.extras = a.extras;
  }

  function loadAll() {
    settings.load();
    loadIvu();
    loadGoals();
    loadAdjust();
    loadCashouts();
    loadShiftCache();
    store.invalidate();
    recountToday();
    refreshStats();
    updateBlock();
    changed();
  }

  // ------------------------------------------------------------ the study

  function elapsedSec() {
    return s.running ? Math.max(0, Math.floor((now() - s.startAt) / 1000)) : 0;
  }

  function resetActivity() {
    s.activeMs = 0;
    s.awayMs = 0;
    s.awayRunMs = 0;
    s.actLast = now();
  }

  // Split the time since the last sample into active / away. A gap over 5 s
  // (sleep, clock jump) counts as 5 s so neither bucket gets a huge slice.
  function sampleActivity() {
    const t = now();
    if (!s.actLast) {
      s.actLast = t;
      return;
    }
    let delta = t - s.actLast;
    s.actLast = t;
    if (delta <= 0) return;
    if (delta > 5000) delta = 5000;
    if (!cfg.actEnabled) {
      s.activeMs += delta;
      return;
    }
    if (idleMs() < cfg.actIdleMs) {
      s.activeMs += delta;
      s.awayRunMs = 0;
    } else {
      s.awayMs += delta;
      s.awayRunMs += delta;
    }
  }

  function activityPct() {
    const tot = s.activeMs + s.awayMs;
    return tot <= 0 ? 100 : U.ahkRound((s.activeMs * 100) / tot);
  }

  function parReset() {
    s.parSec = 0;
    s.parBase = 0;
    s.parLocked = false;
    s.parAdjust = 0;
  }

  function clearWarning() {
    s.warnActive = false;
    s.warnThreshold = 0;
    s.warnLocked = false;
  }

  function clearDetect() {
    if (s.det.timer) timers.clearTimeout(s.det.timer);
    s.det.timer = null;
    s.det.gen++;
  }

  function scheduleDetect(gaps, idx) {
    clearDetect();
    if (idx < 0 || idx >= gaps.length) return;
    const gen = s.det.gen;
    s.det.timer = timers.setTimeout(() => {
      s.det.timer = null;
      if (gen === s.det.gen) detectTick(gen);
    }, gaps[idx] * 1000);
  }

  // Read PowerScribe and take what it says. Returns true with a usable exam.
  async function detectOnce() {
    const ps = await readPS();
    if (!s.running) return false;
    const exam = (ps && ps.exam) || '';
    if (!exam) return false;
    s.exam = exam;
    if (!s.examManual && ps.code) s.procCode = ps.code;
    if (!s.examManual && ps.desc) s.procDesc = ps.desc;
    const r = ivu.lookupFull(s.exam, s.examManual ? '' : s.procCode);
    s.banner = { text: s.exam, ivu: r.ivu, shaky: isShaky(r.src, r.score) };
    const m = modFromExamText(s.exam);
    if (m) {
      s.mod = m;
      notify(`Auto: ${m}`, 2000, 'quiet');
    }
    changed();
    return true;
  }

  async function detectTick(gen) {
    if (!s.running || s.examManual) return;
    const got = await detectOnce();
    if (gen !== s.det.gen || !s.running) return;
    if (!s.det.captured) {
      if (got && s.exam) {
        s.det.captured = true;
        s.det.text = s.exam;
        s.det.verIdx = 0;
        scheduleDetect(DET_VER_GAPS, s.det.verIdx);
      } else {
        s.det.findIdx++;
        scheduleDetect(DET_FIND_GAPS, s.det.findIdx);
      }
      return;
    }
    // Verify: the first read was of whatever PowerScribe still showed. When
    // the real study lands the text changes, and everything derived from the
    // wrong exam (par included - there was never a valid bet on it) resets.
    if (s.exam && s.exam !== s.det.text) {
      s.det.text = s.exam;
      parReset();
      clearWarning();
      notify(`Exam corrected: ${s.exam}`, 2500);
    }
    s.det.verIdx++;
    scheduleDetect(DET_VER_GAPS, s.det.verIdx);
  }

  function startTicking() {
    stopTicking();
    tickTimer = timers.setInterval(tick, 100);
  }
  function stopTicking() {
    if (tickTimer) timers.clearInterval(tickTimer);
    tickTimer = null;
  }

  // 10 times a second while a study runs.
  function tick() {
    if (!s.running) return;
    sampleActivity();
    if (!s.parLocked) {
      const base = A.getPar(parMaps, s.exam, s.mod);
      if (base > 0) {
        s.parBase = base;
        s.parSec = Math.max(30, base + s.parAdjust);
        if (s.exam) s.parLocked = true;
      }
    }
    if (cfg.warnEnabled && !s.warnActive) {
      // Keep recomputing until the exam type is known; locking on tick 1 would
      // use the PREVIOUS study's modality (a PET once blinked at CR's limit).
      if (s.warnThreshold === 0 || !s.warnLocked) {
        s.warnThreshold = A.warnThreshold(parMaps, s.exam, s.mod, cfg.warnPct);
        if (s.exam) s.warnLocked = true;
      }
      let fireOK = s.warnLocked;
      if (!fireOK && elapsedSec() > 20 && s.warnThreshold > 0) fireOK = true;
      if (fireOK && s.warnThreshold > 0 && Math.round(s.activeMs / 1000) > s.warnThreshold) s.warnActive = true;
    }
    changed();
  }

  // Stop the running study without logging it (reset button, stale study).
  function cancelStudy() {
    s.running = false;
    clearDetect();
    stopTicking();
    resetActivity();
    parReset();
    clearWarning();
    s.startAt = 0;
    s.signed = null;
    s.banner = null;
  }

  function start() {
    // F4 also toggles PowerScribe's microphone, so mid-study presses are
    // ignored. But a study open for hours was never signed: without this the
    // first F4 of the next day would be ignored too, and the clock would keep
    // counting from Friday (it read 65h on a Monday). Dropped, not logged.
    let staleNote = '';
    if (s.running && (now() - s.startAt) / 60000 >= cfg.staleStudyMin) {
      const from = new Date(s.startAt);
      staleNote = `The last study was still open from ${U.dayName(from)} ${U.clockTime(from)} (never signed with F12). Dropped, not logged.`;
      cancelStudy();
    }
    if (s.running || s.stopping) return false;
    if (s.undo) endUndo();
    s.exam = '';
    s.procCode = '';
    s.procDesc = '';
    s.lastSrc = '';
    s.lastScore = 0;
    s.banner = null;
    s.signed = null;
    if (s.bannerTimer) timers.clearTimeout(s.bannerTimer);
    s.running = true;
    s.startAt = now();
    resetActivity();
    parReset();
    clearWarning();
    s.examManual = false;
    s.det.findIdx = 0;
    s.det.verIdx = 0;
    s.det.captured = false;
    s.det.text = '';
    scheduleDetect(DET_FIND_GAPS, 0);
    startTicking();
    if (staleNote) notify(staleNote, 8000, 'warn');
    changed();
    return true;
  }

  // Sign. ps = what the helper read from PowerScribe the moment F12 went
  // down (before the sign completes); without it (menu "Test stop") it is
  // read here.
  async function stop(ps) {
    if (!s.running || s.stopping) return false;
    s.stopping = true;
    try {
      if (!s.examManual) {
        const fresh = ps || (await readPS());
        if (fresh && fresh.exam) s.exam = fresh.exam;
        if (fresh && fresh.code) s.procCode = fresh.code;
        if (fresh && fresh.desc) s.procDesc = fresh.desc;
      }
    } catch (_) {}
    if (!s.running) {
      s.stopping = false;
      return false;
    }
    clearDetect();
    sampleActivity();
    s.running = false;
    stopTicking();
    let activeSec = Math.round(s.activeMs / 1000);
    const elapsed = Math.max(0, Math.floor((now() - s.startAt) / 1000));
    if (activeSec > elapsed) activeSec = elapsed;

    const r = ivu.lookupFull(s.exam, s.examManual ? '' : s.procCode);
    s.lastIVU = r.ivu;
    s.lastNumExams = r.numExams || 1;
    s.lastSrc = r.src;
    s.lastScore = r.score;
    if (s.exam) {
      const m = modFromExamText(s.exam);
      if (m) s.mod = m;
    }
    s.today.count += s.lastNumExams;
    s.today.ivu += s.lastIVU;
    if (s.today.byMod[s.mod] != null) s.today.byMod[s.mod] += s.lastIVU;

    // Score the bet against the par that was on screen.
    const parLog = s.parSec > 0 ? U.ahkRound(s.parSec) : 0;
    let status = 'SIGNED';
    let tone = 'done';
    if (parLog > 0) {
      s.parRunToday++;
      if (activeSec <= parLog) {
        s.parWinsToday++;
        cfg.parStreak++;
        if (cfg.parStreak > cfg.parBestStreak) cfg.parBestStreak = cfg.parStreak;
        if (cfg.parStreak > s.parBestToday) s.parBestToday = cfg.parStreak;
        status = `UNDER PAR  ${U.formatSeconds(parLog - activeSec)}${cfg.parStreak > 1 ? `   ×${cfg.parStreak}` : ''}`;
      } else {
        cfg.parStreak = 0;
        status = `OVER PAR  ${U.formatSeconds(activeSec - parLog)}`;
        tone = 'warn';
      }
      settings.save('ParStreak', cfg.parStreak);
      settings.save('ParBestStreak', cfg.parBestStreak);
    }
    s.signed = { clock: U.formatClock(elapsed), status, tone };
    s.banner = { text: s.exam || s.banner?.text || '', ivu: s.lastIVU, shaky: isShaky(s.lastSrc, s.lastScore), signed: true };
    if (s.bannerTimer) timers.clearTimeout(s.bannerTimer);
    s.bannerTimer = timers.setTimeout(() => {
      s.banner = null;
      changed();
    }, 3000);

    logStudy(elapsed, activeSec, parLog);
    refreshStats();
    clearWarning();
    parReset();
    s.exam = '';
    s.stopping = false;
    beginUndo();
    changed();
    return true;
  }

  function logStudy(elapsed, activeSec, parLog) {
    const d = new Date(now());
    const at = shifts.attribute(U.mdy(d), U.hourDec(d));
    const clean = (x) => String(x || '').replace(/[,\r\n]/g, '');
    const examClean = String(s.exam || '').replace(/"/g, '').replace(/[\r\n]/g, '').replace(/,/g, ' ');
    const line = [
      U.logStamp(d),
      U.mdy(d),
      U.dayName(d),
      U.hour2(d),
      elapsed,
      U.formatSeconds(elapsed),
      s.mod,
      s.today.count,
      examClean,
      s.lastIVU.toFixed(2),
      clean(at.shift),
      clean(at.extras),
      activeSec >= 0 ? activeSec : '',
      parLog > 0 ? parLog : '',
      clean(s.procCode),
      clean(srcTag(s.lastSrc, s.lastScore)),
    ].join(',');
    const res = store.appendLog(line);
    const ivuTxt = s.lastIVU > 0 ? `  IVU ${s.lastIVU.toFixed(2)}` : '';
    const ex = s.lastNumExams > 1 ? ` (${s.lastNumExams} exams)` : '';
    if (res.ok) notify(`${s.mod} ${U.formatSeconds(elapsed)}${ivuTxt}${ex} logged  #${s.today.count}`, 3000, 'good');
    else notify(`The log file is locked (open in Excel?) - ${res.queued} queued, written when it frees up.`, 5000, 'warn');
  }

  function beginUndo() {
    s.undo = true;
    if (s.undoTimer) timers.clearTimeout(s.undoTimer);
    s.undoTimer = timers.setTimeout(() => {
      s.undo = false;
      s.undoTimer = null;
      changed();
    }, UNDO_MS);
  }
  function endUndo() {
    s.undo = false;
    if (s.undoTimer) timers.clearTimeout(s.undoTimer);
    s.undoTimer = null;
  }

  // The reset button: right after a sign it undoes the sign; otherwise it
  // cancels the running study without logging it.
  function reset() {
    if (s.undo) {
      endUndo();
      undoLast();
      s.signed = null;
      s.banner = null;
      changed();
      return 'undo';
    }
    cancelStudy();
    notify('Timer reset', 1500);
    changed();
    return 'reset';
  }

  function setMod(m) {
    if (!MODS.includes(m)) return;
    s.mod = m;
    changed();
  }

  function cycleMod(dir) {
    const i = MODS.indexOf(s.mod);
    setMod(MODS[(i + dir + MODS.length) % MODS.length]);
  }

  // ------------------------------------------------------------ par

  // Par moves are relative to the suggestion, so a nudge made before the exam
  // is detected still applies once the suggestion lands.
  function parShift(delta) {
    if (!s.running) return;
    if (s.parSec <= 0) {
      let seed = A.getPar(parMaps, s.exam, s.mod);
      if (seed <= 0) seed = 300;
      s.parBase = seed;
      s.parSec = seed;
    }
    const np = Math.max(30, s.parSec + delta);
    s.parAdjust += np - s.parSec;
    s.parSec = np;
    changed();
  }
  const parNudge = (dir) => parShift(dir * PAR_STEP);
  function parSuggested() {
    if (s.parBase > 0) {
      s.parAdjust = 0;
      s.parSec = s.parBase;
      changed();
    }
  }

  // ------------------------------------------------------------ exam title

  async function refetchExam() {
    if (!s.running) return { ok: false, msg: 'No study running - nothing to re-fetch.' };
    clearDetect();
    s.examManual = false;
    const before = s.exam;
    const got = await detectOnce();
    if (!got) {
      s.det.captured = false;
      s.det.text = '';
      s.det.findIdx = 0;
      s.det.verIdx = 0;
      scheduleDetect(DET_FIND_GAPS, 0);
      return { ok: false, msg: 'PowerScribe gave nothing back. Still looking - it will land on its own if it shows up.' };
    }
    s.det.text = s.exam;
    let msg;
    if (s.exam !== before) {
      parReset();
      clearWarning();
      msg = `Exam: ${s.exam}. Par and overtime re-derived.`;
    } else msg = `Unchanged: ${s.exam}`;
    s.det.captured = true;
    s.det.verIdx = 0;
    scheduleDetect(DET_VER_GAPS, 0);
    changed();
    return { ok: true, msg };
  }

  function setExamTitle(title) {
    if (!s.running) return { ok: false, msg: 'No study running - nothing to title.' };
    const t = String(title || '').trim();
    if (!t) return { ok: false, msg: '' };
    clearDetect();
    s.examManual = true;
    s.exam = t;
    s.det.captured = true;
    s.det.text = t;
    const r = ivu.lookupFull(t, '');
    s.banner = { text: t, ivu: r.ivu, shaky: isShaky(r.src, r.score) };
    const m = modFromExamText(t);
    if (m) s.mod = m;
    parReset();
    clearWarning();
    changed();
    return { ok: true, msg: `Exam set: ${t}. Par and overtime re-derived.` };
  }

  // ------------------------------------------------------------ log edits

  function undoLast() {
    const res = M.undoLast(store.logLines().slice());
    if (!res) {
      notify('No entries to undo', 2000);
      return null;
    }
    store.writeLog(res.lines);
    recountToday();
    refreshStats();
    notify(`Undone: ${res.removed.mod} ${res.removed.time}`, 2000);
    changed();
    return res.removed;
  }

  function fixLast(mod) {
    const res = M.fixLast(store.logLines().slice(), mod);
    if (!res) {
      notify('No entries to fix', 2000);
      return null;
    }
    store.writeLog(res.lines);
    recountToday();
    refreshStats();
    notify(`Fixed: ${res.oldMod || '?'} → ${mod}`, 2000);
    changed();
    return res;
  }

  function cleanDb() {
    const lines = store.logLines().slice();
    if (lines.length < 2) return { empty: true };
    const res = M.cleanDb(lines, ivu);
    store.writeLog(res.lines);
    recountToday();
    refreshStats();
    changed();
    return res;
  }

  function findOutliers() {
    return M.findOutliers(store.logLines().slice());
  }

  function removeOutliers(flagged) {
    const lines = store.logLines().slice();
    const out = M.removeIndices(lines, flagged.map((f) => f.idx));
    store.writeLog(out, '.bak');
    recountToday();
    refreshStats();
    changed();
    return { removed: flagged.length, kept: out.length - 1, backup: store.file('log') + '.bak' };
  }

  function backfillShifts() {
    const lines = store.logLines().slice();
    if (lines.length < 2) return { empty: true };
    const res = M.backfillShifts(lines, shifts);
    store.writeLog(res.lines, '.shiftbak');
    refreshStats();
    return { ...res, backup: store.file('log') + '.shiftbak' };
  }

  function resetDayCount() {
    s.today = { count: 0, ivu: 0, byMod: { CR: 0, CT: 0, MR: 0, US: 0, PET: 0 } };
    changed();
  }

  // ------------------------------------------------------------ goals

  function saveGoal(val) {
    const d = today();
    if (val > 0) goals.set(d, val);
    else goals.delete(d);
    store.write('goals', A.goalsText(goals));
    changed();
  }

  function goalInfo() {
    const typ = A.typicalDailyIvu(rows());
    const g = todayGoal();
    const t = s.today.ivu;
    // Seed with the rung still in play: once today's goal is met the prompt
    // opens on the NEXT rung, not on the number already beaten.
    let base = t > g ? t : g;
    if (base === 0) base = typ;
    let cur = g > 0 && t < g ? g : A.nextRung(base, cfg.goalBase, cfg.goalStep);
    cur = U.ahkRound(cur * 10) / 10;
    const rungs = [];
    for (let i = 1; i <= cfg.goalRungs; i++) {
      const v = cfg.goalBase + i * cfg.goalStep;
      rungs.push({ ivu: v, credits: i, label: A.g4(v) });
    }
    return {
      date: today(),
      goal: g,
      today: t,
      typical: typ,
      suggested: cur,
      upcoming: A.rungList(base, cfg.goalBase, cfg.goalStep).map(A.g4),
      rungs,
      credits: A.goalCredits(t, cfg.goalBase, cfg.goalStep),
      next: A.nextRung(t, cfg.goalBase, cfg.goalStep),
      blurb: (v) => A.goalBlurb(v, t, cfg.goalBase, cfg.goalStep),
    };
  }

  const goalBlurb = (v) => A.goalBlurb(v, s.today.ivu, cfg.goalBase, cfg.goalStep);

  // ------------------------------------------------------------ calibration

  function loggedToday() {
    return A.todayTotals(rows(), today()).ivu;
  }

  function calibInfo() {
    return { logged: loggedToday(), showing: s.today.ivu, adjust: todayAdjust(), scale: cfg.calScale };
  }

  // PowerScribe's RVU Sum IS the day's production: today's tally becomes it.
  function calibApply(psRvu) {
    const v = Number(psRvu);
    if (!(v > 0)) return null;
    const base = loggedToday();
    const psIvu = v * cfg.calScale;
    const stamp = new Date(now());
    store.append('adjust', 'Date,Adjust,PowerScribeTotal,Recorded', `${today()},${(psIvu - base).toFixed(4)},${v.toFixed(4)},${U.isoDate(stamp)} ${stamp.toTimeString().slice(0, 8)}`);
    loadAdjust();
    recountToday();
    changed();
    return { total: s.today.ivu, delta: psIvu - base };
  }

  function calibClear() {
    const stamp = new Date(now());
    store.append('adjust', 'Date,Adjust,PowerScribeTotal,Recorded', `${today()},0.0000,0.0000,${U.isoDate(stamp)} ${stamp.toTimeString().slice(0, 8)}`);
    loadAdjust();
    recountToday();
    changed();
  }

  // ------------------------------------------------------------ rewards

  // Today's par record, from the log so it survives a restart.
  function todayPar() {
    let bets = 0;
    let wins = 0;
    let run = 0;
    let best = 0;
    for (const c of rows()) {
      if ((c[1] || '').trim() !== today()) continue;
      const parS = c.length >= 14 ? U.num(c[13]) : 0;
      const actS = c.length >= 13 && (c[12] || '').trim() !== '' ? U.num(c[12]) : -1;
      if (parS > 0 && actS >= 0) {
        bets++;
        if (actS <= parS) {
          wins++;
          run++;
          best = Math.max(best, run);
        } else run = 0;
      }
    }
    return { bets, wins, best };
  }

  function rewardInfo() {
    const p = todayPar();
    const rung = A.goalCredits(s.today.ivu, cfg.goalBase, cfg.goalStep);
    const pts = A.rewardPoints(p.wins, p.bets, p.best, rung, cfg);
    const earned = A.rewardEarnedTotal(rows(), cfg);
    const balance = Math.max(0, U.ahkRound((earned - cashed) * 100) / 100);
    return {
      enabled: cfg.rewardEnabled,
      todayPts: pts,
      todayDollars: A.rewardDollars(pts, cfg),
      wins: p.wins,
      bets: p.bets,
      best: p.best,
      rung,
      ivu: s.today.ivu,
      earned,
      cashed,
      balance,
      perPoint: cfg.rewardPerPoint,
      weekCap: cfg.rewardWeekCap,
      storeUrl: cfg.rewardStoreUrl,
      start: cfg.rewardStart,
      sample: A.rewardDollars(A.rewardPoints(25, 30, 10, 2, cfg), cfg),
    };
  }

  function cashOut(amount, note = 'gift card') {
    const info = rewardInfo();
    const a = Number(amount);
    if (!(a > 0)) return { ok: false, msg: '' };
    if (a > info.balance + 1e-9) return { ok: false, msg: `That is more than the bank holds ($${info.balance.toFixed(2)}).` };
    const d = new Date(now());
    store.append('rewards', 'Date,Amount,Note', `${U.isoDate(d)} ${U.pad2(d.getHours())}:${U.pad2(d.getMinutes())},${a.toFixed(2)},${String(note).replace(/,/g, ' ')}`);
    loadCashouts();
    return { ok: true, amount: a, balance: rewardInfo().balance };
  }

  function setRewardRate(v) {
    const x = Number(v);
    if (!(x >= 0)) return false;
    cfg.rewardPerPoint = x;
    settings.save('RewardPerPoint', x);
    return true;
  }

  function restartBank() {
    cfg.rewardStart = U.ymd(new Date(now()));
    settings.save('RewardStartDate', cfg.rewardStart);
  }

  // ------------------------------------------------------------ shifts

  async function refreshShifts() {
    if (!cfg.shiftUrl) return 'No QGenda calendar link is set (Settings > Schedule).';
    let ics;
    try {
      ics = await fetchText(cfg.shiftUrl);
    } catch (e) {
      return 'Fetch failed: ' + (e.message || e);
    }
    if (!String(ics).includes('BEGIN:VCALENDAR')) return 'The link did not return a calendar feed.';
    const n = shifts.parseICal(ics);
    if (n === 0) return 'The feed parsed but contained no events.';
    const d = new Date(now());
    shifts.setLastFetch(U.ymd(d) + U.pad2(d.getHours()) + U.pad2(d.getMinutes()) + U.pad2(d.getSeconds()));
    try {
      store.write('shifts', shifts.cacheText());
    } catch (_) {}
    refreshStats();
    updateBlock();
    changed();
    return '';
  }

  function shiftToday() {
    updateBlock();
    const d = new Date(now());
    const tm = U.addDays(d, 1);
    return {
      today: { date: U.mdy(d), ...shifts.describeDay(U.mdy(d)) },
      tomorrow: { date: U.mdy(tm), ...shifts.describeDay(U.mdy(tm)) },
      active: s.block,
      extras: s.extras,
      lastFetch: shifts.lastFetch(),
      count: shifts.count(),
    };
  }

  function shiftSchedule() {
    const d = new Date(now());
    const lo = U.ymd(U.addDays(d, -7));
    const hi = U.ymd(U.addDays(d, 30));
    const t = U.ymd(d);
    const out = [];
    for (const [k, v] of shifts.map()) {
      const y = U.stampOf(k);
      if (y >= lo && y <= hi) out.push({ ymd: y, date: k, day: U.dayName(U.parseMdy(k)), shifts: v, today: y === t });
    }
    out.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
    return { rows: out, count: shifts.count() };
  }

  function blockContext(extra = 0) {
    updateBlock();
    const typ = stats.typical(s.block);
    if (!(typ.ivu > 0 && typ.n >= 2)) return null;
    const so = A.todayBlockIvu(rows(), s.block, today());
    return {
      block: s.block || 'any block',
      extras: s.extras,
      typical: typ.ivu,
      n: typ.n,
      soFar: so,
      pace: U.ahkRound(((so + extra) / typ.ivu) * 100),
    };
  }

  function todayTypicalTotal() {
    const plan = shifts.dayPlan(today());
    if (!plan) return 0;
    return plan.prims.reduce((a, p) => a + stats.typical(p.name).ivu, 0);
  }

  // ------------------------------------------------------------ forecast

  function forecast(kind, text) {
    const r = kind === 'rows' ? F.fromRows(text, ivu) : F.fromPasted(text, ivu);
    let goalPrefill = cfg.forecastGoal;
    if (!goalPrefill) {
      const t = todayTypicalTotal();
      if (t > 0) goalPrefill = String(U.ahkRound(t));
    }
    return { ...r, today: s.today.ivu, count: s.today.count, projected: s.today.ivu + r.total, block: blockContext(r.total), goalPrefill };
  }

  function forecastGoalCheck(goal, total) {
    const g = Number(goal);
    if (!(g > 0)) return { msg: 'Enter a number first', tone: 'muted' };
    cfg.forecastGoal = String(goal);
    settings.save('ForecastGoal', goal);
    const projected = s.today.ivu + Number(total || 0);
    if (projected >= g) return { msg: `✓ Goal met! +${(projected - g).toFixed(1)} over target`, tone: 'good' };
    return { msg: `Need ${(g - projected).toFixed(1)} more IVU after this batch`, tone: 'warn' };
  }

  // ------------------------------------------------------------ breakdown

  function breakdown() {
    const t = A.todayTotals(rows(), today());
    return {
      byMod: s.today.byMod,
      total: s.today.ivu,
      count: s.today.count,
      block: blockContext(0),
      rate: cfg.hourlyRate,
      engagedDollars: (t.engagedSec / 3600) * cfg.hourlyRate,
      idleDollars: (t.idleSec / 3600) * cfg.hourlyRate,
      idleSec: t.idleSec,
      goal: todayGoal(),
      credits: A.goalCredits(s.today.ivu, cfg.goalBase, cfg.goalStep),
      next: A.nextRung(s.today.ivu, cfg.goalBase, cfg.goalStep),
    };
  }

  // ------------------------------------------------------------ housekeeping

  // Once a minute: a new date resets the day; the active block can change.
  function minuteTick() {
    const cur = U.ymd(new Date(now()));
    let newDay = false;
    if (cur !== s.lastDate) {
      s.lastDate = cur;
      s.today = { count: 0, ivu: 0, byMod: { CR: 0, CT: 0, MR: 0, US: 0, PET: 0 } };
      s.parWinsToday = 0;
      s.parRunToday = 0;
      s.parBestToday = 0;
      wellness.newDay();
      loadGoals();
      newDay = true;
    }
    const prev = s.block;
    updateBlock();
    if (newDay || prev !== s.block) changed();
    return newDay;
  }

  function flushPending() {
    const n = store.flushPending();
    if (n) notify(`${n} queued ${n === 1 ? 'study' : 'studies'} written to the log`, 2000, 'good');
    return n;
  }

  // ------------------------------------------------------------ the view

  function view() {
    const el = elapsedSec();
    const goal = todayGoal();
    const goalPct = goal > 0 ? U.ahkRound((s.today.ivu / goal) * 100) : null;
    const v = {
      running: s.running,
      mod: s.mod,
      mods: MODS.map((m) => ({ id: m, color: MOD_COLORS[m] })),
      count: s.today.count,
      ivu: U.fixed(s.today.ivu, 1),
      goal,
      goalPct,
      credits: A.goalCredits(s.today.ivu, cfg.goalBase, cfg.goalStep),
      undo: s.undo,
      banner: s.banner,
      exam: s.exam,
      block: s.block,
      extras: s.extras,
      warn: false,
      parSec: s.parSec,
      parBase: s.parBase,
      parAdjust: s.parAdjust,
      actEnabled: cfg.actEnabled,
      warnEnabled: cfg.warnEnabled,
      warnPct: cfg.warnPct,
      actIdleSec: Math.round(cfg.actIdleMs / 1000),
      wellnessMinutes: cfg.wellnessMinutes,
      examManual: s.examManual,
    };
    if (!s.running) {
      v.phase = s.signed ? 'signed' : 'idle';
      v.clock = s.signed ? s.signed.clock : '--:--';
      v.status = s.signed ? s.signed.status : 'READY';
      v.tone = s.signed ? s.signed.tone : 'idle';
      v.dot = s.signed ? 'done' : 'idle';
      v.slot = { label: 'EXAMS', value: String(s.today.count) };
      v.bar = { pct: 100, color: s.signed ? COLORS.good : null };
      return v;
    }
    v.phase = 'running';
    v.clock = U.formatClock(el);
    v.elapsed = el;
    v.slot = { label: 'PAR', value: s.parSec > 0 ? U.formatSeconds(U.ahkRound(s.parSec)) : '--', clickable: true };
    const actSecs = U.ahkRound(s.activeMs / 1000);
    v.activeSec = actSecs;
    const pct = activityPct();
    v.focusPct = pct;
    if (!cfg.actEnabled) {
      v.status = 'DICTATING';
      v.tone = 'run';
      v.dot = 'active';
      v.bar = { pct: 100, color: COLORS.run };
    } else {
      // The bar is the race: it fills with engaged time toward par.
      let barPct;
      let barCol;
      if (s.parSec > 0) {
        barPct = Math.min(100, U.ahkRound((actSecs / s.parSec) * 100));
        const ratio = actSecs / s.parSec;
        barCol = ratio <= 1 ? COLORS.good : ratio <= cfg.warnPct / 100 ? COLORS.run : COLORS.warn;
      } else {
        barPct = pct;
        barCol = COLORS.run;
      }
      v.bar = { pct: Math.max(2, barPct), color: barCol };
      const away = idleMs() >= cfg.actIdleMs;
      v.dot = away ? 'away' : 'active';
      if (away) {
        v.status = `AWAY ${U.formatSeconds(Math.floor(s.awayRunMs / 1000))}`;
        v.tone = 'away';
      } else if (s.parSec > 0) {
        // Mid-study this is a countdown, not a verdict: UNDER/OVER PAR is only
        // said once the study is signed.
        const dlt = U.ahkRound(s.parSec) - actSecs;
        v.status = `${pct}%  ·  ${dlt >= 0 ? U.formatSeconds(dlt) + ' LEFT' : U.formatSeconds(-dlt) + ' OVER'}`;
        v.tone = dlt >= 0 ? 'run' : 'warn';
      } else {
        v.status = `${pct}%  ·  par --`;
        v.tone = 'run';
      }
    }
    if (s.warnActive && cfg.warnEnabled) {
      v.warn = true;
      v.phase = 'warn';
      v.status = 'OVER TIME';
      v.tone = 'warn';
    }
    return v;
  }

  // Tray tooltip: state, count, today's block.
  function trayTip() {
    let tip = 'RadTempo';
    if (s.running) tip += ` - running (${s.mod})`;
    else if (s.today.count > 0) tip += ` - ${s.today.count} today`;
    if (s.block) tip += ` | ${s.block}`;
    if (s.extras) tip += ` (+${s.extras})`;
    return tip.length > 127 ? tip.slice(0, 124) + '...' : tip;
  }

  // ------------------------------------------------------------ settings

  function setSetting(name, value) {
    switch (name) {
      case 'warnEnabled':
        cfg.warnEnabled = !!value;
        settings.save('WarnEnabled', value ? 1 : 0);
        if (!value) clearWarning();
        break;
      case 'warnPct':
        cfg.warnPct = +value;
        s.warnThreshold = 0;
        settings.save('WarnPct', +value);
        break;
      case 'actEnabled':
        cfg.actEnabled = !!value;
        settings.save('ActivityEnabled', value ? 1 : 0);
        break;
      case 'actIdleSec':
        cfg.actIdleMs = +value * 1000;
        settings.save('ActivityIdleSec', +value);
        break;
      case 'wellnessMinutes':
        wellness.setInterval(+value);
        settings.save('WellnessMinutes', +value);
        break;
      default:
        return false;
    }
    changed();
    return true;
  }

  function parRecompute() {
    refreshStats();
    return { examTypes: parMaps.exam.size };
  }

  return {
    state: s,
    cfg,
    shifts,
    wellness,
    ivuTable: () => ivu,
    loadAll,
    loadIvu,
    start,
    stop,
    reset,
    cancelStudy: () => {
      cancelStudy();
      changed();
    },
    setMod,
    cycleMod,
    parShift,
    parNudge,
    parSuggested,
    refetchExam,
    setExamTitle,
    undoLast,
    fixLast,
    cleanDb,
    findOutliers,
    removeOutliers,
    backfillShifts,
    resetDayCount,
    saveGoal,
    goalInfo,
    goalBlurb,
    typicalDaily: () => A.typicalDailyIvu(rows()),
    calibInfo,
    calibApply,
    calibClear,
    rewardInfo,
    cashOut,
    setRewardRate,
    restartBank,
    refreshShifts,
    shiftToday,
    shiftSchedule,
    forecast,
    forecastGoalCheck,
    breakdown,
    minuteTick,
    flushPending,
    view,
    trayTip,
    setSetting,
    parRecompute,
    elapsedSec,
    fillerIvu: () => ivu.fillerIvu(cfg.fillerMatch, cfg.fillerIvu),
    goals: () => goals,
    adjust: () => adjust,
    tick,
    changed,
  };
}

module.exports = { createCore, DET_FIND_GAPS, DET_VER_GAPS };
