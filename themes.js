const { dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./platform');

const THEMES_DIR = path.join(DATA_DIR, 'themes');
const INDEX_PATH = path.join(THEMES_DIR, 'index.json');
const MAX_BYTES = 2 * 1024 * 1024;
const validId = (id) => /^t[a-z0-9]{6,24}$/.test(String(id));

function readIndex() {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')).themes;
    return Array.isArray(list) ? list.filter(t => t && validId(t.id)) : [];
  } catch (e) {
    return [];
  }
}

function writeIndex(themes) {
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify({ themes }, null, 2));
}

// name, author and description come from "@name ..." lines in the first comment, if there is one
function readMeta(css, fallback) {
  const head = (css.match(/\/\*[\s\S]*?\*\//) || [''])[0];
  const pick = (key) => ((head.match(new RegExp(`@${key}[ \\t]+([^\\r\\n*]+)`)) || [])[1] || '').trim().slice(0, 120);
  return { name: pick('name') || fallback, author: pick('author'), description: pick('description') };
}

function register(getWindow) {
  ipcMain.handle('themes-list', () => readIndex().map((t) => {
    try { return { ...t, css: fs.readFileSync(path.join(THEMES_DIR, `${t.id}.css`), 'utf8') }; } catch (e) { return null; }
  }).filter(Boolean));

  ipcMain.handle('themes-import', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openFile', 'multiSelections'], filters: [{ name: 'CSS', extensions: ['css'] }] });
    if (r.canceled) return [];
    const themes = readIndex();
    const added = [];
    for (const file of r.filePaths) {
      try {
        if (fs.statSync(file).size > MAX_BYTES) continue;
        const css = fs.readFileSync(file, 'utf8');
        const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, `${id}.css`), css);
        const entry = { id, ...readMeta(css, path.basename(file, path.extname(file))), enabled: false };
        themes.push(entry);
        added.push({ ...entry, css });
      } catch (e) {}
    }
    writeIndex(themes);
    return added;
  });

  ipcMain.on('themes-set-enabled', (e, id, on) => {
    if (validId(id)) writeIndex(readIndex().map(t => (t.id === id ? { ...t, enabled: !!on } : t)));
  });

  ipcMain.on('themes-remove', (e, id) => {
    if (!validId(id)) return;
    fs.rmSync(path.join(THEMES_DIR, `${id}.css`), { force: true });
    writeIndex(readIndex().filter(t => t.id !== id));
  });
}

module.exports = { register };
