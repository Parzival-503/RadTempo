// End-to-end test of the real app: every window, every dialog, a full study.
//
// Linux / cloud (default): the app runs under a virtual screen and this script
// plays the AutoHotkey helper over the bridge (F4, F12, PowerScribe reads).
// Windows CI (RT_APP_EXE set): the packaged app runs with its REAL compiled
// helper; real F4 / F12 key presses are injected with AutoHotkey and the
// exam is read from a stand-in PowerScribe window (tests-e2e/fake_ps.ahk).
//
// Screenshots land in e2e-shots/. Exits non-zero on the first failure.

const { _electron } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { writeFixtures } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'e2e-shots');
const WIN = !!process.env.RT_APP_EXE;
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (c, msg) => {
  if (c) console.log('  ok  ' + msg);
  else {
    failures++;
    console.log('  FAIL ' + msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ userData, dataDir, extraEnv = {} }) {
  const env = { ...process.env, RT_E2E: '1', RT_USER_DATA: userData, ...extraEnv };
  if (dataDir) env.RT_DATA_DIR = dataDir;
  delete env.NODE_OPTIONS;
  if (!WIN) env.RT_SOFTWARE_GL = '1';
  const opts = WIN ? { executablePath: process.env.RT_APP_EXE, args: [], env } : { args: ['--no-sandbox', '--disable-gpu', ROOT], env };
  const app = await _electron.launch({ ...opts, timeout: 60000 });
  app.process().stdout.on('data', (d) => process.env.RT_VERBOSE && process.stdout.write('    app: ' + d));
  return app;
}

async function win(app, pred, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const w of app.windows()) {
      try {
        if (pred(w.url())) return w;
      } catch (_) {}
    }
    await sleep(100);
  }
  return null;
}

async function shot(page, name) {
  if (!page) return;
  try {
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  } catch (e) {
    console.log('    (screenshot failed: ' + e.message + ')');
  }
}

// Esc closes a dialog before the key press call returns.
const esc = (page) => page.keyboard.press('Escape').catch(() => {});

const isWidget = (u) => u.includes('/widget/');
const isMenu = (u) => u.includes('/menu/');
const isPanel = (v) => (u) => u.includes('/panel/') && u.includes('view=' + v);

// ---------------------------------------------------------------- fake helper

function fakeHelper(userData) {
  const ini = fs.readFileSync(path.join(userData, 'bridge.ini'), 'utf8');
  const port = +ini.match(/Port=(\d+)/)[1];
  const token = ini.match(/Token=(\w+)/)[1];
  const st = { idle: 0, ps: { exam: '', code: '', desc: '' }, stop: false, reads: 0, cmds: [] };
  const req = (method, p, body = '') =>
    new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'X-RT-Token': token } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve(t));
      });
      r.on('error', () => resolve(''));
      r.end(body);
    });
  const fields = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');
  (async function loop() {
    while (!st.stop) {
      const text = await req('GET', `/poll?idle=${st.idle}&classic=0`);
      for (const cmd of text.split('\n').filter(Boolean)) {
        st.cmds.push(cmd);
        const [name, id] = cmd.split(':');
        if (name === 'read') {
          st.reads++;
          await req('POST', `/reply?id=${id}`, fields(st.ps));
        } else if (name === 'rows') {
          await req('POST', `/reply?id=${id}`, fields({ rows: 'Doe\\tCTCHW\\tCT CHEST WITH CONTRAST\\nRoe\\tXRCH2V\\tXR CHEST 2 VIEWS\\nPoe\\t\\tMRI BRAIN WITHOUT AND WITH CONTRAST' }));
        } else if (name === 'diag') {
          await req('POST', `/reply?id=${id}`, fields({ text: 'PACS WINDOW DIAGNOSTIC\\nProcess: fake.exe\\nNo SysListView32 controls found.' }));
        }
      }
      await sleep(250);
    }
  })();
  return {
    st,
    key: (k, f = {}) => req('POST', `/key?k=${k}`, fields(f)),
  };
}

