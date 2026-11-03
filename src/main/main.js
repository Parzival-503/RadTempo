// RadTempo - Electron main process.
//
//  - widget: the always-on-top timer, never focused (dictation stays in
//    PowerScribe), click-through outside the card;
//  - menu: one designed menu, from the tray icon and from right-clicking the
//    widget; submenus slide in place;
//  - panels: every dialog (par, goal, forecast, calibration, rewards, shifts,
//    settings...) is one styled window type showing a named view;
//  - toast + wellness card: small never-focused windows above the widget;
//  - helper: the AutoHotkey part (F4/F12, PowerScribe, PACS, idle time),
//    started and kept alive by helper-supervisor.js;
//  - core: the study-timer logic itself (src/engine/core.js).

const { app, BrowserWindow, Tray, Menu, screen, shell, clipboard, ipcMain, nativeImage, nativeTheme, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { createStore, FILES, adoptEarlier, earlierLeft } = require('../engine/store');
const { createSettings, FIELDS } = require('../engine/settings');
const { createCore } = require('../engine/core');
const { buildHtml } = require('../engine/dashboard');
const U = require('../engine/util');
const { createBridge, parseFields } = require('./bridge');
const { createSupervisor } = require('./helper-supervisor');
const { createDataFolder, candidates, describe, importFrom } = require('./data-folder');
const { buildMenu, menuHeader } = require('./menu-model');

const E2E = !!process.env.RT_E2E;
const PREFERRED_PORT = 47821;
const LOGIN_ARGS = ['--at-login'];
const AT_LOGIN = process.argv.includes('--at-login');

if (process.env.RT_USER_DATA) app.setPath('userData', process.env.RT_USER_DATA);
if (process.env.RT_SOFTWARE_GL) app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('studio.avecina.radtempo');

const ROOT = path.join(__dirname, '..', '..');
const UI = path.join(ROOT, 'src', 'ui');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const appDir = () => app.getPath('userData');
const helperDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'helper') : path.join(ROOT, 'helper'));

// Card geometry. The window is larger than the card: room for the soft
// shadow and for the exam banner that sits above it.
const CARD_W = 284;
const CARD_H = 92;
const PAD = 12;
const BANNER = 28;
const WIN_W = CARD_W + PAD * 2;
const WIN_H = CARD_H + PAD * 2 + BANNER;

let folder;
let store;
let settings;
let core;
let bridge;
let supervisor;
let tray;
let widget;
let toastWin;
let cardWin;
let menuWin;
let dashWin;
const panels = new Map(); // view -> BrowserWindow
let helperIdle = null; // ms, from the helper's last poll
let helperIdleAt = 0;
let classicRunning = false;
let classicWarned = false;
let local = {};
let lastPush = 0;
const events = [];

