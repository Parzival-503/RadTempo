// The analytics dashboard: tools/dashboard/tpl.html + app.js (the same web
// app the classic version emitted), with the runtime data blocks filled in.
// <!--DATA--> marks where the data goes and /*JS*/ where app.js goes. Chart.js
// is inlined (offline=true) or loaded from the app (a local file), never from
// a CDN: hospital networks block them.

const fs = require('fs');
const path = require('path');
const { parseCashouts } = require('./analytics');

const DIR = path.join(__dirname, '..', '..', 'tools', 'dashboard');
const CDN = /<script src='https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@[^']+'><\/script>/;

// A JS literal safe inside <script>: JSON, with "</" broken up.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const lit = (v) => JSON.stringify(v).replace(/<\//g, '<\\/').split(LS).join('\\u2028').split(PS).join('\\u2029');

const upperList = (csv) =>
  String(csv || '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);

function dataBlocks(d) {
  const cfg = d.cfg;
  const adj = {};
  for (const [k, v] of d.adjust) if (Math.abs(v) >= 0.001) adj[k] = +v.toFixed(4);
  const goals = {};
  for (const [k, v] of d.goals) goals[k] = v;
  const shifts = {};
  for (const [k, v] of d.shifts) shifts[k] = v;
  const rs = cfg.rewardStart && cfg.rewardStart.length === 8 ? `${cfg.rewardStart.slice(0, 4)}-${cfg.rewardStart.slice(4, 6)}-${cfg.rewardStart.slice(6, 8)}` : cfg.rewardStart || '';
  const goalNum = cfg.forecastGoal !== '' && +cfg.forecastGoal > 0 ? +cfg.forecastGoal : 0;
  const blocks = {
    CSV_RAW: String(d.csv || '').replace(/\r/g, ''),
    TODAY_SHIFT: d.todayShift || '',
    SHIFTS: shifts,
    CLS: {
      mod: upperList(cfg.clsModKeys),
      off: upperList(cfg.clsOffKeys),
      noise: upperList(cfg.clsNoiseKeys),
      onsite: cfg.clsOnsiteRe,
      am: [cfg.amStart, cfg.amEnd],
      pm: [cfg.pmStart, cfg.pmEnd],
    },
    DAILY_GOAL: goalNum,
    IVU_ADJ: adj,
    HOURLY_RATE: cfg.hourlyRate,
    GOALS: goals,
    FILLER: { n: cfg.fillerName, re: cfg.fillerMatch, ivu: +(+d.fillerIvu || 0).toFixed(4) },
    LADDER: { b: cfg.goalBase, s: cfg.goalStep },
    REWARD: {
      on: cfg.rewardEnabled ? 1 : 0,
      per: cfg.rewardPerPoint,
      rung: cfg.rewardRungPts,
      every: cfg.rewardStreakEvery,
      bonus: cfg.rewardStreakBonus,
      cap: cfg.rewardWeekCap,
      start: rs,
    },
    CASHOUTS: parseCashouts(d.cashoutLines || []).map((c) => ({ d: c.d, a: c.a, n: c.n })),
  };
  return Object.entries(blocks)
    .map(([k, v]) => `<script>const ${k}=${lit(v)};</script>`)
    .join('\n');
}

// opts.chart: 'inline' (a self-contained file) or a URL to load it from.
function buildHtml(d, opts = {}) {
  const tpl = fs.readFileSync(path.join(DIR, 'tpl.html'), 'utf8');
  const app = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
  const chartTag =
    opts.chart === 'inline'
      ? `<script>${fs.readFileSync(path.join(__dirname, '..', 'vendor', 'chart.umd.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`
      : `<script src='${opts.chart || '../vendor/chart.umd.min.js'}'></script>`;
  if (!tpl.includes('<!--DATA-->') || !tpl.includes('/*JS*/')) throw new Error('dashboard template markers missing');
  return tpl
    .replace('<!--DATA-->', () => dataBlocks(d))
    .replace(CDN, () => chartTag)
    .replace('/*JS*/', () => app);
}

module.exports = { buildHtml, dataBlocks };
