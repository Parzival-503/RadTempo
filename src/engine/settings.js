// RadTempo.ini: every tunable, its default, and how it is validated.
// Same keys as the classic AutoHotkey version, so an INI copied over from it
// carries every choice across.

const { openIni } = require('./ini');
const { ymd } = require('./util');

function defaults() {
  return {
    staleStudyMin: 240,
    warnEnabled: true,
    warnPct: 150,
    wellnessMinutes: 90,
    breakMs: 120000,
    forecastGoal: '',
    actEnabled: true,
    actIdleMs: 60000,
    hourlyRate: 0,
    fillerName: 'lung screening',
    fillerMatch: 'LUNG.*(SCREEN|CANCER)|(SCREEN|LDCT).*LUNG',
    fillerIvu: 0,
    calScale: 1.0,
    goalBase: 60,
    goalStep: 7,
    goalRungs: 8,
    rewardEnabled: true,
    rewardPerPoint: 0.2,
    rewardRungPts: 10,
    rewardStreakEvery: 5,
    rewardStreakBonus: 3,
    rewardWeekCap: 150,
    rewardStoreUrl: 'https://www.amazon.com/gift-cards',
    rewardStart: '',
    parStreak: 0,
    parBestStreak: 0,
    shiftUrl: '',
    clsModKeys: 'POC,READOUT,CONF,CHART REVIEW',
    clsOffKeys: 'OFF,VAC,ATO,SB/,FLOAT',
    clsNoiseKeys: 'EXTRA HOURS,CUSTOM HOURS',
    clsOnsiteRe: '',
    amStart: 8.0,
    amEnd: 12.5,
    pmStart: 12.5,
    pmEnd: 17.0,
  };
}

const isInt = (v) => /^\s*[-+]?\d+\s*$/.test(String(v));
const isNum = (v) => /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(String(v));
const blank = (v) => v === '' || v === 'ERROR' || v == null;

