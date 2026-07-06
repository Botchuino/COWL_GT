#!/usr/bin/env node
/**
 * launch-dashboard.js — cross-platform SessionStart launcher for COWL_GT.
 *
 * Node equivalent of launch-dashboard.sh, for Windows (where the bash script
 * can't run) and any platform that prefers a single launcher. Same contract:
 *   - If an instance is already running (live pidfile), exit 0.
 *   - If ~/.claude/dashboard or Electron isn't installed yet, exit 0 quietly.
 *   - Otherwise spawn Electron detached and return immediately.
 * It must NEVER block a Claude Code session start, so every path exits 0 fast.
 * (Electron's single-instance lock is the real backstop: a duplicate launch
 * focuses the existing window and exits on its own.)
 *
 * settings.json hook command:
 *   macOS/Linux:  node ~/.claude/dashboard/launch-dashboard.js
 *   Windows:      node "%USERPROFILE%\.claude\dashboard\launch-dashboard.js"
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DASH_DIR = path.join(os.homedir(), '.claude', 'dashboard');
const PIDFILE = path.join(DASH_DIR, '.pid');

function isRunning(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, works on Windows too
    return true;
  } catch (_err) {
    return false;
  }
}

try {
  // App dir must exist and contain the Electron entrypoint.
  if (!fs.existsSync(path.join(DASH_DIR, 'main.js'))) process.exit(0);

  // Already running?
  try {
    const oldPid = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (Number.isFinite(oldPid) && oldPid > 0 && isRunning(oldPid)) process.exit(0);
  } catch (_err) { /* no/stale pidfile — proceed */ }

  // Resolve the Electron executable. The `electron` package's main export IS
  // the absolute path to the platform binary (electron.exe on Windows).
  let electronPath = null;
  try {
    electronPath = require(path.join(DASH_DIR, 'node_modules', 'electron'));
  } catch (_err) { /* deps not installed */ }

  let child;
  if (typeof electronPath === 'string' && fs.existsSync(electronPath)) {
    child = spawn(electronPath, ['.'], { cwd: DASH_DIR, detached: true, stdio: 'ignore' });

    // Linux: a missing SUID chrome-sandbox or disabled unprivileged user
    // namespaces (common on Debian/Arch/WSL) kills Electron within moments.
    // Watch briefly and relaunch ONCE with --no-sandbox instead of silently
    // leaving no dashboard. This is the only path where the launcher lingers
    // (~2.5s); the SessionStart hook runs it async, so nothing blocks.
    if (process.platform === 'linux') {
      let exitCode = null;
      child.on('error', () => { exitCode = -1; });
      child.once('exit', (code) => { exitCode = (code == null ? -1 : code); });
      try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch (_err) { /* best effort */ }
      child.unref();
      setTimeout(() => {
        if (exitCode === null || exitCode === 0) process.exit(0); // still running (or clean exit)
        const retry = spawn(electronPath, ['.', '--no-sandbox'], { cwd: DASH_DIR, detached: true, stdio: 'ignore' });
        retry.on('error', () => { /* nothing to launch — never fail the session */ });
        try { fs.writeFileSync(PIDFILE, String(retry.pid)); } catch (_err) { /* best effort */ }
        retry.unref();
        process.exit(0);
      }, 2500);
      return; // the timeout above owns process exit on this path
    }
  } else {
    // Last resort: npx (needs a shell on Windows to resolve npx.cmd).
    // On Windows do NOT combine detached with shell:true — the detached
    // console-subsystem grandchild allocates a new visible console that stays
    // open as long as Electron runs. Windows doesn't kill children on parent
    // exit, so windowsHide + unref is enough to detach there.
    const win = process.platform === 'win32';
    child = spawn('npx', ['electron', '.'], {
      cwd: DASH_DIR,
      detached: !win,
      stdio: 'ignore',
      shell: win,
      windowsHide: true
    });
  }
  child.on('error', () => { /* nothing to launch — never fail the session */ });

  // Record the pid for the next idempotency check (best-effort).
  try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch (_err) { /* best effort */ }

  child.unref();
} catch (_err) { /* never fail the session */ }

process.exit(0);
