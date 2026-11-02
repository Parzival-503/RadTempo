// The QGenda schedule: the personal iCal feed parsed into date -> shift names,
// each day's events classified (reading blocks, side duties, pay-code noise,
// days off), and every signed study attributed to the reading block active at
// its sign minute. Ported from the classic AutoHotkey version.

const { num, ymdToMdy, stampOf, addDays, ymd, mdy, pad2 } = require('./util');

function cleanEventName(t) {
  return String(t || '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\*?\s*swap.*$/i, '')
    .trim();
}

const keys = (list) =>
  String(list || '')
    .split(',')
    .filter((k) => k !== '')
    .map((k) => k.toUpperCase());

function createShifts(cfg) {
  let byDate = new Map(); // "M/d/yyyy" -> "A / B / C"
  let lastFetch = ''; // yyyyMMddHHmmss

  function classify(t) {
    const u = String(t).toUpperCase();
    for (const k of keys(cfg.clsNoiseKeys)) if (u.includes(k)) return 'NOISE';
    for (const k of keys(cfg.clsOffKeys)) if (u.includes(k)) return 'OFF';
    for (const k of keys(cfg.clsModKeys)) if (u.includes(k)) return 'MODIFIER';
    return 'PRIMARY';
  }

  function isOnsite(t) {
    if (!cfg.clsOnsiteRe) return false;
    try {
      return new RegExp(cfg.clsOnsiteRe, 'i').test(t);
    } catch (_) {
      return false;
    }
  }

  // "8a-12:30p" -> {s, e} in decimal hours; e past midnight is +24.
  function parseTimeWin(t) {
    const m = String(t).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
    if (!m) return null;
    const s = (num(m[1]) % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0) + (m[2] ? num(m[2]) / 60 : 0);
    let e = (num(m[4]) % 12) + (m[6].toLowerCase() === 'p' ? 12 : 0) + (m[5] ? num(m[5]) / 60 : 0);
    if (e <= s) e += 24;
    return { s, e };
  }

  // Explicit range > AM/PM token > none (all day).
  function eventWindow(t) {
    const w = parseTimeWin(t);
    if (w) return w;
    if (/\bAM\b/i.test(t)) return { s: cfg.amStart, e: cfg.amEnd };
    if (/\bPM\b/i.test(t)) return { s: cfg.pmStart, e: cfg.pmEnd };
    return null;
  }

  const forDate = (d) => (d && byDate.has(d) ? byDate.get(d) : '');

  // -> { prims: [{name,s,e,win,on}], mods: [{name,s,e,win}] } or null (no schedule)
  function dayPlan(dateStr) {
    const raw = forDate(dateStr);
    if (!raw) return null;
    const prims = [];
    const mods = [];
    let hasExtra = false;
    for (const tok of raw.split(' / ')) {
      const c = cleanEventName(tok);
      if (!c) continue;
      const cls = classify(c);
      if (cls === 'PRIMARY' || cls === 'MODIFIER') {
        const w = eventWindow(c);
        const item = { name: c, s: w ? w.s : 0, e: w ? w.e : 24, win: !!w };
        if (cls === 'PRIMARY') prims.push({ ...item, on: isOnsite(c) });
        else mods.push(item);
      } else if (cls === 'NOISE' && c.toUpperCase().includes('EXTRA HOURS')) hasExtra = true;
    }
    if (!prims.length && hasExtra) prims.push({ name: 'Extra Hours', s: 0, e: 24, win: false, on: false });
    return { prims, mods };
  }

  // The reading block active at decimal hour t on dateStr, and the side duties
  // overlapping it. -> { shift, extras } ("" when there is no schedule).
  function attribute(dateStr, t) {
    const plan = dayPlan(dateStr);
    if (!plan) return { shift: '', extras: '' };
    if (!plan.prims.length) return { shift: 'Unscheduled', extras: '' };
    let best = '';
    let bestW = 99;
    let bestS = -1;
    for (const p of plan.prims) {
      if (p.s <= t && t < p.e) {
        const w = p.e - p.s;
        if (w < bestW || (w === bestW && p.s > bestS)) {
          best = p.name;
          bestW = w;
          bestS = p.s;
        }
      }
    }
    if (!best) {
      let bd = 99999;
      let bs = -1;
      for (const p of plan.prims) {
        const d = Math.min(Math.abs(t - p.s), Math.abs(t - p.e));
        if (d < bd || (d === bd && p.s > bs)) {
          best = p.name;
          bd = d;
          bs = p.s;
        }
      }
    }
    const extras = plan.mods.filter((m) => !m.win || (m.s <= t && t < m.e)).map((m) => m.name);
    return { shift: best, extras: extras.join(' + ') };
  }

  // Parse the feed. Inside the span the feed covers it is authoritative
  // (swaps and deletions propagate); dates that rolled out of the feed are
  // kept from before, so history is never lost. Returns dates in the feed.
  function parseICal(ics) {
    let text = String(ics).replace(/\r?\n[ \t]/g, '');
    const fresh = new Map();
    let n = 0;
    let fetchMin = '99999999';
    let fetchMax = '00000000';
    let inEv = false;
    let dtS = '';
    let dtE = '';
    let summ = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === 'BEGIN:VEVENT') {
        inEv = true;
        dtS = dtE = summ = '';
        continue;
      }
      if (line === 'END:VEVENT') {
        inEv = false;
        if (dtS && summ) {
          let endYmd = dtS;
          if (dtE && dtE > dtS) {
            const e = ymdDate(dtE);
            endYmd = ymd(addDays(e, -1)); // DTEND is exclusive for all-day events
            if (endYmd < dtS) endYmd = dtS;
          }
          if (dtS < fetchMin) fetchMin = dtS;
          if (endYmd > fetchMax) fetchMax = endYmd;
          let cur = dtS;
          for (let i = 0; i < 62; i++) {
            const key = ymdToMdy(cur);
            if (fresh.has(key)) {
              if (!fresh.get(key).toUpperCase().includes(summ.toUpperCase())) fresh.set(key, fresh.get(key) + ' / ' + summ);
            } else {
              fresh.set(key, summ);
              n++;
            }
            if (cur >= endYmd) break;
            cur = ymd(addDays(ymdDate(cur), 1));
          }
        }
        continue;
      }
      if (!inEv) continue;
      let m;
      if ((m = line.match(/^DTSTART[^:]*:(\d{8})/))) dtS = m[1];
      else if ((m = line.match(/^DTEND[^:]*:(\d{8})/))) dtE = m[1];
      else if ((m = line.match(/^SUMMARY[^:]*:(.*)$/))) {
        summ = m[1]
          .split('\\\\').join(' ')
          .split('\\,').join(' ')
          .split('\\;').join(';')
          .split('\\n').join(' ')
          .split(',').join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
    if (n > 0) {
      const merged = new Map();
      for (const [k, v] of byDate) {
        const y = stampOf(k);
        if (y && (y < fetchMin || y > fetchMax)) merged.set(k, v);
      }
      for (const [k, v] of fresh) merged.set(k, v);
      byDate = merged;
    }
    return n;
  }

  function loadCache(lines) {
    byDate = new Map();
    lastFetch = '';
    for (const raw of lines || []) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#fetched,')) {
        lastFetch = line.slice(9);
        continue;
      }
      const cp = line.indexOf(',');
      if (cp < 1) continue;
      byDate.set(line.slice(0, cp), line.slice(cp + 1));
    }
  }

  function cacheText() {
    let out = '#fetched,' + lastFetch + '\n';
    for (const [k, v] of byDate) out += k + ',' + v + '\n';
    return out;
  }

  function describeDay(dateStr) {
    const plan = dayPlan(dateStr);
    if (!plan) return { none: true, prims: [], mods: [] };
    return {
      none: false,
      prims: plan.prims.map((p) => ({ name: p.name, when: p.win ? `${fmtHour(p.s)}-${fmtHour(p.e)}` : 'all day', onsite: p.on })),
      mods: plan.mods.map((m) => ({ name: m.name, when: m.win ? `${fmtHour(m.s)}-${fmtHour(m.e)}` : '' })),
    };
  }

  return {
    classify,
    parseTimeWin,
    eventWindow,
    dayPlan,
    attribute,
    parseICal,
    loadCache,
    cacheText,
    describeDay,
    forDate,
    map: () => byDate,
    count: () => byDate.size,
    lastFetch: () => lastFetch,
    setLastFetch: (s) => {
      lastFetch = s;
    },
  };
}

