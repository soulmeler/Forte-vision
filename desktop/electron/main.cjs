const { app, BrowserWindow, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'kassa', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function backendURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Укажите локальный адрес, например http://127.0.0.1:8000');
  return url.origin;
}
app.whenReady().then(() => {
  protocol.handle('kassa', request => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const root = path.join(__dirname, '../ui');
    const target = path.resolve(root, '.' + relative);
    if (url.hostname !== 'app' || !target.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('source:open', (event, value) => {
    const source = new URL(event.senderFrame.url);
    const url = new URL(value);
    if (event.senderFrame !== event.sender.mainFrame || source.protocol !== 'kassa:' || source.hostname !== 'app' || url.protocol !== 'https:' || !['adilet.zan.kz', 'old.adilet.zan.kz', 'nationalbank.kz', 'www.nationalbank.kz', 'zan.gov.kz'].includes(url.hostname) || url.username || url.password) throw new Error('Unsupported source');
    return shell.openExternal(url.href);
  });
  ipcMain.handle('backend:request', async (event, request) => {
    const source = new URL(event.senderFrame.url);
    if (event.senderFrame !== event.sender.mainFrame || source.protocol !== 'kassa:' || source.hostname !== 'app') throw new Error('Unknown sender');
    const base = backendURL(request.baseUrl);
    if (typeof request.apiKey !== 'string' || request.apiKey.length > 2048) throw new Error('Некорректный API-ключ');
    const headers = { 'X-API-Key': request.apiKey };
    let body, route, method;
    if (request.action === 'analyze') {
      if (!(request.bytes instanceof ArrayBuffer) || request.bytes.byteLength > 300 * 1024 * 1024 || !/\.(mov|mp4|webm)$/i.test(request.name)) throw new Error('Некорректный видеофайл');
      body = new FormData();
      body.append('file', new Blob([request.bytes], { type: request.mime || 'video/quicktime' }), path.basename(request.name));
      method = 'POST'; route = '/api/v1/analyze';
    } else if (request.action === 'job' && typeof request.jobId === 'string' && /^[\w-]{1,128}$/.test(request.jobId)) {
      method = 'GET'; route = '/api/v1/jobs/' + encodeURIComponent(request.jobId);
    } else throw new Error('Unknown operation');
    try {
      const response = await fetch(base + route, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(request.action === 'analyze' ? 60000 : 15000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'API отклонил ключ доступа.' : `API вернул HTTP ${response.status}.`);
      return await response.json();
    } catch (error) { throw new Error(error.message === 'fetch failed' ? 'Локальный API недоступен. Проверьте адрес и запустите backend.' : error.message); }
  });
  function createWindow() {
    const window = new BrowserWindow({ width: 1440, height: 980, minWidth: 900, minHeight: 650, title: 'vision-forte', backgroundColor: '#f6f6f7', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 20 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('kassa://app/')) event.preventDefault(); });
    window.loadURL('kassa://app/');
  }
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
