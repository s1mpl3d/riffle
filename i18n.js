// UI translations. English is written directly in the markup and code; another
// language is a file in locales/ that maps the English text to its own. Only the
// active language is loaded, so English costs nothing and others cost one small file.
(function () {
  // each one is a file in locales/, named here in its own language; a system language
  // that isn't listed falls back to one with the same base ('pt-PT' -> 'pt-BR'), then English
  const LANGUAGES = {
    'de': 'Deutsch',
    'es': 'Español',
    'fr': 'Français',
    'it': 'Italiano',
    'pl': 'Polski',
    'pt-BR': 'Português (Brasil)',
    'tr': 'Türkçe',
    'ru': 'Русский',
    'ja': '日本語',
    'ko': '한국어',
    'zh-CN': '简体中文'
  };
  const STORAGE_KEY = 'riffle_language';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  let dict = null;

  function chosen() {
    try { return localStorage.getItem(STORAGE_KEY) || 'auto'; } catch (e) { return 'auto'; }
  }

  function resolve(pref) {
    if (pref && pref !== 'auto') return LANGUAGES[pref] ? pref : 'en';
    const sys = String(navigator.language || 'en');
    if (LANGUAGES[sys]) return sys;
    const base = sys.split('-')[0];
    return Object.keys(LANGUAGES).find(code => code.split('-')[0] === base) || 'en';
  }

  function t(text, vars) {
    let out = (dict && dict[text]) || text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return out;
  }

  // translates the static markup once; text set later by code goes through t()
  function translateTree(root) {
    if (!dict) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue;
      const key = raw.trim();
      if (key && dict[key]) n.nodeValue = raw.replace(key, dict[key]);
    }
    for (const attr of ATTRS) {
      root.querySelectorAll('[' + attr + ']').forEach(node => {
        const v = node.getAttribute(attr);
        if (v && dict[v]) node.setAttribute(attr, dict[v]);
      });
    }
  }

  const lang = resolve(chosen());
  document.documentElement.lang = lang;

  const ready = new Promise(done => {
    if (lang === 'en') return done();
    const script = document.createElement('script');
    script.src = 'locales/' + lang + '.js';
    script.onload = () => { dict = window.RIFFLE_LOCALE || null; delete window.RIFFLE_LOCALE; done(); };
    script.onerror = () => done();
    document.head.appendChild(script);
  }).then(() => new Promise(done => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => done(), { once: true });
    else done();
  })).then(() => {
    translateTree(document.body);
    if (dict) document.title = t(document.title);
  });

  window.i18n = {
    t,
    ready,
    lang,
    languages: LANGUAGES,
    preference: chosen,
    setPreference(pref) {
      try {
        if (!pref || pref === 'auto') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, pref);
      } catch (e) {}
    }
  };
})();
