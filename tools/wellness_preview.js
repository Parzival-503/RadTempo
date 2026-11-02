#!/usr/bin/env node
/*
 * Wellness-card preview.
 *
 * Same problem as the widget: the card is an AutoHotkey GUI and cannot be run
 * or screenshotted outside Windows, so designing it would otherwise be a blind
 * edit -> push -> pull -> look loop.
 *
 * The spec is PARSED BACK OUT of BuildWellnessCard() in the .ahk - the control
 * geometry, fonts and colours are read from the source rather than retyped -
 * so the preview cannot drift from what actually ships. Only the runtime text
 * (which prompt, which state) is supplied here, because that is the one thing
 * the builder does not contain.
 *
 * It is a previewer, not an emulator: browser text metrics stand in for GDI.
 * Judge layout, proportion and contrast; not sub-pixel kerning.
 *
 * Usage: node tools/wellness_preview.js [path/to/RadTempo.ahk] [--out dir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { shoot } = require('./widget_preview.js');

const AHK = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(__dirname, '..', 'RadTempo.ahk');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? process.argv[i + 1] : path.join(__dirname, '..', '.preview');
})();

const src = fs.readFileSync(AHK, 'utf8');

// ---- resolve the globals the builder interpolates -------------------------
const CONST = {};
for (const m of src.matchAll(/^global\s+(\w+)\s*:=\s*"([0-9A-Fa-f]{6})"/gm)) CONST[m[1]] = m[2];
for (const m of src.matchAll(/^global\s+(\w+)\s*:=\s*(\d+)\s*$/gm)) CONST[m[1]] = m[2];
for (const m of src.matchAll(/^global\s+(\w+)\s*:=\s*(\d+)\s{2,};/gm)) CONST[m[1]] = m[2];
const deref = (s) => String(s).replace(/%(\w+)%/g, (_, k) => {
  if (CONST[k] === undefined) throw new Error(`preview: unresolved %${k}% in BuildWellnessCard()`);
  return CONST[k];
});

// ---- parse BuildWellnessCard() -------------------------------------------
function parseBuilder() {
  const start = src.indexOf('BuildWellnessCard() {');
  if (start < 0) throw new Error('BuildWellnessCard() not found');
  const body = src.slice(start, src.indexOf('\n}', start));
  const controls = [];
  let font = { size: 9, color: 'FFFFFF', bold: false, family: "'Segoe UI',system-ui" };
  let bg = '12122A';

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s*;.*$/, '').trim();

    let m = /^Gui,\s*Well:Color,\s*(\S+)/.exec(line);
    if (m) { bg = deref(m[1]); continue; }

    m = /^Gui,\s*Well:Font,\s*([^,]+),\s*(.+)$/.exec(line);
    if (m) {
      const opts = deref(m[1]);
      const sz = /s([\d.]+)/.exec(opts);
      const col = /\bc([0-9A-Fa-f]{6})\b/.exec(opts);
      font = {
        size: sz ? parseFloat(sz[1]) : font.size,
        color: col ? col[1] : 'FFFFFF',
        bold: /\bBold\b/.test(opts),
        family: `'${m[2].trim()}',system-ui`,
      };
      continue;
    }

    m = /^Gui,\s*Well:Add,\s*(\w+),\s*([^,]*)(?:,\s*(.*))?$/.exec(line);
    if (!m) continue;
    const type = m[1];
    const opts = deref(m[2] || '');
    const g = (re) => { const r = re.exec(opts); return r ? Number(r[1]) : 0; };
    const name = (/v(\w+)/.exec(opts) || [, ''])[1];
    const cbg = /Background([0-9A-Fa-f]{6})/.exec(opts);
    const ccol = /\bc([0-9A-Fa-f]{6})\b/.exec(opts);
    controls.push({
      name, type,
      x: g(/\bx(-?\d+)/), y: g(/\by(-?\d+)/), w: g(/\bw(\d+)/), h: g(/\bh(\d+)/),
      bg: cbg ? cbg[1] : null,
      color: ccol ? ccol[1] : font.color,
      size: font.size, bold: font.bold, font: font.family,
      align: /\+Center/.test(opts) ? 'center' : 'left',
    });
  }
  return { bg, controls };
}

// ---- states ---------------------------------------------------------------
// Only the runtime text lives here. Geometry comes from the parse above, so a
// control moved in the .ahk moves in the preview automatically.
const STATES = {
  nudge: {
    WellAccent: { pct: 100, color: '3987E5' },
    WellIcon: { text: '◉', color: '3987E5' },
    WellCat: { text: 'EYES   •   92 MIN AT THE DESK' },
    WellTitle: { text: 'Look 20 feet away' },
    WellBody: { text: 'Twenty seconds on something distant.\nThe focus muscles unclench.' },
    WellMeter: { pct: 18, color: '199E70' },
    WellFoot: { text: 'Step away for 2:00 and this clears itself. 0:22 so far.' },
    WellA: { text: 'Snooze 15 min' },
    WellB: { text: 'Dismiss' },
  },
  breaking: {
    WellAccent: { pct: 100, color: '9085E9' },
    WellIcon: { text: '↻', color: '9085E9' },
    WellCat: { text: 'NECK   •   96 MIN AT THE DESK' },
    WellTitle: { text: 'Roll your shoulders' },
    WellBody: { text: 'Ten backward, ten forward.\nLet the tension go somewhere else.' },
    WellMeter: { pct: 71, color: '199E70' },
    WellFoot: { text: 'Step away for 2:00 and this clears itself. 1:25 so far.' },
    WellA: { text: 'Snooze 15 min' },
    WellB: { text: 'Dismiss' },
  },
  logged: {
    WellAccent: { pct: 100, color: '0CA30C' },
    WellIcon: { text: '✓', color: '0CA30C' },
    WellCat: { text: 'BREAK LOGGED' },
    WellTitle: { text: 'Strain cleared' },
    WellBody: { text: 'That counted - break 3 today.\nThe clock starts again from zero.' },
    WellMeter: { pct: 100, color: '0CA30C' },
    WellFoot: { text: '' },
    WellA: { text: 'Nice', move: { x: 16, w: 316 } },
    WellB: null,
  },
  status: {
    WellAccent: { pct: 64, color: '3987E5' },
    WellIcon: { text: '◔', color: '3987E5' },
    WellCat: { text: 'WELLNESS' },
    WellTitle: { text: '58 min at the desk' },
    WellBody: { text: '32 min of desk time until the next nudge.\nLast break 10:41 AM, 3 today.' },
    WellMeter: { pct: 4, color: '199E70' },
    WellFoot: { text: 'Away 0:05 of 2:00 - stay away and the strain clears.' },
    WellA: { text: 'Close', move: { x: 16, w: 316 } },
    WellB: null,
  },
};

function buildSpec(parsed, state) {
  const out = [];
  for (const c of parsed.controls) {
    const s = state[c.name];
    if (s === null) continue;                       // hidden in this state
    if (c.type === 'Progress') {
      const pct = s ? s.pct : 0;
      out.push({ ...c, text: '', bg: c.bg, radius: c.h <= 6 ? c.h / 2 : 0 });
      if (pct > 0) {
        out.push({
          ...c, name: c.name + 'Fill', text: '',
          w: Math.max(1, Math.round(c.w * pct / 100)),
          bg: (s && s.color) || c.color, radius: c.h <= 6 ? c.h / 2 : 0,
        });
      }
      continue;
    }
    // `move` mirrors a GuiControl,Move the state performs at runtime - the
    // builder holds the default geometry, the state declares the exception.
    out.push({
      ...c,
      ...(s && s.move ? s.move : {}),
      text: (s && s.text !== undefined) ? s.text : '',
      color: (s && s.color) || c.color,
      // Text controls in AHK wrap; the previewer needs to be told
      wrap: true,
    });
  }
  return {
    w: Number(CONST.wellCardW), h: Number(CONST.wellCardH),
    bg: parsed.bg, radius: 12, scale: 2, controls: out,
  };
}

if (require.main === module) {
  const parsed = parseBuilder();
  const missing = parsed.controls.filter(c => !c.name).length;
  if (missing) console.warn(`[wellness_preview] ${missing} control(s) with no v-name`);
  const specs = {};
  for (const [k, st] of Object.entries(STATES)) specs['well-' + k] = buildSpec(parsed, st);
  // Report the parse so a silent geometry change is visible in CI output too.
  console.log(`[wellness_preview] ${parsed.controls.length} controls parsed from ` +
    `BuildWellnessCard(), card ${CONST.wellCardW}x${CONST.wellCardH}`);
  for (const c of parsed.controls) {
    console.log(`   ${String(c.name).padEnd(11)} ${c.type.padEnd(8)} ` +
      `x${c.x} y${c.y} w${c.w} h${c.h}  s${c.size}${c.bold ? ' bold' : ''} #${c.color}`);
  }
  shoot(specs, OUT).then(f => console.log('wrote:\n' + f.join('\n')))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseBuilder, buildSpec, STATES };
