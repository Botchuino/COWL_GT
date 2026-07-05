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

  // --- terminal targeting ---
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  setTerminal: (name) => ipcRenderer.invoke('terminals:set', name),

  // --- window controls ---
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleClose: () => ipcRenderer.send('win:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('win:toggleAlwaysOnTop')
});
