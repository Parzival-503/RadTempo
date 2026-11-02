// Numbers derived from the log: par per exam type, today's totals, the goal
// ladder, the reward bank. Everything is recomputed from the CSV files rather
// than kept running, so a cleaned or corrected row is reflected at once.
// Ported from the classic AutoHotkey version; AutoHotkey's object keys are
// case-insensitive, so exam-text keys are upper-cased here.

const { num, median, ahkRound, stampOf, parseMdy, isoWeekKey, mdy } = require('./util');

const PAR_MIN_SAMPLES = 4;
const WARN_FLOOR_SEC = 90;

// ---------------------------------------------------------------- par

// Par = median ENGAGED seconds (col 13) per exam type once there are enough
// samples, else the median elapsed time (col 5). Never reads ParSec (col 14):
// moving par must never feed back into future pars.
function parMaps(rows) {
  const examAct = new Map();
  const examEl = new Map();
  const modAct = new Map();
  const modEl = new Map();
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const p of rows) {
    if (p.length < 7) continue;
    const secs = num(p[4]);
    const mod = (p[6] || '').trim();
    const exam = p.length >= 9 ? (p[8] || '').trim() : '';
    const act = p.length >= 13 ? num(p[12]) : 0;
    if (secs < 15) continue;
    if (exam) {
      const k = exam.toUpperCase();
      push(examEl, k, secs);
      if (act > 0) push(examAct, k, act);
    }
    if (mod) {
      const k = mod.toUpperCase();
      push(modEl, k, secs);
      if (act > 0) push(modAct, k, act);
    }
  }
  const exam = new Map();
  for (const [k, el] of examEl) {
    const act = examAct.get(k) || [];
    if (act.length >= PAR_MIN_SAMPLES) exam.set(k, median(act));
    else if (el.length >= PAR_MIN_SAMPLES) exam.set(k, median(el));
  }
  const mod = new Map();
  for (const [k, el] of modEl) {
    const act = modAct.get(k) || [];
    mod.set(k, act.length >= PAR_MIN_SAMPLES ? median(act) : median(el));
  }
  return { exam, mod };
}

function getPar(maps, examText, modality) {
  const e = String(examText || '').toUpperCase();
  if (e && maps.exam.has(e)) return maps.exam.get(e);
  const m = String(modality || '').toUpperCase();
  if (m && maps.mod.has(m)) return maps.mod.get(m);
  return 0;
}

// The overtime warning is "well past par": WARN_PCT is a percentage of par.
function warnThreshold(maps, examText, modality, warnPct) {
  const avg = getPar(maps, examText, modality);
  if (avg <= 0) return 0;
  return Math.max(avg * (warnPct / 100), WARN_FLOOR_SEC);
}

// ---------------------------------------------------------------- today

const MOD_KEYS = ['CR', 'CT', 'MR', 'US', 'PET'];

// Today's count and IVU (per modality too), straight from the log.
function todayTotals(rows, today = mdy()) {
  const out = { count: 0, ivu: 0, byMod: { CR: 0, CT: 0, MR: 0, US: 0, PET: 0 }, engagedSec: 0, idleSec: 0, total: rows.length };
  for (const p of rows) {
    if ((p[1] || '').trim() !== today) continue;
    out.count++;
    const ivu = p.length >= 10 ? num(p[9]) : 0;
    out.ivu += ivu;
    const m = (p[6] || '').trim().toUpperCase();
    if (MOD_KEYS.includes(m)) out.byMod[m] += ivu;
    if (p.length >= 13) {
      const el = num(p[4]);
      const ac = num(p[12]);
      out.engagedSec += ac;
      if (ac > 0 && el > ac) out.idleSec += el - ac;
    }
  }
  return out;
}

function todayBlockIvu(rows, block, today = mdy()) {
  if (!block) return 0;
  let sum = 0;
  for (const p of rows) {
    if (p.length < 10 || (p[1] || '').trim() !== today) continue;
    if ((p.length >= 11 ? (p[10] || '').trim() : '') === block) sum += num(p[9]);
  }
  return sum;
}

// Median IVU across worked days: "a normal day for me", which seeds goals.
function typicalDailyIvu(rows) {
  const by = new Map();
  for (const p of rows) {
    if (p.length < 10) continue;
    const d = (p[1] || '').trim();
    if (!d) continue;
    by.set(d, (by.get(d) || 0) + num(p[9]));
  }
  const lst = [];
  for (const v of by.values()) if (v > 0) lst.push(ahkRound(v * 10));
  return lst.length ? median(lst) / 10 : 0;
}

// ---------------------------------------------------------------- goal ladder

// Credits at an IVU total: whole steps past the base. One credit = one hour,
// floored on purpose: finishing between two rungs pays the rung below.
function goalCredits(v, base, step) {
  if (step <= 0 || v < base) return 0;
  return Math.floor((v - base) / step + 0.0001);
}

// Lowest rung strictly above v.
function nextRung(v, base, step) {
  if (step <= 0) return v;
  if (v < base) return base;
  let r = base + (Math.floor((v - base) / step) + 1) * step;
  while (r <= v + 0.001) r += step;
  return r;
}

