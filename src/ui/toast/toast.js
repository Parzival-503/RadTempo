(function () {
  const t = document.getElementById('t');
  let timer = null;
  rt.on('t:show', ({ text, ms, tone, below }) => {
    document.body.classList.toggle('below', !!below);
    t.className = 't glass ' + (tone || '');
    t.querySelector('.ic').innerHTML = icon(tone === 'good' ? 'check' : tone === 'warn' ? 'warn' : 'info');
    t.querySelector('.tx').textContent = text;
    requestAnimationFrame(() => t.classList.add('on'));
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove('on'), ms || 2600);
  });
})();
