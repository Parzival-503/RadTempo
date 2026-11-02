// The wellness card. Never takes focus (dictation keeps going); it watches
// for the break instead of asking about it.
(function () {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  let mode = '';
  rt.on('c:view', (v) => {
    if (!v) return;
    card.style.setProperty('--c', v.color);
    if (v.mode !== mode) {
      mode = v.mode;
      $('icon').innerHTML = icon(v.icon);
      const b = $('btns');
      b.innerHTML = '';
      for (const btn of v.buttons) {
        const el = document.createElement('button');
        el.textContent = btn.label;
        el.onclick = () => rt.send('c:btn', btn.id);
        b.appendChild(el);
      }
    }
    $('cat').textContent = v.cat;
    $('title').textContent = v.title;
    $('body').textContent = v.body;
    $('meter').style.width = v.meter + '%';
    $('accent').style.width = v.accent + '%';
    $('foot').textContent = v.foot;
    card.classList.add('on');
  });
  rt.on('c:hide', () => {
    card.classList.remove('on');
    mode = '';
  });
})();
