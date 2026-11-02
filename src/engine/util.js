// Small shared helpers: AutoHotkey-compatible rounding and formatting, the
// date formats the CSV files use, medians, and file reading that copes with
// files written by the classic AutoHotkey version (ANSI, UTF-8 or UTF-16).

const fs = require('fs');

// AutoHotkey's Round(): half away from zero. Math.round rounds -2.5 to -2.
function ahkRound(x, digits = 0) {
  const f = Math.pow(10, digits);
  const v = Math.abs(x) * f;
  const r = Math.floor(v + 0.5 + 1e-9) / f;
  return x < 0 ? -r : r;
}

// Format("{:.Nf}") - fixed decimals.
function fixed(x, n = 1) {
  const v = Number(x) || 0;
  return ahkRound(v, n).toFixed(n);
}

// Number("12abc") is NaN in JS; AutoHotkey's "12abc" + 0 is "" (0 in math).
function num(v) {
  const n = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// "1:02:03" past an hour, else "02:03" (FormatSeconds).
function formatSeconds(totalSec) {
  totalSec = Math.trunc(totalSec);
  const neg = totalSec < 0;
  if (neg) totalSec = -totalSec;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const out = h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  return neg ? '-' + out : out;
}

// The widget's big clock: past ten hours the seconds go ("46h32").
function formatClock(totalSec) {
  if (totalSec >= 36000) return `${Math.floor(totalSec / 3600)}h${pad2(Math.floor((totalSec % 3600) / 60))}`;
  return formatSeconds(totalSec);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The log's formats, all local time.
const mdy = (d = new Date()) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const ymd = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const logStamp = (d = new Date()) => `${mdy(d)} ${d.getHours()}:${pad2(d.getMinutes())}`;
const dayName = (d = new Date()) => DAYS[d.getDay()];
const hour2 = (d = new Date()) => pad2(d.getHours());
const hourDec = (d = new Date()) => d.getHours() + d.getMinutes() / 60;
// "4:58 PM"
function clockTime(d = new Date()) {
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${ap}`;
}

// "M/d/yyyy" -> Date (local midnight) or null.
function parseMdy(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2]);
}

// "M/d/yyyy" -> "yyyyMMdd" (StampOf / MDYToYmd), "" if malformed.
function stampOf(s) {
  const p = String(s || '').split('/');
  if (p.length < 3) return '';
  return `${String(num(p[2])).padStart(4, '0')}${pad2(num(p[0]))}${pad2(num(p[1]))}`;
}

// "yyyyMMdd" -> "M/d/yyyy"
function ymdToMdy(s) {
  return `${+s.slice(4, 6)}/${+s.slice(6, 8)}/${s.slice(0, 4)}`;
}

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return x;
}

// ISO-8601 year+week, e.g. 202631 - what AutoHotkey's FormatTime YWeek gives,
// so the weekly reward cap buckets match the classic version and the dashboard.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}${pad2(week)}`;
}

function median(values) {
  const a = values.map(Number).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// Read a text file whatever wrote it: UTF-16 (BOM), UTF-8 (with or without
// BOM), or ANSI from the classic AutoHotkey FileAppend. Missing file -> null.
function readText(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (_) {
    return null;
  }
  return decode(buf);
}

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  const s = buf.toString('utf8');
  // Invalid UTF-8 shows up as U+FFFD; then it was ANSI (Windows-1252 ~ latin1).
  if (s.includes('�')) return buf.toString('latin1');
  return s;
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ahkRound,
  fixed,
  num,
  pad2,
  formatSeconds,
  formatClock,
  mdy,
  ymd,
  isoDate,
  logStamp,
  dayName,
  hour2,
  hourDec,
  clockTime,
  parseMdy,
  stampOf,
  ymdToMdy,
  addDays,
  isoWeekKey,
  median,
  readText,
  decode,
  exists,
};
