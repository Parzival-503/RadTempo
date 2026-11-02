// The IVU table and how a study is valued: by the order's procedure code when
// there is one (exact; what PowerScribe bills against), else by fuzzy-matching
// the report's EXAMINATION text. Ported line for line from the classic
// AutoHotkey version, including its quirks, so values do not shift when the
// app changes: AutoHotkey's InStr() is a substring test, so the stop-word and
// common-word lists match any token that ends a listed word ("HE" is a stop
// word because "THE," contains "HE,").

const { median, ahkRound } = require('./util');

const STOPWORDS = 'AND,OR,THE,A,OF,FOR,IN,AT,';
const COMMONWORDS = 'W,NO,CONTRAST,LEFT,RIGHT,LT,RT,VIEWS,VIEW,MORE,ORAL,IV,';
const SPLIT_PREFIXES = ['XR', 'CT', 'CTA', 'CTV', 'MR', 'MRI', 'MRA', 'MRV', 'US', 'NM', 'PET', 'DEXA', 'FLUORO', 'FLUOROSCOPY', 'MAMMO'];
const SHAKY_BELOW = 0.6;

function normalizeExamText(txt) {
  let t = String(txt || '').toUpperCase();
  const r = (re, s) => {
    t = t.replace(re, s);
  };
  r(/\bW\/O\b/g, 'NO');
  r(/\bWO\b/g, 'NO');
  r(/\bWITHOUT\b/g, 'NO');
  r(/\bW\/\b/g, 'W'); // as written in the classic version: "W/CONTRAST" -> "WCONTRAST"
  r(/\bWITH\b/g, 'W');
  r(/\bWO\/W\b/g, 'NO AND W');
  r(/\bABD\b/g, 'ABDOMEN');
  r(/\bPEL\b/g, 'PELVIS');
  r(/\bCHES\b/g, 'CHEST');
  r(/\bEXTREM\b/g, 'EXTREMITY');
  r(/\bEXTRM\b/g, 'EXTREMITY');
  r(/\bNEC\b/g, 'NECK');
  r(/\bBILAT\b/g, 'BILATERAL');
  r(/\bLT\b/g, 'LEFT');
  r(/\bRT\b/g, 'RIGHT');
  r(/\bCSP\b/g, 'CERVICAL SPINE');
  r(/\bTSP\b/g, 'THORACIC SPINE');
  r(/\bLSP\b/g, 'LUMBAR SPINE');
  r(/[^A-Z0-9 ]/g, ' ');
  r(/\s+/g, ' ');
  return t.trim();
}

// Tokens that count: not a stop word (substring rule, see the header), > 1 char.
function cleanTokens(s) {
  return s.split(' ').filter((t) => t !== '' && !STOPWORDS.includes(t + ',') && t.length > 1);
}
const weight = (t) => (COMMONWORDS.includes(t + ',') ? 1 : 3);

