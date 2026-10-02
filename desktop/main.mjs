// Electron main process. Serves web/ from a private app:// origin and runs the shared Node probe
// engine for the renderer over IPC, so checks are CORS-free with no local server or port.
import { app, BrowserWindow, protocol, net, ipcMain, dialog, nativeTheme, shell } from 'electron';
import { join, dirname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { probeBatch } from './shared/probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, 'web');
const STATE_FILE = join(app.getPath('userData'), 'window-state.json');
const ORIGIN = 'app://site-status';
const BG = { dark: '#0b111c', light: '#f4f6fa' };

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return { width: 1120, height: 800 }; }
}

async function createWindow() {
  const state = await loadState();
  win = new BrowserWindow({
    ...state,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'Site Status',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light,
    autoHideMenuBar: true,
    icon: join(here, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // keep the heartbeat ticking when minimised
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    writeFile(STATE_FILE, JSON.stringify({ ...bounds, maximized })).catch(() => {});
  });

  // Links to monitored sites open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });

  await win.loadURL(`${ORIGIN}/index.html`);
  if (process.env.SITESTATUS_SMOKE) smokeTest();
}

/** CI/dev self-check: SITESTATUS_SMOKE=1 electron . -> prints renderer state as JSON and exits. */
async function smokeTest() {
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`document.getElementById('empty-examples')?.click()`);
  await new Promise(r => setTimeout(r, 6000));
  const report = await win.webContents.executeJavaScript(`({
    transport: document.getElementById('transport').textContent,
    font: document.fonts.check('16px "Google Sans"'),
    sites: [...document.querySelectorAll('.site')].map(s => s.querySelector('.site-name').textContent + ': ' + s.querySelector('.pill').textContent),
    banner: document.getElementById('banner-text').textContent,
  })`);
  console.log('SMOKE ' + JSON.stringify(report));
  app.exit(0);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  protocol.handle('app', request => {
    const { host, pathname } = new URL(request.url);
    if (host !== 'site-status') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = normalize(join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // ---- IPC (the only capabilities the renderer gets) ----
  ipcMain.handle('probe-batch', (event, urls, opts) => {
    if (!event.senderFrame?.url.startsWith(ORIGIN)) throw new Error('Untrusted sender');
    if (!Array.isArray(urls) || urls.length > 500 || urls.some(u => typeof u !== 'string')) throw new Error('Bad request');
    const timeoutMs = Math.min(10_000, Math.max(1000, Number(opts?.timeoutMs) || 10_000));
    // The user's own machine: private/LAN targets are allowed
    return probeBatch(urls, { timeoutMs, allowPrivate: true, transport: 'electron' });
  });

  ipcMain.handle('save-file', async (event, name, text) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: String(name).replace(/[^\w.-]/g, '_'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    await writeFile(filePath, String(text), 'utf8');
    return true;
  });

  ipcMain.handle('open-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return null;
    return readFile(filePaths[0], 'utf8');
  });

  ipcMain.on('set-theme', (_e, theme) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
    win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
  });

  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
