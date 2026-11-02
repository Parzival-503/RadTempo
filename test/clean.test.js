// Nothing personal ships in the code: the calendar link, pay rate and site
// names are each person's own settings (RadTempo.ini), never defaults.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaults } = require('../src/engine/settings');

const root = path.join(__dirname, '..');

function trackedText() {
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
  return files
    .filter((f) => !/\.(png|ico|jpg|woff2?|exe)$/i.test(f) && !f.startsWith('src/vendor/') && f !== 'package-lock.json')
    .filter((f) => fs.existsSync(path.join(root, f)))
    .map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
}

test('defaults carry no personal calendar link, pay rate or site', () => {
  const d = defaults();
  assert.strictEqual(d.shiftUrl, '');
  assert.strictEqual(d.hourlyRate, 0);
  assert.strictEqual(d.clsOnsiteRe, '');
});

test('no keys, calendar links or work links in any file', () => {
  const bad = [
    [/ical\?key=[0-9a-f]{8}/i, 'a calendar subscription key'],
    [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
    [/ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}/, 'a cloud API key'],
    [/sharepoint\.com|onmicrosoft\.com|-my\.sharepoint/i, 'a work link'],
  ];
  for (const [f, text] of trackedText()) {
    for (const [re, what] of bad) assert.ok(!re.test(text), `${f} contains ${what}`);
  }
});
