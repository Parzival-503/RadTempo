// A history kept under the app's earlier name carries over: the files are
// renamed to the RadTempo names the first time the folder is used, nothing is
// overwritten, and the welcome screen finds such a folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, FILES, EARLIER, adoptEarlier } = require('../src/engine/store');
const { describe, importFrom } = require('../src/main/data-folder');

const old = (f) => f.replace(/^RadTempo/, EARLIER);

test('earlier-named files become RadTempo files, once, and the history reads the same', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-earlier-'));
  const log = 'Timestamp,Date\n20261101120000,2026-11-01\n';
  fs.writeFileSync(path.join(d, old(FILES.log)), log);
  fs.writeFileSync(path.join(d, old(FILES.ini)), '[Settings]\nGoalBase=60\n');
  const info = describe(d);
  assert.ok(info && info.studies === 1, 'the welcome screen finds the folder by its earlier-named log');
  const store = createStore(d);
  assert.strictEqual(store.logRows().length, 1, 'the history reads through the store');
  assert.strictEqual(fs.readFileSync(path.join(d, FILES.log), 'utf8'), log);
  assert.ok(!fs.existsSync(path.join(d, old(FILES.log))), 'renamed, not duplicated');
  assert.ok(fs.existsSync(path.join(d, FILES.ini)));
  assert.deepStrictEqual(adoptEarlier(d), [], 'nothing left to take over');
});

test('an existing RadTempo file is never overwritten by an earlier-named one', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-earlier2-'));
  fs.writeFileSync(path.join(d, FILES.log), 'new');
  fs.writeFileSync(path.join(d, old(FILES.log)), 'old');
  adoptEarlier(d);
  assert.strictEqual(fs.readFileSync(path.join(d, FILES.log), 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(path.join(d, old(FILES.log)), 'utf8'), 'old', 'the earlier file is left alone');
});

test('copying a history in from an earlier-named folder gives RadTempo names', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-dest-'));
  fs.writeFileSync(path.join(src, old(FILES.log)), 'Timestamp\n1\n');
  assert.deepStrictEqual(importFrom(src, dest), [FILES.log]);
  assert.ok(fs.existsSync(path.join(dest, FILES.log)));
});

test('Fix file names: lists what is left, renames it, and names any file it could not take over', () => {
  const { earlierLeft } = require('../src/engine/store');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fix-'));
  for (const k of ['log', 'goals', 'adjust', 'shifts', 'ini']) fs.writeFileSync(path.join(d, old(FILES[k])), k);
  fs.writeFileSync(path.join(d, FILES.ivu), 'already renamed');
  assert.deepStrictEqual(earlierLeft(d).sort(), ['log', 'goals', 'adjust', 'shifts', 'ini'].map((k) => old(FILES[k])).sort());
  const failed = [];
  const taken = adoptEarlier(d, failed);
  assert.strictEqual(taken.length, 5);
  assert.deepStrictEqual(failed, []);
  assert.deepStrictEqual(earlierLeft(d), [], 'nothing left');
  assert.strictEqual(fs.readFileSync(path.join(d, FILES.ivu), 'utf8'), 'already renamed');
});

test('a file that cannot be taken over is reported, not skipped silently', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fix2-'));
  fs.writeFileSync(path.join(d, old(FILES.log)), 'x');
  const realRename = fs.renameSync;
  const realCopy = fs.copyFileSync;
  fs.renameSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  fs.copyFileSync = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  try {
    const failed = [];
    assert.deepStrictEqual(adoptEarlier(d, failed), []);
    assert.deepStrictEqual(failed, [{ file: old(FILES.log), error: 'EBUSY' }]);
  } finally {
    fs.renameSync = realRename;
    fs.copyFileSync = realCopy;
  }
});
