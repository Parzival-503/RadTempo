// A small INI reader/writer for RadTempo.ini. The classic AutoHotkey
// version wrote it with IniWrite, which can leave a UTF-16 file; it is read
// either way and written back in the encoding it came in.

const fs = require('fs');

function parse(text) {
  const sections = new Map(); // name -> Map(key -> value)
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) {
      cur = s[1].trim();
      if (!sections.has(cur)) sections.set(cur, new Map());
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0 && cur) sections.get(cur).set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return sections;
}

function serialize(sections) {
  const out = [];
  for (const [name, keys] of sections) {
    out.push(`[${name}]`);
    for (const [k, v] of keys) out.push(`${k}=${String(v).replace(/[\r\n]+/g, ' ')}`);
  }
  return out.join('\r\n') + '\r\n';
}

// Section and key names are case-insensitive in Windows INI files.
function findKey(map, key) {
  const lk = key.toLowerCase();
  for (const k of map.keys()) if (k.toLowerCase() === lk) return k;
  return null;
}

function findSection(sections, sec) {
  return findKey(sections, sec);
}

function get(sections, sec, key, dflt = '') {
  const sn = findSection(sections, sec);
  if (!sn) return dflt;
  const s = sections.get(sn);
  const k = findKey(s, key);
  return k ? s.get(k) : dflt;
}

function has(sections, sec, key) {
  const sn = findSection(sections, sec);
  return !!(sn && findKey(sections.get(sn), key));
}

function set(sections, sec, key, value) {
  let sn = findSection(sections, sec);
  if (!sn) {
    sn = sec;
    sections.set(sn, new Map());
  }
  const s = sections.get(sn);
  s.set(findKey(s, key) || key, String(value));
}

// A file-backed INI: load() once, set() writes through.
function openIni(file) {
  let utf16 = false;
  let sections = new Map();
  function load() {
    let buf = null;
    try {
      buf = fs.readFileSync(file);
    } catch (_) {}
    if (!buf) {
      sections = new Map();
      return;
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      utf16 = true;
      sections = parse(buf.slice(2).toString('utf16le'));
    } else {
      let t = buf.toString('utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      sections = parse(t);
    }
  }
  function save() {
    const text = serialize(sections);
    const data = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8');
    fs.writeFileSync(file, data);
  }
  load();
  return {
    file,
    load,
    get: (sec, key, dflt) => get(sections, sec, key, dflt),
    has: (sec, key) => has(sections, sec, key),
    set(sec, key, value) {
      set(sections, sec, key, value);
      try {
        save();
      } catch (_) {}
    },
    sections: () => sections,
  };
}

module.exports = { parse, serialize, get, set, has, openIni };
