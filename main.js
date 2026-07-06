// main.js — Electron main process for the vintage classic-car Claude Code dashboard.
// Creates a frameless window, wires all ipcMain handlers backing window.dash,
// and pushes live session state to the renderer.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const config = require('./lib/config');
const inject = require('./lib/inject');
const statewatch = require('./lib/statewatch');
const updater = require('./lib/updater');

let mainWindow = null;
let stopWatch = null;
let updateTimer = null;
let lastUpdateInfo = null; // { available, local, remote } from the last check

// alwaysOnTop is user-toggleable at runtime; default true.
let alwaysOnTop = true;

// --- Active-gear matching ----------------------------------------------------
// Per contract: lowercase state.modelId; a gear "matches" when ALL its match
// tokens are substrings of the id; among matches, the one with the MOST matched
// tokens wins (most specific); ties go to the LATER gear (gears are ordered
// least→most specific, so plain "opus-4-8" engages gear 5, not gear 4).
// Returns the gear number, or null.
function computeActiveGear(state, cfg) {
  if (!state || !state.modelId || !cfg || !Array.isArray(cfg.gears)) return null;
  const id = String(state.modelId).toLowerCase();
  let best = null;
  let bestCount = -1;
  for (const gear of cfg.gears) {
    const tokens = Array.isArray(gear.match) ? gear.match : [];
    if (!tokens.length) continue;
    const allMatch = tokens.every((t) => id.includes(String(t).toLowerCase()));
    if (allMatch && tokens.length >= bestCount) {
      best = gear.gear;
      bestCount = tokens.length;
    }
  }
  return best;
}

// --- targetApp cache -----------------------------------------------------------
// decorateState must never block on osascript, so the injection target terminal
// name is resolved ASYNCHRONOUSLY (same logic as the actions: inject.pickTargetApp)
// and cached. Refreshed at most every 5s; on resolution failure the last known
// value (possibly null) is kept.
const TARGET_APP_REFRESH_MS = 5000;
let cachedTargetApp = null;
let targetAppLastAttempt = 0;
let targetAppResolving = false;

function refreshTargetApp() {
  const now = Date.now();
  if (targetAppResolving || (now - targetAppLastAttempt) < TARGET_APP_REFRESH_MS) return;
  targetAppResolving = true;
  targetAppLastAttempt = now;
  Promise.resolve()
    .then(() => inject.pickTargetApp(config.load()))
    .then((appName) => {
      // A resolved value (including null = no terminal running) is authoritative.
      cachedTargetApp = appName || null;
    })
    .catch(() => { /* keep last known value */ })
    .then(() => { targetAppResolving = false; });
}

// Attach the computed activeGear + cached targetApp to a state object
// (non-destructive copy) so the renderer can highlight without re-implementing
// the matching rule. Kicks off a background targetApp refresh but reads the
// cache synchronously — state pushes are never slowed.
function decorateState(state) {
  if (!state) return state;
  refreshTargetApp();
  const cfg = config.load();
  return Object.assign({}, state, {
    activeGear: computeActiveGear(state, cfg),
    targetApp: cachedTargetApp
  });
}

// --- Window ------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 700,   // > the 600px/500px compact-height and 780px narrow-width CSS breakpoints, so the default view is the full V3 layout
    minWidth: 640,
    minHeight: 420,
    frame: false,          // we draw our own controls
    transparent: false,
    resizable: true,
    alwaysOnTop: alwaysOnTop,
    backgroundColor: '#1a1410',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false        // preload requires lib modules
    }
  });

  if (alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Start watching the state file; push decorated updates to the renderer.
  stopWatch = statewatch.watch((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:update', decorateState(state));
    }
  });
}

// --- Update check ("richiamo in officina") ----------------------------------
// Runs in the main process (the renderer's CSP forbids network). Notifies the
// renderer to light the recall telltale when a newer version is on GitHub.
// Throttled to once per day via lib/updater; `force` bypasses the throttle for
// the manual "check now" action.
function runUpdateCheck(force) {
  if (!force && !updater.shouldCheck()) return Promise.resolve(lastUpdateInfo);
  return updater.checkForUpdate()
    .then((info) => {
      lastUpdateInfo = info;
      updater.recordCheck({ lastSeenRemote: info.remote });
      if (info.available && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', info);
      }
      return info;
    })
    .catch((err) => {
      // Offline / rate-limited / DNS: never bother the user, just try tomorrow.
      updater.recordCheck({ lastError: String(err && err.message || err) });
      return { available: false, error: String(err && err.message || err) };
    });
}

// --- IPC handlers (back window.dash) ----------------------------------------

