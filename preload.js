const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const tokenArg = process.argv.find(a => a.startsWith('--riffle-token='));

contextBridge.exposeInMainWorld('electronAPI', {
  serverToken: tokenArg ? tokenArg.slice('--riffle-token='.length) : '',
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  pickMedia: (kind) => ipcRenderer.invoke('pick-media', kind),
  gpuIsSoftware: () => ipcRenderer.invoke('gpu-is-software'),
  importAudioFiles: () => ipcRenderer.invoke('import-audio-files'),
  importAudioPaths: (paths) => ipcRenderer.invoke('import-audio-paths', paths),
  // dropped File objects don't expose their path to the page any more
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  onWindowVisibility: (callback) => {
    ipcRenderer.on('window-visibility', (event, visible) => callback(visible));
  },
  setZoomFactor: (factor) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch (e) {}
  },
  getZoomFactor: () => {
    try {
      return webFrame.getZoomFactor();
    } catch (e) {
      return 1.0;
    }
  },

  discordRpcUpdate: (trackInfo) => ipcRenderer.send('discord-rpc-update', trackInfo),
  discordRpcClear: () => ipcRenderer.send('discord-rpc-clear'),
  discordRpcSetEnabled: (enabled) => ipcRenderer.send('discord-rpc-set-enabled', enabled),
  discordRpcGetEnabled: () => ipcRenderer.invoke('discord-rpc-get-enabled'),
  discordRpcGetConnected: () => ipcRenderer.invoke('discord-rpc-get-connected'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  updateAction: (action) => ipcRenderer.send('update-action', action),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, d) => cb(d)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, d) => cb(d)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (e, d) => cb(d)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (e, d) => cb(d)),
  setCloseToTray: (enabled) => ipcRenderer.send('set-close-to-tray', enabled),
  trayUpdate: (info) => ipcRenderer.send('tray-update', info),
  onTrayCommand: (cb) => ipcRenderer.on('tray-command', (e, cmd) => cb(cmd)),
  setGlobalShortcuts: (enabled) => ipcRenderer.send('set-global-shortcuts', enabled),
  isWindows: process.platform === 'win32',
  setMediaKeys: (enabled) => ipcRenderer.send('set-media-keys', enabled),
  mediaKeysArmed: () => ipcRenderer.send('media-keys-armed'),
  setUiScale: (s) => ipcRenderer.send('ui-scale', s),
  getMultiInstance: () => ipcRenderer.invoke('get-multi-instance'),
  setMultiInstance: (on) => ipcRenderer.send('set-multi-instance', on),
  listThemes: () => ipcRenderer.invoke('themes-list'),
  importThemes: () => ipcRenderer.invoke('themes-import'),
  setThemeEnabled: (id, on) => ipcRenderer.send('themes-set-enabled', id, on),
  removeTheme: (id) => ipcRenderer.send('themes-remove', id),
  storageInfo: () => ipcRenderer.invoke('storage-info'),
  launcherInfo: () => ipcRenderer.invoke('launcher-info'),
  installLauncher: () => ipcRenderer.invoke('launcher-install'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  setDataDir: (payload) => ipcRenderer.invoke('set-data-dir', payload),
  setDownloadDir: (payload) => ipcRenderer.invoke('set-download-dir', payload),
  restartApp: () => ipcRenderer.send('restart-app'),
  toggleMini: () => ipcRenderer.send('mini-toggle'),
  miniState: (info) => ipcRenderer.send('mini-state', info),
  onMiniVisibility: (cb) => ipcRenderer.on('mini-visibility', (e, open) => cb(open)),
});
