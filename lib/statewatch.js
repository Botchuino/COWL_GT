// lib/statewatch.js
// Watches ~/.claude/dashboard/state.json (written by statusline-tap.js) AND
// ~/.claude/dashboard/activity.json (written by hooks/activity-hook.js), and
// calls onChange(state) whenever either changes. The activity record is merged
// into every emitted/read state as state.activity (null if missing or stale
// >120s). macOS editors/atomic-rename writes make fs.watch unreliable, so we
// combine fs.watch + fs.watchFile (polling) + a debounce.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_PATH = path.join(os.homedir(), '.claude', 'dashboard', 'state.json');
const ACTIVITY_PATH = path.join(path.dirname(STATE_PATH), 'activity.json');
const STATE_DIR = path.dirname(STATE_PATH);

// Activity records older than this are considered stale and dropped.
const ACTIVITY_STALE_MS = 120000;

// Read + parse the activity file safely. Returns the parsed record, or null if
// missing/unparseable/stale (>120s old).
function readActivity() {
  try {
    const raw = fs.readFileSync(ACTIVITY_PATH, 'utf8');
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const at = typeof obj.at === 'number' ? obj.at : NaN;
    if (!Number.isFinite(at) || (Date.now() - at) >= ACTIVITY_STALE_MS) return null;
    return obj;
  } catch (_err) {
    return null;
  }
}

// Read + parse the state file safely and merge in the current activity record.
// Returns null if missing/unparseable.
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    obj.activity = readActivity();
    return obj;
  } catch (_err) {
    return null;
  }
}

// Start watching. Returns a stop() function to tear down all watchers.
function watch(onChange) {
  let debounceTimer = null;
  let lastSerialized = null; // avoid firing onChange for no-op writes
  let dirWatcher = null;
  let fileWatcherActive = false;
  let activityWatcherActive = false;

  function fire() {
    const state = readState();
    if (state === null) return;
    // De-dupe: only emit when the parsed content actually changed.
    const serialized = JSON.stringify(state);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    try {
      onChange(state);
    } catch (_err) {
      /* never let a renderer/callback error kill the watcher */
    }
  }

  function scheduleFire() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, 200); // 200ms debounce
  }

  // Primary: fs.watch on the containing directory. Watching the directory
  // survives atomic renames (write temp + rename over) that would otherwise
  // orphan a watcher bound directly to the file inode.
  function startDirWatch() {
    try {
      dirWatcher = fs.watch(STATE_DIR, (_eventType, filename) => {
        // filename may be null on some platforms; if present, filter to the
        // files we merge into the emitted state.
        if (!filename || filename === 'state.json' || filename === 'activity.json') scheduleFire();
      });
      dirWatcher.on('error', () => {
        // Directory vanished or watcher died; polling fallback covers us.
        try { dirWatcher.close(); } catch (_e) { /* ignore */ }
        dirWatcher = null;
      });
    } catch (_err) {
      dirWatcher = null;
    }
  }

  // Fallback: fs.watchFile polls the file's mtime/size. Reliable but coarse;
  // catches changes fs.watch misses on network/atomic writes.
  function startFileWatch() {
    try {
      fs.watchFile(STATE_PATH, { interval: 500 }, () => scheduleFire());
      fileWatcherActive = true;
    } catch (_err) {
      fileWatcherActive = false;
    }
    try {
      fs.watchFile(ACTIVITY_PATH, { interval: 500 }, () => scheduleFire());
      activityWatcherActive = true;
    } catch (_err) {
      activityWatcherActive = false;
    }
  }

  startDirWatch();
  startFileWatch();

  // Emit the current state immediately so the UI has data on startup.
  scheduleFire();

  return function stop() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (dirWatcher) {
      try { dirWatcher.close(); } catch (_e) { /* ignore */ }
      dirWatcher = null;
    }
    if (fileWatcherActive) {
      try { fs.unwatchFile(STATE_PATH); } catch (_e) { /* ignore */ }
      fileWatcherActive = false;
    }
    if (activityWatcherActive) {
      try { fs.unwatchFile(ACTIVITY_PATH); } catch (_e) { /* ignore */ }
      activityWatcherActive = false;
    }
  };
}

module.exports = {
  watch,
  readState,
  readActivity,
  STATE_PATH,
  ACTIVITY_PATH
};
