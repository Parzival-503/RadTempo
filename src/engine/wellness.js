// Wellness: strain is time at the desk, measured from physical keyboard and
// mouse presence, never clock time and never sign events. You are on a break
// after BREAK_MIN of continuous absence; every other moment accrues strain.
// A break is the ONLY thing that clears strain - clicking the card does not.
// The card watches for the break instead of asking about it.

const { clockTime, isoDate } = require('./util');

const SNOOZE_MS = 900000; // extra strain before re-nudging when no break was taken
const CARD_MS = 45000; // the card lingers at least this long before auto-hiding

// Each prompt: [category, title, body]. Five categories carry thirty prompts.
const PROMPTS = [
  ['EYES', 'Look 20 feet away', 'Twenty seconds on something distant. The focus muscles unclench.'],
  ['MOVE', 'Stand and reach', 'Arms overhead, thirty seconds. Your spine has been waiting.'],
  ['NECK', 'Roll your shoulders', 'Ten backward, ten forward. Let the tension go somewhere else.'],
  ['WATER', 'Refill', 'Hydration is not optional equipment for an accurate read.'],
  ['NECK', 'Ear to shoulder', 'Slowly, each side, hold ten. Neck relief incoming.'],
  ['BREATHE', 'Five deep breaths', 'In for four, out for six. Eyes closed. Reset the room.'],
  ['MOVE', 'Ten calf raises', 'Gets the blood back up out of your legs.'],
  ['NECK', 'Squeeze the blades', 'Shoulder blades together, hold ten. Five times.'],
  ['MOVE', 'Wrist circles', 'Flex and extend, ten each way. Protect the hands you work with.'],
  ['EYES', 'Find a window', 'Thirty seconds of distance does more for your eyes than blinking.'],
  ['NECK', 'Sit tall', 'A string pulling up from the crown of your head. Hold that.'],
  ['MOVE', 'Push the palms out', 'Fingers interlocked, arms forward, fifteen seconds.'],
  ['NECK', 'Five chin tucks', 'Chin straight back, hold five. Undoes the screen lean.'],
  ['WATER', 'Water or tea', 'A hydrated radiologist is an accurate radiologist.'],
  ['MOVE', 'Open the chest', 'Hands behind your head, elbows wide, arch back gently. Breathe.'],
  ['EYES', 'Blink twenty times', 'Then close them for ten. Screen fatigue, undone.'],
  ['MOVE', 'March in place', 'Thirty seconds. Sitting still is the part that costs you.'],
  ['MOVE', 'Ankle circles', 'Ten each direction. Circulation does not manage itself.'],
  ['MOVE', 'Press the palms', 'Together at your chest, push ten seconds, release. Repeat.'],
  ['EYES', 'Up, down, left, right', 'Five times around. The eye muscles get a stretch too.'],
  ['EYES', 'Palm your eyes', 'Elbows on the desk, palms cupping closed eyes. Twenty seconds of dark.'],
  ['NECK', 'Twist in the chair', 'Left, then right, ten seconds each. Spinal reset.'],
  ['MOVE', 'Shake out your hands', 'Ten seconds, vigorously. Wiggle the fingers.'],
  ['MOVE', 'Two-minute walk', 'A lap of the reading room counts. Just move.'],
  ['NECK', 'Open the jaw', 'Wide, then closed, five times. You have been clenching.'],
  ['MOVE', 'Reach for your toes', 'Or near them. Fifteen seconds, then straighten slowly.'],
  ['NECK', 'Hand to shoulder', 'Right hand on left shoulder, look right, hold ten. Switch.'],
  ['BREATHE', 'Box breathing', 'In four, hold four, out four, hold four. Twice around.'],
  ['MOVE', 'Straighten a leg', 'Under the desk, hold ten, switch. Quiet quad work.'],
  ['BREATHE', 'You have earned this', 'That is a long stretch at the desk. Five minutes is cheap.'],
];

const CATS = {
  EYES: { name: 'EYES', color: '#3987E5', icon: 'eye' },
  NECK: { name: 'NECK', color: '#9085E9', icon: 'neck' },
  WATER: { name: 'HYDRATE', color: '#C98500', icon: 'water' },
  BREATHE: { name: 'BREATHE', color: '#D55181', icon: 'breathe' },
  MOVE: { name: 'MOVE', color: '#199E70', icon: 'move' },
};

