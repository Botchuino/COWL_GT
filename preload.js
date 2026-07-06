// preload.js — exposes the window.dash API to the renderer over a secure bridge.
// contextIsolation:true + nodeIntegration:false: the renderer only sees these methods.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  // --- config ---
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // --- state ---
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    // Register a listener for every state.json change. cb receives the state object.
    ipcRenderer.on('state:update', (_e, state) => {
      try { cb(state); } catch (_err) { /* swallow renderer callback errors */ }
    });
  },

  // --- actions (keystroke injection) ---
  shift: (gearNumber) => ipcRenderer.invoke('action:shift', gearNumber),
  boost: () => ipcRenderer.invoke('action:boost'),
  runButton: (index) => ipcRenderer.invoke('action:runButton', index),
  wipe: (modeIndex) => ipcRenderer.invoke('action:wipe', modeIndex),
  stop: () => ipcRenderer.invoke('action:stop'),

  // --- terminal targeting ---
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  setTerminal: (name) => ipcRenderer.invoke('terminals:set', name),

  // --- backend availability (display-only "vetrina" mode) ---
  probeInjection: () => ipcRenderer.invoke('inject:probe'),

  // --- window controls ---
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleClose: () => ipcRenderer.send('win:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('win:toggleAlwaysOnTop'),

  // --- self-update ("richiamo in officina") ---
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update:available', (_e, info) => {
      try { cb(info); } catch (_err) { /* swallow renderer callback errors */ }
    });
  },
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply')
});
