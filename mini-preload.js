const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniAPI', {
  onState: (cb) => ipcRenderer.on('mini-state', (e, info) => cb(info)),
  command: (cmd) => ipcRenderer.send('mini-command', cmd)
});
