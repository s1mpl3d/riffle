const fs = require('fs');
const os = require('os');
const path = require('path');

// first run of Riffle on a machine that already has Riff: bring the profile
// (settings, playlists, library) and custom lyrics along.
// Old folders are only copied, never touched, and nothing is overwritten.

const SKIP_PROFILE = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);

function firstExisting(dirs) {
  return dirs.find((d) => {
    try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
  });
}

function copyMissing(from, to, skip) {
  try {
    fs.cpSync(from, to, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => !skip || !skip.has(path.basename(src))
    });
    return true;
  } catch (e) {
    console.warn('[migrate]', from, '->', to, e.message);
    return false;
  }
}

function migrateProfile(app) {
  const target = app.getPath('userData');
  if (fs.existsSync(path.join(target, 'Local Storage'))) return;
  const appData = app.getPath('appData');
  const source = firstExisting([path.join(appData, 'Riff')]);
  if (source && copyMissing(source, target, SKIP_PROFILE)) console.log('[migrate] profile imported from', source);
}

function migrateData() {
  if (process.platform !== 'win32') return;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const source = firstExisting([path.join(local, 'Riff')]);
  const target = path.join(local, 'Riffle');
  if (!source || fs.existsSync(target)) return;
  // the stream cache can be gigabytes and refills on its own; keep what can't be re-fetched
  for (const name of ['custom-lyrics', 'lyrics', 'bin']) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) copyMissing(from, path.join(target, name));
  }
  console.log('[migrate] lyrics and tools imported from', source);
}

function migrateFromRiff(app) {
  if (process.env.RIFFLE_PROFILE_DIR) return;
  migrateProfile(app);
  migrateData();
}

module.exports = { migrateFromRiff };
