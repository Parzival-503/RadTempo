#!/usr/bin/env node
/*
 * Widget preview harness.
 *
 * The RadTempo widget is an AutoHotkey GUI, which cannot be run or
 * screenshotted anywhere except Windows. That makes visual iteration on it a
 * blind edit -> push -> pull -> look loop. This harness closes that gap: it
 * renders a *spec* of the widget (absolute-positioned controls with exact
 * x/y/w/h, font, colour and background) as HTML at 1:1 device pixels and
 * screenshots it, so layout, contrast and proportions can be judged before
 * anything reaches Windows.
 *
 * It is a previewer, not an emulator: it approximates GDI text metrics with
 * the browser's. Treat it as a layout/colour check, not a pixel oracle.
 *
 * Usage: node tools/widget_preview.js [spec.json] [--out dir]
 *        node tools/widget_preview.js --states   (render all built-in states)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? process.argv[i + 1] : path.join(__dirname, '..', '.preview');
})();

// A spec is { w, h, bg, controls: [ {x,y,w,h,text,font,size,bold,color,bg,align} ] }
function toHtml(spec, scale) {
  const c = (v) => (/^#/.test(v) ? v : '#' + v);
  const parts = spec.controls.map((k) => {
    const st = [
      `position:absolute`, `left:${k.x}px`, `top:${k.y}px`,
      `width:${k.w}px`, `height:${k.h}px`,
      `font-family:${k.font || "'Segoe UI',system-ui"}`,
      `font-size:${k.size || 9}pt`,
      `font-weight:${k.bold ? 700 : 400}`,
      `color:${c(k.color || 'FFFFFF')}`,
      k.bg ? `background:${c(k.bg)}` : '',
      k.radius ? `border-radius:${k.radius}px` : '',
      k.border ? `box-shadow:inset 0 0 0 1px ${c(k.border)}` : '',
      `display:flex`,
      `align-items:${k.valign || 'center'}`,
      `justify-content:${k.align === 'center' ? 'center' : k.align === 'right' ? 'flex-end' : 'flex-start'}`,
      `letter-spacing:${k.ls || 0}px`,
      `white-space:pre`, `overflow:hidden`, `box-sizing:border-box`,
      k.pad ? `padding:0 ${k.pad}px` : '',
      k.opacity ? `opacity:${k.opacity}` : '',
    ].filter(Boolean).join(';');
    const txt = String(k.text == null ? '' : k.text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div style="${st}">${txt}</div>`;
  }).join('\n');
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#2b2b2b}
#wrap{position:relative;width:${spec.w}px;height:${spec.h}px;background:${c(spec.bg)};
 overflow:hidden;${spec.radius ? `border-radius:${spec.radius}px;` : ''}
 transform:scale(${scale});transform-origin:0 0}
</style><div id="wrap">${parts}</div>`;
}

async function shoot(specs, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { chromium } = require('playwright');
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .find(p => fs.existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const written = [];
  for (const [name, spec] of Object.entries(specs)) {
    const scale = spec.scale || 3;               // 3x so small text is judgeable
    const ctx = await browser.newContext({
      viewport: { width: Math.ceil(spec.w * scale), height: Math.ceil(spec.h * scale) },
      deviceScaleFactor: 2,
    });
    const pg = await ctx.newPage();
    await pg.setContent(toHtml(spec, scale));
    await pg.waitForTimeout(120);
    const f = path.join(outDir, `widget-${name}.png`);
    await pg.screenshot({ path: f });
    written.push(f);
    await ctx.close();
  }
  await browser.close();
  return written;
}

if (require.main === module) {
  const specArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (!specArg) {
    console.error('usage: node tools/widget_preview.js <spec.json> [--out dir]');
    process.exit(2);
  }
  const specs = JSON.parse(fs.readFileSync(specArg, 'utf8'));
  shoot(specs, OUT).then(fs2 => {
    console.log('wrote:\n' + fs2.join('\n'));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { toHtml, shoot };
