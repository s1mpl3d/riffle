// an AppImage isn't installed anywhere, so it only shows up in the applications menu
// once it writes its own .desktop entry
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const desktopPath = () => path.join(os.homedir(), '.local', 'share', 'applications', 'riffle.desktop');
const iconPath = () => path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'riffle.png');

function launcherInfo() {
  const image = process.platform === 'linux' && process.env.APPIMAGE;
  return { canInstall: !!image, installed: !!image && fs.existsSync(desktopPath()) };
}

// desktop entry Exec quoting: \ " ` $ are escaped inside quotes and % is doubled
const quoteExec = (file) => '"' + file.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%') + '"';

function installLauncher() {
  const image = process.platform === 'linux' && process.env.APPIMAGE;
  // a line break in the path would add lines to the desktop entry
  if (!image || /[\r\n]/.test(image)) return false;
  try {
    fs.chmodSync(image, 0o755);
    fs.mkdirSync(path.dirname(iconPath()), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'assets', 'icon.png'), iconPath());
    fs.mkdirSync(path.dirname(desktopPath()), { recursive: true });
    fs.writeFileSync(desktopPath(), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Riffle',
      'GenericName=Music Player',
      'Comment=Music player',
      `Exec=${quoteExec(image)} %U`,
      `TryExec=${image}`,
      `Icon=${iconPath()}`,
      'Terminal=false',
      'Categories=AudioVideo;Audio;Player;Music;',
      `StartupWMClass=${app.getName()}`,
      ''
    ].join('\n'));
    execFile('update-desktop-database', [path.dirname(desktopPath())], () => {});
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { launcherInfo, installLauncher, quoteExec };
