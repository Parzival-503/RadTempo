// The menu: a summary card, then items. Submenus slide in over the list with
// a back arrow; switches and radio choices apply in place and keep the menu
// open, everything else closes it. Arrow keys, Enter, Esc / Left all work.
(function () {
  const panel = document.getElementById('panel');
  const views = document.getElementById('views');
  let data = null;
  let stack = []; // ids of open submenus
  let kbIndex = -1;

  document.getElementById('backdrop').addEventListener('mousedown', () => rt.send('m:close'));

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function findSub(items, id) {
    for (const it of items) if (it.id === id && it.sub) return it;
    return null;
  }

  function header(h) {
    const goal = h.goal > 0;
    const pct = goal ? Math.min(100, h.goalPct || 0) : 0;
    return `<div class="hdr">
      <div class="brand"><span class="logo">${icon('clock')}</span>RADTEMPO${h.running ? `<span class="live">${esc(h.mod)} ${esc(h.clock)}</span>` : ''}</div>
      <div class="nums">
        <div class="n"><b>${h.count}</b><span>STUDIES</span></div>
        <div class="n"><b>${esc(h.ivu)}</b><span>IVU TODAY</span></div>
        ${h.credits > 0 ? `<div class="n"><b>${h.credits}</b><span>CREDITS</span></div>` : ''}
      </div>
      ${goal ? `<div class="goal"><div class="row"><span>Goal ${Number(h.goal).toFixed(1)}</span><em>${h.goalPct}%</em></div><div class="gbar"><i style="width:${pct}%"></i></div></div>`
        : `<div class="goal"><div class="row"><span>No goal set today</span><em>${h.credits > 0 ? 'next rung ' + Number(h.next).toFixed(0) : 'credits from ' + Number(h.next).toFixed(0)}</em></div></div>`}
      ${h.block ? `<div class="block">Block <b>${esc(h.block)}</b>${h.extras ? ' + ' + esc(h.extras) : ''}</div>` : ''}
    </div>`;
  }

  function itemHtml(it, i) {
    if (it.sep) return '<div class="sep"></div>';
    if (it.bar)
      return `<div class="bar">${it.bar
        .map((b, j) => `<button class="bb ${b.danger ? 'danger' : ''} ${b.on ? 'on' : ''}" data-i="${i}" data-j="${j}" title="${esc(b.label)}">${icon(b.icon)}<span>${esc(b.label.replace(/ RadTempo| the timer| to the corner/g, ''))}</span></button>`)
        .join('')}</div>`;
    if (it.section) return `<div class="section">${esc(it.label)}</div>`;
    let lead = it.swatch ? `<span class="sw" style="--c:${it.swatch}"></span>` : it.icon ? icon(it.icon) : '';
    let tail = '';
    if (it.check === true) tail = `<span class="tg ${it.on ? 'on' : ''}"></span>`;
    else if (it.check === 'radio') tail = (it.hint ? `<span class="hint">${esc(it.hint)}</span>` : '') + `<span class="rd ${it.on ? 'on' : ''}"></span>`;
    else if (it.hint) tail = `<span class="hint">${esc(it.hint)}</span>`;
    if (it.sub) tail = (it.hint ? `<span class="hint">${esc(it.hint)}</span>` : '') + `<span class="chev">${icon('chev-r')}</span>`;
    return `<button class="item ${it.danger ? 'danger' : ''}" data-i="${i}" role="menuitem" ${it.disabled ? 'disabled' : ''}>
      <span class="ic">${lead}</span><span class="lb">${esc(it.label)}</span>${tail}</button>`;
  }

  function build(items, title) {
    const v = document.createElement('div');
    v.className = 'view';
    let html = '';
    if (title) html += `<div class="subhdr"><button class="back" title="Back">${icon('chev-l')}</button><span class="t">${esc(title)}</span></div>`;
    else html += header(data.header);
    html += items.map(itemHtml).join('');
    v.innerHTML = html;
    v.querySelectorAll('.bb').forEach((b) => {
      const it = items[+b.dataset.i].bar[+b.dataset.j];
      b.addEventListener('click', () => activate(it));
    });
    v.querySelectorAll('.item').forEach((b) => {
      const it = items[+b.dataset.i];
      b.addEventListener('click', () => activate(it));
      b.addEventListener('mouseenter', () => setKb(-1));
    });
    const back = v.querySelector('.back');
    if (back) back.addEventListener('click', pop);
    return v;
  }

  function currentItems() {
    let items = data.items;
    const titles = [];
    for (const id of stack) {
      const s = findSub(items, id);
      if (!s) break;
      titles.push(s.label);
      items = s.sub;
    }
    return { items, title: titles[titles.length - 1] || '' };
  }

  function render(dir) {
    const { items, title } = currentItems();
    const nv = build(items, title);
    const old = views.querySelector('.view:not(.leaving)');
    views.appendChild(nv);
    if (old && dir) {
      old.classList.add('leaving', dir === 'in' ? 'out-left' : 'out-right');
      nv.classList.add(dir === 'in' ? 'out-right' : 'out-left');
      requestAnimationFrame(() => requestAnimationFrame(() => nv.classList.remove('out-right', 'out-left')));
      setTimeout(() => old.remove(), 260);
    } else if (old) old.remove();
    views.style.height = nv.offsetHeight + 'px';
    kbIndex = -1;
    place(nv.offsetHeight);
  }

  // Sit at the cursor; near the bottom of the screen grow upward instead.
  let rootTop = 8;
  function place(h) {
    const H = window.innerHeight;
    const want = stack.length ? rootTop : data.cursorY != null ? data.cursorY - 6 : 8;
    let top = Math.max(8, Math.min(want, H - h - 10));
    if (!stack.length) rootTop = top;
    panel.style.top = top + 'px';
    panel.classList.toggle('up', top + h > H - 30);
  }

  function activate(it) {
    if (!it || it.disabled || it.sep || it.section) return;
    if (it.sub) {
      stack.push(it.id);
      return render('in');
    }
    if (it.check) return rt.send('m:pick', it.id, true);
    rt.send('m:pick', it.id, false);
  }

  function pop() {
    if (!stack.length) return rt.send('m:close');
    stack.pop();
    render('out');
  }

  function buttons() {
    const v = views.querySelector('.view:not(.leaving)');
    return v ? [...v.querySelectorAll('.item:not([disabled]), .bb')] : [];
  }
  function setKb(i) {
    const bs = buttons();
    bs.forEach((b) => b.classList.remove('kb'));
    kbIndex = i;
    if (i >= 0 && bs[i]) {
      bs[i].classList.add('kb');
      bs[i].scrollIntoView({ block: 'nearest' });
    }
  }

  document.addEventListener('keydown', (e) => {
    const bs = buttons();
    if (e.key === 'ArrowDown') setKb((kbIndex + 1) % bs.length);
    else if (e.key === 'ArrowUp') setKb(kbIndex <= 0 ? bs.length - 1 : kbIndex - 1);
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      if (kbIndex >= 0 && bs[kbIndex]) bs[kbIndex].click();
    } else if (e.key === 'Escape') rt.send('m:close');
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') pop();
    else return;
    e.preventDefault();
  });

  rt.on('m:data', (d) => {
    const keep = d.keep;
    data = d;
    if (!keep) stack = [];
    render(null);
    panel.classList.add('on');
  });
  rt.on('m:reset', () => {
    panel.classList.remove('on');
    stack = [];
  });
})();
