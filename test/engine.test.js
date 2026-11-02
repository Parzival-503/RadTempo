const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../src/engine/util');
const { createIvuTable, normalizeExamText, splitMultiExam, parseIvuCsv, srcTag, isShaky } = require('../src/engine/ivu');
const A = require('../src/engine/analytics');
const { createShifts, shiftStats } = require('../src/engine/shifts');
const M = require('../src/engine/maintenance');
const F = require('../src/engine/forecast');
const { modFromExamText } = require('../src/engine/modality');
const { defaults } = require('../src/engine/settings');

// Invented sample data only - no real patients, no real reports.
const TABLE = parseIvuCsv([
  'Code,Description,IVU',
  'CTCHW,CT CHEST W CONTRAST,1.50',
  'CTCHWO,CT CHEST WO CONTRAST,1.25',
  'CTABPEW,CT ABDOMEN PELVIS W CONTRAST,2.10',
  'XRFOOT,XR FOOT 3 VIEWS,0.30',
  'XRANK,XR ANKLE 3 VIEWS,0.30',
  'CTLUNGSCR,CT LUNG CANCER SCREENING,1.20',
  'MRBRWWO,MRI BRAIN WO AND W CONTRAST,2.80',
]);

test('formatting matches the classic widget', () => {
  assert.equal(U.formatSeconds(0), '00:00');
  assert.equal(U.formatSeconds(75), '01:15');
  assert.equal(U.formatSeconds(3725), '1:02:05');
  assert.equal(U.formatClock(35999), '9:59:59');
  assert.equal(U.formatClock(237306), '65h55');
  assert.equal(U.ahkRound(2.5), 3);
  assert.equal(U.ahkRound(-2.5), -3);
  assert.equal(U.stampOf('8/3/2026'), '20260803');
  assert.equal(U.ymdToMdy('20260803'), '8/3/2026');
});

test('ISO week matches FormatTime YWeek', () => {
  assert.equal(U.isoWeekKey(new Date(2026, 0, 1)), '202601'); // Thu
  assert.equal(U.isoWeekKey(new Date(2027, 0, 1)), '202653'); // Fri -> last week of 2026
  assert.equal(U.isoWeekKey(new Date(2026, 7, 3)), '202632');
});

