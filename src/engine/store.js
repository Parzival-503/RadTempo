// The data folder: the same CSV files, names and columns the classic
// AutoHotkey version kept next to its script, so history moves across by
// copying the files and the dashboard reads them unchanged.
//
//   RadTempo_Log.csv        one row per signed study (LOG_HEADER)
//   RadTempo_IVU.csv        Code,Description,IVU - the workload table
//   RadTempo_Goals.csv      Date,GoalIVU
//   RadTempo_IVUAdjust.csv  Date,Adjust,PowerScribeTotal,Recorded
//   RadTempo_Rewards.csv    Date,Amount,Note (cash-outs)
//   RadTempo_Shifts.csv     #fetched,<stamp> then Date,Shift names
//   RadTempo.ini            settings
//
// Rows are split on plain commas, exactly as the classic version did: every
// writer strips commas from free text before it lands in a row.

const fs = require('fs');
const path = require('path');
const { readText } = require('./util');

const FILES = {
  log: 'RadTempo_Log.csv',
  ivu: 'RadTempo_IVU.csv',
  goals: 'RadTempo_Goals.csv',
  adjust: 'RadTempo_IVUAdjust.csv',
  rewards: 'RadTempo_Rewards.csv',
  shifts: 'RadTempo_Shifts.csv',
  ini: 'RadTempo.ini',
  dashboard: 'RadTempo_Dashboard.html',
};

const LOG_HEADER = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec,ProcCode,IVUSrc';

function createStore(dirFn) {
  const dir = typeof dirFn === 'function' ? dirFn : () => dirFn;
  const file = (k) => path.join(dir(), FILES[k] || k);
  let cache = { key: '', lines: [] };
  let pending = []; // rows that could not be written (file locked by Excel)

  // All lines of the log, header first, empties dropped. Cached on mtime+size:
  // the log is read by half a dozen features after every sign.
  function logLines() {
    const f = file('log');
    let st;
    try {
      st = fs.statSync(f);
    } catch (_) {
      cache = { key: '', lines: [] };
      return [];
    }
    const key = `${f}|${st.mtimeMs}|${st.size}`;
    if (cache.key !== key) {
      const text = readText(f) || '';
      cache = { key, lines: text.split(/\r?\n/).filter((l) => l !== '') };
    }
    return cache.lines;
  }

  // Data rows as arrays of fields (header skipped).
  function logRows() {
    return logLines()
      .slice(1)
      .map((l) => l.split(','));
  }

  function invalidate() {
    cache = { key: '', lines: [] };
  }

  // Append one study row. Returns { ok, queued } - a locked file (Excel has it
  // open) queues the row and flushPending() retries it later.
  function appendLog(line) {
    const f = file('log');
    try {
      if (!fs.existsSync(f)) fs.writeFileSync(f, LOG_HEADER + '\n');
    } catch (_) {}
    let text = '';
    if (pending.length) text += pending.join('\n') + '\n';
    text += line + '\n';
    try {
      fs.appendFileSync(f, text);
      pending = [];
      invalidate();
      return { ok: true, queued: 0 };
    } catch (_) {
      if (!pending.includes(line)) pending.push(line);
      return { ok: false, queued: pending.length };
    }
  }

  function flushPending() {
    if (!pending.length) return 0;
    const n = pending.length;
    try {
      fs.appendFileSync(file('log'), pending.join('\n') + '\n');
      pending = [];
      invalidate();
      return n;
    } catch (_) {
      return 0;
    }
  }

  // Replace the whole log (header + rows), keeping a backup when asked.
  function writeLog(lines, backupSuffix) {
    const f = file('log');
    if (backupSuffix) {
      try {
        fs.copyFileSync(f, f + backupSuffix);
      } catch (_) {}
    }
    fs.writeFileSync(f, lines.filter((l) => l !== '').join('\n') + '\n');
    invalidate();
  }

  function readLines(k) {
    const t = readText(file(k));
    return t == null ? null : t.split(/\r?\n/);
  }

  function write(k, text) {
    fs.writeFileSync(file(k), text);
  }

  function append(k, header, line) {
    const f = file(k);
    if (!fs.existsSync(f)) fs.writeFileSync(f, header + '\n');
    fs.appendFileSync(f, line + '\n');
  }

  return {
    dir,
    file,
    logLines,
    logRows,
    appendLog,
    flushPending,
    pendingCount: () => pending.length,
    writeLog,
    readLines,
    write,
    append,
    invalidate,
  };
}

module.exports = { createStore, FILES, LOG_HEADER };
