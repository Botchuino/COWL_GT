// lib/inject-win32.js
// Windows keystroke-injection backend: PowerShell window activation
// (user32 SetForegroundWindow + WScript.Shell AppActivate) and
// System.Windows.Forms SendKeys.
//
// SECURITY / CORRECTNESS: user-provided strings (NOS text, skill keystrokes,
// model args) are NEVER interpolated into PowerShell source. They travel via
// environment variables (COWL_*) that the static script reads back — the
// win32 equivalent of the macOS argv contract. Numeric delays are validated
// Numbers baked in as literals.

const { execFile } = require('child_process');
const { parseChord, namedKey, isWSL } = require('./inject-common');

// This backend also serves WSL: Windows interop lets a WSL process spawn
// powershell.exe and drive Windows-side windows. Three WSL specifics:
// - env vars only cross the Linux→Windows boundary when named in WSLENV
//   (the COWL_* payload vars, flag /w = "when invoking Win32 from WSL");
// - with appendWindowsPath=false in /etc/wsl.conf the bare name isn't on
//   PATH, so ENOENT falls back to the canonical absolute interop path;
// - interop cold-starts PowerShell noticeably slower, so the timeout is wider.
const WSL = isWSL();
const COWL_WSLENV = ['COWL_APP/w', 'COWL_KEYS/w', 'COWL_ENTER/w'];
const PS_WSL_FALLBACK = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
let psBin = 'powershell.exe'; // sticks to the fallback once it's needed

function runPowerShell(script, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  if (WSL) {
    env.WSLENV = [process.env.WSLENV].concat(COWL_WSLENV).filter(Boolean).join(':');
  }
  return new Promise((resolve, reject) => {
    const attempt = (bin) => execFile(
      bin,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: WSL ? 30000 : 15000,
        windowsHide: true,
        env
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' && WSL && bin !== PS_WSL_FALLBACK && require('fs').existsSync(PS_WSL_FALLBACK)) {
            psBin = PS_WSL_FALLBACK;
            attempt(PS_WSL_FALLBACK);
            return;
          }
          const msg = (stderr && stderr.trim()) || err.message || 'powershell failed';
          reject(new Error(msg));
          return;
        }
        resolve((stdout || '').trim());
      }
    );
    attempt(psBin);
  });
}

// --- Discover running terminal apps -----------------------------------------

// Only processes with a real top-level window are activatable targets.
const LIST_SCRIPT =
  'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ' +
  'Select-Object -ExpandProperty ProcessName -Unique';

function listRunningProcesses() {
  return runPowerShell(LIST_SCRIPT)
    .then((out) => (out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []))
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
    if (idx !== -1) result.push(running[idx]);
  }
  return result;
}

// --- SendKeys escaping --------------------------------------------------------

// SendKeys treats + ^ % ~ ( ) { } [ ] as special; brace-wrap them so text is
// typed literally.
function escapeSendKeysText(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (c) => '{' + c + '}');
}

// --- The activate + type script -----------------------------------------------
// Static PowerShell; reads COWL_APP / COWL_KEYS / COWL_ENTER from env; the two
// delays are validated numeric literals. Exit 3 = target has no window.
function buildSendScript(activateDelayMs, enterDelayMs) {
  const d1 = Number.isFinite(activateDelayMs) ? Math.max(0, activateDelayMs | 0) : 150;
  const d2 = Number.isFinite(enterDelayMs) ? Math.max(0, enterDelayMs | 0) : 250;
  return [
    "$ErrorActionPreference = 'Stop'",
    '$p = Get-Process -Name $env:COWL_APP -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    "if (-not $p) { [Console]::Error.WriteLine('No window found for process: ' + $env:COWL_APP) ; exit 3 }",
    "Add-Type -Namespace Cowl -Name User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
    '$null = [Cowl.User32]::ShowWindow($p.MainWindowHandle, 9)', // 9 = SW_RESTORE (un-minimize)
    '$null = [Cowl.User32]::SetForegroundWindow($p.MainWindowHandle)',
    'try { $null = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch { }',
    'Start-Sleep -Milliseconds ' + d1,
    'Add-Type -AssemblyName System.Windows.Forms',
    'if ($env:COWL_KEYS) { [System.Windows.Forms.SendKeys]::SendWait($env:COWL_KEYS) }',
    "if ($env:COWL_ENTER -eq '1') {",
    '  Start-Sleep -Milliseconds ' + d2,
    // Re-assert the target foreground before Enter: SendWait targets whatever
    // window is frontmost, so a focus steal during the enter delay would send
    // the Enter to the stealing window (same guard as the macOS backend).
    '  $null = [Cowl.User32]::SetForegroundWindow($p.MainWindowHandle)',
    '  try { $null = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch { }',
    '  Start-Sleep -Milliseconds ' + d1,
    "  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    '}'
  ].join('\n');
}