test('file decoding: UTF-16, UTF-8 BOM, ANSI', () => {
  const t16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[Settings]\r\nA=1', 'utf16le')]);
  assert.equal(U.decode(t16), '[Settings]\r\nA=1');
  assert.equal(U.decode(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'A');
  assert.equal(U.decode(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
});

test('exam text normalisation keeps the classic quirks', () => {
  assert.equal(normalizeExamText('CT Abd/Pel w/o contrast'), 'CT ABDOMEN PELVIS NO CONTRAST');
  assert.equal(normalizeExamText('CT CHEST W/CONTRAST'), 'CT CHEST WCONTRAST');
  assert.equal(normalizeExamText('MRI brain wo/w'), 'MRI BRAIN NO W');
});

test('linked exams split at modality prefixes', () => {
  assert.deepEqual(splitMultiExam('XR FOOT 3 VIEWS XR ANKLE 3 VIEWS'), ['XR FOOT 3 VIEWS', 'XR ANKLE 3 VIEWS']);
  assert.deepEqual(splitMultiExam('CT CHEST W CONTRAST'), ['CT CHEST W CONTRAST']);
});

test('IVU lookup: code first, then fuzzy description', () => {
  const t = createIvuTable(TABLE);
  assert.equal(t.findByCode('ctchw'), 1.5);
  const byCode = t.lookupFull('CT CHEST WITH CONTRAST', 'CTCHW');
  assert.equal(byCode.src, 'code');
  assert.equal(byCode.ivu, 1.5);
  const byDesc = t.lookupFull('CT CHEST WITH CONTRAST', '');
  assert.equal(byDesc.src, 'desc');
  assert.equal(byDesc.ivu, 1.5);
  const linked = t.lookup('XR FOOT 3 VIEWS XR ANKLE 3 VIEWS');
  assert.equal(linked.numExams, 2);
  assert.equal(+linked.ivu.toFixed(2), 0.6);
  assert.equal(t.lookupFull('ZZZ NOTHING', '').src, 'none');
  assert.equal(srcTag('desc', 0.4567), 'desc:0.46');
  assert.equal(isShaky('code', 0), false);
  assert.equal(isShaky('desc', 0.5), true);
  assert.equal(t.fillerIvu('LUNG.*(SCREEN|CANCER)|(SCREEN|LDCT).*LUNG', 0), 1.2);
});

test('modality from exam text', () => {
  assert.equal(modFromExamText('PET/CT SKULL BASE TO THIGH'), 'PET');
  assert.equal(modFromExamText('MRI BRAIN'), 'MR');
  assert.equal(modFromExamText('CTA HEAD'), 'CT');
  assert.equal(modFromExamText('US ABDOMEN'), 'US');
  assert.equal(modFromExamText('XR CHEST 2 VIEWS'), 'CR');
  assert.equal(modFromExamText('SOMETHING'), '');
});

function row(date, secs, mod, exam, ivu, act = '', par = '', shift = '') {
  return `${date} 9:00,${date},Mon,09,${secs},x,${mod},1,${exam},${ivu},${shift},,${act},${par},,`.split(',');
}

test('par: median engaged seconds, elapsed until there are enough samples', () => {
  const rows = [
    row('8/3/2026', 600, 'CT', 'CT CHEST', 1.5, 300),
    row('8/3/2026', 700, 'CT', 'CT CHEST', 1.5, 320),
    row('8/3/2026', 800, 'CT', 'CT CHEST', 1.5, 340),
    row('8/3/2026', 900, 'CT', 'CT CHEST', 1.5, 360),
    row('8/3/2026', 100, 'CR', 'XR FOOT', 0.3),
    row('8/3/2026', 120, 'CR', 'XR FOOT', 0.3),
    row('8/3/2026', 140, 'CR', 'XR FOOT', 0.3),
    row('8/3/2026', 160, 'CR', 'XR FOOT', 0.3),
    row('8/3/2026', 10, 'CR', 'XR FOOT', 0.3), // under 15 s: ignored
  ];
  const maps = A.parMaps(rows);
  assert.equal(A.getPar(maps, 'ct chest', 'CT'), 330);
  assert.equal(A.getPar(maps, 'XR FOOT', 'CR'), 130);
  assert.equal(A.getPar(maps, 'UNKNOWN', 'CT'), 330);
  assert.equal(A.warnThreshold(maps, 'XR FOOT', 'CR', 150), 195);
  assert.equal(A.warnThreshold(maps, 'UNKNOWN', 'MR', 150), 0);
});

test('goal ladder: whole credits, next rung strictly above', () => {
  assert.equal(A.goalCredits(66.9, 60, 7), 0);
  assert.equal(A.goalCredits(67, 60, 7), 1);
  assert.equal(A.goalCredits(80.9, 60, 7), 2);
  assert.equal(A.nextRung(50, 60, 7), 60);
  assert.equal(A.nextRung(67, 60, 7), 74);
  assert.deepEqual(A.rungList(67, 60, 7), [74, 81, 88, 95]);
  assert.equal(A.goalBlurb(74, 31.5, 60, 7), '74.0 IVU = 2 credits   (at 31.5)');
});

test('reward points and the weekly cap', () => {
  const cfg = { ...defaults(), rewardStart: '' };
  // 25 wins of 30, best run 10, rung 2 -> par 25 + 3*2 = 31; goal 10*3 = 30 * (0.75 + 0.5*25/30)
  const pts = A.rewardPoints(25, 30, 10, 2, cfg);
  assert.ok(Math.abs(pts - (31 + 30 * (0.75 + 0.5 * (25 / 30)))) < 1e-9);
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row('8/3/2026', 300, 'CT', 'CT CHEST', 15, 100, 200));
  const earned = A.rewardEarnedTotal(rows, cfg);
  // 6 wins, best 6 -> 6 + 3 = 9 par points; 90 IVU -> rung 4 -> 100 pts * 1.25
  assert.equal(earned, A.rewardDollars(9 + 100 * 1.25, cfg));
  const capped = A.rewardEarnedTotal(rows, { ...cfg, rewardWeekCap: 5 });
  assert.equal(capped, 5);
  assert.equal(A.rewardEarnedTotal(rows, { ...cfg, rewardStart: '20260804' }), 0);
});

test('typical day is the median of worked days', () => {
  const rows = [row('8/3/2026', 1, 'CT', 'a', 10), row('8/3/2026', 1, 'CT', 'a', 5), row('8/4/2026', 1, 'CT', 'a', 20), row('8/5/2026', 1, 'CT', 'a', 30)];
  assert.equal(A.typicalDailyIvu(rows), 20);
});

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260803',
  'DTEND;VALUE=DATE:20260804',
  'SUMMARY:BODY MR AM [Doe]',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260803',
  'DTEND;VALUE=DATE:20260804',
  'SUMMARY:STAT 1p-5p',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260803',
  'DTEND;VALUE=DATE:20260804',
  'SUMMARY:POC',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260805',
  'DTEND;VALUE=DATE:20260807',
  'SUMMARY:VAC',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('QGenda feed: parse, classify, attribute to the active block', () => {
  const sh = createShifts(defaults());
  assert.equal(sh.parseICal(ICS), 3);
  assert.equal(sh.forDate('8/3/2026'), 'BODY MR AM [Doe] / STAT 1p-5p / POC');
  assert.equal(sh.forDate('8/6/2026'), 'VAC');
  assert.equal(sh.attribute('8/3/2026', 9.5).shift, 'BODY MR AM');
  assert.equal(sh.attribute('8/3/2026', 9.5).extras, 'POC');
  assert.equal(sh.attribute('8/3/2026', 14).shift, 'STAT 1p-5p');
  assert.equal(sh.attribute('8/3/2026', 18).shift, 'STAT 1p-5p'); // nearest edge
  assert.equal(sh.attribute('8/6/2026', 10).shift, 'Unscheduled');
  assert.equal(sh.attribute('8/9/2026', 10).shift, '');
  const again = createShifts(defaults());
  again.loadCache(sh.cacheText().split('\n'));
  assert.equal(again.forDate('8/3/2026'), sh.forDate('8/3/2026'));
  const stats = shiftStats([row('8/3/2026', 1, 'CT', 'a', 10, '', '', 'BODY MR AM'), row('8/4/2026', 1, 'CT', 'a', 12, '', '', 'BODY MR AM')], sh, '9/1/2026');
  assert.deepEqual(stats.typical('BODY MR AM'), { ivu: 11, n: 2 });
});

const HDR = 'Timestamp,Date,DayOfWeek,Hour,Seconds,Formatted,Modality,DailyStudyNum,ExamText,IVU,Shift,Extras,ActiveSec,ParSec,ProcCode,IVUSrc';

test('maintenance: undo, fix, outliers, clean', () => {
  const lines = [HDR, row('8/3/2026', 300, 'CT', 'CT CHEST', 1.5).join(','), row('8/3/2026', 400, '', 'MRI BRAIN', 280).join(',')];
  const u = M.undoLast(lines);
  assert.equal(u.lines.length, 2);
  assert.equal(u.removed.ivu, 280);
  const f = M.fixLast(lines, 'MR');
  assert.equal(f.lines[2].split(',')[6], 'MR');
  const c = M.cleanDb(lines, createIvuTable(TABLE));
  assert.equal(c.lines[2].split(',')[6], 'MR');
  assert.equal(c.lines[2].split(',')[9], '2.80');
  const out = [HDR, row('8/3/2026', 5, 'CT', 'CT CHEST', 1.5).join(',')];
  assert.equal(M.findOutliers(out)[0].reason, 'under 15s (accidental)');
});

test('forecast from pasted text and worklist rows', () => {
  const t = createIvuTable(TABLE);
  const p = F.fromPasted('Smith 10:02 CT CHEST W CONTRAST 8/3/2026\nnoise\n  XR FOOT 3 VIEWS', t);
  assert.equal(p.matched, 2);
  assert.equal(+p.total.toFixed(2), 1.8);
  const r = F.fromRows('x\tCTABPEW\tCT ABDOMEN PELVIS W CONTRAST\nnothing here', t);
  assert.equal(r.matched, 1);
  assert.equal(r.total, 2.1);
  assert.equal(r.unmatchedCount, 1);
});
