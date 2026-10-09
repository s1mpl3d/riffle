
document.addEventListener('DOMContentLoaded', async () => {

  // settings carried over from Riff use the old riff_ prefix
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('riff_')) continue;
      const renamed = 'riffle_' + key.slice(5);
      if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch (e) {}

  // translations: wait until the static markup is translated, then use tr() for text set from code
  if (window.i18n) await window.i18n.ready;
  const tr = window.i18n ? window.i18n.t : (s => s);
  const trn = (n, one, many, vars) => tr(n === 1 ? one : many, Object.assign({ n }, vars));

  // search results carry 1280x720 YouTube thumbnails; a 44px row only needs the 320x180
  // one, which decodes to a twentieth of the memory
  const smallThumb = (url) => {
    const m = /^https?:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([^/?#]+)\//.exec(url || '');
    return m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : (url || '');
  };

  const LiquidMotion = {
    setAnchor(element, triggerEl, axis = 'x') {
      if (!element) return;
      if (triggerEl) {
        const rect = triggerEl.getBoundingClientRect();
        const parentRect = element.parentElement ? element.parentElement.getBoundingClientRect() : { top: 0, left: 0 };
        if (axis === 'x') {
          const anchorY = (rect.top + rect.height / 2) - parentRect.top;
          element.style.setProperty('--liquid-anchor-y', `${anchorY}px`);
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = `0px ${anchorY}px`;
        } else {
          const anchorX = (rect.left + rect.width / 2) - parentRect.left;
          element.style.setProperty('--liquid-anchor-x', `${anchorX}px`);
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = `${anchorX}px 0px`;
        }
      } else {
        if (axis === 'x') {
          element.style.setProperty('--liquid-anchor-y', '50%');
          element.style.setProperty('--liquid-anchor-x', '0px');
          element.style.transformOrigin = '0px 50%';
        } else {
          element.style.setProperty('--liquid-anchor-x', '50%');
          element.style.setProperty('--liquid-anchor-y', '0px');
          element.style.transformOrigin = '50% 0px';
        }
      }
    },
    open(element, triggerEl, axis = 'x', onDone) {
      if (!element) return;
      this.setAnchor(element, triggerEl, axis);
      element.classList.remove('liquid-closing');
      element.classList.add('liquid-surface', `liquid-${axis}`, 'liquid-open');
      if (onDone) setTimeout(onDone, 480);
    },
    close(element, onDone) {
      if (!element) return;
      element.classList.add('liquid-closing');
      element.classList.remove('liquid-open');
      setTimeout(() => {
        element.classList.remove('liquid-closing', 'liquid-open');
        if (onDone) onDone();
      }, 300);
    }
  };
  window.LiquidMotion = LiquidMotion;


  function injectM3Shapes() {
    const defs = document.getElementById('m3-dynamic-defs');
    if (!defs) return;

    const formulas = {
      'm3-cookie-4': (a) => 40 + 6 * Math.cos(4 * a),
                          'm3-diamond-puffy': (a) => 36 + 10 * Math.cos(4 * a),
                          'm3-flower': (a) => 28 + 18 * Math.abs(Math.cos(4 * a)),
                          'm3-poly-6': (a) => {
                            let t = a % (2 * Math.PI / 6);
                            if (t < 0) t += 2 * Math.PI / 6;
                            return 36 / Math.cos(t - Math.PI / 6);
                          },
                          'm3-leaf-4': (a) => 40 + 6 * Math.cos(4 * a)
    };

    let html = '';
    for (const [id, formula] of Object.entries(formulas)) {
      let path = '';
      const res = 120;
      for (let i = 0; i <= res; i++) {
        const angle = (i / res) * 2 * Math.PI;
        const r = formula(angle);
        const x = 0.5 + (r * Math.cos(angle)) / 100;
        const y = 0.5 + (r * Math.sin(angle)) / 100;
        path += `${i === 0 ? 'M' : 'L'} ${x.toFixed(4)},${y.toFixed(4)} `;
      }
      path += 'Z';
      html += `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><path d="${path}" /></clipPath>`;
    }
    defs.insertAdjacentHTML('beforeend', html);
  }
  injectM3Shapes();

  const toastQueue = [];
  let isToastActive = false;

  function showToast(message, type = 'info', options = null) {
    if (!message) return;
    let handle = null;
    let toastItem = null;

    if (options && (options.actions || options.persistent)) {
      handle = {
        setText(text) {
          const clean = String(text).charAt(0).toUpperCase() + String(text).slice(1);
          if (toastItem && toastItem.textEl) {
            toastItem.textEl.textContent = clean;
          }
          if (toastItem && toastItem.actionsEl) {
            toastItem.actionsEl.style.display = 'none';
          }
        },
        close() {
          if (toastItem && toastItem.dismiss) {
            toastItem.dismiss();
          }
        }
      };
    }

    toastItem = { message, type, options, textEl: null, actionsEl: null, dismiss: null };
    toastQueue.push(toastItem);
    if (!isToastActive) {
      processToastQueue();
    }
    return handle;
  }

  function processToastQueue() {
    if (toastQueue.length === 0) {
      isToastActive = false;
      return;
    }
    isToastActive = true;
    const currentItem = toastQueue.shift();
    const { message, type, options } = currentItem;
    const container = document.getElementById('toast-container');
    if (!container) {
      isToastActive = false;
      return;
    }

    const toast = document.createElement('div');
    toast.className = `riffle-toast ${type} liquid-content-stagger`;

    let iconSvg = '';
    if (type === 'error') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    } else if (type === 'success') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    } else if (type === 'warning') {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    } else {
      iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    const cleanMessage = String(message).charAt(0).toUpperCase() + String(message).slice(1);

    toast.innerHTML = `
      <span class="toast-icon">${iconSvg}</span>
      <span class="toast-text">${cleanMessage}</span>
    `;

    const textEl = toast.querySelector('.toast-text');
    currentItem.textEl = textEl;

    const hasActions = options && options.actions && options.actions.length > 0;
    const isPersistent = hasActions || (options && options.persistent);

    if (hasActions) {
      toast.classList.add('has-actions');
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'riffle-toast-actions';
      options.actions.forEach((act) => {
        const btn = document.createElement('button');
        btn.className = `riffle-toast-btn ${act.primary ? 'primary' : 'text'}`;
        btn.textContent = act.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (act.onClick) act.onClick();
        });
        actionsContainer.appendChild(btn);
      });
      toast.appendChild(actionsContainer);
      currentItem.actionsEl = actionsContainer;
    }

    container.appendChild(toast);
    LiquidMotion.open(toast, null, 'y');

    let dismissed = false;
    let timer = null;
    let remaining = 3500;
    let startTimestamp = Date.now();

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      LiquidMotion.close(toast, () => {
        toast.remove();
        processToastQueue();
      });
    };

    currentItem.dismiss = dismiss;

    if (!isPersistent) {
      const startTimer = (dur) => {
        startTimestamp = Date.now();
        timer = setTimeout(dismiss, dur);
      };

      toast.addEventListener('mouseenter', () => {
        if (timer) clearTimeout(timer);
        remaining -= (Date.now() - startTimestamp);
        if (remaining < 500) remaining = 500;
      });

      toast.addEventListener('mouseleave', () => {
        if (!dismissed) {
          startTimer(remaining);
        }
      });

      toast.addEventListener('click', dismiss);

      startTimer(remaining);
    }
  }

  const savedScale = parseFloat(localStorage.getItem('devsize_ui_scale') || '100');
  applyScale(savedScale);

  function applyScale(scalePercent) {
    const factor = scalePercent / 100;
    document.documentElement.style.setProperty('--app-scale', factor.toString());
    if (window.electronAPI && window.electronAPI.setZoomFactor) {
      window.electronAPI.setZoomFactor(factor);
    } else {
      document.body.style.zoom = factor;
    }
  }

  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  function openModal(elModal) {
    if (!elModal) return;
    elModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elModal.classList.add('visible');
      });
    });
  }

  function closeModal(elModal) {
    if (!elModal) return;
    elModal.classList.remove('visible');
    setTimeout(() => {
      elModal.classList.add('hidden');
    }, 200);
  }

  const defaultPresets = [
    { id: 'p_default', name: 'default', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0 } },
    { id: 'p_speedup', name: 'speed up (orig pitch)', settings: { speed: 1.35, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0 } },
                          { id: 'p_speedup_pitch', name: 'speed up (tape pitch)', settings: { speed: 1.0, speedPitch: 1.30, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0 } },
                          { id: 'p_slowed', name: 'slowed + reverb', settings: { speed: 1.0, speedPitch: 0.82, pitch: 0, reverb: 65, distortion: 0, volume: 1.0, echo: 15 } },
                          { id: 'p_nightcore', name: 'nightcore', settings: { speed: 1.0, speedPitch: 1.25, pitch: 0, reverb: 20, distortion: 0, volume: 1.0, echo: 0 } },
                          { id: 'p_distortion', name: 'distortion hard', settings: { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 75, volume: 1.25, echo: 0 } }
  ];

  const defaultVfx = {
    ambientGlow: true,
    bassPulse: false,
    vinylSpin: false,
    soundwaveRings: false,
    borderGlow: false,
    particles: false,
    backdropBlur: false,
    crt: false,
    grain: false,
    lyricsSpotlight: false
  };

  function normalizePreset(p) {
    if (!p) return null;
    const s = p.settings || p.values || {};
    return {
      id: p.id,
      name: p.name || 'preset',
      settings: {
        speed: typeof s.speed === 'number' ? s.speed : 1.0,
        speedPitch: typeof s.speedPitch === 'number' ? s.speedPitch : 1.0,
        pitch: typeof s.pitch === 'number' ? s.pitch : (typeof s.pitchSemitones === 'number' ? s.pitchSemitones : 0),
                          reverb: typeof s.reverb === 'number' ? s.reverb : 0,
                          distortion: typeof s.distortion === 'number' ? s.distortion : 0,
                          volume: typeof s.volume === 'number' ? s.volume : (typeof s.gain === 'number' ? s.gain : 1.0),
                          echo: typeof s.echo === 'number' ? s.echo : 0
      }
    };
  }

  const rawCustomPresets = JSON.parse(localStorage.getItem('devsize_custom_presets') || '[]');
  const normalizedCustomPresets = rawCustomPresets.map(normalizePreset).filter(Boolean);

  const state = {
    platform: 'youtube',
    currentView: 'discover',
    previousView: 'discover',
    currentPlaylistId: null,
    currentArtistData: null,
    searchQuery: '',
    searchResults: [],
    queue: [],
    queueIndex: -1,
    currentTrack: null,
    currentTrackContext: null,
    currentTrackIndexInContext: -1,
    isPlaying: false,
    isMuted: localStorage.getItem('riffle_muted') === 'true',
    volume: Math.min(1, Math.max(0, parseFloat(localStorage.getItem('riffle_volume') ?? '0.85') || 0)),
    isRepeat: localStorage.getItem('riffle_repeat') === 'true',
    isShuffle: localStorage.getItem('riffle_shuffle') === 'true',
    crossfadeEnabled: localStorage.getItem('riffle_crossfade') === 'true',
    crossfadeLoop: localStorage.getItem('riffle_crossfade_loop') === 'true',
    crossfadeSecs: parseInt(localStorage.getItem('riffle_crossfade_secs') || '6', 10),
    closeToTray: localStorage.getItem('riffle_close_to_tray') !== 'false',
    normalizeVolume: localStorage.getItem('riffle_normalize') !== 'false',
    autoplayEnabled: localStorage.getItem('riffle_autoplay') !== 'false',
    globalShortcuts: localStorage.getItem('riffle_global_shortcuts') !== 'false',
    playNextPending: 0,
    isAutoRemix: false,
    myWaveActive: false,
    isRightPanelOpen: true,
    lyricsMode: 'line',
    uiScale: savedScale,
    activePresetId: 'p_default',
    themeMode: localStorage.getItem('riffle_theme_mode') || 'dark',
    paletteStyle: localStorage.getItem('riffle_palette_style') || 'classic',
    meshBrightness: parseInt(localStorage.getItem('riffle_mesh_brightness') || '100', 10),
    themeAccent: localStorage.getItem('riffle_theme_accent') || '#6750A4',
    themeIntensity: parseInt(localStorage.getItem('riffle_theme_intensity') || '0'),
    themeBrightness: parseInt(localStorage.getItem('riffle_theme_brightness') || '50'),
                          audioSettings: {
                            speed: 1.0,
                          speedPitch: 1.0,
                          pitch: 0,
                          reverb: 0,
                          distortion: 0,
                          volume: 1.0,
                          echo: 0
                          },
                          hqEnabled: false,
                          hqSettings: {
                            engine: 'hqmusic-3',
                          preset: 'studio',
                          vocal: 0,
                          air: 0,
                          bass: 0
                          },
                          vfx: { ...defaultVfx, ...JSON.parse(localStorage.getItem('devsize_vfx') || '{}'), bassPulse: false, particles: false, soundwaveRings: false, borderGlow: false, backdropBlur: false, crt: false, grain: false, lyricsSpotlight: false },
                          favorites: JSON.parse(localStorage.getItem('devsize_favorites') || '[]'),
                          savedTracks: [],
                          savedDirectory: '',
                          history: JSON.parse(localStorage.getItem('devsize_history') || '[]'),
                          playlists: JSON.parse(localStorage.getItem('devsize_playlists') || '[]'),
                          customPresets: normalizedCustomPresets,
                          syncedLyrics: [],
                          glitchTimes: [],
                          lastGlitchedIndex: -1,
                          isGlitching: false,
                          isWindowVisible: true,
                          loadToken: 0,
                          currentAbortController: null,
                          presetToRenameId: null,
                          serverPort: 38472,
                          discordRpcEnabled: JSON.parse(localStorage.getItem('devsize_discord_rpc') ?? 'true'),
                          lastBroadcastStateKey: null,
                          syncTimeout: null,
                          scrubberDragTargetTime: undefined
  };

  if (window.electronAPI && window.electronAPI.getServerPort) {
    try {
      state.serverPort = await window.electronAPI.getServerPort();
    } catch (e) {
      console.warn('Failed to get server port:', e);
    }
  }

  checkToolsStatus(true);

  if (window.electronAPI && window.electronAPI.discordRpcSetEnabled) {
    window.electronAPI.discordRpcSetEnabled(state.discordRpcEnabled);
  }

  function sendDiscordRpcUpdate(track, isPlaying) {
    if (!window.electronAPI || !window.electronAPI.discordRpcUpdate) return;
    if (!track || !isPlaying) {
      if (window.electronAPI.discordRpcClear) window.electronAPI.discordRpcClear();
      return;
    }
    window.electronAPI.discordRpcUpdate({
      title: track.title || tr('Unknown Track'),
      artist: track.artist || tr('Unknown Artist'),
      duration: track.duration || 0,
      thumbnail: track.thumbnail || '',
      url: track.url || '',
      platform: track.platform || state.platform,
      startTimestamp: Math.floor(Date.now() / 1000)
    });
  }

  function sendStateToServer(currentWordText = '', wordIndex = -1, lineIndex = -1) {
    if (!state.currentTrack) return;
    fetch(`http://127.0.0.1:${state.serverPort}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: state.currentTrack.title,
        artist: state.currentTrack.artist,
        isPlaying: state.isPlaying,
        word: currentWordText,
        wordIndex: wordIndex,
        lineIndex: lineIndex
      })
    }).catch(() => {});
  }

  function updateMediaSession() {
    if ('mediaSession' in navigator && state.currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.currentTrack.title || tr('Untitled'),
        artist: state.currentTrack.artist || tr('Unknown Artist'),
        artwork: state.currentTrack.thumbnail ? [{ src: state.currentTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : []
      });
    }
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', togglePlayPause);
    navigator.mediaSession.setActionHandler('pause', togglePlayPause);
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
    return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  }

  function getAdv(name, defaultVal = true) {
    const val = localStorage.getItem(`riffle_adv_${name}`);
    if (val === null) return defaultVal;
    return val === 'true';
  }

  function setAdv(name, boolVal) {
    localStorage.setItem(`riffle_adv_${name}`, boolVal ? 'true' : 'false');
  }

  function applyReducedMotionSetting() {
    document.documentElement.classList.remove('force-reduced-motion');
  }

  const PALETTE_STYLES = {
    classic: {
      label: tr('Classic'),
      secHueShift: 0,
      tertHueShift: 0,
      priSatScale: 1.0,
      surfSatScale: 1.0,
      contSatScale: 1.0
    },
    'tonal-spot': {
      label: tr('Tonal spot'),
      secHueShift: 0,
      tertHueShift: 60,
      priSatScale: 1.0,
      surfSatScale: 0.8,
      contSatScale: 0.9
    },
    expressive: {
      label: tr('Expressive'),
      secHueShift: 60,
      tertHueShift: 120,
      priSatScale: 1.25,
      surfSatScale: 1.5,
      contSatScale: 1.3
    },
    vibrant: {
      label: tr('Vibrant'),
      secHueShift: 0,
      tertHueShift: 60,
      priSatScale: 1.4,
      surfSatScale: 1.2,
      contSatScale: 1.4
    },
    neutral: {
      label: tr('Neutral'),
      secHueShift: 0,
      tertHueShift: 0,
      priSatScale: 0.35,
      surfSatScale: 0.2,
      contSatScale: 0.25
    }
  };

  function generateM3Palette(hexColor, mode, intensity, brightness) {
    if (!hexColor) hexColor = '#6750A4';
    const rgb = hexToRgb(hexColor);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const h = hsl.h;
    const intensityFactor = (typeof intensity === 'number' ? intensity : 100) / 100;
    const root = document.documentElement;

    const styleKey = state.paletteStyle || 'classic';
    const style = PALETTE_STYLES[styleKey] || PALETTE_STYLES.classic;

    const hSec = (h + style.secHueShift) % 360;
    const hTert = (h + style.tertHueShift) % 360;

    const isMonochrome = intensityFactor < 0.08 || (styleKey === 'neutral' && intensityFactor < 0.05);
    const br = (typeof brightness === 'number' ? brightness : 50) / 100;

    if (mode === 'light') {
      const LB = (v) => Math.max(0, Math.min(100, Math.round(v + (br - 0.5) * 24)));
      if (isMonochrome) {
        root.style.setProperty('--md-sys-color-primary', '#1C1B1F');
        root.style.setProperty('--md-sys-color-on-primary', '#FFFFFF');
        root.style.setProperty('--md-sys-color-primary-container', hslToHex(0, 0, LB(90)));
        root.style.setProperty('--md-sys-color-on-primary-container', '#1C1B1F');
        root.style.setProperty('--md-sys-color-secondary', '#49454F');
        root.style.setProperty('--md-sys-color-secondary-container', hslToHex(0, 0, LB(90)));
        root.style.setProperty('--md-sys-color-on-secondary-container', '#1C1B1F');
        root.style.setProperty('--md-sys-color-tertiary', '#49454F');
        root.style.setProperty('--md-sys-color-tertiary-container', hslToHex(0, 0, LB(90)));
        root.style.setProperty('--md-sys-color-background', hslToHex(0, 0, LB(99)));
        root.style.setProperty('--md-sys-color-surface', hslToHex(0, 0, LB(98)));
        root.style.setProperty('--md-sys-color-surface-dim', hslToHex(0, 0, LB(87)));
        root.style.setProperty('--md-sys-color-surface-bright', hslToHex(0, 0, LB(98)));
        root.style.setProperty('--md-sys-color-surface-container-lowest', hslToHex(0, 0, LB(100)));
        root.style.setProperty('--md-sys-color-surface-container-low', hslToHex(0, 0, LB(96)));
        root.style.setProperty('--md-sys-color-surface-container', hslToHex(0, 0, LB(94)));
        root.style.setProperty('--md-sys-color-surface-container-high', hslToHex(0, 0, LB(92)));
        root.style.setProperty('--md-sys-color-surface-container-highest', hslToHex(0, 0, LB(90)));
        root.style.setProperty('--md-sys-color-on-surface', '#1C1B1F');
        root.style.setProperty('--md-sys-color-on-surface-variant', '#49454F');
        root.style.setProperty('--md-sys-color-outline', '#79747E');
        root.style.setProperty('--md-sys-color-outline-variant', '#CAC4D0');
      } else {
        const sat = Math.min(100, Math.round(48 * intensityFactor * style.priSatScale));
        const satHi = Math.min(100, Math.round(80 * intensityFactor * style.contSatScale));
        const satMed = Math.min(100, Math.round(55 * intensityFactor * style.priSatScale));
        const satLow = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
        const satLow2 = Math.min(100, Math.round(20 * intensityFactor * style.contSatScale));
        const surfFactor = intensityFactor * style.surfSatScale;

        root.style.setProperty('--md-sys-color-primary', hslToHex(h, sat, 40));
        root.style.setProperty('--md-sys-color-on-primary', '#FEFBFF');
        root.style.setProperty('--md-sys-color-primary-container', hslToHex(h, satHi, LB(90)));
        root.style.setProperty('--md-sys-color-on-primary-container', hslToHex(h, satMed, 18));
        root.style.setProperty('--md-sys-color-secondary', hslToHex(hSec, satLow, 45));
        root.style.setProperty('--md-sys-color-secondary-container', hslToHex(hSec, satLow, LB(90)));
        root.style.setProperty('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 15));
        root.style.setProperty('--md-sys-color-tertiary', hslToHex(hTert, satLow, 45));
        root.style.setProperty('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, LB(90)));
        root.style.setProperty('--md-sys-color-background', hslToHex(h, Math.round(5 * surfFactor), LB(99)));
        root.style.setProperty('--md-sys-color-surface', hslToHex(h, Math.round(6 * surfFactor), LB(98)));
        root.style.setProperty('--md-sys-color-surface-dim', hslToHex(h, Math.round(5 * surfFactor), LB(87)));
        root.style.setProperty('--md-sys-color-surface-bright', hslToHex(h, Math.round(6 * surfFactor), LB(98)));
        root.style.setProperty('--md-sys-color-surface-container-lowest', hslToHex(h, Math.round(4 * surfFactor), LB(100)));
        root.style.setProperty('--md-sys-color-surface-container-low', hslToHex(h, Math.round(5 * surfFactor), LB(96)));
        root.style.setProperty('--md-sys-color-surface-container', hslToHex(h, Math.round(6 * surfFactor), LB(94)));
        root.style.setProperty('--md-sys-color-surface-container-high', hslToHex(h, Math.round(5 * surfFactor), LB(92)));
        root.style.setProperty('--md-sys-color-surface-container-highest', hslToHex(h, Math.round(5 * surfFactor), LB(90)));
        root.style.setProperty('--md-sys-color-on-surface', '#1C1B1F');
        root.style.setProperty('--md-sys-color-on-surface-variant', '#49454F');
        root.style.setProperty('--md-sys-color-outline', '#79747E');
        root.style.setProperty('--md-sys-color-outline-variant', '#CAC4D0');
      }
    } else {
      if (isMonochrome) {
        root.style.setProperty('--md-sys-color-primary', '#E2E2E9');
        root.style.setProperty('--md-sys-color-on-primary', '#1C1B1F');
        root.style.setProperty('--md-sys-color-primary-container', '#49454F');
        root.style.setProperty('--md-sys-color-on-primary-container', '#E2E2E9');
        root.style.setProperty('--md-sys-color-secondary', '#C4C6D0');
        root.style.setProperty('--md-sys-color-secondary-container', '#2B2930');
        root.style.setProperty('--md-sys-color-on-secondary-container', '#E2E2E9');
        root.style.setProperty('--md-sys-color-tertiary', '#C4C6D0');
        root.style.setProperty('--md-sys-color-tertiary-container', '#2B2930');
        const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
        root.style.setProperty('--md-sys-color-background', hslToHex(0, 0, B(7)));
        root.style.setProperty('--md-sys-color-surface', hslToHex(0, 0, B(7)));
        root.style.setProperty('--md-sys-color-surface-dim', hslToHex(0, 0, B(7)));
        root.style.setProperty('--md-sys-color-surface-bright', hslToHex(0, 0, B(19)));
        root.style.setProperty('--md-sys-color-surface-container-lowest', hslToHex(0, 0, B(5)));
        root.style.setProperty('--md-sys-color-surface-container-low', hslToHex(0, 0, B(10)));
        root.style.setProperty('--md-sys-color-surface-container', hslToHex(0, 0, B(13)));
        root.style.setProperty('--md-sys-color-surface-container-high', hslToHex(0, 0, B(16)));
        root.style.setProperty('--md-sys-color-surface-container-highest', hslToHex(0, 0, B(20)));
        root.style.setProperty('--md-sys-color-on-surface', '#E2E2E9');
        root.style.setProperty('--md-sys-color-on-surface-variant', '#C4C6D0');
        root.style.setProperty('--md-sys-color-outline', '#8E9099');
        root.style.setProperty('--md-sys-color-outline-variant', '#44474E');
      } else {
        const sat = Math.min(100, Math.round(60 * intensityFactor * style.priSatScale));
        const satHi = Math.min(100, Math.round(60 * intensityFactor * style.contSatScale));
        const satMed = Math.min(100, Math.round(50 * intensityFactor * style.priSatScale));
        const satLow = Math.min(100, Math.round(15 * intensityFactor * style.contSatScale));
        const satLow2 = Math.min(100, Math.round(30 * intensityFactor * style.contSatScale));
        const surfFactor = intensityFactor * style.surfSatScale;
        const priHex = hslToHex(h, sat, 75);
        const priRgb = hexToRgb(priHex);
        root.style.setProperty('--md-sys-color-primary', priHex);
        root.style.setProperty('--md-sys-color-on-primary', hslToHex(h, satMed, 20));
        root.style.setProperty('--md-sys-color-primary-container', `rgba(${priRgb.r}, ${priRgb.g}, ${priRgb.b}, 0.18)`);
        root.style.setProperty('--md-sys-color-on-primary-container', priHex);
        root.style.setProperty('--md-sys-color-secondary', hslToHex(hSec, satLow2, 75));
        root.style.setProperty('--md-sys-color-secondary-container', hslToHex(hSec, satLow, 22));
        root.style.setProperty('--md-sys-color-on-secondary-container', hslToHex(hSec, satLow2, 85));
        root.style.setProperty('--md-sys-color-tertiary', hslToHex(hTert, satLow2, 75));
        root.style.setProperty('--md-sys-color-tertiary-container', hslToHex(hTert, satLow, 22));
        const B = (v) => Math.max(0, Math.min(100, Math.round(v * (br * 2))));
        root.style.setProperty('--md-sys-color-background', hslToHex(h, Math.round(5 * surfFactor), B(7)));
        root.style.setProperty('--md-sys-color-surface', hslToHex(h, Math.round(6 * surfFactor), B(8)));
        root.style.setProperty('--md-sys-color-surface-dim', hslToHex(h, Math.round(5 * surfFactor), B(7)));
        root.style.setProperty('--md-sys-color-surface-bright', hslToHex(h, Math.round(4 * surfFactor), B(24)));
        root.style.setProperty('--md-sys-color-surface-container-lowest', hslToHex(h, Math.round(5 * surfFactor), B(5)));
        root.style.setProperty('--md-sys-color-surface-container-low', hslToHex(h, Math.round(5 * surfFactor), B(10)));
        root.style.setProperty('--md-sys-color-surface-container', hslToHex(h, Math.round(6 * surfFactor), B(13)));
        root.style.setProperty('--md-sys-color-surface-container-high', hslToHex(h, Math.round(5 * surfFactor), B(16)));
        root.style.setProperty('--md-sys-color-surface-container-highest', hslToHex(h, Math.round(5 * surfFactor), B(20)));
        root.style.setProperty('--md-sys-color-on-surface', '#e2e2e9');
        root.style.setProperty('--md-sys-color-on-surface-variant', '#c4c6d0');
        root.style.setProperty('--md-sys-color-outline', '#8e9099');
        root.style.setProperty('--md-sys-color-outline-variant', '#282a33');
      }
    }
  }

  // panel and text opacity: surfaces and text colors become a mix with transparent, so a
  // wallpaper can show through. The plain color stays in --*-solid for canvases and the mini player
  const PANEL_TOKENS = ['background', 'surface', 'surface-dim', 'surface-bright', 'surface-container-lowest',
    'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest'];
  const TEXT_TOKENS = ['on-surface', 'on-surface-variant'];
  const readPercent = (key, min) => {
    const v = parseInt(localStorage.getItem(key) || '100', 10);
    return Math.max(min, Math.min(100, Number.isFinite(v) ? v : 100));
  };

  function applyTranslucency() {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const panel = readPercent('riffle_ui_alpha', 20);
    const text = readPercent('riffle_text_alpha', 10);
    const mix = (tokens, pct) => tokens.forEach(name => {
      const prop = `--md-sys-color-${name}`;
      let solid = root.style.getPropertyValue(prop).trim();
      if (!solid || solid.startsWith('color-mix')) solid = root.style.getPropertyValue(prop + '-solid').trim() || css.getPropertyValue(prop + '-solid').trim();
      if (!solid) return;
      root.style.setProperty(prop + '-solid', solid);
      root.style.setProperty(prop, pct >= 100 ? solid : `color-mix(in srgb, ${solid} ${pct}%, transparent)`);
    });
    mix(PANEL_TOKENS, panel);
    mix(TEXT_TOKENS, text);
    document.body.classList.toggle('translucent-ui', panel < 100);
  }

  function extractDominantColor(imgSrc) {
    return new Promise((resolve) => {
      if (!imgSrc) return resolve('#6750A4');
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 10;
        canvas.height = 10;
        ctx.drawImage(img, 0, 0, 10, 10);
        const data = ctx.getImageData(0, 0, 10, 10).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i+1]; b += data[i+2];
        }
        const count = data.length / 4;
        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);
        const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        resolve(hex);
      };
      img.onerror = () => resolve('#6750A4');
      img.src = imgSrc;
    });
  }

  let cachedPrimaryColor = '';
  let cachedDimColor = '';
  function refreshCachedThemeColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    cachedPrimaryColor = rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4';
    cachedDimColor = rootStyle.getPropertyValue('--md-sys-color-surface-container-highest-solid').trim() || '#E6E0E9';
  }

  const coverAnalysisCache = new Map();

  function analyzeCover(imgSrc) {
    return new Promise((resolve) => {
      if (!imgSrc) {
        return resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
      }
      if (coverAnalysisCache.has(imgSrc)) {
        const cached = coverAnalysisCache.get(imgSrc);
        coverAnalysisCache.delete(imgSrc);
        coverAnalysisCache.set(imgSrc, cached);
        return resolve(cached);
      }

      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 48;
          canvas.height = 48;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 48, 48);
          const data = ctx.getImageData(0, 0, 48, 48).data;

          let totalLuminance = 0;
          let nonGraySatSum = 0;
          let nonGraySatCount = 0;

          const bins = Array.from({ length: 24 }, (_, i) => ({
            idx: i,
            centerHue: (i + 0.5) * 15,
            weight: 0,
            rSum: 0,
            gSum: 0,
            bSum: 0,
            count: 0
          }));

          let fallbackR = 0, fallbackG = 0, fallbackB = 0;
          const totalPixels = data.length / 4;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            fallbackR += r;
            fallbackG += g;
            fallbackB += b;

            const rN = r / 255;
            const gN = g / 255;
            const bN = b / 255;

            const lum = 0.2126 * rN + 0.7152 * gN + 0.0722 * bN;
            totalLuminance += lum;

            const max = Math.max(rN, gN, bN);
            const min = Math.min(rN, gN, bN);
            const d = max - min;
            const l = (max + min) / 2;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

            if (s >= 0.15) {
              nonGraySatSum += s;
              nonGraySatCount++;

              if (l >= 0.10 && l <= 0.90) {
                let hDeg = 0;
                if (d > 0) {
                  if (max === rN) {
                    hDeg = ((gN - bN) / d + (gN < bN ? 6 : 0)) * 60;
                  } else if (max === gN) {
                    hDeg = ((bN - rN) / d + 2) * 60;
                  } else {
                    hDeg = ((rN - gN) / d + 4) * 60;
                  }
                }
                const binIdx = Math.min(23, Math.max(0, Math.floor(hDeg / 15)));
                const bin = bins[binIdx];
                bin.weight += s;
                bin.rSum += r;
                bin.gSum += g;
                bin.bSum += b;
                bin.count++;
              }
            }
          }

          const meanLuminance = totalLuminance / totalPixels;
          const meanSaturation = nonGraySatCount > 0 ? (nonGraySatSum / nonGraySatCount) : 0;

          let bestBin = null;
          for (let i = 0; i < 24; i++) {
            if (bins[i].count > 0) {
              if (!bestBin || bins[i].weight > bestBin.weight) {
                bestBin = bins[i];
              }
            }
          }

          let accentHex = '';
          let accentR = 0, accentG = 0, accentB = 0;

          if (bestBin && bestBin.count > 0) {
            accentR = Math.round(bestBin.rSum / bestBin.count);
            accentG = Math.round(bestBin.gSum / bestBin.count);
            accentB = Math.round(bestBin.bSum / bestBin.count);
            accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
          } else {
            accentR = Math.round(fallbackR / totalPixels);
            accentG = Math.round(fallbackG / totalPixels);
            accentB = Math.round(fallbackB / totalPixels);
            accentHex = '#' + [accentR, accentG, accentB].map(x => x.toString(16).padStart(2, '0')).join('');
          }

          let bestBin2 = null;
          if (bestBin) {
            for (let i = 0; i < 24; i++) {
              if (bins[i].count > 0 && i !== bestBin.idx) {
                const diff = Math.abs(bins[i].centerHue - bestBin.centerHue);
                const dist = Math.min(diff, 360 - diff);
                if (dist >= 60) {
                  if (!bestBin2 || bins[i].weight > bestBin2.weight) {
                    bestBin2 = bins[i];
                  }
                }
              }
            }
          }

          let accent2Hex = '';
          if (bestBin2 && bestBin2.count > 0) {
            const r2 = Math.round(bestBin2.rSum / bestBin2.count);
            const g2 = Math.round(bestBin2.gSum / bestBin2.count);
            const b2 = Math.round(bestBin2.bSum / bestBin2.count);
            accent2Hex = '#' + [r2, g2, b2].map(x => x.toString(16).padStart(2, '0')).join('');
          } else {
            const hslAcc = rgbToHsl(accentR, accentG, accentB);
            const h2 = (hslAcc.h + 40) % 360;
            accent2Hex = hslToHex(h2, hslAcc.s, hslAcc.l);
          }

          const result = {
            accent: accentHex,
            accent2: accent2Hex,
            luminance: meanLuminance,
            saturation: meanSaturation
          };

          if (coverAnalysisCache.size >= 50) {
            const oldestKey = coverAnalysisCache.keys().next().value;
            coverAnalysisCache.delete(oldestKey);
          }
          coverAnalysisCache.set(imgSrc, result);
          resolve(result);
        } catch (err) {
          resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
        }
      };
      img.onerror = () => {
        resolve({ accent: '#6750A4', accent2: '#9A82DB', luminance: 0.2, saturation: 0.5 });
      };
      img.src = imgSrc;
    });
  }

  let activeMeshLayer = 'a';
  let lastMeshKey = '';

  function updateMeshGradient(accentHex, accent2Hex, mode) {
    const meshA = document.getElementById('bg-mesh-a');
    const meshB = document.getElementById('bg-mesh-b');
    if (!meshA || !meshB) return;

    const isEnabled = getAdv('mesh_gradient', true) && (state.meshBrightness > 0);
    if (!isEnabled) {
      meshA.style.opacity = '0';
      meshB.style.opacity = '0';
      lastMeshKey = '';
      return;
    }

    const meshKey = `${accentHex}_${accent2Hex}_${mode}_${state.meshBrightness}`;
    if (meshKey === lastMeshKey) return;
    lastMeshKey = meshKey;

    const rgb1 = hexToRgb(accentHex);
    const rgb2 = hexToRgb(accent2Hex);

    const brightnessScale = Math.max(0, Math.min(100, state.meshBrightness)) / 100;
    const a1 = (mode === 'light' ? 0.22 : 0.55) * brightnessScale;
    const a2 = (mode === 'light' ? 0.18 : 0.45) * brightnessScale;

    const accentRgba = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, ${a1})`;
    const accent2Rgba = `rgba(${rgb2.r}, ${rgb2.g}, ${rgb2.b}, ${a2})`;

    const gradient = `linear-gradient(to bottom, transparent 35%, var(--md-sys-color-background) 85%), ` +
      `radial-gradient(ellipse at var(--mesh-p1x, 20%) var(--mesh-p1y, 0%), ${accentRgba} 0%, transparent 70%), ` +
      `radial-gradient(ellipse at var(--mesh-p2x, 85%) var(--mesh-p2y, 5%), ${accent2Rgba} 0%, transparent 65%), ` +
      `var(--md-sys-color-background)`;

    const target = activeMeshLayer === 'a' ? meshB : meshA;
    const current = activeMeshLayer === 'a' ? meshA : meshB;

    target.style.background = gradient;
    target.style.opacity = '1';
    current.style.opacity = '0';

    activeMeshLayer = activeMeshLayer === 'a' ? 'b' : 'a';
    const stage = document.getElementById('mesh-stage-bg');
    if (stage) stage.style.background = gradient;
  }

  let currentEffectiveMode = state.themeMode === 'auto' ? 'dark' : state.themeMode;

  function applyTheme(hexColor, mode, intensity = state.themeIntensity, brightness = state.themeBrightness, accent2 = null, isAuto = false) {
    currentEffectiveMode = mode;
    generateM3Palette(hexColor, mode, intensity, brightness);
    applyTranslucency();
    document.body.classList.toggle('theme-light', mode === 'light');
    document.body.classList.toggle('theme-dark', mode === 'dark');
    if (el.themeSwatches) {
      el.themeSwatches.forEach(sw => sw.classList.toggle('active', sw.dataset.color && sw.dataset.color.toLowerCase() === hexColor.toLowerCase()));
    }
    if (el.customColorInput) el.customColorInput.value = hexColor;

    const rgb = hexToRgb(hexColor);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    if (el.sliderHue) el.sliderHue.value = hsl.h;
    if (el.valHue) el.valHue.textContent = hsl.h + '°';

    if (el.sliderIntensity) {
      el.sliderIntensity.disabled = isAuto;
      el.sliderIntensity.value = intensity;
      const parent = el.sliderIntensity.closest('.setting-item');
      if (parent) parent.classList.toggle('is-disabled', isAuto);
    }
    if (el.valIntensity) el.valIntensity.textContent = intensity + '%';

    if (el.sliderBrightness) {
      el.sliderBrightness.disabled = isAuto;
      el.sliderBrightness.value = brightness;
      const parent = el.sliderBrightness.closest('.setting-item');
      if (parent) parent.classList.toggle('is-disabled', isAuto);
    }
    if (el.valBrightness) el.valBrightness.textContent = brightness + '%';

    let resolvedAccent2 = accent2;
    if (!resolvedAccent2) {
      const h2 = (hsl.h + 40) % 360;
      resolvedAccent2 = hslToHex(h2, hsl.s, hsl.l);
    }

    updateMeshGradient(hexColor, resolvedAccent2, mode);
    refreshCachedThemeColors();
  }

  function updateThemeFromState() {
    if (state.themeMode === 'auto') {
      if (coverOf(state.currentTrack)) {
        analyzeCover(coverOf(state.currentTrack)).then(analysis => {
          if (state.themeMode !== 'auto') return;

          const derivedMode = analysis.luminance > 0.58 ? 'light' : 'dark';
          const derivedIntensity = Math.min(85, Math.max(20, Math.round(analysis.saturation * 100 * 0.9)));
          let derivedBrightness;
          if (derivedMode === 'dark') {
            derivedBrightness = Math.min(60, Math.max(40, Math.round(40 + (Math.min(0.58, analysis.luminance) / 0.58) * 20)));
          } else {
            const normLum = Math.max(0, Math.min(1, (analysis.luminance - 0.58) / (1 - 0.58)));
            derivedBrightness = Math.min(75, Math.max(55, Math.round(55 + normLum * 20)));
          }

          applyTheme(analysis.accent, derivedMode, derivedIntensity, derivedBrightness, analysis.accent2, true);
        });
      } else {
        applyTheme(state.themeAccent, 'dark', state.themeIntensity, state.themeBrightness, null, true);
      }
    } else {
      applyTheme(state.themeAccent, state.themeMode, state.themeIntensity, state.themeBrightness, null, false);
    }

    if (el.themeModeBtns) {
      el.themeModeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.themeMode === state.themeMode));
    }
  }

  const el = {
    btnMinimize: document.getElementById('btn-minimize'),
                          btnMaximize: document.getElementById('btn-maximize'),
                          btnClose: document.getElementById('btn-close'),

                          searchInput: document.getElementById('search-input'),
                          searchClearBtn: document.getElementById('search-clear-btn'),
                          platformYt: document.getElementById('platform-yt'),
                          platformSc: document.getElementById('platform-sc'),

                          navActiveIndicator: document.getElementById('nav-active-indicator'),
                          navDiscover: document.getElementById('nav-discover'),
                          navFavorites: document.getElementById('nav-favorites'),
                          navHistory: document.getElementById('nav-history'),
                          navSaved: document.getElementById('nav-saved'),
                          savedCount: document.getElementById('saved-count'),
                          navQueue: document.getElementById('nav-queue'),
                          navSettings: document.getElementById('nav-settings'),
                          favoritesCount: document.getElementById('favorites-count'),
                          queueCount: document.getElementById('queue-count'),

                          presetsContainer: document.getElementById('presets-container'),
                          btnSavePresetDialog: document.getElementById('btn-save-preset-dialog'),
                          savePresetModal: document.getElementById('save-preset-modal'),
                          newPresetName: document.getElementById('new-preset-name'),
                          btnCancelPreset: document.getElementById('btn-cancel-preset'),
                          btnConfirmSavePreset: document.getElementById('btn-confirm-save-preset'),

                          renamePresetModal: document.getElementById('rename-preset-modal'),
                          renamePresetName: document.getElementById('rename-preset-name'),
                          btnCancelRenamePreset: document.getElementById('btn-cancel-rename-preset'),
                          btnConfirmRenamePreset: document.getElementById('btn-confirm-rename-preset'),

                          playlistsList: document.getElementById('playlists-list'),
                          btnNewPlaylist: document.getElementById('btn-new-playlist'),

                          viewDiscover: document.getElementById('view-discover'),
                          viewFavorites: document.getElementById('view-favorites'),
                          viewHistory: document.getElementById('view-history'),
                          viewSaved: document.getElementById('view-saved'),
                          savedTracksList: document.getElementById('saved-tracks-list'),
                          savedSubtitle: document.getElementById('saved-subtitle'),
                          savedSearchInput: document.getElementById('saved-search-input'),
                          btnOpenSavedFolder: document.getElementById('btn-open-saved-folder'),
                          viewQueue: document.getElementById('view-queue'),
                          viewPlaylistDetail: document.getElementById('view-playlist-detail'),
                          viewArtist: document.getElementById('view-artist'),
                          viewSettings: document.getElementById('view-settings'),

                          artistHeroBackdrop: document.getElementById('artist-hero-backdrop'),
                          btnBackArtist: document.getElementById('btn-back-artist'),
                          artistAvatarImg: document.getElementById('artist-avatar-img'),
                          artistAvatarFallback: document.getElementById('artist-avatar-fallback'),
                          artistVerifiedBadge: document.getElementById('artist-verified-badge'),
                          artistProfileName: document.getElementById('artist-profile-name'),
                          artistProfileBio: document.getElementById('artist-profile-bio'),
                          btnPlayArtistTracks: document.getElementById('btn-play-artist-tracks'),
                          artistTracksCount: document.getElementById('artist-tracks-count'),
                          artistTracksList: document.getElementById('artist-tracks-list'),

                          discoverEmpty: document.getElementById('discover-empty'),
                          searchResultsContainer: document.getElementById('search-results-container'),
                          resultsTitle: document.getElementById('results-title'),
                          resultsPlatformBadge: document.getElementById('results-platform-badge'),
                          resultsCount: document.getElementById('results-count'),
                          searchTracksList: document.getElementById('search-tracks-list'),
                          suggestionChips: document.getElementById('suggestion-chips'),

                          favoritesTracksList: document.getElementById('favorites-tracks-list'),
                          favoritesSearchInput: document.getElementById('favorites-search-input'),
                          playlistSearchInput: document.getElementById('playlist-search-input'),
                          favoritesSubtitle: document.getElementById('favorites-subtitle'),
                          historyTracksList: document.getElementById('history-tracks-list'),
                          btnClearHistory: document.getElementById('btn-clear-history'),
                          queueTracksList: document.getElementById('queue-tracks-list'),
                          btnClearQueue: document.getElementById('btn-clear-queue'),
                          playlistTracksList: document.getElementById('playlist-tracks-list'),
                          playlistDetailTitle: document.getElementById('playlist-detail-title'),
                          playlistDetailCount: document.getElementById('playlist-detail-count'),
                          btnBackPlaylists: document.getElementById('btn-back-playlists'),
                          btnPlayPlaylist: document.getElementById('btn-play-playlist'),
                          btnDeletePlaylist: document.getElementById('btn-delete-playlist'),

                          rightPanel: document.getElementById('right-panel'),
                          btnCloseRightPanel: document.getElementById('btn-close-right-panel'),
                          btnToggleLyricsPanel: document.getElementById('btn-toggle-lyrics-panel'),
                          btnLyricsMode: document.getElementById('btn-lyrics-mode'),
                          coverContainer: document.getElementById('cover-container'),
                          rightPanelArtworkBox: document.getElementById('right-panel-artwork-box'),
                          rightPanelCover: document.getElementById('right-panel-cover'),
                          rightPanelFallback: document.getElementById('right-panel-fallback'),
                          rightPanelTitle: document.getElementById('right-panel-title'),
                          rightPanelArtist: document.getElementById('right-panel-artist'),
                          lyricsStatus: document.getElementById('lyrics-status'),
                          lyricsContainer: document.getElementById('lyrics-container'),
                          lyricsHint: document.getElementById('lyrics-hint'),

                          playbar: document.getElementById('playbar'),
                          playbarArtwork: document.getElementById('playbar-artwork'),
                          artworkFallback: document.getElementById('artwork-fallback'),
                          playbarTitle: document.getElementById('playbar-title'),
                          playbarArtist: document.getElementById('playbar-artist'),
                          btnToggleFav: document.getElementById('btn-toggle-fav'),
                          favIcon: document.getElementById('fav-icon'),
                          btnShuffle: document.getElementById('btn-shuffle'),
                          btnPrev: document.getElementById('btn-prev'),
                          btnPlayPause: document.getElementById('btn-play-pause'),
                          playIcon: document.getElementById('play-icon'),
                          pauseIcon: document.getElementById('pause-icon'),
                          playbarSpinner: document.getElementById('playbar-spinner'),
                          btnNext: document.getElementById('btn-next'),
                          btnRepeat: document.getElementById('btn-repeat'),

                          timeCurrent: document.getElementById('time-current'),
                          timeDuration: document.getElementById('time-duration'),
                          scrubberTrack: document.getElementById('scrubber-track'),

                          visualizerCanvas: document.getElementById('visualizer-canvas'),
                          btnOpenSettings: document.getElementById('btn-open-settings'),
                          btnOpenVisualSettings: document.getElementById('btn-open-visual-settings'),
                          settingsModifiedDot: document.getElementById('settings-modified-dot'),
                          btnVolumeMute: document.getElementById('btn-volume-mute'),
                          volumeIcon: document.getElementById('volume-icon'),
                          volumeMutedIcon: document.getElementById('volume-muted-icon'),
                          volumeSlider: document.getElementById('volume-slider'),

                          downloadModal: document.getElementById('download-modal'),
                          btnCloseDownloadModal: document.getElementById('btn-close-download-modal'),
                          btnCancelDownload: document.getElementById('btn-cancel-download'),
                          btnConfirmDownload: document.getElementById('btn-confirm-download'),
                          downloadBtnText: document.getElementById('download-btn-text'),
                          downloadPreviewThumb: document.getElementById('download-preview-thumb'),
                          downloadPreviewFallback: document.getElementById('download-preview-fallback'),
                          downloadPreviewTitle: document.getElementById('download-preview-title'),
                          downloadPreviewArtist: document.getElementById('download-preview-artist'),
                          btnPlaybarMore: document.getElementById('btn-playbar-more'),

                          audioSettingsModal: document.getElementById('audio-settings-modal'),
                          btnCloseSettings: document.getElementById('btn-close-settings'),

                          btnToggleHqAudio: document.getElementById('toggle-hq-audio'),
                          hqPanelWrapper: document.getElementById('hq-panel-wrapper'),
                          hqEngineSelect: document.getElementById('hq-engine-select'),
                          sliderHqVocal: document.getElementById('slider-hq-vocal'),
                          valHqVocal: document.getElementById('val-hq-vocal'),
                          sliderHqAir: document.getElementById('slider-hq-air'),
                          valHqAir: document.getElementById('val-hq-air'),
                          sliderHqBass: document.getElementById('slider-hq-bass'),
                          valHqBass: document.getElementById('val-hq-bass'),
                          hqPresetChips: document.querySelectorAll('.hq-preset-chip'),

                          sliderSpeed: document.getElementById('slider-speed'),
                          valSpeed: document.getElementById('val-speed'),
                          sliderSpeedPitch: document.getElementById('slider-speed-pitch'),
                          valSpeedPitch: document.getElementById('val-speed-pitch'),
                          sliderPitch: document.getElementById('slider-pitch'),
                          valPitch: document.getElementById('val-pitch'),
                          sliderReverb: document.getElementById('slider-reverb'),
                          valReverb: document.getElementById('val-reverb'),
                          sliderDistortion: document.getElementById('slider-distortion'),
                          valDistortion: document.getElementById('val-distortion'),
                          sliderGain: document.getElementById('slider-gain'),
                          valGain: document.getElementById('val-gain'),
                          sliderEcho: document.getElementById('slider-echo'),
                          valEcho: document.getElementById('val-echo'),

                          sliderScale: document.getElementById('settings-slider-scale') || document.getElementById('slider-scale'),
                          valScale: document.getElementById('settings-val-scale') || document.getElementById('val-scale'),
                          sliderFontScale: document.getElementById('slider-font-scale'),
                          valFontScale: document.getElementById('val-font-scale'),
                          sliderCornerRadius: document.getElementById('slider-corner-radius'),
                          valCornerRadius: document.getElementById('val-corner-radius'),
                          themeModeBtns: document.querySelectorAll('.theme-mode-btn'),
                          themeSwatches: document.querySelectorAll('.theme-swatch'),
                          customColorInput: document.getElementById('settings-custom-color-input'),
                          sliderHue: document.getElementById('slider-theme-hue'),
                          valHue: document.getElementById('val-theme-hue'),
                          sliderIntensity: document.getElementById('slider-theme-intensity'),
                          valIntensity: document.getElementById('val-theme-intensity'),
                          sliderBrightness: document.getElementById('slider-theme-brightness'),
                          valBrightness: document.getElementById('val-theme-brightness'),

                          visualSettingsModal: document.getElementById('visual-settings-modal'),
                          btnCloseVisualSettings: document.getElementById('btn-close-visual-settings'),
                          btnResetVfx: document.getElementById('btn-reset-vfx'),

                          createPlaylistModal: document.getElementById('create-playlist-modal'),
                          newPlaylistInput: document.getElementById('new-playlist-input'),
                          btnCancelNewPlaylist: document.getElementById('btn-cancel-new-playlist'),
                          btnConfirmNewPlaylist: document.getElementById('btn-confirm-new-playlist'),

                          addToPlaylistModal: document.getElementById('add-to-playlist-modal'),
                          playlistPickList: document.getElementById('playlist-pick-list'),
                          btnCancelAddPlaylist: document.getElementById('btn-cancel-add-playlist'),

                          nativeAudio: document.getElementById('native-audio'),
                          tailAudio: document.getElementById('crossfade-audio'),
                          trackLoadingOverlay: document.getElementById('track-loading-overlay'),
                          trackLoadingTitle: document.getElementById('track-loading-title'),
                          trackLoadingSub: document.getElementById('track-loading-sub'),

                          btnAddCustomLyrics: document.getElementById('btn-add-custom-lyrics'),
                          btnSyncLyrics: document.getElementById('btn-sync-lyrics'),
                          customLyricsModal: document.getElementById('custom-lyrics-modal'),
                          customLyricsTextarea: document.getElementById('custom-lyrics-textarea'),
                          customLyricsTrackTitle: document.getElementById('custom-lyrics-track-title'),
                          customLyricsTrackArtist: document.getElementById('custom-lyrics-track-artist'),
                          btnCloseCustomLyrics: document.getElementById('btn-close-custom-lyrics'),
                          btnCancelCustomLyrics: document.getElementById('btn-cancel-custom-lyrics'),
                          btnSaveCustomLyrics: document.getElementById('btn-save-custom-lyrics'),
                          syncModeOverlay: document.getElementById('sync-mode-overlay'),
                          syncModeLyrics: document.getElementById('sync-mode-lyrics'),
                          syncProgressText: document.getElementById('sync-progress-text'),
                          btnRestartSync: document.getElementById('btn-restart-sync'),
                          btnSaveSync: document.getElementById('btn-save-sync'),
                          btnCancelSync: document.getElementById('btn-cancel-sync'),

                          btnEditCurrentTrack: document.getElementById('btn-edit-current-track'),
                          renameTrackModal: document.getElementById('rename-track-modal'),
                          inputRenameTitle: document.getElementById('rename-track-title'),
                          inputRenameArtist: document.getElementById('rename-track-artist'),
                          btnCancelRenameTrack: document.getElementById('btn-cancel-rename-track'),
                          btnConfirmRenameTrack: document.getElementById('btn-confirm-rename-track'),

                          btnRefreshVibe: document.getElementById('btn-refresh-vibe')
  };

  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    if (slider) {
      slider.min = -50;
      slider.max = 50;
      slider.value = state.hqSettings[type.toLowerCase()];
    }
  });

  if (el.sliderScale) el.sliderScale.value = state.uiScale;
  if (el.valScale) el.valScale.textContent = `${state.uiScale}%`;

  const savedFontScale = localStorage.getItem('riffle_font_scale') || '100';
  if (el.sliderFontScale) el.sliderFontScale.value = savedFontScale;
  if (el.valFontScale) el.valFontScale.textContent = savedFontScale + '%';
  document.documentElement.style.setProperty('--font-scale', (parseInt(savedFontScale) / 100));

  const savedRadius = localStorage.getItem('riffle_corner_radius') || '16';
  if (el.sliderCornerRadius) el.sliderCornerRadius.value = savedRadius;
  if (el.valCornerRadius) el.valCornerRadius.textContent = savedRadius === '16' ? tr('Default') : `${savedRadius}px`;
  document.documentElement.style.setProperty('--md-shape-corner-l', `${savedRadius}px`);
  document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, parseInt(savedRadius) - 4)}px`);

  applyReducedMotionSetting();

  const savedBannerBlur = parseInt(localStorage.getItem('riffle_banner_blur') || '3', 10);
  const savedBannerOpacity = parseInt(localStorage.getItem('riffle_banner_opacity') || '100', 10);
  const savedBannerFade = parseInt(localStorage.getItem('riffle_banner_fade') || '38', 10);

  document.documentElement.style.setProperty('--banner-blur', `${savedBannerBlur}px`);
  document.documentElement.style.setProperty('--banner-opacity', `${savedBannerOpacity / 100}`);
  document.documentElement.style.setProperty('--banner-fade-base', `${savedBannerFade}%`);

  updateThemeFromState();

  if (state.themeMode !== 'auto') {
    if (el.sliderIntensity) el.sliderIntensity.value = state.themeIntensity;
    if (el.valIntensity) el.valIntensity.textContent = state.themeIntensity + '%';
    if (el.sliderBrightness) el.sliderBrightness.value = state.themeBrightness;
    if (el.valBrightness) el.valBrightness.textContent = state.themeBrightness + '%';
  }

  const railDrawer = document.getElementById('rail-drawer');
  const sidebarEl = document.querySelector('.sidebar');
  const btnTogglePresets = document.getElementById('btn-toggle-presets-drawer');
  const btnTogglePlaylists = document.getElementById('btn-toggle-playlists-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-rail-drawer');
  const sectionPresets = document.getElementById('drawer-section-presets');
  const sectionPlaylists = document.getElementById('drawer-section-playlists');
  const drawerTitle = document.getElementById('rail-drawer-title');

  let openDrawerState = null;
  let activeDrawerMode = null;

  function applyDrawerState(triggerBtn) {
    if (!railDrawer) return;

    if (!openDrawerState) {
      if (activeDrawerMode !== null) {
        if (sidebarEl) sidebarEl.classList.remove('has-drawer-open');
        if (btnTogglePresets) btnTogglePresets.classList.remove('active');
        if (btnTogglePlaylists) btnTogglePlaylists.classList.remove('active');
        activeDrawerMode = null;
        LiquidMotion.close(railDrawer, () => {
          railDrawer.classList.add('hidden');
        });
      }
    } else {
      const isPresets = openDrawerState === 'presets';
      const trigger = triggerBtn || (isPresets ? btnTogglePresets : btnTogglePlaylists);

      if (btnTogglePresets) btnTogglePresets.classList.toggle('active', isPresets);
      if (btnTogglePlaylists) btnTogglePlaylists.classList.toggle('active', !isPresets);
      railDrawer.classList.toggle('drawer-presets-mode', isPresets);

      if (activeDrawerMode === null) {
        activeDrawerMode = openDrawerState;
        railDrawer.classList.remove('hidden');
        if (sectionPresets) sectionPresets.style.display = isPresets ? 'flex' : 'none';
        if (sectionPlaylists) sectionPlaylists.style.display = isPresets ? 'none' : 'flex';
        if (drawerTitle) drawerTitle.textContent = isPresets ? tr('Presets') : tr('Playlists');
        if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
        if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
        if (sidebarEl) sidebarEl.classList.add('has-drawer-open');
        LiquidMotion.open(railDrawer, trigger, 'x');
      } else if (activeDrawerMode !== openDrawerState) {
        activeDrawerMode = openDrawerState;
        const outgoing = isPresets ? sectionPlaylists : sectionPresets;
        const incoming = isPresets ? sectionPresets : sectionPlaylists;

        if (outgoing) outgoing.classList.add('section-switching-out');
        setTimeout(() => {
          if (outgoing) {
            outgoing.style.display = 'none';
            outgoing.classList.remove('section-switching-out');
          }
          if (drawerTitle) drawerTitle.textContent = isPresets ? tr('Presets') : tr('Playlists');
          railDrawer.classList.toggle('drawer-presets-mode', isPresets);
          if (el.btnSavePresetDialog) el.btnSavePresetDialog.style.display = isPresets ? 'inline-flex' : 'none';
          if (el.btnNewPlaylist) el.btnNewPlaylist.style.display = isPresets ? 'none' : 'inline-flex';
          if (incoming) {
            incoming.style.display = 'flex';
            incoming.classList.add('section-switching-in');
            setTimeout(() => incoming.classList.remove('section-switching-in'), 200);
          }
        }, 120);
      }
    }
  }

  function openDrawer(mode, triggerBtn) {
    openDrawerState = mode;
    applyDrawerState(triggerBtn);
  }

  function closeDrawer() {
    openDrawerState = null;
    applyDrawerState();
  }

  if (btnTogglePresets) {
    btnTogglePresets.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'presets' ? null : 'presets';
      applyDrawerState(btnTogglePresets);
    });
  }

  if (btnTogglePlaylists) {
    btnTogglePlaylists.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawerState = openDrawerState === 'playlists' ? null : 'playlists';
      applyDrawerState(btnTogglePlaylists);
    });
  }

  if (btnCloseDrawer) {
    btnCloseDrawer.addEventListener('click', () => closeDrawer());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDrawerState) closeDrawer();
  });

  const resumeAudioOnce = () => {
    initAudioContext();
    document.removeEventListener('click', resumeAudioOnce);
    document.removeEventListener('keydown', resumeAudioOnce);
  };
  document.addEventListener('click', resumeAudioOnce);
  document.addEventListener('keydown', resumeAudioOnce);

  document.addEventListener('click', (e) => {
    if (openDrawerState && railDrawer) {
      if (!railDrawer.contains(e.target) &&
        (!btnTogglePresets || !btnTogglePresets.contains(e.target)) &&
        (!btnTogglePlaylists || !btnTogglePlaylists.contains(e.target))) {
        closeDrawer();
      }
    }
  });

  // edit dialog: title, artist, and an optional cover and banner of the song. Picks are only
  // kept when the dialog is saved
  let editTarget = null;
  let editArt = {};

  function renderTrackEditorArt() {
    const cover = editArt.cover || (editTarget && editTarget.thumbnail) || '';
    paintMediaThumb(document.getElementById('track-art-cover-thumb'), cover);
    const coverStatus = document.getElementById('track-art-cover-status');
    if (coverStatus) coverStatus.textContent = editArt.cover ? fileNameOf(editArt.cover) : tr('Original art');
    const globalBanner = localStorage.getItem('riffle_banner_media') || '';
    paintMediaThumb(document.getElementById('track-art-banner-thumb'), editArt.banner || globalBanner || cover);
    const bannerStatus = document.getElementById('track-art-banner-status');
    if (bannerStatus) bannerStatus.textContent = editArt.banner ? fileNameOf(editArt.banner) : tr('Same as every song');
    const resetCover = document.getElementById('btn-reset-track-cover');
    const resetBanner = document.getElementById('btn-reset-track-banner');
    if (resetCover) resetCover.disabled = !editArt.cover;
    if (resetBanner) resetBanner.disabled = !editArt.banner;
  }

  function openTrackRenameDialog(track) {
    editTarget = (track && track.id) ? track : state.currentTrack;
    if (!editTarget) {
      showToast(tr('No track currently playing'), 'info');
      return;
    }
    editArt = Object.assign({}, getTrackArt(editTarget));
    if (el.inputRenameTitle) el.inputRenameTitle.value = editTarget.title || '';
    if (el.inputRenameArtist) el.inputRenameArtist.value = editTarget.artist || '';
    renderTrackEditorArt();
    if (el.renameTrackModal) openModal(el.renameTrackModal);
    if (el.inputRenameTitle) el.inputRenameTitle.focus();
  }
  window.openTrackEditor = openTrackRenameDialog;

  if (el.btnEditCurrentTrack) el.btnEditCurrentTrack.addEventListener('click', () => openTrackRenameDialog(state.currentTrack));
  if (el.btnCancelRenameTrack) el.btnCancelRenameTrack.addEventListener('click', () => closeModal(el.renameTrackModal));

  [['btn-choose-track-cover', 'cover', 'image'], ['btn-choose-track-banner', 'banner', 'media']].forEach(([id, key, kind]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', async () => {
      const picked = await pickMediaFile(kind);
      if (!picked) return;
      editArt[key] = picked.url;
      renderTrackEditorArt();
    });
  });
  [['btn-reset-track-cover', 'cover'], ['btn-reset-track-banner', 'banner']].forEach(([id, key]) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => { delete editArt[key]; renderTrackEditorArt(); });
  });

  if (el.btnConfirmRenameTrack) {
    el.btnConfirmRenameTrack.addEventListener('click', () => {
      const target = editTarget;
      if (!target) return;
      const newTitle = el.inputRenameTitle ? el.inputRenameTitle.value.trim() || tr('Untitled track') : tr('Untitled track');
      const newArtist = el.inputRenameArtist ? el.inputRenameArtist.value.trim() || tr('Unknown artist') : tr('Unknown artist');
      const canonical = getTrackCanonicalId(target);

      // art is keyed by id, so store it before anything else changes
      setTrackArt(target, { cover: editArt.cover || null, banner: editArt.banner || null });
      if (editArt.cover) coverAnalysisCache.delete(editArt.cover);

      const matches = (t) => t && getTrackCanonicalId(t) === canonical;
      const renameIn = (arr) => {
        let updated = false;
        (arr || []).forEach(t => {
          if (matches(t)) {
            t.title = newTitle;
            t.artist = newArtist;
            updated = true;
          }
        });
        return updated;
      };
      target.title = newTitle;
      target.artist = newArtist;
      const isCurrent = matches(state.currentTrack);
      if (isCurrent && state.currentTrack !== target) {
        state.currentTrack.title = newTitle;
        state.currentTrack.artist = newArtist;
      }

      if (renameIn(state.history)) localStorage.setItem('devsize_history', JSON.stringify(state.history));
      if (renameIn(state.favorites)) localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      let playlistsChanged = false;
      (state.playlists || []).forEach(pl => { if (renameIn(pl.tracks)) playlistsChanged = true; });
      if (playlistsChanged) localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
      if (renameIn(state.queue)) renderQueueView();

      document.querySelectorAll(`.track-row[data-canonical-id="${CSS.escape(canonical)}"]`).forEach(row => {
        const img = row.querySelector('.track-row-thumb');
        if (img) { img.src = smallThumb(coverOf(target)); img.style.visibility = ''; }
        const t = row.querySelector('.track-row-title');
        const a = row.querySelector('.track-row-artist');
        if (t) t.textContent = newTitle;
        if (a) a.textContent = newArtist;
      });

      if (isCurrent) {
        updateNowPlayingUI(state.currentTrack);
        sendStateToServer();
        sendDiscordRpcUpdate(state.currentTrack, state.isPlaying);
        sendMiniState(true);
      }

      if (el.renameTrackModal) closeModal(el.renameTrackModal);
      showToast(tr('Track info updated'), 'info');
    });
  }

  const audioEngine = new window.RiffleAudioEngine();
  let hlsInstance = null;

  // crossfade: the tail element replays the outgoing track's last seconds while the main one moves on
  const crossfade = { active: false, swapping: false, token: 0, pendingFadeIn: 0, prefetchedFor: null };
  let lastSessionSave = 0;

  function syncLoopMode() {
    // plain loop is gapless natively; crossfaded loops are driven from timeupdate
    if (el.nativeAudio) el.nativeAudio.loop = state.isRepeat && !state.crossfadeLoop;
  }

  function stopCrossfade() {
    crossfade.token++;
    crossfade.active = false;
    crossfade.swapping = false;
    crossfade.pendingFadeIn = 0;
    if (el.tailAudio) {
      el.tailAudio.pause();
      el.tailAudio.removeAttribute('src');
      el.tailAudio.load();
    }
    audioEngine.resetDecks();
  }

  function waitForEvent(target, name, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      target.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  function prefetchNextTrack() {
    if (state.isShuffle && !state.playNextPending) return;
    const next = state.queue[state.queueIndex + 1] || (state.queue.length > 1 ? state.queue[0] : null);
    if (!next || !next.url || crossfade.prefetchedFor === next) return;
    crossfade.prefetchedFor = next;
    if (findSavedTrack(next)) return;
    fetch(`http://127.0.0.1:${state.serverPort}/api/prefetch?url=${encodeURIComponent(next.url)}&id=${encodeURIComponent(next.id || '')}&platform=${next.platform || state.platform}`).catch(() => {});
  }

  function maybeStartCrossfade() {
    const a = el.nativeAudio;
    if (!a || !el.tailAudio || crossfade.active || a.paused || hlsInstance || !audioEngine.canCrossfade()) return;
    const looping = state.isRepeat;
    if (looping ? !state.crossfadeLoop : !state.crossfadeEnabled) return;
    const dur = a.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const rate = a.playbackRate || 1;
    const remaining = (dur - a.currentTime) / rate;
    const secs = Math.min(state.crossfadeSecs, dur / rate / 3);
    if (!looping && remaining < secs + 25) prefetchNextTrack();
    if (secs < 1 || remaining > secs || remaining < 0.5) return;
    startCrossfade(looping, secs, remaining);
  }

  async function startCrossfade(looping, secs, remaining) {
    const a = el.nativeAudio;
    const tail = el.tailAudio;
    const src = a.currentSrc;
    if (!src || src.startsWith('blob:')) return;
    crossfade.active = true;
    const token = ++crossfade.token;
    // past this budget the track would end first; let the normal ended path handle it
    const budget = Math.max(200, remaining * 1000 - 300);
    try {
      tail.src = src;
      tail.preservesPitch = a.preservesPitch;
      tail.currentTime = a.currentTime;
      await Promise.race([tail.play(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), budget))]);
      tail.playbackRate = a.playbackRate;
      if (Math.abs(tail.currentTime - a.currentTime) > 0.08) {
        tail.currentTime = a.currentTime + 0.03;
        await waitForEvent(tail, 'seeked', 400).catch(() => {});
      }
    } catch (e) {
      if (token === crossfade.token) stopCrossfade();
      return;
    }
    if (token !== crossfade.token || a.paused) {
      if (token === crossfade.token) stopCrossfade();
      return;
    }

    audioEngine.startTailFade(secs);
    if (looping) {
      a.currentTime = 0;
      audioEngine.fadeInMain(secs);
    } else {
      crossfade.swapping = true;
      crossfade.pendingFadeIn = secs;
      playNext();
    }

    setTimeout(() => {
      if (token !== crossfade.token) return;
      crossfade.active = false;
      crossfade.swapping = false;
      tail.pause();
      tail.removeAttribute('src');
      tail.load();
    }, secs * 1000 + 250);
  }

  function savePlayerVolume() {
    localStorage.setItem('riffle_volume', String(state.volume));
    localStorage.setItem('riffle_muted', String(state.isMuted));
  }

  function saveSession() {
    if (!state.currentTrack) return;
    const hasSrc = el.nativeAudio && el.nativeAudio.getAttribute('src');
    const position = hasSrc ? (el.nativeAudio.currentTime || 0) : (state.resumePosition || 0);
    try {
      localStorage.setItem('riffle_session', JSON.stringify({
        track: state.currentTrack,
        queue: state.queue,
        queueIndex: state.queueIndex,
        position
      }));
    } catch (e) {}
  }

  function restoreSession() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('riffle_session') || 'null'); } catch (e) {}
    if (!saved || !saved.track) return;
    state.queue = Array.isArray(saved.queue) && saved.queue.length ? saved.queue : [saved.track];
    state.queueIndex = isSameTrack(state.queue[saved.queueIndex], saved.track)
      ? saved.queueIndex
      : state.queue.findIndex(t => isSameTrack(t, saved.track));
    if (state.queueIndex === -1) {
      state.queue.unshift(saved.track);
      state.queueIndex = 0;
    }
    state.currentTrack = saved.track;
    state.resumeTrack = saved.track;
    state.resumePosition = Number(saved.position) || 0;
    updateNowPlayingUI(saved.track);
    updateQueueBadge();
    if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(state.resumePosition);
  }

  function queuePlayNext(track) {
    if (!track) return;
    if (!state.currentTrack) {
      playTrack(track);
      return;
    }
    if (isSameTrack(track, state.currentTrack)) {
      showToast(tr('Already playing'));
      return;
    }
    const existing = state.queue.findIndex((t, i) => i !== state.queueIndex && isSameTrack(t, track));
    if (existing !== -1) {
      state.queue.splice(existing, 1);
      if (existing < state.queueIndex) state.queueIndex--;
    }
    state.playNextPending = Math.min(state.playNextPending, state.queue.length - state.queueIndex - 1);
    const insertAt = state.queueIndex + 1 + state.playNextPending;
    state.queue.splice(insertAt, 0, track);
    state.playNextPending++;
    updateQueueBadge();
    if (state.currentView === 'queue') renderQueueView();
    showToast(tr('Playing next: {title}', { title: track.title || tr('untitled') }));
    saveSession();
  }

  const TRAY_LABELS = window.i18n && window.i18n.lang !== 'en' ? {
    play: tr('Play'), pause: tr('Pause'), next: tr('Next'), previous: tr('Previous'),
    mini: tr('Mini player'), closeMini: tr('Close mini player'), show: tr('Show Riffle'), quit: tr('Quit')
  } : null;

  function sendTrayState() {
    if (!window.electronAPI || !window.electronAPI.trayUpdate) return;
    const t = state.currentTrack;
    window.electronAPI.trayUpdate({
      title: t ? t.title || '' : '',
      artist: t ? t.artist || '' : '',
      isPlaying: Boolean(el.nativeAudio && !el.nativeAudio.paused),
      labels: TRAY_LABELS
    });
  }
  // loudness normalization: the server measures each file once; unmeasured tracks play at 0 dB
  const NORMALIZE_TARGET_LUFS = -14;
  const loudness = { token: 0, info: null, source: null };

  function loudnessGainDb(info) {
    if (!info || !isFinite(info.lufs)) return 0;
    let gain = NORMALIZE_TARGET_LUFS - info.lufs;
    // never lift true peaks past -1 dBTP
    if (isFinite(info.peak)) gain = Math.min(gain, Math.max(0, -1 - info.peak));
    return Math.max(-12, Math.min(6, gain));
  }

  function applyNormalization(rampSec = 0.6) {
    const db = state.normalizeVolume ? loudnessGainDb(loudness.info) : 0;
    audioEngine.setNormalizationGain(db, rampSec);
    const readout = document.getElementById('normalize-readout');
    if (!readout) return;
    if (!state.normalizeVolume) readout.textContent = tr('Off: every song plays at its original level');
    else if (!loudness.info) readout.textContent = loudness.source ? tr('Measuring this song…') : tr('Evens out loud and quiet songs');
    else readout.textContent = tr('This song: {value}', { value: `${loudness.info.lufs.toFixed(1)} LUFS · ${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB` });
  }

  async function loadTrackLoudness(source, loadToken) {
    const token = ++loudness.token;
    loudness.info = null;
    loudness.source = source;
    applyNormalization(0.05);
    if (!state.normalizeVolume || !source) return;
    const query = source.saved ? `saved=${encodeURIComponent(source.saved)}` : `id=${encodeURIComponent(source.id || '')}`;
    // streams land in the cache in the background; poll until the file is there
    for (let attempt = 0; attempt < 16; attempt++) {
      if (token !== loudness.token || loadToken !== state.loadToken) return;
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/loudness?${query}`);
        const data = await res.json();
        if (token !== loudness.token) return;
        if (data.success) {
          loudness.info = { lufs: data.lufs, peak: data.peak };
          applyNormalization(attempt === 0 ? 0.3 : 2.5);
          return;
        }
        if (!data.pending) return;
      } catch (e) {
        return;
      }
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  // autoplay: when the queue runs low, append YouTube's mix for the last queued song
  let isExtendingAutoplay = false;

  async function extendAutoplayQueue({ announce = false } = {}) {
    if (!state.autoplayEnabled || state.myWaveActive || isExtendingAutoplay) return false;
    const seed = state.queue[state.queue.length - 1] || state.currentTrack;
    if (!seed) return false;
    isExtendingAutoplay = true;
    try {
      const params = new URLSearchParams({
        id: seed.id || '', url: seed.url || '', title: seed.title || '',
        artist: seed.artist || '', platform: seed.platform || 'youtube', limit: '14'
      });
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/radio?${params}`);
      const data = await res.json();
      const recent = [...state.queue, ...state.history.slice(0, 60)];
      const knownIds = new Set(recent.map(t => getTrackCanonicalId(t)));
      const knownKeys = new Set(recent.map(t => getTrackNormalizedKey(t.artist, t.title)));
      const fresh = (data.tracks || []).filter(t => {
        const key = getTrackNormalizedKey(t.artist, t.title);
        if (knownIds.has(getTrackCanonicalId(t)) || knownKeys.has(key)) return false;
        knownKeys.add(key);
        return true;
      }).slice(0, 8);
      if (fresh.length === 0) return false;
      state.queue.push(...fresh);
      updateQueueBadge();
      if (state.currentView === 'queue') renderQueueView();
      if (announce) showToast(trn(fresh.length, 'Autoplay: {n} similar song added', 'Autoplay: {n} similar songs added'));
      return true;
    } catch (e) {
      return false;
    } finally {
      isExtendingAutoplay = false;
    }
  }

  // mini player: main process forwards this snapshot while the mini window is open
  let miniOpen = false;
  let lastMiniSend = 0;

  // hls.js is ~600 KB and only needed for HLS streams, so it loads on first use
  let hlsLoading = null;
  function loadHls() {
    if (window.Hls) return Promise.resolve();
    if (!hlsLoading) {
      hlsLoading = new Promise(resolve => {
        const script = document.createElement('script');
        script.src = 'assets/hls.min.js';
        script.onload = resolve;
        script.onerror = () => { hlsLoading = null; resolve(); };
        document.head.appendChild(script);
      });
    }
    return hlsLoading;
  }

  function sendMiniState(force = false) {
    if (!miniOpen || !window.electronAPI || !window.electronAPI.miniState) return;
    const now = Date.now();
    if (!force && now - lastMiniSend < 240) return;
    lastMiniSend = now;
    const t = state.currentTrack;
    const a = el.nativeAudio;
    const css = getComputedStyle(document.documentElement);
    window.electronAPI.miniState({
      title: t ? t.title || '' : '',
      artist: t ? t.artist || '' : '',
      thumbnail: coverOf(t),
      isPlaying: Boolean(a && !a.paused),
      currentTime: a ? a.currentTime || 0 : 0,
      duration: a && isFinite(a.duration) ? a.duration : (t ? t.duration || 0 : 0),
      isFavorite: Boolean(t && state.favorites && state.favorites.some(f => isSameTrack(f, t))),
      accent: css.getPropertyValue('--md-sys-color-primary').trim(),
      onAccent: css.getPropertyValue('--md-sys-color-on-primary').trim(),
      surface: css.getPropertyValue('--md-sys-color-surface-container-solid').trim()
    });
  }

  let animationFrameId = null;
  // read every frame, so kept as plain booleans instead of body class lookups
  const uiFlags = { perf: false, flatScrubber: false };

  function initAudioContext() {
    audioEngine.init(el.nativeAudio, el.tailAudio);
    
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume().catch(() => {});
    }
    
    audioEngine.setHqEnabled(state.hqEnabled);
    audioEngine.setHqSettings(state.hqSettings);
    audioEngine.setAudioSettings(state.audioSettings);
    audioEngine.setVolume(state.volume, state.isMuted);
    
    startVisualizers();
  }

  function updateHqRouting() {
    audioEngine.setHqEnabled(state.hqEnabled);
  }

  function applyHqSettings() {
    audioEngine.setHqSettings(state.hqSettings);
  }
  
  function applyAudioSettings() {
    audioEngine.setAudioSettings(state.audioSettings);
    audioEngine.setVolume(state.volume, state.isMuted);
    audioEngine.applySettings(el.nativeAudio);
    
    if (el.settingsModifiedDot) {
      if (audioEngine.isModified()) {
        el.settingsModifiedDot.classList.remove('hidden');
      } else {
        el.settingsModifiedDot.classList.add('hidden');
      }
    }
  }


  let cachedTrackWidth = 0;
  let cachedTrackHeight = 40;
  let hasDrawnPausedFrame = false;

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    if (el.scrubberTrack) {
      let scrubberCanvas = document.getElementById('squiggly-canvas');
      if (!scrubberCanvas) {
        scrubberCanvas = document.createElement('canvas');
        scrubberCanvas.id = 'squiggly-canvas';
        scrubberCanvas.className = 'squiggly-canvas';
        el.scrubberTrack.appendChild(scrubberCanvas);
      }
      const rect = el.scrubberTrack.getBoundingClientRect();
      cachedTrackWidth = rect.width;
      cachedTrackHeight = Math.max(40, rect.height);
      hasDrawnPausedFrame = false;
      scrubberCanvas.width = rect.width * dpr;
      scrubberCanvas.height = Math.max(40, rect.height) * dpr;
      scrubberCanvas.style.width = `${rect.width}px`;
      scrubberCanvas.style.height = `${Math.max(40, rect.height)}px`;
      const ctx = scrubberCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    }
    if (el.visualizerCanvas) {
      el.visualizerCanvas.width = 60 * dpr;
      el.visualizerCanvas.height = 24 * dpr;
      el.visualizerCanvas.style.width = '60px';
      el.visualizerCanvas.style.height = '24px';
      const ctx = el.visualizerCanvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    }
  }
  window.addEventListener('resize', resizeCanvases);
  setTimeout(resizeCanvases, 100);

  let smoothAmplitude = 0;
  let smoothPhase = 0;
  let scrubPhase = 0;
  let scrubProgress = 0;
  let scrubPrevKnobX = null;
  let scrubKnobAnim = 0;
  let scrubLastTime = 0;

  let lastFrameTime = 0;
  function startVisualizers() {
    const analyserNode = audioEngine.getAnalyserNode();
    if (!analyserNode || !state.isWindowVisible) return;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    const miniCanvas = el.visualizerCanvas;
    const miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;

    const bufferLength = analyserNode.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const timeData = new Uint8Array(bufferLength);

    function renderLoop(timestamp) {
      if (!state.isWindowVisible) return;
      animationFrameId = requestAnimationFrame(renderLoop);

      if (timestamp - lastFrameTime < (uiFlags.perf ? 33 : 28)) return;
      lastFrameTime = timestamp;

      if (!state.isPlaying && !isDraggingScrubber) {
        if (hasDrawnPausedFrame) return;
        hasDrawnPausedFrame = true;
      } else {
        hasDrawnPausedFrame = false;
      }

      if (uiFlags.perf) {
        if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
        if (miniCtx) miniCtx.clearRect(0, 0, 60, 24);
      } else {
      audioEngine.getFrequencyData(freqData);
      audioEngine.getTimeDomainData(timeData);

      let bassEnergy = (freqData[0] + freqData[1] + freqData[2] + freqData[3]) / (4 * 255);

      if (state.vfx.bassPulse) {
        const scaleMul = 1.0 + (bassEnergy * 0.035);
        const targetTransform = `scale(${scaleMul.toFixed(3)})`;
        if (el.coverContainer && el.coverContainer.style.transform !== targetTransform) {
          el.coverContainer.style.transform = targetTransform;
        }
      } else {
        if (el.coverContainer && el.coverContainer.style.transform) el.coverContainer.style.transform = '';
      }

      if (miniCtx && miniCanvas) {
        miniCtx.clearRect(0, 0, 60, 24);
        if (state.isPlaying) {
          const barCount = 12;
          const barWidth = 3;
          const gap = 2;
          const startX = (60 - (barCount * (barWidth + gap))) / 2;

          for (let i = 0; i < barCount; i++) {
            const val = freqData[i * 2] || 0;
            let barHeight = (val / 255) * (24 - 4);
            if (barHeight < 2) barHeight = 2;

            const x = startX + i * (barWidth + gap);
            const y = 24 - barHeight;

            miniCtx.fillStyle = '#ffffff';
            miniCtx.beginPath();
            miniCtx.roundRect(x, y, barWidth, barHeight, 2);
            miniCtx.fill();
          }
        }
      }
      }

      let scrubberCanvas = document.getElementById('squiggly-canvas');
      if (scrubberCanvas && el.scrubberTrack) {
        const sCtx = scrubberCanvas.getContext('2d');
        const sw = cachedTrackWidth || (el.scrubberTrack ? el.scrubberTrack.clientWidth : 0);
        const sh = cachedTrackHeight || 40;
        sCtx.clearRect(0, 0, sw, sh);

        const dt = scrubLastTime === 0 ? 0.016 : Math.min((timestamp - scrubLastTime) / 1000, 0.1);
        scrubLastTime = timestamp;

        const dur = el.nativeAudio && el.nativeAudio.duration ? el.nativeAudio.duration : (state.currentTrack ? state.currentTrack.duration : 0);
        let cur = el.nativeAudio ? el.nativeAudio.currentTime : 0;

        if (isDraggingScrubber && state.scrubberDragTargetTime !== undefined) {
          cur = state.scrubberDragTargetTime;
        }

        const targetProgress = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
        const followSpeed = isDraggingScrubber ? 32 : 45;
        scrubProgress += (targetProgress - scrubProgress) * Math.min(1, dt * followSpeed);

        const targetAnim = isDraggingScrubber ? 1 : 0;
        scrubKnobAnim += (targetAnim - scrubKnobAnim) * Math.min(1, dt * 16);
        const curKnobW = 7.5 + (9.0 - 7.5) * scrubKnobAnim;
        const curKnobH = 24 + (32 - 24) * scrubKnobAnim;
        const curKnobR = 3.75 + (4.5 - 3.75) * scrubKnobAnim;

        const padLeft = 5.5;
        const padRight = 5.5;
        const trackWidth = sw - padLeft - padRight;
        const knobCenterX = padLeft + scrubProgress * trackWidth;

        if (scrubPrevKnobX === null) scrubPrevKnobX = knobCenterX;
        const deltaX = knobCenterX - scrubPrevKnobX;
        scrubPrevKnobX = knobCenterX;

        const k = (2 * Math.PI) / 42;

        if (isDraggingScrubber) {
          scrubPhase += deltaX * k;
        } else if (state.isPlaying) {
          scrubPhase += 3.5 * dt;
        }

        const capRadius = 9.5 / 2;
        const knobLeft = knobCenterX - curKnobW / 2;
        const waveStart = padLeft;
        const waveEnd = knobLeft - 4.5 - capRadius;

        const inactiveStart = knobCenterX + (curKnobW / 2) + 4;
        const inactiveEnd = sw - padRight;

        if (!cachedPrimaryColor) refreshCachedThemeColors();
        const primaryColor = cachedPrimaryColor;
        const dimColor = cachedDimColor;

        const centerY = sh / 2;

        if (inactiveEnd > inactiveStart) {
          sCtx.beginPath();
          sCtx.lineWidth = 11;
          sCtx.lineCap = 'round';
          sCtx.strokeStyle = dimColor;
          sCtx.moveTo(inactiveStart, centerY);
          sCtx.lineTo(inactiveEnd, centerY);
          sCtx.stroke();
        }

        if (waveEnd > waveStart) {
          sCtx.beginPath();
          sCtx.lineWidth = 9.5;
          sCtx.lineCap = 'round';
          sCtx.lineJoin = 'round';
          sCtx.strokeStyle = primaryColor;

          const step = uiFlags.flatScrubber ? waveEnd - waveStart : 2;
          for (let x = waveStart; x <= waveEnd; x += step) {
            const angle = scrubPhase - (waveEnd - x) * k;
            const y = uiFlags.flatScrubber ? centerY : centerY + Math.sin(angle) * 5;
            if (x === waveStart) {
              sCtx.moveTo(x, y);
            } else {
              sCtx.lineTo(x, y);
            }
          }

          const finalY = uiFlags.flatScrubber ? centerY : centerY + Math.sin(scrubPhase) * 5;
          sCtx.lineTo(waveEnd, finalY);
          sCtx.stroke();
        }

        sCtx.beginPath();
        sCtx.roundRect(knobLeft, centerY - curKnobH / 2, curKnobW, curKnobH, curKnobR);
        sCtx.fillStyle = primaryColor;
        sCtx.fill();
      }
    }
    renderLoop(0);
  }

  function handleVisibilityChange(visible) {
    state.isWindowVisible = visible;
    // hidden or minimized: wallpaper and banner videos stop decoding
    document.querySelectorAll('#custom-wallpaper video, video.banner-video').forEach(v => {
      if (visible && !uiFlags.perf) v.play().catch(() => {});
      else v.pause();
    });
    if (!visible) {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      document.body.classList.add('app-paused');
    } else {
      document.body.classList.remove('app-paused');
      resizeCanvases();
      startVisualizers();
    }
  }

  document.addEventListener('visibilitychange', () => {
    handleVisibilityChange(!document.hidden);
  });

  if (window.electronAPI && window.electronAPI.onWindowVisibility) {
    window.electronAPI.onWindowVisibility(visible => handleVisibilityChange(visible));
  }

  function applyVisualEffects() {
    const v = state.vfx;

    if (el.coverContainer) {
      el.coverContainer.classList.toggle('vinyl-mode', !!v.vinylSpin);
      el.coverContainer.classList.toggle('spinning', !!v.vinylSpin && state.isPlaying);
    }
    document.body.classList.toggle('vfx-spotlight-on', !!v.lyricsSpotlight);
    syncVisualSettingsUI();
  }

  function syncVisualSettingsUI() {
    const v = state.vfx;
    const vfxList = [
      { id: 'vfx-pulse', key: 'bassPulse' },
      { id: 'vfx-vinyl', key: 'vinylSpin' },
      { id: 'vfx-spotlight', key: 'lyricsSpotlight' }
    ];

    vfxList.forEach(item => {
      const card = document.getElementById(`card-${item.id}`);
      const badge = document.getElementById(`badge-${item.id}`);
      const btn = document.getElementById(`toggle-${item.id}`);
      const isEnabled = v[item.key];

      if (card) card.classList.toggle('enabled', !!isEnabled);
      if (badge) badge.textContent = isEnabled ? tr('on') : tr('off');
      if (btn) {
        btn.classList.toggle('active', !!isEnabled);
        
      }
    });
  }


  function syncSettingsSlidersToState() {
    const s = state.audioSettings;
    if (el.sliderSpeed) el.sliderSpeed.value = s.speed;
    if (el.valSpeed) el.valSpeed.textContent = `${s.speed.toFixed(2)}x`;

    if (el.sliderSpeedPitch) el.sliderSpeedPitch.value = s.speedPitch;
    if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${s.speedPitch.toFixed(2)}x`;

    if (el.sliderPitch) el.sliderPitch.value = s.pitch;
    if (el.valPitch) el.valPitch.textContent = `${s.pitch > 0 ? '+' : ''}${s.pitch} st`;

    if (el.sliderReverb) el.sliderReverb.value = s.reverb;
    if (el.valReverb) el.valReverb.textContent = `${s.reverb}%`;

    if (el.sliderDistortion) el.sliderDistortion.value = s.distortion;
    if (el.valDistortion) el.valDistortion.textContent = `${s.distortion}%`;

    if (el.sliderGain) el.sliderGain.value = Math.round(s.volume * 100);
    if (el.valGain) el.valGain.textContent = `${Math.round(s.volume * 100)}%`;

    if (el.sliderEcho) el.sliderEcho.value = s.echo;
    if (el.valEcho) el.valEcho.textContent = `${s.echo}%`;
  }

  function updateNowPlayingUI(track) {
    if (el.playbarTitle) el.playbarTitle.textContent = track.title || tr('Untitled');
    if (el.playbarTitle) el.playbarTitle.dataset.origTitle = track.title || '';
    if (el.playbarArtist) el.playbarArtist.textContent = track.artist || tr('Unknown artist');

    const cover = coverOf(track);
    if (cover) {
      if (el.playbarArtwork) {
        el.playbarArtwork.src = smallThumb(cover);
        el.playbarArtwork.style.display = 'block';
      }
      if (el.artworkFallback) el.artworkFallback.style.display = 'none';
      if (el.rightPanelCover) {
        el.rightPanelCover.src = cover;
        el.rightPanelCover.style.display = 'block';
      }
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'none';
    } else {
      if (el.playbarArtwork) el.playbarArtwork.style.display = 'none';
      if (el.artworkFallback) el.artworkFallback.style.display = 'flex';
      if (el.rightPanelCover) el.rightPanelCover.style.display = 'none';
      if (el.rightPanelFallback) el.rightPanelFallback.style.display = 'flex';
    }

    if (el.rightPanelTitle) el.rightPanelTitle.textContent = track.title || tr('Untitled');
    if (el.rightPanelArtist) el.rightPanelArtist.textContent = track.artist || tr('Unknown artist');

    updateRightPanelBanner(cover);
    updateFavoriteIcon();
    applyVisualEffects();
    highlightPlayingRow();
    updateThemeFromState();
    updateMediaSession();
  }

  const VIDEO_URL_RE = /\.(mp4|webm|m4v)(?:$|[?#])/i;
  const isVideoUrl = (url) => VIDEO_URL_RE.test(url || '');

  // a banner shows either a css background image or a muted looping video
  function setBannerSource(banner, url, onError) {
    const bannerImg = banner.querySelector('.banner-image') || banner;
    let video = banner.querySelector('video.banner-video');
    if (isVideoUrl(url)) {
      bannerImg.style.backgroundImage = 'none';
      if (!video) {
        video = document.createElement('video');
        video.className = 'banner-video';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        banner.appendChild(video);
      }
      video.onerror = onError;
      if (video.getAttribute('src') !== url) video.src = url;
      if (state.isWindowVisible && !uiFlags.perf) video.play().catch(() => {});
      return;
    }
    if (video) { video.removeAttribute('src'); video.load(); video.remove(); }
    bannerImg.style.backgroundImage = url ? `url("${url}")` : 'none';
  }

  function bannerSourceFor(track, thumbUrl) {
    return (track && getTrackArt(track).banner) || localStorage.getItem('riffle_banner_media') || thumbUrl || '';
  }

  function updateRightPanelBanner(thumbUrl) {
    const banner = document.getElementById('right-panel-banner');
    if (!banner) return;
    if (!getAdv('banners', true)) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    const track = state.currentTrack;
    const source = bannerSourceFor(track, thumbUrl);
    const fail = () => {
      // a custom file that was moved or deleted falls back to the album art
      if (track && getTrackArt(track).banner) { setTrackArt(track, { banner: null }); updateRightPanelBanner(thumbUrl); }
      else banner.style.opacity = '0';
    };
    if (!source) {
      banner.classList.add('fading-out');
      setTimeout(() => {
        setBannerSource(banner, '');
        banner.style.opacity = '0';
        banner.classList.remove('fading-out');
      }, 300);
      return;
    }
    if (isVideoUrl(source)) {
      setBannerSource(banner, source, fail);
      banner.style.opacity = '1';
      return;
    }

    const img = new Image();
    img.src = source;
    img.onload = () => {
      banner.classList.add('fading-out');
      setTimeout(() => {
        setBannerSource(banner, source);
        banner.classList.remove('fading-out');
        banner.style.opacity = '1';
      }, 150);
    };
    img.onerror = fail;
  }

  function updatePlaylistDetailBanner(thumbUrl) {
    const banner = document.getElementById('playlist-header-banner');
    if (!banner) return;
    if (!getAdv('banners', true)) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    const source = localStorage.getItem('riffle_banner_media') || thumbUrl || '';
    if (!source) {
      banner.style.opacity = '0';
      setBannerSource(banner, '');
      return;
    }
    if (isVideoUrl(source)) {
      setBannerSource(banner, source, () => { banner.style.opacity = '0'; });
      banner.style.opacity = '1';
      return;
    }
    const img = new Image();
    img.src = source;
    img.onload = () => {
      setBannerSource(banner, source);
      banner.style.opacity = '1';
    };
    img.onerror = () => {
      banner.style.opacity = '0';
    };
  }

  // custom cover and banner per song, keyed like favorites so it follows the song everywhere
  let trackArtMap = null;
  function readTrackArtMap() {
    if (!trackArtMap) {
      try { trackArtMap = JSON.parse(localStorage.getItem('riffle_track_art') || '{}') || {}; } catch (e) { trackArtMap = {}; }
    }
    return trackArtMap;
  }
  const coverOf = (track) => (track && (getTrackArt(track).cover || track.thumbnail)) || '';
  function getTrackArt(track) {
    const id = track ? getTrackCanonicalId(track) : '';
    return (id && readTrackArtMap()[id]) || {};
  }
  function setTrackArt(track, patch) {
    const id = track ? getTrackCanonicalId(track) : '';
    if (!id) return;
    const all = readTrackArtMap();
    const next = Object.assign({}, all[id], patch);
    Object.keys(next).forEach(k => { if (!next[k]) delete next[k]; });
    if (Object.keys(next).length) all[id] = next; else delete all[id];
    localStorage.setItem('riffle_track_art', JSON.stringify(all));
  }

  function getTrackCanonicalId(track) {
    if (!track) return '';
    const platform = track.platform || state.platform || 'yt';
    if (track.id) return `${platform}:${track.id}`;
    if (track.url || track.videoId) return `${platform}:${track.url || track.videoId}`;
    const t = (track.title || '').trim().toLowerCase();
    const a = (track.artist || '').trim().toLowerCase();
    const d = Math.round(Number(track.duration) || 0);
    return `${platform}:${t}|${a}|${d}`;
  }

  function isSameTrack(a, b) {
    if (!a || !b) return false;
    return getTrackCanonicalId(a) === getTrackCanonicalId(b);
  }

  async function playTrack(track, queueList = null, startIndex = -1, context = null) {
    if (!track || !el.nativeAudio) return;
    initAudioContext();

    try {
      el.nativeAudio.pause();
      el.nativeAudio.removeAttribute('src');
      el.nativeAudio.load();
    } catch (e) {}

    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) {}
      hlsInstance = null;
    }

    state.isPlaying = false;
    updatePlayPauseButton(false, true);
    sendStateToServer();

    if (el.timeCurrent) el.timeCurrent.textContent = '0:00';
    scrubPrevKnobX = null;
    scrubProgress = 0;

    if (el.trackLoadingOverlay) {
      if (el.trackLoadingTitle) el.trackLoadingTitle.textContent = track.title || tr('loading track...');
      if (el.trackLoadingSub) el.trackLoadingSub.textContent = track.artist ? tr('{artist} • buffering stream', { artist: track.artist }) : tr('buffering audio stream');
      el.trackLoadingOverlay.classList.remove('hidden');
    }

    state.loadToken++;
    const currentToken = state.loadToken;

    const resumeAt = state.resumeTrack && isSameTrack(state.resumeTrack, track) ? state.resumePosition : 0;
    state.resumeTrack = null;
    state.resumePosition = 0;
    crossfade.prefetchedFor = null;
    if (!crossfade.active) audioEngine.resetDecks();

    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
    state.currentAbortController = new AbortController();
    const signal = state.currentAbortController.signal;

    state.currentTrack = track;
    state.currentTrackContext = context;
    state.currentTrackIndexInContext = startIndex;

    if (queueList) {
      state.playNextPending = 0;
      state.queue = [...queueList];
      if (startIndex >= 0 && startIndex < state.queue.length && isSameTrack(state.queue[startIndex], track)) {
        state.queueIndex = startIndex;
      } else {
        state.queueIndex = state.queue.findIndex(t => isSameTrack(t, track));
      }
      if (state.queueIndex === -1) {
        state.queue.unshift(track);
        state.queueIndex = 0;
      }
    } else if (!state.queue.some(t => isSameTrack(t, track))) {
      state.queue.push(track);
      state.queueIndex = state.queue.length - 1;
    }
    updateQueueBadge();

    state.history = state.history.filter(t => !isSameTrack(t, track));
    state.history.unshift(track);
    if (state.history.length > 100) state.history.pop();
    localStorage.setItem('devsize_history', JSON.stringify(state.history));
    if (state.currentView === 'history') renderHistoryView();

    updateNowPlayingUI(track);
    updatePlayPauseButton(false, true);

    loadSyncedLyrics(track.title, track.artist, currentToken);

    try {
      let resolvedUrl = track.url;
      let resolvedId = track.id;
      let data = null;

      const savedCopy = findSavedTrack(track);
      if (savedCopy) {
        data = { success: true, isLocal: true, streamUrl: `http://127.0.0.1:${state.serverPort}/api/saved-file?name=${encodeURIComponent(savedCopy.savedFile)}` };
      }

      const initialId = track.id || (track.url && track.url.includes('v=') ? track.url.split('v=')[1].split('&')[0] : null);
      if (!data && initialId) {
        try {
          const cacheRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(initialId)}`, { signal });
          const cacheData = await cacheRes.json();
          if (cacheData.cached && cacheData.streamUrl) {
            data = { success: true, isLocal: true, streamUrl: cacheData.streamUrl };
          }
        } catch (e) {}
      }

      if (!data && !navigator.onLine) {
        showToast(tr('Offline: this track is not available in local cache'));
        throw new Error('Offline: track not cached locally');
      }

      if (!data && track.searchQuery) {
        try {
          const searchRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(track.searchQuery)}&platform=youtube&limit=1`, { signal });
          const sData = await searchRes.json();
          if (sData.success && sData.tracks && sData.tracks[0]) {
            resolvedUrl = sData.tracks[0].url;
            resolvedId = sData.tracks[0].id;
            state.currentTrack.id = resolvedId;
            state.currentTrack.url = resolvedUrl;

            try {
              const cacheRes = await fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(resolvedId)}`, { signal });
              const cacheData = await cacheRes.json();
              if (cacheData.cached && cacheData.streamUrl) {
                data = { success: true, isLocal: true, streamUrl: cacheData.streamUrl };
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      if (!data) {
        const streamInfoUrl = `http://127.0.0.1:${state.serverPort}/api/stream-info?url=${encodeURIComponent(resolvedUrl || '')}&id=${encodeURIComponent(resolvedId || '')}&platform=${track.platform || state.platform}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&duration=${encodeURIComponent(track.duration || 0)}&thumbnail=${encodeURIComponent(track.thumbnail || '')}`;
        const res = await fetch(streamInfoUrl, { signal });
        data = await res.json();
      }

      if (currentToken !== state.loadToken) return;

      if (!data.success || !data.streamUrl) throw new Error(data.error || tr('Failed to extract audio stream'));

      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      if (data.isHls) await loadHls();
      if (currentToken !== state.loadToken) return;

      if (data.isHls && window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000 });
        hlsInstance.loadSource(data.streamUrl);
        hlsInstance.attachMedia(el.nativeAudio);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (currentToken === state.loadToken) {
            el.nativeAudio.play().catch(e => console.warn('Play error:', e));
          }
        });
      } else {
        el.nativeAudio.src = data.streamUrl;
        el.nativeAudio.load();
        el.nativeAudio.play().catch(e => console.warn('Play error:', e));
      }

      if (resumeAt > 0) {
        el.nativeAudio.addEventListener('loadedmetadata', () => {
          if (currentToken === state.loadToken && resumeAt < (el.nativeAudio.duration || 0) - 2) {
            el.nativeAudio.currentTime = resumeAt;
          }
        }, { once: true });
      }

      applyAudioSettings();
      saveSession();
      loadTrackLoudness(savedCopy ? { saved: savedCopy.savedFile } : { id: resolvedId || initialId }, currentToken);
      if (!state.isShuffle && state.queueIndex >= state.queue.length - 2) extendAutoplayQueue();
      sendMiniState(true);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (currentToken === state.loadToken) {
        console.warn('Track playback notice:', err);
        updatePlayPauseButton(false, false);
        if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
        showToast(err.message || tr('Could not load audio stream'), 'error');
      }
    }
  }

  function flipAnimate(elements, mutateFn, duration = 380) {
    const validElements = (elements || []).filter(item => item && item.getBoundingClientRect);
    const firstRects = new Map();
    validElements.forEach(item => {
      firstRects.set(item, item.getBoundingClientRect());
    });

    validElements.forEach(item => {
      item.style.transition = 'none';
      item.style.transform = 'none';
    });

    if (typeof mutateFn === 'function') {
      mutateFn();
    }

    const animatingElements = [];
    validElements.forEach(item => {
      const first = firstRects.get(item);
      const last = item.getBoundingClientRect();
      if (!first || !last) return;
      if ((first.width === 0 && first.height === 0) || (last.width === 0 && last.height === 0)) return;

      const dx = first.left - last.left;
      const dy = first.top - last.top;

      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        item.style.transform = `translate(${dx}px, ${dy}px)`;
        animatingElements.push(item);
      } else {
        item.style.transform = '';
        item.style.transition = '';
      }
    });

    if (animatingElements.length === 0) return;

    animatingElements.forEach(item => item.offsetHeight);

    requestAnimationFrame(() => {
      animatingElements.forEach(item => {
        item.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0, 1)`;
        item.style.transform = '';

        let cleaned = false;
        const cleanUp = () => {
          if (cleaned) return;
          cleaned = true;
          item.removeEventListener('transitionend', onEnd);
          item.style.transition = '';
          item.style.transform = '';
        };
        const onEnd = (e) => {
          if (e.target !== item || e.propertyName !== 'transform') return;
          cleanUp();
        };
        item.addEventListener('transitionend', onEnd);
        setTimeout(cleanUp, duration + 50);
      });
    });
  }

  function setLyricsEmpty(isEmpty) {
    const panel = el.rightPanel || document.getElementById('right-panel');
    if (!panel) return;
    const currentlyEmpty = panel.classList.contains('lyrics-empty');
    if (currentlyEmpty === !!isEmpty) return;

    const hero = el.rightPanelArtworkBox || document.getElementById('right-panel-artwork-box');

    flipAnimate([hero], () => {
      panel.classList.toggle('lyrics-empty', !!isEmpty);
    }, 380);
  }

  async function loadSyncedLyrics(title, artist, token) {
    if (el.lyricsContainer) {
      el.lyricsContainer.style.transition = 'opacity 200ms cubic-bezier(0.2, 0, 0, 1)';
      el.lyricsContainer.style.opacity = '0';
    }
    state.syncedLyrics = [];
    state.isCustomLyrics = false;

    try {
      const onlineParam = getAdv('online_lyrics', true) ? '1' : '0';
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&online=${onlineParam}`);
      const data = await res.json();

      if (token !== state.loadToken) return;

      if (!data.success || !data.lyrics) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
        return;
      }

      state.isCustomLyrics = !!data.isCustom;

      const raw = data.lyrics;
      const lines = raw.split('\n');
      const parsed = [];
      const lrcRegex = /\[(\d+):(\d+(\.\d+)?)\](.*)/;

      for (const line of lines) {
        const match = lrcRegex.exec(line);
        if (match) {
          const min = parseInt(match[1], 10);
          const sec = parseFloat(match[2]);
          const text = match[4].trim();
          if (text) {
            parsed.push({ time: min * 60 + sec, text: text });
          }
        } else if (line.trim()) {
          parsed.push({ time: -1, text: line.trim() });
        }
      }

      if (parsed.length === 0) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
        return;
      }

      state.syncedLyrics = parsed;
      const hasSyncTimes = parsed.some(p => p.time >= 0);
      if (el.lyricsStatus) el.lyricsStatus.textContent = data.isCustom ? (hasSyncTimes ? tr('Custom synced') : tr('Custom')) : (hasSyncTimes ? tr('Synced') : tr('Plain'));
      renderLyricsView();
      setLyricsEmpty(false);
      if (el.lyricsContainer) {
        el.lyricsContainer.style.opacity = '0';
        requestAnimationFrame(() => {
          el.lyricsContainer.style.transition = 'opacity 250ms cubic-bezier(0.2, 0, 0, 1)';
          el.lyricsContainer.style.opacity = '1';
        });
      }
    } catch (e) {
      if (token === state.loadToken) {
        if (el.lyricsStatus) el.lyricsStatus.textContent = '';
        if (el.lyricsContainer) {
          el.lyricsContainer.innerHTML = '';
          el.lyricsContainer.style.opacity = '1';
        }
        setLyricsEmpty(true);
      }
    }
  }

  function renderLyricsView() {
    if (!el.lyricsContainer) return;
    if (state.syncedLyrics.length === 0) return;
    el.lyricsContainer.innerHTML = '';

    state.syncedLyrics.forEach((line, index) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.id = `lyric-line-${index}`;

      if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
        const cleanText = line.text.replace(/<[^>]+>/g, '').trim();
        const words = cleanText.split(/\s+/).filter(Boolean);
        div.innerHTML = words.map((w, wIdx) => {
          const safeText = w.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<span class="lyric-word" data-word-idx="${wIdx}">${safeText}</span>`;
        }).join(' ');
      } else {
        div.textContent = line.text;
      }

      if (line.time >= 0) {
        div.addEventListener('click', () => {
          const seekTime = getLineStartTime(index);
          if (el.nativeAudio && seekTime >= 0) el.nativeAudio.currentTime = seekTime;
        });
      }
      el.lyricsContainer.appendChild(div);
    });
  }

  const CUSTOM_SHIFT_LEAD_SECONDS = 4.0;

  function getLineStartTime(idx) {
    const lines = state.syncedLyrics;
    if (idx < 0 || idx >= lines.length) return -1;
    const raw = lines[idx].time;
    if (raw < 0) return -1;
    if (!state.isCustomLyrics) return raw;
    for (let j = idx - 1; j >= 0; j--) {
      if (lines[j].time >= 0) return lines[j].time;
    }
    return Math.max(0, raw - CUSTOM_SHIFT_LEAD_SECONDS);
  }

  function getLineEndTime(idx) {
    const start = getLineStartTime(idx);
    const lines = state.syncedLyrics;
    for (let j = idx + 1; j < lines.length; j++) {
      const t = getLineStartTime(j);
      if (t >= 0) return t;
    }
    return start + 4.0;
  }

  function updateSyncedLyricsHighlight(currentTime) {
    if (state.syncedLyrics.length === 0 || !state.isWindowVisible) return;
    let activeIndex = -1;

    const validLines = [];
    for (let i = 0; i < state.syncedLyrics.length; i++) {
      const startTime = getLineStartTime(i);
      if (startTime >= 0) {
        validLines.push({ time: startTime, index: i });
      }
    }

    const lookAhead = state.isCustomLyrics ? 0.25 : 0.0;
    const matchTime = currentTime + lookAhead;

    for (let i = 0; i < validLines.length; i++) {
      const current = validLines[i];
      const next = validLines[i + 1];
      const nextTime = next ? next.time : Infinity;
      if (matchTime >= current.time && matchTime < nextTime) {
        activeIndex = current.index;
        break;
      }
    }

    if (activeIndex >= 0 && state.isPlaying) {
      const currentLineTime = getLineStartTime(activeIndex);
      const nextLineTime = getLineEndTime(activeIndex);
      const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
      const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

      const cleanText = state.syncedLyrics[activeIndex].text.replace(/<[^>]+>/g, '').trim();
      const words = cleanText.split(/\s+/).filter(Boolean);
      const totalWords = words.length;
      const currentWordIndex = totalWords > 0 ? Math.floor(progress * totalWords) : 0;
      const activeWordText = totalWords > 0 ? words[currentWordIndex] : '';

      const stateKey = `${activeIndex}-${currentWordIndex}`;
      if (state.lastBroadcastStateKey !== stateKey) {
        state.lastBroadcastStateKey = stateKey;
        sendStateToServer(activeWordText, currentWordIndex, activeIndex);
      }
    }

    document.querySelectorAll('.lyric-line').forEach((lineEl, idx) => {
      if (idx === activeIndex) {
        if (!lineEl.classList.contains('active')) {
          lineEl.classList.add('active');
          const parent = el.lyricsContainer;
          if (parent && getAdv('lyrics_autoscroll', true)) {
            const parentRect = parent.getBoundingClientRect();
            const lineRect = lineEl.getBoundingClientRect();
            const targetY = parent.scrollTop + (lineRect.top - parentRect.top) - (parentRect.height / 2) + (lineRect.height / 2);
            parent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
          }
        }

        if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
          const currentLineTime = getLineStartTime(idx);
          const nextLineTime = getLineEndTime(idx);
          const lineDur = Math.max(0.5, nextLineTime - currentLineTime);
          const progress = Math.min(Math.max((matchTime - currentLineTime) / lineDur, 0), 0.999);

          const wordSpans = lineEl.querySelectorAll('.lyric-word');
          const totalWords = wordSpans.length;
          const currentWordIndex = Math.floor(progress * totalWords);

          wordSpans.forEach((wSpan, wIdx) => {
            if (wIdx < currentWordIndex) {
              wSpan.className = 'lyric-word past-word';
            } else if (wIdx === currentWordIndex) {
              wSpan.className = 'lyric-word active-word';
            } else {
              wSpan.className = 'lyric-word';
            }
          });
        }
      } else {
        lineEl.classList.remove('active');
        if (getAdv('karaoke_words', true) && state.lyricsMode === 'word') {
          lineEl.querySelectorAll('.lyric-word').forEach(wSpan => {
            wSpan.className = idx < activeIndex ? 'lyric-word past-word' : 'lyric-word';
          });
        }
      }
    });
  }

  function updateLyricsModeButton() {
    if (!el.btnLyricsMode) return;
    const isWordEnabled = getAdv('karaoke_words', true);
    if (!isWordEnabled && state.lyricsMode === 'word') {
      state.lyricsMode = 'line';
    }
    const label = state.lyricsMode === 'word' ? tr('Word') : tr('Line');
    el.btnLyricsMode.querySelector('span').textContent = label;
  }

  if (el.btnLyricsMode) {
    updateLyricsModeButton();
    el.btnLyricsMode.addEventListener('click', () => {
      if (!getAdv('karaoke_words', true)) {
        state.lyricsMode = 'line';
        updateLyricsModeButton();
        return;
      }
      state.lyricsMode = state.lyricsMode === 'line' ? 'word' : 'line';
      updateLyricsModeButton();
      renderLyricsView();
      if (el.nativeAudio) updateSyncedLyricsHighlight(el.nativeAudio.currentTime || 0);
    });
  }

  function openCustomLyricsEditor() {
    if (!state.currentTrack) {
      showToast(tr('Play a track first to add lyrics'), 'info');
      return;
    }
    if (el.customLyricsTrackTitle) el.customLyricsTrackTitle.textContent = (state.currentTrack.title || tr('untitled'));
    if (el.customLyricsTrackArtist) el.customLyricsTrackArtist.textContent = (state.currentTrack.artist || '');

    if (state.syncedLyrics.length > 0) {
      if (el.customLyricsTextarea) el.customLyricsTextarea.value = state.syncedLyrics.map(l => l.text).join('\n');
    } else {
      if (el.customLyricsTextarea) el.customLyricsTextarea.value = '';
    }
    if (el.customLyricsModal) {
      openModal(el.customLyricsModal);
      if (el.customLyricsTextarea) setTimeout(() => el.customLyricsTextarea.focus(), 100);
    }
  }

  function closeCustomLyricsEditor() {
    if (el.customLyricsModal) closeModal(el.customLyricsModal);
  }

  async function saveCustomLyrics() {
    if (!state.currentTrack || !el.customLyricsTextarea) return;
    const text = el.customLyricsTextarea.value.trim();
    if (!text) {
      showToast(tr('Please enter some lyrics first'), 'info');
      return;
    }

    const title = state.currentTrack.title || '';
    const artist = state.currentTrack.artist || '';

    try {
      const res = await fetch(
        `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ lyrics: text })
                              }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || tr('Save failed'));

      showToast(tr('Lyrics saved successfully'), 'info');
      closeCustomLyricsEditor();
      loadSyncedLyrics(title, artist, state.loadToken);
    } catch (e) {
      showToast(tr('Failed to save lyrics: {error}', { error: e.message }), 'error');
    }
  }

  if (el.btnAddCustomLyrics) el.btnAddCustomLyrics.addEventListener('click', openCustomLyricsEditor);
  if (el.btnCloseCustomLyrics) el.btnCloseCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnCancelCustomLyrics) el.btnCancelCustomLyrics.addEventListener('click', closeCustomLyricsEditor);
  if (el.btnSaveCustomLyrics) el.btnSaveCustomLyrics.addEventListener('click', saveCustomLyrics);

  if (el.customLyricsModal) {
    el.customLyricsModal.addEventListener('click', (e) => {
      if (e.target === el.customLyricsModal) closeCustomLyricsEditor();
    });
  }

  let syncState = {
    active: false,
    lines: [],
    currentIndex: 0
  };

  function openSyncMode() {
    if (!state.currentTrack) {
      showToast(tr('Play a track first to sync lyrics'), 'info');
      return;
    }

    if (state.syncedLyrics.length === 0) {
      showToast(tr('Add lyrics first using the edit button, then sync them'), 'info');
      return;
    }

    syncState.active = true;
    syncState.lines = state.syncedLyrics.map(l => ({ text: l.text, time: null }));
    syncState.currentIndex = 0;

    renderSyncLines();
    if (el.syncModeOverlay) openModal(el.syncModeOverlay);

    if (el.nativeAudio && el.nativeAudio.paused && state.currentTrack) {
      el.nativeAudio.play().catch(() => {});
    }

    showToast(tr('Press play, then click or tap each line when you hear it'), 'info');
  }

  function updateSyncProgress() {
    const synced = syncState.lines.filter(l => l.time !== null).length;
    const total = syncState.lines.length;
    if (el.syncProgressText) el.syncProgressText.textContent = tr('{synced} / {total} lines synced', { synced, total });
  }

  function renderSyncLines() {
    if (!el.syncModeLyrics) return;
    el.syncModeLyrics.innerHTML = '';
    syncState.lines.forEach((line, idx) => {
      const div = document.createElement('div');
      div.className = 'sync-line';
      div.textContent = line.text;

      if (line.time !== null) {
        div.classList.add('synced');
        const min = Math.floor(line.time / 60);
        const sec = (line.time % 60).toFixed(2);
        div.setAttribute('data-time', `[${min}:${sec.padStart(5, '0')}]`);
      }

      if (idx === syncState.currentIndex && line.time === null) {
        div.classList.add('next-line');
      }

      div.addEventListener('click', () => handleSyncLineClick(idx));
      el.syncModeLyrics.appendChild(div);
    });

    updateSyncProgress();

    const nextEl = el.syncModeLyrics.querySelector('.next-line');
    if (nextEl) {
      nextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function handleSyncLineClick(idx) {
    if (!syncState.active || !el.nativeAudio) return;

    const currentTime = el.nativeAudio.currentTime || 0;
    syncState.lines[idx].time = currentTime;

    let next = -1;
    for (let i = idx + 1; i < syncState.lines.length; i++) {
      if (syncState.lines[i].time === null) {
        next = i;
        break;
      }
    }
    syncState.currentIndex = next >= 0 ? next : syncState.lines.length;

    renderSyncLines();
  }

  function restartSync() {
    syncState.lines.forEach(l => l.time = null);
    syncState.currentIndex = 0;
    if (el.nativeAudio) el.nativeAudio.currentTime = 0;
    renderSyncLines();
    showToast(tr('Sync restarted'), 'info');
  }

  async function saveSyncAndExit() {
    if (!state.currentTrack) return;

    const lrcLines = syncState.lines.map(line => {
      if (line.time !== null) {
        const min = Math.floor(line.time / 60);
        const sec = (line.time % 60).toFixed(2);
        return `[${min}:${sec.padStart(5, '0')}]${line.text}`;
      }
      return line.text;
    });
    const lrcContent = lrcLines.join('\n');

    const title = state.currentTrack.title || '';
    const artist = state.currentTrack.artist || '';

    try {
      const res = await fetch(
        `http://127.0.0.1:${state.serverPort}/api/save-custom-lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ lyrics: lrcContent })
                              }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || tr('Save failed'));

      showToast(tr('Synced lyrics saved'), 'info');
      closeSyncMode();
      loadSyncedLyrics(title, artist, state.loadToken);
    } catch (e) {
      showToast(tr('Failed to save synced lyrics: {error}', { error: e.message }), 'error');
    }
  }

  function closeSyncMode() {
    syncState.active = false;
    if (el.syncModeOverlay) closeModal(el.syncModeOverlay);
  }

  if (el.btnSyncLyrics) el.btnSyncLyrics.addEventListener('click', openSyncMode);
  if (el.btnRestartSync) el.btnRestartSync.addEventListener('click', restartSync);
  if (el.btnSaveSync) el.btnSaveSync.addEventListener('click', saveSyncAndExit);
  if (el.btnCancelSync) el.btnCancelSync.addEventListener('click', closeSyncMode);

  if (el.syncModeOverlay) {
    el.syncModeOverlay.addEventListener('click', (e) => {
      if (e.target === el.syncModeOverlay) closeSyncMode();
    });
  }

  function togglePlayPause() {
    if (!state.currentTrack) {
      if (state.queue.length > 0) playTrack(state.queue[0]);
      return;
    }

    if (el.nativeAudio && !el.nativeAudio.getAttribute('src') && !hlsInstance) {
      playTrack(state.currentTrack, state.queue, state.queueIndex);
      return;
    }

    if (el.nativeAudio && el.nativeAudio.paused) {
      initAudioContext();
      if (audioEngine) audioEngine._applyMasterVolume();
      el.nativeAudio.play().catch(() => {});
    } else if (el.nativeAudio) {
      el.nativeAudio.pause();
    }
  }

  function playNext() {
    if (state.queue.length === 0) return;
    if (state.playNextPending > 0 && state.queueIndex + 1 < state.queue.length) {
      state.playNextPending--;
      state.queueIndex++;
      playTrack(state.queue[state.queueIndex]);
      return;
    }
    if (state.isShuffle) {
      const nextIdx = Math.floor(Math.random() * state.queue.length);
      state.queueIndex = nextIdx;
      playTrack(state.queue[nextIdx]);
      return;
    }

    let nextIdx = state.queueIndex + 1;
    if (nextIdx >= state.queue.length) {
      if (state.myWaveActive && typeof extendMyWaveQueue === 'function') {
        extendMyWaveQueue().then(added => {
          if (added && state.queueIndex + 1 < state.queue.length) {
            playNext();
          }
        });
        return;
      }
      if (state.autoplayEnabled) {
        const lastIdx = state.queueIndex;
        extendAutoplayQueue({ announce: true }).then(added => {
          state.queueIndex = added ? lastIdx + 1 : 0;
          playTrack(state.queue[state.queueIndex]);
        });
        return;
      }
      nextIdx = 0;
    }
    state.queueIndex = nextIdx;
    playTrack(state.queue[nextIdx]);

    if (state.myWaveActive && state.queueIndex >= state.queue.length - 3 && typeof extendMyWaveQueue === 'function') {
      extendMyWaveQueue();
    }
  }

  function playPrev() {
    if (el.nativeAudio && el.nativeAudio.currentTime > 3) {
      el.nativeAudio.currentTime = 0;
      return;
    }
    if (state.queue.length === 0) return;
    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = state.queue.length - 1;
    state.queueIndex = prevIdx;
    playTrack(state.queue[prevIdx]);
  }

  if (el.nativeAudio) {
    el.nativeAudio.addEventListener('waiting', () => {
      updatePlayPauseButton(state.isPlaying, true);
    });

    el.nativeAudio.addEventListener('playing', () => {
      updatePlayPauseButton(state.isPlaying, false);
      if (crossfade.pendingFadeIn) {
        audioEngine.fadeInMain(crossfade.pendingFadeIn);
        crossfade.pendingFadeIn = 0;
        crossfade.swapping = false;
      } else if (!crossfade.active) {
        audioEngine.resetDecks();
      }
    });

    el.nativeAudio.addEventListener('canplay', () => {
      updatePlayPauseButton(state.isPlaying, false);
    });

    el.nativeAudio.addEventListener('play', () => {
      if (el.trackLoadingOverlay) el.trackLoadingOverlay.classList.add('hidden');
      state.isPlaying = true;
      document.body.classList.add('is-playing');
      updatePlayPauseButton(true, false);
      if (el.coverContainer && state.vfx.vinylSpin) el.coverContainer.classList.add('spinning');
      if (audioEngine) audioEngine._applyMasterVolume();
      sendDiscordRpcUpdate(state.currentTrack, true);
      sendStateToServer();
    });

    el.nativeAudio.addEventListener('pause', () => {
      state.isPlaying = false;
      document.body.classList.remove('is-playing');
      updatePlayPauseButton(false, false);
      if (el.coverContainer) el.coverContainer.classList.remove('spinning');
      sendDiscordRpcUpdate(null, false);
      sendStateToServer();
      // a pause mid-crossfade (not the track swap itself) drops the tail
      if (crossfade.active && !crossfade.swapping) stopCrossfade();
      saveSession();
      sendTrayState();
    });

    el.nativeAudio.addEventListener('ended', () => {
      if (state.isRepeat) {
        el.nativeAudio.currentTime = 0;
        el.nativeAudio.play().catch(() => {});
      } else {
        setTimeout(() => playNext(), 100);
      }
    });

    el.nativeAudio.addEventListener('play', () => { sendTrayState(); sendMiniState(true); });
    el.nativeAudio.addEventListener('pause', () => sendMiniState(true));
    el.nativeAudio.addEventListener('timeupdate', () => sendMiniState());

    el.nativeAudio.addEventListener('timeupdate', () => {
      maybeStartCrossfade();
      const now = Date.now();
      if (now - lastSessionSave > 5000) {
        lastSessionSave = now;
        saveSession();
      }
    });

    el.nativeAudio.addEventListener('timeupdate', () => {
      const cur = el.nativeAudio.currentTime || 0;
      const dur = el.nativeAudio.duration || (state.currentTrack ? state.currentTrack.duration : 0);

      updateSyncedLyricsHighlight(cur);

      if (isDraggingScrubber) return;
      if (!state.isPlaying) hasDrawnPausedFrame = false;
      if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(cur);
      if (el.timeDuration) el.timeDuration.textContent = formatDuration(dur);
    });
  }

  let isDraggingScrubber = false;

  function updateScrubberPositionFromEvent(e) {
    if (!el.scrubberTrack) return 0;
    const rect = el.scrubberTrack.getBoundingClientRect();
    const padLeft = 5.5;
    const trackWidth = rect.width - 2 * padLeft;
    let pos = trackWidth > 0 ? (e.clientX - rect.left - padLeft) / trackWidth : 0;
    pos = Math.max(0, Math.min(1, pos));
    const dur = (el.nativeAudio && el.nativeAudio.duration) ? el.nativeAudio.duration : (state.currentTrack ? state.currentTrack.duration : 0);
    const targetTime = pos * dur;

    state.scrubberDragTargetTime = targetTime;
    if (el.timeCurrent) el.timeCurrent.textContent = formatDuration(targetTime);
    return targetTime;
  }

  if (el.scrubberTrack) {
    el.scrubberTrack.addEventListener('mousedown', (e) => {
      isDraggingScrubber = true;
      el.scrubberTrack.classList.add('dragging');
      updateScrubberPositionFromEvent(e);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingScrubber) return;
    updateScrubberPositionFromEvent(e);
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDraggingScrubber) return;
    isDraggingScrubber = false;
    if (el.scrubberTrack) el.scrubberTrack.classList.remove('dragging');
    const targetTime = updateScrubberPositionFromEvent(e);
    if (!isNaN(targetTime) && el.nativeAudio) {
      el.nativeAudio.currentTime = targetTime;
    }
    state.scrubberDragTargetTime = undefined;
  });

  function getAllPresets() {
    return [...defaultPresets, ...state.customPresets];
  }

  function renderPresets() {
    if (!el.presetsContainer) return;
    el.presetsContainer.innerHTML = '';
    const all = getAllPresets();
    all.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'preset-chip';
      if (state.activePresetId === p.id) chip.classList.add('active');

      const isCustom = p.id.startsWith('custom_');
      chip.dataset.isCustom = isCustom ? 'true' : 'false';
      chip.dataset.presetId = p.id;

      chip.innerHTML = `
      <span class="preset-name-label">${isCustom ? p.name : tr(p.name)}</span>
      ${isCustom ? `
        <div class="preset-actions">
          <button type="button" class="preset-btn-action btn-rename-p" title="${tr('Rename')}" aria-label="${tr('Rename preset')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <button type="button" class="preset-btn-action btn-delete-p" title="${tr('Delete')}" aria-label="${tr('Delete preset')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>` : ''}
        `;

        if (isCustom) {
          const btnRename = chip.querySelector('.btn-rename-p');
          const btnDelete = chip.querySelector('.btn-delete-p');
          if (btnRename) {
            btnRename.addEventListener('click', (e) => {
              e.stopPropagation();
              openRenamePresetModal(p);
            });
          }
          if (btnDelete) {
            btnDelete.addEventListener('click', (e) => {
              e.stopPropagation();
              openDeletePresetConfirm(p);
            });
          }
        }

        chip.addEventListener('click', (e) => {
          if (e.target.closest('.btn-delete-p') || e.target.closest('.btn-rename-p')) return;
          applyPreset(p);
        });

        el.presetsContainer.appendChild(chip);
    });
  }

  function applyPreset(preset) {
    const normalized = normalizePreset(preset);
    if (!normalized) return;
    state.activePresetId = normalized.id;
    state.audioSettings = { ...normalized.settings };
    initAudioContext();
    syncSettingsSlidersToState();
    applyAudioSettings();
    renderPresets();
  }

  function saveCustomPreset(name) {
    if (!name || !name.trim()) return;
    const newPreset = {
      id: 'custom_' + Date.now(),
                          name: name.trim(),
                          settings: { ...state.audioSettings }
    };
    state.customPresets.push(newPreset);
    state.activePresetId = newPreset.id;
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    renderPresets();
  }

  function openRenamePresetModal(preset) {
    state.presetToRenameId = preset.id;
    if (el.renamePresetName) el.renamePresetName.value = preset.name;
    if (el.renamePresetModal) openModal(el.renamePresetModal);
    if (el.renamePresetName) el.renamePresetName.focus();
  }

  function renameCustomPreset(id, newName) {
    if (!newName || !newName.trim()) return;
    const p = state.customPresets.find(x => x.id === id);
    if (p) {
      p.name = newName.trim();
      localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
      renderPresets();
    }
  }

  function deleteCustomPreset(id) {
    state.customPresets = state.customPresets.filter(p => p.id !== id);
    if (state.activePresetId === id) state.activePresetId = 'p_default';
    localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    renderPresets();
  }

  function openDeletePresetConfirm(preset) {
    state.presetToDeleteId = preset.id;
    const msg = document.getElementById('delete-preset-msg');
    if (msg) msg.textContent = tr('Delete preset "{name}"?', { name: preset.name });
    const modal = document.getElementById('delete-preset-modal');
    if (modal) openModal(modal);
  }

  let searchDebounceTimer = null;
  async function performSearch(query) {
    if (!query || !query.trim()) {
      if (el.discoverEmpty) el.discoverEmpty.classList.remove('hidden');
      if (el.searchResultsContainer) el.searchResultsContainer.classList.add('hidden');
      return;
    }

    // links (spotify/tiktok) carry case-sensitive ids
    state.searchQuery = /^https?:\/\//i.test(query.trim()) ? query.trim() : query.trim().toLowerCase();
    switchView('discover');

    if (el.discoverEmpty) el.discoverEmpty.classList.add('hidden');
    if (el.searchResultsContainer) el.searchResultsContainer.classList.remove('hidden');
    if (el.resultsTitle) el.resultsTitle.textContent = tr('Results for "{query}"', { query: state.searchQuery });
    if (el.resultsPlatformBadge) el.resultsPlatformBadge.textContent = state.platform;
    if (el.resultsCount) el.resultsCount.textContent = tr('Searching...');

    if (el.searchTracksList) {
      el.searchTracksList.innerHTML = `<div class="m3-loader-container" style="display: flex; justify-content: center; align-items: center; padding: 64px 0; width: 100%;">
        <svg width="64" height="64" viewBox="0 0 100 100">
          <style>
            .m3-spinner-wave {
              fill: none;
              stroke: var(--md-sys-color-primary, #6750A4);
              stroke-width: 4;
              stroke-linecap: round;
              stroke-linejoin: round;
              transform-origin: 50px 50px;
              animation: m3-spin 3s linear infinite;
            }
            .m3-spinner-cookie {
              fill: var(--md-sys-color-primary, #6750A4);
              transform-origin: 50px 50px;
              animation: m3-pulse-spin 2s ease-in-out infinite alternate;
            }
            @keyframes m3-spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            @keyframes m3-pulse-spin {
              0% { transform: scale(0.8) rotate(0deg); opacity: 0.7; }
              100% { transform: scale(1.1) rotate(120deg); opacity: 1; }
            }
          </style>
          <path class="m3-spinner-cookie" d="M 90.00 50.00 L 89.95 50.70 L 89.78 51.39 L 89.51 52.07 L 89.14 52.74 L 88.68 53.38 L 88.14 54.01 L 87.51 54.61 L 86.83 55.18 L 86.10 55.72 L 85.32 56.23 L 84.53 56.71 L 83.72 57.17 L 82.92 57.60 L 82.14 58.01 L 81.39 58.41 L 80.69 58.80 L 80.03 59.18 L 79.44 59.57 L 78.92 59.96 L 78.47 60.36 L 78.11 60.79 L 77.83 61.24 L 77.63 61.73 L 77.51 62.25 L 77.46 62.81 L 77.49 63.41 L 77.58 64.05 L 77.73 64.74 L 77.92 65.48 L 78.15 66.25 L 78.40 67.06 L 78.66 67.91 L 78.92 68.78 L 79.16 69.67 L 79.38 70.57 L 79.57 71.48 L 79.70 72.38 L 79.78 73.27 L 79.80 74.13 L 79.75 74.96 L 79.61 75.74 L 79.40 76.48 L 79.11 77.15 L 78.74 77.75 L 78.28 78.28 L 77.75 78.74 L 77.15 79.11 L 76.48 79.40 L 75.74 79.61 L 74.96 79.75 L 74.13 79.80 L 73.27 79.78 L 72.38 79.70 L 71.48 79.57 L 70.57 79.38 L 69.67 79.16 L 68.78 78.92 L 67.91 78.66 L 67.06 78.40 L 66.25 78.15 L 65.48 77.92 L 64.74 77.73 L 64.05 77.58 L 63.41 77.49 L 62.81 77.46 L 62.25 77.51 L 61.73 77.63 L 61.24 77.83 L 60.79 78.11 L 60.36 78.47 L 59.96 78.92 L 59.57 79.44 L 59.18 80.03 L 58.80 80.69 L 58.41 81.39 L 58.01 82.14 L 57.60 82.92 L 57.17 83.72 L 56.71 84.53 L 56.23 85.32 L 55.72 86.10 L 55.18 86.83 L 54.61 87.51 L 54.01 88.14 L 53.38 88.68 L 52.74 89.14 L 52.07 89.51 L 51.39 89.78 L 50.70 89.95 L 50.00 90.00 L 49.30 89.95 L 48.61 89.78 L 47.93 89.51 L 47.26 89.14 L 46.62 88.68 L 45.99 88.14 L 45.39 87.51 L 44.82 86.83 L 44.28 86.10 L 43.77 85.32 L 43.29 84.53 L 42.83 83.72 L 42.40 82.92 L 41.99 82.14 L 41.59 81.39 L 41.20 80.69 L 40.82 80.03 L 40.43 79.44 L 40.04 78.92 L 39.64 78.47 L 39.21 78.11 L 38.76 77.83 L 38.27 77.63 L 37.75 77.51 L 37.19 77.46 L 36.59 77.49 L 35.95 77.58 L 35.26 77.73 L 34.52 77.92 L 33.75 78.15 L 32.94 78.40 L 32.09 78.66 L 31.22 78.92 L 30.33 79.16 L 29.43 79.38 L 28.52 79.57 L 27.62 79.70 L 26.73 79.78 L 25.87 79.80 L 25.04 79.75 L 24.26 79.61 L 23.52 79.40 L 22.85 79.11 L 22.25 78.74 L 21.72 78.28 L 21.26 77.75 L 20.89 77.15 L 20.60 76.48 L 20.39 75.74 L 20.25 74.96 L 20.20 74.13 L 20.22 73.27 L 20.30 72.38 L 20.43 71.48 L 20.62 70.57 L 20.84 69.67 L 21.08 68.78 L 21.34 67.91 L 21.60 67.06 L 21.85 66.25 L 22.08 65.48 L 22.27 64.74 L 22.42 64.05 L 22.51 63.41 L 22.54 62.81 L 22.49 62.25 L 22.37 61.73 L 22.17 61.24 L 21.89 60.79 L 21.53 60.36 L 21.08 59.96 L 20.56 59.57 L 19.97 59.18 L 19.31 58.80 L 18.61 58.41 L 17.86 58.01 L 17.08 57.60 L 16.28 57.17 L 15.47 56.71 L 14.68 56.23 L 13.90 55.72 L 13.17 55.18 L 12.49 54.61 L 11.86 54.01 L 11.32 53.38 L 10.86 52.74 L 10.49 52.07 L 10.22 51.39 L 10.05 50.70 L 10.00 50.00 L 10.05 49.30 L 10.22 48.61 L 10.49 47.93 L 10.86 47.26 L 11.32 46.62 L 11.86 45.99 L 12.49 45.39 L 13.17 44.82 L 13.90 44.28 L 14.68 43.77 L 15.47 43.29 L 16.28 42.83 L 17.08 42.40 L 17.86 41.99 L 18.61 41.59 L 19.31 41.20 L 19.97 40.82 L 20.56 40.43 L 21.08 40.04 L 21.53 39.64 L 21.89 39.21 L 22.17 38.76 L 22.37 38.27 L 22.49 37.75 L 22.54 37.19 L 22.51 36.59 L 22.42 35.95 L 22.27 35.26 L 22.08 34.52 L 21.85 33.75 L 21.60 32.94 L 21.34 32.09 L 21.08 31.22 L 20.84 30.33 L 20.62 29.43 L 20.43 28.52 L 20.30 27.62 L 20.22 26.73 L 20.20 25.87 L 20.25 25.04 L 20.39 24.26 L 20.60 23.52 L 20.89 22.85 L 21.26 22.25 L 21.72 21.72 L 22.25 21.26 L 22.85 20.89 L 23.52 20.60 L 24.26 20.39 L 25.04 20.25 L 25.87 20.20 L 26.73 20.22 L 27.62 20.30 L 28.52 20.43 L 29.43 20.62 L 30.33 20.84 L 31.22 21.08 L 32.09 21.34 L 32.94 21.60 L 33.75 21.85 L 34.52 22.08 L 35.26 22.27 L 35.95 22.42 L 36.59 22.51 L 37.19 22.54 L 37.75 22.49 L 38.27 22.37 L 38.76 22.17 L 39.21 21.89 L 39.64 21.53 L 40.04 21.08 L 40.43 20.56 L 40.82 19.97 L 41.20 19.31 L 41.59 18.61 L 41.99 17.86 L 42.40 17.08 L 42.83 16.28 L 43.29 15.47 L 43.77 14.68 L 44.28 13.90 L 44.82 13.17 L 45.39 12.49 L 45.99 11.86 L 46.62 11.32 L 47.26 10.86 L 47.93 10.49 L 48.61 10.22 L 49.30 10.05 L 50.00 10.00 L 50.70 10.05 L 51.39 10.22 L 52.07 10.49 L 52.74 10.86 L 53.38 11.32 L 54.01 11.86 L 54.61 12.49 L 55.18 13.17 L 55.72 13.90 L 56.23 14.68 L 56.71 15.47 L 57.17 16.28 L 57.60 17.08 L 58.01 17.86 L 58.41 18.61 L 58.80 19.31 L 59.18 19.97 L 59.57 20.56 L 59.96 21.08 L 60.36 21.53 L 60.79 21.89 L 61.24 22.17 L 61.73 22.37 L 62.25 22.49 L 62.81 22.54 L 63.41 22.51 L 64.05 22.42 L 64.74 22.27 L 65.48 22.08 L 66.25 21.85 L 67.06 21.60 L 67.91 21.34 L 68.78 21.08 L 69.67 20.84 L 70.57 20.62 L 71.48 20.43 L 72.38 20.30 L 73.27 20.22 L 74.13 20.20 L 74.96 20.25 L 75.74 20.39 L 76.48 20.60 L 77.15 20.89 L 77.75 21.26 L 78.28 21.72 L 78.74 22.25 L 79.11 22.85 L 79.40 23.52 L 79.61 24.26 L 79.75 25.04 L 79.80 25.87 L 79.78 26.73 L 79.70 27.62 L 79.57 28.52 L 79.38 29.43 L 79.16 30.33 L 78.92 31.22 L 78.66 32.09 L 78.40 32.94 L 78.15 33.75 L 77.92 34.52 L 77.73 35.26 L 77.58 35.95 L 77.49 36.59 L 77.46 37.19 L 77.51 37.75 L 77.63 38.27 L 77.83 38.76 L 78.11 39.21 L 78.47 39.64 L 78.92 40.04 L 79.44 40.43 L 80.03 40.82 L 80.69 41.20 L 81.39 41.59 L 82.14 41.99 L 82.92 42.40 L 83.72 42.83 L 84.53 43.29 L 85.32 43.77 L 86.10 44.28 L 86.83 44.82 L 87.51 45.39 L 88.14 45.99 L 88.68 46.62 L 89.14 47.26 L 89.51 47.93 L 89.78 48.61 L 89.95 49.30 L 90.00 50.00 Z" />
        </svg>
      </div>`;
    }

    try {
      if (!navigator.onLine) {
        if (el.searchTracksList) el.searchTracksList.innerHTML = `<div class="empty-hint">${tr('Offline: connect to the internet to search new tracks')}</div>`;
        if (el.resultsCount) el.resultsCount.textContent = tr('offline');
        return;
      }
      const searchUrl = `http://127.0.0.1:${state.serverPort}/api/search?q=${encodeURIComponent(state.searchQuery)}&platform=${state.platform}&limit=20`;
      const res = await fetch(searchUrl);
      const data = await res.json();

      if (!data.success || !data.tracks) throw new Error(data.error || tr('Failed to load search results'));

      state.searchResults = data.tracks;
      if (el.resultsCount) el.resultsCount.textContent = trn(data.tracks.length, '{n} track found', '{n} tracks found');
      if (el.resultsPlatformBadge && data.source === 'deezer') el.resultsPlatformBadge.textContent = tr('spotify · deezer catalog');

      requestAnimationFrame(() => {
        if (el.searchTracksList) renderTracks(el.searchTracksList, data.tracks, 'search');
      });
    } catch (err) {
      console.error('Search error:', err);
      const isOff = !navigator.onLine;
      if (el.searchTracksList) el.searchTracksList.innerHTML = `<div class="empty-hint">${isOff ? tr('Offline: connect to the internet to search new tracks') : tr('Error fetching results: {error}', { error: err.message })}</div>`;
      if (el.resultsCount) el.resultsCount.textContent = isOff ? tr('offline') : tr('error');
    }
  }


  function createTrackRow(track, idx, currentCanonicalId, context, tracks, container) {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.tabIndex = 0;
      const canonicalId = getTrackCanonicalId(track);
      row.dataset.canonicalId = canonicalId;
      row.dataset.trackIndex = String(idx);
      row.dataset.trackId = track.id || '';
      row.dataset.trackTitle = track.title || '';
      row.dataset.trackArtist = track.artist || '';

      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });

      const isMatch = currentCanonicalId && canonicalId === currentCanonicalId;
      if (isMatch) {
        if (state.currentTrackContext === context && state.currentTrackIndexInContext >= 0) {
          if (state.currentTrackIndexInContext === idx) {
            row.classList.add('playing');
          }
        } else {
          row.classList.add('playing');
        }
      }

      const isFav = state.favorites.some(f => isSameTrack(f, track));

      row.innerHTML = `
      <span class="track-row-index">${idx + 1}</span>
      <img class="track-row-thumb" src="${smallThumb(coverOf(track))}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">
      <div class="track-row-info">
      <span class="track-row-title">${(track.title || 'untitled')}</span>
      <span class="track-row-artist" title="${tr('view artist profile')}">${(track.artist || tr('unknown artist'))}</span>
      </div>
      <span class="track-row-duration">${formatDuration(track.duration)}</span>
      <div class="track-row-actions">
      <button class="btn-icon-pill btn-row-fav" title="${tr('favorite')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>
      </button>
      <button class="btn-icon-pill btn-row-play-next" title="${tr('play next')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="4 5 12 12 4 19 4 5" fill="currentColor"></polygon><line x1="15" y1="7" x2="21" y2="7"></line><line x1="15" y1="12" x2="21" y2="12"></line><line x1="15" y1="17" x2="21" y2="17"></line></svg>
      </button>
      <button class="btn-icon-pill btn-row-add-playlist" title="${tr('add to playlist')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <button class="btn-icon-pill btn-row-more" title="${tr('download & options')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle><circle cx="5" cy="12" r="2"></circle></svg>
      </button>
      ${context === 'saved' ? `
        <button class="btn-icon-pill btn-row-remove-saved delete-btn" title="${tr('delete saved file')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>
        </button>` : ''}
      ${context === 'playlist' ? `
        <button class="btn-icon-pill btn-row-remove-playlist delete-btn" title="${tr('remove from playlist')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>` : ''}
        </div>
        `;

        row.addEventListener('mouseenter', () => {
          if (track.url && context !== 'saved') {
            fetch(`http://127.0.0.1:${state.serverPort}/api/prefetch?url=${encodeURIComponent(track.url)}&id=${encodeURIComponent(track.id)}&platform=${track.platform || state.platform}`).catch(() => {});
          }
        });

        row.addEventListener('click', (e) => {
          if (e.target.closest('.track-row-actions')) return;
          if (e.target.classList.contains('track-row-artist')) {
            e.stopPropagation();
            openArtistProfile(track.artist);
            return;
          }
          let clickIndex = idx;
          let currentList = tracks;
          if (context === 'favorites') {
            currentList = state.favorites;
            clickIndex = state.favorites.findIndex(t => isSameTrack(t, track));
          } else if (context === 'playlist') {
            const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
            if (pl && pl.tracks) {
              currentList = pl.tracks;
              clickIndex = pl.tracks.findIndex(t => isSameTrack(t, track));
            }
          } else if (row.parentElement) {
            const rows = Array.from(row.parentElement.querySelectorAll('.track-row'));
            const domPos = rows.indexOf(row);
            // rows are virtualized: DOM position is relative to the first rendered row
            if (domPos !== -1) clickIndex = domPos + Math.max(0, row.parentElement._lastStartIndex || 0);
            // the queue can be reordered in place; always play from the live array
            if (context === 'queue') currentList = state.queue;
          }
          if (context === 'search' && el.searchInput) rememberSearch(el.searchInput.value);
          playTrack(track, currentList, clickIndex >= 0 ? clickIndex : idx, context);
        });

        const btnFav = row.querySelector('.btn-row-fav');
        if (btnFav) {
          btnFav.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavoriteTrack(track);
            const isFavNow = state.favorites.some(f => isSameTrack(f, track));
            const svg = btnFav.querySelector('svg');
            if (svg) svg.setAttribute('fill', isFavNow ? 'currentColor' : 'none');
          });
        }

        const btnMore = row.querySelector('.btn-row-more');
        if (btnMore) {
          btnMore.addEventListener('click', (e) => {
            e.stopPropagation();
            openDownloadModal(track);
          });
        }

        const btnAddPl = row.querySelector('.btn-row-add-playlist');
        if (btnAddPl) {
          btnAddPl.addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track);
          });
        }

        const btnPlayNext = row.querySelector('.btn-row-play-next');
        if (btnPlayNext) {
          btnPlayNext.addEventListener('click', (e) => {
            e.stopPropagation();
            queuePlayNext(track);
          });
        }

        const btnRemSaved = row.querySelector('.btn-row-remove-saved');
        if (btnRemSaved) {
          btnRemSaved.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSavedTrack(track);
          });
        }

        const btnRemPl = row.querySelector('.btn-row-remove-playlist');
        if (btnRemPl) {
          btnRemPl.addEventListener('click', (e) => {
            e.stopPropagation();
            removeTrackFromCurrentPlaylist(track.id);
          });
        }
        
      return row;
  }

  function renderTracks(container, tracks, context = 'search') {
    if (!container) return;
    
    const scrollParent = document.querySelector('.main-content');
    if (container._vScrollHandler && scrollParent) {
      scrollParent.removeEventListener('scroll', container._vScrollHandler);
    }
    
    container.innerHTML = '';
    
    if (!tracks || tracks.length === 0) {
      container.style.paddingTop = '0px';
      container.style.paddingBottom = '0px';
      container.innerHTML = `<div class="empty-hint">${tr('no tracks found.')}</div>`;
      return;
    }

    const itemHeight = 68;
    const overscan = 15;
    
    function renderChunk() {
      if (!scrollParent || container._isDraggingReorder) return;
      const parentRect = scrollParent.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const relativeTop = containerRect.top - parentRect.top + scrollParent.scrollTop;
      
      const visibleTop = Math.max(0, scrollParent.scrollTop - relativeTop);
      let startIndex = Math.floor(visibleTop / itemHeight) - overscan;
      let endIndex = Math.ceil((visibleTop + scrollParent.clientHeight) / itemHeight) + overscan;
      
      startIndex = Math.floor(startIndex / 5) * 5;
      endIndex = Math.ceil(endIndex / 5) * 5;
      
      startIndex = Math.max(0, startIndex);
      endIndex = Math.min(tracks.length, endIndex);
      
      if (container._lastStartIndex === startIndex && container._lastEndIndex === endIndex) return;
      container._lastStartIndex = startIndex;
      container._lastEndIndex = endIndex;
      
      const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
      const fragment = document.createDocumentFragment();
      for (let idx = startIndex; idx < endIndex; idx++) {
         const track = tracks[idx];
         const row = createTrackRow(track, idx, currentCanonicalId, context, tracks, container);
         if (container._hasInitialRendered) row.style.animation = 'none';
         fragment.appendChild(row);
      }
      
      container.innerHTML = '';
      container.style.paddingTop = `${startIndex * itemHeight}px`;
      container.style.paddingBottom = `${(tracks.length - endIndex) * itemHeight}px`;
      container.appendChild(fragment);
      container._hasInitialRendered = true;
      highlightPlayingRow();
    }
    
    container._vScrollHandler = () => {
      if (!container._ticking) {
        window.requestAnimationFrame(() => {
          renderChunk();
          container._ticking = false;
        });
        container._ticking = true;
      }
    };
    
    if (scrollParent) {
       scrollParent.addEventListener('scroll', container._vScrollHandler, { passive: true });
    }
    
    container._hasInitialRendered = false;
    container._lastStartIndex = -1;
    container._lastEndIndex = -1;
    renderChunk();
  }

  function highlightPlayingRow() {
    const currentCanonicalId = state.currentTrack ? getTrackCanonicalId(state.currentTrack) : '';
    const rows = document.querySelectorAll('.track-row');

    if (!currentCanonicalId) {
      rows.forEach(r => r.classList.remove('playing'));
      return;
    }

    const containers = new Set();
    rows.forEach(r => {
      r.classList.remove('playing');
      if (r.parentElement) containers.add(r.parentElement);
    });

    containers.forEach(container => {
      const matches = Array.from(container.querySelectorAll('.track-row')).filter(r => r.dataset.canonicalId === currentCanonicalId);
      if (matches.length === 1) {
        matches[0].classList.add('playing');
      } else if (matches.length > 1) {
        const targetIdx = String(state.currentTrackIndexInContext);
        const exact = matches.find(r => r.dataset.trackIndex === targetIdx);
        if (exact) {
          exact.classList.add('playing');
        } else {
          matches[0].classList.add('playing');
        }
      }
    });
  }

  async function openArtistProfile(artistName) {
    if (!artistName || !artistName.trim()) return;
    const cleanName = artistName.replace(/ - Topic|VEVO|Official|Records/gi, '').trim().toLowerCase();

    state.previousView = state.currentView;
    switchView('artist');

    if (el.artistProfileName) el.artistProfileName.textContent = cleanName;
    if (el.artistProfileBio) el.artistProfileBio.textContent = tr('Fetching artist discography and biography...');
    if (el.artistTracksCount) el.artistTracksCount.textContent = tr('Searching...');
    if (el.artistAvatarImg) el.artistAvatarImg.style.display = 'none';
    const wrap = document.getElementById('artist-avatar-wrap');
    if (wrap) wrap.classList.add('loading');
    if (el.artistAvatarFallback) el.artistAvatarFallback.style.display = 'flex';
    if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.add('hidden');
    if (el.artistTracksList) el.artistTracksList.innerHTML = `<div class="empty-hint">${tr('fetching official releases...')}</div>`;

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/artist?name=${encodeURIComponent(cleanName)}`);
      const data = await res.json();

      if (!data.success || !data.artist) throw new Error(tr('Artist not found'));

      state.currentArtistData = data.artist;
      if (el.artistProfileName) el.artistProfileName.textContent = data.artist.name;
      if (el.artistProfileBio) el.artistProfileBio.textContent = data.artist.bio;

      if (el.artistVerifiedBadge) el.artistVerifiedBadge.classList.toggle('hidden', !data.artist.isVerified);

      if (data.artist.avatar) {
        if (el.artistAvatarImg) {
          el.artistAvatarImg.src = data.artist.avatar;
          el.artistAvatarImg.style.display = 'block';
        }
        if (el.artistAvatarFallback) el.artistAvatarFallback.style.display = 'none';
        if (el.artistHeroBackdrop) {
          el.artistHeroBackdrop.style.backgroundImage = `url("${data.artist.avatar}")`;
        }
      }

      if (el.artistTracksCount) el.artistTracksCount.textContent = trn(data.artist.tracks.length, '{n} track', '{n} tracks');

      requestAnimationFrame(() => {
        if (el.artistTracksList) renderTracks(el.artistTracksList, data.artist.tracks, 'artist');
      });
    } catch (e) {
      console.warn('Artist load error:', e);
      if (el.artistProfileBio) el.artistProfileBio.textContent = tr('Could not load artist profile information.');
      if (el.artistTracksList) el.artistTracksList.innerHTML = `<div class="empty-hint">${tr('no tracks found for this artist.')}</div>`;
    }
  }

  if (el.btnPlayArtistTracks) {
    el.btnPlayArtistTracks.addEventListener('click', () => {
      if (state.currentArtistData && state.currentArtistData.tracks.length > 0) {
        playTrack(state.currentArtistData.tracks[0], state.currentArtistData.tracks);
      }
    });
  }

  if (el.btnBackArtist) {
    el.btnBackArtist.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = (state.previousView && state.previousView !== 'artist') ? state.previousView : 'discover';
      switchView(target);
    };
  }

  if (el.playbarArtist) {
    el.playbarArtist.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.currentTrack && state.currentTrack.artist) {
        openArtistProfile(state.currentTrack.artist);
      }
    });
  }

  if (el.rightPanelArtist) {
    el.rightPanelArtist.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.currentTrack && state.currentTrack.artist) {
        openArtistProfile(state.currentTrack.artist);
      }
    });
  }

  function toggleFavoriteTrack(track) {
    if (!track) return;
    const exists = state.favorites.some(f => isSameTrack(f, track));
    
    if (exists) {
      state.favorites = state.favorites.filter(f => !isSameTrack(f, track));
    } else {
      state.favorites.unshift(track);
    }
    
    localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
    updateFavoritesBadge();
    updateFavoriteIcon();
    if (state.currentView === 'favorites') renderFavoritesView();
  }

  function updateFavoriteIcon() {
    if (!el.favIcon) return;
    if (!state.currentTrack) {
      el.favIcon.setAttribute('fill', 'none');
      return;
    }
    const isFav = state.favorites.some(f => isSameTrack(f, state.currentTrack));
    el.favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
  }

  function updateFavoritesBadge() {
    if (el.favoritesCount) el.favoritesCount.textContent = state.favorites.length;
  }

  function renderFavoritesView() {
    const query = el.favoritesSearchInput ? el.favoritesSearchInput.value.trim().toLowerCase() : '';
    let filtered = state.favorites;
    if (query) {
      filtered = state.favorites.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query))
      );
    }
    if (el.favoritesSubtitle) el.favoritesSubtitle.textContent = query ? tr('{shown} of {total} tracks', { shown: filtered.length, total: state.favorites.length }) : trn(state.favorites.length, '{n} track saved', '{n} tracks saved');
    if (el.favoritesTracksList) renderTracks(el.favoritesTracksList, filtered, 'favorites');
  }

  if (el.favoritesSearchInput) {
    el.favoritesSearchInput.addEventListener('input', () => renderFavoritesView());
  }

  function findSavedTrack(track) {
    if (!track) return null;
    if (track.savedFile) return state.savedTracks.find(t => t.savedFile === track.savedFile) || null;
    return state.savedTracks.find(t => isSameTrack(t, track)) || null;
  }

  function renderSavedView() {
    const query = el.savedSearchInput ? el.savedSearchInput.value.trim().toLowerCase() : '';
    let filtered = state.savedTracks;
    if (query) {
      filtered = state.savedTracks.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query))
      );
    }
    const total = state.savedTracks.length;
    if (el.savedSubtitle) {
      el.savedSubtitle.textContent = query ? tr('{shown} of {total} songs', { shown: filtered.length, total }) : trn(total, '{n} song · {dir}', '{n} songs · {dir}', { dir: state.savedDirectory });
    }
    if (el.savedTracksList) {
      if (!total) el.savedTracksList.innerHTML = `<div class="empty-hint">${tr('No saved songs yet. Use the download button on any track.')}</div>`;
      else renderTracks(el.savedTracksList, filtered, 'saved');
    }
  }

  async function loadSavedTracks() {
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/saved-library`);
      const data = await res.json();
      if (!data.success) return;
      state.savedTracks = data.tracks || [];
      state.savedDirectory = data.directory || '';
    } catch (e) {
      return;
    }
    if (el.savedCount) el.savedCount.textContent = state.savedTracks.length;
    if (state.currentView === 'saved') renderSavedView();
  }

  async function deleteSavedTrack(track) {
    if (!track || !track.savedFile) return;
    if (!confirm(tr('Delete "{file}" from the saved folder?', { file: track.savedFile }))) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/saved-delete?name=${encodeURIComponent(track.savedFile)}`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || tr('could not delete'));
      showToast(tr('Saved song deleted'));
    } catch (e) {
      showToast(tr('Delete failed: {error}', { error: e.message }), 'error');
    }
    loadSavedTracks();
  }

  if (el.savedSearchInput) {
    el.savedSearchInput.addEventListener('input', () => renderSavedView());
  }

  if (el.btnOpenSavedFolder) {
    el.btnOpenSavedFolder.addEventListener('click', () => {
      fetch(`http://127.0.0.1:${state.serverPort}/api/open-saved-folder`, { method: 'POST' }).catch(() => {});
    });
  }

  loadSavedTracks();

  if (el.volumeSlider) el.volumeSlider.value = state.volume;
  if (state.isMuted) {
    if (el.volumeIcon) el.volumeIcon.classList.add('hidden');
    if (el.volumeMutedIcon) el.volumeMutedIcon.classList.remove('hidden');
  }
  syncLoopMode();

  function bindSettingSwitch(id, stateKey, storageKey, onChange) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle('active', state[stateKey]);
    btn.addEventListener('click', () => {
      state[stateKey] = !state[stateKey];
      btn.classList.toggle('active', state[stateKey]);
      localStorage.setItem(storageKey, String(state[stateKey]));
      if (onChange) onChange(state[stateKey]);
    });
  }

  const setCloseToTray = (on) => {
    if (window.electronAPI && window.electronAPI.setCloseToTray) window.electronAPI.setCloseToTray(on);
  };
  bindSettingSwitch('btn-close-to-tray', 'closeToTray', 'riffle_close_to_tray', setCloseToTray);
  bindSettingSwitch('btn-crossfade', 'crossfadeEnabled', 'riffle_crossfade');
  bindSettingSwitch('btn-crossfade-loop', 'crossfadeLoop', 'riffle_crossfade_loop', () => syncLoopMode());
  setCloseToTray(state.closeToTray);

  bindSettingSwitch('btn-normalize', 'normalizeVolume', 'riffle_normalize', (on) => {
    if (on && !loudness.info && loudness.source) loadTrackLoudness(loudness.source, state.loadToken);
    else applyNormalization(0.8);
  });
  applyNormalization(0.05);

  bindSettingSwitch('btn-autoplay', 'autoplayEnabled', 'riffle_autoplay', (on) => {
    if (on && state.currentTrack && state.queueIndex >= state.queue.length - 2) extendAutoplayQueue({ announce: true });
  });

  const setGlobalShortcuts = (on) => {
    if (window.electronAPI && window.electronAPI.setGlobalShortcuts) window.electronAPI.setGlobalShortcuts(on);
  };
  bindSettingSwitch('btn-global-shortcuts', 'globalShortcuts', 'riffle_global_shortcuts', setGlobalShortcuts);
  setGlobalShortcuts(state.globalShortcuts);

  function nudgeVolume(delta) {
    if (!el.volumeSlider) return;
    el.volumeSlider.value = Math.min(1, Math.max(0, state.volume + delta));
    el.volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
    showToast(tr('Volume {value}%', { value: Math.round(state.volume * 100) }));
  }

  function toggleMiniPlayer() {
    if (window.electronAPI && window.electronAPI.toggleMini) window.electronAPI.toggleMini();
  }

  const btnMiniPlayer = document.getElementById('btn-mini-player');
  if (btnMiniPlayer) btnMiniPlayer.addEventListener('click', toggleMiniPlayer);

  if (window.electronAPI && window.electronAPI.onMiniVisibility) {
    window.electronAPI.onMiniVisibility((open) => {
      miniOpen = Boolean(open);
      if (btnMiniPlayer) btnMiniPlayer.classList.toggle('active', miniOpen);
      sendMiniState(true);
    });
  }

  const sliderCrossfade = document.getElementById('slider-crossfade-secs');
  const valCrossfade = document.getElementById('val-crossfade-secs');
  if (sliderCrossfade) {
    sliderCrossfade.value = state.crossfadeSecs;
    if (valCrossfade) valCrossfade.textContent = `${state.crossfadeSecs}s`;
    sliderCrossfade.addEventListener('input', () => {
      state.crossfadeSecs = parseInt(sliderCrossfade.value, 10);
      if (valCrossfade) valCrossfade.textContent = `${state.crossfadeSecs}s`;
      localStorage.setItem('riffle_crossfade_secs', String(state.crossfadeSecs));
    });
  }

  if (window.electronAPI && window.electronAPI.onTrayCommand) {
    window.electronAPI.onTrayCommand((cmd) => {
      if (cmd === 'toggle') togglePlayPause();
      else if (cmd === 'next') playNext();
      else if (cmd === 'prev') playPrev();
      else if (cmd === 'volup') nudgeVolume(0.05);
      else if (cmd === 'voldown') nudgeVolume(-0.05);
      else if (cmd === 'mini') toggleMiniPlayer();
      else if (cmd === 'favorite') {
        if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
        sendMiniState(true);
      } else if (typeof cmd === 'string' && cmd.startsWith('seek:') && el.nativeAudio) {
        const ratio = Math.min(1, Math.max(0, parseFloat(cmd.slice(5)) || 0));
        const dur = el.nativeAudio.duration;
        if (isFinite(dur) && dur > 0) el.nativeAudio.currentTime = ratio * dur;
        sendMiniState(true);
      }
    });
  }

  window.addEventListener('beforeunload', saveSession);

  function renderHistoryView() {
    if (el.historyTracksList) renderTracks(el.historyTracksList, state.history, 'history');
  }

  function updateQueueBadge() {
    if (el.queueCount) el.queueCount.textContent = state.queue.length;
  }

  function renderQueueView() {
    if (el.queueTracksList) renderTracks(el.queueTracksList, state.queue, 'queue');
  }

  function getTrackThumbUrl(track) {
    if (!track) return '';
    const custom = getTrackArt(track).cover;
    if (custom) return custom;
    if (track.localThumbnail) return track.localThumbnail;
    if (track.id && state.serverPort) {
      const cleanId = String(track.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    }
    return track.thumbnail || '';
  }

  function renderPlaylistCover(container, playlist, size = 64) {
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('playlist-cover-art');

    const tracks = (playlist && playlist.tracks) ? playlist.tracks : [];
    let firstThumb = null;
    for (const t of tracks) {
      const src = getTrackThumbUrl(t);
      if (src) {
        firstThumb = src;
        break;
      }
    }

    if (firstThumb) {
      container.classList.add('cover-single');
      const img = document.createElement('img');
      img.className = 'cover-single-img';
      img.src = smallThumb(firstThumb);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        container.classList.remove('cover-single');
        container.classList.add('cover-empty');
        container.innerHTML = `<svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
      };
      container.appendChild(img);
    } else {
      container.classList.add('cover-empty');
      container.innerHTML = `
        <svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      `;
    }
  }

  function renderPlaylistsList() {
    if (!el.playlistsList) return;
    el.playlistsList.innerHTML = '';
    state.playlists.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'playlist-item';
      item.dataset.playlistId = pl.id;
      if (state.currentView === 'playlist-detail' && state.currentPlaylistId === pl.id) {
        item.classList.add('active');
      }

      const thumbEl = document.createElement('div');
      thumbEl.className = 'playlist-item-thumb';
      renderPlaylistCover(thumbEl, pl, 44);

      const infoEl = document.createElement('div');
      infoEl.className = 'playlist-item-info';
      const trackCount = (pl.tracks || []).length;
      infoEl.innerHTML = `
        <span class="playlist-item-name">${(pl.name || tr('untitled'))}</span>
        <span class="playlist-item-count">${trn(trackCount, '{n} track', '{n} tracks')}</span>
      `;

      item.appendChild(thumbEl);
      item.appendChild(infoEl);

      item.addEventListener('click', () => {
        openPlaylistDetail(pl.id);
      });
      el.playlistsList.appendChild(item);
    });
  }

  function initListReordering({ container, itemSelector, setOrder, canDragItem, isFilterActive }) {
    if (!container) return;

    let draggedItem = null;
    let startX = 0;
    let startY = 0;
    let activePointerId = null;
    let isDragging = false;
    let pressTimer = null;
    let autoScrollTimer = null;
    let suppressClick = false;
    let startIndex = -1;
    let targetIndex = -1;
    let itemMetrics = [];
    let items = [];
    let draggedHeight = 0;
    let draggedStartTop = 0;

    const scrollParent = container.closest('.main-content, .rail-drawer') || container;

    window.addEventListener('click', (e) => {
      if (suppressClick) {
        e.stopImmediatePropagation();
        e.preventDefault();
        suppressClick = false;
      }
    }, true);

    const startDrag = () => {
      if (!draggedItem || isDragging) return;
      isDragging = true;
      suppressClick = true;
      container._isDraggingReorder = true;
      try {
        if (activePointerId !== null && draggedItem.setPointerCapture) {
          draggedItem.setPointerCapture(activePointerId);
        }
      } catch (e) {}

      container.style.userSelect = 'none';
      draggedItem.classList.add('is-dragging');

      items = Array.from(container.querySelectorAll(itemSelector)).filter(el => !canDragItem || canDragItem(el));
      startIndex = items.indexOf(draggedItem);
      targetIndex = startIndex;
      draggedHeight = draggedItem.offsetHeight;
      draggedStartTop = draggedItem.offsetTop;

      itemMetrics = items.map((el, i) => ({
        el,
        index: i,
        top: el.offsetTop,
        height: el.offsetHeight
      }));
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      if (isFilterActive && isFilterActive()) return;

      const item = e.target.closest(itemSelector);
      if (!item || item.parentElement !== container) return;
      if (canDragItem && !canDragItem(item)) return;

      if (e.target.closest('button, input, select, textarea, .btn-icon-pill, .track-fav, .track-download-btn, .btn-rename-p, .btn-delete-p')) return;

      draggedItem = item;
      startX = e.clientX;
      startY = e.clientY;
      activePointerId = e.pointerId;
      isDragging = false;

      pressTimer = setTimeout(() => {
        startDrag();
      }, 250);

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!draggedItem) return;

      if (!isDragging) {
        const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
        if (dist > 7) {
          clearTimeout(pressTimer);
          startDrag();
        } else {
          return;
        }
      }

      const dy = e.clientY - startY;

      if (scrollParent) {
        const scRect = scrollParent.getBoundingClientRect();
        clearInterval(autoScrollTimer);
        if (e.clientY < scRect.top + 40) {
          autoScrollTimer = setInterval(() => { scrollParent.scrollTop -= 8; }, 16);
        } else if (e.clientY > scRect.bottom - 40) {
          autoScrollTimer = setInterval(() => { scrollParent.scrollTop += 8; }, 16);
        }
      }

      draggedItem.style.transform = `translate3d(0, ${dy}px, 0) scale(1.02)`;

      if (itemMetrics.length <= 1) return;

      const currentCenter = draggedStartTop + (draggedHeight / 2) + dy;
      let newTarget = 0;
      for (let i = 0; i < itemMetrics.length; i++) {
        const m = itemMetrics[i];
        const mid = m.top + (m.height / 2);
        if (currentCenter > mid) {
          newTarget = i;
        }
      }
      newTarget = Math.max(0, Math.min(newTarget, itemMetrics.length - 1));

      if (newTarget !== targetIndex) {
        targetIndex = newTarget;
        const shiftDistance = (itemMetrics.length > 1 && Math.abs(itemMetrics[1].top - itemMetrics[0].top) > 0)
          ? Math.abs(itemMetrics[1].top - itemMetrics[0].top)
          : draggedHeight;

        itemMetrics.forEach(metric => {
          if (metric.el === draggedItem) return;
          if (startIndex < targetIndex) {
            if (metric.index > startIndex && metric.index <= targetIndex) {
              metric.el.style.transform = `translate3d(0, -${shiftDistance}px, 0)`;
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            } else {
              metric.el.style.transform = '';
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            }
          } else if (startIndex > targetIndex) {
            if (metric.index >= targetIndex && metric.index < startIndex) {
              metric.el.style.transform = `translate3d(0, ${shiftDistance}px, 0)`;
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            } else {
              metric.el.style.transform = '';
              metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
            }
          } else {
            metric.el.style.transform = '';
            metric.el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
          }
        });
      }
    };

    const onPointerUp = () => {
      clearTimeout(pressTimer);
      clearInterval(autoScrollTimer);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (!draggedItem) return;

      const item = draggedItem;
      const currentActiveId = activePointerId;
      draggedItem = null;
      activePointerId = null;

      try {
        if (currentActiveId !== null && item.hasPointerCapture && item.hasPointerCapture(currentActiveId)) {
          item.releasePointerCapture(currentActiveId);
        }
      } catch (e) {}

      if (isDragging) {
        let targetSlotDy = 0;
        if (targetIndex >= 0 && targetIndex < itemMetrics.length && targetIndex !== startIndex) {
          targetSlotDy = itemMetrics[targetIndex].top - draggedStartTop;
        }

        item.style.transition = 'transform 160ms cubic-bezier(0.2, 0, 0, 1)';
        item.style.transform = `translate3d(0, ${targetSlotDy}px, 0) scale(1)`;

        setTimeout(() => {
          if (targetIndex !== startIndex && targetIndex >= 0 && targetIndex < items.length) {
            const targetItem = items[targetIndex];
            if (targetIndex > startIndex) {
              targetItem.after(item);
            } else {
              targetItem.before(item);
            }
          }

          item.classList.remove('is-dragging');
          item.style.transform = '';
          item.style.transition = '';
          item.style.willChange = '';

          items.forEach(el => {
            el.style.transform = '';
            el.style.transition = '';
          });

          container.style.userSelect = '';
          container.classList.add('no-enter-anim');

          // virtualized track lists only render a window; map DOM indices back to the array
          const offset = Math.max(0, container._lastStartIndex || 0);
          container.querySelectorAll('.track-row').forEach((r, i) => {
            r.dataset.trackIndex = String(offset + i);
            const num = r.querySelector('.track-row-index');
            if (num) num.textContent = String(offset + i + 1);
          });

          if (startIndex !== -1 && targetIndex !== -1 && startIndex !== targetIndex) {
            setOrder(startIndex + offset, targetIndex + offset);
          }

          container._isDraggingReorder = false;
          setTimeout(() => { suppressClick = false; }, 80);
        }, 160);
      } else {
        suppressClick = false;
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
  }

  initListReordering({
    container: el.playlistsList,
    itemSelector: '.playlist-item',
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.playlists.splice(fromIdx, 1);
      state.playlists.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    }
  });

  initListReordering({
    container: el.presetsContainer,
    itemSelector: '.preset-chip',
    canDragItem: (chip) => chip.dataset.isCustom === 'true',
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.customPresets.splice(fromIdx, 1);
      state.customPresets.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_custom_presets', JSON.stringify(state.customPresets));
    }
  });

  initListReordering({
    container: el.favoritesTracksList,
    itemSelector: '.track-row',
    isFilterActive: () => Boolean(el.favoritesSearchInput && el.favoritesSearchInput.value.trim()),
    setOrder: (fromIdx, toIdx) => {
      const [moved] = state.favorites.splice(fromIdx, 1);
      state.favorites.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_favorites', JSON.stringify(state.favorites));
      if (el.favoritesSubtitle) {
        el.favoritesSubtitle.textContent = trn(state.favorites.length, '{n} track saved', '{n} tracks saved');
      }
    }
  });

  initListReordering({
    container: el.playlistTracksList,
    itemSelector: '.track-row',
    isFilterActive: () => Boolean(el.playlistSearchInput && el.playlistSearchInput.value.trim()),
    setOrder: (fromIdx, toIdx) => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl || !pl.tracks) return;
      const [moved] = pl.tracks.splice(fromIdx, 1);
      pl.tracks.splice(toIdx, 0, moved);
      localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    }
  });

  initListReordering({
    container: el.queueTracksList,
    itemSelector: '.track-row',
    setOrder: (fromIdx, toIdx) => {
      const current = state.queue[state.queueIndex];
      const [moved] = state.queue.splice(fromIdx, 1);
      state.queue.splice(toIdx, 0, moved);
      state.queueIndex = state.queue.indexOf(current);
      state.playNextPending = 0;
      saveSession();
    }
  });

  function createPlaylist(name) {
    if (!name || !name.trim()) return;
    const newPl = { id: 'pl_' + Date.now(), name: name.trim(), tracks: [] };
    state.playlists.push(newPl);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    renderPlaylistsList();
    openPlaylistDetail(newPl.id);
  }

  function openPlaylistDetail(playlistId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    state.currentPlaylistId = playlistId;
    if (el.playlistDetailTitle) el.playlistDetailTitle.textContent = pl.name;
    const query = el.playlistSearchInput ? el.playlistSearchInput.value.trim().toLowerCase() : '';
    let filtered = pl.tracks;
    if (query) {
      filtered = pl.tracks.filter(t =>
      (t.title && t.title.toLowerCase().includes(query)) ||
      (t.artist && t.artist.toLowerCase().includes(query))
      );
    }
    if (el.playlistDetailCount) el.playlistDetailCount.textContent = query ? tr('{shown} of {total} tracks', { shown: filtered.length, total: pl.tracks.length }) : trn(pl.tracks.length, '{n} track', '{n} tracks');
    const detailCover = document.getElementById('playlist-detail-cover');
    if (detailCover) renderPlaylistCover(detailCover, pl, 140);
    const firstThumb = (pl.tracks && pl.tracks[0]) ? getTrackThumbUrl(pl.tracks[0]) : '';
    updatePlaylistDetailBanner(firstThumb);
    if (el.playlistTracksList) renderTracks(el.playlistTracksList, filtered, 'playlist');
    switchView('playlist-detail');
    renderPlaylistsList();
  }

  function removeTrackFromCurrentPlaylist(trackId) {
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (!pl) return;
    pl.tracks = pl.tracks.filter(t => t.id !== trackId);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    openPlaylistDetail(state.currentPlaylistId);
  }

  function deleteCurrentPlaylist() {
    if (!state.currentPlaylistId) return;
    state.playlists = state.playlists.filter(p => p.id !== state.currentPlaylistId);
    localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
    state.currentPlaylistId = null;
    renderPlaylistsList();
    switchView('discover');
  }

  let trackToAddToPlaylist = null;
  function openAddToPlaylistModal(track) {
    trackToAddToPlaylist = track;
    if (!el.playlistPickList) return;
    el.playlistPickList.innerHTML = '';
    if (state.playlists.length === 0) {
      el.playlistPickList.innerHTML = `<div class="empty-hint">${tr('no playlists yet. create one first.')}</div>`;
    } else {
      state.playlists.forEach(pl => {
        const item = document.createElement('div');
        item.className = 'playlist-pick-item';
        item.textContent = pl.name;
        item.addEventListener('click', () => {
          if (!pl.tracks.some(t => t.id === track.id)) {
            pl.tracks.push(track);
            localStorage.setItem('devsize_playlists', JSON.stringify(state.playlists));
            renderPlaylistsList();
          }
          if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
        });
          el.playlistPickList.appendChild(item);
      });
    }
    if (el.addToPlaylistModal) openModal(el.addToPlaylistModal);
  }

  function switchView(viewName) {
    state.currentView = viewName;

    requestAnimationFrame(() => {
      document.querySelectorAll('.no-enter-anim').forEach(c => c.classList.remove('no-enter-anim'));
      [el.viewDiscover, el.viewFavorites, el.viewSaved, el.viewHistory, el.viewQueue, el.viewPlaylistDetail, el.viewArtist, el.viewSettings].forEach(v => {
        if (v) v.classList.remove('active');
      });

        [el.navDiscover, el.navFavorites, el.navSaved, el.navHistory, el.navQueue, el.navSettings].forEach(n => {
          if (n) n.classList.remove('active');
        });

          if (viewName === 'discover') {
            if (el.viewDiscover) el.viewDiscover.classList.add('active');
            if (el.navDiscover) el.navDiscover.classList.add('active');
          } else if (viewName === 'favorites') {
            if (el.viewFavorites) el.viewFavorites.classList.add('active');
            if (el.navFavorites) el.navFavorites.classList.add('active');
            renderFavoritesView();
          } else if (viewName === 'saved') {
            if (el.viewSaved) el.viewSaved.classList.add('active');
            if (el.navSaved) el.navSaved.classList.add('active');
            renderSavedView();
            loadSavedTracks();
          } else if (viewName === 'history') {
            if (el.viewHistory) el.viewHistory.classList.add('active');
            if (el.navHistory) el.navHistory.classList.add('active');
            renderHistoryView();
          } else if (viewName === 'queue') {
            if (el.viewQueue) el.viewQueue.classList.add('active');
            if (el.navQueue) el.navQueue.classList.add('active');
            renderQueueView();
          } else if (viewName === 'playlist-detail') {
            if (el.viewPlaylistDetail) el.viewPlaylistDetail.classList.add('active');
          } else if (viewName === 'artist') {
            if (el.viewArtist) el.viewArtist.classList.add('active');
          } else if (viewName === 'settings') {
            if (el.viewSettings) el.viewSettings.classList.add('active');
            if (el.navSettings) el.navSettings.classList.add('active');
            showSettingsCategory(localStorage.getItem('riffle_settings_cat') || 'appearance');
            updateOfflineStorageUI();
            checkToolsStatus(false);
          }

          if (el.navActiveIndicator) {
            const activeNav = document.querySelector(`.nav-item[data-view="${viewName}"]`);
            if (activeNav) {
              const navRect = activeNav.closest('.sidebar-nav').getBoundingClientRect();
              const targetRect = activeNav.getBoundingClientRect();
              const targetY = targetRect.top - navRect.top;

              const currentTransform = el.navActiveIndicator.style.transform;
              const currentY = currentTransform ? parseFloat(currentTransform.match(/translateY\((.*?)px\)/)?.[1] || 0) : 0;
              const distance = Math.abs(targetY - currentY);

              if (distance > 0) {
                el.navActiveIndicator.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), height 0.15s ease-in';
                el.navActiveIndicator.style.height = `${48 + distance * 0.4}px`;

                if (targetY < currentY) {
                  el.navActiveIndicator.style.transform = `translateY(${targetY}px)`;
                }

                setTimeout(() => {
                  el.navActiveIndicator.style.transition = 'transform 0.3s cubic-bezier(0.2, 0, 0, 1), height 0.3s cubic-bezier(0.2, 0, 0, 1)';
                  el.navActiveIndicator.style.height = `48px`;
                  el.navActiveIndicator.style.transform = `translateY(${targetY}px)`;
                }, 150);
              } else {
                el.navActiveIndicator.style.transform = `translateY(${targetY}px)`;
              }
            }
          }

          highlightPlayingRow();
    });
  }

  function updatePlayPauseButton(isPlaying, isBuffering = false) {
    if (isBuffering) {
      if (el.playIcon) el.playIcon.classList.add('hidden');
      if (el.pauseIcon) el.pauseIcon.classList.add('hidden');
      if (el.playbarSpinner) el.playbarSpinner.classList.remove('hidden');
      if (el.btnPlayPause) el.btnPlayPause.classList.add('playing');
    } else {
      if (el.playbarSpinner) el.playbarSpinner.classList.add('hidden');
      if (isPlaying) {
        if (el.playIcon) el.playIcon.classList.add('hidden');
        if (el.pauseIcon) el.pauseIcon.classList.remove('hidden');
        if (el.btnPlayPause) el.btnPlayPause.classList.add('playing');
      } else {
        if (el.playIcon) el.playIcon.classList.remove('hidden');
        if (el.pauseIcon) el.pauseIcon.classList.add('hidden');
        if (el.btnPlayPause) el.btnPlayPause.classList.remove('playing');
      }
    }
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  if (el.btnResetVfx) {
    el.btnResetVfx.addEventListener('click', () => {
      state.vfx = { ...defaultVfx };
      localStorage.setItem('devsize_vfx', JSON.stringify(state.vfx));
      applyVisualEffects();
    });
  }

  if (window.electronAPI) {
    if (el.btnMinimize) el.btnMinimize.addEventListener('click', () => window.electronAPI.minimizeWindow());
    if (el.btnMaximize) el.btnMaximize.addEventListener('click', () => window.electronAPI.maximizeWindow());
    if (el.btnClose) el.btnClose.addEventListener('click', () => window.electronAPI.closeWindow());
  }

  if (el.navDiscover) el.navDiscover.addEventListener('click', () => switchView('discover'));
  if (el.navFavorites) el.navFavorites.addEventListener('click', () => switchView('favorites'));
  if (el.navHistory) el.navHistory.addEventListener('click', () => switchView('history'));
  if (el.navSaved) el.navSaved.addEventListener('click', () => switchView('saved'));
  if (el.navQueue) el.navQueue.addEventListener('click', () => switchView('queue'));
  if (el.navSettings) el.navSettings.addEventListener('click', () => switchView('settings'));

  if (el.btnAutoRemix) {
    el.btnAutoRemix.addEventListener('click', () => {
      state.isAutoRemix = !state.isAutoRemix;
      el.btnAutoRemix.classList.toggle('active', state.isAutoRemix);
    });
  }

  if (el.btnSavePresetDialog) {
    el.btnSavePresetDialog.addEventListener('click', () => {
      if (el.newPresetName) el.newPresetName.value = '';
      if (el.savePresetModal) openModal(el.savePresetModal);
      if (el.newPresetName) el.newPresetName.focus();
    });
  }

  if (el.btnCancelPreset) {
    el.btnCancelPreset.addEventListener('click', () => {
      if (el.savePresetModal) closeModal(el.savePresetModal);
    });
  }

  if (el.btnConfirmSavePreset) {
    el.btnConfirmSavePreset.addEventListener('click', () => {
      const name = el.newPresetName ? el.newPresetName.value : '';
      if (name.trim()) {
        saveCustomPreset(name);
        if (el.savePresetModal) closeModal(el.savePresetModal);
      }
    });
  }

  if (el.newPresetName) {
    el.newPresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmSavePreset) el.btnConfirmSavePreset.click();
      if (e.key === 'Escape' && el.btnCancelPreset) el.btnCancelPreset.click();
    });
  }

  if (el.btnCancelRenamePreset) {
    el.btnCancelRenamePreset.addEventListener('click', () => {
      if (el.renamePresetModal) closeModal(el.renamePresetModal);
    });
  }

  if (el.btnConfirmRenamePreset) {
    el.btnConfirmRenamePreset.addEventListener('click', () => {
      const name = el.renamePresetName ? el.renamePresetName.value : '';
      if (name.trim() && state.presetToRenameId) {
        renameCustomPreset(state.presetToRenameId, name);
        if (el.renamePresetModal) closeModal(el.renamePresetModal);
      }
    });
  }

  if (el.renamePresetName) {
    el.renamePresetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmRenamePreset) el.btnConfirmRenamePreset.click();
      if (e.key === 'Escape' && el.btnCancelRenamePreset) el.btnCancelRenamePreset.click();
    });
  }

  const deletePresetModal = document.getElementById('delete-preset-modal');
  const btnCancelDeletePreset = document.getElementById('btn-cancel-delete-preset');
  const btnConfirmDeletePreset = document.getElementById('btn-confirm-delete-preset');

  if (btnCancelDeletePreset) {
    btnCancelDeletePreset.addEventListener('click', () => {
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  if (btnConfirmDeletePreset) {
    btnConfirmDeletePreset.addEventListener('click', () => {
      if (state.presetToDeleteId) {
        deleteCustomPreset(state.presetToDeleteId);
        state.presetToDeleteId = null;
      }
      if (deletePresetModal) closeModal(deletePresetModal);
    });
  }

  if (el.btnToggleLyricsPanel) {
    el.btnToggleLyricsPanel.addEventListener('click', () => {
      state.isRightPanelOpen = !state.isRightPanelOpen;
      if (el.rightPanel) el.rightPanel.classList.toggle('hidden', !state.isRightPanelOpen);
      el.btnToggleLyricsPanel.classList.toggle('active', state.isRightPanelOpen);
      setTimeout(resizeCanvases, 150);
    });
  }

  if (el.btnCloseRightPanel) {
    el.btnCloseRightPanel.addEventListener('click', () => {
      state.isRightPanelOpen = false;
      if (el.rightPanel) el.rightPanel.classList.add('hidden');
      if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.classList.remove('active');
      setTimeout(resizeCanvases, 150);
    });
  }

  if (el.searchInput) {
    el.searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val && el.searchClearBtn) {
        el.searchClearBtn.classList.remove('hidden');
      } else if (el.searchClearBtn) {
        el.searchClearBtn.classList.add('hidden');
      }

      clearTimeout(searchDebounceTimer);
      // tiktok has no text search; only auto-search complete links (an @username needs Enter)
      if (state.platform === 'tiktok' && !/^https?:\/\/\S+$/i.test(val.trim())) return;
      searchDebounceTimer = setTimeout(() => {
        if (val.trim()) performSearch(val);
      }, 280);
    });

    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchDebounceTimer);
        performSearch(el.searchInput.value);
      }
    });
  }

  // search autocomplete: your own songs and recent searches first, then YouTube's suggestions
  const suggest = { items: [], active: -1, token: 0, timer: null, box: document.getElementById('search-suggest') };
  const RECENT_SEARCHES_KEY = 'riffle_recent_searches';

  function getRecentSearches() {
    try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]').filter(q => typeof q === 'string'); } catch (e) { return []; }
  }

  function rememberSearch(query) {
    const q = String(query || '').trim();
    if (!q || q.length < 2 || /^https?:\/\//i.test(q)) return;
    const list = [q, ...getRecentSearches().filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, 12);
    try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function forgetSearch(query) {
    const list = getRecentSearches().filter(r => r !== query);
    try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function escapeSuggestHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // the typed prefix stays regular, the completion is bold
  function highlightCompletion(text, typed) {
    const t = String(text || '');
    const q = String(typed || '').trim();
    if (q && t.toLowerCase().startsWith(q.toLowerCase())) {
      return `${escapeSuggestHtml(t.slice(0, q.length))}<b>${escapeSuggestHtml(t.slice(q.length))}</b>`;
    }
    return escapeSuggestHtml(t);
  }

  function localTrackMatches(q) {
    const needle = q.toLowerCase();
    const seen = [];
    const pool = [...state.history, ...state.favorites, ...(state.savedTracks || [])];
    for (const track of pool) {
      if (!track || seen.some(t => isSameTrack(t, track))) continue;
      const hay = `${track.title || ''} ${track.artist || ''}`.toLowerCase();
      if (needle.split(/\s+/).every(word => hay.includes(word))) seen.push(track);
      if (seen.length >= 3) break;
    }
    return seen;
  }

  const SUGGEST_ICONS = {
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>',
    recent: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><polyline points="3 3 3 8 8 8"></polyline><polyline points="12 7 12 12 15 14"></polyline></svg>',
    fill: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="8 7 17 7 17 16"></polyline></svg>',
    remove: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
  };

  function renderSuggestions(typed) {
    if (!suggest.box) return;
    suggest.active = -1;
    if (suggest.items.length === 0 || document.activeElement !== el.searchInput) {
      hideSuggestBox();
      return;
    }
    let html = '';
    let lastKind = null;
    suggest.items.forEach((item, i) => {
      if (item.kind !== lastKind) {
        const label = item.kind === 'track' ? tr('In your library') : item.kind === 'recent' ? tr('Recent searches') : tr('Suggestions');
        html += `<div class="search-suggest-label">${label}</div>`;
        lastKind = item.kind;
      }
      if (item.kind === 'track') {
        const t = item.track;
        const thumb = getTrackArt(t).cover || t.localThumbnail || smallThumb(t.thumbnail);
        html += `<div class="search-suggest-item is-track" role="option" data-index="${i}">
          <span class="search-suggest-thumb">${thumb ? `<img src="${escapeSuggestHtml(thumb)}" alt="" loading="lazy">` : ''}</span>
          <span class="search-suggest-text"><span class="search-suggest-main">${escapeSuggestHtml(t.title)}</span><span class="search-suggest-sub">${escapeSuggestHtml(t.artist)}</span></span>
          <span class="search-suggest-play">${'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>'}</span>
        </div>`;
      } else {
        html += `<div class="search-suggest-item" role="option" data-index="${i}">
          <span class="search-suggest-icon">${SUGGEST_ICONS[item.kind === 'recent' ? 'recent' : 'search']}</span>
          <span class="search-suggest-text"><span class="search-suggest-main">${highlightCompletion(item.text, typed)}</span></span>
          ${item.kind === 'recent'
            ? `<button class="search-suggest-action" data-remove="${i}" title="${tr('Remove from recent searches')}">${SUGGEST_ICONS.remove}</button>`
            : `<button class="search-suggest-action" data-fill="${i}" title="${tr('Complete without searching')}">${SUGGEST_ICONS.fill}</button>`}
        </div>`;
      }
    });
    html += `<div class="search-suggest-hint"><kbd>↑</kbd><kbd>↓</kbd> ${tr('navigate')} <kbd>Tab</kbd> ${tr('complete')} <kbd>Esc</kbd> ${tr('close')}</div>`;
    suggest.box.innerHTML = html;
    suggest.box.classList.remove('hidden');
    requestAnimationFrame(() => suggest.box.classList.add('open'));
  }

  function hideSuggestBox() {
    if (!suggest.box) return;
    suggest.active = -1;
    suggest.box.classList.remove('open');
    suggest.box.classList.add('hidden');
  }

  // also drops any suggestion request still in flight
  function closeSuggestions() {
    suggest.token++;
    clearTimeout(suggest.timer);
    hideSuggestBox();
  }

  function setActiveSuggestion(index) {
    const nodes = suggest.box ? suggest.box.querySelectorAll('.search-suggest-item') : [];
    if (nodes.length === 0) return;
    suggest.active = (index + nodes.length) % nodes.length;
    nodes.forEach((n, i) => n.classList.toggle('active', i === suggest.active));
    nodes[suggest.active].scrollIntoView({ block: 'nearest' });
  }

  async function updateSuggestions() {
    if (!el.searchInput || !suggest.box) return;
    const typed = el.searchInput.value;
    const q = typed.trim();
    const token = ++suggest.token;
    if (/^https?:\/\//i.test(q) || state.platform === 'tiktok') { closeSuggestions(); return; }

    const recent = getRecentSearches();
    if (!q) {
      suggest.items = recent.slice(0, 6).map(text => ({ kind: 'recent', text }));
      renderSuggestions('');
      return;
    }

    const lower = q.toLowerCase();
    const tracks = localTrackMatches(q).map(track => ({ kind: 'track', track }));
    const recentHits = recent.filter(r => r.toLowerCase().startsWith(lower) && r.toLowerCase() !== lower).slice(0, 3).map(text => ({ kind: 'recent', text }));
    suggest.items = [...tracks, ...recentHits];
    renderSuggestions(typed);

    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (token !== suggest.token) return;
      const taken = new Set([lower, ...recentHits.map(r => r.text.toLowerCase())]);
      const online = (data.suggestions || []).filter(text => !taken.has(text.toLowerCase())).slice(0, 7 - Math.min(3, tracks.length)).map(text => ({ kind: 'online', text }));
      suggest.items = [...tracks, ...recentHits, ...online];
      renderSuggestions(typed);
    } catch (e) {}
  }

  function pickSuggestion(index) {
    const item = suggest.items[index];
    if (!item) return;
    closeSuggestions();
    if (item.kind === 'track') {
      playTrack(item.track);
      return;
    }
    el.searchInput.value = item.text;
    rememberSearch(item.text);
    if (el.searchClearBtn) el.searchClearBtn.classList.remove('hidden');
    clearTimeout(searchDebounceTimer);
    performSearch(item.text);
  }

  function fillSuggestion(index) {
    const item = suggest.items[index];
    if (!item || item.kind === 'track') return;
    el.searchInput.value = `${item.text} `;
    el.searchInput.focus();
    el.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  if (el.searchInput && suggest.box) {
    el.searchInput.addEventListener('input', () => {
      clearTimeout(suggest.timer);
      suggest.timer = setTimeout(updateSuggestions, 110);
    });
    el.searchInput.addEventListener('focus', updateSuggestions);
    el.searchInput.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

    // capture phase: runs before the plain Enter-to-search handler
    el.searchInput.addEventListener('keydown', (e) => {
      const open = !suggest.box.classList.contains('hidden');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) { updateSuggestions(); return; }
        e.preventDefault();
        setActiveSuggestion(suggest.active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        if (open && suggest.active >= 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          pickSuggestion(suggest.active);
        } else {
          rememberSearch(el.searchInput.value);
          closeSuggestions();
        }
      } else if (e.key === 'Tab' && open) {
        const idx = suggest.active >= 0 ? suggest.active : suggest.items.findIndex(i => i.kind !== 'track');
        if (idx >= 0 && suggest.items[idx].kind !== 'track') {
          e.preventDefault();
          fillSuggestion(idx);
        }
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        closeSuggestions();
      }
    }, true);

    // keep focus in the input while clicking inside the list
    suggest.box.addEventListener('mousedown', (e) => e.preventDefault());
    suggest.box.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (remove) {
        forgetSearch(suggest.items[Number(remove.dataset.remove)].text);
        updateSuggestions();
        return;
      }
      const fill = e.target.closest('[data-fill]');
      if (fill) { fillSuggestion(Number(fill.dataset.fill)); return; }
      const row = e.target.closest('.search-suggest-item');
      if (row) pickSuggestion(Number(row.dataset.index));
    });
    suggest.box.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.search-suggest-item');
      if (row && Number(row.dataset.index) !== suggest.active) setActiveSuggestion(Number(row.dataset.index));
    });
  }

  if (el.searchClearBtn) {
    el.searchClearBtn.addEventListener('click', () => {
      if (el.searchInput) el.searchInput.value = '';
      el.searchClearBtn.classList.add('hidden');
      if (el.discoverEmpty) el.discoverEmpty.classList.remove('hidden');
      if (el.searchResultsContainer) el.searchResultsContainer.classList.add('hidden');
    });
  }

  if (el.suggestionChips) {
    el.suggestionChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip-btn');
      if (!chip) return;
      const query = chip.dataset.query;
      rememberSearch(query);
      if (el.searchInput) el.searchInput.value = query;
      if (el.searchClearBtn) el.searchClearBtn.classList.remove('hidden');
      performSearch(query);
    });
  }

  const platformButtons = document.querySelectorAll('.platform-btn[data-platform]');
  platformButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const platform = btn.dataset.platform;
      if (state.platform === platform) return;
      state.platform = platform;
      platformButtons.forEach(b => b.classList.toggle('active', b === btn));
      if (el.searchInput) {
        el.searchInput.placeholder = platform === 'tiktok'
          ? tr('Paste a TikTok video link, profile link or @username...')
          : tr('Search, or paste a Spotify / TikTok link...');
      }
      if (el.searchInput && el.searchInput.value.trim()) performSearch(el.searchInput.value);
    });
  });

  if (el.btnPlayPause) el.btnPlayPause.addEventListener('click', togglePlayPause);
  if (el.btnNext) el.btnNext.addEventListener('click', playNext);
  if (el.btnPrev) el.btnPrev.addEventListener('click', playPrev);

  if (el.btnShuffle) {
    el.btnShuffle.addEventListener('click', () => {
      state.isShuffle = !state.isShuffle;
      el.btnShuffle.classList.toggle('active', state.isShuffle);
      localStorage.setItem('riffle_shuffle', String(state.isShuffle));
    });
    el.btnShuffle.classList.toggle('active', state.isShuffle);
  }

  if (el.btnRepeat) {
    el.btnRepeat.addEventListener('click', () => {
      state.isRepeat = !state.isRepeat;
      el.btnRepeat.classList.toggle('active', state.isRepeat);
      localStorage.setItem('riffle_repeat', String(state.isRepeat));
      syncLoopMode();
    });
    el.btnRepeat.classList.toggle('active', state.isRepeat);
  }

  if (el.volumeSlider) {
    el.volumeSlider.addEventListener('input', (e) => {
      state.volume = parseFloat(e.target.value);
      state.isMuted = false;
      savePlayerVolume();
      if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
      if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
      applyAudioSettings();
    });
  }

  if (el.btnVolumeMute) {
    el.btnVolumeMute.addEventListener('click', () => {
      state.isMuted = !state.isMuted;
      savePlayerVolume();
      if (state.isMuted) {
        if (el.volumeIcon) el.volumeIcon.classList.add('hidden');
        if (el.volumeMutedIcon) el.volumeMutedIcon.classList.remove('hidden');
      } else {
        if (el.volumeIcon) el.volumeIcon.classList.remove('hidden');
        if (el.volumeMutedIcon) el.volumeMutedIcon.classList.add('hidden');
      }
      applyAudioSettings();
    });
  }

  if (el.btnToggleFav) {
    el.btnToggleFav.addEventListener('click', () => {
      if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
    });
  }

  if (el.btnClearHistory) {
    el.btnClearHistory.addEventListener('click', () => {
      state.history = [];
      localStorage.setItem('devsize_history', '[]');
      renderHistoryView();
    });
  }

  if (el.btnClearQueue) {
    el.btnClearQueue.addEventListener('click', () => {
      state.queue = [];
      state.queueIndex = -1;
      updateQueueBadge();
      renderQueueView();
    });
  }

  if (el.playlistSearchInput) {
    el.playlistSearchInput.addEventListener('input', () => {
      if (state.currentPlaylistId) openPlaylistDetail(state.currentPlaylistId);
    });
  }
  if (el.btnBackPlaylists) el.btnBackPlaylists.addEventListener('click', () => switchView('discover'));

  const deletePlaylistModal = document.getElementById('delete-playlist-modal');
  const deletePlaylistMsg = document.getElementById('delete-playlist-msg');
  const btnCancelDeletePlaylist = document.getElementById('btn-cancel-delete-playlist');
  const btnConfirmDeletePlaylist = document.getElementById('btn-confirm-delete-playlist');

  if (el.btnDeletePlaylist) {
    el.btnDeletePlaylist.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (!pl) return;
      if (deletePlaylistMsg) deletePlaylistMsg.textContent = tr('Delete playlist "{name}"? This action cannot be undone.', { name: pl.name });
      if (deletePlaylistModal) openModal(deletePlaylistModal);
    });
  }

  if (btnCancelDeletePlaylist && deletePlaylistModal) {
    btnCancelDeletePlaylist.addEventListener('click', () => {
      closeModal(deletePlaylistModal);
    });
  }

  if (btnConfirmDeletePlaylist && deletePlaylistModal) {
    btnConfirmDeletePlaylist.addEventListener('click', () => {
      deleteCurrentPlaylist();
      closeModal(deletePlaylistModal);
      showToast(tr('Playlist deleted'));
    });
  }

  if (el.btnPlayPlaylist) {
    el.btnPlayPlaylist.addEventListener('click', () => {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      if (pl && pl.tracks.length > 0) playTrack(pl.tracks[0], pl.tracks);
    });
  }

  if (el.btnNewPlaylist) {
    el.btnNewPlaylist.addEventListener('click', () => {
      if (el.newPlaylistInput) el.newPlaylistInput.value = '';
      if (el.createPlaylistModal) openModal(el.createPlaylistModal);
      if (el.newPlaylistInput) el.newPlaylistInput.focus();
    });
  }

  if (el.btnCancelNewPlaylist) {
    el.btnCancelNewPlaylist.addEventListener('click', () => {
      if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
    });
  }

  if (el.btnConfirmNewPlaylist) {
    el.btnConfirmNewPlaylist.addEventListener('click', () => {
      const name = el.newPlaylistInput ? el.newPlaylistInput.value : '';
      if (name.trim()) {
        createPlaylist(name);
        if (el.createPlaylistModal) closeModal(el.createPlaylistModal);
      }
    });
  }

  if (el.newPlaylistInput) {
    el.newPlaylistInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && el.btnConfirmNewPlaylist) el.btnConfirmNewPlaylist.click();
      if (e.key === 'Escape' && el.btnCancelNewPlaylist) el.btnCancelNewPlaylist.click();
    });
  }

  if (el.btnCancelAddPlaylist) {
    el.btnCancelAddPlaylist.addEventListener('click', () => {
      if (el.addToPlaylistModal) closeModal(el.addToPlaylistModal);
    });
  }

  if (el.btnOpenSettings) {
    el.btnOpenSettings.addEventListener('click', () => {
      if (el.audioSettingsModal) openModal(el.audioSettingsModal);
    });
  }

  if (el.btnCloseSettings) {
    el.btnCloseSettings.addEventListener('click', () => {
      if (el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  if (el.audioSettingsModal) {
    el.audioSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.audioSettingsModal) closeModal(el.audioSettingsModal);
    });
  }

  if (el.btnOpenVisualSettings) {
    el.btnOpenVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) openModal(el.visualSettingsModal);
    });
  }

  if (el.btnCloseVisualSettings) {
    el.btnCloseVisualSettings.addEventListener('click', () => {
      if (el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.visualSettingsModal) {
    el.visualSettingsModal.addEventListener('click', (e) => {
      if (e.target === el.visualSettingsModal) closeModal(el.visualSettingsModal);
    });
  }

  if (el.btnToggleHqAudio) {
    el.btnToggleHqAudio.addEventListener('click', () => {
      state.hqEnabled = !state.hqEnabled;
      el.btnToggleHqAudio.classList.toggle('active', state.hqEnabled);
      
      if (el.hqPanelWrapper) {
        el.hqPanelWrapper.classList.toggle('expanded', state.hqEnabled);
      }
      initAudioContext();
      updateHqRouting();
    });
  }

  if (el.hqPresetChips) {
    el.hqPresetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        el.hqPresetChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.hqSettings.preset = chip.dataset.preset;

        let v = 0, a = 0, b = 0;
        if (state.hqSettings.preset === 'studio') { v = 0; a = 0; b = 0; }
        else if (state.hqSettings.preset === 'vinyl') { v = 15; a = -15; b = 25; }
        else if (state.hqSettings.preset === 'concert') { v = -10; a = 30; b = 15; }

        if (el.sliderHqVocal) { el.sliderHqVocal.value = v; el.valHqVocal.textContent = (v > 0 ? '+' : '') + v + '%'; state.hqSettings.vocal = v; }
        if (el.sliderHqAir) { el.sliderHqAir.value = a; el.valHqAir.textContent = (a > 0 ? '+' : '') + a + '%'; state.hqSettings.air = a; }
        if (el.sliderHqBass) { el.sliderHqBass.value = b; el.valHqBass.textContent = (b > 0 ? '+' : '') + b + '%'; state.hqSettings.bass = b; }

        applyHqSettings();
      });
    });
  }

  ['Vocal', 'Air', 'Bass'].forEach(type => {
    const slider = el[`sliderHq${type}`];
    const valDisplay = el[`valHq${type}`];
    if (slider) {
      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (valDisplay) valDisplay.textContent = (val > 0 ? '+' : '') + val + '%';
        state.hqSettings[type.toLowerCase()] = val;
        if (el.hqPresetChips) el.hqPresetChips.forEach(c => c.classList.remove('active'));
        applyHqSettings();
      });
    }
  });

  if (el.hqEngineSelect) {
    el.hqEngineSelect.addEventListener('change', (e) => {
      state.hqSettings.engine = e.target.value;
      applyHqSettings();
    });
  }

  const hqDropdown = document.getElementById('hq-engine-dropdown');
  const hqTrigger = document.getElementById('hq-engine-trigger');
  const hqLabel = document.getElementById('hq-engine-label');
  const hqMenu = document.getElementById('hq-engine-menu');

  if (hqTrigger && hqDropdown && hqMenu) {
    hqTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      hqDropdown.classList.toggle('open');
    });

    hqMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (hqLabel) hqLabel.textContent = opt.textContent;
        hqMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        if (el.hqEngineSelect) {
          el.hqEngineSelect.value = val;
          el.hqEngineSelect.dispatchEvent(new Event('change'));
        }
        hqDropdown.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      hqDropdown.classList.remove('open');
    });
  }

  if (el.sliderSpeed) {
    el.sliderSpeed.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.audioSettings.speed = val;
      state.audioSettings.speedPitch = 1.0;
      if (el.sliderSpeedPitch) el.sliderSpeedPitch.value = 1.0;
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = '1.00x';
      if (el.valSpeed) el.valSpeed.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderSpeedPitch) {
    el.sliderSpeedPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseFloat(e.target.value);
      state.audioSettings.speedPitch = val;
      state.audioSettings.speed = 1.0;
      if (el.sliderSpeed) el.sliderSpeed.value = 1.0;
      if (el.valSpeed) el.valSpeed.textContent = '1.00x';
      if (el.valSpeedPitch) el.valSpeedPitch.textContent = `${val.toFixed(2)}x`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderPitch) {
    el.sliderPitch.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.pitch = val;
      if (el.valPitch) el.valPitch.textContent = `${val > 0 ? '+' : ''}${val} st`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderReverb) {
    el.sliderReverb.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.reverb = val;
      if (el.valReverb) el.valReverb.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderDistortion) {
    el.sliderDistortion.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.distortion = val;
      if (el.valDistortion) el.valDistortion.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderGain) {
    el.sliderGain.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.volume = val / 100;
      if (el.valGain) el.valGain.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.sliderEcho) {
    el.sliderEcho.addEventListener('input', (e) => {
      initAudioContext();
      const val = parseInt(e.target.value, 10);
      state.audioSettings.echo = val;
      if (el.valEcho) el.valEcho.textContent = `${val}%`;
      state.activePresetId = null;
      applyAudioSettings();
      renderPresets();
    });
  }

  if (el.themeModeBtns) {
    el.themeModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        state.themeMode = btn.dataset.themeMode;
        localStorage.setItem('riffle_theme_mode', state.themeMode);
        updateThemeFromState();
      });
    });
  }

  if (el.themeSwatches) {
    el.themeSwatches.forEach(sw => {
      sw.addEventListener('click', () => {
        state.themeAccent = sw.dataset.color;
        localStorage.setItem('riffle_theme_accent', state.themeAccent);
        if (state.themeMode === 'auto') {
          const targetMode = currentEffectiveMode || 'dark';
          state.themeMode = targetMode;
          localStorage.setItem('riffle_theme_mode', targetMode);
        }
        updateThemeFromState();
      });
    });
  }

  if (el.customColorInput) {
    el.customColorInput.addEventListener('input', (e) => {
      state.themeAccent = e.target.value;
      localStorage.setItem('riffle_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('riffle_theme_mode', targetMode);
      }
      updateThemeFromState();
    });
  }

  if (el.sliderHue) {
    el.sliderHue.addEventListener('input', (e) => {
      const h = parseInt(e.target.value, 10);
      state.themeAccent = hslToHex(h, 55, 50);
      localStorage.setItem('riffle_theme_accent', state.themeAccent);
      if (state.themeMode === 'auto') {
        const targetMode = currentEffectiveMode || 'dark';
        state.themeMode = targetMode;
        localStorage.setItem('riffle_theme_mode', targetMode);
      }
      updateThemeFromState();
    });
  }

  if (el.sliderIntensity) {
    el.sliderIntensity.addEventListener('input', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeIntensity = val;
      if (el.valIntensity) el.valIntensity.textContent = val + '%';
      localStorage.setItem('riffle_theme_intensity', val.toString());
      updateThemeFromState();
    });
  }
  if (el.sliderBrightness) {
    el.sliderBrightness.addEventListener('input', (e) => {
      if (state.themeMode === 'auto') return;
      const val = parseInt(e.target.value, 10);
      state.themeBrightness = val;
      if (el.valBrightness) el.valBrightness.textContent = val + '%';
      localStorage.setItem('riffle_theme_brightness', val.toString());
      updateThemeFromState();
    });
  }

  if (el.sliderScale) {
    el.sliderScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
    });
    el.sliderScale.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      state.uiScale = val;
      if (el.valScale) el.valScale.textContent = `${val}%`;
      localStorage.setItem('devsize_ui_scale', val.toString());
      requestAnimationFrame(() => {
        applyScale(val);
        requestAnimationFrame(resizeCanvases);
      });
    });
  }

  if (el.sliderFontScale) {
    el.sliderFontScale.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valFontScale) el.valFontScale.textContent = `${val}%`;
      document.documentElement.style.setProperty('--font-scale', (val / 100).toString());
      localStorage.setItem('riffle_font_scale', val.toString());
    });
  }

  if (el.sliderCornerRadius) {
    el.sliderCornerRadius.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (el.valCornerRadius) el.valCornerRadius.textContent = val === 16 ? tr('Default') : `${val}px`;
      document.documentElement.style.setProperty('--md-shape-corner-l', `${val}px`);
      document.documentElement.style.setProperty('--md-shape-corner-m', `${Math.max(0, val - 4)}px`);
      localStorage.setItem('riffle_corner_radius', val.toString());
    });
  }

  const sliderBannerBlur = document.getElementById('slider-banner-blur');
  const valBannerBlur = document.getElementById('val-banner-blur');
  if (sliderBannerBlur) {
    sliderBannerBlur.value = savedBannerBlur;
    if (valBannerBlur) valBannerBlur.textContent = `${savedBannerBlur}px`;
    sliderBannerBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-blur', `${v}px`);
      if (valBannerBlur) valBannerBlur.textContent = `${v}px`;
      localStorage.setItem('riffle_banner_blur', v.toString());
    });
  }

  const sliderBannerOpacity = document.getElementById('slider-banner-opacity');
  const valBannerOpacity = document.getElementById('val-banner-opacity');
  if (sliderBannerOpacity) {
    sliderBannerOpacity.value = savedBannerOpacity;
    if (valBannerOpacity) valBannerOpacity.textContent = `${savedBannerOpacity}%`;
    sliderBannerOpacity.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-opacity', `${v / 100}`);
      if (valBannerOpacity) valBannerOpacity.textContent = `${v}%`;
      localStorage.setItem('riffle_banner_opacity', v.toString());
    });
  }

  const sliderBannerFade = document.getElementById('slider-banner-fade');
  const valBannerFade = document.getElementById('val-banner-fade');
  if (sliderBannerFade) {
    sliderBannerFade.value = savedBannerFade;
    if (valBannerFade) valBannerFade.textContent = `${savedBannerFade}%`;
    sliderBannerFade.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.documentElement.style.setProperty('--banner-fade-base', `${v}%`);
      if (valBannerFade) valBannerFade.textContent = `${v}%`;
      localStorage.setItem('riffle_banner_fade', v.toString());
    });
  }

  const sliderMeshBrightness = document.getElementById('slider-mesh-brightness');
  const valMeshBrightness = document.getElementById('val-mesh-brightness');
  if (sliderMeshBrightness) {
    sliderMeshBrightness.value = state.meshBrightness;
    if (valMeshBrightness) valMeshBrightness.textContent = `${state.meshBrightness}%`;
    sliderMeshBrightness.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      state.meshBrightness = v;
      if (valMeshBrightness) valMeshBrightness.textContent = `${v}%`;
      localStorage.setItem('riffle_mesh_brightness', v.toString());
      updateThemeFromState();
    });
  }

  const paletteDropdown = document.getElementById('palette-style-dropdown');
  const paletteTrigger = document.getElementById('palette-style-trigger');
  const paletteLabel = document.getElementById('palette-style-trigger-label');
  const paletteMenu = document.getElementById('palette-style-menu');
  if (paletteDropdown && paletteTrigger && paletteMenu) {
    const currentStyle = state.paletteStyle || 'classic';
    const styleObj = PALETTE_STYLES[currentStyle] || PALETTE_STYLES.classic;
    if (paletteLabel) paletteLabel.textContent = styleObj.label;
    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === currentStyle);
    });

    paletteTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      paletteDropdown.classList.toggle('open');
    });

    paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        state.paletteStyle = val;
        localStorage.setItem('riffle_palette_style', state.paletteStyle);
        if (paletteLabel) paletteLabel.textContent = opt.textContent;
        paletteMenu.querySelectorAll('.m3-dropdown-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        paletteDropdown.classList.remove('open');
        updateThemeFromState();
      });
    });

    document.addEventListener('click', () => {
      paletteDropdown.classList.remove('open');
    });
  }

  // language: the page reloads to switch, so only one dictionary is ever in memory
  const languageDropdown = document.getElementById('language-dropdown');
  const languageTrigger = document.getElementById('language-trigger');
  const languageLabel = document.getElementById('language-trigger-label');
  const languageMenu = document.getElementById('language-menu');
  if (window.i18n && languageDropdown && languageTrigger && languageMenu) {
    // one option per file in locales/, named in its own language
    for (const [code, name] of Object.entries(window.i18n.languages)) {
      const opt = document.createElement('button');
      opt.className = 'm3-dropdown-option';
      opt.type = 'button';
      opt.dataset.value = code;
      opt.textContent = name;
      languageMenu.appendChild(opt);
    }
    const currentPref = window.i18n.preference();
    languageMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      const selected = opt.dataset.value === currentPref;
      opt.classList.toggle('selected', selected);
      if (selected && languageLabel) languageLabel.textContent = opt.textContent;
    });

    languageTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      languageDropdown.classList.toggle('open');
    });

    languageMenu.querySelectorAll('.m3-dropdown-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        languageDropdown.classList.remove('open');
        if (opt.dataset.value === window.i18n.preference()) return;
        window.i18n.setPreference(opt.dataset.value);
        window.location.reload();
      });
    });

    document.addEventListener('click', () => {
      languageDropdown.classList.remove('open');
    });
  }

  const advButtons = document.querySelectorAll('.effect-switch-btn[data-adv]');
  advButtons.forEach(btn => {
    const key = btn.dataset.adv;
    const defaultVal = key === 'reduce_motion' ? false : true;
    const currentVal = getAdv(key, defaultVal);
    btn.classList.toggle('active', currentVal);

    btn.addEventListener('click', () => {
      const newVal = !btn.classList.contains('active');
      btn.classList.toggle('active', newVal);
      setAdv(key, newVal);

      if (key === 'reduce_motion') {
        applyReducedMotionSetting();
      } else if (key === 'mesh_gradient') {
        updateThemeFromState();
      } else if (key === 'my_wave') {
        const waveSection = document.getElementById('section-my-wave');
        if (waveSection) waveSection.style.display = newVal ? '' : 'none';
        if (newVal) loadHomePage();
      } else if (key === 'my_wave_ambient') {
        const ambientEl = document.getElementById('my-wave-ambient-light');
        if (ambientEl) ambientEl.style.display = newVal ? '' : 'none';
      } else if (key === 'banners') {
        const bannerR = document.getElementById('right-panel-banner');
        const bannerP = document.getElementById('playlist-header-banner');
        if (bannerR) bannerR.style.display = newVal ? '' : 'none';
        if (bannerP) bannerP.style.display = newVal ? '' : 'none';
        if (newVal && state.currentTrack) {
          updateRightPanelBanner(coverOf(state.currentTrack));
        }
      } else if (key === 'karaoke_words') {
        renderLyricsView();
      }
    });
  });


  if (el.btnResetAudio) {
    el.btnResetAudio.addEventListener('click', () => {
      state.activePresetId = 'p_default';
      state.audioSettings = { speed: 1.0, speedPitch: 1.0, pitch: 0, reverb: 0, distortion: 0, volume: 1.0, echo: 0 };
      syncSettingsSlidersToState();
      applyAudioSettings();
      renderPresets();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (syncState.active && e.code === 'Space' && syncState.currentIndex < syncState.lines.length) {
      e.preventDefault();
      handleSyncLineClick(syncState.currentIndex);
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowRight' && el.nativeAudio) {
      e.preventDefault();
      const nextTime = Math.min(el.nativeAudio.duration || 0, el.nativeAudio.currentTime + 5);
      el.nativeAudio.currentTime = nextTime;
    } else if (e.code === 'ArrowLeft' && el.nativeAudio) {
      e.preventDefault();
      const prevTime = Math.max(0, el.nativeAudio.currentTime - 5);
      el.nativeAudio.currentTime = prevTime;
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      state.volume = Math.min(1, state.volume + 0.05);
      savePlayerVolume();
      if (el.volumeSlider) el.volumeSlider.value = state.volume;
      applyAudioSettings();
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      state.volume = Math.max(0, state.volume - 0.05);
      savePlayerVolume();
      if (el.volumeSlider) el.volumeSlider.value = state.volume;
      applyAudioSettings();
    } else if (e.key === 's' || e.key === 'S') {
      if (el.audioSettingsModal) {
        if (el.audioSettingsModal.classList.contains('hidden')) openModal(el.audioSettingsModal);
        else closeModal(el.audioSettingsModal);
      }
    } else if (e.key === 'v' || e.key === 'V') {
      if (el.visualSettingsModal) {
        if (el.visualSettingsModal.classList.contains('hidden')) openModal(el.visualSettingsModal);
        else closeModal(el.visualSettingsModal);
      }
    } else if (e.key === 'f' || e.key === 'F') {
      if (state.currentTrack) toggleFavoriteTrack(state.currentTrack);
    } else if (e.key === 'r' || e.key === 'R') {
      if (el.btnRepeat) el.btnRepeat.click();
    } else if (e.key === 'l' || e.key === 'L') {
      if (el.btnToggleLyricsPanel) el.btnToggleLyricsPanel.click();
    }
  });

  const spotifyApiStatus = document.getElementById('spotify-api-status');
  const spotifyClientId = document.getElementById('spotify-client-id');
  const spotifyClientSecret = document.getElementById('spotify-client-secret');
  const btnSpotifyApiSave = document.getElementById('btn-spotify-api-save');
  const btnSpotifyApiClear = document.getElementById('btn-spotify-api-clear');

  function setSpotifyApiStatus(configured, error) {
    if (!spotifyApiStatus) return;
    spotifyApiStatus.textContent = error
      ? error
      : configured ? tr('Connected: searching the Spotify catalog') : tr('Not configured: using Deezer catalog');
  }

  async function saveSpotifyApiConfig(clientId, clientSecret) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || tr('could not save'));
      setSpotifyApiStatus(data.configured);
      if (spotifyClientSecret) spotifyClientSecret.value = '';
      showToast(data.configured ? tr('Spotify connected') : tr('Spotify keys removed'));
    } catch (e) {
      setSpotifyApiStatus(false, e.message);
    }
  }

  if (spotifyApiStatus) {
    fetch(`http://127.0.0.1:${state.serverPort}/api/spotify-config`)
      .then(r => r.json())
      .then(d => setSpotifyApiStatus(d.configured))
      .catch(() => setSpotifyApiStatus(false));
  }
  if (btnSpotifyApiSave) {
    btnSpotifyApiSave.addEventListener('click', () => {
      const id = (spotifyClientId?.value || '').trim();
      const secret = (spotifyClientSecret?.value || '').trim();
      if (!id || !secret) return setSpotifyApiStatus(false, tr('Fill in both Client ID and Client Secret'));
      if (spotifyApiStatus) spotifyApiStatus.textContent = tr('Checking keys...');
      saveSpotifyApiConfig(id, secret);
    });
  }
  if (btnSpotifyApiClear) {
    btnSpotifyApiClear.addEventListener('click', () => {
      if (spotifyClientId) spotifyClientId.value = '';
      if (spotifyClientSecret) spotifyClientSecret.value = '';
      saveSpotifyApiConfig('', '');
    });
  }

  const btnDiscordRpc = document.getElementById('btn-discord-rpc');
  const badgeDiscordRpc = document.getElementById('badge-discord-rpc');

  function syncDiscordRpcUI() {
    if (btnDiscordRpc) {
      btnDiscordRpc.classList.toggle('active', state.discordRpcEnabled);
      
    }
    if (badgeDiscordRpc) {
      badgeDiscordRpc.textContent = state.discordRpcEnabled ? tr('on') : tr('off');
    }
    const card = document.getElementById('card-discord-rpc');
    if (card) card.classList.toggle('enabled', state.discordRpcEnabled);
  }

  if (btnDiscordRpc) {
    btnDiscordRpc.addEventListener('click', () => {
      state.discordRpcEnabled = !state.discordRpcEnabled;
      localStorage.setItem('devsize_discord_rpc', JSON.stringify(state.discordRpcEnabled));
      if (window.electronAPI && window.electronAPI.discordRpcSetEnabled) {
        window.electronAPI.discordRpcSetEnabled(state.discordRpcEnabled);
      }
      if (state.discordRpcEnabled && state.isPlaying && state.currentTrack) {
        sendDiscordRpcUpdate(state.currentTrack, true);
      }
      syncDiscordRpcUI();
    });
  }

  syncDiscordRpcUI();

  let trackToDownload = null;
  let selectedFormat = 'mp3';
  let selectedQuality = '0';

  function updateDownloadBtnLabel() {
    if (el.downloadBtnText) {
      el.downloadBtnText.textContent = tr('Download {format}', { format: selectedFormat.toUpperCase() });
    }
  }

  function updateLosslessQualityState() {
    const isLossless = selectedFormat === 'flac' || selectedFormat === 'wav';
    const qualityGrid = document.getElementById('quality-chips-grid');
    if (qualityGrid) {
      qualityGrid.classList.toggle('disabled', isLossless);
    }
  }

  function openDownloadModal(track) {
    if (!track || !el.downloadModal) return;
    trackToDownload = track;
    if (el.downloadPreviewTitle) el.downloadPreviewTitle.textContent = track.title || tr('untitled');
    if (el.downloadPreviewArtist) el.downloadPreviewArtist.textContent = track.artist || tr('unknown artist');

    if (track.thumbnail) {
      if (el.downloadPreviewThumb) {
        el.downloadPreviewThumb.src = track.thumbnail;
        el.downloadPreviewThumb.style.display = 'block';
      }
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'none';
    } else {
      if (el.downloadPreviewThumb) el.downloadPreviewThumb.style.display = 'none';
      if (el.downloadPreviewFallback) el.downloadPreviewFallback.style.display = 'flex';
    }

    updateDownloadBtnLabel();
    updateLosslessQualityState();

    const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
    if (btnDeleteOfflineTrack) {
      btnDeleteOfflineTrack.classList.add('hidden');
      if (track && track.id) {
        fetch(`http://127.0.0.1:${state.serverPort}/api/check-cache?id=${encodeURIComponent(track.id)}`)
          .then(r => r.json())
          .then(res => {
            if (res.cached) {
              btnDeleteOfflineTrack.classList.remove('hidden');
            }
          })
          .catch(() => {});
      }
    }

    openModal(el.downloadModal);
  }

  document.querySelectorAll('.format-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.format-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedFormat = chip.dataset.format;
      updateDownloadBtnLabel();
      updateLosslessQualityState();
    });
  });

  document.querySelectorAll('.quality-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.quality-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedQuality = chip.dataset.quality;
    });
  });

  if (el.btnCloseDownloadModal) {
    el.btnCloseDownloadModal.addEventListener('click', () => {
      if (el.downloadModal) closeModal(el.downloadModal);
    });
  }

  if (el.btnCancelDownload) {
    el.btnCancelDownload.addEventListener('click', () => {
      if (el.downloadModal) closeModal(el.downloadModal);
    });
  }

  if (el.btnPlaybarMore) {
    el.btnPlaybarMore.addEventListener('click', () => {
      if (state.currentTrack) {
        openDownloadModal(state.currentTrack);
      } else {
        showToast(tr('No track currently playing'), 'info');
      }
    });
  }

  if (el.btnConfirmDownload) {
    el.btnConfirmDownload.addEventListener('click', async () => {
      if (!trackToDownload) return;
      const t = trackToDownload;

      if (el.downloadBtnText) el.downloadBtnText.textContent = tr('Downloading & converting...');
      el.btnConfirmDownload.disabled = true;

      showToast(tr('Download started: {title} (.{format})', { title: t.title, format: selectedFormat }), 'info');

      try {
        const downloadUrl = `http://127.0.0.1:${state.serverPort}/api/download?url=${encodeURIComponent(t.url || '')}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}&format=${selectedFormat}&quality=${selectedQuality}&id=${encodeURIComponent(t.id || '')}&thumbnail=${encodeURIComponent(t.thumbnail || '')}&duration=${encodeURIComponent(t.duration || 0)}&platform=${encodeURIComponent(t.platform || state.platform || '')}`;
        const res = await fetch(downloadUrl);
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error(text || tr('server error'));
        }

        if (!data.success) throw new Error(data.error || tr('Failed to download'));

        showToast(tr('Download complete: {file} is in Saved songs', { file: data.filename }), 'info');
        loadSavedTracks();
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (err) {
        console.error('Download error:', err);
        showToast(tr('Download failed: {error}', { error: err.message }), 'error');
      } finally {
        el.btnConfirmDownload.disabled = false;
        updateDownloadBtnLabel();
      }
    });
  }

  updateFavoritesBadge();
  renderPlaylistsList();
  renderPresets();
  syncSettingsSlidersToState();
  applyVisualEffects();

  const analysisCache = new Map();
  let myWaveCurrentTracks = [];
  let isExtendingMyWave = false;

  function getCachedTrackAnalysis(trackId) {
    if (!trackId) return null;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (analysisCache.has(cleanId)) return analysisCache.get(cleanId);
    try {
      const stored = localStorage.getItem(`riffle_audio_analysis_${cleanId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        analysisCache.set(cleanId, parsed);
        return parsed;
      }
    } catch (e) {}
    return null;
  }

  function setCachedTrackAnalysis(trackId, analysis) {
    if (!trackId || !analysis) return;
    const cleanId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    analysisCache.set(cleanId, analysis);
    try {
      localStorage.setItem(`riffle_audio_analysis_${cleanId}`, JSON.stringify(analysis));
      fetch(`http://127.0.0.1:${state.serverPort}/api/track-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cleanId, analysis })
      }).catch(() => {});
    } catch (e) {}
  }

  async function computeTasteProfile() {
    const seeds = (state.favorites || []).slice(0, 25);
    const artistCounts = {};
    let cyrillicCount = 0;
    const durations = [];

    seeds.forEach(track => {
      if (track.artist && track.artist.trim()) {
        const a = track.artist.trim();
        artistCounts[a] = (artistCounts[a] || 0) + 1;
      }
      if (track.title && /[\u0400-\u04FF]/.test(track.title)) {
        cyrillicCount++;
      }
      if (track.duration > 0) {
        durations.push(track.duration);
      }
    });

    const sortedArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    const dominantScript = cyrillicCount > seeds.length * 0.35 ? 'Cyrillic' : 'Latin';
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    return {
      trackCount: seeds.length,
      topArtists: sortedArtists.slice(0, 5),
      dominantScript,
      avgDuration,
      bpmLabel: null,
      energyLabel: null
    };
  }

  function renderMyWaveChips(profile) {
    const chipsContainer = document.getElementById('my-wave-chips');
    if (chipsContainer) chipsContainer.innerHTML = '';
  }

  function getTrackNormalizedKey(artist, title) {
    let a = String(artist || '').toLowerCase();
    let t = String(title || '').toLowerCase();
    t = t.replace(/\s*\([^)]*official[^)]*\)/gi, '')
         .replace(/\s*\[[^\]]*\]/gi, '')
         .replace(/\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)/gi, '');
    t = t.replace(/\s*(feat\.?|ft\.?)\s+[^(\[-]+/gi, '')
         .replace(/\s*\((feat\.?|ft\.?)[^)]*\)/gi, '');
    a = a.replace(/\s*(feat\.?|ft\.?)\s+.*$/gi, '');
    a = a.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return `${a}::${t}`;
  }

  const dominantColorsCache = new Map();

  function getCoverDominantColors(url) {
    if (!url) return Promise.resolve(['rgb(80, 80, 120)', 'rgb(120, 80, 100)']);
    if (dominantColorsCache.has(url)) {
      return Promise.resolve(dominantColorsCache.get(url));
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;

          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness < 30 || brightness > 230) continue;

            const qr = Math.round(r / 32) * 32;
            const qg = Math.round(g / 32) * 32;
            const qb = Math.round(b / 32) * 32;
            const key = `${qr},${qg},${qb}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }

          const sorted = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
          const c1 = sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(80, 100, 140)';
          const c2 = sorted[1] ? `rgb(${sorted[1][0]})` : sorted[0] ? `rgb(${sorted[0][0]})` : 'rgb(140, 80, 100)';

          const result = [c1, c2];
          dominantColorsCache.set(url, result);
          canvas.width = 0;
          canvas.height = 0;
          img.onload = null;
          img.onerror = null;
          img.src = '';
          resolve(result);
        } catch (e) {
          const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
          dominantColorsCache.set(url, fallback);
          img.onload = null;
          img.onerror = null;
          resolve(fallback);
        }
      };
      img.onerror = () => {
        const fallback = ['rgb(80, 100, 140)', 'rgb(140, 80, 100)'];
        dominantColorsCache.set(url, fallback);
        img.onload = null;
        img.onerror = null;
        resolve(fallback);
      };
      img.src = url;
    });
  }

  async function updateAmbientLight(thumbnailUrl) {
    const ambientEl = document.getElementById('my-wave-ambient-light');
    if (!ambientEl) return;
    if (!getAdv('my_wave_ambient', true)) {
      ambientEl.style.display = 'none';
      return;
    }
    ambientEl.style.display = '';
    const [c1, c2] = await getCoverDominantColors(thumbnailUrl);
    ambientEl.style.background = `radial-gradient(circle at 35% 35%, ${c1} 0%, transparent 70%), radial-gradient(circle at 65% 65%, ${c2} 0%, transparent 70%)`;
  }

  let currentWaveFocusedIndex = 0;

  async function extendMyWaveQueue() {
    if (!state.myWaveActive || isExtendingMyWave) return false;
    isExtendingMyWave = true;
    try {
      const profile = await computeTasteProfile();
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: state.history.slice(0, 30),
          favorites: state.favorites.slice(0, 25),
          platform: 'soundcloud',
          limit: 8,
          clientProfile: profile
        })
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.tracks) && data.tracks.length > 0) {
        const existingIds = new Set(state.queue.map(t => getTrackCanonicalId(t)));
        const existingKeys = new Set(state.queue.map(t => getTrackNormalizedKey(t.artist, t.title)));
        const newTracks = data.tracks.filter(t => {
          const cid = getTrackCanonicalId(t);
          const nkey = getTrackNormalizedKey(t.artist, t.title);
          return !existingIds.has(cid) && !existingKeys.has(nkey);
        });
        if (newTracks.length > 0) {
          state.queue.push(...newTracks);
          updateQueueBadge();
          renderQueueView();
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      isExtendingMyWave = false;
    }
  }

  const btnPlayMyWave = document.getElementById('btn-play-my-wave');
  if (btnPlayMyWave) {
    btnPlayMyWave.addEventListener('click', async () => {
      if (!myWaveCurrentTracks || myWaveCurrentTracks.length === 0) {
        const profile = await computeTasteProfile();
        if (profile.trackCount < 5) {
          showToast(tr('Save at least 5 tracks to tune My Wave'));
          return;
        }
        await loadHomePage();
      }
      if (myWaveCurrentTracks && myWaveCurrentTracks.length > 0) {
        state.myWaveActive = true;
        const startIdx = (currentWaveFocusedIndex >= 0 && currentWaveFocusedIndex < myWaveCurrentTracks.length) ? currentWaveFocusedIndex : 0;
        playTrack(myWaveCurrentTracks[startIdx], [...myWaveCurrentTracks], startIdx);
        showToast(tr('Playing My Wave'));
      }
    });
  }

  if (el.btnRefreshVibe) {
    el.btnRefreshVibe.addEventListener('click', loadHomePage);
  }

  function updateCoverflowCards() {
    const vibeGrid = document.getElementById('home-vibe-grid');
    if (!vibeGrid || myWaveCurrentTracks.length === 0) return;
    const cards = vibeGrid.querySelectorAll('.my-wave-track-card');
    if (cards.length === 0) return;

    const floatIndex = vibeGrid.scrollLeft / 304;
    const newFocused = Math.max(0, Math.min(cards.length - 1, Math.round(floatIndex)));

    cards.forEach((card, j) => {
      const dist = j - floatIndex;
      if (Math.abs(dist) <= 3.5) {
        const factor = Math.max(0, 1 - Math.min(1, Math.abs(dist)));
        const scale = (0.82 + 0.18 * factor).toFixed(3);
        const opacity = (0.55 + 0.45 * factor).toFixed(3);
        const zIndex = String(Math.round(10 - Math.abs(dist)));
        const targetTransform = `scale(${scale})`;
        if (card.style.transform !== targetTransform) card.style.transform = targetTransform;
        if (card.style.opacity !== opacity) card.style.opacity = opacity;
        if (card.style.zIndex !== zIndex) card.style.zIndex = zIndex;
      } else {
        if (card.style.transform !== 'scale(0.82)') card.style.transform = 'scale(0.82)';
        if (card.style.opacity !== '0.55') card.style.opacity = '0.55';
        if (card.style.zIndex !== '1') card.style.zIndex = '1';
      }
    });

    if (newFocused !== currentWaveFocusedIndex && myWaveCurrentTracks[newFocused]) {
      currentWaveFocusedIndex = newFocused;
      const track = myWaveCurrentTracks[newFocused];
      const focusedTitle = document.getElementById('my-wave-focused-title');
      const focusedArtist = document.getElementById('my-wave-focused-artist');
      if (focusedTitle && focusedArtist) {
        focusedTitle.style.opacity = '0';
        focusedArtist.style.opacity = '0';
        setTimeout(() => {
          focusedTitle.textContent = track.title || tr('Untitled');
          focusedArtist.textContent = track.artist || tr('Unknown');
          focusedTitle.style.opacity = '1';
          focusedArtist.style.opacity = '1';
        }, 150);
      }
      updateAmbientLight(track.thumbnail);
    }
  }

  let waveTargetScroll = 0;
  let isWaveWheeling = false;
  let waveIdleSnapTimer = null;

  function startWaveScrollAnimation() {
    const vibeGrid = document.getElementById('home-vibe-grid');
    if (!vibeGrid || isWaveWheeling) return;
    const maxScroll = Math.max(0, vibeGrid.scrollWidth - vibeGrid.clientWidth);
    waveTargetScroll = Math.max(0, Math.min(maxScroll, waveTargetScroll));
    isWaveWheeling = true;
    let prevScroll = -1;
    let stalledFrames = 0;
    const animate = () => {
      const currentMax = Math.max(0, vibeGrid.scrollWidth - vibeGrid.clientWidth);
      const target = Math.max(0, Math.min(currentMax, waveTargetScroll));
      const diff = target - vibeGrid.scrollLeft;
      if (Math.abs(diff) < 0.5) {
        vibeGrid.scrollLeft = target;
        updateCoverflowCards();
        isWaveWheeling = false;
        return;
      }
      if (Math.abs(vibeGrid.scrollLeft - prevScroll) < 0.1) {
        stalledFrames++;
        if (stalledFrames >= 2) {
          vibeGrid.scrollLeft = target;
          updateCoverflowCards();
          isWaveWheeling = false;
          return;
        }
      } else {
        stalledFrames = 0;
      }
      prevScroll = vibeGrid.scrollLeft;
      vibeGrid.scrollLeft += diff * 0.14;
      updateCoverflowCards();
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  async function loadHomePage() {
    const quickRow = document.getElementById('home-quick-play-row');
    if (quickRow) {
      quickRow.innerHTML = '';
      const recent = state.history.slice(0, 6);
      if (recent.length === 0) {
        quickRow.innerHTML = `<span style="font-size:calc(12px * var(--font-scale, 1));color:var(--md-sys-color-outline)">${tr('Play some tracks to see them here')}</span>`;
      } else {
        recent.forEach((t, idx) => {
          const pill = document.createElement('button');
          pill.className = 'quick-play-pill';
          pill.style.animationDelay = (idx * 60) + 'ms';
          pill.innerHTML = `
          <img class="quick-play-pill-img" src="${smallThumb(coverOf(t))}" alt="" decoding="async" onerror="this.style.visibility='hidden'">
          <div class="quick-play-pill-text">
          <span class="quick-play-pill-title">${(t.title || 'untitled')}</span>
          <span class="quick-play-pill-artist">${(t.artist || '')}</span>
          </div>
          `;
          pill.addEventListener('click', () => {
            state.myWaveActive = false;
            playTrack(t, recent);
          });
          quickRow.appendChild(pill);
        });
      }
    }

    const waveSection = document.getElementById('section-my-wave');
    if (waveSection) {
      waveSection.style.display = getAdv('my_wave', true) ? '' : 'none';
    }
    if (!getAdv('my_wave', true)) {
      return;
    }

    const vibeGrid = document.getElementById('home-vibe-grid');
    const focusedMeta = document.getElementById('my-wave-focused-meta');

    if (focusedMeta) {
      focusedMeta.innerHTML = `
        <div class="my-wave-skeleton-title-bar skeleton-shimmer"></div>
        <div class="my-wave-skeleton-artist-bar skeleton-shimmer"></div>
      `;
    }

    if (vibeGrid) {
      vibeGrid.style.opacity = '1';
      vibeGrid.innerHTML = Array.from({ length: 6 }).map(() => `
        <div class="my-wave-skeleton-card skeleton-shimmer">
          <div class="my-wave-skeleton-cover"></div>
        </div>
      `).join('');

      const profile = await computeTasteProfile();

      if (profile.trackCount < 5) {
        if (focusedMeta) focusedMeta.innerHTML = '';
        vibeGrid.innerHTML = `<div class="vibe-empty-hint">${tr('Save at least 5 tracks to tune My Wave to your taste.')}</div>`;
        myWaveCurrentTracks = [];
        return;
      }

      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/vibe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            history: state.history.slice(0, 30),
            favorites: state.favorites.slice(0, 25),
            platform: 'soundcloud',
            limit: 10,
            clientProfile: profile
          })
        });

        const data = await res.json();
        if (!data.success || !data.tracks || data.tracks.length === 0) {
          if (focusedMeta) focusedMeta.innerHTML = '';
          vibeGrid.innerHTML = `<div class="vibe-empty-hint">${tr('No wave recommendations available right now.')}</div>`;
          myWaveCurrentTracks = [];
          return;
        }

        const seenIds = new Set();
        const seenKeys = new Set();
        const uniqueTracks = [];
        for (const t of data.tracks) {
          const cid = getTrackCanonicalId(t);
          const nkey = getTrackNormalizedKey(t.artist, t.title);
          if (!seenIds.has(cid) && !seenKeys.has(nkey)) {
            seenIds.add(cid);
            seenKeys.add(nkey);
            uniqueTracks.push(t);
          }
        }

        myWaveCurrentTracks = uniqueTracks;
        currentWaveFocusedIndex = 0;

        vibeGrid.style.opacity = '0';
        setTimeout(() => {
          vibeGrid.innerHTML = '';
          const fragment = document.createDocumentFragment();

          myWaveCurrentTracks.forEach((track, idx) => {
            const card = document.createElement('div');
            card.className = 'my-wave-track-card';
            card.dataset.index = String(idx);
            card.innerHTML = `
              <div class="my-wave-track-cover-wrap">
                <img class="my-wave-track-cover" src="${coverOf(track)}" alt="" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'280\\' height=\\'280\\' fill=\\'%23555\\'><rect width=\\'100%\\' height=\\'100%\\'/></svg>'">
                <div class="my-wave-track-play-overlay">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </div>
              </div>
              <div class="my-wave-track-meta">
                <span class="my-wave-track-title">${track.title || tr('Untitled')}</span>
                <span class="my-wave-track-artist">${track.artist || 'Unknown'}</span>
              </div>
            `;

            card.addEventListener('click', () => {
              if (idx === currentWaveFocusedIndex) {
                state.myWaveActive = true;
                const waveQueue = [...myWaveCurrentTracks];
                playTrack(track, waveQueue, idx);
              } else {
                const maxScroll = Math.max(0, vibeGrid.scrollWidth - vibeGrid.clientWidth);
                waveTargetScroll = Math.max(0, Math.min(maxScroll, idx * 304));
                startWaveScrollAnimation();
              }
            });

            fragment.appendChild(card);
          });

          vibeGrid.appendChild(fragment);

          if (focusedMeta && myWaveCurrentTracks[0]) {
            focusedMeta.innerHTML = `
              <div class="my-wave-focused-title" id="my-wave-focused-title">${myWaveCurrentTracks[0].title || tr('Untitled')}</div>
              <div class="my-wave-focused-artist" id="my-wave-focused-artist">${myWaveCurrentTracks[0].artist || 'Unknown'}</div>
            `;
            updateAmbientLight(myWaveCurrentTracks[0].thumbnail);
          }

          vibeGrid.scrollLeft = 0;
          waveTargetScroll = 0;
          vibeGrid.style.opacity = '1';
          updateCoverflowCards();
        }, 100);
      } catch (err) {
        if (focusedMeta) focusedMeta.innerHTML = '';
        vibeGrid.innerHTML = `<div class="vibe-empty-hint">${tr('Could not connect to wave recommendations.')}</div>`;
        myWaveCurrentTracks = [];
      }
    }
  }

  const vibeGridEl = document.getElementById('home-vibe-grid');
  if (vibeGridEl) {
    vibeGridEl.addEventListener('wheel', (e) => {
      const maxScroll = vibeGridEl.scrollWidth - vibeGridEl.clientWidth;
      if (maxScroll <= 0) return;

      const delta = e.deltaY + e.deltaX;
      if (delta === 0) return;

      const canScrollRight = delta > 0 && vibeGridEl.scrollLeft < maxScroll - 1;
      const canScrollLeft = delta < 0 && vibeGridEl.scrollLeft > 1;

      if (canScrollRight || canScrollLeft) {
        e.preventDefault();
        clearTimeout(waveIdleSnapTimer);

        const step = 304;
        if (Math.abs(delta) >= 30) {
          const dir = delta > 0 ? 1 : -1;
          const currentTrack = Math.round(waveTargetScroll / step);
          const nextTrack = Math.max(0, Math.min(myWaveCurrentTracks.length - 1, currentTrack + dir));
          waveTargetScroll = Math.max(0, Math.min(maxScroll, nextTrack * step));
        } else {
          waveTargetScroll = Math.max(0, Math.min(maxScroll, waveTargetScroll + delta * 2.5));
          waveIdleSnapTimer = setTimeout(() => {
            const nearest = Math.max(0, Math.min(myWaveCurrentTracks.length - 1, Math.round(vibeGridEl.scrollLeft / step)));
            waveTargetScroll = nearest * step;
            startWaveScrollAnimation();
          }, 180);
        }

        startWaveScrollAnimation();
      } else {
        waveTargetScroll = vibeGridEl.scrollLeft;
      }
    }, { passive: false });

    vibeGridEl.addEventListener('scroll', () => {
      if (!isWaveWheeling) {
        waveTargetScroll = vibeGridEl.scrollLeft;
        updateCoverflowCards();
      }
    }, { passive: true });
  }

  const cacheModal = document.getElementById('cache-modal');
  const cacheModalCard = document.querySelector('.cache-modal-card');
  const btnCancelCache = document.getElementById('btn-cancel-cache');
  const btnConfirmClearCache = document.getElementById('btn-confirm-clear-cache');
  const cacheAudioSize = document.getElementById('cache-audio-size');
  const cacheWebSize = document.getElementById('cache-web-size');

  const CACHE_BAR_MAX_BYTES = 4 * 1024 * 1024 * 1024;
  const CACHE_BAR_SAFE_STOP = 0.25;
  const CACHE_BAR_DANGER_STOP = 0.75;
  const CACHE_BAR_MIN_VISIBLE_PX = 4;

  const cacheBars = {
    audio: { canvas: document.getElementById('cache-audio-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 },
    web: { canvas: document.getElementById('cache-web-bar'), current: 0, from: 0, to: 0, t0: 0, dur: 0 }
  };
  let cacheRafId = 0;
  let cachePhase = 0;
  let cacheSpeed = 0.06;
  let cacheTargetSpeed = 0.06;
  let cacheBusy = false;
  let cacheColors = { primary: '#6750A4', dim: '#E6E0E9', warn: '#F9A825', error: '#B3261E' };

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      obj.textContent = formatBytes(Math.floor(progress * (end - start) + start));
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }

  const cacheWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function readCacheColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      primary: rootStyle.getPropertyValue('--md-sys-color-primary').trim() || '#6750A4',
      dim: rootStyle.getPropertyValue('--md-sys-color-surface-container-highest-solid').trim() || '#E6E0E9',
      warn: '#F9A825',
      error: rootStyle.getPropertyValue('--md-sys-color-error').trim() || '#B3261E'
    };
  }

  function setCacheBarTarget(bar, bytes, duration) {
    bar.from = bar.current;
    bar.to = bytes;
    bar.t0 = performance.now();
    bar.dur = duration;
  }

  function drawCacheBar(canvas, bytes, phase) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const lineW = 6;
    const pad = lineW / 2;
    const centerY = h / 2;
    const usable = Math.max(1, w - lineW);

    ctx.lineWidth = lineW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pad, centerY);
    ctx.lineTo(w - pad, centerY);
    ctx.strokeStyle = cacheColors.dim;
    ctx.stroke();

    if (bytes <= 0) return;
    const frac = Math.min(1, Math.max(0, bytes / CACHE_BAR_MAX_BYTES));
    const fillW = Math.max(frac * usable, CACHE_BAR_MIN_VISIBLE_PX);
    const endX = pad + fillW;

    const grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
    grad.addColorStop(0, cacheColors.primary);
    grad.addColorStop(CACHE_BAR_SAFE_STOP, cacheColors.primary);
    grad.addColorStop((CACHE_BAR_SAFE_STOP + CACHE_BAR_DANGER_STOP) / 2, cacheColors.warn);
    grad.addColorStop(CACHE_BAR_DANGER_STOP, cacheColors.error);
    grad.addColorStop(1, cacheColors.error);

    const amplitude = 4;
    const freq = 0.12;
    ctx.beginPath();
    for (let x = pad; x <= endX; x++) {
      const distFromEnd = endX - x;
      const damping = Math.min(1, distFromEnd / 14);
      const distFromStart = x - pad;
      const startDamping = Math.min(1, distFromStart / 14);
      const snakeWave = Math.sin(x * freq - phase) + 0.4 * Math.sin(x * freq * 0.5 - phase * 1.5);
      const y = centerY + snakeWave * (amplitude * damping * startDamping);
      if (x === pad) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

  function cacheFrame(now) {
    cacheSpeed += (cacheTargetSpeed - cacheSpeed) * 0.08;
    cachePhase += cacheSpeed;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      if (bar.dur > 0) {
        const p = Math.min(1, (now - bar.t0) / bar.dur);
        const ease = 1 - Math.pow(1 - p, 3);
        bar.current = bar.from + (bar.to - bar.from) * ease;
        if (p >= 1) bar.dur = 0;
      }
      drawCacheBar(bar.canvas, bar.current, cachePhase);
    });
    cacheRafId = requestAnimationFrame(cacheFrame);
  }

  function closeCacheModal() {
    if (!cacheModal) return;
    cacheModal.classList.remove('visible');
    setTimeout(() => {
      if (cacheModal.classList.contains('visible')) return;
      cacheModal.classList.add('hidden');
      if (cacheRafId) {
        cancelAnimationFrame(cacheRafId);
        cacheRafId = 0;
      }
      if (cacheModalCard) cacheModalCard.classList.remove('cleaning', 'finishing', 'done');
      if (btnConfirmClearCache) btnConfirmClearCache.disabled = false;
      if (btnCancelCache) btnCancelCache.disabled = false;
    }, 200);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#btn-open-clear-cache');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (!cacheModal || cacheBusy) return;

    cacheColors = readCacheColors();
    cacheSpeed = 0.06;
    cacheTargetSpeed = 0.06;
    Object.keys(cacheBars).forEach((key) => {
      const bar = cacheBars[key];
      bar.current = 0;
      bar.from = 0;
      bar.to = 0;
      bar.dur = 0;
    });
    if (cacheAudioSize) { cacheAudioSize.textContent = tr('calculating...'); cacheAudioSize.dataset.val = '0'; }
    if (cacheWebSize) { cacheWebSize.textContent = tr('calculating...'); cacheWebSize.dataset.val = '0'; }

    cacheModal.classList.remove('hidden');
    requestAnimationFrame(() => cacheModal.classList.add('visible'));
    if (!cacheRafId) cacheRafId = requestAnimationFrame(cacheFrame);

    let sizes = { audio: 0, web: 0 };
    try {
      if (window.electronAPI && window.electronAPI.getCacheSize) {
        sizes = await window.electronAPI.getCacheSize();
      }
    } catch (err) {
      console.warn('getCacheSize failed', err);
    }
    if (cacheAudioSize) { cacheAudioSize.textContent = formatBytes(sizes.audio); cacheAudioSize.dataset.val = String(sizes.audio); }
    if (cacheWebSize) { cacheWebSize.textContent = formatBytes(sizes.web); cacheWebSize.dataset.val = String(sizes.web); }
    setCacheBarTarget(cacheBars.audio, sizes.audio, 900);
    setCacheBarTarget(cacheBars.web, sizes.web, 900);
  });

  if (btnCancelCache) {
    btnCancelCache.addEventListener('click', () => {
      if (cacheBusy) return;
      closeCacheModal();
    });
  }

  if (btnConfirmClearCache) {
    btnConfirmClearCache.addEventListener('click', async () => {
      if (cacheBusy) return;
      cacheBusy = true;
      btnConfirmClearCache.disabled = true;
      if (btnCancelCache) btnCancelCache.disabled = true;

      cacheModalCard.classList.add('cleaning');
      cacheTargetSpeed = 0.2;

      const startAudio = parseInt(cacheAudioSize.dataset.val || '0', 10);
      const startWeb = parseInt(cacheWebSize.dataset.val || '0', 10);
      animateValue(cacheAudioSize, startAudio, 0, 1500);
      animateValue(cacheWebSize, startWeb, 0, 1500);
      setCacheBarTarget(cacheBars.audio, 0, 1500);
      setCacheBarTarget(cacheBars.web, 0, 1500);

      const startedAt = Date.now();
      try {
        await window.electronAPI.clearCache();
      } catch (err) {
        console.warn('clearCache failed', err);
      }
      await cacheWait(Math.max(0, 1500 - (Date.now() - startedAt)));

      cacheModalCard.classList.add('finishing');
      cacheTargetSpeed = 0;
      await cacheWait(350);

      cacheModalCard.classList.remove('cleaning', 'finishing');
      cacheModalCard.classList.add('done');
      cacheAudioSize.dataset.val = '0';
      cacheWebSize.dataset.val = '0';
      await cacheWait(1200);

      cacheBusy = false;
      closeCacheModal();
    });
  }

  async function updateOfflineStorageUI() {
    const elSize = document.getElementById('offline-library-size');
    if (!elSize) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-library`);
      const data = await res.json();
      if (data && data.success) {
        elSize.textContent = trn(data.count, '{n} track ({size})', '{n} tracks ({size})', { size: formatBytes(data.totalBytes) });
      } else {
        elSize.textContent = trn(0, '{n} track ({size})', '{n} tracks ({size})', { size: '0 B' });
      }
    } catch (e) {
      elSize.textContent = tr('Unavailable');
    }
  }

  const btnDeleteOfflineTrack = document.getElementById('btn-delete-offline-track');
  if (btnDeleteOfflineTrack) {
    btnDeleteOfflineTrack.addEventListener('click', async () => {
      if (!trackToDownload || !trackToDownload.id) return;
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/offline-delete?id=${encodeURIComponent(trackToDownload.id)}`, { method: 'POST' });
        showToast(tr('Track removed from offline cache'));
        updateOfflineStorageUI();
        if (el.downloadModal) closeModal(el.downloadModal);
      } catch (e) {
        showToast(tr('Failed to delete offline track'));
      }
    });
  }

  const btnClearOffline = document.getElementById('btn-clear-offline');
  const clearOfflineModal = document.getElementById('clear-offline-modal');
  const btnCancelClearOffline = document.getElementById('btn-cancel-clear-offline');
  const btnConfirmClearOffline = document.getElementById('btn-confirm-clear-offline');

  if (btnClearOffline && clearOfflineModal) {
    btnClearOffline.addEventListener('click', () => {
      openModal(clearOfflineModal);
    });
  }
  if (btnCancelClearOffline && clearOfflineModal) {
    btnCancelClearOffline.addEventListener('click', () => {
      closeModal(clearOfflineModal);
    });
  }
  if (btnConfirmClearOffline && clearOfflineModal) {
    btnConfirmClearOffline.addEventListener('click', async () => {
      try {
        await fetch(`http://127.0.0.1:${state.serverPort}/api/clear-offline-library`, { method: 'POST' });
        showToast(tr('Offline library cleared'));
        updateOfflineStorageUI();
      } catch (e) {
        showToast(tr('Failed to clear offline library'));
      }
      closeModal(clearOfflineModal);
    });
  }

  let toolsPollInterval = null;

  function updateToolsUI(data) {
    const statusText = document.getElementById('tools-status-text');
    const btnInstall = document.getElementById('btn-install-tools');
    if (!statusText || !data) return;

    if (data.progress && data.progress.status === 'downloading') {
      const tool = data.progress.tool || 'yt-dlp';
      const pct = data.progress.percent || 0;
      statusText.textContent = tr('Downloading {tool} {pct}%', { tool, pct });
      if (btnInstall) {
        btnInstall.classList.remove('hidden');
        btnInstall.disabled = true;
      }
      return;
    }

    if (data.ytDlp && data.ffmpeg) {
      statusText.textContent = tr('Installed');
      if (btnInstall) {
        btnInstall.classList.add('hidden');
        btnInstall.disabled = false;
      }
    } else {
      const missing = [];
      if (!data.ytDlp) missing.push('yt-dlp');
      if (!data.ffmpeg) missing.push('ffmpeg');
      statusText.textContent = tr('Missing: {list}', { list: missing.join(', ') });
      if (btnInstall) {
        btnInstall.classList.remove('hidden');
        btnInstall.disabled = false;
      }
    }
  }

  function pollToolsStatus() {
    if (toolsPollInterval) return;
    toolsPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools-status`);
        const data = await res.json();
        updateToolsUI(data);
        if (data.progress && (data.progress.status === 'done' || data.progress.status === 'error')) {
          clearInterval(toolsPollInterval);
          toolsPollInterval = null;
          if (data.progress.status === 'error' && data.progress.error) {
            showToast(data.progress.error, 'error');
          }
        }
      } catch (e) {}
    }, 500);
  }

  function startToolsInstall() {
    const btnInstall = document.getElementById('btn-install-tools');
    if (btnInstall) btnInstall.disabled = true;
    fetch(`http://127.0.0.1:${state.serverPort}/api/tools-install`, { method: 'POST' }).catch(() => {});
    pollToolsStatus();
  }

  async function checkToolsStatus(promptUser = false) {
    if (!state.serverPort) return;
    try {
      const res = await fetch(`http://127.0.0.1:${state.serverPort}/api/tools-status`);
      const data = await res.json();
      updateToolsUI(data);

      if (data.progress && data.progress.status === 'downloading') {
        pollToolsStatus();
      } else if (promptUser && (!data.ytDlp || !data.ffmpeg)) {
        if (!sessionStorage.getItem('riffle_tools_prompt_dismissed')) {
          const modal = document.getElementById('tools-install-modal');
          if (modal) openModal(modal);
        }
      }
    } catch (e) {}
  }

  const btnInstallTools = document.getElementById('btn-install-tools');
  if (btnInstallTools) {
    btnInstallTools.addEventListener('click', () => {
      startToolsInstall();
    });
  }

  const toolsModal = document.getElementById('tools-install-modal');
  const btnConfirmInstallTools = document.getElementById('btn-confirm-install-tools');
  const btnDismissToolsModal = document.getElementById('btn-dismiss-tools-modal');

  if (btnConfirmInstallTools && toolsModal) {
    btnConfirmInstallTools.addEventListener('click', () => {
      closeModal(toolsModal);
      startToolsInstall();
    });
  }

  if (btnDismissToolsModal && toolsModal) {
    btnDismissToolsModal.addEventListener('click', () => {
      sessionStorage.setItem('riffle_tools_prompt_dismissed', '1');
      closeModal(toolsModal);
    });
  }

  if (window.electronAPI && window.electronAPI.onUpdateAvailable) {
    let userTriggeredUpdate = false;
    let activeUpdateToast = null;

    window.electronAPI.onUpdateAvailable((d) => {
      let actions = [];
      if (d.canInstall) {
        actions = [
          {
            label: tr('Update now'),
            primary: true,
            onClick: () => {
              userTriggeredUpdate = true;
              window.electronAPI.updateAction('now');
              if (activeUpdateToast) activeUpdateToast.setText(tr('Downloading update {pct}%', { pct: 0 }));
            }
          },
          {
            label: tr('On next launch'),
            primary: false,
            onClick: () => {
              window.electronAPI.updateAction('later');
              if (activeUpdateToast) activeUpdateToast.close();
              showToast(tr('The update will install when you quit Riffle'));
            }
          },
          {
            label: tr('Ignore'),
            primary: false,
            onClick: () => {
              window.electronAPI.updateAction('ignore');
              if (activeUpdateToast) activeUpdateToast.close();
            }
          }
        ];
      } else {
        actions = [
          {
            label: tr('Open release page'),
            primary: true,
            onClick: () => {
              window.open(d.url);
            }
          },
          {
            label: tr('Ignore'),
            primary: false,
            onClick: () => {
              window.electronAPI.updateAction('ignore');
              if (activeUpdateToast) activeUpdateToast.close();
            }
          }
        ];
      }

      activeUpdateToast = showToast(tr('Riffle {version} is available', { version: d.version }), 'info', { actions, persistent: true });
    });

    if (window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress((p) => {
        if (activeUpdateToast) activeUpdateToast.setText(tr('Downloading update {pct}%', { pct: p.percent }));
        else showToast(tr('A new version is downloading in the background'));
      });
    }

    if (window.electronAPI.onUpdateReady) {
      window.electronAPI.onUpdateReady((d) => {
        if (activeUpdateToast) activeUpdateToast.close();
        activeUpdateToast = showToast(tr('Riffle {version} is ready. It installs when you quit, or restart now.', { version: (d && d.version) || '' }), 'info', {
          persistent: true,
          actions: [
            { label: tr('Restart now'), primary: true, onClick: () => window.electronAPI.updateAction('restart') },
            { label: tr('Later'), primary: false, onClick: () => { if (activeUpdateToast) activeUpdateToast.close(); } }
          ]
        });
      });
    }

    if (window.electronAPI.onUpdateError) {
      window.electronAPI.onUpdateError((e) => {
        if (activeUpdateToast) activeUpdateToast.close();
        if (userTriggeredUpdate) {
          showToast(e && e.message ? e.message : tr('Update failed'), 'error');
        }
      });
    }

    if (window.electronAPI.onUpdateNotAvailable) {
      window.electronAPI.onUpdateNotAvailable(() => {
        showToast(tr('You are up to date'));
      });
    }

    const btnCheckUpdates = document.getElementById('btn-check-updates');
    if (btnCheckUpdates) {
      btnCheckUpdates.addEventListener('click', () => {
        userTriggeredUpdate = true;
        if (window.electronAPI.checkForUpdates) {
          window.electronAPI.checkForUpdates();
        }
      });
    }

    if (window.electronAPI.getAppVersion) {
      window.electronAPI.getAppVersion().then((version) => {
        const elAboutVersion = document.getElementById('about-version');
        if (elAboutVersion) elAboutVersion.textContent = tr('Version {version}', { version });
        const elCreditsVersion = document.getElementById('credits-version');
        if (elCreditsVersion) elCreditsVersion.textContent = 'v' + version;
      }).catch(() => {});
    }
  }

  const btnDownloadEditTrack = document.getElementById('btn-download-edit-track');
  if (btnDownloadEditTrack) btnDownloadEditTrack.addEventListener('click', () => {
    const track = trackToDownload;
    if (el.downloadModal) closeModal(el.downloadModal);
    if (track) setTimeout(() => openTrackRenameDialog(track), 180);
  });

  // ---- appearance -------------------------------------------------------------------------

  // panel and text opacity sliders; double-click puts them back to 100%
  function bindOpacitySlider(sliderId, valueId, key, min) {
    const slider = document.getElementById(sliderId);
    const value = document.getElementById(valueId);
    if (!slider) return;
    const show = (v) => { slider.value = v; if (value) value.textContent = `${v}%`; };
    show(readPercent(key, min));
    const set = (v) => {
      show(v);
      localStorage.setItem(key, String(v));
      applyTranslucency();
    };
    slider.addEventListener('input', () => set(parseInt(slider.value, 10)));
    slider.addEventListener('dblclick', () => set(100));
  }
  bindOpacitySlider('slider-ui-alpha', 'val-ui-alpha', 'riffle_ui_alpha', 20);
  bindOpacitySlider('slider-text-alpha', 'val-text-alpha', 'riffle_text_alpha', 10);

  const fileNameOf = (url) => {
    try { return decodeURIComponent(String(url).split(/[\\/]/).pop().split(/[?#]/)[0]); } catch (e) { return ''; }
  };

  // small preview in settings; videos get an icon instead of a second decoder
  function paintMediaThumb(node, url) {
    if (!node) return;
    node.innerHTML = '';
    node.style.backgroundImage = '';
    if (!url) return;
    if (isVideoUrl(url)) {
      node.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>';
      node.classList.add('is-video');
    } else {
      node.classList.remove('is-video');
      node.style.backgroundImage = `url("${url}")`;
    }
  }

  // wallpaper: an image, gif or muted video behind the panels
  const wallpaper = document.getElementById('custom-wallpaper');
  function renderWallpaper() {
    const url = localStorage.getItem('riffle_wallpaper') || '';
    const opacity = readPercent('riffle_wallpaper_opacity', 10);
    const blur = Math.max(0, Math.min(40, parseInt(localStorage.getItem('riffle_wallpaper_blur') || '0', 10) || 0));
    const sliderOpacity = document.getElementById('slider-bg-opacity');
    const sliderBlur = document.getElementById('slider-bg-blur');
    if (sliderOpacity) sliderOpacity.value = opacity;
    if (sliderBlur) sliderBlur.value = blur;
    const valOpacity = document.getElementById('val-bg-opacity');
    const valBlur = document.getElementById('val-bg-blur');
    if (valOpacity) valOpacity.textContent = `${opacity}%`;
    if (valBlur) valBlur.textContent = `${blur}px`;
    paintMediaThumb(document.getElementById('custom-bg-thumb'), url);
    const status = document.getElementById('custom-bg-status');
    if (status) status.textContent = url ? fileNameOf(url) : tr('None. PNG, JPG, WebP, GIF, MP4 or WebM');
    document.querySelectorAll('.custom-bg-dependent').forEach(n => n.classList.toggle('is-disabled', !url));
    const btnRemove = document.getElementById('btn-remove-custom-bg');
    if (btnRemove) btnRemove.disabled = !url;
    document.body.classList.toggle('has-wallpaper', Boolean(url));
    if (!wallpaper) return;
    if (!url) {
      const old = wallpaper.querySelector('video');
      if (old) { old.removeAttribute('src'); old.load(); }
      wallpaper.innerHTML = '';
      wallpaper.hidden = true;
      return;
    }
    wallpaper.hidden = false;
    wallpaper.style.opacity = String(opacity / 100);
    wallpaper.style.setProperty('--wallpaper-blur', `${blur}px`);
    const tag = isVideoUrl(url) ? 'VIDEO' : 'IMG';
    const current = wallpaper.firstElementChild;
    if (current && current.tagName === tag && current.getAttribute('src') === url) return;
    wallpaper.innerHTML = '';
    const media = document.createElement(tag.toLowerCase());
    media.onerror = () => {
      showToast(tr('The wallpaper file could not be opened'), 'error');
      localStorage.removeItem('riffle_wallpaper');
      renderWallpaper();
    };
    if (tag === 'VIDEO') {
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
      media.src = url;
      if (state.isWindowVisible && !uiFlags.perf) media.play().catch(() => {});
    } else {
      media.decoding = 'async';
      media.alt = '';
      media.src = url;
    }
    wallpaper.appendChild(media);
  }

  async function pickMediaFile(kind) {
    if (!window.electronAPI || !window.electronAPI.pickMedia) return null;
    try { return await window.electronAPI.pickMedia(kind); } catch (e) { return null; }
  }

  const btnChooseWallpaper = document.getElementById('btn-choose-custom-bg');
  if (btnChooseWallpaper) btnChooseWallpaper.addEventListener('click', async () => {
    const picked = await pickMediaFile('media');
    if (!picked) return;
    localStorage.setItem('riffle_wallpaper', picked.url);
    // a wallpaper is pointless behind fully opaque panels
    if (readPercent('riffle_ui_alpha', 20) === 100) {
      localStorage.setItem('riffle_ui_alpha', '70');
      const slider = document.getElementById('slider-ui-alpha');
      const value = document.getElementById('val-ui-alpha');
      if (slider) slider.value = 70;
      if (value) value.textContent = '70%';
      applyTranslucency();
    }
    renderWallpaper();
  });
  const btnRemoveWallpaper = document.getElementById('btn-remove-custom-bg');
  if (btnRemoveWallpaper) btnRemoveWallpaper.addEventListener('click', () => {
    localStorage.removeItem('riffle_wallpaper');
    renderWallpaper();
  });
  [['slider-bg-opacity', 'riffle_wallpaper_opacity'], ['slider-bg-blur', 'riffle_wallpaper_blur']].forEach(([id, key]) => {
    const slider = document.getElementById(id);
    if (slider) slider.addEventListener('input', () => {
      localStorage.setItem(key, slider.value);
      renderWallpaper();
    });
  });
  renderWallpaper();

  // banner media for every song (a song's own banner still wins) and how it is sized
  function renderBannerMediaSetting() {
    const url = localStorage.getItem('riffle_banner_media') || '';
    paintMediaThumb(document.getElementById('banner-media-thumb'), url);
    const status = document.getElementById('banner-media-status');
    if (status) status.textContent = url ? fileNameOf(url) : tr('Album art of the current song');
    const btnReset = document.getElementById('btn-reset-banner-media');
    if (btnReset) btnReset.disabled = !url;
  }
  function refreshBanners() {
    const thumb = state.currentTrack ? getTrackThumbUrl(state.currentTrack) : '';
    updateRightPanelBanner(thumb);
    if (state.currentView === 'playlist-detail' && state.currentPlaylistId) {
      const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
      const first = pl && pl.tracks && pl.tracks[0];
      updatePlaylistDetailBanner(first ? getTrackThumbUrl(first) : '');
    }
  }
  const btnChooseBanner = document.getElementById('btn-choose-banner-media');
  if (btnChooseBanner) btnChooseBanner.addEventListener('click', async () => {
    const picked = await pickMediaFile('media');
    if (!picked) return;
    localStorage.setItem('riffle_banner_media', picked.url);
    renderBannerMediaSetting();
    refreshBanners();
  });
  const btnResetBanner = document.getElementById('btn-reset-banner-media');
  if (btnResetBanner) btnResetBanner.addEventListener('click', () => {
    localStorage.removeItem('riffle_banner_media');
    renderBannerMediaSetting();
    refreshBanners();
  });
  renderBannerMediaSetting();

  const BANNER_FITS = {
    fit: { size: 'contain', object: 'contain', scale: 'none' },
    zoom: { size: 'cover', object: 'cover', scale: 'scale(1.06)' },
    stretch: { size: '100% 100%', object: 'fill', scale: 'none' }
  };
  function applyBannerFit(fit) {
    const f = BANNER_FITS[fit] ? fit : 'zoom';
    const root = document.documentElement;
    root.style.setProperty('--banner-size', BANNER_FITS[f].size);
    root.style.setProperty('--banner-object-fit', BANNER_FITS[f].object);
    root.style.setProperty('--banner-scale', BANNER_FITS[f].scale);
    document.querySelectorAll('#banner-fit-toggle [data-fit]').forEach(b => b.classList.toggle('active', b.dataset.fit === f));
  }
  const bannerFitToggle = document.getElementById('banner-fit-toggle');
  if (bannerFitToggle) bannerFitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fit]');
    if (!btn) return;
    localStorage.setItem('riffle_banner_fit', btn.dataset.fit);
    applyBannerFit(btn.dataset.fit);
  });
  applyBannerFit(localStorage.getItem('riffle_banner_fit') || 'zoom');

  // background gradient editor: where the two accent lights sit, how they drift and how soft they are
  const MESH_DEFAULT = { p1: { x: 20, y: 0 }, p2: { x: 85, y: 5 }, drift: 0, soft: 0 };
  const clampPct = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : d);
  function readMeshConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem('riffle_mesh_cfg') || 'null');
      if (!raw || !raw.p1 || !raw.p2) return JSON.parse(JSON.stringify(MESH_DEFAULT));
      return {
        p1: { x: clampPct(raw.p1.x, 20), y: clampPct(raw.p1.y, 0) },
        p2: { x: clampPct(raw.p2.x, 85), y: clampPct(raw.p2.y, 5) },
        drift: Math.max(0, Math.min(10, parseInt(raw.drift, 10) || 0)),
        soft: Math.max(0, Math.min(60, parseInt(raw.soft, 10) || 0))
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(MESH_DEFAULT));
    }
  }
  let meshConfig = readMeshConfig();
  function applyMeshConfig(save) {
    const root = document.documentElement;
    root.style.setProperty('--mesh-p1x', `${meshConfig.p1.x}%`);
    root.style.setProperty('--mesh-p1y', `${meshConfig.p1.y}%`);
    root.style.setProperty('--mesh-p2x', `${meshConfig.p2.x}%`);
    root.style.setProperty('--mesh-p2y', `${meshConfig.p2.y}%`);
    root.style.setProperty('--mesh-blur', `${meshConfig.soft}px`);
    // drift 1 is a lazy 90 s loop, 10 a lively 18 s one
    root.style.setProperty('--mesh-drift-duration', `${Math.round(98 - meshConfig.drift * 8)}s`);
    document.body.classList.toggle('mesh-drifting', meshConfig.drift > 0);
    document.body.classList.toggle('mesh-soft', meshConfig.soft > 0);
    const pin1 = document.getElementById('mesh-pin-1');
    const pin2 = document.getElementById('mesh-pin-2');
    if (pin1) { pin1.style.left = `${meshConfig.p1.x}%`; pin1.style.top = `${meshConfig.p1.y}%`; }
    if (pin2) { pin2.style.left = `${meshConfig.p2.x}%`; pin2.style.top = `${meshConfig.p2.y}%`; }
    const speed = document.getElementById('slider-mesh-speed');
    const blur = document.getElementById('slider-mesh-blur');
    if (speed) speed.value = meshConfig.drift;
    if (blur) blur.value = meshConfig.soft;
    const valSpeed = document.getElementById('val-mesh-speed');
    const valBlur = document.getElementById('val-mesh-blur');
    if (valSpeed) valSpeed.textContent = meshConfig.drift ? String(meshConfig.drift) : tr('Still');
    if (valBlur) valBlur.textContent = `${meshConfig.soft}px`;
    if (save) localStorage.setItem('riffle_mesh_cfg', JSON.stringify(meshConfig));
  }
  applyMeshConfig(false);

  const meshModal = document.getElementById('mesh-editor-modal');
  const btnEditMesh = document.getElementById('btn-configure-mesh');
  if (btnEditMesh && meshModal) btnEditMesh.addEventListener('click', () => {
    const stageBg = document.getElementById('mesh-stage-bg');
    const live = document.getElementById(activeMeshLayer === 'a' ? 'bg-mesh-a' : 'bg-mesh-b');
    if (stageBg && live) stageBg.style.background = live.style.background;
    applyMeshConfig(false);
    openModal(meshModal);
  });
  ['btn-close-mesh-editor', 'btn-done-mesh'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => closeModal(meshModal));
  });
  if (meshModal) meshModal.addEventListener('click', (e) => { if (e.target === meshModal) closeModal(meshModal); });
  const btnResetMesh = document.getElementById('btn-reset-mesh');
  if (btnResetMesh) btnResetMesh.addEventListener('click', () => {
    meshConfig = JSON.parse(JSON.stringify(MESH_DEFAULT));
    applyMeshConfig(true);
  });
  const sliderMeshSpeed = document.getElementById('slider-mesh-speed');
  if (sliderMeshSpeed) sliderMeshSpeed.addEventListener('input', () => { meshConfig.drift = parseInt(sliderMeshSpeed.value, 10) || 0; applyMeshConfig(true); });
  const sliderMeshBlur = document.getElementById('slider-mesh-blur');
  if (sliderMeshBlur) sliderMeshBlur.addEventListener('input', () => { meshConfig.soft = parseInt(sliderMeshBlur.value, 10) || 0; applyMeshConfig(true); });

  function makeMeshPinDraggable(pin, key) {
    const stage = document.getElementById('mesh-stage');
    if (!pin || !stage) return;
    const moveTo = (clientX, clientY) => {
      const r = stage.getBoundingClientRect();
      meshConfig[key] = { x: clampPct(((clientX - r.left) / r.width) * 100, 0), y: clampPct(((clientY - r.top) / r.height) * 100, 0) };
      applyMeshConfig(true);
    };
    pin.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pin.setPointerCapture(e.pointerId);
      pin.classList.add('dragging');
    });
    pin.addEventListener('pointermove', (e) => { if (pin.hasPointerCapture(e.pointerId)) moveTo(e.clientX, e.clientY); });
    const stop = (e) => { pin.classList.remove('dragging'); try { pin.releasePointerCapture(e.pointerId); } catch (err) {} };
    pin.addEventListener('pointerup', stop);
    pin.addEventListener('pointercancel', stop);
    pin.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      meshConfig[key] = { x: clampPct(meshConfig[key].x + d[0], 0), y: clampPct(meshConfig[key].y + d[1], 0) };
      applyMeshConfig(true);
    });
  }
  makeMeshPinDraggable(document.getElementById('mesh-pin-1'), 'p1');
  makeMeshPinDraggable(document.getElementById('mesh-pin-2'), 'p2');

  // simple on/off appearance switches
  function bindLocalSwitch(id, key, defaultOn, apply) {
    const btn = document.getElementById(id);
    const read = () => { const v = localStorage.getItem(key); return v === null ? defaultOn : v === 'true'; };
    apply(read(), false);
    if (!btn) return;
    btn.classList.toggle('active', read());
    btn.addEventListener('click', () => {
      const next = !read();
      localStorage.setItem(key, String(next));
      btn.classList.toggle('active', next);
      apply(next, true);
    });
  }

  bindLocalSwitch('btn-no-hand-cursor', 'riffle_arrow_cursor', false, (on) => document.body.classList.toggle('arrow-cursor', on));

  function syncScrubberStyle() {
    uiFlags.flatScrubber = uiFlags.perf || localStorage.getItem('riffle_wavy_progress') === 'false';
    hasDrawnPausedFrame = false;
  }
  bindLocalSwitch('btn-wavy-progress', 'riffle_wavy_progress', true, syncScrubberStyle);

  function setMediaPlaying(on) {
    document.querySelectorAll('#custom-wallpaper video, video.banner-video').forEach(v => {
      if (on) v.play().catch(() => {});
      else v.pause();
    });
  }
  function applyPerfMode(on) {
    uiFlags.perf = on;
    document.body.classList.toggle('perf', on);
    syncScrubberStyle();
    setMediaPlaying(!on && state.isWindowVisible);
  }
  bindLocalSwitch('btn-perf-mode', 'riffle_perf_mode', false, applyPerfMode);

  // first run on a machine without graphics acceleration: start in performance mode
  if (localStorage.getItem('riffle_perf_mode') === null && window.electronAPI && window.electronAPI.gpuIsSoftware) {
    window.electronAPI.gpuIsSoftware().then((software) => {
      if (!software || localStorage.getItem('riffle_perf_mode') !== null) return;
      localStorage.setItem('riffle_perf_mode', 'true');
      const btn = document.getElementById('btn-perf-mode');
      if (btn) btn.classList.add('active');
      applyPerfMode(true);
      showToast(tr('No graphics acceleration found, so performance mode is on. You can turn it off in Settings'));
    }).catch(() => {});
  }

  // presses stay visible for a moment even on very fast clicks, and leave a ripple behind
  const PRESSABLE = 'button, .chip-btn, .mix-card, .track-row, .nav-item, .rail-icon-btn, .preset-chip, .settings-nav-btn';
  const RIPPLE_HOSTS = '.btn-pill-primary, .btn-outline-pill, .btn-icon-pill, .chip-btn, .rail-icon-btn, .preset-chip, .theme-mode-btn, .settings-nav-btn, .mix-card, .track-row, .btn-tonal-mini, .platform-btn';
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const pressed = e.target.closest(PRESSABLE);
    if (pressed) {
      pressed.classList.add('pressed');
      const t0 = performance.now();
      const release = () => {
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
        setTimeout(() => pressed.classList.remove('pressed'), Math.max(0, 170 - (performance.now() - t0)));
      };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }
    if (uiFlags.perf || document.documentElement.classList.contains('force-reduced-motion')) return;
    const host = e.target.closest(RIPPLE_HOSTS);
    if (!host || host.disabled) return;
    const r = host.getBoundingClientRect();
    const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
    let layer = host.querySelector(':scope > .ripple-layer');
    if (!layer) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      layer = document.createElement('span');
      layer.className = 'ripple-layer';
      host.appendChild(layer);
    }
    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    wave.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    layer.appendChild(wave);
    wave.addEventListener('animationend', () => wave.remove(), { once: true });
  }, true);

  // settings are split into categories; only the chosen one is in the layout at a time
  function showSettingsCategory(cat) {
    if (!document.querySelector(`#settings-nav [data-cat="${cat}"]`)) cat = 'appearance';
    document.querySelectorAll('#settings-pane > [data-cat]').forEach(node => node.classList.toggle('cat-hidden', node.dataset.cat !== cat));
    document.querySelectorAll('#settings-nav .settings-nav-btn').forEach(btn => {
      const on = btn.dataset.cat === cat;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
    const pane = document.querySelector('#view-settings .settings-view');
    if (pane) pane.scrollTop = 0;
    try { localStorage.setItem('riffle_settings_cat', cat); } catch (e) {}
  }
  const settingsNav = document.getElementById('settings-nav');
  if (settingsNav) {
    settingsNav.addEventListener('click', (e) => {
      const btn = e.target.closest('.settings-nav-btn');
      if (btn) showSettingsCategory(btn.dataset.cat);
    });
  }
  showSettingsCategory(localStorage.getItem('riffle_settings_cat') || 'appearance');

  // short sliders get a dot per step; the old hint labels move under their dots
  function addSliderTicks(input) {
    const hints = input.parentElement.querySelector('.setting-hints');
    const labels = hints ? [...hints.querySelectorAll('span')].map(s => s.textContent) : [];
    const min = Number(input.min), max = Number(input.max), step = Number(input.step) || 1;
    const marks = {};
    if (labels.length === 3) {
      // the middle label belongs to the default value, or to the middle when the default sits at an end
      let mid = Number(input.getAttribute('value'));
      if (!(mid > min && mid < max)) mid = min + Math.round((max - min) / 2 / step) * step;
      marks[min] = labels[0]; marks[mid] = labels[1]; marks[max] = labels[2];
    }
    else if (labels.length === 2) { marks[min] = labels[0]; marks[max] = labels[1]; }
    const row = document.createElement('div');
    row.className = 'slider-ticks';
    for (let v = min; v <= max + 1e-9; v += step) {
      const dot = document.createElement('i');
      dot.style.setProperty('--at', ((v - min) / (max - min)).toFixed(4));
      if (marks[v] != null) {
        dot.className = 'labeled';
        const label = document.createElement('span');
        label.textContent = marks[v];
        dot.appendChild(label);
      }
      row.appendChild(dot);
    }
    input.insertAdjacentElement('afterend', row);
    if (hints) hints.remove();
  }
  document.querySelectorAll('#view-settings .pill-range').forEach(input => {
    const steps = (Number(input.max) - Number(input.min)) / (Number(input.step) || 1);
    if (steps <= 24 && input.parentElement.querySelector('.setting-hints')) addSliderTicks(input);
  });

  // switches show a check when on and a dash when off
  function decorateSwitches(root = document) {
    root.querySelectorAll('.effect-switch-btn .thumb:not(.has-glyph)').forEach(thumb => {
      thumb.classList.add('has-glyph');
      thumb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="glyph-on" d="M6 12.5l4 4 8-9"/><path class="glyph-off" d="M7 12h10"/></svg>';
    });
  }
  decorateSwitches();

  loadHomePage();
  resizeCanvases();
  updateOfflineStorageUI();
  checkToolsStatus(false);
  setLyricsEmpty(true);
  restoreSession();
  sendTrayState();
});

document.addEventListener('DOMContentLoaded', () => {
  const btnCollapseRightPanel = document.getElementById('btn-collapse-right-panel');
  const rightPanel = document.getElementById('right-panel');
  if (btnCollapseRightPanel && rightPanel) {
    btnCollapseRightPanel.addEventListener('click', () => {
      rightPanel.classList.toggle('is-collapsed');
    });
  }
});