function createIvuTable(rows = []) {
  // rows: [{ code, desc, ivu }]
  const codes = [];
  const descs = [];
  const values = [];
  const descTok = [];
  const descW = [];
  for (const r of rows) {
    const code = String(r.code || '').trim().toUpperCase();
    const desc = normalizeExamText(String(r.desc || '').toUpperCase());
    codes.push(code);
    descs.push(desc);
    values.push(Number(r.ivu) || 0);
    const toks = cleanTokens(desc);
    descTok.push(toks);
    descW.push(toks.reduce((a, t) => a + weight(t), 0));
  }

  function findByCode(code) {
    const c = String(code || '').toUpperCase();
    if (!c) return 0;
    const i = codes.indexOf(c);
    return i >= 0 ? values[i] : 0;
  }

  // One exam -> { ivu, score }
  function lookupSingle(examText) {
    if (!examText) return { ivu: 0, score: 0 };
    const input = cleanTokens(normalizeExamText(examText));
    if (!input.length) return { ivu: 0, score: 0 };
    const inputW = input.reduce((a, t) => a + weight(t), 0);
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < descs.length; i++) {
      const dt = descTok[i];
      if (!dt.length) continue;
      let ws = 0;
      for (const it of input) if (dt.includes(it)) ws += weight(it);
      const maxW = descW[i] > inputW ? descW[i] : inputW;
      const score = maxW > 0 ? ws / maxW : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestScore >= 0.3 && bestIdx >= 0) return { ivu: values[bestIdx], score: bestScore };
    return { ivu: 0, score: 0 };
  }

  // Linked exams ("XR FOOT XR ANKLE") are valued one by one and summed.
  // -> { ivu, numExams, score } (score of the last exam, as before)
  function lookup(examText) {
    if (!examText || !descs.length) return { ivu: 0, numExams: 1, score: 0 };
    const exams = splitMultiExam(examText);
    let sum = 0;
    let score = 0;
    for (const e of exams) {
      const r = lookupSingle(e);
      sum += r.ivu;
      score = r.score;
    }
    return { ivu: sum, numExams: exams.length, score };
  }

  // Code first, then the description. src records which answered:
  // "code" | "desc" | "none" - so a guess never looks like a fact.
  function lookupFull(examText, procCode) {
    if (procCode) {
      const byCode = findByCode(procCode);
      if (byCode > 0) {
        const n = examText ? splitMultiExam(examText).length || 1 : 1;
        return { ivu: byCode, numExams: n, src: 'code', score: 1 };
      }
    }
    const r = lookup(examText);
    return { ivu: r.ivu, numExams: r.numExams, src: r.ivu > 0 ? 'desc' : 'none', score: r.ivu > 0 ? r.score : 0 };
  }

  // Filler exam IVU: the INI value, else the median of matching table rows.
  function fillerIvu(match, override) {
    if (Number(override) > 0) return Number(override);
    let re;
    try {
      re = new RegExp(match, 'i');
    } catch (_) {
      return 0;
    }
    const hits = [];
    for (let i = 0; i < descs.length; i++) if (re.test(descs[i])) hits.push(ahkRound(values[i] * 100));
    return hits.length ? median(hits) / 100 : 0;
  }

  return { size: () => descs.length, findByCode, lookupSingle, lookup, lookupFull, fillerIvu, codes, descs, values };
}

// Split at each modality prefix after the first ("XR FOOT XR ANKLE" -> 2).
function splitMultiExam(examText) {
  let txt = String(examText || '').toUpperCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const positions = [0];
  let pos = 1; // AHK InStr's StartingPos 2 (1-based) == index 1
  for (;;) {
    // The classic version searched for " " + prefix (trailing space trimmed),
    // so " CT" also matches the start of " CTA" - kept as is.
    let best = -1;
    for (const pfx of SPLIT_PREFIXES) {
      const q = txt.indexOf(' ' + pfx, pos);
      if (q >= 0 && (best < 0 || q < best)) best = q;
    }
    if (best < 0) break;
    positions.push(best + 1);
    pos = best + 2;
    if (pos >= txt.length) break;
  }
  const out = [];
  for (let i = 0; i < positions.length; i++) {
    const seg = txt.slice(positions[i], i < positions.length - 1 ? positions[i + 1] : txt.length).trim();
    if (seg) out.push(seg);
  }
  if (!out.length) out.push(txt);
  return out;
}

// RadTempo_IVU.csv: Code,Description,IVU with a header line.
function parseIvuCsv(lines) {
  const rows = [];
  (lines || []).forEach((line, i) => {
    if (i === 0 || !line) return;
    const p = line.split(',');
    if (p.length < 3) return;
    rows.push({ code: p[0], desc: p[1], ivu: parseFloat(p[2]) || 0 });
  });
  return rows;
}

// "code" | "desc:0.42" | "none" for the log's IVUSrc column.
function srcTag(src, score) {
  if (src === 'code') return 'code';
  if (src === 'desc') return 'desc:' + (ahkRound(score, 2)).toFixed(2);
  return 'none';
}

// A weak description match is marked with "~" on the widget.
function isShaky(src, score) {
  if (src === 'code' || src === 'learned') return false;
  if (src === 'none' || !src) return true;
  return score < SHAKY_BELOW;
}

module.exports = { createIvuTable, normalizeExamText, splitMultiExam, parseIvuCsv, srcTag, isShaky };