function registerIpc() {
  ipcMain.handle('config:get', () => config.load());

  ipcMain.handle('config:save', (_e, cfg) => {
    config.save(cfg);
  });

  ipcMain.handle('state:get', () => {
    const state = statewatch.readState();
    return state ? decorateState(state) : null;
  });

  // shift(gearNumber): type "/model <arg>"+Return into the terminal AND persist
  // the choice to settings.json for future sessions (best-effort).
  ipcMain.handle('action:shift', async (_e, gearNumber) => {
    const cfg = config.load();
    const gears = Array.isArray(cfg.gears) ? cfg.gears : [];
    const gear = gears.find((g) => g.gear === gearNumber);
    if (!gear) {
      return { ok: false, method: 'keystroke', error: 'Unknown gear: ' + gearNumber };
    }
    // Persist for future sessions (does not block the keystroke).
    inject.writeModelToSettings(gear.modelArg);

    const appName = await inject.pickTargetApp(cfg);
    return inject.injectText(appName, '/model ' + gear.modelArg, {
      enter: true,
      activateDelayMs: cfg.activateDelayMs,
      injectEnterDelayMs: cfg.injectEnterDelayMs
    });
  });

  // boost(): the OVERDRIVE / NOS action.
  ipcMain.handle('action:boost', async () => {
    const cfg = config.load();
    const nos = cfg.nos || {};
    const appName = await inject.pickTargetApp(cfg);
    return inject.injectText(appName, nos.keystrokes != null ? nos.keystrokes : '', {
      enter: !!nos.enter,
      activateDelayMs: cfg.activateDelayMs,
      injectEnterDelayMs: cfg.injectEnterDelayMs
    });
  });

  // runButton(index): a skill toggle/button — either text or chord.
  ipcMain.handle('action:runButton', async (_e, index) => {
    const cfg = config.load();
    const buttons = Array.isArray(cfg.skillButtons) ? cfg.skillButtons : [];
    const btn = buttons[index];
    if (!btn) return { ok: false, error: 'No skill button at index ' + index };
    const appName = await inject.pickTargetApp(cfg);
    if (btn.type === 'chord') {
      return inject.injectChord(appName, btn.chord, { activateDelayMs: cfg.activateDelayMs });
    }
    // default: text
    return inject.injectText(appName, btn.keystrokes != null ? btn.keystrokes : '', {
      enter: !!btn.enter,
      activateDelayMs: cfg.activateDelayMs,
      injectEnterDelayMs: cfg.injectEnterDelayMs
    });
  });

  // wipe(modeIndex): the wiper stalk — injects the mode's keystrokes (e.g.
  // /compact for INT, /clear for FULL). The "confirm" flag on a mode is a
  // renderer-side concern (double-click guard); main injects unconditionally.
  ipcMain.handle('action:wipe', async (_e, modeIndex) => {
    const cfg = config.load();
    const wipers = cfg.wipers || {};
    const modes = Array.isArray(wipers.modes) ? wipers.modes : [];
    const mode = modes[modeIndex];
    if (!mode) return { ok: false, error: 'No wiper mode at index ' + modeIndex };
    const appName = await inject.pickTargetApp(cfg);
    return inject.injectText(appName, mode.keystrokes != null ? mode.keystrokes : '', {
      enter: !!mode.enter,
      activateDelayMs: cfg.activateDelayMs,
      injectEnterDelayMs: cfg.injectEnterDelayMs
    });
  });

  // stop(): the R (retromarcia) gate position — sends Escape to the target
  // terminal, interrupting Claude Code's current run. Momentary by design:
  // the renderer springs the lever back to the engaged gear on its own.
  ipcMain.handle('action:stop', async () => {
    const cfg = config.load();
    const appName = await inject.pickTargetApp(cfg);
    return inject.injectChord(appName, 'escape', { activateDelayMs: cfg.activateDelayMs });
  });

  ipcMain.handle('terminals:list', () => {
    const cfg = config.load();
    return inject.listRunningTerminals(cfg);
  });

  ipcMain.handle('terminals:set', (_e, name) => {
    const cfg = config.load();
    cfg.targetTerminal = name;
    config.save(cfg);
  });

  // Window controls.
  ipcMain.on('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('win:close', () => {
    app.quit();
  });

  ipcMain.handle('win:toggleAlwaysOnTop', () => {
    alwaysOnTop = !alwaysOnTop;
    if (mainWindow) mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
    return alwaysOnTop;
  });

  // --- self-update ("richiamo in officina") ---
  // Manual re-check (⌥ bypasses the daily throttle).
  ipcMain.handle('update:check', () => runUpdateCheck(true));

  // Apply: download + overlay the fresh files, then relaunch into the new
  // version. On success the app quits and comes back, so the resolved value is
  // only seen by the renderer when something failed before the relaunch.
  ipcMain.handle('update:apply', async () => {
    try {
      const result = await updater.applyUpdate();
      app.relaunch();
      app.exit(0);
      return { ok: true, newVersion: result.newVersion };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });
}

// --- App lifecycle -----------------------------------------------------------

// Single-instance lock: a 2nd launch focuses the existing window and exits.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();

    // Recall check: once ~20s after boot (so it never competes with the window
    // showing), then re-armed every 6h. lib/updater throttles the actual
    // network call to at most once per day.
    updateTimer = setTimeout(function armUpdateChecks() {
      runUpdateCheck(false);
      updateTimer = setInterval(() => runUpdateCheck(false), 6 * 60 * 60 * 1000);
    }, 20000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Single-window utility: quit when the window closes (including on macOS).
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    if (stopWatch) {
      try { stopWatch(); } catch (_e) { /* ignore */ }
      stopWatch = null;
    }
    if (updateTimer) {
      clearTimeout(updateTimer);
      clearInterval(updateTimer);
      updateTimer = null;
    }
  });
}
