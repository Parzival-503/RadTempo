// The timer widget. Renders the core's view; every click goes back to main.
(function () {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const banner = $('banner');
  let last = null;

  $('aForecast').innerHTML = icon('sigma');
  $('aPaste').innerHTML = icon('paste');
  $('aReset').innerHTML = icon('undo');
  $('aMenu').innerHTML = icon('list');

  // ---- click-through outside the card: tell main when the pointer is over
  // something we own, so the transparent margin never blocks other windows.
  let inside = false;
  function setInside(v) {
    if (v === inside) return;
    inside = v;
    rt.send('w:mouse', v);
  }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    setInside(!!(el && (card.contains(el) || banner.contains(el))));
  });
  document.addEventListener('mouseleave', () => setInside(false));

  // ---- drag the card from anywhere that is not a button
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    card.setPointerCapture(e.pointerId);
    rt.send('w:drag', 'start');
    const end = () => {
      rt.send('w:drag', 'end');
      card.removeEventListener('pointerup', end);
      card.removeEventListener('lostpointercapture', end);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('lostpointercapture', end);
  });

  // ---- right-click anywhere: the menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    rt.send('w:action', 'menu', { x: e.clientX, y: e.clientY });
  });

  // ---- scroll over the card nudges this study's par
  card.addEventListener(
    'wheel',
    (e) => {
      if (!last || !last.running) return;
      e.preventDefault();
      rt.send('w:action', 'nudge', e.deltaY < 0 ? 1 : -1);
    },
    { passive: false }
  );

  $('aForecast').onclick = () => rt.send('w:action', 'forecast');
  $('aPaste').onclick = () => rt.send('w:action', 'paste');
  $('aReset').onclick = () => rt.send('w:action', 'reset');
  $('aMenu').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    rt.send('w:action', 'menu', { x: r.left, y: r.bottom });
  };
  $('slot').onclick = () => rt.send('w:action', 'par');
  $('ivuStat').onclick = () => rt.send('w:action', 'breakdown');

  // Modality strip, built once.
  let modsBuilt = false;
  function buildMods(mods) {
    const host = $('mods');
    host.innerHTML = '';
    for (const m of mods) {
      const b = document.createElement('button');
      b.textContent = m.id;
      b.dataset.mod = m.id;
      b.style.setProperty('--mc', m.color);
      b.title = `Set the modality to ${m.id}`;
      b.setAttribute('role', 'radio');
      b.onclick = () => rt.send('w:action', 'mod', m.id);
      host.appendChild(b);
    }
    modsBuilt = true;
  }

  function render(v) {
    last = v;
    if (!modsBuilt) buildMods(v.mods);
    card.className = 'card ' + v.phase + (v.dot === 'away' ? ' away' : '');
    $('clock').textContent = v.clock;
    const st = $('status');
    const down = v.helperDown && v.phase === 'idle';
    st.textContent = down ? 'F4 / F12 NOT WATCHED' : v.status;
    st.className = 'status ' + (down ? 'warn' : v.tone || '');
    st.title = down ? 'The keyboard helper is not running, so F4 and F12 are not seen. Menu > Data & tools > Helper status.' : '';
    $('dot').className = 'sdot ' + (v.dot || '');

    // EXAMS when idle; PAR (clickable) while a study runs.
    $('slotLabel').textContent = v.slot.label;
    $('slotValue').textContent = v.slot.value;
    $('slot').title = v.running ? 'Click to set this study’s par (or scroll over the timer)' : 'Today’s studies';

    $('ivu').textContent = v.ivu;
    const il = $('ivuLabel');
    if (v.goal > 0) {
      il.innerHTML = `<span class="pill ${v.goalPct >= 100 ? 'met' : ''}">${v.goalPct}%</span>`;
      $('ivuStat').title = `Today's IVU: ${v.goalPct}% of your ${v.goal} goal - click for the breakdown`;
    } else {
      il.textContent = 'IVU';
      $('ivuStat').title = 'Today’s IVU - click for the breakdown';
    }

    for (const b of $('mods').children) {
      const on = b.dataset.mod === v.mod;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    }

    const rb = $('aReset');
    rb.classList.toggle('undo', !!v.undo);
    rb.innerHTML = v.undo ? icon('close') : icon('undo');
    rb.title = v.undo ? 'Undo that sign (removes it from the log)' : 'Reset the current timer (nothing is logged)';

    const bar = $('bar');
    bar.style.width = (v.bar && v.bar.pct != null ? v.bar.pct : 100) + '%';
    bar.style.background = (v.bar && v.bar.color) || '#2b2b52';

    const bn = v.banner;
    if (bn && bn.text) {
      banner.hidden = false;
      banner.classList.toggle('signed', !!bn.signed);
      $('bannerText').textContent = bn.text;
      banner.title = bn.text;
      const mc = (v.mods.find((m) => m.id === v.mod) || {}).color;
      banner.style.setProperty('--mc', mc);
      const bi = $('bannerIvu');
      bi.textContent = bn.ivu > 0 ? `IVU ${bn.ivu.toFixed(2)}${bn.shaky ? ' ~' : ''}` : '';
      bi.classList.toggle('shaky', !!bn.shaky);
      bi.title = bn.shaky ? 'A weak match from the exam text, not the order code' : '';
    } else banner.hidden = true;
  }

  rt.on('w:state', render);
})();
