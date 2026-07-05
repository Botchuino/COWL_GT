// lib/inject.js
// macOS keystroke injection into the target terminal app via osascript + System Events.
//
// SECURITY / CORRECTNESS: user-provided strings (model args like "opus[1m]", NOS text,
// skill keystrokes) are NEVER interpolated into AppleScript source. They are passed as
// ARGV to an `on run argv` script, so quotes/backslashes/brackets can't break the script
// or inject AppleScript. This is mandated by the shared contract.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// --- Promise wrapper around execFile('osascript', ...) -----------------------

function runOsascript(args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        // Surface stderr (osascript writes useful errors there) when present.
        const msg = (stderr && stderr.trim()) || err.message || 'osascript failed';
        reject(new Error(msg));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

// small delay helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

// --- Discover running terminal apps -----------------------------------------

// Returns the list of System Events process names that are currently running.
function listRunningProcesses() {
  // No user data interpolated here; static script.
  const script = 'tell application "System Events" to get name of every process';
  return runOsascript(['-e', script])
    .then((out) => {
      if (!out) return [];
      // osascript returns a comma+space separated list.
      return out.split(',').map((s) => s.trim()).filter(Boolean);
    })
    .catch(() => []);
}

// Intersect running processes with the config's knownTerminals (case-insensitive),
// preserving the knownTerminals order (which encodes user preference/priority).
async function listRunningTerminals(config) {
  const known = (config && Array.isArray(config.knownTerminals)) ? config.knownTerminals : [];
  const running = await listRunningProcesses();
  const runningLower = running.map((p) => p.toLowerCase());
  const result = [];
  for (const term of known) {
    const idx = runningLower.indexOf(String(term).toLowerCase());
    if (idx !== -1) {
      // Use the real process name as reported by the OS (correct casing to activate).
      result.push(running[idx]);
    }
  }
  return result;
}

// Resolve which app to target. If config.targetTerminal !== "auto", trust it.
// Otherwise pick the first running known terminal. Returns null if none found.
async function pickTargetApp(config) {
  const target = config && config.targetTerminal;
  if (target && target !== 'auto') return target;
  const running = await listRunningTerminals(config);
  return running.length ? running[0] : null;
}

// --- Text injection ----------------------------------------------------------

// AppleScript that activates an app (by name from argv) and types text (from argv).
// Nothing is interpolated: appName + text arrive as argv items 1 and 2, and the
// activate-delay is a numeric literal we build safely (Number, not user input).
function buildKeystrokeScript(delaySeconds) {
  const d = Number.isFinite(delaySeconds) ? delaySeconds : 0.15;
  return [
    'on run argv',
    '  set appName to item 1 of argv',
    '  set theText to item 2 of argv',
    '  tell application appName to activate',
    '  delay ' + d,
    '  tell application "System Events" to keystroke theText',
    'end run'
  ].join('\n');
}

// Script to press Return (key code 36) in the already-active app.
const RETURN_SCRIPT = 'tell application "System Events" to key code 36';

// Inject text into appName. Options: { enter, activateDelayMs, injectEnterDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
async function injectText(appName, text, opts = {}) {
  try {
    if (!appName) {
      return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
    }
    const activateDelayMs = Number.isFinite(opts.activateDelayMs) ? opts.activateDelayMs : 150;
    const injectEnterDelayMs = Number.isFinite(opts.injectEnterDelayMs) ? opts.injectEnterDelayMs : 80;
    const script = buildKeystrokeScript(activateDelayMs / 1000);

    // Pass appName + text as argv — safe against any characters in `text`.
    await runOsascript(['-e', script, String(appName), String(text == null ? '' : text)]);

    if (opts.enter) {
      await sleep(injectEnterDelayMs);
      await runOsascript(['-e', RETURN_SCRIPT]);
    }
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
}

// --- Chord injection ---------------------------------------------------------

// Map modifier tokens to AppleScript "using" clause fragments.
const MODIFIER_MAP = {
  ctrl: 'control down',
  control: 'control down',
  cmd: 'command down',
  command: 'command down',
  opt: 'option down',
  option: 'option down',
  alt: 'option down',
  shift: 'shift down'
};

// Named keys -> AppleScript key codes (used when the final key isn't a single char).
const KEY_CODE_MAP = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  delete: 51,
  backspace: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124
};

// Parse "ctrl+shift+k" -> { modifiers:['control down','shift down'], key:'k' }.
function parseChord(chord) {
  const parts = String(chord).split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_MAP[lower]) {
      const frag = MODIFIER_MAP[lower];
      if (!modifiers.includes(frag)) modifiers.push(frag);
    } else {
      key = part; // last non-modifier wins as the actual key
    }
  }
  return { modifiers, key };
}

// Build the "using {a, b}" suffix for modifiers (empty string if none).
function buildUsingClause(modifiers) {
  if (!modifiers.length) return '';
  return ' using {' + modifiers.join(', ') + '}';
}

// Inject a chord into appName. Options: { activateDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
async function injectChord(appName, chord, opts = {}) {
  try {
    if (!appName) {
      return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
    }
    const activateDelayMs = Number.isFinite(opts.activateDelayMs) ? opts.activateDelayMs : 150;
    const { modifiers, key } = parseChord(chord);
    if (!key) {
      return { ok: false, method: 'keystroke', error: 'Invalid chord: no key specified (' + chord + ')' };
    }
    const using = buildUsingClause(modifiers);

    // Activate first (static script; appName via argv).
    const activateScript = [
      'on run argv',
      '  set appName to item 1 of argv',
      '  tell application appName to activate',
      '  delay ' + (activateDelayMs / 1000),
      'end run'
    ].join('\n');
    await runOsascript(['-e', activateScript, String(appName)]);

    const namedCode = KEY_CODE_MAP[key.toLowerCase()];
    if (namedCode !== undefined) {
      // Named key -> use key code. Code + modifiers are all safe (no user text).
      const script = 'tell application "System Events" to key code ' + namedCode + using;
      await runOsascript(['-e', script]);
    } else {
      // Single character -> keystroke via argv (safe against quotes/backslashes).
      // The "using {...}" clause is fixed AppleScript; only the char is argv.
      const script = [
        'on run argv',
        '  set theKey to item 1 of argv',
        '  tell application "System Events" to keystroke theKey' + using,
        'end run'
      ].join('\n');
      await runOsascript(['-e', script, key]);
    }
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
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
  parseChord, // exported for potential testing
  SETTINGS_PATH
};
