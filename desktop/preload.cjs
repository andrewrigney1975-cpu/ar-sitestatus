// Sandboxed preload: exposes a minimal, typed bridge to the main process. Nothing else from
// Node or Electron reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siteStatusNative', {
  platform: process.platform,
  probeBatch: (urls, opts) => ipcRenderer.invoke('probe-batch', urls, opts),
  saveFile: (name, text) => ipcRenderer.invoke('save-file', name, text),
  openFile: () => ipcRenderer.invoke('open-file'),
  setTheme: theme => ipcRenderer.send('set-theme', theme),
});
