// lib/inject.js
// Cross-platform keystroke-injection dispatcher. Selects the per-OS backend —
// macOS: osascript + System Events (inject-darwin.js)
// Windows: PowerShell + SendKeys      (inject-win32.js)
// Linux:  xdotool, X11/XWayland       (inject-linux.js)
// — and keeps the platform-neutral pieces here: target-terminal resolution,
// chord parsing (re-exported for tests) and the settings.json model writer.
//
// Shared backend contract: injectText/injectChord never throw — they resolve
// { ok, method:'keystroke', error? } — and user-provided strings are NEVER
// interpolated into script source (argv on macOS, env vars on Windows,
// separate argv after `--` on Linux).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseChord, isWSL } = require('./inject-common');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// --- Backend selection --------------------------------------------------------

const BACKEND_MODULES = {
  darwin: './inject-darwin',
  win32: './inject-win32',
  linux: './inject-linux',
  // WSL bridge: inside WSL the terminal that runs Claude Code is almost always
  // a Windows app (VS Code, Windows Terminal) — invisible to xdotool. Windows
  // interop lets us spawn powershell.exe from Linux, so the win32 backend
  // drives it directly (env vars cross via WSLENV, see inject-win32.js).
  wsl: './inject-win32'
};

const BACKEND_ID = (process.platform === 'linux' && isWSL()) ? 'wsl' : process.platform;

let backend;
if (BACKEND_MODULES[BACKEND_ID]) {
  backend = require(BACKEND_MODULES[BACKEND_ID]);
} else {
  const unsupported = 'Keystroke injection is not supported on this platform: ' + process.platform;
  backend = {
    listRunningTerminals: async () => [],
    injectText: async () => ({ ok: false, method: 'keystroke', error: unsupported }),
    injectChord: async () => ({ ok: false, method: 'keystroke', error: unsupported }),
    probe: async () => ({ available: false, reason: unsupported })
  };
}

// Backend availability check (display-only "vetrina" mode). A POSITIVE answer
// is a durable machine property and is cached forever; a NEGATIVE one can be
// moment-scoped (interop cold-start timeout, transient spawn failure), so it
// is returned but not pinned — the next call re-probes. Concurrent callers
// always share the in-flight promise.
let probePromise = null;
function probeBackend() {
  if (!probePromise) {
    probePromise = Promise.resolve()
      .then(() => (typeof backend.probe === 'function'
        ? backend.probe()
        : { available: true }))
      .then((r) => Object.assign({ backend: BACKEND_ID }, r))
      .catch((err) => ({
        backend: BACKEND_ID,
        available: false,
        reason: String(err && err.message ? err.message : err)
      }))
      .then((res) => {
        if (!res.available) probePromise = null;
        return res;
      });
  }
  return probePromise;
}

// --- Target resolution (platform-neutral) --------------------------------------

function listRunningTerminals(config) {
  return backend.listRunningTerminals(config);
}

// Resolve which app to target. If config.targetTerminal !== "auto", trust it.
// Otherwise pick the first running known terminal. Returns null if none found.
async function pickTargetApp(config) {
  const target = config && config.targetTerminal;
  if (target && target !== 'auto') return target;
  const running = await listRunningTerminals(config);
  return running.length ? running[0] : null;
}

// --- Injection (delegated) ------------------------------------------------------

function injectText(appName, text, opts) {
  return backend.injectText(appName, text, opts || {});
}

function injectChord(appName, chord, opts) {
  return backend.injectChord(appName, chord, opts || {});
}

// --- settings.json model writer ---------------------------------------------

// Best-effort: set .model in ~/.claude/settings.json to modelArg, preserving other
// keys and 2-space indent. Silently skips if the file is missing/unparseable.
// Returns { ok, error? } but callers should not gate the keystroke on this.
function writeModelToSettings(modelArg) {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return { ok: false, error: 'settings.json not an object' };
    settings.model = modelArg;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    // Missing file / parse error / write error: skip silently per contract.
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  injectText,
  injectChord,
  pickTargetApp,
  listRunningTerminals,
  writeModelToSettings,
  probeBackend,
  parseChord, // exported for potential testing
  SETTINGS_PATH
};
