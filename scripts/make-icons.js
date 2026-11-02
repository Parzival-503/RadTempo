// Draws RadTempo's icons with Electron (so no image tools are needed) and
// writes assets/icon.png, assets/icon.ico (16-256 px, PNG-in-ICO), and the
// tray icons for idle and running. Run: xvfb-run -a npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');

function svg(size, { a = '#4f8ff0', b = '#9085e9', hand = 42 } = {}) {
  // 256-unit artboard, scaled.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#g)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#s)"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="128" cy="142" r="70" stroke-width="20"/>
    <path d="M106 50h44M128 50v22" stroke-width="18"/>
    <path d="M186 80l12-12" stroke-width="16"/>
    <path d="M128 142L${128 + hand * Math.sin(Math.PI / 4)} ${142 - hand * Math.cos(Math.PI / 4)}" stroke-width="18"/>
  </g>
  <circle cx="128" cy="142" r="11" fill="#fff"/>
</svg>`;
}

function icoFromPngs(pngs) {
  const n = pngs.length;
  const header = Buffer.alloc(6 + 16 * n);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  let off = header.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.buf)]);
}

async function render(win, size, opts) {
  const html = `<html><body style="margin:0;background:transparent">${svg(size, opts)}</body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 120));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size }).toPNG();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push({ size: s, buf: await render(win, s) });
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).buf);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), icoFromPngs(pngs.filter((p) => [16, 20, 24, 32, 40, 48, 64, 256].includes(p.size))));
  fs.writeFileSync(path.join(OUT, 'tray-idle.png'), await render(win, 32));
  fs.writeFileSync(path.join(OUT, 'tray-run.png'), await render(win, 32, { a: '#f0b23c', b: '#e5484d', hand: 50 }));
  console.log('icons written to', OUT);
  app.quit();
});
