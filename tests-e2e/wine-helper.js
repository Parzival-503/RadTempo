// The app (Linux build) with the REAL helper running in Wine, a stand-in
// PowerScribe in Wine, and real F4 / F12 key presses from xdotool. Proves the
// helper loads, connects over the bridge, sees pass-through keys, reads the
// exam and the order code, and that the study is logged - without Windows.
//
//   AHK_EXE=/path/AutoHotkeyU64.exe xvfb-run -a node tests-e2e/wine-helper.js
//
// Needs wine (64 and 32 bit) and xdotool. CI runs the real thing on Windows.

const { _electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { writeFixtures } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? '  ok  ' : '  FAIL ') + m);
  if (!c) fails++;
};
const winPath = (p) => 'Z:' + p.replace(/\//g, '\\');

(async () => {
  const ahk = process.env.AHK_EXE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wine-'));
  const ud = path.join(tmp, 'app');
  const dd = path.join(tmp, 'data');
  fs.mkdirSync(ud);
  writeFixtures(dd);
  // The stand-in PowerScribe: AutoHotkey renamed, running its same-named script.
  const ps = path.join(tmp, 'ps');
  fs.mkdirSync(ps);
  fs.copyFileSync(ahk, path.join(ps, 'Nuance.PowerScribe360.exe'));
  fs.copyFileSync(path.join(__dirname, 'fake_ps.ahk'), path.join(ps, 'Nuance.PowerScribe360.ahk'));

  const env = { ...process.env, RT_E2E: '1', RT_USER_DATA: ud, RT_DATA_DIR: dd, RT_SOFTWARE_GL: '1' };
  delete env.NODE_OPTIONS;
  const app = await _electron.launch({ args: ['--no-sandbox', '--disable-gpu', ROOT], env });
  let widget = null;
  for (let i = 0; i < 50 && !widget; i++) {
    widget = app.windows().find((w) => w.url().includes('/widget/'));
    await sleep(100);
  }
  await widget.waitForSelector('#clock');
  const state = () => widget.evaluate(() => rt.invoke('e2e:state'));

  const wenv = { ...process.env, WINEDEBUG: '-all', RT_HUB_DIR: winPath(ud) };
  const fake = spawn('wine', [path.join(ps, 'Nuance.PowerScribe360.exe')], { env: wenv, stdio: 'ignore' });
  const helper = spawn('wine', [ahk, '/ErrorStdOut', winPath(path.join(ROOT, 'helper', 'RadTempoHelper.ahk'))], { env: wenv, stdio: ['ignore', 'pipe', 'pipe'] });
  let hout = '';
  helper.stdout.on('data', (d) => (hout += d));
  helper.stderr.on('data', (d) => (hout += d));

  let s;
  for (let i = 0; i < 60; i++) {
    s = await state();
    if (s.helper && s.helper.connected) break;
    await sleep(500);
  }
  ok(s.helper && s.helper.connected, 'the real helper (AutoHotkey in Wine) connects over the bridge');
  await sleep(2000);

  // Wine only hears keys while one of its windows has focus; at the desk
  // that is PowerScribe anyway.
  const press = (k) => {
    try {
      execFileSync('xdotool', ['search', '--name', 'PowerScribe 360', 'windowfocus', '--sync']);
    } catch (_) {}
    execFileSync('xdotool', ['key', k]);
  };
  press('F4');
  await sleep(4000);
  s = await state();
  ok(s.view.running, 'a real F4 key press started the timer');
  ok(s.view.banner && s.view.banner.text === 'CT CHEST WITH CONTRAST', `the helper read the exam from PowerScribe (${s.view.banner && s.view.banner.text})`);
  ok(s.view.banner && s.view.banner.ivu === 1.5 && !s.view.banner.shaky, 'valued by the order code (not a guess)');
  await widget.screenshot({ path: path.join(ROOT, 'e2e-shots', '60-wine-running.png') }).catch(() => {});

  press('F12');
  await sleep(1500);
  s = await state();
  ok(!s.view.running && s.view.count === 1, 'a real F12 key press signed the study');
  const last = fs.readFileSync(path.join(dd, 'RadTempo_Log.csv'), 'utf8').trim().split('\n').pop().split(',');
  ok(last[8] === 'CT CHEST WITH CONTRAST' && last[14] === 'CTCHW' && last[15] === 'code', `logged with the order code (${last[8]} | ${last[14]} | ${last[15]})`);

  helper.kill();
  fake.kill();
  try {
    execFileSync('wineserver', ['-k']);
  } catch (_) {}
  await app.close();
  if (hout.trim()) console.log('helper output:', hout.trim().slice(0, 500));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
