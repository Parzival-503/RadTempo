// Log maintenance: undo or fix the last study, clean the database, find and
// remove accidental short captures, backfill reading blocks. Each works on the
// log's lines (header first) and returns new lines plus a summary, so the
// caller decides when to write and the logic stays testable.

const { num, ahkRound } = require('./util');
const { modFromExamText } = require('./modality');

function lastRowIndex(lines) {
  let last = -1;
  lines.forEach((l, i) => {
    if (l !== '') last = i;
  });
  return last;
}

// Remove the newest row. -> { lines, removed: {mod, time, ivu} } or null.
function undoLast(lines) {
  const i = lastRowIndex(lines);
  if (i < 1) return null;
  const f = lines[i].split(',');
  const removed = { mod: f[6] || '', time: f[5] || '', ivu: f.length >= 10 ? num(f[9]) : 0, date: (f[1] || '').trim() };
  const out = lines.slice();
  out.splice(i, 1);
  return { lines: out.filter((l) => l !== ''), removed };
}

// Change the newest row's modality. -> { lines, oldMod } or null.
function fixLast(lines, newMod) {
  const i = lastRowIndex(lines);
  if (i < 1) return null;
  const f = lines[i].split(',');
  const oldMod = f[6] || '';
  while (f.length < 7) f.push('');
  f[6] = newMod;
  const out = lines.slice();
  out[i] = f.join(',');
  return { lines: out.filter((l) => l !== ''), oldMod };
}

// Rows that look accidental: under 15 s, far shorter than their type, or with
// no modality that can be derived. Long reads are never flagged.
function findOutliers(lines) {
  const examSecs = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(',');
    if (p.length < 9) continue;
    const exam = p[8].trim();
    if (!exam) continue;
    const k = exam.toUpperCase();
    if (!examSecs.has(k)) examSecs.set(k, []);
    examSecs.get(k).push(num(p[4]));
  }
  const stats = new Map();
  for (const [k, arr] of examSecs) {
    const n = arr.length;
    if (n < 4) continue;
    const mean = arr.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
    stats.set(k, { mean, sd });
  }
  const ABS_FLOOR = 15;
  const flagged = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(',');
    if (p.length < 7) {
      flagged.push({ idx: i, line, reason: 'malformed row', exam: '', secs: 0 });
      continue;
    }
    const mod = p[6].trim();
    const exam = p.length >= 9 ? p[8].trim() : '';
    const secs = p.length >= 5 ? num(p[4]) : 0;
    let reason = '';
    if (!mod && !(exam && modFromExamText(exam))) reason = "no modality, can't derive";
    if (!reason && secs > 0 && secs < ABS_FLOOR) reason = `under ${ABS_FLOOR}s (accidental)`;
    const st = exam ? stats.get(exam.toUpperCase()) : null;
    if (!reason && st) {
      const floor = st.mean - 2 * st.sd;
      if (secs < floor && secs < st.mean / 2) reason = `short for type (avg ${ahkRound(st.mean)}s)`;
    }
    if (reason) flagged.push({ idx: i, line, reason, exam, secs });
  }
  return flagged;
}

function removeIndices(lines, idxs) {
  const del = new Set(idxs);
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (del.has(i)) continue;
    const l = lines[i].trim();
    if (l) out.push(l);
  }
  return out;
}

// Fix what can be fixed: modality from the exam text, missing IVU looked up,
// IVU typed without its decimal point (125 -> 1.25), trailing dates and extra
// spaces in the exam text. Malformed rows (< 7 fields) are dropped.
function cleanDb(lines, ivuTable) {
  let fixed = 0;
  let removed = 0;
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 7) {
      removed++;
      continue;
    }
    const mod = parts[6].trim();
    const exam = parts.length >= 9 ? parts[8].trim() : '';
    const ivu = parts.length >= 10 ? parts[9].trim() : '';
    if (exam) {
      const cm = modFromExamText(exam);
      if (cm && cm !== mod) {
        parts[6] = cm;
        fixed++;
      }
    }
    if (exam && (ivu === '' || ivu === '0' || ivu === '0.00')) {
      const nv = ivuTable.lookup(exam).ivu;
      if (nv > 0) {
        while (parts.length < 10) parts.push('');
        parts[9] = nv.toFixed(2);
        fixed++;
      }
    }
    if (ivu !== '') {
      const v = num(ivu);
      if (v > 10) {
        while (parts.length < 10) parts.push('');
        parts[9] = (v / 100).toFixed(2);
        fixed++;
      }
    }
    if (exam) {
      const ec = exam.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*$/, '').trim();
      if (ec !== exam && parts.length >= 9) {
        parts[8] = ec;
        fixed++;
      }
    }
    if (parts.length >= 9) parts[8] = parts[8].replace(/\s+/g, ' ').trim();
    out.push(parts.join(','));
  }
  return { lines: out, fixed, removed, total: out.length - 1 };
}

// Re-attribute every row to the reading block active at its sign minute.
function backfillShifts(lines, shifts) {
  let hdr = lines[0].trim();
  if (!hdr.includes(',Shift')) hdr += ',Shift';
  if (!hdr.includes(',Extras')) hdr += ',Extras';
  let attributed = 0;
  let unsched = 0;
  let kept = 0;
  const out = [hdr];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(',');
    while (p.length < 10) p.push('');
    const rowDate = p[1].trim();
    let hr = num(p[3]);
    let mn = 30;
    const tm = p[0].trim().match(/\s(\d{1,2}):(\d{2})$/);
    if (tm) {
      hr = +tm[1];
      mn = +tm[2];
    }
    let sh = '';
    let ex = '';
    if (rowDate && shifts.forDate(rowDate)) {
      const a = shifts.attribute(rowDate, hr + mn / 60);
      sh = a.shift;
      ex = a.extras;
      if (sh === 'Unscheduled') unsched++;
      else if (sh) attributed++;
    } else {
      sh = p.length >= 11 ? p[10].trim() : '';
      ex = p.length >= 12 ? p[11].trim() : '';
    }
    let nl = p.slice(0, 10).join(',') + ',' + sh + ',' + ex;
    if (p.length >= 13) nl += ',' + p.slice(12).join(',');
    out.push(nl);
    kept++;
  }
  return { lines: out, attributed, unsched, kept };
}

module.exports = { undoLast, fixLast, findOutliers, removeIndices, cleanDb, backfillShifts };
