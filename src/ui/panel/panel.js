// Every RadTempo dialog is one of these views. Main supplies plain data
// (p:get) and runs the actions (p:do); this page only draws and asks.
(function () {
  const VIEW = new URLSearchParams(location.search).get('view');
  const $ = (id) => document.getElementById(id);
  const P = $('p');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const f1 = (n) => Number(n || 0).toFixed(1);
  const f2 = (n) => Number(n || 0).toFixed(2);
  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const MODC = { CR: 'var(--cr)', CT: 'var(--ct)', MR: 'var(--mr)', US: 'var(--us)', PET: 'var(--pet)' };
  const TONES = { good: 'var(--good)', warn: 'var(--warn)', violet: '#b9b2ff', amber: 'var(--run)' };

  const act = (action, payload) => rt.invoke('p:do', VIEW, action, payload || {});
  const close = (restore = true) => act('close', { restore });

  $('x').innerHTML = icon('close');
  $('x').onclick = () => close();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement && document.activeElement.tagName !== 'TEXTAREA') {
      const p = document.querySelector('.pf .primary, .pf .danger');
      if (p && document.activeElement.tagName !== 'BUTTON') {
        e.preventDefault();
        p.click();
      }
    }
  });

  function frame({ title, sub = '', icon: ic = 'info', tone = '' }) {
    $('title').textContent = title;
    $('sub').textContent = sub;
    $('badge').innerHTML = icon(ic);
    P.style.setProperty('--tone', TONES[tone] || '');
  }

  function footer(btns) {
    const f = $('foot');
    f.innerHTML = '';
    for (const b of btns) {
      if (b === '|') {
        f.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));
        continue;
      }
      const el = document.createElement('button');
      el.className = 'btn ' + (b.kind || '');
      el.innerHTML = (b.icon ? icon(b.icon) : '') + esc(b.label);
      el.onclick = b.onClick;
      if (b.id) el.id = b.id;
      f.appendChild(el);
    }
  }

  // Size the window to the content: header + everything in the body + footer.
  function fit() {
    const measure = () => {
      const need = $('ph').offsetHeight + $('body').scrollHeight + $('foot').offsetHeight + 24;
      rt.send('p:size', window.innerWidth, Math.min(need, screen.availHeight - 40));
    };
    requestAnimationFrame(() => requestAnimationFrame(measure));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  }

  const body = (html) => {
    $('body').innerHTML = html;
    fit();
  };

  // ------------------------------------------------------------ views

  const V = {};

  V.par = (d) => {
    frame({ title: 'Set par', sub: d.exam || 'exam not detected yet', icon: 'flag' });
    const adj = d.adjust === 0 ? 'no adjustment' : `${d.adjust > 0 ? '+' : '−'}${fmt(Math.abs(d.adjust))} vs suggested`;
    body(`
      <div class="bigpar"><span class="v">${esc(d.parSec > 0 ? d.par : '--:--')}</span></div>
      <div class="center muted">${d.parBase > 0 ? 'suggested ' + fmt(d.parBase) : 'suggested par not known yet'} &nbsp;·&nbsp; ${adj}</div>
      <div class="steps">
        <button class="btn" data-d="-60">−1:00</button><button class="btn" data-d="-15">−0:15</button>
        <button class="btn" data-s="1">Suggested</button>
        <button class="btn" data-d="15">+0:15</button><button class="btn" data-d="60">+1:00</button>
      </div>
      <div class="note">Par is engaged time - away time never counts against it. Scroll over the timer to nudge it too.</div>`);
    $('body').querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => act('parShift', { delta: +b.dataset.d }).then(render)));
    $('body').querySelector('[data-s]').onclick = () => act('parSuggested').then(render);
    footer([{ label: 'Done', kind: 'primary', onClick: () => close() }]);
    if (!d.running) close();
  };

  V.goal = (d) => {
    frame({ title: "Today's IVU goal", sub: d.date, icon: 'target' });
    const chips = d.rungs
      .map((r) => `<button class="chip ${Math.abs(d.goal - r.ivu) < 0.001 ? 'on' : ''}" data-v="${r.ivu}">${esc(r.label)} <small>${r.credits} cr</small></button>`)
      .join('');
    body(`
      <div class="cards">
        <div class="kpi blue"><div class="l">Today</div><div class="v">${f1(d.today)}</div><div class="s">${d.credits} ${d.credits === 1 ? 'credit' : 'credits'} so far</div></div>
        <div class="kpi"><div class="l">Typical day</div><div class="v">${f1(d.typical)}</div><div class="s">median of worked days</div></div>
      </div>
      <div class="field"><label for="g">Goal (IVU)</label><input id="g" class="inp big" inputmode="decimal" value="${esc(d.suggested)}"></div>
      <div class="muted" style="font-size:11.5px">Next rungs: ${d.upcoming.map(esc).join(' · ')}. Between two rungs pays the rung below, so pick one.</div>
      <div class="chips">${chips}</div>
      <div class="err" id="err"></div>`);
    const g = $('g');
    g.focus();
    g.select();
    $('body').querySelectorAll('.chip').forEach((c) => (c.onclick = () => {
      g.value = c.dataset.v;
      $('body').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    }));
    footer([
      { label: 'Clear goal', onClick: () => act('goalSave', { value: 0 }) },
      '|',
      { label: 'Cancel', onClick: () => close() },
      { label: 'Set goal', kind: 'primary', icon: 'check', onClick: () => act('goalSave', { value: parseFloat(g.value) || 0 }) },
    ]);
  };

  V.calib = (d) => {
    frame({ title: "Correct today's total", sub: "Make the widget agree with PowerScribe", icon: 'delta' });
    body(`
      <p class="lead">Open <b>Dashboards → My productivity</b> (Time Frame = Today) in PowerScribe and type its <b>RVU Sum</b>. Today's tally becomes that number.</p>
      <div class="cards" style="margin-top:12px">
        <div class="kpi"><div class="l">From the IVU table</div><div class="v">${f2(d.logged)}</div></div>
        <div class="kpi blue"><div class="l">On the widget</div><div class="v">${f2(d.showing)}</div><div class="s">${Math.abs(d.adjust) > 0.001 ? 'corrected ' + (d.adjust >= 0 ? '+' : '') + f2(d.adjust) : 'not corrected'}</div></div>
      </div>
      <div class="field"><label for="v">PowerScribe RVU Sum</label><input id="v" class="inp big" inputmode="decimal" placeholder="0.00"></div>
      <div class="err" id="err"></div>
      <div class="note">Studies signed after this are added on top until you correct it again. 1 RVU = <b id="sc">${esc(d.scale)}</b> IVU <button class="btn small" id="scb" style="margin-left:6px">Change</button></div>`);
    $('v').focus();
    $('scb').onclick = () => {
      const n = document.querySelector('.note');
      n.innerHTML = `1 RVU = <input id="scv" class="inp" style="height:28px;width:80px;font-size:12px;display:inline-block;vertical-align:middle" value="${esc(d.scale)}"> IVU <button class="btn small" id="scs">Save</button>`;
      $('scv').focus();
      $('scs').onclick = async () => {
        const r = await act('calibScale', { value: parseFloat($('scv').value) });
        if (r && r.error) $('err').textContent = r.error;
        else render(r);
      };
    };
    footer([
      { label: 'Clear correction', onClick: () => act('calibClear') },
      '|',
      { label: 'Cancel', onClick: () => close() },
      {
        label: 'Apply',
        kind: 'primary',
        icon: 'check',
        onClick: async () => {
          const r = await act('calibApply', { value: parseFloat($('v').value) });
          if (r && r.error) $('err').textContent = r.error;
        },
      },
    ]);
  };

  V.examTitle = (d) => {
    frame({ title: 'Exam title', sub: 'For the study you are reading now', icon: 'edit' });
    body(`
      <div class="field"><label for="t">Exam description</label><input id="t" class="inp" value="${esc(d.exam)}" placeholder="e.g. CT CHEST WITH CONTRAST"></div>
      <div class="note">This feeds the log, the IVU lookup, the modality and par. PowerScribe is not read again for this study.</div>`);
    $('t').focus();
    $('t').select();
    footer([{ label: 'Cancel', onClick: () => close() }, { label: 'Use this title', kind: 'primary', icon: 'check', onClick: () => act('examTitle', { value: $('t').value }) }]);
  };

  V.paste = () => {
    frame({ title: 'Forecast from pasted text', sub: 'For PowerScribe and any list on screen', icon: 'paste' });
    body(`
      <ol class="lead" style="padding-left:18px;margin-bottom:10px;white-space:normal">
        <li>Press <b>Win+Shift+S</b> and drag a box around the procedure column.</li>
        <li>In the snip preview, click <b>Text actions → Copy all text</b>.</li>
        <li>Paste below (<b>Ctrl+V</b>) and click Forecast.</li>
      </ol>
      <textarea id="t" class="inp" placeholder="Paste here"></textarea>
      <div class="err" id="err"></div>`);
    $('t').focus();
    footer([
      { label: 'Cancel', onClick: () => close() },
      {
        label: 'Forecast',
        kind: 'primary',
        icon: 'sigma',
        onClick: async () => {
          const r = await act('pasteForecast', { text: $('t').value });
          if (r && r.error) $('err').textContent = r.error;
        },
      },
    ]);
  };

  V.forecast = (d) => {
    frame({ title: 'IVU forecast', sub: `${d.matched} ${d.matched === 1 ? 'study' : 'studies'}${d.unmatchedCount ? ` · ${d.unmatchedCount} not matched` : ''}`, icon: 'sigma', tone: 'good' });
    const max = 60;
    const rows = d.items
      .slice(0, max)
      .map((f) => `<div class="r"><span class="a" title="${esc(f.name)}">${esc(f.name)}</span><span class="b ${f.ivu > 0 ? '' : 'miss'}">${f.ivu > 0 ? f2(f.ivu) : '?'}</span></div>`)
      .join('');
    const blk = d.block
      ? `<div class="note ${d.block.pace >= 100 ? 'good' : d.block.pace >= 80 ? '' : 'warn'}">Typical ${esc(d.block.block)} block: ${f1(d.block.typical)} IVU (n=${d.block.n}) · this block so far ${f1(d.block.soFar)} · <b>block + forecast = ${d.block.pace}%</b></div>`
      : '';
    body(`
      <div class="cards">
        <div class="kpi green"><div class="l">Forecast</div><div class="v">${f1(d.total)}</div><div class="s">IVU from selection</div></div>
        <div class="kpi amber"><div class="l">Today</div><div class="v">${f1(d.today)}</div><div class="s">${d.count} studies signed</div></div>
        <div class="kpi violet"><div class="l">Projected</div><div class="v">${f1(d.projected)}</div><div class="s">today + forecast</div></div>
      </div>
      ${blk}
      <div style="display:flex;gap:8px;align-items:center;margin:12px 0 6px">
        <span class="muted" style="font-size:12px">Daily goal</span>
        <input id="g" class="inp" style="height:32px;width:90px;font-size:13px;text-align:center" inputmode="decimal" value="${esc(d.goalPrefill || '')}">
        <button class="btn small" id="calc">Check</button>
        <span id="res" class="muted" style="font-size:12px"></span>
      </div>
      <div class="list">${rows}${d.items.length > max ? `<div class="more">… and ${d.items.length - max} more</div>` : ''}</div>`);
    $('calc').onclick = async () => {
      const r = await act('forecastGoal', { goal: parseFloat($('g').value), total: d.total });
      $('res').textContent = r.msg;
      $('res').style.color = r.tone === 'good' ? 'var(--good)' : r.tone === 'warn' ? 'var(--run)' : '';
    };
    footer([{ label: 'Close', kind: 'primary', onClick: () => close() }]);
  };

  V.breakdown = (d) => {
    frame({ title: 'Today', sub: `${d.count} studies · ${f1(d.total)} IVU`, icon: 'chart', tone: 'violet' });
    const mods = ['CR', 'CT', 'MR', 'US', 'PET']
      .map((m) => `<div class="row"><span class="k"><span class="sw" style="--c:${MODC[m]}"></span>${m}</span><span class="v">${f1(d.byMod[m])}</span></div>`)
      .join('');
    let extra = '';
    if (d.goal > 0) extra += `<div class="row"><span class="k">Goal</span><span class="v">${f1(d.goal)} · ${Math.round((d.total / d.goal) * 100)}%</span></div>`;
    extra += `<div class="row"><span class="k">Credits</span><span class="v">${d.credits} · next rung ${f1(d.next)}</span></div>`;
    if (d.block) extra += `<div class="row"><span class="k">${esc(d.block.block)}</span><span class="v">${f1(d.block.soFar)} / ${f1(d.block.typical)} · ${d.block.pace}%</span></div>`;
    if (d.rate > 0)
      extra += `<div class="row"><span class="k">Engaged today</span><span class="v">$${Math.round(d.engagedDollars)}</span></div><div class="row"><span class="k">Idle inside studies</span><span class="v" style="color:${d.idleSec >= 900 ? 'var(--warn)' : ''}">$${Math.round(d.idleDollars)}</span></div>`;
    body(`${mods}<div class="row total"><span class="k">Total</span><span class="v">${f1(d.total)}</span></div><div style="height:8px"></div>${extra}`);
    footer([]);
  };

  V.shiftToday = (d) => {
    frame({ title: "Today's shift", sub: d.active ? `Active now: ${d.active}${d.extras ? ' + ' + d.extras : ''}` : 'No block active now', icon: 'calendar' });
    const day = (x, label) => {
      if (x.none) return `<div class="field"><label>${label} · ${esc(x.date)}</label><div class="muted">No schedule for this day.</div></div>`;
      const pr = x.prims.length ? x.prims.map((p) => `<div class="r"><span class="a"><b style="color:var(--ink)">${esc(p.name)}</b>${p.onsite ? ' <span class="tag">ON-SITE</span>' : ''}</span><span class="c">${esc(p.when)}</span></div>`).join('') : '<div class="r"><span class="a muted">No reading blocks</span></div>';
      const md = x.mods.map((m) => `<div class="r"><span class="a muted">+ ${esc(m.name)}</span><span class="c">${esc(m.when)}</span></div>`).join('');
      return `<div class="field"><label>${label} · ${esc(x.date)}</label><div class="list">${pr}${md}</div></div>`;
    };
    body(day(d.today, 'Today') + day(d.tomorrow, 'Tomorrow') + (d.lastFetch ? `<div class="note">Schedule refreshed ${esc(fmtStamp(d.lastFetch))} · ${d.count} dates cached</div>` : '<div class="note warn">The schedule has not been fetched yet.</div>'));
    footer([{ label: 'Close', kind: 'primary', onClick: () => close() }]);
  };

  V.shiftView = (d) => {
    frame({ title: 'Shift schedule', sub: '7 days back to 30 ahead', icon: 'list' });
    const rows = d.rows.map((r) => `<div class="r ${r.today ? 'today' : ''}"><span class="d"><b>${esc(r.day)}</b> ${esc(r.date.replace(/\/\d{4}$/, ''))}</span><span class="a" title="${esc(r.shifts)}">${esc(r.shifts)}</span>${r.today ? '<span class="tag">TODAY</span>' : ''}</div>`).join('');
    body(rows ? `<div class="list">${rows}</div>` : '<div class="muted">No shifts in this window.</div>');
    footer([{ label: 'Close', kind: 'primary', onClick: () => close() }]);
  };

  V.rewards = (d) => {
    frame({ title: 'Rewards', sub: d.enabled ? `$${f2(d.perPoint)} a point · cap $${d.weekCap} a week` : 'Rewards are off', icon: 'gift', tone: 'good' });
    body(`
      <div class="cards">
        <div class="kpi green"><div class="l">Bank</div><div class="v">${money(d.balance)}</div><div class="s">${money(d.earned)} earned · ${money(d.cashed)} out</div></div>
        <div class="kpi amber"><div class="l">Today</div><div class="v">${money(d.todayDollars)}</div><div class="s">${Math.round(d.todayPts)} points</div></div>
      </div>
      <div class="row"><span class="k">Under par today</span><span class="v">${d.wins} of ${d.bets}</span></div>
      <div class="row"><span class="k">Best run today</span><span class="v">${d.best}</span></div>
      <div class="row"><span class="k">Goal rungs cleared</span><span class="v">${d.rung} at ${f1(d.ivu)} IVU</span></div>
      <div class="note">A par win pays a flat amount and streaks pay a bonus; a loss costs nothing. Rungs pay more each step, scaled by how focused the day was.</div>`);
    footer([
      { label: 'Gift card page', icon: 'globe', onClick: () => act('openStore') },
      '|',
      { label: 'Close', onClick: () => close() },
      { label: 'Cash out…', kind: 'primary', icon: 'gift', onClick: () => rt.invoke('p:do', 'rewards', 'close', { restore: false }).then(() => rt.send('m:pick', 'reward:cashout')) },
    ]);
  };

  V.cashout = (d) => {
    frame({ title: 'Cash out', sub: `Bank balance ${money(d.balance)}`, icon: 'gift', tone: 'good' });
    body(`
      <div class="field"><label for="a">Amount ($)</label><input id="a" class="inp big" inputmode="decimal" value="${Math.floor(d.balance).toFixed(2)}"></div>
      <div class="err" id="err"></div>
      <div class="note">This records the withdrawal and copies the amount. Buying the card stays a step you take yourself.</div>`);
    $('a').focus();
    $('a').select();
    const go = async (openStore) => {
      const r = await act('cashout', { amount: parseFloat($('a').value), openStore });
      if (r && r.error) $('err').textContent = r.error;
    };
    footer([{ label: 'Cancel', onClick: () => close() }, { label: 'Record', onClick: () => go(false) }, { label: 'Record + open store', kind: 'primary', icon: 'globe', onClick: () => go(true) }]);
  };

  V.rate = (d) => {
    frame({ title: 'Dollars per point', sub: `Weekly cap $${d.weekCap}`, icon: 'coin' });
    body(`
      <div class="field"><label for="a">$ per point</label><input id="a" class="inp big" inputmode="decimal" value="${f2(d.perPoint)}"></div>
      <div class="err" id="err"></div>
      <div class="note">At $${f2(d.perPoint)}, a solid day (25 wins, rung 2) pays about $${f2(d.sample)}.</div>`);
    $('a').focus();
    $('a').select();
    footer([
      { label: 'Cancel', onClick: () => close() },
      {
        label: 'Save',
        kind: 'primary',
        icon: 'check',
        onClick: async () => {
          const r = await act('rate', { value: parseFloat($('a').value) });
          if (r && r.error) $('err').textContent = r.error;
        },
      },
    ]);
  };

  V.message = (d) => {
    frame({ title: d.title || 'RadTempo', icon: d.icon || 'info', tone: d.tone || '' });
    body(`<p class="lead">${esc(d.text)}</p>`);
    footer([{ label: 'OK', kind: 'primary', onClick: () => close() }]);
  };

  V.confirm = (d) => {
    frame({ title: d.title, icon: d.icon || 'warn', tone: d.danger ? 'warn' : '' });
    const list = d.list
      ? `<div class="list" style="margin-top:12px">${d.list.map((x) => `<div class="r"><span class="d"><b>${esc(x.a)}</b></span><span class="a" title="${esc(x.b)}">${esc(x.b)}</span><span class="c">${esc(x.c)}</span></div>`).join('')}</div>`
      : '';
    body(`<p class="lead">${esc(d.text)}</p>${list}`);
    footer([{ label: 'Cancel', onClick: () => close() }, { label: d.ok || 'OK', kind: d.danger ? 'danger' : 'primary', onClick: () => act('confirm') }]);
  };

  V.pacs = (d) => {
    frame({ title: 'PACS diagnostic', sub: 'Copied to the clipboard', icon: 'search' });
    body(`<pre class="mono">${esc(d.text)}</pre>`);
    footer([{ label: 'Close', kind: 'primary', onClick: () => close() }]);
  };

  V.status = (d) => {
    const h = d.helper || {};
    frame({ title: 'Helper status', sub: h.connected ? 'Connected - F4 and F12 are being watched' : 'Not connected', icon: 'pulse', tone: h.connected ? 'good' : 'warn' });
    const ev = (d.events || []).map((e) => `<div class="r"><span class="d">${new Date(e.t).toLocaleTimeString()}</span><span class="a">${esc(e.type)} ${esc(e.detail)}</span></div>`).join('');
    body(`
      <div class="row"><span class="k">Helper</span><span class="v">${h.running ? 'running' : 'stopped'}${h.mode ? ' (' + esc(h.mode) + ')' : ''}</span></div>
      <div class="row"><span class="k">Last heartbeat</span><span class="v">${h.lastPollAgoMs != null ? Math.round(h.lastPollAgoMs / 100) / 10 + ' s ago' : 'never'}</span></div>
      <div class="row"><span class="k">Classic RadTempo running</span><span class="v">${d.classicRunning ? 'yes' : 'no'}</span></div>
      <div class="row"><span class="k">Rows waiting for the log</span><span class="v">${d.pending}</span></div>
      <div class="row"><span class="k">Version</span><span class="v">${esc(d.version)}</span></div>
      ${h.lastError ? `<div class="note warn">${esc(h.lastError)}</div>` : ''}
      ${!h.connected && !h.lastError ? `<div class="note warn">The helper is not answering. If this stays, a security program on this PC may be blocking RadTempoHelper.exe. The details are in radtempo.log (Open the log).</div>` : ''}
      <div class="field"><label>Recent activity</label><div class="list">${ev || '<div class="r"><span class="a muted">Nothing yet</span></div>'}</div></div>`);
    footer([
      { label: 'Restart the helper', icon: 'refresh', onClick: () => act('restartHelper').then(render) },
      { label: 'Open the log', icon: 'folder', onClick: () => act('openFolder', { dir: d.appDir }) },
      '|',
      { label: 'Close', kind: 'primary', onClick: () => close() },
    ]);
  };

  // ------------------------------------------------------------ settings

  let settingsTab = 'General';
  V.settings = (d) => {
    frame({ title: 'Settings', sub: `RadTempo ${d.version}`, icon: 'sliders' });
    const groups = ['General', ...[...new Set(d.fields.map((f) => f.group))], 'Data'];
    const tabs = `<div class="tabs">${groups.map((g) => `<button data-t="${esc(g)}" class="${g === settingsTab ? 'on' : ''}">${esc(g)}</button>`).join('')}</div>`;
    let inner = '';
    if (settingsTab === 'General') {
      inner = `
        <div class="set"><div class="lbl">Start with Windows</div><div class="ctl"><button class="tg ${d.login ? 'on' : ''}" id="login" title="Start RadTempo when you sign in"></button></div><div class="help">Starts quietly in the tray when you sign in to Windows. No administrator rights needed.</div></div>
        <div class="set"><div class="lbl">Helper</div><div class="ctl"><span class="${d.helper && d.helper.connected ? 'saved' : 'muted'}">${d.helper && d.helper.connected ? 'connected' : 'not connected'}</span></div><div class="help">The helper watches F4 / F12 and reads PowerScribe. Diagnostics › Helper status has details.</div></div>
        <div class="set"><div class="lbl">IVU table</div><div class="ctl"><span class="${d.ivuRows ? 'saved' : 'muted'}">${d.ivuRows} rows</span><button class="btn small" id="ivu">Load…</button></div><div class="help">RadTempo_IVU.csv (Code, Description, IVU). Without it every study is valued at 0.</div></div>`;
    } else if (settingsTab === 'Data') {
      inner = `
        <div class="set wide"><div class="lbl">Data folder</div><div class="path">${esc(d.dataDir)}</div>
          <div class="help" id="reading">${d.reading && d.reading.studies ? `Reading <b>${d.reading.studies}</b> studies here, ${esc(d.reading.first)} to ${esc(d.reading.last)}.` : '<b>No studies in this folder.</b> If your history is elsewhere, use another folder below.'}</div>
          <div class="help">The log, goals, IVU table, rewards and settings live here, in the same files the classic RadTempo used. Point it at a OneDrive folder and every workstation shares one history.</div>
          <div class="ctl" style="justify-content:flex-start;gap:8px;margin-top:6px"><button class="btn small" id="open">${icon('folder')}Open</button><button class="btn small" id="choose">Use another folder…</button><button class="btn small" id="imp">Copy in from the classic version…</button></div></div>
        <div class="set wide"><div class="lbl">File names</div>
          <div class="help">${d.earlierLeft && d.earlierLeft.length ? `<b>${d.earlierLeft.length} file${d.earlierLeft.length === 1 ? '' : 's'} still have the app's earlier name</b> (${esc(d.earlierLeft.join(', '))}), so RadTempo cannot see them.` : 'Every data file has its RadTempo name.'}</div>
          <div class="ctl" style="justify-content:flex-start;gap:8px;margin-top:6px"><button class="btn small ${d.earlierLeft && d.earlierLeft.length ? 'primary' : ''}" id="fixnames">${icon('check')}Fix file names</button></div>
          ${d.fixMsg ? `<div class="note ${d.fixFailed ? 'warn' : ''}" id="fixmsg">${esc(d.fixMsg)}</div>` : ''}</div>
        <div class="err" id="err"></div>`;
    } else {
      inner = d.fields
        .filter((f) => f.group === settingsTab)
        .map(
          (f) => `<div class="set ${f.type === 'text' ? 'wide' : ''}" data-k="${esc(f.key)}">
            <div class="lbl">${esc(f.label)}</div>
            <div class="ctl"><input class="inp ${f.type !== 'text' ? 'num' : ''} ${f.mono ? 'mono' : ''}" value="${esc(f.value)}" ${f.type !== 'text' ? 'inputmode="decimal"' : ''} spellcheck="false">${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ''}<span class="saved" hidden>saved</span></div>
            ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}<div class="help err" hidden></div></div>`
        )
        .join('');
    }
    body(tabs + inner);
    const B = $('body');
    B.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
      settingsTab = b.dataset.t;
      V.settings(d);
    }));
    B.querySelectorAll('.set[data-k] input').forEach((inp) => {
      const save = async () => {
        const row = inp.closest('.set');
        const r = await act('setting', { key: row.dataset.k, value: inp.value });
        const err = row.querySelector('.err');
        const ok = row.querySelector('.saved');
        if (r && r.error) {
          err.hidden = false;
          err.textContent = r.error;
          ok.hidden = true;
        } else {
          err.hidden = true;
          ok.hidden = false;
          setTimeout(() => (ok.hidden = true), 1400);
        }
      };
      inp.addEventListener('change', save);
    });
    const on = (id, fn) => $(id) && ($(id).onclick = fn);
    on('login', async () => {
      const r = await act('login', { on: !d.login });
      d.login = r.login;
      V.settings(d);
    });
    on('ivu', async () => render(await act('importIvu')));
    on('fixnames', async () => render(await act('fixNames')));
    on('open', () => act('openFolder'));
    on('choose', async () => {
      const r = await act('chooseFolder');
      if (!r || r.canceled) return;
      render(await act('useFolder', { dir: r.dir }));
    });
    on('imp', async () => {
      const r = await act('chooseFolder');
      if (!r || r.canceled) return;
      if (!r.info) return ($('err').textContent = 'No RadTempo_Log.csv in that folder.');
      render(await act('importFrom', { dir: r.dir }));
    });
    footer([{ label: 'Done', kind: 'primary', onClick: () => close() }]);
  };

  // ------------------------------------------------------------ welcome

  V.welcome = (d) => {
    frame({ title: 'Welcome to the new RadTempo', sub: 'One app, nothing to install on top of it', icon: 'clock', tone: 'good' });
    const best = d.found[0];
    let html = '';
    if (d.current && d.current.studies > 0) {
      html += `<p class="lead">History found in the data folder: <b>${d.current.studies}</b> studies, last on ${esc(d.current.last)}.</p>`;
    } else if (best) {
      html += `<p class="lead">Found your history from the classic RadTempo:</p>
        <div class="found sel"><span class="fi">${icon('database')}</span><div class="ft"><b>${best.studies} studies · last ${esc(best.last)}</b><span title="${esc(best.dir)}">${esc(best.dir)}</span></div></div>
        <div class="opts">
          <button class="opt rec" id="use"><span class="oi">${icon('folder')}</span><div><b>Keep using that folder <span class="tag">RECOMMENDED</span></b><span>One history. The classic version still sees it if you ever go back.</span></div></button>
          <button class="opt" id="copy"><span class="oi">${icon('copy')}</span><div><b>Copy it into RadTempo's own folder</b><span>The original stays untouched.</span></div></button>
          <button class="opt" id="other"><span class="oi">${icon('search')}</span><div><b>It is somewhere else…</b><span>Choose the folder that has RadTempo_Log.csv.</span></div></button>
          <button class="opt" id="fresh"><span class="oi">${icon('sparkle')}</span><div><b>Start fresh</b><span>You can bring the history in later from Settings › Data.</span></div></button>
        </div>`;
    } else {
      html += `<p class="lead">No history from the classic RadTempo was found on this PC. If you have one (RadTempo_Log.csv), point at its folder - a OneDrive folder works and lets every workstation share it.</p>
        <div class="opts">
          <button class="opt rec" id="other"><span class="oi">${icon('folder')}</span><div><b>Use my existing folder…</b><span>Choose the folder with RadTempo_Log.csv and the IVU table.</span></div></button>
          <button class="opt" id="fresh"><span class="oi">${icon('sparkle')}</span><div><b>Start fresh</b><span>History starts today. Load the IVU table in Settings so studies get values.</span></div></button>
        </div>`;
    }
    if (d.classicRunning) html += `<div class="note warn">The classic RadTempo is running too. Quit it from its tray icon so studies are not logged twice.</div>`;
    html += `<div class="set" style="margin-top:10px"><div class="lbl">Start with Windows</div><div class="ctl"><button class="tg ${d.login ? 'on' : ''}" id="login"></button></div></div><div class="err" id="err"></div>`;
    body(html);
    const on = (id, fn) => $(id) && ($(id).onclick = fn);
    on('use', () => act('useFolder', { dir: best.dir }));
    on('copy', () => act('importFrom', { dir: best.dir }));
    on('fresh', () => act('startFresh'));
    on('other', async () => {
      const r = await act('chooseFolder');
      if (!r || r.canceled) return;
      if (!r.info) return ($('err').textContent = 'That folder has no RadTempo_Log.csv. Choose another, or start fresh.');
      act('useFolder', { dir: r.dir });
    });
    on('login', async () => {
      const r = await act('login', { on: !d.login });
      d.login = r.login;
      $('login').classList.toggle('on', d.login);
    });
    footer(d.current && d.current.studies > 0 ? [{ label: 'Start', kind: 'primary', onClick: () => act('startFresh') }] : []);
  };

  // ------------------------------------------------------------ helpers

  function fmt(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function fmtStamp(st) {
    if (!st || st.length < 12) return st || '';
    return `${+st.slice(4, 6)}/${+st.slice(6, 8)} ${st.slice(8, 10)}:${st.slice(10, 12)}`;
  }

  function render(d) {
    if (!d || typeof d !== 'object') return;
    (V[VIEW] || V.message)(d);
    P.classList.add('on');
  }

  rt.on('p:reload', render);
  let lastLive = '';
  rt.on('p:live', (d) => {
    const k = JSON.stringify(d);
    if (k === lastLive) return;
    lastLive = k;
    if (VIEW === 'par' || VIEW === 'breakdown') {
      const a = document.activeElement;
      if (!a || a.tagName !== 'INPUT') render(d);
    }
  });
  rt.invoke('p:get', VIEW).then(render);
})();