function createSettings(file) {
  let ini = openIni(file);
  const cfg = defaults();

  function load() {
    ini.load();
    const d = defaults();
    Object.assign(cfg, d);
    const S = (k, dflt = '') => ini.get('Settings', k, dflt);
    let v;

    v = S('StaleStudyMin', 240);
    if (isInt(v) && +v >= 60) cfg.staleStudyMin = +v;
    cfg.warnEnabled = String(S('WarnEnabled', 1)) !== '0';
    v = S('WarnPct', 150);
    if (isInt(v)) cfg.warnPct = +v;
    cfg.wellnessMinutes = String(S('WellnessMinutes', 90)) === '60' ? 60 : 90;
    v = S('BreakMinutes', 2);
    if (isNum(v) && +v > 0 && +v <= 30) cfg.breakMs = Math.round(+v * 60000);
    v = S('ForecastGoal');
    if (!blank(v)) cfg.forecastGoal = v;
    cfg.actEnabled = String(S('ActivityEnabled', 1)) !== '0';
    v = S('HourlyRate');
    if (!blank(v) && +v > 0) cfg.hourlyRate = +v;
    v = S('FillerName');
    if (!blank(v)) cfg.fillerName = v;
    v = S('FillerMatch');
    if (!blank(v)) cfg.fillerMatch = v;
    v = S('FillerIVU');
    if (!blank(v) && +v > 0) cfg.fillerIvu = +v;
    v = S('IvuPerRvu');
    if (!blank(v) && +v > 0) cfg.calScale = +v;
    v = S('GoalBase', 60);
    if (isNum(v) && +v >= 0) cfg.goalBase = +v;
    v = S('GoalStep', 7);
    if (isNum(v) && +v > 0) cfg.goalStep = +v;
    cfg.rewardEnabled = String(S('RewardEnabled', 1)) !== '0';
    v = S('RewardPerPoint');
    if (!blank(v) && isNum(v) && +v >= 0) cfg.rewardPerPoint = +v;
    v = S('RewardRungPts', 10);
    if (isNum(v) && +v > 0) cfg.rewardRungPts = +v;
    v = S('RewardStreakEvery', 5);
    if (isInt(v) && +v > 0) cfg.rewardStreakEvery = +v;
    v = S('RewardStreakBonus', 3);
    if (isNum(v) && +v >= 0) cfg.rewardStreakBonus = +v;
    v = S('RewardWeekCap', 150);
    if (isNum(v) && +v > 0) cfg.rewardWeekCap = +v;
    v = S('RewardStoreUrl');
    if (!blank(v)) cfg.rewardStoreUrl = v;
    v = S('RewardStartDate');
    if (!blank(v) && String(v).length === 8) cfg.rewardStart = String(v);
    else {
      // The bank opens the day the feature first runs: without this the first
      // launch would pay out for the whole back-catalogue.
      cfg.rewardStart = ymd();
      ini.set('Settings', 'RewardStartDate', cfg.rewardStart);
    }
    v = S('ParStreak', 0);
    if (isInt(v)) cfg.parStreak = +v;
    v = S('ParBestStreak', 0);
    if (isInt(v)) cfg.parBestStreak = +v;
    v = S('ActivityIdleSec', 60);
    if (isInt(v) && +v >= 10 && +v <= 600) cfg.actIdleMs = +v * 1000;
    v = S('ShiftUrl');
    if (!blank(v)) cfg.shiftUrl = v.trim();

    const C = (k, def, prop) => {
      const x = ini.get('ShiftClass', k, '');
      if (!blank(x)) cfg[prop] = x;
      else ini.set('ShiftClass', k, def);
    };
    C('ModifierKeys', d.clsModKeys, 'clsModKeys');
    C('OffKeys', d.clsOffKeys, 'clsOffKeys');
    C('NoiseKeys', d.clsNoiseKeys, 'clsNoiseKeys');
    C('OnsiteRegex', d.clsOnsiteRe, 'clsOnsiteRe');
    const F = (k, def) => {
      const x = ini.get('ShiftClass', k, def);
      return isNum(x) ? +x : def;
    };
    cfg.amStart = F('AmStart', 8.0);
    cfg.amEnd = F('AmEnd', 12.5);
    cfg.pmStart = F('PmStart', 12.5);
    cfg.pmEnd = F('PmEnd', 17.0);
    return cfg;
  }

  // Persist one [Settings] key (same names as the classic INI).
  function save(key, value) {
    ini.set('Settings', key, value);
  }

  function saveClass(key, value) {
    ini.set('ShiftClass', key, value);
  }

  // Point at another RadTempo.ini (the data folder moved). cfg stays the
  // same object, so everything holding it sees the new values.
  function retarget(f) {
    ini = openIni(f);
    load();
  }

  load();
  return { cfg, load, save, saveClass, retarget, ini: () => ini };
}