function rungList(v, base, step, n = 4) {
  const out = [];
  let r = v;
  for (let i = 0; i < n; i++) {
    r = nextRung(r, base, step);
    out.push(r);
  }
  return out;
}

const g4 = (x) => String(Number(Number(x).toPrecision(4)));

// "74 IVU = 2 credits   (at 31.5)"
function goalBlurb(v, todayIvu, base, step) {
  const c = goalCredits(v, base, step);
  let s = `${Number(v).toFixed(1)} IVU`;
  if (c > 0) s += ` = ${c} ${c === 1 ? 'credit' : 'credits'}`;
  return `${s}   (at ${Number(todayIvu).toFixed(1)})`;
}

// Goals file: Date,GoalIVU
function parseGoals(lines) {
  const m = new Map();
  (lines || []).forEach((line, i) => {
    if (i === 0 || !line) return;
    const p = line.split(',');
    if (p.length < 2) return;
    const k = p[0].trim();
    const v = num(p[1]);
    if (k && v > 0) m.set(k, v);
  });
  return m;
}

function goalsText(map) {
  let out = 'Date,GoalIVU\n';
  for (const [k, v] of map) out += `${k},${v}\n`;
  return out;
}

// ---------------------------------------------------------------- adjustments

// Day corrections against PowerScribe's RVU Sum: the last row for a date wins.
function parseAdjust(lines) {
  const m = new Map();
  (lines || []).forEach((line, i) => {
    if (i === 0 || !line) return;
    const p = line.split(',');
    if (p.length < 2) return;
    const d = p[0].trim();
    if (d) m.set(d, num(p[1]));
  });
  return m;
}

// ---------------------------------------------------------------- rewards

// Points for one day. Pure arithmetic; the dashboard's rwDays() does the same.
function rewardPoints(wins, bets, bestStreak, rungs, cfg) {
  let parPts = wins;
  if (cfg.rewardStreakEvery > 0) parPts += cfg.rewardStreakBonus * Math.floor(bestStreak / cfg.rewardStreakEvery);
  const goalPts = rungs > 0 ? (cfg.rewardRungPts * rungs * (rungs + 1)) / 2 : 0;
  const winRate = bets > 0 ? wins / bets : 0;
  const focusMul = 0.75 + 0.5 * winRate;
  return parPts + goalPts * focusMul;
}

const rewardDollars = (pts, cfg) => ahkRound(pts * cfg.rewardPerPoint * 100) / 100;

// Lifetime dollars earned from the log, the weekly cap applied per ISO week,
// counting only from the day the bank opened.
function rewardEarnedTotal(rows, cfg) {
  const dates = [];
  const by = new Map();
  for (const c of rows) {
    if (c.length < 10) continue;
    const dk = (c[1] || '').trim();
    if (!dk) continue;
    if (cfg.rewardStart && stampOf(dk) < cfg.rewardStart) continue;
    if (!by.has(dk)) {
      dates.push(dk);
      by.set(dk, { bets: 0, wins: 0, best: 0, run: 0, ivu: 0 });
    }
    const d = by.get(dk);
    d.ivu += num(c[9]);
    const parS = c.length >= 14 ? num(c[13]) : 0;
    const actS = c.length >= 13 && (c[12] || '').trim() !== '' ? num(c[12]) : -1;
    if (parS > 0 && actS >= 0) {
      d.bets++;
      if (actS <= parS) {
        d.wins++;
        d.run++;
        if (d.run > d.best) d.best = d.run;
      } else d.run = 0;
    }
  }
  const weekTot = new Map();
  let total = 0;
  for (const dk of dates) {
    const d = by.get(dk);
    let amt = rewardDollars(rewardPoints(d.wins, d.bets, d.best, goalCredits(d.ivu, cfg.goalBase, cfg.goalStep), cfg), cfg);
    const dt = parseMdy(dk);
    const wk = dt ? isoWeekKey(dt) : '?';
    const prev = weekTot.get(wk) || 0;
    const room = cfg.rewardWeekCap - prev;
    if (room <= 0) continue;
    if (amt > room) amt = room;
    weekTot.set(wk, prev + amt);
    total += amt;
  }
  return ahkRound(total * 100) / 100;
}

// Cash-out ledger: Date,Amount,Note
function parseCashouts(lines) {
  const out = [];
  (lines || []).forEach((line, i) => {
    if (i === 0 || !line) return;
    const p = line.split(',');
    if (p.length < 2) return;
    out.push({ d: p[0].trim(), a: num(p[1]), n: p.length >= 3 ? p[2].trim() : '' });
  });
  return out;
}

module.exports = {
  PAR_MIN_SAMPLES,
  parMaps,
  getPar,
  warnThreshold,
  todayTotals,
  todayBlockIvu,
  typicalDailyIvu,
  goalCredits,
  nextRung,
  rungList,
  goalBlurb,
  g4,
  parseGoals,
  goalsText,
  parseAdjust,
  rewardPoints,
  rewardDollars,
  rewardEarnedTotal,
  parseCashouts,
};
