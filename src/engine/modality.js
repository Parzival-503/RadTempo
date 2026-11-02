// Modality from exam text, and the colours each modality wears (the same
// validated hues the dashboard uses).

const MODS = ['CR', 'CT', 'MR', 'US', 'PET'];

const MOD_COLORS = { CR: '#199E70', CT: '#C98500', MR: '#3987E5', US: '#D55181', PET: '#9085E9' };

function modFromExamText(examText) {
  const t = String(examText || '').toUpperCase();
  if (t.includes('PET/CT') || t.includes('NM PET') || /^\s*PET\b/.test(t)) return 'PET';
  if (t.includes('MRI') || t.includes('MRCP') || /^\s*MRA\b/.test(t) || /^\s*MR\b/.test(t) || /^\s*MRV\b/.test(t)) return 'MR';
  if (/^\s*CTA\b/.test(t) || /^\s*CTV\b/.test(t) || /^\s*CT\b/.test(t)) return 'CT';
  if (/^\s*US\b/.test(t) || t.includes('ULTRASOUND') || t.includes('SONOGRAPH') || t.includes('DUPLEX')) return 'US';
  if (/^\s*XR\b/.test(t) || t.includes('X-RAY') || t.includes('FLUORO') || t.includes('BARIUM') || t.includes('HSG') || t.includes('DEXA') || t.includes('MAMMO')) return 'CR';
  return '';
}

module.exports = { MODS, MOD_COLORS, modFromExamText };