// Shared runner for text and chords (both end up as a SendKeys sequence).
async function sendKeys(appName, keys, opts, withEnter) {
  if (!appName) {
    return { ok: false, method: 'keystroke', error: 'No target terminal found. Open a terminal or set one in settings.' };
  }
  try {
    const script = buildSendScript(opts.activateDelayMs, opts.injectEnterDelayMs);
    await runPowerShell(script, {
      COWL_APP: String(appName),
      COWL_KEYS: String(keys == null ? '' : keys),
      COWL_ENTER: withEnter ? '1' : '0'
    });
    return { ok: true, method: 'keystroke' };
  } catch (err) {
    return { ok: false, method: 'keystroke', error: err && err.message ? err.message : String(err) };
  }
}

// Inject text into appName. Options: { enter, activateDelayMs, injectEnterDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
function injectText(appName, text, opts = {}) {
  return sendKeys(appName, escapeSendKeysText(text == null ? '' : text), opts, !!opts.enter);
}

// --- Chord injection ---------------------------------------------------------

// Canonical modifiers -> SendKeys prefixes. There is no SendKeys token for the
// Windows key, so `cmd` chords are rejected with a clear error.
const SK_MODIFIERS = { ctrl: '^', alt: '%', shift: '+' };

// Canonical named keys -> SendKeys tokens.
const SK_NAMED = {
  return: '{ENTER}',
  enter: '{ENTER}',
  tab: '{TAB}',
  space: ' ',
  escape: '{ESC}',
  esc: '{ESC}',
  delete: '{DEL}',
  backspace: '{BACKSPACE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}'
};

// Inject a chord into appName. Options: { activateDelayMs }.
// Returns { ok, method:'keystroke', error? }. Never throws.
function injectChord(appName, chord, opts = {}) {
  const { modifiers, key } = parseChord(chord);
  if (!key) {
    return Promise.resolve({ ok: false, method: 'keystroke', error: 'Invalid chord: no key specified (' + chord + ')' });
  }
  if (modifiers.includes('cmd')) {
    return Promise.resolve({ ok: false, method: 'keystroke', error: 'The cmd/command modifier is not supported on Windows (chord: ' + chord + ')' });
  }
  const named = namedKey(key);
  const keyToken = named ? SK_NAMED[named] : escapeSendKeysText(key);
  const seq = modifiers.map((m) => SK_MODIFIERS[m]).join('') + keyToken;
  return sendKeys(appName, seq, opts, false);
}

// --- Availability probe --------------------------------------------------------

// Can this backend inject at all on this machine? Cheap one-shot check used by
// the display-only ("vetrina") mode — it verifies PowerShell is reachable, not
// that a target window exists.
async function probe() {
  try {
    await runPowerShell('exit 0');
    return { available: true };
  } catch (err) {
    const enoent = err && /ENOENT/.test(String(err.message || err));
    return {
      available: false,
      reason: enoent
        ? (WSL
          ? 'powershell.exe not reachable from WSL — check /etc/wsl.conf: [interop] enabled=true and appendWindowsPath=true (restart WSL after changes)'
          : 'powershell.exe not found on PATH')
        : String(err && err.message ? err.message : err)
    };
  }
}

module.exports = { listRunningTerminals, injectText, injectChord, probe };
