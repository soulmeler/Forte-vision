const { app, BrowserWindow, dialog, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');

const platformRoot = path.resolve(__dirname, '../../platform');
let ownedServer;
let mainWindow;

function openExternal(value) {
  const url = new URL(value);
  if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
    shell.openExternal(url.href).catch(console.error);
  }
}

async function serverAvailable(origin) {
  try {
    const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    const status = await response.json();
    if (!response.ok || status.service !== 'vision-forte') throw new Error('Порт занят другим сервисом.');
    return true;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw error;
  }
}

async function preparePlatform() {
  if (app.isPackaged) return prepareInstalledPlatform();
  const { configure } = await import(pathToFileURL(path.join(platformRoot, 'scripts/configure.mjs')).href);
  configure();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3001);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Для Electron настройте локальные HOST и PORT в platform/.env.');
  }
  const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  if (await serverAvailable(origin)) return origin;
  let startupError;
  ownedServer = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: platformRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  ownedServer.on('error', (error) => { startupError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    if (ownedServer.exitCode !== null || ownedServer.signalCode !== null) throw new Error('Сервер платформы завершился при запуске.');
    if (await serverAvailable(origin)) return origin;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Сервер не запустился за 20 секунд. Проверьте сборку platform/dist.');
}

async function prepareInstalledPlatform() {
  const resources = path.join(process.resourcesPath, 'platform');
  const dataDir = path.join(app.getPath('userData'), 'storage');
  fs.mkdirSync(dataDir, { recursive: true });
  // Each installed app owns a private loopback service on a free port. No shared
  // credentials, developer .env, or working-directory assumptions are packaged.
  ownedServer = spawn(process.execPath, [path.join(__dirname, 'runtime.cjs')], {
    cwd: app.getPath('userData'), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
      VISION_RESOURCES: resources, VISION_DATA_DIR: dataDir,
      VISION_SESSION_KEY: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  // Never forward request bodies, credentials, or remote server output to logs.
  ownedServer.stderr?.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ownedServer?.kill(); reject(new Error('Сервис платформы не запустился за 30 секунд.')); }, 30000);
    const fail = () => { clearTimeout(timer); reject(new Error('Не удалось запустить встроенный сервис платформы.')); };
    ownedServer.once('error', fail);
    ownedServer.once('exit', fail);
    ownedServer.on('message', (message) => {
      if (message?.type !== 'ready' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)) return;
      clearTimeout(timer); ownedServer.removeListener('error', fail); ownedServer.removeListener('exit', fail);
      ownedServer.once('exit', () => { if (!app.isQuitting) { dialog.showErrorBox('Сервис остановлен', 'Перезапустите Vision Forte.'); app.quit(); } });
      resolve(message.origin);
    });
  });
}

app.setName('Vision Forte');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show(); mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    const origin = await preparePlatform();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const createWindow = async () => {
      mainWindow = new BrowserWindow({
        title: 'Vision Forte', width: 1480, height: 980, minWidth: 1024, minHeight: 700,
        backgroundColor: '#f6f6f7', show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
      mainWindow.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
      });
      mainWindow.webContents.on('will-prevent-unload', (event) => {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'question', buttons: ['Продолжить загрузку', 'Закрыть окно'], defaultId: 0, cancelId: 0,
          message: 'Загрузка видео ещё выполняется. Закрыть окно?',
        });
        if (choice === 1) event.preventDefault();
      });
      mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
      mainWindow.on('closed', () => { mainWindow = null; });
      await mainWindow.loadURL(origin);
      console.log(`Electron platform ready: ${origin}`);
    };
    await createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow().catch(console.error); });
  }).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Не удалось открыть платформу', error.message);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  app.isQuitting = true;
  if (!ownedServer || ownedServer.exitCode !== null || ownedServer.signalCode !== null) return;
  if (!app.isPackaged) { ownedServer.kill('SIGTERM'); return; }
  event.preventDefault();
  const child = ownedServer; ownedServer = null;
  const timer = setTimeout(() => { child.kill(); app.quit(); }, 10000);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
  if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
process.on('exit', () => { ownedServer?.kill('SIGTERM'); });
