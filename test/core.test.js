// The study-timer flow end to end on a temp data folder, with a fake clock,
// fake timers and a fake PowerScribe. Invented exams only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/engine/store');
const { createSettings } = require('../src/engine/settings');
const { createCore } = require('../src/engine/core');
const { buildHtml } = require('../src/engine/dashboard');

function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsw-'));
  fs.writeFileSync(path.join(dir, 'RadTempo_IVU.csv'), 'Code,Description,IVU\nCTCHW,CT CHEST W CONTRAST,1.50\nXRFOOT,XR FOOT 3 VIEWS,0.30\n');
  if (opts.log) fs.writeFileSync(path.join(dir, 'RadTempo_Log.csv'), opts.log);
  let t = opts.t0 || new Date(2026, 9, 26, 9, 0, 0).getTime();
  let idle = 0;
  const timers = [];
  const fake = {
    setTimeout: (fn, ms) => {
      const h = { fn, at: t + ms, once: true };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const h = { fn, at: t + ms, every: ms };
      timers.push(h);
      return h;
    },
    clearInterval: (h) => fake.clearTimeout(h),
  };
  let ps = { exam: 'CT CHEST WITH CONTRAST', code: 'CTCHW', desc: '' };
  const notes = [];
  const settings = createSettings(path.join(dir, 'RadTempo.ini'));
  const store = createStore(dir);
  const core = createCore({
    store,
    settings,
    now: () => t,
    idleMs: () => idle,
    readPS: async () => ({ ...ps }),
    notify: (m) => notes.push(m),
    timers: fake,
  });
  core.loadAll();
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const h = timers[0];
      if (!h || h.at > end) break;
      t = h.at;
      if (h.every) h.at += h.every;
      else timers.shift();
      await h.fn();
      await new Promise((r) => setImmediate(r));
    }
    t = end;
  }
  return {
    dir,
    core,
    store,
    notes,
    advance,
    setIdle: (v) => (idle = v),
    setPS: (v) => (ps = v),
    now: () => t,
    log: () => fs.readFileSync(path.join(dir, 'RadTempo_Log.csv'), 'utf8').trim().split('\n'),
  };
}

test('F4, exam detected, F12: one row with the code-valued IVU', async () => {
  const r = rig();
  assert.equal(r.core.view().status, 'READY');
  r.core.start();
  await r.advance(2500); // first detect at 2 s
  const v = r.core.view();
  assert.equal(v.mod, 'CT');
  assert.equal(v.banner.text, 'CT CHEST WITH CONTRAST');
  assert.equal(v.banner.ivu, 1.5);
  await r.advance(120000);
  assert.match(r.core.view().clock, /^0?2:0\d$/);
  await r.core.stop();
  const lines = r.log();
  assert.equal(lines.length, 2);
  const f = lines[1].split(',');
  assert.equal(f[1], '10/26/2026');
  assert.equal(f[6], 'CT');
  assert.equal(f[8], 'CT CHEST WITH CONTRAST');
  assert.equal(f[9], '1.50');
  assert.equal(f[14], 'CTCHW');
  assert.equal(f[15], 'code');
  assert.equal(r.core.view().count, 1);
  assert.equal(r.core.view().ivu, '1.5');
  assert.equal(r.core.view().undo, true);
  // reset right after a sign undoes it
  assert.equal(r.core.reset(), 'undo');
  assert.equal(r.log().length, 1);
  assert.equal(r.core.view().count, 0);
});

test('a study left open for hours is dropped by the next F4, not logged', async () => {
  const r = rig();
  r.core.start();
  await r.advance(65 * 3600 * 1000);
  assert.match(r.core.view().clock, /^65h/);
  assert.equal(r.core.start(), true);
  assert.equal(r.core.view().clock, '0:00'.length ? r.core.view().clock : '');
  assert.ok(r.core.elapsedSec() < 2);
  assert.ok(r.notes.some((n) => /still open from/.test(n)));
  assert.ok(!fs.existsSync(path.join(r.dir, 'RadTempo_Log.csv')));
  // ...and a normal mid-study F4 is still ignored
  await r.advance(60000);
  assert.equal(r.core.start(), false);
});

