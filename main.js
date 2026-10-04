const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'm4v', 'mov'];
const SUB_EXT = ['.vtt', '.srt'];

/* ---------- Zoom (Ctrl +/-, Ctrl 0, Ctrl + mouse wheel) ---------- */
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const settingsFile = () => path.join(app.getPath('userData'), 'window-settings.json');
function loadZoom() {
  try { const z = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).zoom; return ZOOM_STEPS.includes(z) ? z : 1; }
  catch { return 1; }
}
function saveZoom(z) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify({ zoom: z })); } catch { /* ignore */ }
}
function applyZoom(wc, z, announce = true) {
  wc.setZoomFactor(z);
  saveZoom(z);
  if (announce) wc.send('zoom-changed', Math.round(z * 100));
}
function stepZoom(wc, dir) {
  const cur = wc.getZoomFactor();
  let i = ZOOM_STEPS.findIndex((s) => Math.abs(s - cur) < 0.01);
  if (i === -1) i = ZOOM_STEPS.indexOf(1);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
  applyZoom(wc, next);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a101a',
    title: 'Anime Stream+',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1624', symbolColor: '#e9eef6', height: 64 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // ◄ Enables cross-origin streaming playback from external servers
      webviewTag: true,
      experimentalFeatures: true
    }
  });

  // Block ad popups originating from embedded streaming sources
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(anilist\.co|github\.com)/i.test(url)) {
      shell.openExternal(url);
    }
    // Deny ad popups and popup windows from streaming providers
    return { action: 'deny' };
  });

  const wc = win.webContents;
  wc.on('did-finish-load', () => applyZoom(wc, loadZoom(), false));

  // Keyboard zoom
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const k = input.key, c = input.code;
    if (k === '=' || k === '+' || c === 'NumpadAdd') { event.preventDefault(); stepZoom(wc, 1); }
    else if (k === '-' || k === '_' || c === 'NumpadSubtract') { event.preventDefault(); stepZoom(wc, -1); }
    else if (k === '0' || c === 'Numpad0') { event.preventDefault(); applyZoom(wc, 1); }
  });

  // Ctrl + mouse wheel (and touchpad pinch)
  wc.on('zoom-changed', (_e, direction) => stepZoom(wc, direction === 'in' ? 1 : -1));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Configure session to strip X-Frame-Options and CSP headers to allow embedding anime streaming sources
function setupStreamSession() {
  const { session } = require('electron');

  // Strip frame-blocking response headers (X-Frame-Options, frame-ancestors)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options') {
        delete responseHeaders[key];
      } else if (lower === 'content-security-policy') {
        responseHeaders[key] = responseHeaders[key].map((csp) =>
          csp.replace(/frame-ancestors[^;]*(;|$)/gi, '')
        );
      }
    }
    callback({ responseHeaders });
  });

  // Provide a clean browser User-Agent so streaming hosts don't reject Electron
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = Object.assign({}, details.requestHeaders);
    if (!requestHeaders['User-Agent'] || requestHeaders['User-Agent'].includes('Electron')) {
      requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    }
    callback({ requestHeaders });
  });

  // ── Anikoto Fork: sniff stream URLs from the 'persist:anikoto' webview partition ──
  const forkPartition = session.fromPartition('persist:anikoto');

  // Fake browser UA for Anikoto partition
  forkPartition.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = Object.assign({}, details.requestHeaders);
    requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    requestHeaders['Referer'] = 'https://anikototv.to/';
    requestHeaders['Origin'] = 'https://anikototv.to';
    callback({ requestHeaders });
  });

  // Strip CSP/X-Frame-Options from anikoto partition responses
  forkPartition.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options') delete responseHeaders[key];
      else if (lower === 'content-security-policy') {
        responseHeaders[key] = responseHeaders[key].map((csp) =>
          csp.replace(/frame-ancestors[^;]*(;|$)/gi, '')
        );
      }
    }
    callback({ responseHeaders });
  });

  // Intercept resource requests in the fork partition to sniff stream URLs
  const STREAM_PATTERNS = /\.(m3u8|mp4|webm|ts)(\?|$|&|#)/i;
  const STREAM_PATHS = /\/(hls|stream|manifest|video|playlist)\//i;

  forkPartition.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || '';
    if (STREAM_PATTERNS.test(url) || STREAM_PATHS.test(url)) {
      // Notify all renderer windows
      const wins = require('electron').BrowserWindow.getAllWindows();
      wins.forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('fork-stream-detected', url);
        }
      });
    }
    callback({});
  });
}


// Look for a subtitle file sitting next to the video with the same name
function findSidecarSub(videoPath) {
  const base = videoPath.slice(0, -path.extname(videoPath).length);
  for (const ext of SUB_EXT) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

ipcMain.handle('pick-videos', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose episode files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video files', extensions: VIDEO_EXT }]
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    name: path.basename(p),
    path: p,
    url: pathToFileURL(p).href,
    sub: findSidecarSub(p)
  }));
});

ipcMain.handle('pick-subtitle', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a subtitle file',
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['vtt', 'srt'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const p = result.filePaths[0];
  return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
});

ipcMain.handle('read-subtitle', async (_e, p) => {
  try {
    if (!p || !SUB_EXT.includes(path.extname(p).toLowerCase())) return null;
    return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
  } catch {
    return null;
  }
});

ipcMain.handle('file-exists', async (_e, p) => {
  try { return !!p && fs.existsSync(p); } catch { return false; }
});

// AniList login: opens AniList's sign-in page and catches the access token it sends back
ipcMain.handle('anilist-login', async (event, clientId) => {
  if (!/^\d+$/.test(String(clientId || ''))) return { error: 'Enter your AniList client ID (a number) first.' };
  const parent = BrowserWindow.fromWebContents(event.sender);
  return new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      parent, modal: true, width: 520, height: 760, autoHideMenuBar: true,
      backgroundColor: '#0b1622', title: 'Log in to AniList',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: { partition: 'persist:anilist', contextIsolation: true, nodeIntegration: false }
    });
    const check = (url) => {
      const m = String(url).match(/[#&?]access_token=([^&]+)/);
      if (m && !done) {
        done = true;
        resolve({ token: decodeURIComponent(m[1]) });
        setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 300);
      }
    };
    win.webContents.on('will-redirect', (_e, url) => check(url));
    win.webContents.on('will-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => { if (!done) resolve({ cancelled: true }); });
    win.loadURL(`https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`);
  });
});

ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
});

app.whenReady().then(() => {
  setupStreamSession();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
