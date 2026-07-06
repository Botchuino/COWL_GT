// lib/inject-common.js
// Platform-neutral helpers shared by the per-OS injection backends
// (inject-darwin.js, inject-win32.js, inject-linux.js).

// small delay helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

// Map modifier spellings to canonical tokens. Backends translate the canonical
// tokens into their own syntax (AppleScript "control down", SendKeys "^",
// xdotool "ctrl").
const MODIFIER_MAP = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'cmd',
  command: 'cmd',
  opt: 'alt',
  option: 'alt',
  alt: 'alt',
  shift: 'shift'
};

// Named (non-character) keys a chord may end with, canonical lowercase.
const NAMED_KEYS = new Set([
  'return', 'enter', 'tab', 'space', 'escape', 'esc',
  'delete', 'backspace', 'up', 'down', 'left', 'right'
]);

// Parse "ctrl+shift+k" -> { modifiers:['ctrl','shift'], key:'k' }.
// Modifiers are canonical tokens; the last non-modifier part wins as the key.
function parseChord(chord) {
  const parts = String(chord).split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const part of parts) {
    const canonical = MODIFIER_MAP[part.toLowerCase()];
    if (canonical) {
      if (!modifiers.includes(canonical)) modifiers.push(canonical);
    } else {
      key = part; // last non-modifier wins as the actual key
    }
  }
  return { modifiers, key };
}

// Return the canonical named-key token for `key`, or null if it's an ordinary
// character key.
function namedKey(key) {
  const k = String(key).toLowerCase();
  return NAMED_KEYS.has(k) ? k : null;
}

module.exports = { sleep, parseChord, namedKey };
