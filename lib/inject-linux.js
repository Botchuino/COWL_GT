// lib/inject-linux.js
// Linux keystroke-injection backend: xdotool (X11 / XWayland).
//
// SECURITY / CORRECTNESS: user text is passed to xdotool as a separate argv
// element after a `--` guard — never interpolated into a shell string. Window
// lookups build a case-insensitive regex from the app name with all regex
// metacharacters escaped.
//
// Pure-Wayland sessions are NOT supported (xdotool can't reach Wayland-native
// windows); apps running under XWayland still work.

const { execFile } = require('child_process');
const { sleep, parseChord, namedKey } = require('./inject-common');

const XDOTOOL_MISSING =
  'xdotool not found. Install it (e.g. `sudo apt install xdotool`). ' +
  'Note: keystroke injection works on X11/XWayland only, not pure Wayland.';

function runXdotool(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { timeout: Number.isFinite(timeoutMs) ? timeoutMs : 10000 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error(XDOTOOL_MISSING));
          return;
        }
        const msg = (stderr && stderr.trim()) || err.message || 'xdotool failed';
        reject(new Error(msg));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

// Build a case-insensitive regex matching `name` literally:
// "code" -> "[cC][oO][dD][eE]"; regex metacharacters are escaped.
function ciPattern(name) {
  let out = '';
  for (const ch of String(name)) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo !== up) {
      out += '[' + lo + up + ']';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

// Find a window id for appName. Tries WM_CLASS class, then instance name —
// ANCHORED (^pat$) so generic entries like "Terminal" can't substring-match
// Gnome-terminal/Xfce4-terminal and hijack the knownTerminals priority order.
// Visible windows are preferred, but minimized (iconified) ones are found in a
// second pass — windowactivate un-minimizes them. Optionally falls back to the
// window title, unanchored (used only for an explicit target, where a broad
// match is what the user asked for — too fuzzy for auto-detect).
// Returns the most recent (last) matching window id, or null.
async function findWindowId(appName, { allowNameFallback = false } = {}) {
  const pat = ciPattern(appName);
  const attempts = [
    ['--onlyvisible', '--class', '^' + pat + '$'],
    ['--onlyvisible', '--classname', '^' + pat + '$'],
    ['--class', '^' + pat + '$'],
    ['--classname', '^' + pat + '$']
  ];
  if (allowNameFallback) attempts.push(['--onlyvisible', '--name', pat], ['--name', pat]);
  for (const args of attempts) {
    try {
      const out = await runXdotool(['search'].concat(args));
      const ids = out.split(/\s+/).filter(Boolean);
      if (ids.length) return ids[ids.length - 1];
    } catch (err) {
      // xdotool exits non-zero on "no match" — keep trying other attempts,
      // but a missing binary is fatal.
      if (err && err.message === XDOTOOL_MISSING) throw err;
    }
  }
  return null;
}

// Intersect knownTerminals with terminals that have a live window right now,
// preserving the knownTerminals order (which encodes user preference/priority).
async function listRunningTerminals(config) {
  const known = (config && Array.isArray(config.knownTerminals)) ? config.knownTerminals : [];
  try {
    const checks = await Promise.all(
      known.map((term) => findWindowId(term).then((id) => (id ? term : null)).catch(() => null))
    );
    return checks.filter(Boolean);
  } catch (_err) {
    return [];
  }
}

// Activate the target window and wait for focus to settle. Throws on failure.
async function activate(appName, activateDelayMs) {
  const wid = await findWindowId(appName, { allowNameFallback: true });
  if (!wid) {
    throw new Error('No window found for "' + appName + '". Is it running? (X11/XWayland only)');
  }
  await runXdotool(['windowactivate', '--sync', wid]);
  await sleep(Number.isFinite(activateDelayMs) ? activateDelayMs : 150);
  return wid;
}

// Inject text into appName. Options: { enter, activateDelayMs, injectEnterDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
async function injectText(appName, text, opts = {}) {
  try {
    if (!appName) {
      return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
    }
    const wid = await activate(appName, opts.activateDelayMs);
    const t = String(text == null ? '' : text);
    if (t) {
      // `--` guards text that starts with a dash; 12ms per char ≈ human typing.
      // Timeout scales with length: a fixed 10s would kill xdotool mid-typing
      // for text longer than ~830 chars.
      await runXdotool(['type', '--clearmodifiers', '--delay', '12', '--', t], 10000 + t.length * 25);
    }
    if (opts.enter) {
      await sleep(Number.isFinite(opts.injectEnterDelayMs) ? opts.injectEnterDelayMs : 250);
      // Re-assert focus before Return so a focus steal during the delay can't
      // send the Enter to another window (same guard as the macOS backend).
      await runXdotool(['windowactivate', '--sync', wid]);
      await runXdotool(['key', '--clearmodifiers', 'Return']);
    }
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
}

// --- Chord injection ---------------------------------------------------------

// Canonical modifiers -> xdotool key prefixes.
const XD_MODIFIERS = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super' };

// Canonical named keys -> X keysyms.
const XD_NAMED = {
  return: 'Return',
  enter: 'Return',
  tab: 'Tab',
  space: 'space',
  escape: 'Escape',
  esc: 'Escape',
  delete: 'Delete',
  backspace: 'BackSpace',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right'
};

// Punctuation -> X keysym names. `xdotool key` resolves tokens via
// XStringToKeysym, which accepts keysym NAMES only: letters/digits are their
// own names, but "ctrl+/" must be sent as "ctrl+slash".
const XD_PUNCT = {
  '.': 'period',
  ',': 'comma',
  '/': 'slash',
  ';': 'semicolon',
  '-': 'minus',
  '+': 'plus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright',
  "'": 'apostrophe',
  '`': 'grave',
  '\\': 'backslash',
  '!': 'exclam',
  '@': 'at',
  '#': 'numbersign',
  '$': 'dollar',
  '%': 'percent',
  '^': 'asciicircum',
  '&': 'ampersand',
  '*': 'asterisk',
  '(': 'parenleft',
  ')': 'parenright',
  '_': 'underscore',
  ':': 'colon',
  '"': 'quotedbl',
  '<': 'less',
  '>': 'greater',
  '?': 'question',
  '|': 'bar',
  '~': 'asciitilde',
  '{': 'braceleft',
  '}': 'braceright'
};

// Translate the final chord key to an X keysym token. Single non-alphanumeric
// chars outside the map use XStringToKeysym's Unicode form (U + hex codepoint).
function toKeysym(key) {
  const named = namedKey(key);
  if (named) return XD_NAMED[named];
  if (key.length === 1) {
    if (/[a-zA-Z0-9]/.test(key)) return key;
    if (XD_PUNCT[key]) return XD_PUNCT[key];
    const cp = key.codePointAt(0);
    return 'U' + cp.toString(16).toUpperCase().padStart(4, '0');
  }
  return key; // multi-char, not named: assume the user wrote a real keysym (e.g. "F5")
}

// Inject a chord into appName. Options: { activateDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
async function injectChord(appName, chord, opts = {}) {
  try {
    if (!appName) {
      return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
    }
    const { modifiers, key } = parseChord(chord);
    if (!key) {
      return { ok: false, method: 'keystroke', error: 'Invalid chord: no key specified (' + chord + ')' };
    }
    await activate(appName, opts.activateDelayMs);
    const seq = modifiers.map((m) => XD_MODIFIERS[m]).concat([toKeysym(key)]).join('+');
    await runXdotool(['key', '--clearmodifiers', '--', seq]);
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
}

// --- Availability probe --------------------------------------------------------

// Cheap one-shot check for the display-only ("vetrina") mode: is xdotool
// installed and can it talk to an X display? Pure-Wayland sessions fail here
// with a clear reason instead of dead buttons later.
async function probe() {
  try {
    await runXdotool(['getdisplaygeometry']);
    return { available: true };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    return {
      available: false,
      reason: msg === XDOTOOL_MISSING
        ? XDOTOOL_MISSING
        : 'xdotool cannot reach the display (' + msg + ') — X11/XWayland required'
    };
  }
}

module.exports = { listRunningTerminals, injectText, injectChord, probe };