// ---------------------------------------------------------------- the test

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-e2e-'));
  const userData = path.join(tmp, 'app');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(userData, { recursive: true });
  const fx = writeFixtures(dataDir);
  console.log(`fixtures: ${fx.studies} invented studies in ${dataDir}`);

  const app = await launch({ userData, dataDir });
  const errors = [];
  app.on('window', (w) => {
    w.on('pageerror', (e) => errors.push(`${w.url()}: ${e.message}`));
    w.on('console', (m) => m.type() === 'error' && errors.push(`${w.url()}: ${m.text()}`));
  });
  for (const w of app.windows()) w.on('pageerror', (e) => errors.push(`${w.url()}: ${e.message}`));

  console.log('widget');
  const widget = await win(app, isWidget);
  ok(!!widget, 'the widget window opened');
  await widget.waitForSelector('#clock');
  await sleep(800);
  const state = () => widget.evaluate(() => rt.invoke('e2e:state'));
  let s = await state();
  ok(s && s.view.status === 'READY', 'idle widget says READY');
  ok(s.view.count === 0, 'no studies yet today');
  await shot(widget, '01-widget-idle');

  let helper = null;
  if (!WIN) {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(userData, 'bridge.ini')); i++) await sleep(100);
    helper = fakeHelper(userData);
    await sleep(800);
    s = await state();
    ok(s.helper.connected, 'the (stand-in) helper is connected over the bridge');
  }

  console.log('a study: F4, exam read from PowerScribe, F12');
  let fakePS = null;
  if (!WIN) {
    helper.st.ps = { exam: 'CT CHEST WITH CONTRAST', code: 'CTCHW', desc: '' };
    await helper.key('start');
  } else {
    // A stand-in PowerScribe (compiled as Nuance.PowerScribe360.exe) for the
    // real helper to read, then a real F4.
    fakePS = spawn(process.env.RT_FAKE_PS, [], { detached: true, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      s = await state();
      if (s.helper && s.helper.connected) break;
      await sleep(500);
    }
    ok(s.helper && s.helper.connected, 'the real helper started and is connected');
    await sleep(1500);
    await injectKeys('start');
  }
  await sleep(3200);
  s = await state();
  ok(s.view.running, 'F4 started the timer');
  ok(s.view.mod === 'CT', 'modality detected from the exam text');
  ok(s.view.banner && /CT CHEST/.test(s.view.banner.text), 'exam banner shows the exam');
  ok(s.view.slot.label === 'PAR' && s.view.slot.value !== '--', `par is on screen (${s.view.slot.value})`);
  await shot(widget, '02-widget-running');

  if (!WIN) {
    helper.st.idle = 120000;
    await sleep(1200);
    s = await state();
    ok(/^AWAY/.test(s.view.status), 'away from the keyboard shows AWAY');
    await shot(widget, '03-widget-away');
    helper.st.idle = 0;
  }

  // the par popover from the PAR slot
  await widget.click('#slot');
  const par = await win(app, isPanel('par'));
  ok(!!par, 'clicking PAR opens Set par');
  if (par) {
    await par.waitForSelector('.bigpar');
    await sleep(300);
    await shot(par, '10-panel-par');
    await par.click('[data-d="60"]');
    await sleep(300);
    s = await state();
    ok(s.view.parAdjust === 60, 'par moved +1:00');
    await esc(par);
  }

  if (!WIN) await helper.key('stop', { exam: 'CT CHEST WITH CONTRAST', code: 'CTCHW', desc: '' });
  else await injectKeys('stop');
  await sleep(800);
  s = await state();
  ok(!s.view.running && s.view.phase === 'signed', 'F12 signed the study');
  ok(s.view.count === 1, 'today counts one study');
  ok(s.view.undo === true, 'the reset button offers undo');
  const log = fs.readFileSync(path.join(dataDir, 'RadTempo_Log.csv'), 'utf8').trim().split('\n');
  const last = log[log.length - 1].split(',');
  ok(last[8] === 'CT CHEST WITH CONTRAST' && last[9] === '1.50' && last[14] === 'CTCHW' && last[15] === 'code', 'the log row: exam, IVU from the order code');
  await shot(widget, '04-widget-signed');

  if (fakePS) {
    try {
      process.kill(fakePS.pid);
    } catch (_) {}
  }

  console.log('menu');
  await widget.dispatchEvent('#card', 'contextmenu', { clientX: 40, clientY: 60 });
  const menu = await win(app, isMenu);
  ok(!!menu, 'right-click opens the menu');
  await menu.waitForSelector('.item');
  await sleep(400);
  await shot(menu, '20-menu');
  const labels = await menu.$$eval('.view:not(.leaving) .item .lb', (els) => els.map((e) => e.textContent));
  const quitBtn = await menu.$('.view:not(.leaving) .bb[title="Quit RadTempo"]');
  ok(labels.includes('Dashboard') && labels.includes('Settings') && !!quitBtn, 'menu lists Dashboard ... Settings, and Quit');
  await menu.click('.item:has-text("Daily goal")');
  await sleep(450);
  await shot(menu, '21-menu-goal');
  await menu.click('.item:has-text("74 IVU")');
  await sleep(500);
  s = await state();
  ok(s.view.goal === 74, 'picking a rung sets the goal (menu stays open)');
  await shot(menu, '22-menu-goal-set');
  await menu.keyboard.press('ArrowLeft');
  await sleep(400);
  await menu.click('.item:has-text("Settings")');
  await sleep(400);
  await shot(menu, '23-menu-settings');
  await menu.click('.item:has-text("Wellness")');
  await sleep(400);
  await shot(menu, '24-menu-wellness');
  await menu.click('.item:has-text("Preview a nudge")');
  const card = await win(app, (u) => u.includes('/card/'));
  ok(!!card, 'wellness card opens');
  await sleep(700);
  await shot(card, '30-wellness-card');

  const openFromMenu = async (path_) => {
    await widget.dispatchEvent('#card', 'contextmenu', { clientX: 40, clientY: 60 });
    await sleep(400);
    for (const p of path_) {
      await menu.click(`.view:not(.leaving) .item:has-text("${p}")`);
      await sleep(380);
    }
  };

  const panelShots = [
    [['Daily goal', 'Set today'], 'goal', '11-panel-goal'],
    [["Correct today"], 'calib', '12-panel-calib'],
    [['Rewards', "Today's reward"], 'rewards', '13-panel-rewards'],
    [['Shifts', "Today's shift"], 'shiftToday', '14-panel-shift-today'],
    [['Shifts', 'View schedule'], 'shiftView', '15-panel-schedule'],
    [['Data & tools', 'Helper status'], 'status', '16-panel-status'],
    [['Settings', 'All settings'], 'settings', '17-panel-settings'],
    [['Data & tools', 'Remove outliers'], null, null],
  ];
  for (const [p, view, name] of panelShots) {
    await openFromMenu(p);
    if (!view) continue;
    const w = await win(app, isPanel(view));
    ok(!!w, `${p.join(' > ')} opens its dialog`);
    if (!w) continue;
    await sleep(500);
    await shot(w, name);
    if (view === 'settings') {
      for (const tab of ['Par', 'Goals', 'Rewards', 'Schedule', 'Data']) {
        await w.click(`.tabs [data-t="${tab}"]`);
        await sleep(250);
        await shot(w, `17-panel-settings-${tab.toLowerCase()}`);
      }
      await w.click('.tabs [data-t="Goals"]');
      await sleep(200);
      const inp = await w.$('.set[data-k="GoalStep"] input');
      await inp.fill('8');
      await inp.press('Tab');
      await sleep(400);
      ok(/GoalStep=8/.test(fs.readFileSync(path.join(dataDir, 'RadTempo.ini'), 'utf8')), 'a setting is saved to RadTempo.ini');
      await inp.fill('7');
      await inp.press('Tab');
      await sleep(300);
    }
    if (view === 'goal') {
      await w.fill('#g', '81');
      await w.click('.pf .primary');
      await sleep(400);
      s = await state();
      ok(s.view.goal === 81, 'the goal dialog saves the goal');
    } else await esc(w);
    await sleep(300);
  }
  // outliers confirm (fixtures may or may not have any; either dialog is fine)
  const conf = (await win(app, isPanel('confirm'), 2500)) || (await win(app, isPanel('message'), 2500));
  ok(!!conf, 'Remove outliers answers with a dialog');
  if (conf) {
    await sleep(300);
    await shot(conf, '18-panel-outliers');
    await esc(conf);
  }

  console.log('widget buttons');
  await widget.click('#ivuStat');
  const bd = await win(app, isPanel('breakdown'));
  ok(!!bd, 'clicking IVU opens the breakdown');
  if (bd) {
    await sleep(400);
    await shot(bd, '19-panel-breakdown');
    await esc(bd);
  }
  await widget.click('#aForecast');
  const fc = WIN ? null : await win(app, isPanel('forecast'));
  if (WIN) {
    const m = await win(app, isPanel('message'));
    ok(!!m, 'the forecast button answers (no PACS worklist on the build machine)');
    if (m) await esc(m);
  }
  if (!WIN) ok(!!fc, 'the forecast button reads the worklist and shows a forecast');
  if (fc) {
    await sleep(400);
    await shot(fc, '24-panel-forecast');
    const t = await fc.textContent('.list');
    ok(/CT CHEST WITH CONTRAST/.test(t) && /MRI BRAIN/.test(t), 'forecast lists the selected studies');
    await esc(fc);
  }
  await widget.click('#aPaste');
  const pp = await win(app, isPanel('paste'));
  ok(!!pp, 'the paste button opens the paste forecast');
  if (pp) {
    await pp.fill('#t', 'Doe  CT HEAD WITHOUT CONTRAST 10/29/2026\nRoe  US ABDOMEN COMPLETE');
    await sleep(200);
    await shot(pp, '25-panel-paste');
    await pp.click('.pf .primary');
    const fc2 = await win(app, isPanel('forecast'));
    ok(!!fc2, 'pasted text becomes a forecast');
    if (fc2) await esc(fc2);
  }

  if (!WIN) {
    console.log('a second study, cancelled with reset');
    helper.st.ps = { exam: 'XR CHEST 2 VIEWS', code: 'XRCH2V', desc: '' };
    await helper.key('start');
    await sleep(2600);
    s = await state();
    ok(s.view.running && s.view.mod === 'CR', 'second study detected as CR');
    // A slow click: pressed, held while the widget redraws (once a second),
    // then released. It used to be lost, so reset took several tries.
    {
      const r = await widget.$eval('#aReset', (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
      await widget.mouse.move(r.x, r.y);
      await widget.mouse.down();
      await sleep(1300);
      await widget.mouse.up();
    }
    await sleep(400);
    s = await state();
    ok(!s.view.running && s.view.count === 1, 'reset cancels the study without logging it, even with a slow click across a redraw');
  }

  console.log('dashboard');
  await openFromMenu(['Dashboard']);
  const dash = await win(app, (u) => u.endsWith('RadTempo_Dashboard.html'), 10000);
  ok(!!dash, 'the dashboard window opens');
  if (dash) {
    await dash.waitForLoadState('load');
    await sleep(2500);
    const err = await dash.evaluate(() => document.body.innerText.includes('Dashboard error'));
    ok(!err, 'the dashboard renders without its error banner');
    const charts = await dash.evaluate(() => document.querySelectorAll('canvas').length);
    ok(charts > 3, `the dashboard draws its charts (${charts})`);
    await shot(dash, '40-dashboard');
  }

  if (helper) helper.st.stop = true;
  await app.close();
  if (WIN) return finish(errors);

  console.log('first run: the welcome screen finds the classic history');
  const home = path.join(tmp, 'home');
  const classic = path.join(home, 'OneDrive - Example', 'Script Vault', 'RadTempo');
  writeFixtures(classic);
  const ud2 = path.join(tmp, 'app2');
  fs.mkdirSync(ud2, { recursive: true });
  const app2 = await launch({ userData: ud2, extraEnv: { HOME: home, USERPROFILE: home } });
  app2.on('window', (w) => w.on('pageerror', (e) => errors.push(`${w.url()}: ${e.message}`)));
  const wel = await win(app2, isPanel('welcome'), 10000);
  ok(!!wel, 'first run shows the welcome screen');
  if (wel) {
    await wel.waitForSelector('.found');
    await sleep(500);
    await shot(wel, '50-welcome');
    ok(/Script Vault/.test(await wel.textContent('.found')), 'it found the classic folder in OneDrive');
    await wel.click('#use');
    await sleep(800);
    const w2 = await win(app2, isWidget);
    const s2 = await w2.evaluate(() => rt.invoke('e2e:state'));
    ok(s2 && !(await win(app2, isPanel('welcome'), 500)), 'choosing it closes the welcome screen');
    const loc = JSON.parse(fs.readFileSync(path.join(ud2, 'location.json'), 'utf8'));
    ok(loc.dataDir === classic && !!loc.setUp, 'the data folder now points at the classic history');
  }
  await app2.close();
  return finish(errors);
}

function finish(errors) {
  const real = errors.filter((e) => !/Autofill|DevTools|favicon/.test(e));
  ok(real.length === 0, 'no page errors' + (real.length ? ':\n      ' + real.join('\n      ') : ''));
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

// Windows: real key presses through AutoHotkey (tests-e2e/inject.ahk).
function injectKeys(which) {
  return new Promise((resolve) => {
    execFile(process.env.AHK_EXE, [path.join(__dirname, 'inject.ahk'), which], { timeout: 20000 }, () => resolve());
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