// Also kept in %APPDATA%\RadTempo\radtempo.log (about the last
// 200 KB) so a problem at the workstation can be read afterwards. Only app
// events: no exam text or patient details are written.
const NOISY = new Set(['quiet', 'toast', 'pick', 'panel', 'widget', 'menu']);
function logEvent(type, detail = '') {
  events.push({ t: Date.now(), type, detail });
  if (events.length > 80) events.shift();
  if (E2E) console.log(`RT ${type} ${detail}`);
  if (NOISY.has(type)) return;
  try {
    const f = path.join(app.getPath('userData'), 'radtempo.log');
    try {
      if (fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old');
    } catch (_) {}
    fs.appendFileSync(f, `${new Date().toISOString()} ${type} ${String(detail).slice(0, 800)}\r\n`);
  } catch (_) {}
}

// ---------------------------------------------------------------- local state

const localFile = () => path.join(appDir(), 'local.json');
function loadLocal() {
  try {
    local = JSON.parse(fs.readFileSync(localFile(), 'utf8'));
  } catch (_) {
    local = {};
  }
}
function saveLocal() {
  try {
    fs.writeFileSync(localFile(), JSON.stringify(local, null, 2));
  } catch (_) {}
}

// ---------------------------------------------------------------- idle time

// Physical keyboard/mouse idle time. The helper's A_TimeIdlePhysical ignores
// keys sent by other scripts; without the helper, Windows' own idle time.
function idleMs() {
  if (helperIdle != null && Date.now() - helperIdleAt < 3000) return helperIdle + (Date.now() - helperIdleAt);
  try {
    return require('electron').powerMonitor.getSystemIdleTime() * 1000;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------- PowerScribe

async function readPS() {
  if (!bridge || !supervisor || !supervisor.status().connected) return { exam: '', code: '', desc: '' };
  const text = await bridge.ask('read', 4000);
  if (text == null) return { exam: '', code: '', desc: '' };
  const f = parseFields(text);
  return { exam: f.exam || '', code: f.code || '', desc: f.desc || '' };
}

async function fetchText(url) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from QGenda`);
  return res.text();
}

// ---------------------------------------------------------------- windows

function baseWin(opts) {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    ...opts,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, ...(opts.webPreferences || {}) },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setMenu(null);
  return w;
}

function rightmostCorner() {
  const ds = screen.getAllDisplays();
  const d = ds.reduce((a, b) => (b.workArea.x + b.workArea.width > a.workArea.x + a.workArea.width ? b : a), ds[0]);
  const wa = d.workArea;
  return { x: wa.x + wa.width - CARD_W - 18, y: wa.y + wa.height - CARD_H - 18 };
}

function onScreen(p) {
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return p.x >= b.x - 10 && p.x < b.x + b.width - 40 && p.y >= b.y - 10 && p.y < b.y + b.height - 20;
  });
}

// Card top-left on screen.
function cardPos() {
  const p = local.card;
  if (p && onScreen(p)) return p;
  return rightmostCorner();
}

function placeWidget(p) {
  if (!widget) return;
  widget.setBounds({ x: Math.round(p.x - PAD), y: Math.round(p.y - PAD - BANNER), width: WIN_W, height: WIN_H });
}

function cardRect() {
  if (!widget) return rightmostCorner();
  const b = widget.getBounds();
  return { x: b.x + PAD, y: b.y + PAD + BANNER, width: CARD_W, height: CARD_H };
}

function createWidget() {
  widget = baseWin({ width: WIN_W, height: WIN_H, focusable: false, title: 'RadTempo' });
  placeWidget(cardPos());
  widget.setIgnoreMouseEvents(true, { forward: true });
  widget.loadFile(path.join(UI, 'widget', 'index.html'));
  widget.webContents.on('did-finish-load', () => {
    pushState(true);
    if (local.hidden !== true) widget.showInactive();
  });
  // Right-click on the card opens the menu; Windows' own window menu never.
  widget.on('system-context-menu', (e) => e.preventDefault());
  widget.on('closed', () => (widget = null));
}

const startedAt = Date.now();

// The helper is the only thing that sees F4 / F12. If it is not running the
// timer must say so, or a whole day goes unlogged without a word.
function helperDown() {
  if (process.platform !== 'win32' || process.env.RT_NO_HELPER) return false;
  if (Date.now() - startedAt < 10000) return false;
  return !(supervisor && supervisor.status().connected);
}

function pushState(force) {
  if (!core) return;
  const v = core.view();
  v.helperDown = helperDown();
  if (widget && !widget.isDestroyed()) widget.webContents.send('w:state', v);
  const now = Date.now();
  if (tray && (force || now - lastPush > 1000)) {
    lastPush = now;
    tray.setToolTip(core.trayTip());
  }
  // Open panels that show live numbers follow along.
  for (const [view, w] of panels) if (!w.isDestroyed() && (view === 'par' || view === 'breakdown')) w.webContents.send('p:live', panelData(view));
}

// ------------------------------------------------ toast (never focused, click-through)

function toast(text, ms = 2600, tone = '') {
  if (tone === 'quiet') return logEvent('quiet', text);
  logEvent('toast', text);
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = baseWin({ width: 360, height: 120, focusable: false });
    toastWin.setIgnoreMouseEvents(true);
    toastWin.loadFile(path.join(UI, 'toast', 'index.html'));
    toastWin.webContents.once('did-finish-load', () => toast(text, ms, tone));
    return;
  }
  const r = cardRect();
  const wa = screen.getDisplayMatching(r).workArea;
  let x = Math.round(r.x + r.width / 2 - 180);
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - 364));
  let y = r.y - BANNER - 120;
  const below = y < wa.y;
  if (below) y = r.y + r.height + 4;
  toastWin.setBounds({ x, y, width: 360, height: 120 });
  toastWin.webContents.send('t:show', { text, ms, tone, below });
  toastWin.showInactive();
}

// ------------------------------------------------ wellness card

function onWellness(ev, view) {
  if (ev === 'hide') {
    clearInterval(cardTimer);
    if (cardWin && !cardWin.isDestroyed()) {
      cardWin.webContents.send('c:hide');
      setTimeout(() => cardWin && !cardWin.isDestroyed() && !core.wellness.isOpen() && cardWin.hide(), 350);
    }
    return;
  }
  if (!cardWin || cardWin.isDestroyed()) {
    cardWin = baseWin({ width: 380, height: 230, focusable: false });
    cardWin.loadFile(path.join(UI, 'card', 'index.html'));
    cardWin.webContents.once('did-finish-load', () => onWellness('show', core.wellness.cardView()));
    return;
  }
  const r = cardRect();
  const wa = screen.getDisplayMatching(r).workArea;
  let x = Math.round(r.x + r.width / 2 - 190);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - 388));
  let y = r.y - BANNER - 230;
  if (y < wa.y + 8) y = r.y + r.height + 8;
  cardWin.setBounds({ x, y, width: 380, height: 230 });
  cardWin.webContents.send('c:view', view);
  cardWin.showInactive();
  clearInterval(cardTimer);
  cardTimer = setInterval(() => {
    const v = core.wellness.cardTick();
    if (v && cardWin && !cardWin.isDestroyed()) cardWin.webContents.send('c:view', v);
    if (!v) clearInterval(cardTimer);
  }, 250);
}
let cardTimer = null;

// ------------------------------------------------ the menu

let menuOpenedAt = 0;
let menuRestoreFocus = false;

function menuCtx() {
  const goal = core.goalInfo();
  return {
    view: core.view(),
    goal,
    cfg: core.cfg,
    reward: core.rewardInfo(),
    widgetVisible: !!(widget && widget.isVisible()),
    helper: supervisor ? supervisor.status() : { connected: false },
    startWithWindows: loginOn(),
  };
}

function openMenu(at, from = 'widget') {
  const ctx = menuCtx();
  const data = { header: menuHeader(ctx), items: buildMenu(ctx), from };
  const W = 312;
  const H = 640;
  if (!menuWin || menuWin.isDestroyed()) {
    menuWin = baseWin({ width: W, height: H, focusable: true, title: 'RadTempo menu' });
    menuWin.loadFile(path.join(UI, 'menu', 'index.html'));
    menuWin.on('blur', () => {
      // A click elsewhere closes it (and that click already chose where focus goes).
      if (Date.now() - menuOpenedAt > 150) closeMenu(false);
    });
    menuWin.webContents.once('did-finish-load', () => openMenu(at, from));
    return;
  }
  const p = at || screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(p).workArea;
  let x = p.x - 8;
  let y = p.y - 8;
  if (x + W > wa.x + wa.width) x = p.x - W + 8;
  if (y + H > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - H);
  x = Math.max(wa.x, x);
  menuWin.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H });
  // The page anchors the panel to the top or bottom so it sits at the cursor.
  data.anchor = y + H >= wa.y + wa.height - 2 && p.y > wa.y + wa.height / 2 ? 'bottom' : 'top';
  data.cursorY = p.y - y;
  lastMenuCursorY = data.cursorY;
  menuWin.webContents.send('m:data', data);
  menuOpenedAt = Date.now();
  menuWin.show();
  menuWin.focus();
  logEvent('menu', from);
}

function refreshMenu() {
  if (!menuWin || menuWin.isDestroyed() || !menuWin.isVisible()) return;
  const ctx = menuCtx();
  menuWin.webContents.send('m:data', { header: menuHeader(ctx), items: buildMenu(ctx), keep: true, cursorY: lastMenuCursorY });
}
let lastMenuCursorY = 8;

function closeMenu(restore = true) {
  if (!menuWin || menuWin.isDestroyed() || !menuWin.isVisible()) return;
  menuWin.webContents.send('m:reset');
  menuWin.hide();
  // Give the keyboard back to whatever had it (PowerScribe, usually).
  if (restore && bridge) bridge.send('activate');
}

// ------------------------------------------------ panels

const PANEL_SIZES = {
  par: [360, 250],
  goal: [420, 420],
  calib: [440, 360],
  examTitle: [460, 240],
  forecast: [520, 560],
  paste: [560, 440],
  breakdown: [300, 340],
  shiftToday: [460, 420],
  shiftView: [520, 560],
  rewards: [420, 420],
  cashout: [400, 300],
  rate: [400, 280],
  message: [460, 300],
  confirm: [480, 360],
  settings: [720, 640],
  welcome: [620, 560],
  pacs: [600, 520],
  status: [520, 460],
};
const POPOVERS = new Set(['par', 'breakdown']);
const panelArgs = new Map();

function openPanel(view, args = {}) {
  panelArgs.set(view, args);
  let w = panels.get(view);
  const [pw, ph] = PANEL_SIZES[view] || [460, 320];
  if (w && !w.isDestroyed()) {
    w.webContents.send('p:reload', panelData(view));
    w.show();
    w.focus();
    return w;
  }
  w = baseWin({ width: pw, height: ph, focusable: true, title: 'RadTempo' });
  panels.set(view, w);
  w.loadFile(path.join(UI, 'panel', 'index.html'), { query: { view } });
  w.on('closed', () => {
    panels.delete(view);
  });
  w.webContents.once('did-finish-load', () => {
    placePanel(w, view, pw, ph);
    w.show();
    w.focus();
  });
  if (POPOVERS.has(view)) {
    // Small pop-overs behave like the classic ones: click away and they go.
    w.on('blur', () => setTimeout(() => !w.isDestroyed() && !w.isFocused() && closePanel(view, false), 120));
    if (view === 'breakdown') setTimeout(() => !w.isDestroyed() && closePanel(view, false), 8000);
  }
  return w;
}

function placePanel(w, view, pw, ph) {
  const r = cardRect();
  // Pop-overs belong to the timer and open beside it. Every other dialog
  // opens on the screen the mouse is on: the one just clicked (the tray, the
  // menu), which is not always the timer's screen.
  const d = POPOVERS.has(view) ? screen.getDisplayMatching(r) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  let x;
  let y;
  if (POPOVERS.has(view)) {
    x = r.x + r.width / 2 - pw / 2;
    y = r.y - BANNER - ph + 6;
    if (y < wa.y) y = r.y + r.height;
  } else {
    x = wa.x + wa.width / 2 - pw / 2;
    y = wa.y + wa.height / 2 - ph / 2;
  }
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - pw - 4));
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - ph - 4));
  w.setBounds({ x: Math.round(x), y: Math.round(y), width: pw, height: ph });
}

function closePanel(view, restore = true) {
  const w = panels.get(view);
  if (w && !w.isDestroyed()) w.close();
  panels.delete(view);
  if (restore && bridge) bridge.send('activate');
}

const fx = (n, d = 1) => Number(n || 0).toFixed(d);

// Everything a panel shows. Plain data; the page decides how it looks.
function panelData(view) {
  const args = panelArgs.get(view) || {};
  const v = core.view();
  switch (view) {
    case 'par':
      return { running: v.running, exam: core.state.exam, par: v.slot.value, parSec: core.state.parSec, parBase: core.state.parBase, adjust: core.state.parAdjust };
    case 'goal': {
      const g = core.goalInfo();
      return { ...g, blurb: undefined, base: core.cfg.goalBase, step: core.cfg.goalStep };
    }
    case 'calib':
      return core.calibInfo();
    case 'examTitle':
      return { exam: core.state.exam, running: v.running };
    case 'forecast':
    case 'paste':
    case 'confirm':
    case 'message':
    case 'pacs':
      return args;
    case 'breakdown':
      return { ...core.breakdown(), goalBlurb: undefined };
    case 'shiftToday':
      return core.shiftToday();
    case 'shiftView':
      return core.shiftSchedule();
    case 'rewards':
      return core.rewardInfo();
    case 'cashout':
      return core.rewardInfo();
    case 'rate':
      return core.rewardInfo();
    case 'settings':
      return settingsData();
    case 'welcome':
      return welcomeData();
    case 'status':
      return statusData();
    default:
      return {};
  }
}

function settingsData() {
  const cfg = core.cfg;
  return {
    fields: FIELDS.map((f) => ({ ...f, value: f.scale ? cfg[f.prop] / f.scale : cfg[f.prop] })),
    dataDir: folder.dir(),
    appDir: appDir(),
    login: loginOn(),
    version: app.getVersion(),
    helper: supervisor ? supervisor.status() : null,
    ivuRows: core.ivuTable().size(),
    earlierLeft: earlierLeft(folder.dir()),
    reading: (() => { const r = store.logRows(); return { studies: r.length, first: r.length ? r[0][1] : '', last: r.length ? r[r.length - 1][1] : '' }; })(),
  };
}

function welcomeData() {
  let found = [];
  try {
    found = candidates(classicDir ? [classicDir] : []);
  } catch (_) {}
  return { found, dataDir: folder.dir(), current: describe(folder.dir()), classicRunning, login: loginOn() };
}

function statusData() {
  const st = supervisor ? supervisor.status() : {};
  return { helper: st, port: bridgePort, logFile: path.join(appDir(), 'radtempo.log'), appDir: appDir(), dataDir: folder.dir(), version: app.getVersion(), events: events.slice(-14).reverse(), classicRunning, pending: store.pendingCount() };
}

// ---------------------------------------------------------------- dashboard

function dashboardHtml() {
  return buildHtml(
    {
      cfg: core.cfg,
      csv: (store.logLines() || []).join('\n'),
      todayShift: core.state.block,
      shifts: core.shifts.map(),
      goals: core.goals(),
      adjust: core.adjust(),
      fillerIvu: core.fillerIvu(),
      cashoutLines: store.readLines('rewards') || [],
    },
    { chart: 'inline' }
  );
}

function writeDashboardFile() {
  const f = store.file('dashboard');
  fs.writeFileSync(f, dashboardHtml());
  return f;
}

function openDashboard() {
  if (!store.logLines().length) {
    toast('No data yet. Sign some studies first!', 3000, 'warn');
    if (!E2E) return;
  }
  let f;
  try {
    f = writeDashboardFile();
  } catch (e) {
    // The data folder may be read-only (a OneDrive hiccup): show it anyway.
    f = path.join(app.getPath('temp'), 'RadTempo_Dashboard.html');
    fs.writeFileSync(f, dashboardHtml());
  }
  if (dashWin && !dashWin.isDestroyed()) {
    dashWin.loadFile(f);
    dashWin.show();
    dashWin.focus();
    return;
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  dashWin = new BrowserWindow({
    width: Math.min(1320, wa.width - 40),
    height: Math.min(900, wa.height - 40),
    x: wa.x + 20,
    y: wa.y + 20,
    title: 'RadTempo Dashboard',
    backgroundColor: '#0b0b16',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  dashWin.setMenu(null);
  dashWin.loadFile(f);
  dashWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  dashWin.on('closed', () => (dashWin = null));
}

// ---------------------------------------------------------------- tray

function iconPath() {
  return path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function trayImage(state) {
  const f = path.join(ROOT, 'assets', `tray-${state}.png`);
  const img = nativeImage.createFromPath(fs.existsSync(f) ? f : path.join(ROOT, 'assets', 'icon.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
}

let trayState = '';
function updateTrayIcon() {
  if (!tray) return;
  const st = core.state.running ? 'run' : 'idle';
  if (st !== trayState) {
    trayState = st;
    tray.setImage(trayImage(st));
  }
}

function createTray() {
  tray = new Tray(trayImage('idle'));
  tray.setToolTip('RadTempo');
  const open = () => openMenu(screen.getCursorScreenPoint(), 'tray');
  tray.on('click', open);
  tray.on('right-click', open);
  tray.on('double-click', openDashboard);
}

// ---------------------------------------------------------------- start with Windows

// The portable exe unpacks itself to a temp folder on every start, so the
// login item must point at the portable file itself, not at what runs.
const loginOpts = () => (process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE, args: LOGIN_ARGS } : { args: LOGIN_ARGS });

function loginOn() {
  if (process.platform !== 'win32') return !!local.loginE2E;
  return app.getLoginItemSettings(loginOpts()).openAtLogin;
}
function setLogin(on) {
  if (process.platform !== 'win32') {
    local.loginE2E = !!on;
    return saveLocal();
  }
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginOpts() });
}

// ---------------------------------------------------------------- actions

function setWidgetVisible(on) {
  local.hidden = !on;
  saveLocal();
  if (!widget) return;
  if (on) widget.showInactive();
  else widget.hide();
}

function snapWidget() {
  const p = rightmostCorner();
  local.card = p;
  saveLocal();
  placeWidget(p);
  if (!widget.isVisible()) setWidgetVisible(true);
}

async function forecastFromWorklist() {
  if (!supervisor || !supervisor.status().connected) return toast('The helper is not running, so the worklist cannot be read. Use the paste forecast instead.', 4000, 'warn');
  const text = await bridge.ask('rows', 5000);
  if (text == null) return toast('The worklist did not answer.', 3000, 'warn');
  const f = parseFields(text);
  if (f.error) {
    const msgs = {
      nopacs: 'No PACS worklist detected yet. Click on your worklist once, wait a moment, then try again.',
      noctrl: 'No readable worklist found. Sectra works directly; PowerScribe Reports uses a custom list that cannot be read.',
      nosel: 'Nothing selected in the worklist. Select one or more studies, then try again.',
    };
    return openPanel('message', { title: 'IVU forecast', icon: 'sigma', text: msgs[f.error] || f.error, tone: 'warn' });
  }
  const r = core.forecast('rows', f.rows || '');
  if (!r.items.length) return openPanel('message', { title: 'IVU forecast', icon: 'sigma', text: 'Could not read any exam names from the selection. The exam name should start with XR, CT, MR, US, NM or PET.', tone: 'warn' });
  openPanel('forecast', r);
}

async function runMenu(id) {
  logEvent('pick', id);
  const [k, a, b] = id.split(':');
  const cfg = core.cfg;
  switch (k) {
    case 'dashboard':
      return openDashboard();
    case 'calib':
      return openPanel('calib');
    case 'goal':
      if (a === 'set') return openPanel('goal');
      if (a === 'typical') {
        const t = U.ahkRound(core.typicalDaily() * 10) / 10;
        core.saveGoal(t);
        return toast(`Goal today: ${core.goalBlurb(t)}   (a typical day)`, 3500, 'good');
      }
      if (a === 'rung') {
        core.saveGoal(+b);
        return toast(`Goal today: ${core.goalBlurb(+b)}`, 3500, 'good');
      }
      if (a === 'clear') {
        core.saveGoal(0);
        return toast("Today's goal cleared", 2500);
      }
      return;
    case 'reward':
      if (a === 'today' || a === 'bank') return openPanel('rewards');
      if (a === 'cashout') return openPanel('cashout');
      if (a === 'rate') return openPanel('rate');
      if (a === 'restart')
        return openPanel('confirm', {
          action: 'restartBank',
          title: 'Start the bank today?',
          icon: 'bank',
          text: 'Everything logged before today stops counting toward earnings. Cash-outs already recorded are kept.',
          ok: 'Start today',
        });
      return;
    case 'exam':
      if (a === 'refetch') {
        const r = await core.refetchExam();
        return toast(r.msg, 3500, r.ok ? 'good' : 'warn');
      }
      if (a === 'type') return openPanel('examTitle');
      return;
    case 'par':
      if (a === 'set') return openPanel('par');
      if (a === 'warn') return core.setSetting('warnEnabled', !cfg.warnEnabled);
      if (a === 'pct') return core.setSetting('warnPct', +b);
      if (a === 'recompute') {
        const r = core.parRecompute();
        return openPanel('message', { title: 'Pars recomputed', icon: 'flag', text: `Exam types with their own par: ${r.examTypes}. Everything else falls back to the modality median.`, tone: 'good' });
      }
      return;
    case 'fix':
      return core.fixLast(a);
    case 'undo':
      return core.undoLast();
    case 'shift':
      if (a === 'today') return openPanel('shiftToday');
      if (a === 'view') {
        if (!core.shifts.count()) return openPanel('message', { title: 'Shift schedule', icon: 'calendar', text: 'No schedule loaded yet. Use "Refresh from QGenda" to fetch it.', tone: 'warn' });
        return openPanel('shiftView');
      }
      if (a === 'refresh') {
        toast('Fetching the QGenda schedule…', 2000);
        const err = await core.refreshShifts();
        if (err) return openPanel('message', { title: 'Schedule refresh failed', icon: 'calendar', text: `${err}\n\nThe cached schedule (if any) is still in use.`, tone: 'warn' });
        return openPanel('message', { title: 'Schedule refreshed', icon: 'calendar', text: `Dates loaded: ${core.shifts.count()}\nToday: ${core.state.block || '(none)'}`, tone: 'good' });
      }
      if (a === 'backfill') {
        if (!core.shifts.count()) return openPanel('message', { title: 'Backfill shifts', icon: 'history', text: 'No schedule loaded. Refresh from QGenda first.', tone: 'warn' });
        return openPanel('confirm', { action: 'backfill', title: 'Backfill log shifts?', icon: 'history', text: 'Every study in the log is re-attributed to the reading block active when it was signed. A backup of the log is kept first.', ok: 'Backfill' });
      }
      return;
    case 'act':
      if (a === 'toggle') return core.setSetting('actEnabled', !cfg.actEnabled);
      if (a === 'idle') return core.setSetting('actIdleSec', +b);
      return;
    case 'well':
      if (a === 'status') return core.wellness.show('status');
      if (a === 'preview') return core.wellness.show('nudge');
      if (a === 'min') {
        core.setSetting('wellnessMinutes', +b);
        return toast(`Break nudge at ${b} min of desk time. You are at ${Math.round(core.wellness.state.strainMs / 60000)} min now.`, 3000);
      }
      if (a === 'reset') {
        core.wellness.creditBreak();
        return toast(`Strain reset. Next nudge after ${cfg.wellnessMinutes} min at the desk.`, 3000);
      }
      return;
    case 'settings':
      return openPanel('settings');
    case 'data':
      if (a === 'folder') return shell.openPath(folder.dir());
      if (a === 'browser') {
        try {
          return shell.openPath(writeDashboardFile());
        } catch (e) {
          return toast('Could not write the dashboard file: ' + e.message, 4000, 'warn');
        }
      }
      if (a === 'resetday') {
        core.resetDayCount();
        return toast('Day count reset', 2000);
      }
      if (a === 'clean')
        return openPanel('confirm', {
          action: 'clean',
          title: 'Clean the database?',
          icon: 'broom',
          text: 'Fixes modalities from the exam text, looks up missing IVU values, repairs IVU typed without its decimal point, and removes malformed rows.',
          ok: 'Clean',
        });
      if (a === 'outliers') {
        const flagged = core.findOutliers();
        if (!flagged.length) return openPanel('message', { title: 'Remove outliers', icon: 'filter', text: 'No suspiciously short captures or missing-modality rows found.', tone: 'good' });
        return openPanel('confirm', {
          action: 'outliers',
          title: `Remove ${flagged.length} suspicious ${flagged.length === 1 ? 'entry' : 'entries'}?`,
          icon: 'filter',
          text: 'Short captures and rows with no modality. Long studies are never flagged - long PET and MR reads are kept. A backup is saved first.',
          list: flagged.slice(0, 200).map((f) => ({ a: `${f.secs}s`, b: f.exam || '(no exam text)', c: f.reason })),
          ok: `Delete ${flagged.length}`,
          danger: true,
        });
      }
      return;
    case 'diag':
      if (a === 'status') return openPanel('status');
      if (a === 'start') return core.start();
      if (a === 'stop') return core.stop();
      if (a === 'pacs') {
        const text = await (bridge ? bridge.ask('diag', 5000) : null);
        if (text == null) return openPanel('message', { title: 'PACS diagnostic', icon: 'search', text: 'The helper did not answer (it only runs on Windows).', tone: 'warn' });
        const info = parseFields(text).text || text;
        clipboard.writeText(info.replace(/\n/g, '\r\n'));
        return openPanel('pacs', { text: info });
      }
      return;
    case 'widget':
      if (a === 'toggle') return setWidgetVisible(!(widget && widget.isVisible()));
      if (a === 'snap') return snapWidget();
      return;
    case 'login':
      local.loginChosen = true;
      saveLocal();
      return setLogin(!loginOn());
    case 'quit':
      return quitApp();
    default:
      return;
  }
}

// What a panel asks main to do. Returns data for the panel.
async function panelDo(view, action, p = {}) {
  logEvent('panel', `${view}:${action}`);
  const cfg = core.cfg;
  switch (action) {
    case 'close':
      return closePanel(view, p.restore !== false);
    case 'parShift':
      core.parShift(+p.delta);
      return panelData('par');
    case 'parSuggested':
      core.parSuggested();
      return panelData('par');
    case 'goalSave': {
      const v = +p.value;
      core.saveGoal(v > 0 ? v : 0);
      toast(v > 0 ? `Goal today: ${core.goalBlurb(v)}` : "Today's goal cleared", 3500, v > 0 ? 'good' : '');
      return closePanel(view);
    }
    case 'calibApply': {
      const r = core.calibApply(p.value);
      if (!r) return { error: 'Type the RVU Sum from My Productivity.' };
      toast(`Today is now ${fx(r.total, 2)} IVU. Corrected by ${r.delta >= 0 ? '+' : ''}${fx(r.delta, 2)} against PowerScribe.`, 4000, 'good');
      return closePanel(view);
    }
    case 'calibClear':
      core.calibClear();
      toast("Today's correction cleared. Back to the table's own numbers.", 3000);
      return closePanel(view);
    case 'calibScale': {
      const v = +p.value;
      if (!(v > 0)) return { error: 'A number above 0.' };
      cfg.calScale = v;
      settings.save('IvuPerRvu', v);
      return panelData('calib');
    }
    case 'examTitle': {
      const r = core.setExamTitle(p.value);
      if (r.msg) toast(r.msg, 3000, r.ok ? 'good' : 'warn');
      return closePanel(view);
    }
    case 'forecastGoal':
      return core.forecastGoalCheck(p.goal, p.total);
    case 'pasteForecast': {
      if (!String(p.text || '').trim()) return { error: 'Nothing was pasted.' };
      const r = core.forecast('paste', p.text);
      if (!r.items.length) return { error: 'No exam names found. Each line needs a modality prefix like CT, MR, XR, US or PET.' };
      closePanel('paste', false);
      openPanel('forecast', r);
      return {};
    }
    case 'cashout': {
      const r = core.cashOut(p.amount);
      if (!r.ok) return { error: r.msg || 'Enter an amount.' };
      clipboard.writeText(r.amount.toFixed(2));
      toast(`$${r.amount.toFixed(2)} taken out and copied. Bank now $${r.balance.toFixed(2)}.`, 4000, 'good');
      if (p.openStore) shell.openExternal(cfg.rewardStoreUrl);
      return closePanel(view);
    }
    case 'rate': {
      if (!core.setRewardRate(p.value)) return { error: 'A number, 0 or more.' };
      toast(`$${cfg.rewardPerPoint.toFixed(2)} per point. Today is worth $${core.rewardInfo().todayDollars.toFixed(2)} so far.`, 3500, 'good');
      return closePanel(view);
    }
    case 'openStore':
      return shell.openExternal(cfg.rewardStoreUrl);
    case 'confirm': {
      const args = panelArgs.get('confirm') || {};
      closePanel('confirm');
      if (args.action === 'restartBank') {
        core.restartBank();
        return toast(`The bank starts today. Earned so far: $${core.rewardInfo().earned.toFixed(2)}.`, 3500, 'good');
      }
      if (args.action === 'clean') {
        const r = core.cleanDb();
        if (r.empty) return toast('The log is empty.', 2500);
        return openPanel('message', { title: 'Database cleaned', icon: 'broom', text: `Processed ${r.total} studies.\nFixed: ${r.fixed} fields\nRemoved: ${r.removed} malformed rows`, tone: 'good' });
      }
      if (args.action === 'outliers') {
        const r = core.removeOutliers(core.findOutliers());
        return openPanel('message', { title: 'Outliers removed', icon: 'filter', text: `Removed ${r.removed} entries. ${r.kept} studies remain.\n\nA backup was saved to:\n${r.backup}`, tone: 'good' });
      }
      if (args.action === 'backfill') {
        const r = core.backfillShifts();
        if (r.empty) return toast('The log is empty.', 2500);
        return openPanel('message', { title: 'Backfill complete', icon: 'history', text: `Rows processed: ${r.kept}\nAttributed to a block: ${r.attributed}\nUnscheduled: ${r.unsched}\n\nBackup saved to:\n${r.backup}`, tone: 'good' });
      }
      if (args.action === 'closeClassic') {
        if (bridge) bridge.send('closeclassic');
        return toast('Closing the classic RadTempo…', 2500);
      }
      return;
    }
    case 'setting': {
      const f = FIELDS.find((x) => x.key === p.key);
      if (!f) return { error: 'unknown' };
      let val = p.value;
      if (f.type === 'int' || f.type === 'num') {
        val = Number(val);
        if (!Number.isFinite(val) || (f.min != null && val < f.min) || (f.max != null && val > f.max)) return { error: `Between ${f.min} and ${f.max}.` };
        if (f.type === 'int') val = Math.round(val);
      } else val = String(val).trim();
      cfg[f.prop] = f.scale ? val * f.scale : val;
      if (f.section === 'ShiftClass') settings.saveClass(f.key, val);
      else settings.save(f.key, val);
      core.changed();
      if (f.key === 'ShiftUrl' && val) core.refreshShifts().then((e) => e && logEvent('shifts', e));
      return { ok: true };
    }
    case 'login':
      local.loginChosen = true;
      saveLocal();
      setLogin(!!p.on);
      return { login: loginOn() };
    case 'openFolder':
      return shell.openPath(p.dir || folder.dir());
    case 'chooseFolder': {
      const r = await dialog.showOpenDialog(panels.get(view), { title: 'Choose the RadTempo data folder', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      return { dir: r.filePaths[0], info: describe(r.filePaths[0]) };
    }
    case 'useFolder': {
      // Point the data at a folder (keeping its files), then reload.
      folder.setDir(p.dir);
      store.invalidate();
      reloadEverything();
      toast(`Data folder: ${p.dir}`, 3000, 'good');
      return view === 'welcome' ? finishWelcome() : settingsData();
    }
    case 'importFrom': {
      const copied = importFrom(p.dir, folder.dir(), !!p.overwrite);
      reloadEverything();
      toast(`Copied ${copied.length} file${copied.length === 1 ? '' : 's'} from the classic RadTempo.`, 3500, 'good');
      return view === 'welcome' ? finishWelcome() : settingsData();
    }
    case 'fixNames': {
      // Give files still under the app's earlier name their RadTempo names.
      const failed = [];
      const taken = adoptEarlier(folder.dir(), failed);
      store.invalidate();
      reloadEverything();
      logEvent('fix-names', `renamed ${taken.length}, failed ${failed.map((x) => x.file + ' ' + x.error).join('; ')}`);
      const msg = failed.length
        ? `Renamed ${taken.length}. Could not rename ${failed.map((x) => x.file).join(', ')} (${failed[0].error}): close Excel and the old app, wait for OneDrive to finish syncing, then try again.`
        : taken.length ? `Renamed ${taken.length} file${taken.length === 1 ? '' : 's'}: your history is back.` : 'Nothing to rename: every file already has its RadTempo name.';
      toast(msg, failed.length ? 7000 : 3500, failed.length ? 'warn' : 'good');
      return { ...settingsData(), fixMsg: msg, fixFailed: failed.length > 0 };
    }
    case 'importIvu': {
      const r = await dialog.showOpenDialog(panels.get(view), { title: 'Choose the IVU table (RadTempo_IVU.csv)', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return settingsData();
      fs.copyFileSync(r.filePaths[0], store.file('ivu'));
      core.loadIvu();
      toast(`IVU table loaded: ${core.ivuTable().size()} rows.`, 3000, 'good');
      return settingsData();
    }
    case 'startFresh':
      return finishWelcome();
    case 'restartHelper':
      if (supervisor) supervisor.restart();
      return statusData();
    case 'copy':
      clipboard.writeText(String(p.text || ''));
      return { ok: true };
    case 'refresh':
      return panelData(view);
    default:
      return {};
  }
}

function finishWelcome() {
  folder.markSetUp();
  // A timer that has to catch every F4 starts with Windows unless you said no.
  if (!local.loginChosen) setLogin(true);
  closePanel('welcome', false);
  const d = describe(folder.dir());
  if (!d || !d.hasIvu) toast('Tip: load your IVU table in All settings > Data, or studies are valued at 0.', 6000, 'warn');
  return {};
}

function reloadEverything() {
  settings.retarget(store.file('ini'));
  core.loadAll();
}

// ---------------------------------------------------------------- the helper

let bridgePort = 0;
let classicDir = '';

async function startHelper() {
  const token = crypto.randomBytes(16).toString('hex');
  bridge = createBridge({
    token,
    onPoll: ({ idle, classic }) => {
      if (Number.isFinite(idle)) {
        helperIdle = idle;
        helperIdleAt = Date.now();
      }
      supervisor.notePoll();
      if (classic !== classicRunning) {
        classicRunning = classic;
        if (classic) onClassicRunning();
      }
    },
    onKey: (k, fields) => {
      logEvent('key', k);
      if (k === 'start') core.start();
      else if (k === 'stop') core.stop({ exam: fields.exam || '', code: fields.code || '', desc: fields.desc || '' });
    },
    onQuit: () => quitApp(),
  });
  bridgePort = await bridge.listen(PREFERRED_PORT);
  logEvent('bridge', `listening on 127.0.0.1:${bridgePort}`);
  setTimeout(() => logEvent('bridge', bridge.server.listening ? `still listening on ${bridgePort}` : 'NOT listening any more'), 5000);
  fs.writeFileSync(path.join(appDir(), 'bridge.ini'), `[Bridge]\r\nPort=${bridgePort}\r\nToken=${token}\r\n`);
  supervisor = createSupervisor({
    resourcesDir: helperDir(),
    dataDir: appDir,
    onChange: (st) => logEvent('helper', `${st.running ? 'running' : 'stopped'}${st.connected ? ' connected' : ''}${st.lastError ? ' ' + st.lastError : ''}`),
    log: (m) => logEvent('helper-log', m),
  });
  if (process.platform === 'win32' && !process.env.RT_NO_HELPER) supervisor.start();
}

// Both would log every study. Say so once, offer to close the classic one.
async function onClassicRunning() {
  logEvent('classic', 'running');
  if (classicWarned) return;
  classicWarned = true;
  const text = bridge ? await bridge.ask('classic', 3000) : null;
  if (text) classicDir = parseFields(text).dir || '';
  openPanel('confirm', {
    action: 'closeClassic',
    title: 'The classic RadTempo is running too',
    icon: 'warn',
    text: 'Both would time and log every study. Close the classic one? (Its history stays where it is.)',
    ok: 'Close the classic one',
  });
}

// ---------------------------------------------------------------- IPC

function wireIpc() {
  ipcMain.on('w:mouse', (_e, inside) => {
    if (widget && !widget.isDestroyed()) widget.setIgnoreMouseEvents(!inside, { forward: true });
  });
  let drag = null;
  ipcMain.on('w:drag', (_e, phase) => {
    if (!widget) return;
    if (phase === 'start') {
      const c = screen.getCursorScreenPoint();
      const b = widget.getBounds();
      drag = { dx: c.x - b.x, dy: c.y - b.y, timer: setInterval(() => {
        const p = screen.getCursorScreenPoint();
        widget.setBounds({ x: p.x - drag.dx, y: p.y - drag.dy, width: WIN_W, height: WIN_H });
      }, 12) };
    } else if (drag) {
      clearInterval(drag.timer);
      drag = null;
      const r = cardRect();
      local.card = { x: r.x, y: r.y };
      saveLocal();
    }
  });
  ipcMain.on('w:action', async (_e, action, arg) => {
    logEvent('widget', action + (arg != null && typeof arg !== 'object' ? ':' + arg : ''));
    switch (action) {
      case 'mod':
        return core.setMod(arg);
      case 'cycle':
        return core.cycleMod(+arg || 1);
      case 'reset':
        return core.reset();
      case 'forecast':
        return forecastFromWorklist();
      case 'paste':
        return openPanel('paste', {});
      case 'snap':
        return snapWidget();
      case 'par':
        return core.state.running ? openPanel('par') : openPanel('breakdown');
      case 'breakdown':
        return openPanel('breakdown');
      case 'nudge':
        return core.parNudge(+arg);
      case 'menu': {
        const r = cardRect();
        const p = arg && Number.isFinite(arg.x) ? { x: r.x - PAD + arg.x, y: r.y - PAD - BANNER + arg.y } : screen.getCursorScreenPoint();
        return openMenu(p, 'widget');
      }
      default:
    }
  });
  ipcMain.on('m:pick', async (_e, id, keep) => {
    if (keep) {
      // Switches and radio choices apply in place; the menu stays open.
      await runMenu(id).catch((e) => toast('Something went wrong: ' + e.message, 4000, 'warn'));
      return refreshMenu();
    }
    // Opening a window hands it the keyboard; anything else gives it back.
    closeMenu(!/^(settings|calib|goal:set|exam:type|par:set|reward:|dashboard|diag:pacs|diag:status|shift:(today|view|refresh|backfill)|data:(clean|outliers)|par:recompute)/.test(id));
    runMenu(id).catch((e) => toast('Something went wrong: ' + e.message, 4000, 'warn'));
  });
  ipcMain.on('m:close', () => closeMenu(true));
  ipcMain.handle('p:get', (_e, view) => panelData(view));
  ipcMain.handle('p:do', (_e, view, action, payload) => panelDo(view, action, payload));
  ipcMain.on('p:size', (e, w, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const b = win.getBounds();
    const view = [...panels.entries()].find(([, x]) => x === win)?.[0];
    const nh = Math.ceil(h);
    const nw = Math.ceil(w || b.width);
    if (Math.abs(b.height - nh) > 2 || Math.abs(b.width - nw) > 2) placePanel(win, view, nw, nh);
  });
  ipcMain.on('c:btn', (_e, id) => {
    if (id === 'a') core.wellness.buttonA();
    else core.wellness.buttonB();
  });
  ipcMain.handle('e2e:state', () => (E2E ? { view: core.view(), events, helper: supervisor && supervisor.status(), port: bridgePort, panels: [...panels.keys()], menu: !!(menuWin && menuWin.isVisible()) } : null));
}

// ---------------------------------------------------------------- lifecycle

let quitting = false;
function quitApp() {
  if (quitting) return;
  quitting = true;
  try {
    if (supervisor) supervisor.stop();
  } catch (_) {}
  app.quit();
}

app.on('second-instance', () => {
  // Started again by hand: show the widget and the menu so it is obvious.
  setWidgetVisible(true);
  const r = cardRect();
  openMenu({ x: r.x, y: r.y }, 'second-launch');
});

app.on('window-all-closed', (e) => e.preventDefault());

// Why the app or one of its parts went away, for radtempo.log.
app.on('will-quit', () => logEvent('exit', 'will-quit'));
app.on('render-process-gone', (_e, wc, d) => logEvent('crash', `window ${wc && wc.getURL().split('/ui/')[1]}: ${d.reason} (${d.exitCode})`));
app.on('child-process-gone', (_e, d) => logEvent('crash', `${d.type} ${d.name || ''}: ${d.reason} (${d.exitCode})`));
process.on('uncaughtException', (e) => logEvent('error', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => logEvent('error', e && e.stack ? e.stack : String(e)));

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  loadLocal();
  folder = createDataFolder(appDir);
  fs.mkdirSync(folder.dir(), { recursive: true });
  store = createStore(() => folder.dir());
  settings = createSettings(store.file('ini'));
  core = createCore({
    store,
    settings,
    idleMs,
    readPS,
    fetchText,
    onChange: () => {
      pushState();
      updateTrayIcon();
    },
    notify: toast,
    onWellness,
  });
  core.loadAll();
  wireIpc();
  createWidget();
  createTray();
  await startHelper();

  setInterval(() => core.minuteTick() && setTimeout(() => core.refreshShifts(), 5000), 60000);
  setInterval(() => core.flushPending(), 30000);
  setInterval(() => core.wellness.tick(), 5000);
  setInterval(() => pushState(), 1000); // the idle clock still moves between studies
  setTimeout(() => core.refreshShifts().then((e) => e && logEvent('shifts', e)), 3000);

  if (!folder.isSetUp()) openPanel('welcome');
  else if (!AT_LOGIN && !E2E) toast('RadTempo is running. Right-click the timer for everything else.', 3500);
  // Files left under the app's earlier name (a rename that failed while they
  // were busy): try again now, and say so if some still will not move.
  if (earlierLeft(folder.dir()).length) {
    const failed = [];
    adoptEarlier(folder.dir(), failed);
    if (failed.length) {
      logEvent('fix-names', failed.map((x) => x.file + ' ' + x.error).join('; '));
      setTimeout(() => toast(`${failed.length} history file${failed.length === 1 ? '' : 's'} still have the old name. Settings > Data > Fix file names.`, 8000, 'warn'), 1500);
    } else {
      store.invalidate();
      reloadEverything();
    }
  }
  logEvent('ready', `data=${folder.dir()}`);
  if (process.env.RT_HEARTBEAT) setInterval(() => logEvent('alive', `helper ${supervisor.status().connected ? 'connected' : 'NOT connected'}`), 5000);
});

module.exports = {};