// What the Settings window shows. key = INI key; prop = cfg field; scale
// converts between what is typed and what is stored in cfg.
const FIELDS = [
  { group: 'Timing', key: 'StaleStudyMin', prop: 'staleStudyMin', label: 'Drop a study left open after', unit: 'min', type: 'int', min: 60, max: 1440,
    help: 'A study still running this long was never signed with F12. The next F4 drops it (not logged) and starts fresh.' },
  { group: 'Timing', key: 'ActivityIdleSec', prop: 'actIdleMs', scale: 1000, label: 'Count as away after', unit: 's', type: 'int', min: 10, max: 600,
    help: 'No keyboard or mouse for this long and study time counts as away. Dictation needs a generous number.' },
  { group: 'Par', key: 'WarnPct', prop: 'warnPct', label: 'Overtime warning at', unit: '% of par', type: 'int', min: 100, max: 400 },
  { group: 'Wellness', key: 'BreakMinutes', prop: 'breakMs', scale: 60000, label: 'A break is', unit: 'min away', type: 'num', min: 0.5, max: 30 },
  { group: 'Goals', key: 'GoalBase', prop: 'goalBase', label: 'Credit starts at', unit: 'IVU', type: 'num', min: 0, max: 500,
    help: 'One credit (one hour) for every step past this.' },
  { group: 'Goals', key: 'GoalStep', prop: 'goalStep', label: 'One credit every', unit: 'IVU', type: 'num', min: 0.5, max: 100 },
  { group: 'Goals', key: 'FillerName', prop: 'fillerName', label: 'Filler exam name', type: 'text',
    help: 'The exam read to top the day up; the dashboard counts shortfalls in it.' },
  { group: 'Goals', key: 'FillerMatch', prop: 'fillerMatch', label: 'Filler exam pattern', type: 'text', mono: true },
  { group: 'Goals', key: 'FillerIVU', prop: 'fillerIvu', label: 'Filler exam IVU', unit: '0 = from the log', type: 'num', min: 0, max: 50 },
  { group: 'Money', key: 'HourlyRate', prop: 'hourlyRate', label: 'Hourly rate', unit: '$ / hour', type: 'num', min: 0, max: 5000,
    help: 'Prices time (idle gaps, engaged hours), never a study. 0 = no dollar figures.' },
  { group: 'Money', key: 'IvuPerRvu', prop: 'calScale', label: 'IVU per PowerScribe RVU', type: 'num', min: 0.01, max: 100 },
  { group: 'Rewards', key: 'RewardPerPoint', prop: 'rewardPerPoint', label: 'Dollars per point', unit: '$', type: 'num', min: 0, max: 100 },
  { group: 'Rewards', key: 'RewardWeekCap', prop: 'rewardWeekCap', label: 'Weekly cap', unit: '$', type: 'num', min: 1, max: 100000 },
  { group: 'Rewards', key: 'RewardRungPts', prop: 'rewardRungPts', label: 'Points for the first rung', type: 'num', min: 1, max: 1000 },
  { group: 'Rewards', key: 'RewardStreakEvery', prop: 'rewardStreakEvery', label: 'Streak bonus every', unit: 'wins in a row', type: 'int', min: 1, max: 100 },
  { group: 'Rewards', key: 'RewardStreakBonus', prop: 'rewardStreakBonus', label: 'Streak bonus', unit: 'points', type: 'num', min: 0, max: 1000 },
  { group: 'Rewards', key: 'RewardStoreUrl', prop: 'rewardStoreUrl', label: 'Gift card page', type: 'text' },
  { group: 'Schedule', key: 'ShiftUrl', prop: 'shiftUrl', label: 'QGenda calendar link (iCal)', type: 'text', mono: true, secret: true,
    help: 'Your own link, kept only on this PC. In QGenda: Schedule > Calendar subscription (iCal), copy the link and paste it here. Empty = no schedule.' },
  { group: 'Schedule', section: 'ShiftClass', key: 'ModifierKeys', prop: 'clsModKeys', label: 'Side duties (comma list)', type: 'text' },
  { group: 'Schedule', section: 'ShiftClass', key: 'OffKeys', prop: 'clsOffKeys', label: 'Days off (comma list)', type: 'text' },
  { group: 'Schedule', section: 'ShiftClass', key: 'NoiseKeys', prop: 'clsNoiseKeys', label: 'Pay codes to ignore', type: 'text' },
  { group: 'Schedule', section: 'ShiftClass', key: 'OnsiteRegex', prop: 'clsOnsiteRe', label: 'On-site pattern', type: 'text', mono: true,
    help: 'Words in a QGenda shift that mean you read on site, e.g. \\b(MAIN|NORTH)\\b. Empty = none.' },
  { group: 'Schedule', section: 'ShiftClass', key: 'AmStart', prop: 'amStart', label: 'AM block starts', unit: 'hour', type: 'num', min: 0, max: 24 },
  { group: 'Schedule', section: 'ShiftClass', key: 'AmEnd', prop: 'amEnd', label: 'AM block ends', unit: 'hour', type: 'num', min: 0, max: 24 },
  { group: 'Schedule', section: 'ShiftClass', key: 'PmStart', prop: 'pmStart', label: 'PM block starts', unit: 'hour', type: 'num', min: 0, max: 24 },
  { group: 'Schedule', section: 'ShiftClass', key: 'PmEnd', prop: 'pmEnd', label: 'PM block ends', unit: 'hour', type: 'num', min: 0, max: 24 },
];

module.exports = { createSettings, defaults, FIELDS };