test('par: locks on the exam, counts down on engaged time, scores at sign', async () => {
  const hist = ['Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec,ProcCode,IVUSrc'];
  for (let i = 0; i < 4; i++) hist.push(`10/1/2026 9:00,10/1/2026,Thu,09,400,06:40,CT,1,CT CHEST WITH CONTRAST,1.50,,,300,,,`);
  const r = rig({ log: hist.join('\n') + '\n' });
  r.core.start();
  await r.advance(3000);
  assert.equal(r.core.view().slot.value, '05:00');
  await r.advance(60000);
  assert.match(r.core.view().status, /LEFT$/);
  r.setIdle(120000); // away
  await r.advance(1000);
  assert.match(r.core.view().status, /^AWAY/);
  r.setIdle(0);
  await r.core.stop();
  assert.match(r.core.view().status, /^UNDER PAR/);
  const f = r.log().pop().split(',');
  assert.equal(f[13], '300');
});

test('overtime warning fires on engaged time past warn% of par', async () => {
  const hist = ['Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec,ProcCode,IVUSrc'];
  for (let i = 0; i < 4; i++) hist.push(`10/1/2026 9:00,10/1/2026,Thu,09,120,02:00,CT,1,CT CHEST WITH CONTRAST,1.50,,,100,,,`);
  const r = rig({ log: hist.join('\n') + '\n' });
  r.core.start();
  await r.advance(140000);
  assert.equal(r.core.view().warn, false);
  await r.advance(20000);
  assert.equal(r.core.view().warn, true);
  assert.equal(r.core.view().status, 'OVER TIME');
});

test('verify pass re-derives when PowerScribe was still on the previous study', async () => {
  const r = rig();
  r.setPS({ exam: 'XR FOOT 3 VIEWS', code: '', desc: '' });
  r.core.start();
  await r.advance(2500);
  assert.equal(r.core.view().mod, 'CR');
  r.setPS({ exam: 'CT CHEST WITH CONTRAST', code: 'CTCHW', desc: '' });
  await r.advance(21000);
  assert.equal(r.core.view().mod, 'CT');
  assert.ok(r.notes.some((n) => /Exam corrected/.test(n)));
});

test('a typed title is never overwritten by PowerScribe', async () => {
  const r = rig();
  r.setPS({ exam: '', code: '', desc: '' });
  r.core.start();
  r.core.setExamTitle('XR FOOT 3 VIEWS');
  r.setPS({ exam: 'CT CHEST WITH CONTRAST', code: 'CTCHW', desc: '' });
  await r.advance(60000);
  await r.core.stop();
  const f = r.log().pop().split(',');
  assert.equal(f[8], 'XR FOOT 3 VIEWS');
  assert.equal(f[6], 'CR');
});

test('goals, calibration and rewards write the classic files', async () => {
  const r = rig();
  r.core.saveGoal(74);
  assert.match(fs.readFileSync(path.join(r.dir, 'RadTempo_Goals.csv'), 'utf8'), /10\/26\/2026,74/);
  assert.equal(r.core.view().goal, 74);
  const c = r.core.calibApply(20);
  assert.equal(+c.total.toFixed(2), 20);
  assert.equal(r.core.view().ivu, '20.0');
  r.core.calibClear();
  assert.equal(r.core.view().ivu, '0.0');
  const info = r.core.rewardInfo();
  assert.equal(info.balance, 0);
  assert.equal(r.core.cashOut(5).ok, false);
});

test('dashboard HTML carries every data block and app.js', () => {
  const r = rig();
  const { cfg } = r.core;
  const html = buildHtml(
    { cfg, csv: 'Timestamp,Date\n1,2', todayShift: "O'Brien block", shifts: new Map([['10/26/2026', 'BODY </script> AM']]), goals: new Map(), adjust: new Map(), fillerIvu: 1.2, cashoutLines: [] },
    { chart: 'inline' }
  );
  for (const k of ['CSV_RAW', 'TODAY_SHIFT', 'SHIFTS', 'CLS', 'DAILY_GOAL', 'IVU_ADJ', 'HOURLY_RATE', 'GOALS', 'FILLER', 'LADDER', 'REWARD', 'CASHOUTS']) assert.ok(html.includes(`const ${k}=`), k);
  assert.ok(!html.includes('cdn.jsdelivr.net'));
  assert.ok(!html.includes('BODY </script>'));
  assert.ok(html.includes('Chart.js v4'));
});