function ymdDate(s) {
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}

function fmtHour(h) {
  let hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (hh >= 24) hh -= 24;
  return `${hh}:${pad2(mm)}`;
}

// Per-block history: typical IVU for each reading block, from every worked
// day before today. Rows carry their block (col 11); rows logged before the
// schedule existed are attributed on the fly from their sign minute.
function shiftStats(rows, shifts, today = mdy()) {
  const blkIVU = new Map();
  const blkShift = new Map();
  const blkDate = new Map();
  for (const p of rows) {
    if (p.length < 7) continue;
    const d = (p[1] || '').trim();
    if (!d || d === today) continue;
    const ivu = p.length >= 10 ? num(p[9]) : 0;
    let sh = p.length >= 11 ? (p[10] || '').trim() : '';
    if (!sh) {
      let hr = num(p[3]);
      let mn = 30;
      const tm = (p[0] || '').trim().match(/\s(\d{1,2}):(\d{2})$/);
      if (tm) {
        hr = +tm[1];
        mn = +tm[2];
      }
      sh = shifts.attribute(d, hr + mn / 60).shift;
    }
    if (!sh) continue;
    const bk = d + '|' + sh;
    blkIVU.set(bk, (blkIVU.get(bk) || 0) + ivu);
    blkShift.set(bk, sh);
    blkDate.set(bk, d);
  }
  const sumI = new Map();
  const cnt = new Map();
  const sumH = new Map();
  const cntH = new Map();
  const onsite = new Map();
  let tot = 0;
  let overallN = 0;
  for (const [bk, iv] of blkIVU) {
    tot += iv;
    overallN++;
    const s = blkShift.get(bk);
    sumI.set(s, (sumI.get(s) || 0) + iv);
    cnt.set(s, (cnt.get(s) || 0) + 1);
    const plan = shifts.dayPlan(blkDate.get(bk));
    if (plan) {
      const pp = plan.prims.find((x) => x.name === s && x.win);
      if (pp) {
        sumH.set(s, (sumH.get(s) || 0) + (pp.e - pp.s));
        cntH.set(s, (cntH.get(s) || 0) + 1);
        if (pp.on) onsite.set(s, true);
      }
    }
  }
  const avg = new Map();
  const days = new Map();
  const hrs = new Map();
  for (const [s, c] of cnt) {
    days.set(s, c);
    avg.set(s, sumI.get(s) / c);
    if (cntH.get(s) > 0) hrs.set(s, sumH.get(s) / cntH.get(s));
  }
  const overallAvg = overallN > 0 ? tot / overallN : 0;
  return {
    avg,
    days,
    hrs,
    onsite,
    overallAvg,
    overallN,
    // Typical IVU per block for a shift name; falls back to the overall block.
    typical(name) {
      if (name && avg.has(name) && days.get(name) >= 2) return { ivu: avg.get(name), n: days.get(name) };
      return { ivu: overallAvg, n: overallN };
    },
  };
}

module.exports = { createShifts, shiftStats, cleanEventName, fmtHour };
