// lib/config.js
// Loads and saves the dashboard configuration.
// The shipped defaults live next to the app (config.default.json). The runtime,
// user-editable config lives at ~/.claude/dashboard/config.json and is seeded
// from the defaults on first load. load() returns the runtime config merged
// OVER the defaults so newly-added default keys keep working after upgrades.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Directory the app is installed/running from (repo during dev, ~/.claude/dashboard at runtime).
// __dirname is <appDir>/lib, so the app dir is one level up.
const APP_DIR = path.join(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(APP_DIR, 'config.default.json');

// Fixed runtime location (per the shared contract).
const RUNTIME_DIR = path.join(os.homedir(), '.claude', 'dashboard');
const RUNTIME_CONFIG_PATH = path.join(RUNTIME_DIR, 'config.json');

// Last-resort defaults if config.default.json is missing/unreadable, so the app
// never crashes on a broken install.
const HARDCODED_DEFAULTS = {
  targetTerminal: 'auto',
  // Bare shells (pwsh/powershell/cmd) sit BELOW Code/Cursor: any incidental
  // console window has those process names, so in "auto" mode they must never
  // preempt the editor terminal where Claude Code actually runs.
  knownTerminals: ['iTerm2', 'iTerm', 'Terminal', 'Ghostty', 'WezTerm', 'kitty', 'Alacritty', 'Warp', 'Hyper', 'WindowsTerminal', 'wezterm-gui', 'org.wezfurlong.wezterm', 'mintty', 'ConEmu64', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'tilix', 'terminator', 'xterm', 'Code', 'Cursor', 'pwsh', 'powershell', 'cmd'],
  injectEnterDelayMs: 250,
  activateDelayMs: 150,
  gears: [],
  nos: { label: 'OVERDRIVE', keystrokes: 'ultracode ', enter: false },
  skillButtons: [],
  wipers: {
    label: 'TERGI',
    modes: [
      { label: 'INT', keystrokes: '/compact', enter: true, confirm: false },
      // No safety by default; re-armable per-mode via the "confirm" flag,
      // toggleable from Garage Settings › Safety.
      { label: 'FULL', keystrokes: '/clear', enter: true, confirm: false }
    ]
  }
};

// Read + parse a JSON file, returning null on any failure.
function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

// Load the shipped defaults (fall back to hardcoded if the file is missing/bad).
function loadDefaults() {
  const fromFile = readJsonSafe(DEFAULT_CONFIG_PATH);
  return fromFile && typeof fromFile === 'object' ? fromFile : HARDCODED_DEFAULTS;
}

// Shallow-merge overrides over base. Arrays and nested objects in overrides
// replace the base value wholesale (config is intentionally simple/flat-ish;
// a user who overrides "gears" means to replace the list).
function mergeConfig(base, overrides) {
  const out = Object.assign({}, base);
  if (overrides && typeof overrides === 'object') {
    for (const key of Object.keys(overrides)) {
      if (overrides[key] !== undefined) out[key] = overrides[key];
    }
  }
  return out;
}

// Ensure the runtime directory exists.
function ensureRuntimeDir() {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  } catch (_err) {
    /* best effort */
  }
}

// Load the effective config: defaults with the runtime file merged on top.
// Seeds the runtime file from defaults on first run.
function load() {
  const defaults = loadDefaults();
  ensureRuntimeDir();

  let runtime = readJsonSafe(RUNTIME_CONFIG_PATH);
  if (runtime === null) {
    // First load (or unreadable): seed the runtime file from defaults.
    try {
      fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(defaults, null, 2), 'utf8');
    } catch (_err) {
      /* best effort; still return defaults in-memory */
    }
    runtime = {};
  }

  return mergeConfig(defaults, runtime);
}

// Persist the given config object to the runtime file.
function save(cfg) {
  ensureRuntimeDir();
  const data = cfg && typeof cfg === 'object' ? cfg : {};
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  load,
  save,
  RUNTIME_CONFIG_PATH,
  RUNTIME_DIR,
  DEFAULT_CONFIG_PATH
};
