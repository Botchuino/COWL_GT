// lib/inject-darwin.js
// macOS keystroke-injection backend: osascript + System Events.
//
// SECURITY / CORRECTNESS: user-provided strings (model args like "opus[1m]", NOS text,
// skill keystrokes) are NEVER interpolated into AppleScript source. They are passed as
// ARGV to an `on run argv` script, so quotes/backslashes/brackets can't break the script
// or inject AppleScript. This is mandated by the shared contract.

const { execFile } = require('child_process');
const { sleep, parseChord, namedKey } = require('./inject-common');

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

// --- Text injection ----------------------------------------------------------

// AppleScript that activates an app (by name from argv), types text (from argv)
// and — when withEnter — presses Return in the SAME script run. Doing it all in
// one osascript invocation closes the race where focus shifts back to the
// dashboard between "type" and "Return" (text lands, Enter goes to the wrong
// window); the extra `activate` before Return re-asserts the target app even
// if something stole focus during the enter delay.
// Nothing is interpolated: appName + text arrive as argv items 1 and 2, and
// the delays are numeric literals we build safely (Number, not user input).
function buildKeystrokeScript(activateDelaySeconds, enterDelaySeconds, withEnter) {
  const d1 = Number.isFinite(activateDelaySeconds) ? activateDelaySeconds : 0.15;
  const lines = [
    'on run argv',
    '  set appName to item 1 of argv',
    '  set theText to item 2 of argv',
    '  tell application appName to activate',
    '  delay ' + d1,
    '  tell application "System Events" to keystroke theText'
  ];
  if (withEnter) {
    const d2 = Number.isFinite(enterDelaySeconds) ? enterDelaySeconds : 0.25;
    lines.push('  delay ' + d2);
    lines.push('  tell application appName to activate');
    // Activation completes asynchronously: without a settle delay the key code
    // would fire while the focus stealer is still frontmost.
    lines.push('  delay ' + d1);
    lines.push('  tell application "System Events" to key code 36');
  }
  lines.push('end run');
  return lines.join('\n');
}

// Inject text into appName. Options: { enter, activateDelayMs, injectEnterDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
async function injectText(appName, text, opts = {}) {
  try {
    if (!appName) {
      return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
    }
    const activateDelayMs = Number.isFinite(opts.activateDelayMs) ? opts.activateDelayMs : 150;
    const injectEnterDelayMs = Number.isFinite(opts.injectEnterDelayMs) ? opts.injectEnterDelayMs : 250;
    const script = buildKeystrokeScript(activateDelayMs / 1000, injectEnterDelayMs / 1000, !!opts.enter);

    // Pass appName + text as argv — safe against any characters in `text`.
    await runOsascript(['-e', script, String(appName), String(text == null ? '' : text)]);
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
}

// --- Chord injection ---------------------------------------------------------

// Canonical modifier tokens (from inject-common parseChord) -> AppleScript
// "using" clause fragments.
const AS_MODIFIERS = {
  ctrl: 'control down',
  cmd: 'command down',
  alt: 'option down',
  shift: 'shift down'
};

// Canonical named keys -> AppleScript key codes (used when the final key isn't
// a single char).
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

// Build the "using {a, b}" suffix for modifiers (empty string if none).
function buildUsingClause(modifiers) {
  if (!modifiers.length) return '';
  return ' using {' + modifiers.map((m) => AS_MODIFIERS[m]).join(', ') + '}';
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

    const named = namedKey(key);
    if (named && KEY_CODE_MAP[named] !== undefined) {
      // Named key -> use key code. Code + modifiers are all safe (no user text).
      const script = 'tell application "System Events" to key code ' + KEY_CODE_MAP[named] + using;
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

module.exports = { listRunningTerminals, injectText, injectChord };
