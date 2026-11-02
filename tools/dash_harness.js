#!/usr/bin/env node
/*
 * Headless test harness for RadTempo's GenerateDashboard() JS.
 *
 * Why this exists: the dashboard is emitted as ~180 AHK `a(f, "...")` string
 * literals that only become runnable JavaScript after AHK writes them to disk.
 * Bugs in that JS (scoping, quote-escaping, a null-deref on a ragged CSV row)
 * are invisible until the user opens the dashboard on Windows. This harness
 * closes that loop on the Mac/Linux side:
 *
 *   1. Extract the a(f, "...") literals from GenerateDashboard() in the .ahk,
 *      honoring AHK's "" -> " escaping, and reconstruct the emitted document.
 *   2. Inject sample data for the four dynamic <script> blocks that AHK fills
 *      at runtime (CSV_RAW, TODAY_SHIFT, SHIFTS, CLS).
 *   3. `node --check` the reconstructed JS for syntax.
 *   4. Execute it in a vm sandbox with minimal DOM + Chart.js stubs against
 *      several sample datasets (old 10-col, ragged/mixed, rich multi-shift).
 *      The body.innerHTML / insertAdjacentHTML error paths are trip-wires:
 *      if the dashboard hits its own error banner, the run FAILS.
 *
 * Usage: node tools/dash_harness.js [path/to/RadTempo.ahk]
 * Exit 0 = all fixtures rendered cleanly, 1 = a syntax or runtime failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const AHK = process.argv[2] || path.join(__dirname, '..', 'RadTempo.ahk');

// ---------------------------------------------------------------------------
// 1. Extract the emitted a(f, "...") strings from GenerateDashboard()
// ---------------------------------------------------------------------------

function extractEmittedStrings(ahkText) {
  const lines = ahkText.split(/\r?\n/);
  // scope to the GenerateDashboard() body
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^\s*GenerateDashboard\s*\(\s*\)\s*\{/.test(lines[i])) start = i;
    else if (start !== -1 && /^\s*Run\s*,\s*%DASH_FILE%/.test(lines[i])) { end = i; break; }
  }
  if (start === -1) throw new Error('GenerateDashboard() not found');
  if (end === -1) end = lines.length;

  const out = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const m = /^\s*a\(\s*f\s*,\s*"/.exec(line);
    if (!m) continue; // skip comments, fObj.Write, code — only a() literals
    const content = readAhkString(line, m[0].length - 1); // index of opening quote
    if (content === null) throw new Error(`L${i + 1}: unterminated a() string`);
    out.push(content);
  }
  return out;
}

// Walk an AHK v1.1 expression double-quoted string starting at `openIdx`
// (the position of the opening "). Returns the unescaped content ("" -> ")
// or null if unterminated. AHK's escape char is backtick, NOT backslash, so
// backslashes pass through verbatim (they are literal in the emitted JS).
function readAhkString(line, openIdx) {
  let i = openIdx + 1;
  const n = line.length;
  let out = '';
  while (i < n) {
    const c = line[i];
    if (c === '"') {
      if (i + 1 < n && line[i + 1] === '"') { out += '"'; i += 2; continue; }
      return out; // string end
    }
    out += c;
    i++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Build the runnable JS: head data scripts + main try/catch body
// ---------------------------------------------------------------------------

function buildDashboardJs(emitted, fixture) {
  // locate the main <script> that starts with try{ ... </script>
  let s = -1, e = -1;
  for (let i = 0; i < emitted.length; i++) {
    if (emitted[i] === '<script>' && i + 1 < emitted.length &&
        emitted[i + 1].startsWith('try{')) { s = i + 1; }
    if (s !== -1 && emitted[i].startsWith('</script>')) { e = i; break; }
  }
  if (s === -1 || e === -1) throw new Error('main <script> try/catch block not found');
  const mainJs = emitted.slice(s, e).join('\n');

  // Head data scripts, exactly the four consts AHK writes at runtime.
  const head = [];
  head.push(`const CSV_RAW=${JSON.stringify(fixture.csv)};`);
  head.push(`const TODAY_SHIFT=${JSON.stringify(fixture.todayShift || '')};`);
  if (fixture.goal !== undefined)
    head.push(`const DAILY_GOAL=${Number(fixture.goal) || 0};`);
  // Mirror the AHK data block exactly. Omitting this left every dollar figure
  // gated off behind RATE>0, so the money code was never exercised.
  head.push(`const HOURLY_RATE=${fixture.rate !== undefined ? Number(fixture.rate) : 150};`);
  head.push(`const GOALS=${JSON.stringify(fixture.goals || {})};`);
  // The filler exam + goal rungs, mirroring the AHK data block. Defaults match
  // the globals in RadTempo.ahk so a fixture only overrides to test edges.
  head.push(`const FILLER=${JSON.stringify(fixture.filler !== undefined ? fixture.filler
    : { n: 'lung screening', re: 'LUNG.*(SCREEN|CANCER)|(SCREEN|LDCT).*LUNG', ivu: 0 })};`);
  head.push(`const LADDER=${JSON.stringify(fixture.ladder || { b: 60, s: 7 })};`);
  head.push(`const REWARD=${JSON.stringify(fixture.reward !== undefined ? fixture.reward
    : { on: 1, per: 0.20, rung: 10, every: 5, bonus: 3, cap: 150, start: '' })};`);
  head.push(`const CASHOUTS=${JSON.stringify(fixture.cashouts || [])};`);
  if (fixture.shifts !== undefined)
    head.push(`const SHIFTS=${JSON.stringify(fixture.shifts)};`);
  if (fixture.cls !== undefined)
    head.push(`const CLS=${JSON.stringify(fixture.cls)};`);

  return head.join('\n') + '\n' + mainJs + '\n';
}

// ---------------------------------------------------------------------------
// 3. DOM + Chart stubs
// ---------------------------------------------------------------------------

function makeSandbox(report) {
  function El(tag) {
    return {
      tagName: tag,
      _innerHTML: '',
      textContent: '',
      value: '',
      style: new Proxy({}, { set: () => true, get: () => '' }),
      children: [],
      _attrs: {},
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v) { this._innerHTML = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      insertAdjacentHTML() {},
      addEventListener() {},
      querySelector() { return El('stub'); },
      querySelectorAll() { return []; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return this._attrs[k]; },
      getContext() { return {}; },
    };
  }

  const body = El('body');
  Object.defineProperty(body, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      v = String(v);
      this._innerHTML = v;
      if (/ERROR:/.test(v)) report.errors.push('body.innerHTML error banner: ' + v.slice(0, 120));
      else if (/No data/.test(v)) report.noData = true;
    },
  });
  body.insertAdjacentHTML = function (_pos, html) {
    if (/Dashboard error:/.test(html)) report.errors.push('catch banner: ' + html.slice(0, 200));
  };

  const cache = {};
  // Selectors the real page has several of; returning an empty list would skip
  // the wiring code entirely and hide bugs in it.
  const MULTI = {
    '#tabs button': ['today', 'focus', 'rhythm', 'bank', 'shifts', 'exams', 'log'].map(p => {
      const e = El('button'); e._attrs['data-p'] = p; return e;
    }),
    '#rng button': ['7', '30', '90', '0'].map(d => {
      const e = El('button'); e._attrs['data-d'] = d; return e;
    }),
    '.pane': ['p-today', 'p-focus', 'p-rhythm', 'p-bank', 'p-shifts', 'p-exams', 'p-log'].map(id => {
      const e = El('section'); e.id = id;
      e.classList = { toggle() {}, contains: () => false, add() {}, remove() {} };
      return e;
    }),
    '#tST thead th': [0, 1, 2, 3, 4, 5].map(i => {
      const e = El('th'); e._attrs['data-s'] = String(i); return e;
    }),
  };
  const document = {
    body,
    getElementById(id) { return cache['#' + id] || (cache['#' + id] = El('#' + id)); },
    querySelector(sel) { return cache[sel] || (cache[sel] = El(sel)); },
    querySelectorAll(sel) { return MULTI[sel] || []; },
    createElement(tag) { return El(tag); },
    addEventListener() {},
  };

  function Chart(canvas, config) {
    report.charts++;
    // mixed charts legitimately omit top-level type and set it per dataset
    const hasType = config && (config.type ||
      (config.data && (config.data.datasets || []).some(ds => ds && ds.type)));
    if (!config || !config.data || !hasType)
      report.warnings.push('Chart created without type/data');
    this.destroy = function () {};
    this.update = function () {};
  }
  // mirror the shape of real Chart.js defaults the dashboard writes into
  Chart.defaults = {
    color: '', borderColor: '', maintainAspectRatio: true,
    font: { family: '', size: 12 },
    plugins: { tooltip: {}, legend: {} },
  };

  // Browser globals the dashboard legitimately uses. rAF runs the callback
  // once with a large timestamp so animated count-ups land on their final
  // value instead of being skipped.
  // Virtual clock: each frame advances 16ms so rAF-driven animations actually
  // converge (a fixed timestamp would spin forever), with a frame cap as a
  // runaway backstop.
  let vclock = 0, frames = 0;
  const requestAnimationFrame = cb => {
    if (++frames > 4000) return;
    vclock += 16;
    try { cb(vclock); } catch (e) { report.errors.push('rAF: ' + e.message); }
  };
  const matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  const win = { matchMedia, requestAnimationFrame, scrollTo() {}, innerWidth: 1280, devicePixelRatio: 1 };

  const sandbox = {
    window: win,
    requestAnimationFrame,
    matchMedia,
    document,
    Chart,
    console: {
      log: () => {},
      error: (...a) => report.consoleErrors.push(a.map(String).join(' ')),
      warn: () => {},
    },
    // built-ins vm provides automatically; expose the few we lean on explicitly
    Math, Date, JSON, RegExp, Set, Map, Array, Object, String, Number,
    parseFloat, parseInt, isNaN, isFinite,
  };
  return sandbox;
}

// ---------------------------------------------------------------------------
// 4. Fixtures
// ---------------------------------------------------------------------------

const CLS = {
  mod: ['POC', 'READOUT', 'RESIDENT READOUT', 'CONF', 'CHART REVIEW'],
  off: ['VACATION', 'ATO', 'PTO', 'HOLIDAY'],
  noise: ['EXTRA HOURS', 'CUSTOM HOURS'],
  onsite: 'MAIN|North Campus',
  am: [8, 12.5],
  pm: [12.5, 17],
};

function mdy(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }
function dow(d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]; }
function fmtSec(s) { const m = Math.floor(s / 60), c = s % 60; return m + ':' + String(c).padStart(2, '0'); }

// Rich fixture generated relative to "today" so the today/week/month buckets
// and the forward-forecast (future SHIFTS keys) are all exercised.
function richFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec';
  const rows = [HDR];
  const shifts = {};
  const goals = {};
  const exams = {
    MR: [['MRI BRAIN W WO', 900, 2.4], ['MRI LUMBAR SPINE WO', 780, 1.8]],
    CT: [['CT ABDOMEN PELVIS W', 300, 1.25], ['CT CHEST WO', 240, 1.0],
         ['CT CHEST LUNG CANCER SCREENING WO', 330, 1.2]],
    US: [['US ABDOMEN COMPLETE', 200, 0.8], ['US RENAL', 160, 0.6]],
    CR: [['XR CHEST 2V', 90, 0.3], ['XR KNEE 3V', 80, 0.25]],
    PET: [['PET CT SKULL TO THIGH', 2400, 5.0]],
  };
  // schedule templates keyed by day-of-week index for variety, incl. on-site + call
  const templates = [
    'BODY MR AM / BODY CT PM',
    'BODY MR 8a-12:30p / POC / BODY CT 12:30p-5p',
    'MAIN 8a-5p / Chart Review',
    'North Campus 8a-12p / Readout / BODY US PM',
    'STAT/BWMC 12a-7a',
    'BODY MR AM / Conf / BODY MR PM',
    'BODY CT AM / BODY CT PM',
  ];
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  for (let off = -25; off <= 14; off++) {
    const d = new Date(today.getTime() + off * 864e5);
    const tmpl = templates[((off % templates.length) + templates.length) % templates.length];
    // Vacation blocks occasionally, to exercise OFF classification + gaps
    const key = mdy(d);
    shifts[key] = (off === -6 || off === -13) ? 'Vacation' : tmpl;
    if (off > 0) continue;                // no logged studies in the future (today IS logged)
    if (off === -6 || off === -13) continue; // vacation days: no studies

    // 6-14 studies spread across AM and PM windows
    const count = 6 + (Math.abs(off) % 9);
    let dnum = 0;
    let dayIvu = 0;
    for (let k = 0; k < count; k++) {
      dnum++;
      const pm = k >= Math.floor(count / 2);
      const hour = pm ? (13 + (k % 4)) : (9 + (k % 3));
      const minute = (k * 13) % 60;
      const modKeys = Object.keys(exams);
      const mod = modKeys[(k + Math.abs(off)) % modKeys.length];
      const [exam, secBase, ivu] = exams[mod][k % exams[mod].length];
      const sec = secBase + ((k * 7) % 60) - 30;
      const ts = `${mdy(d)} ${hour}:${String(minute).padStart(2, '0')}`;
      rows.push([
        ts, mdy(d), dow(d), hour, sec, fmtSec(sec), mod, dnum,
        exam, ivu.toFixed(2), '', '',
        // engaged seconds, then the par that was on screen. Alternating so
        // roughly half the bets are won and both branches get exercised.
        Math.round(sec * 0.85), (k % 2 === 0 ? Math.round(secBase * 0.95) : Math.round(secBase * 1.15)),
      ].join(','));
      dayIvu += ivu;
    }
    // Goals on most days, spread across the three outcomes so the hit / miss /
    // "stopped on the line" branches all execute:
    //   0 -> coasted (~102% of goal)   1 -> cleared (~125%)   2 -> missed (~83%)
    if (off % 4 !== 0 && dayIvu > 0) {
      const m = ((off % 3) + 3) % 3;
      const factor = m === 0 ? 0.98 : m === 1 ? 0.80 : 1.20;
      goals[mdy(d)] = Math.round(dayIvu * factor * 10) / 10;
    }
  }
  return { name: 'rich (multi-shift, consecutive days, forecast, today+goal)', csv: rows.join('\n') + '\n',
           shifts, goals, cls: CLS, todayShift: 'BODY MR AM', goal: 30 };
}

// Old 10-column format: no Shift/Extras columns, no SHIFTS matches -> degrade path.
function old10Fixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU';
  const rows = [HDR,
    '5/1/2025 9:15,5/1/2025,Thu,9,300,5:00,CT,1,CT ABDOMEN PELVIS W,1.25',
    '5/1/2025 9:40,5/1/2025,Thu,9,280,4:40,CT,2,CT CHEST WO,1.00',
    '5/1/2025 10:05,5/1/2025,Thu,10,900,15:00,MR,3,MRI BRAIN W WO,2.40',
    '5/2/2025 9:00,5/2/2025,Fri,9,90,1:30,CR,1,XR CHEST 2V,0.30',
    '5/2/2025 9:20,5/2/2025,Fri,9,200,3:20,US,2,US ABDOMEN COMPLETE,0.80',
    '5/2/2025 13:10,5/2/2025,Fri,13,780,13:00,MR,3,MRI LUMBAR SPINE WO,1.80',
    '5/3/2025 8:50,5/3/2025,Sat,8,300,5:00,CT,1,CT ABDOMEN PELVIS W,1.25',
    '5/3/2025 11:30,5/3/2025,Sat,11,240,4:00,CT,2,CT CHEST WO,1.00',
    '5/3/2025 14:00,5/3/2025,Sat,14,2400,40:00,PET,3,PET CT SKULL TO THIGH,5.00',
  ];
  // SHIFTS/CLS still emitted by AHK, but empty map -> hasShift stays false.
  return { name: 'old 10-col (no shift data)', csv: rows.join('\n') + '\n',
           shifts: {}, cls: CLS, todayShift: '' };
}

// Ragged: mixed 10/11/12-col rows, blank fields, a legacy 11-col Shift-only row.
function raggedFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras';
  const rows = [HDR,
    '6/1/2025 9:15,6/1/2025,Sun,9,300,5:00,CT,1,CT ABDOMEN PELVIS W,1.25,BODY CT AM,',       // 12-col, empty extras
    '6/1/2025 9:40,6/1/2025,Sun,9,280,4:40,CT,2,CT CHEST WO,1.00,BODY CT AM',                 // 11-col, no extras field
    '6/1/2025 13:05,6/1/2025,Sun,13,900,15:00,MR,3,MRI BRAIN W WO,2.40',                      // 10-col legacy
    '6/2/2025 9:00,6/2/2025,Mon,9,90,1:30,CR,1,,0.30,BODY MR AM,POC Body MR',                 // blank exam
    '6/2/2025 9:20,6/2/2025,Mon,9,200,3:20,US,2,US RENAL,,BODY MR AM,',                       // blank IVU
    '6/2/2025 13:10,6/2/2025,Mon,13,780,13:00,MR,3,MRI LUMBAR SPINE WO,1.80,BODY MR PM,Chart Review',
    '6/3/2025 8:50,6/3/2025,Tue,8,300,5:00,CT,1,CT ABDOMEN PELVIS W,1.25,MAIN 8a-5p,',          // on-site shift string
  ];
  return { name: 'ragged (10/11/12-col mix, blank fields)', csv: rows.join('\n') + '\n',
           shifts: {
             '6/1/2025': 'BODY CT AM / BODY MR PM',
             '6/2/2025': 'BODY MR 8a-12:30p / POC / BODY MR 12:30p-5p / Chart Review',
             '6/3/2025': 'MAIN 8a-5p',
           }, cls: CLS, todayShift: '' };
}

// Focus fixture: today's studies with KNOWN gaps, so the idle/gap math can be
// asserted exactly. Sequence (mirrors tools prototype):
//   A 9:10 (10m) | +1m micro | B 9:16 (5m) | +10m idle | C 9:34 (8m)
//   | +12m idle | D 9:52 (6m) | +45m break | E 10:44 (7m)
// => active 36m, idle 22m (1320s) across 2 gaps; IVU 7.25 => reclaim 4.4
function focusFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras';
  const n = new Date();
  const md = (n.getUTCMonth() + 1) + '/' + n.getUTCDate() + '/' + n.getUTCFullYear();
  const dy = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n.getUTCDay()];
  const R = [
    ['9:10', 9, 600, 'MR', 'MRI BRAIN W WO', 2.40],
    ['9:16', 9, 300, 'CT', 'CT CHEST WO', 1.00],
    ['9:34', 9, 480, 'CT', 'CT ABDOMEN PELVIS W', 1.25],
    ['9:52', 9, 360, 'US', 'US ABDOMEN COMPLETE', 0.80],
    ['10:44', 10, 420, 'MR', 'MRI LUMBAR SPINE WO', 1.80],
  ];
  const rows = [HDR];
  R.forEach(([hm, hr, sec, mod, exam, ivu], i) =>
    rows.push([`${md} ${hm}`, md, dy, hr, sec, fmtSec(sec), mod, i + 1, exam, ivu.toFixed(2), '', ''].join(',')));
  return {
    name: 'focus (known gaps: 22m idle / 2 gaps)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    expect: { idle: 1320, gaps: 2, reclaim: 4.4 },
  };
}

// 13-column fixture: rows carry ActiveSec (physical-activity seconds measured
// during the study). Exercises the in-study idle path.
//   600s study, 600 active | 300s, 300 | 480s, 180 (300s drifted)
//   360s, 360 | 420s, 120 (300s drifted)  => inIdle 600s, inMeas 2160s
function activityFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec';
  const n = new Date();
  const md = (n.getUTCMonth() + 1) + '/' + n.getUTCDate() + '/' + n.getUTCFullYear();
  const dy = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n.getUTCDay()];
  const R = [
    ['9:10', 9, 600, 600, 'MR', 'MRI BRAIN W WO', 2.40],
    ['9:16', 9, 300, 300, 'CT', 'CT CHEST WO', 1.00],
    ['9:34', 9, 480, 180, 'CT', 'CT ABDOMEN PELVIS W', 1.25],
    ['9:52', 9, 360, 360, 'US', 'US ABDOMEN COMPLETE', 0.80],
    ['10:44', 10, 420, 120, 'MR', 'MRI LUMBAR SPINE WO', 1.80],
  ];
  const rows = [HDR];
  R.forEach(([hm, hr, sec, act, mod, exam, ivu], i) =>
    rows.push([`${md} ${hm}`, md, dy, hr, sec, fmtSec(sec), mod, i + 1, exam,
      ivu.toFixed(2), '', '', act].join(',')));
  return {
    name: 'activity (13-col ActiveSec: 10m drifted in-study)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    expect: { idle: 1320, gaps: 2, reclaim: 4.4, inIdle: 600, inMeas: 2160 },
  };
}

// Filler fixture: five lung screenings today, 5m each, with one 15m gap.
//   active 25m, idle 15m (900s) in 1 gap; IVU 5 x 1.2 = 6.0
//   => drift 900s / 300s each          = 3 screenings lost
//   => goal 4.0 is cleared by 2.0 IVU; ladder {4,2} puts the next rung at 8,
//      so ceil(2 / 1.2) = 2 more to reach it
function fillerFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras';
  const n = new Date();
  const md = (n.getUTCMonth() + 1) + '/' + n.getUTCDate() + '/' + n.getUTCFullYear();
  const dy = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n.getUTCDay()];
  const rows = [HDR];
  ['9:05', '9:10', '9:15', '9:35', '9:40'].forEach((hm, i) =>
    rows.push([`${md} ${hm}`, md, dy, 9, 300, fmtSec(300), 'CT', i + 1,
      'CT CHEST LUNG CANCER SCREENING WO', '1.20', '', ''].join(',')));
  return {
    name: 'filler (5 lung screenings, 15m gap, goal cleared)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    goal: 4, ladder: { b: 4, s: 2 },
    expect: { idle: 900, gaps: 1, reclaim: 3.6 },
    expectFiller: [
      'from the 5 in your log: 1.2 IVU each',
      '3 lung screenings went into drifting',
      '2 more to reach 8 +1 credit, $150',
    ],
  };
}

// Same rows, but on the REAL ladder (60 / 7) with a goal on a rung, so the
// numbers asserted here are the ones the user will actually see:
//   goal 74 = 2 credits over the 60 floor; at 6.0 IVU that is 68 IVU short,
//   ceil(68 / 1.2) = 57 screenings, worth 2 credits = 2 hours = $300.
function rungFixture() {
  const fx = fillerFixture();
  fx.name = 'rungs (real 60/7 ladder, goal 74 = 2 credits)';
  fx.goal = 74;
  delete fx.ladder;                     // fall through to the shipped default
  fx.expectFiller = ['57 more to hit 74 +2 credits, $300'];
  return fx;
}

// Rhythm fixture: 8 days whose length is EXACTLY 8h, with starts stepping
// 7:00 -> 10:30 in half hours. That makes finish = start + 8 a perfect fit, so
// the slope is 1.0 and r^2 is 100% - the "fixed length, not a fixed end" branch.
//   median start  8:45a   (median of 7, 7.5 ... 10.5)
//   median finish 4:45p   median day 8h 0m
//   finish IQR: q75 17.625 - q25 15.875 = 1.75h = 105m
// Each day is two studies: one signed 30m in (so it OPENED at the start time)
// and one signed at start + 8h.
function rhythmFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras';
  const hm = (f) => `${Math.floor(f)}:${String(Math.round((f - Math.floor(f)) * 60)).padStart(2, '0')}`;
  const rows = [HDR];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  [7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5].forEach((st, i) => {
    const d = new Date(base.getTime() - (20 - i) * 864e5);
    const md = mdy(d), dy = dow(d);
    [[st + 0.5, 1800], [st + 8, 600]].forEach(([sign, sec], k) => {
      rows.push([`${md} ${hm(sign)}`, md, dy, Math.floor(sign), sec, fmtSec(sec),
        'CT', k + 1, 'CT CHEST WO', '1.00', '', ''].join(','));
    });
  });
  return {
    name: 'rhythm (8 days, exact 8h length, slope 1.0)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    expectRhythm: ['8:45a', '4:45p', '8h 0m', '105m'],
    expectVerdict: ['fixed length', '60m earlier', '8 days, r² 100%'],
  };
}

// The opposite branch: same spread of starts, but every day ENDS at 5:00p. The
// finish has zero variance, which linfit reports as a flat fit rather than as a
// failed one - a fixed end is a finding, not missing data.
function rhythmFlatFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras';
  const hm = (f) => `${Math.floor(f)}:${String(Math.round((f - Math.floor(f)) * 60)).padStart(2, '0')}`;
  const rows = [HDR];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  [7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5].forEach((st, i) => {
    const d = new Date(base.getTime() - (20 - i) * 864e5);
    const md = mdy(d), dy = dow(d);
    [[st + 0.5, 1800], [17, 600]].forEach(([sign, sec], k) => {
      rows.push([`${md} ${hm(sign)}`, md, dy, Math.floor(sign), sec, fmtSec(sec),
        'CT', k + 1, 'CT CHEST WO', '1.00', '', ''].join(','));
    });
  });
  return {
    name: 'rhythm-flat (8 days, every day ends 5:00p, slope 0)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    expectVerdict: ['fixed end, not a fixed length', 'You finish near 5:00p',
                    'an extra hour of reading'],
  };
}

// Bank fixture: one day whose reward arithmetic is fully hand-computable.
//   10 bets, pattern W W W W W W L W W W -> 9 wins, best streak 6
//   10 studies x 7.0 IVU = 70 IVU -> credits(70) = floor((70-60)/7) = 1 rung
//
//   parPts   = 9 + 3 * floor(6/5)      = 12
//   goalPts  = 10 * 1*(1+1)/2          = 10
//   focusMul = 0.75 + 0.5 * (9/10)     = 1.20
//   points   = 12 + 10 * 1.20          = 24
//   dollars  = 24 * 0.20               = $4.80     (well under the 150 cap)
//   balance  = 4.80 - 2.00 cashed out  = $2.80
function bankFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,' +
              'ExamText,IVU,Shift,Extras,ActiveSec,ParSec';
  const n = new Date();
  const md = (n.getUTCMonth() + 1) + '/' + n.getUTCDate() + '/' + n.getUTCFullYear();
  const dy = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n.getUTCDay()];
  const win = [1, 1, 1, 1, 1, 1, 0, 1, 1, 1];
  const rows = [HDR];
  win.forEach((w, i) => {
    const mins = 10 * i;
    const hm = `${9 + Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    rows.push([`${md} ${hm}`, md, dy, 9 + Math.floor(mins / 60), 600, fmtSec(600),
      'CT', i + 1, 'CT ABDOMEN PELVIS W', '7.00', '', '', w ? 200 : 400, 300].join(','));
  });
  return {
    name: 'bank (9/10 under par, streak 6, 70 IVU = 1 rung)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '',
    cashouts: [{ d: '2026-07-20 11:04', a: 2.0, n: 'gift card' }],
    expectBank: ['$2.80', '$4.80 earned', '$2.00 taken out',
                 '12 pts', '10 pts', '1.2', '24 pts = $4.80'],
  };
}

// Same day twice - today, and an identical one five days back - with the bank
// set to open TODAY. Only today may pay, so the totals must be unchanged from
// bankFixture. Without the start filter this doubles to $9.60, which is exactly
// the retroactive back-catalogue payout the start date exists to prevent.
function bankStartFixture() {
  const fx = bankFixture();
  const n = new Date();
  const iso = n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1).padStart(2, '0') +
              '-' + String(n.getUTCDate()).padStart(2, '0');
  const old = new Date(n.getTime() - 5 * 864e5);
  const omd = (old.getUTCMonth() + 1) + '/' + old.getUTCDate() + '/' + old.getUTCFullYear();
  const ody = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][old.getUTCDay()];
  const lines = fx.csv.trim().split('\n');
  const past = lines.slice(1).map(l => {
    const v = l.split(',');
    v[0] = omd + v[0].slice(v[0].indexOf(' '));
    v[1] = omd; v[2] = ody;
    return v.join(',');
  });
  fx.name = 'bank-start (identical day 5d ago must NOT pay)';
  fx.csv = [lines[0]].concat(past, lines.slice(1)).join('\n') + '\n';
  fx.reward = { on: 1, per: 0.20, rung: 10, every: 5, bonus: 3, cap: 150, start: iso };
  fx.expectBank = ['$2.80', '$4.80 earned', '24 pts = $4.80'];
  return fx;
}

// The percentage-inverts-the-ranking case, straight from the user's example:
//   day A  goal  25, delivered 22.5  ->  90%
//   day B  goal 100, delivered 60    ->  60%
// The plain average of the percentages is 75% and says A was the better day.
// The volume-weighted aggregate is 82.5 / 125 = 66% and knows that B delivered
// nearly three times as much work. Both must be reported, and the note must
// call out which way they disagree.
function goalScaleFixture() {
  const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,' +
              'ExamText,IVU,Shift,Extras';
  const now = new Date();
  const day = (off) => new Date(now.getTime() - off * 864e5);
  const rows = [HDR];
  const goals = {};
  const push = (d, n, ivu, goal) => {
    const md = mdy(d), dy = dow(d);
    if (goal > 0) goals[md] = goal;
    for (let i = 0; i < n; i++) {
      rows.push([`${md} ${9 + i}:00`, md, dy, 9 + i, 600, fmtSec(600), 'CT', i + 1,
        'CT ABDOMEN PELVIS W', ivu.toFixed(2), '', ''].join(','));
    }
  };
  push(day(5), 3, 7.5, 25);     // 22.5 delivered against 25
  push(day(0), 4, 15.0, 100);   // 60.0 delivered against 100
  // Three plain worked days so "typical day" has 5 days behind it and the
  // goal-vs-typical comparison is not drawn from the two days it is judging.
  [7, 8, 9].forEach(function (o) { push(day(o), 4, 10.0, 0); });
  return {
    name: 'goal-scale (90% of 25 vs 60% of 100)',
    csv: rows.join('\n') + '\n', shifts: {}, cls: CLS, todayShift: '', goals: goals,
    expectGoals: ['delivered 82.5 IVU against 125 committed', '66%',
                  'flatters you', '75%'],
    expectGoalStk: ['0% goals hit', '66% delivered vs committed',
                    '75% average finish', '156% goal vs typical day'],
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runFixture(emitted, fixture) {
  const report = { charts: 0, errors: [], warnings: [], consoleErrors: [], noData: false };
  const code = buildDashboardJs(emitted, fixture);

  // syntax check via a throwaway compile in a fresh context
  try {
    new vm.Script(code, { filename: 'dashboard.generated.js' });
  } catch (e) {
    report.errors.push('SYNTAX: ' + e.message);
    return { report, code };
  }

  const sandbox = makeSandbox(report);
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { filename: 'dashboard.generated.js', timeout: 10000 });
  } catch (e) {
    report.errors.push('RUNTIME (uncaught): ' + e.message);
  }
  // capture the Today hero panel so we can confirm it populated (not silently empty)
  try {
    const hero = sandbox.document.getElementById('heroWrap');
    const grid = sandbox.document.getElementById('tGrid');
    report.todayHero = hero.innerHTML + grid.innerHTML;
    report.todayEmpty = !/heroNum|class="cd"/.test(report.todayHero);
    const gk = sandbox.document.getElementById('goalStk');
    report.goalStk = gk ? gk.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const gn = sandbox.document.getElementById('goalNote');
    report.goalNote = gn ? gn.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const cb = sandbox.document.getElementById('costBanner');
    report.costBanner = cb ? cb.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const parBox = sandbox.document.getElementById('parSum');
    report.parSummary = parBox ? parBox.innerHTML : '';
    const bkB = sandbox.document.getElementById('bkBal');
    const bkS = sandbox.document.getElementById('bkSub');
    const bkF = sandbox.document.getElementById('bkFormula');
    const bkT = sandbox.document.getElementById('bkToday');
    report.bank = [bkB && bkB.textContent, bkS && bkS.textContent,
                   bkF && bkF.innerHTML, bkT && bkT.innerHTML]
      .filter(Boolean).join(' | ').replace(/<[^>]+>/g, ' ')
      .replace(/&middot;/g, '-').replace(/&times;/g, '\u00d7')
      .replace(/\s+/g, ' ').trim();
    const rs = sandbox.document.getElementById('rhStk');
    const rv = sandbox.document.getElementById('rhVerdict');
    const rn = sandbox.document.getElementById('rhNotes');
    const flat = (n) => n ? n.innerHTML.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '-')
      .replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim() : '';
    report.rhStk = flat(rs);
    report.rhVerdict = flat(rv);
    report.rhNotes = flat(rn);
    const fb = sandbox.document.getElementById('bxFill');
    const fg = sandbox.document.getElementById('fillGrid');
    const fd = sandbox.document.getElementById('fillD');
    report.fillerShown = !!(fb && fb.style.display !== 'none');
    report.filler = report.fillerShown && fg
      ? ((fd ? fd.innerHTML : '') + ' || ' + fg.innerHTML)
        .replace(/<[^>]+>/g, ' ').replace(/&divide;/g, '/').replace(/&middot;/g, '-')
        .replace(/\s+/g, ' ').trim()
      : '';
    report.idleSec = hero.getAttribute('data-idle');
    report.gaps = hero.getAttribute('data-gaps');
    report.reclaim = hero.getAttribute('data-reclaim');
    report.inIdle = hero.getAttribute('data-inidle');
    report.inMeas = hero.getAttribute('data-inmeas');
  } catch (_) {}
  return { report, code };
}

function main() {
  const ahkText = fs.readFileSync(AHK, 'utf8');
  let emitted;
  try {
    emitted = extractEmittedStrings(ahkText);
  } catch (e) {
    console.error('[dash_harness] extraction failed: ' + e.message);
    process.exit(1);
  }
  console.log(`[dash_harness] ${path.basename(AHK)}: extracted ${emitted.length} a() strings from GenerateDashboard()`);

  const fixtures = [richFixture(), old10Fixture(), raggedFixture(), focusFixture(),
                    activityFixture(), fillerFixture(), rungFixture(), rhythmFixture(), rhythmFlatFixture(),
                    bankFixture(), bankStartFixture(), goalScaleFixture()];
  let ok = true;
  let dumpDir = null;

  for (const fx of fixtures) {
    const { report, code } = runFixture(emitted, fx);
    const problems = report.errors.length + report.consoleErrors.length;
    const status = problems ? 'FAIL' : (report.noData ? 'ok (no-data path)' : 'ok');
    console.log(`\n  [${status}] ${fx.name}`);
    console.log(`    charts rendered: ${report.charts}` +
                (report.warnings.length ? `  warnings: ${report.warnings.length}` : ''));
    if (report.todayHero !== undefined) {
      const tiles = (report.todayHero.match(/class="tLb">([^<]+)</g) || [])
        .map(s => s.replace(/class="tLb">/, '').replace(/</, ''));
      console.log(`    todayHero: ${report.todayEmpty ? 'empty-state' : 'populated'}` +
                  (tiles.length ? ` [${tiles.join(', ')}]` : '') +
                  ` (${report.todayHero.length} chars)`);
      if (report.idleSec !== undefined)
        console.log(`    focus: idle=${report.idleSec}s gaps=${report.gaps} reclaim=${report.reclaim} IVU`);
      if (report.goalNote)
        console.log('    goals: ' + report.goalNote.slice(0, 240));
      if (report.goalStk)
        console.log('    goal tiles: ' + report.goalStk.slice(0, 160));
      if (report.costBanner)
        console.log('    cost banner: ' + report.costBanner.slice(0, 120));
      if (report.parSummary)
        console.log('    par: ' + report.parSummary.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (report.filler)
        console.log('    filler: ' + report.filler.slice(0, 320));
      if (report.bank)
        console.log('    bank: ' + report.bank.slice(0, 260));
      if (report.rhStk)
        console.log('    rhythm: ' + report.rhStk.slice(0, 160));
      if (report.rhVerdict)
        console.log('    verdict: ' + report.rhVerdict.slice(0, 200));
      if (report.rhNotes)
        console.log('    start-time: ' + report.rhNotes.slice(0, 240));
    }
    // assert known-answer expectations
    if (fx.expect) {
      const chk = [
        ['idle', +report.idleSec, fx.expect.idle],
        ['gaps', +report.gaps, fx.expect.gaps],
        ['reclaim', +report.reclaim, fx.expect.reclaim],
      ];
      if (fx.expect.inIdle !== undefined) {
        chk.push(['inIdle', +report.inIdle, fx.expect.inIdle]);
        chk.push(['inMeas', +report.inMeas, fx.expect.inMeas]);
      }
      for (const [k, got, want] of chk) {
        if (Math.abs(got - want) > 0.05) {
          ok = false;
          console.log(`    ASSERT FAIL: ${k} expected ${want}, got ${got}`);
        }
      }
      if (ok) console.log('    assertions OK: ' + chk.map(c => c[0] + '=' + c[1]).join(' '));
    }
    for (const [field, key, label] of [['expectRhythm', 'rhStk', 'rhythm'],
                                       ['expectVerdict', 'rhVerdict', 'verdict'],
                                       ['expectBank', 'bank', 'bank'],
                                       ['expectGoals', 'goalNote', 'goals'],
                                       ['expectGoalStk', 'goalStk', 'goal tiles']]) {
      if (!fx[field]) continue;
      let fok = true;
      for (const want of fx[field]) {
        if (!String(report[key] || '').includes(want)) {
          ok = false; fok = false;
          console.log(`    ASSERT FAIL: ${label} missing "${want}"`);
        }
      }
      if (fok) console.log(`    ${label} assertions OK (${fx[field].length})`);
    }
    if (fx.expectFiller) {
      let fok = true;
      for (const want of fx.expectFiller) {
        if (!report.filler.includes(want)) {
          ok = false; fok = false;
          console.log(`    ASSERT FAIL: filler missing "${want}"`);
        }
      }
      if (fok) console.log(`    filler assertions OK (${fx.expectFiller.length})`);
    }
    for (const w of report.warnings) console.log('    warn: ' + w);
    for (const e of report.errors) console.log('    ERROR: ' + e);
    for (const e of report.consoleErrors) console.log('    console.error: ' + e);
    if (problems) {
      ok = false;
      // dump the generated JS for inspection
      if (!dumpDir) dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashjs-'));
      const p = path.join(dumpDir, fx.name.replace(/[^a-z0-9]+/gi, '_') + '.js');
      fs.writeFileSync(p, code);
      console.log('    (generated JS written to ' + p + ')');
    }
  }

  console.log('\n' + (ok ? 'PASS - all fixtures rendered cleanly' : 'PROBLEMS FOUND'));
  process.exit(ok ? 0 : 1);
}

main();
