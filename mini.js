(() => {
  const $ = (id) => document.getElementById(id);
  const tr = (text) => (window.i18n ? window.i18n.t(text) : text);
  const ui = {
    mini: $('mini'),
    cover: $('cover'),
    coverFallback: $('cover-fallback'),
    backdrops: [$('backdrop-a'), $('backdrop-b')],
    title: $('title'),
    artist: $('artist'),
    timeCur: $('time-cur'),
    timeDur: $('time-dur'),
    progress: $('progress'),
    fill: $('progress-fill'),
    fav: $('btn-fav')
  };

  // the main window reports ~4x a second; position is interpolated between reports
  let snapshot = { title: '', artist: '', thumbnail: '', isPlaying: false, currentTime: 0, duration: 0 };
  let receivedAt = performance.now();
  let shownThumb = null;
  let backdropIndex = 0;
  let dragging = false;

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setThumbnail(url) {
    if (url === shownThumb) return;
    shownThumb = url;
    ui.coverFallback.classList.toggle('hidden', Boolean(url));
    ui.cover.classList.remove('show');
    ui.backdrops.forEach(img => img.classList.remove('show'));
    if (!url) return;

    const next = ui.backdrops[backdropIndex = 1 - backdropIndex];
    const probe = new Image();
    probe.onload = () => {
      if (shownThumb !== url) return;
      ui.cover.src = url;
      ui.cover.classList.add('show');
      next.src = url;
      next.classList.add('show');
    };
    probe.src = url;
  }

  function setTitle(text) {
    if (ui.title.textContent === text) return;
    ui.title.textContent = text;
    ui.title.classList.remove('scrolling');
    requestAnimationFrame(() => {
      const overflow = ui.title.scrollWidth - ui.title.parentElement.clientWidth;
      if (overflow > 4) {
        ui.title.style.setProperty('--marquee-shift', `-${overflow + 40}px`);
        ui.title.style.setProperty('--marquee-duration', `${Math.max(8, (overflow + 40) / 18)}s`);
        ui.title.classList.add('scrolling');
      }
    });
  }

  function currentPosition() {
    const elapsed = snapshot.isPlaying ? (performance.now() - receivedAt) / 1000 : 0;
    return Math.min(snapshot.duration || Infinity, snapshot.currentTime + elapsed);
  }

  function render(info) {
    snapshot = { ...snapshot, ...info };
    receivedAt = performance.now();
    document.body.classList.toggle('paused', !snapshot.isPlaying);
    setTitle(snapshot.title || tr('Nothing playing'));
    ui.artist.textContent = snapshot.artist || 'Riffle';
    ui.fav.classList.toggle('active', Boolean(snapshot.isFavorite));
    setThumbnail(snapshot.thumbnail || '');
    const root = document.documentElement.style;
    if (snapshot.accent) root.setProperty('--accent', snapshot.accent);
    if (snapshot.onAccent) root.setProperty('--on-accent', snapshot.onAccent);
    if (snapshot.surface) root.setProperty('--surface', snapshot.surface);
    document.title = snapshot.title ? `${snapshot.title} · Riffle` : tr('Riffle mini player');
  }

  function tick() {
    if (!dragging) {
      const pos = currentPosition();
      const dur = snapshot.duration || 0;
      ui.fill.style.width = dur > 0 ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
      ui.timeCur.textContent = formatTime(pos);
      ui.timeDur.textContent = formatTime(dur);
    }
    requestAnimationFrame(tick);
  }

  function ratioFromEvent(e) {
    const rect = ui.progress.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  ui.progress.addEventListener('pointerdown', (e) => {
    dragging = true;
    ui.progress.setPointerCapture(e.pointerId);
    const r = ratioFromEvent(e);
    ui.fill.style.width = `${r * 100}%`;
    ui.timeCur.textContent = formatTime(r * (snapshot.duration || 0));
  });

  ui.progress.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = ratioFromEvent(e);
    ui.fill.style.width = `${r * 100}%`;
    ui.timeCur.textContent = formatTime(r * (snapshot.duration || 0));
  });

  ui.progress.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const r = ratioFromEvent(e);
    snapshot.currentTime = r * (snapshot.duration || 0);
    receivedAt = performance.now();
    window.miniAPI.command(`seek:${r}`);
  });

  document.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      // instant feedback; the main window confirms with the next report
      if (cmd === 'toggle') {
        snapshot.currentTime = currentPosition();
        receivedAt = performance.now();
        snapshot.isPlaying = !snapshot.isPlaying;
        document.body.classList.toggle('paused', !snapshot.isPlaying);
      }
      window.miniAPI.command(cmd);
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); window.miniAPI.command('toggle'); }
    else if (e.code === 'ArrowRight') window.miniAPI.command('next');
    else if (e.code === 'ArrowLeft') window.miniAPI.command('prev');
    else if (e.code === 'Escape') window.miniAPI.command('close');
  });

  document.body.classList.add('paused');
  window.miniAPI.onState(render);
  requestAnimationFrame(tick);
})();