function createWellness({ cfg, idleMs, now = Date.now, onCard = () => {} }) {
  const st = {
    strainMs: 0,
    lastTick: 0,
    nextMs: cfg.wellnessMinutes * 60000,
    index: 0,
    lastBreak: '',
    breaksToday: 0,
    breaksDate: '',
    card: null, // { mode, at, done, doneAt, prompt }
  };
  const limit = () => cfg.wellnessMinutes * 60000;

  function creditBreak() {
    st.strainMs = 0;
    st.nextMs = limit();
    st.lastBreak = clockTime(new Date(now()));
    const d = isoDate(new Date(now()));
    if (st.breaksDate !== d) {
      st.breaksDate = d;
      st.breaksToday = 0;
    }
    st.breaksToday++;
  }

  // Every 5 s for the whole session.
  function tick() {
    const t = now();
    if (!st.lastTick) {
      st.lastTick = t;
      return;
    }
    let delta = t - st.lastTick;
    st.lastTick = t;
    if (delta <= 0) return;
    if (delta > 15000) delta = 15000; // sleep/resume must not dump an hour into strain
    if (idleMs() >= cfg.breakMs) {
      if (st.strainMs > 0) {
        creditBreak();
        if (st.card) st.card.done = true;
      }
      return;
    }
    st.strainMs += delta;
    if (st.strainMs >= st.nextMs && !st.card) {
      st.nextMs = st.strainMs + SNOOZE_MS;
      show('nudge');
    }
  }

  function show(mode) {
    let prompt = null;
    if (mode === 'nudge') {
      st.index = st.index >= PROMPTS.length ? 1 : st.index + 1;
      const [cat, title, body] = PROMPTS[st.index - 1];
      prompt = { cat, title, body, ...CATS[cat] };
    }
    st.card = { mode, at: now(), done: false, doneAt: 0, prompt };
    onCard('show', cardView());
  }

  function hide() {
    if (!st.card) return;
    st.card = null;
    onCard('hide');
  }

  // Button A: on a nudge, snooze; otherwise just close. Button B: dismiss.
  function buttonA() {
    if (st.card && st.card.mode === 'nudge' && !st.card.done) st.nextMs = st.strainMs + SNOOZE_MS;
    hide();
  }

  // Every 250 ms while the card is up. Returns the view, or null once hidden.
  function cardTick() {
    const c = st.card;
    if (!c) return null;
    if (c.done) {
      if (!c.doneAt) c.doneAt = now();
      if (now() - c.doneAt > 5000) {
        hide();
        return null;
      }
      return cardView();
    }
    // Auto-hide only once you are demonstrably back and ignoring it; a fixed
    // timer would close it mid-break, right before the break completes.
    const age = now() - c.at;
    const idle = idleMs();
    if ((age > CARD_MS && idle < 5000) || age > cfg.breakMs + 600000) {
      hide();
      return null;
    }
    return cardView();
  }

  function cardView() {
    const c = st.card;
    if (!c) return null;
    const idle = idleMs();
    const mins = Math.round(st.strainMs / 60000);
    const lim = limit();
    const fmt = (ms) => {
      const s = Math.round(ms / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const meter = c.done ? 100 : Math.min(100, Math.round((idle / cfg.breakMs) * 100));
    if (c.done) {
      return {
        mode: 'done',
        color: '#0CA30C',
        icon: 'check',
        cat: 'BREAK LOGGED',
        title: 'Strain cleared',
        body: `That counted - break ${st.breaksToday} today. The clock starts again from zero.`,
        meter: 100,
        accent: 100,
        foot: '',
        buttons: [{ id: 'a', label: 'Nice' }],
      };
    }
    if (c.mode === 'status') {
      const left = Math.max(0, Math.round((lim - st.strainMs) / 60000));
      let body = st.strainMs >= lim ? `You are past the ${lim / 60000}-minute mark. A break is due.` : `${left} min of desk time until the next nudge.`;
      body += `  Last break ${st.lastBreak || 'not yet today'}, ${st.breaksToday} today.`;
      return {
        mode: 'status',
        color: '#3987E5',
        icon: 'gauge',
        cat: 'WELLNESS',
        title: `${mins} min at the desk`,
        body,
        meter,
        accent: lim > 0 ? Math.min(100, Math.round((st.strainMs / lim) * 100)) : 0,
        foot: `Away ${fmt(idle)} of ${fmt(cfg.breakMs)} - stay away and the strain clears.`,
        buttons: [{ id: 'a', label: 'Close' }],
      };
    }
    const p = c.prompt;
    return {
      mode: 'nudge',
      color: p.color,
      icon: p.icon,
      cat: `${p.name}   •   ${mins} MIN AT THE DESK`,
      title: p.title,
      body: p.body,
      meter,
      accent: 100,
      foot: `Step away for ${fmt(cfg.breakMs)} and this clears itself. ${fmt(idle)} so far.`,
      buttons: [
        { id: 'a', label: `Snooze ${SNOOZE_MS / 60000} min` },
        { id: 'b', label: 'Dismiss' },
      ],
    };
  }

  // Changing the interval re-aims the pending nudge at the new level.
  function setInterval(mins) {
    cfg.wellnessMinutes = mins;
    st.nextMs = mins * 60000;
  }

  function newDay() {
    st.breaksToday = 0;
    st.breaksDate = isoDate(new Date(now()));
  }

  return {
    tick,
    show,
    hide,
    buttonA,
    buttonB: hide,
    cardTick,
    cardView,
    creditBreak,
    setInterval,
    newDay,
    state: st,
    isOpen: () => !!st.card,
  };
}

module.exports = { createWellness, PROMPTS, CATS, SNOOZE_MS };
