// Invented history for the end-to-end test: a fake IVU table, three weeks of
// made-up studies, goals, a schedule. No real patients, no real reports.
const fs = require('fs');
const path = require('path');

const EXAMS = [
  ['CTCHW', 'CT CHEST WITH CONTRAST', 'CT', 1.5, 420],
  ['CTABPEW', 'CT ABDOMEN PELVIS WITH CONTRAST', 'CT', 2.1, 600],
  ['CTHEADWO', 'CT HEAD WITHOUT CONTRAST', 'CT', 1.0, 240],
  ['CTLUNGSCR', 'CT LUNG CANCER SCREENING', 'CT', 1.2, 300],
  ['MRBRWWO', 'MRI BRAIN WITHOUT AND WITH CONTRAST', 'MR', 2.8, 780],
  ['MRLSPWO', 'MRI LUMBAR SPINE WITHOUT CONTRAST', 'MR', 2.2, 540],
  ['USABD', 'US ABDOMEN COMPLETE', 'US', 0.9, 200],
  ['XRCH2V', 'XR CHEST 2 VIEWS', 'CR', 0.3, 70],
  ['XRFOOT3', 'XR FOOT 3 VIEWS', 'CR', 0.3, 60],
  ['PETCTSKT', 'PET/CT SKULL BASE TO MID THIGH', 'PET', 3.6, 900],
];

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`);

function writeFixtures(dir, today = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'RadTempo_IVU.csv'), 'Code,Description,IVU\n' + EXAMS.map((e) => `${e[0]},${e[1]},${e[3].toFixed(2)}`).join('\n') + '\n');
  const r = rng(42);
  const lines = ['Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec,ProcCode,IVUSrc'];
  const goals = ['Date,GoalIVU'];
  const shifts = ['#fetched,20261029080000'];
  for (let back = 21; back >= 1; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const block = d.getDay() % 2 ? 'BODY CT AM' : 'NEURO MR AM';
    shifts.push(`${mdy(d)},${block} / BODY PM 12:30p-5p / POC`);
    if (back % 3 === 0) goals.push(`${mdy(d)},${[67, 74, 81][back % 3 === 0 ? (back / 3) % 3 : 0]}`);
    let t = 8 * 3600 + Math.floor(r() * 1800);
    const n = 28 + Math.floor(r() * 18);
    for (let i = 1; i <= n; i++) {
      const e = EXAMS[Math.floor(r() * EXAMS.length)];
      const secs = Math.max(30, Math.round(e[4] * (0.6 + r() * 0.9)));
      const act = Math.round(secs * (0.7 + r() * 0.28));
      const par = i > 3 ? Math.round(e[4] * 0.85) : '';
      t += secs + Math.floor(r() * 240);
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const sh = h < 12 || (h === 12 && m < 30) ? block : 'BODY PM 12:30p-5p';
      lines.push([`${mdy(d)} ${h}:${pad(m)}`, mdy(d), DAYS[d.getDay()], pad(h), secs, fmt(secs), e[2], i, e[1], e[3].toFixed(2), sh, 'POC', act, par, e[0], 'code'].join(','));
    }
  }
  const td = mdy(today);
  shifts.push(`${td},BODY CT AM / BODY PM 12:30p-5p / POC`);
  fs.writeFileSync(path.join(dir, 'RadTempo_Log.csv'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'RadTempo_Goals.csv'), goals.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'RadTempo_Shifts.csv'), shifts.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'RadTempo.ini'), '[Settings]\r\nShiftUrl=http://127.0.0.1:9/none.ics\r\nRewardStartDate=20260901\r\n');
  return { exams: EXAMS, studies: lines.length - 1 };
}

module.exports = { writeFixtures, EXAMS };
