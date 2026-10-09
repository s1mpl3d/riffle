// Lists the English UI text found in the markup and code, then reports what each
// locale in locales/ is missing or no longer uses.
//   node scripts/i18n-check.js            report
//   node scripts/i18n-check.js --keys     print every key as JSON (to hand to a translator)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// proper names, units and formats that read the same in every language
const SKIP = /^(Riffle|Riff|s1mpl3d|YouTube|YT Music|SoundCloud|Spotify|TikTok|Rock|Phonk|Synthwave|English|Ctrl|Alt|Esc|[A-Z]|yt-dlp|ffmpeg|https?:\/\/.*|MP3, FLAC.*|-?\d+ dB|BETA|Client ID|Client Secret|MP3|FLAC|M4A|AAC|Opus|WAV|PCM|[\d.+\-]+ ?(px|s|x|st|kbps)|.*\(.*(Restorer|Upscaler|Depth)\))$/;

function decode(s) {
  return s.replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function collect() {
  const keys = new Set();
  const add = k => { k = decode(k).trim(); if (k && /[A-Za-z]/.test(k) && !SKIP.test(k)) keys.add(k); };
  for (const file of ['index.html', 'mini.html']) {
    const html = read(file).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) add(m[1]);
    for (const m of html.matchAll(/>([^<>]+)</g)) add(m[1]);
  }
  for (const file of ['app.js', 'mini.js']) {
    const src = read(file);
    for (const m of src.matchAll(/\btrn?\((?:[^,()'`]+,\s*)?'((?:[^'\\]|\\.)*)'(?:,\s*'((?:[^'\\]|\\.)*)')?/g)) {
      if (m[1]) add(m[1].replace(/\\'/g, "'"));
      if (m[2]) add(m[2].replace(/\\'/g, "'"));
    }
    for (const m of src.matchAll(/\{ id: 'p_\w+', name: '([^']+)'/g)) add(m[1]);
  }
  return [...keys];
}

const keys = collect();
if (process.argv.includes('--keys')) {
  console.log(JSON.stringify(keys, null, 1));
  process.exit(0);
}

let failed = false;
for (const file of fs.readdirSync(path.join(root, 'locales')).filter(f => f.endsWith('.js'))) {
  const sandbox = { window: {} };
  new Function('window', read(path.join('locales', file)))(sandbox.window);
  const dict = sandbox.window.RIFFLE_LOCALE || {};
  const missing = keys.filter(k => !(k in dict));
  const unused = Object.keys(dict).filter(k => !keys.includes(k));
  const broken = Object.keys(dict).filter(k => {
    const vars = s => (s.match(/\{\w+\}/g) || []).sort().join();
    return vars(k) !== vars(dict[k]);
  });
  console.log(`${file}: ${Object.keys(dict).length - unused.length}/${keys.length} translated`);
  if (missing.length) console.log('  missing:\n    ' + missing.join('\n    '));
  if (unused.length) console.log('  unused:\n    ' + unused.join('\n    '));
  if (broken.length) console.log('  placeholders differ:\n    ' + broken.join('\n    '));
  if (missing.length || broken.length) failed = true;
}
process.exit(failed ? 1 : 0);
