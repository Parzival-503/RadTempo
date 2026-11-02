// The one menu, shown from the tray icon and by right-clicking the widget.
// Built fresh each time it opens, so ticks and labels are always current.
// Grouped by how often things get used; submenus open in place (the panel
// slides over), never more than two levels deep.
//
// Item: { id, label, icon, hint, check: true|false (toggle) | 'radio',
//         on, sub: [...], danger, disabled, swatch }
// The renderer sends back the id; main.js runs it.

const { MOD_COLORS } = require('../engine/modality');

function buildMenu(ctx) {
  const { view: v, goal, cfg, reward, widgetVisible, helper, startWithWindows } = ctx;
  const sep = { sep: true };

  const goalSub = [
    { id: 'goal:set', label: "Set today's goal…", icon: 'target' },
    { id: 'goal:typical', label: 'Match a typical day', icon: 'calendar', hint: goal.typical > 0 ? goal.typical.toFixed(1) : '' },
    sep,
    { label: 'Rungs', section: true },
    ...goal.rungs.map((r) => ({
      id: 'goal:rung:' + r.ivu,
      label: `${r.label} IVU`,
      hint: `${r.credits} ${r.credits === 1 ? 'credit' : 'credits'}`,
      check: 'radio',
      on: Math.abs(goal.goal - r.ivu) < 0.001,
    })),
    sep,
    { id: 'goal:clear', label: "Clear today's goal", icon: 'close', disabled: !(goal.goal > 0) },
  ];

  const rewardSub = [
    { id: 'reward:today', label: "Today's reward", icon: 'sparkle', hint: '$' + reward.todayDollars.toFixed(2) },
    { id: 'reward:bank', label: 'The bank', icon: 'bank', hint: '$' + reward.balance.toFixed(2) },
    sep,
    { id: 'reward:cashout', label: 'Cash out…', icon: 'gift', disabled: reward.balance < 1 },
    sep,
    { id: 'reward:rate', label: 'Dollars per point…', icon: 'coin', hint: '$' + cfg.rewardPerPoint.toFixed(2) },
    { id: 'reward:restart', label: 'Start the bank today', icon: 'refresh' },
  ];

  const examSub = [
    { id: 'exam:refetch', label: 'Re-fetch from PowerScribe', icon: 'download', disabled: !v.running },
    { id: 'exam:type', label: 'Type the title in…', icon: 'edit', disabled: !v.running },
  ];

  const fixSub = ['CR', 'CT', 'MR', 'US', 'PET'].map((m) => ({ id: 'fix:' + m, label: `Change to ${m}`, swatch: MOD_COLORS[m] }));

  const shiftSub = [
    { id: 'shift:today', label: "Today's shift", icon: 'calendar' },
    { id: 'shift:view', label: 'View schedule', icon: 'list' },
    sep,
    { id: 'shift:refresh', label: 'Refresh from QGenda', icon: 'refresh' },
    { id: 'shift:backfill', label: 'Backfill log shifts', icon: 'history' },
  ];

  const parSub = [
    { id: 'par:warn', label: 'Overtime warning', check: true, on: cfg.warnEnabled },
    sep,
    { label: 'Warn at', section: true },
    ...[125, 150, 200].map((p) => ({ id: 'par:pct:' + p, label: `${p}% of par`, check: 'radio', on: cfg.warnPct === p })),
    sep,
    { id: 'par:recompute', label: 'Recompute pars from history', icon: 'refresh' },
  ];

  const actSub = [
    { id: 'act:toggle', label: 'Track keyboard & mouse', check: true, on: cfg.actEnabled },
    sep,
    { label: 'Count as away after', section: true },
    ...[30, 60, 90].map((s) => ({ id: 'act:idle:' + s, label: `${s} seconds`, check: 'radio', on: Math.round(cfg.actIdleMs / 1000) === s })),
  ];

  const wellSub = [
    { id: 'well:status', label: 'Where am I?', icon: 'gauge' },
    { id: 'well:preview', label: 'Preview a nudge', icon: 'bell' },
    sep,
    { label: 'Nudge after', section: true },
    ...[60, 90].map((m) => ({ id: 'well:min:' + m, label: `${m} min at the desk`, check: 'radio', on: cfg.wellnessMinutes === m })),
    sep,
    { id: 'well:reset', label: 'Reset strain', icon: 'refresh' },
  ];

  const dataSub = [
    { id: 'data:folder', label: 'Open the data folder', icon: 'folder' },
    { id: 'data:browser', label: 'Open the dashboard in a browser', icon: 'globe' },
    sep,
    { id: 'data:resetday', label: 'Reset day count', icon: 'refresh' },
    { id: 'data:clean', label: 'Clean database…', icon: 'broom' },
    { id: 'data:outliers', label: 'Remove outliers…', icon: 'filter' },
  ];

  const diagSub = [
    { id: 'diag:status', label: 'Helper status', icon: 'pulse', hint: helper.connected ? 'connected' : 'not connected' },
    { id: 'diag:pacs', label: 'Find PACS controls', icon: 'search' },
    sep,
    { id: 'diag:start', label: 'Test start', icon: 'play' },
    { id: 'diag:stop', label: 'Test stop', icon: 'stop' },
  ];

  const settingsSub = [
    { id: 'par', label: 'Par & overtime', icon: 'flag', sub: parSub },
    { id: 'act', label: 'Activity tracking', icon: 'mouse', sub: actSub },
    { id: 'well', label: 'Wellness', icon: 'heart', sub: wellSub },
    sep,
    { id: 'login:toggle', label: 'Start with Windows', check: true, on: startWithWindows },
    { id: 'settings', label: 'All settings…', icon: 'sliders' },
  ];

  const toolsSub = [...dataSub, sep, { label: 'Diagnostics', section: true }, ...diagSub];

  return [
    { id: 'dashboard', label: 'Dashboard', icon: 'chart' },
    { id: 'goal', label: 'Daily goal', icon: 'target', hint: goal.goal > 0 ? `${goal.goal.toFixed(1)}` : '', sub: goalSub },
    ...(cfg.rewardEnabled ? [{ id: 'rewards', label: 'Rewards', icon: 'gift', hint: '$' + reward.balance.toFixed(2), sub: rewardSub }] : []),
    { id: 'calib', label: "Correct today's total…", icon: 'delta' },
    { label: 'This study', section: true },
    { id: 'exam', label: 'Exam title', icon: 'doc', sub: examSub },
    { id: 'par:set', label: 'Set par…', icon: 'flag', disabled: !v.running, hint: v.running && v.parSec > 0 ? v.slot.value : '' },
    { id: 'fix', label: 'Fix last study', icon: 'wrench', sub: fixSub },
    { id: 'undo', label: 'Undo last sign', icon: 'undo' },
    { label: 'More', section: true },
    { id: 'shifts', label: 'Shifts', icon: 'calendar', hint: v.block || '', sub: shiftSub },
    { id: 'prefs', label: 'Settings', icon: 'sliders', sub: settingsSub },
    { id: 'tools', label: 'Data & tools', icon: 'database', sub: toolsSub },
    {
      bar: [
        { id: 'widget:toggle', icon: widgetVisible ? 'eye' : 'eye', label: widgetVisible ? 'Hide the timer' : 'Show the timer', on: widgetVisible },
        { id: 'widget:snap', icon: 'corner', label: 'Snap the timer to the corner' },
        { id: 'quit', icon: 'power', label: 'Quit RadTempo', danger: true },
      ],
    },
  ];
}

// The summary card at the top of the menu.
function menuHeader(ctx) {
  const { view: v, goal } = ctx;
  return {
    running: v.running,
    count: v.count,
    ivu: v.ivu,
    goal: goal.goal,
    goalPct: v.goalPct,
    credits: v.credits,
    next: goal.next,
    block: v.block,
    extras: v.extras,
    clock: v.running ? v.clock : '',
    mod: v.mod,
  };
}

module.exports = { buildMenu, menuHeader };
