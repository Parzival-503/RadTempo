// IVU forecast: value the studies still to read, from rows selected in the
// PACS worklist (tab-separated, read by the helper) or from text pasted out of
// Snipping Tool's "Copy all text". Ported from the classic AutoHotkey version.

const PASTE_MOD = /\b(XR|CTA|CTV|CT|MRI|MRA|MRV|MR|US|NM|PET|DEXA|MAMMO|FLUORO|FLUOROSCOPY)\b\s+[A-Z]/i;
const DESC_START = /^(XR|CTA?|CTV|MRI|MRA|MRV|MR|US|NM|PET|DEXA|MAMMO|FLUORO|FLUOROSCOPY)\s/i;
const stripDate = (s) => s.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*$/, '');

function summarize(items) {
  let total = 0;
  let matched = 0;
  const unmatched = [];
  for (const it of items) {
    if (it.ivu > 0) {
      total += it.ivu;
      matched++;
    } else if (!it.skip) unmatched.push(it.name + ' (no match)');
  }
  return { items: items.filter((i) => !i.skip), total, matched, unmatchedCount: items.length - matched, unmatched };
}

function fromPasted(text, table) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 4) continue;
    const m = line.match(PASTE_MOD);
    if (!m) continue;
    // InStr of the matched prefix, case-insensitive, as the classic version did.
    const pos = line.toUpperCase().indexOf(m[1].toUpperCase());
    if (pos < 0) continue;
    let name = line.slice(pos).trim();
    name = stripDate(name.replace(/,/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    items.push({ name, ivu: table.lookup(name).ivu });
  }
  return summarize(items);
}

// Rows from a SysListView32: prefer an exam CODE column found in the IVU
// table (exact), else a column that starts with a modality prefix.
function fromRows(rowsText, table) {
  const items = [];
  const odd = [];
  for (const line of String(rowsText || '').split('\n')) {
    if (!line.trim()) continue;
    let code = '';
    let desc = '';
    for (const c of line.split('\t')) {
      const col = c.trim();
      if (!col) continue;
      if (!code && /^[A-Z][A-Z0-9]{4,14}$/.test(col) && table.findByCode(col) > 0) code = col;
      if (!desc && DESC_START.test(col)) desc = col;
    }
    const name = code || desc;
    if (!name) {
      odd.push(line.length > 60 ? line.slice(0, 60) + '...' : line);
      continue;
    }
    let display = desc || code;
    display = stripDate(display.replace(/,/g, ' ')).trim();
    const ivu = code ? table.findByCode(code) : table.lookup(name).ivu;
    items.push({ name: display, ivu });
  }
  const s = summarize(items);
  s.unmatchedCount += odd.length;
  s.unmatched = odd.concat(s.unmatched);
  return s;
}

module.exports = { fromPasted, fromRows };
