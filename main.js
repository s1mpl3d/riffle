const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,UseOzonePlatform,WaylandFractionalScaleV1');
  app.commandLine.appendSwitch('disable-features', 'Vulkan');

  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  if (process.env.RIFFLE_SKIP_GPU_BUFFER_FLAGS !== '1') {
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-compositor-resources');
  }
}

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const extraFlags = (process.env.RIFFLE_FLAGS || '').split(';').map((s) => s.trim()).filter(Boolean);
for (const flag of extraFlags) {
  const eq = flag.indexOf('=');
  if (eq > 0) app.commandLine.appendSwitch(flag.slice(0, eq), flag.slice(eq + 1));
  else app.commandLine.appendSwitch(flag);
}

if (process.env.RIFFLE_DEBUG === '1') {
  app.whenReady().then(async () => {
    console.log('[gpu] features', JSON.stringify(app.getGPUFeatureStatus()));
    try {
      console.log('[gpu] info', JSON.stringify(await app.getGPUInfo('basic')));
    } catch (e) {}
    setInterval(() => {
      const rows = app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`);
      console.log('[cpu]', rows.join('  '));
    }, 5000).unref();
  });
}

if (process.argv.includes('lyrics') || process.argv.includes('--lyrics')) {
  const cliPath = path.join(__dirname, 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'lyrics'], { stdio: 'inherit', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  runGUI();
}

function runGUI() {
  // RIFFLE_PROFILE_DIR lets a dev copy run next to the installed one
  app.setPath('userData', process.env.RIFFLE_PROFILE_DIR || path.join(app.getPath('appData'), 'Riffle'));

  // a second instance can't open localStorage (leveldb lock) and loses everything on exit
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  require('./migrate').migrateFromRiff(app);

  const { startServer, PORT } = require('./server');
  const discordRPC = require('./discord-rpc');

  let mainWindow = null;
  let serverPort = PORT;
  let tray = null;
  let closeToTray = true;
  let isQuitting = false;
  let trayInfo = { title: '', artist: '', isPlaying: false };

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function sendTrayCommand(cmd) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tray-command', cmd);
  }

  function refreshTray() {
    if (!tray) return;
    const nowPlaying = trayInfo.title ? `${trayInfo.title}${trayInfo.artist ? ' - ' + trayInfo.artist : ''}` : '';
    tray.setToolTip(nowPlaying ? `Riffle\n${nowPlaying}`.slice(0, 127) : 'Riffle');
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(nowPlaying ? [{ label: nowPlaying.slice(0, 60), enabled: false }, { type: 'separator' }] : []),
      { label: trayInfo.isPlaying ? 'Pause' : 'Play', click: () => sendTrayCommand('toggle') },
      { label: 'Next', click: () => sendTrayCommand('next') },
      { label: 'Previous', click: () => sendTrayCommand('prev') },
      { type: 'separator' },
      { label: miniWindow && !miniWindow.isDestroyed() ? 'Close mini player' : 'Mini player', click: toggleMiniWindow },
      { label: 'Show Riffle', click: showMainWindow },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
    ]));
  }

  // global shortcuts work while Riffle is hidden in the tray
  const GLOBAL_SHORTCUTS = {
    'CommandOrControl+Alt+Space': 'toggle',
    'CommandOrControl+Alt+Right': 'next',
    'CommandOrControl+Alt+Left': 'prev',
    'CommandOrControl+Alt+Up': 'volup',
    'CommandOrControl+Alt+Down': 'voldown',
    'CommandOrControl+Alt+P': 'mini'
  };

  function setGlobalShortcuts(enabled) {
    Object.keys(GLOBAL_SHORTCUTS).forEach((accel) => {
      if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    });
    if (!enabled) return;
    for (const [accel, cmd] of Object.entries(GLOBAL_SHORTCUTS)) {
      try {
        if (!globalShortcut.register(accel, () => sendTrayCommand(cmd))) console.warn('Shortcut taken by another app:', accel);
      } catch (e) {}
    }
  }

  // mini player: small always-on-top window fed by the main renderer through ipc
  let miniWindow = null;
  const miniStatePath = path.join(app.getPath('userData'), 'mini-state.json');
  const MINI_SIZE = { width: 460, height: 112 };

  function miniBounds() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(miniStatePath, 'utf8')); } catch (e) {}
    const display = saved ? screen.getDisplayMatching({ ...MINI_SIZE, x: saved.x, y: saved.y }) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const x = saved ? saved.x : area.x + area.width - MINI_SIZE.width - 24;
    const y = saved ? saved.y : area.y + area.height - MINI_SIZE.height - 24;
    return {
      ...MINI_SIZE,
      x: Math.min(Math.max(x, area.x), area.x + area.width - MINI_SIZE.width),
      y: Math.min(Math.max(y, area.y), area.y + area.height - MINI_SIZE.height)
    };
  }

  function notifyMiniVisibility(open) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini-visibility', open);
    refreshTray();
  }

  function openMiniWindow() {
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.show();
      return;
    }
    miniWindow = new BrowserWindow({
      ...miniBounds(),
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: false,
      show: false,
      title: 'Riffle mini player',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'mini-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: false
      }
    });
    miniWindow.setAlwaysOnTop(true, 'floating');
    miniWindow.loadFile(path.join(__dirname, 'mini.html'));
    miniWindow.once('ready-to-show', () => {
      if (!miniWindow || miniWindow.isDestroyed()) return;
      miniWindow.showInactive();
      notifyMiniVisibility(true);
    });
    miniWindow.on('moved', () => {
      if (!miniWindow || miniWindow.isDestroyed()) return;
      const { x, y } = miniWindow.getBounds();
      try { fs.writeFileSync(miniStatePath, JSON.stringify({ x, y })); } catch (e) {}
    });
    miniWindow.on('closed', () => {
      miniWindow = null;
      notifyMiniVisibility(false);
    });
  }

  function closeMiniWindow() {
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  }

  function toggleMiniWindow() {
    if (miniWindow && !miniWindow.isDestroyed()) {
      closeMiniWindow();
    } else {
      openMiniWindow();
      // the mini player replaces the big window; expanding it brings that back
      if (mainWindow && !mainWindow.isDestroyed() && tray) mainWindow.hide();
    }
  }

  function createTray() {
    if (tray) return;
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
      tray = new Tray(icon);
      tray.on('click', showMainWindow);
      refreshTray();
    } catch (e) {
      console.warn('Tray unavailable:', e);
      tray = null;
    }
  }

  const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

  function readWindowState() {
    try {
      const raw = fs.readFileSync(windowStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function clampBoundsToDisplay(bounds) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryWorkArea = primaryDisplay.workArea;
    const scaleFactor = primaryDisplay.scaleFactor;

    const sourceBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    ? { ...bounds }
    : {};

    const minW = 360;
    const minH = 500;

    const width = Math.max(minW, Math.min(sourceBounds.width || 0, primaryWorkArea.width));
    const height = Math.max(minH, Math.min(sourceBounds.height || 0, primaryWorkArea.height));

    const display = screen.getDisplayMatching({
      x: sourceBounds.x ?? primaryWorkArea.x,
      y: sourceBounds.y ?? primaryWorkArea.y,
      width,
      height
    }) || primaryDisplay;

    const workArea = display.workArea;
    const x = Math.min(
      Math.max(sourceBounds.x ?? workArea.x + Math.round((workArea.width - width) / 2), workArea.x),
                       workArea.x + Math.max(0, workArea.width - width)
    );
    const y = Math.min(
      Math.max(sourceBounds.y ?? workArea.y + Math.round((workArea.height - height) / 2), workArea.y),
                       workArea.y + Math.max(0, workArea.height - height)
    );

    return { x, y, width, height };
  }

  function getResponsiveWindowBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const persisted = readWindowState();
    const responsiveBounds = {
      width: Math.round(workArea.width * 0.82),
      height: Math.round(workArea.height * 0.86),
      x: workArea.x + Math.round(workArea.width * 0.09),
      y: workArea.y + Math.round(workArea.height * 0.07)
    };
    const merged = {
      ...responsiveBounds,
      ...(persisted && persisted.bounds ? persisted.bounds : {})
    };
    return clampBoundsToDisplay(merged);
  }

  function persistWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    const bounds = isMaximized || isFullScreen ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    try {
      fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
      fs.writeFileSync(windowStatePath, JSON.stringify({
        bounds,
        isMaximized,
        isFullScreen
      }, null, 2));
    } catch (error) {
      console.warn('Failed to persist window state:', error);
    }
  }

  async function createWindow() {
    serverPort = await startServer(PORT);
    const initialBounds = getResponsiveWindowBounds();
    const savedState = readWindowState();

    const primaryDisplay = screen.getPrimaryDisplay();
    const scaleFactor = primaryDisplay.scaleFactor;

    mainWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: 360,
                                   minHeight: 500,
                                   backgroundColor: '#000000',
                                   title: 'Riffle',
                                   icon: path.join(__dirname, 'assets', 'icon.png'),
                                   frame: false,
                                   titleBarStyle: 'hidden',
                                   show: false,
                                   useContentSize: true,
                                   webPreferences: {
                                     preload: path.join(__dirname, 'preload.js'),
                                   nodeIntegration: false,
                                   contextIsolation: true,
                                   webSecurity: false,
                                   backgroundThrottling: false,
                                   spellcheck: false
                                   }
    });

    if (savedState?.isMaximized) {
      mainWindow.maximize();
    }

    mainWindow.once('ready-to-show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
      }
    });

    mainWindow.on('restore', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });

    mainWindow.on('hide', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
      }
    });

    mainWindow.on('show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });
    mainWindow.on('resize', persistWindowState);
    mainWindow.on('move', persistWindowState);
    mainWindow.on('maximize', persistWindowState);
    mainWindow.on('unmaximize', persistWindowState);
    mainWindow.on('enter-full-screen', persistWindowState);
    mainWindow.on('leave-full-screen', persistWindowState);
    mainWindow.on('close', persistWindowState);
    mainWindow.on('close', (e) => {
      // keep the music going in the tray; Quit from the tray menu really exits
      if (closeToTray && tray && !isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
    mainWindow.on('closed', closeMiniWindow);

    discordRPC.initRPC();
  }

  ipcMain.removeHandler('get-server-port');
  ipcMain.removeHandler('discord-rpc-get-enabled');
  ipcMain.removeHandler('discord-rpc-get-connected');

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

    ipcMain.on('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      }
    });

    ipcMain.on('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

      ipcMain.handle('get-server-port', () => serverPort);

      ipcMain.on('discord-rpc-update', (event, trackInfo) => {
        discordRPC.updatePresence(trackInfo);
      });

      ipcMain.on('discord-rpc-clear', () => {
        discordRPC.clearPresence();
      });

      ipcMain.on('discord-rpc-set-enabled', (event, enabled) => {
        discordRPC.setEnabled(enabled);
      });

      ipcMain.handle('discord-rpc-get-enabled', () => discordRPC.getEnabled());
      ipcMain.handle('discord-rpc-get-connected', () => discordRPC.getConnected());

      ipcMain.handle('get-cache-size', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');

        let webSize = 0;
        try { webSize = await session.defaultSession.getCacheSize(); } catch(e) {}

        let audioSize = 0;
        const tracksDir = require('./platform').CACHE_DIR;
        try {
          if (fs.existsSync(tracksDir)) {
            const files = fs.readdirSync(tracksDir);
            for (const file of files) {
              if (file.includes('.temp.')) {
                try {
                  audioSize += fs.statSync(path.join(tracksDir, file)).size;
                } catch(e) {}
              }
            }
          }
        } catch(e) {}

        return { audio: audioSize, web: webSize };
      });

      ipcMain.handle('clear-cache', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');
        
        try { await session.defaultSession.clearCache(); } catch(e) {}
        try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch(e) {}

        const tracksDir = require('./platform').CACHE_DIR;
        try {
          if (fs.existsSync(tracksDir)) {
            const files = fs.readdirSync(tracksDir);
            for (const file of files) {
              if (file.includes('.temp.')) {
                try { fs.unlinkSync(path.join(tracksDir, file)); } catch(e) {}
              }
            }
          }
        } catch(e) {}

        return true;
      });

      app.on('second-instance', showMainWindow);

      ipcMain.on('set-close-to-tray', (event, enabled) => {
        closeToTray = Boolean(enabled);
      });

      ipcMain.on('set-global-shortcuts', (event, enabled) => {
        if (app.isReady()) setGlobalShortcuts(Boolean(enabled));
        else app.whenReady().then(() => setGlobalShortcuts(Boolean(enabled)));
      });

      ipcMain.on('mini-toggle', toggleMiniWindow);

      ipcMain.on('mini-state', (event, info) => {
        if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('mini-state', info);
      });

      ipcMain.on('mini-command', (event, cmd) => {
        if (cmd === 'expand') {
          showMainWindow();
          closeMiniWindow();
        } else if (cmd === 'close') {
          closeMiniWindow();
          // no tray to fall back on: don't leave the app invisible
          if (!tray && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showMainWindow();
        } else if (typeof cmd === 'string') {
          sendTrayCommand(cmd);
        }
      });

      ipcMain.on('tray-update', (event, info) => {
        trayInfo = Object.assign(trayInfo, info || {});
        refreshTray();
      });

      app.on('will-quit', () => {
        try { globalShortcut.unregisterAll(); } catch (e) {}
      });

      app.on('before-quit', () => {
        isQuitting = true;
        try { require('electron').session.defaultSession.flushStorageData(); } catch(e) {}
      });

      app.whenReady().then(() => {
        createTray();
        createWindow();
        require('./updater').initUpdater(() => mainWindow);
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });

      app.on('window-all-closed', () => {
        discordRPC.destroyRPC();
        if (process.platform !== 'darwin') app.quit();
      });
}
