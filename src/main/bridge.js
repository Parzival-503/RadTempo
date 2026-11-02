// Local bridge between the app and its AutoHotkey helper.
//
// The helper owns the keyboard hook (F4 / F12 must reach PowerScribe too, so
// only a pass-through hook can watch them) and does all the Windows-only
// reading: PowerScribe's exam and order, the PACS worklist, physical idle
// time. The app does everything else. Plain HTTP on 127.0.0.1 with a shared
// token so no other program can drive it; plain-text replies because
// AutoHotkey v1 has no JSON.
//
//   GET  /poll?idle=<ms>&classic=<0|1>   helper heartbeat (every 300 ms);
//                                        reply: commands, one per line
//   POST /key?k=start                    F4 / Ctrl+Alt+F4 went down
//   POST /key?k=stop   (body: fields)    F12 went down; PowerScribe read first
//   POST /reply?id=<n> (body)            answer to a command (read / rows / diag / classic)
//   POST /quit                           installer: please quit
//   GET  /ping                           "radtempo"
//
// Bodies are "key=value" lines; in values the helper writes newline and tab
// as \n and \t, and backslash and non-ASCII as \u{XXXX}.

const http = require('http');

function parseFields(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = unescape(line.slice(i + 1));
  }
  return out;
}

// \n, \t and \u{XXXX} (the helper's FieldEsc), decoded in one pass.
function unescape(v) {
  return String(v).replace(/\\u\{([0-9A-Fa-f]{1,6})\}|\\n|\\t/g, (m, h) => (m === '\\n' ? '\n' : m === '\\t' ? '\t' : String.fromCharCode(parseInt(h, 16))));
}

function createBridge({ token, onPoll = () => {}, onKey = () => {}, onQuit = () => {} }) {
  const queue = [];
  const waiting = new Map(); // id -> { resolve, timer }
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const reply = (code, text) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ping') return reply(200, 'radtempo');
    if (req.headers['x-rt-token'] !== token) return reply(403, 'bad token');
    const body = () =>
      new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (c) => {
          size += c.length;
          if (size > 4e6) return reject(new Error('too big'));
          parts.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
      });
    try {
      switch (url.pathname) {
        case '/poll': {
          onPoll({ idle: Number(url.searchParams.get('idle')), classic: url.searchParams.get('classic') === '1' });
          const cmds = queue.splice(0, queue.length);
          return reply(200, cmds.join('\n'));
        }
        case '/key': {
          const k = url.searchParams.get('k') || '';
          const fields = req.method === 'POST' ? parseFields(await body()) : {};
          reply(200, 'ok');
          return onKey(k, fields);
        }
        case '/reply': {
          const id = url.searchParams.get('id');
          const text = await body();
          const w = waiting.get(id);
          if (w) {
            clearTimeout(w.timer);
            waiting.delete(id);
            w.resolve(text);
          }
          return reply(200, 'ok');
        }
        case '/quit':
          if (req.method !== 'POST') return reply(405, 'POST only');
          reply(200, 'bye');
          return onQuit();
        default:
          return reply(404, 'unknown');
      }
    } catch (e) {
      return reply(500, 'error: ' + e.message);
    }
  });

  return {
    server,
    // Fire-and-forget command for the helper's next poll.
    send(cmd) {
      queue.push(cmd);
    },
    // A command with an answer. Resolves with the reply text, or null when
    // the helper does not answer in time (not running, PowerScribe hung).
    ask(cmd, timeoutMs = 3000) {
      const id = String(++seq);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          const i = queue.indexOf(`${cmd}:${id}`);
          if (i >= 0) queue.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        waiting.set(id, { resolve, timer });
        queue.push(`${cmd}:${id}`);
      });
    },
    pending: () => queue.slice(),
    listen(port, tries = 10) {
      return new Promise((resolve, reject) => {
        const attempt = (p, left) => {
          server.once('error', (e) => {
            if (e.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
            else reject(e);
          });
          server.listen(p, '127.0.0.1', () => resolve(server.address().port));
        };
        attempt(port, tries);
      });
    },
    close() {
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createBridge, parseFields, unescape };
