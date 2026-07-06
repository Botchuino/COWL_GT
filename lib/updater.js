// lib/updater.js — "richiamo in officina" self-updater for COWL_GT.
//
// The app is installed by copying dashboard/ into ~/.claude/dashboard (see the
// README), so the installed copy is detached from git: it never learns about
// new releases on its own. This module lets the MAIN process (the renderer's
// CSP has connect-src 'none', on purpose) do three things over plain HTTPS:
//
//   1. checkForUpdate() — read the repo's dashboard/package.json "version" from
//      GitHub raw and compare it to the locally installed version.
//   2. applyUpdate()   — download the branch tarball, extract it, and overlay
//      the fresh dashboard/ files over the install dir. Runtime files
//      (config.json, state.json, activity.json, .pid, node_modules) live ONLY
//      in the install dir and are NOT in the tarball, so a plain recursive
//      copy never clobbers them. npm install runs only if deps changed.
//   3. throttling helpers so the check fires at most once per day.
//
// No git, no code signing, no electron-builder — works the same on macOS,
// Windows and Linux. The main process wires app.relaunch() after applyUpdate.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// --- where things live -------------------------------------------------------
// __dirname is <appDir>/lib, so the running app dir is one level up. At runtime
// that IS ~/.claude/dashboard (install target); during dev it's the repo.
const APP_DIR = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(os.homedir(), '.claude', 'dashboard');
const CHECK_STATE_PATH = path.join(RUNTIME_DIR, '.update-check.json');

// --- the release source ------------------------------------------------------
// REPO must be the repository users install FROM (its dashboard/package.json is
// the version signal). The layout is auto-detected: the dashboard sources may
// sit at the repo root or under a `dashboard/` subfolder — both raw paths are
// tried, and the tarball's dashboard dir is located either way.
// Users install COWL_GT from the public Botchuino/COWL_GT repo, so that's the
// version signal. (This dev repo, claude-configuration/dashboard, is the source
// of truth Federico pushes FROM.) The dashboard may live at that repo's root
// or under dashboard/ — both layouts are auto-detected below.
const REPO = 'Botchuino/COWL_GT';
const BRANCH = 'main';
// candidate paths for the released package.json, most-likely first. COWL_GT
// most likely has the app at its root, so try that first, then dashboard/.
const REMOTE_PKG_PATHS = ['package.json', 'dashboard/package.json'];
const TARBALL_URL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most one check per day
const HTTP_TIMEOUT_MS = 20000;

// --- small helpers -----------------------------------------------------------
function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_e) { return null; }
}

function getLocalVersion() {
  const pkg = readJsonSafe(path.join(APP_DIR, 'package.json'));
  return pkg && pkg.version ? String(pkg.version) : '0.0.0';
}

// numeric-segment compare: -1 if a<b, 0 if equal, 1 if a>b. Ignores any
// pre-release suffix (we only ship plain x.y.z tags).
function cmpVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// GET with redirect handling + timeout. Resolves a Buffer, or a parsed object
// when {json:true}. Rejects on non-2xx (after redirects) or network error.
function httpsGet(url, opts = {}) {
  const { json = false, redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'COWL_GT-updater' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume(); // drain
        const next = new URL(res.headers.location, url).toString();
        resolve(httpsGet(next, { json, redirects: redirects - 1 }));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error('HTTP ' + status + ' for ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!json) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
  });
}

// --- throttle ----------------------------------------------------------------
// One network check per day. State is a tiny JSON blob in the runtime dir.
function loadCheckState() { return readJsonSafe(CHECK_STATE_PATH) || {}; }

function shouldCheck() {
  const st = loadCheckState();
  const last = Number(st.lastCheck) || 0;
  return (Date.now() - last) >= CHECK_INTERVAL_MS;
}

function recordCheck(extra) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const st = Object.assign(loadCheckState(), { lastCheck: Date.now() }, extra || {});
    fs.writeFileSync(CHECK_STATE_PATH, JSON.stringify(st, null, 2), 'utf8');
  } catch (_e) { /* best effort */ }
}

// --- public: check -----------------------------------------------------------
// Fetch the released package.json, trying each candidate layout path in turn.
async function fetchRemotePkg() {
  let lastErr = null;
  for (const p of REMOTE_PKG_PATHS) {
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`;
    try {
      const pkg = await httpsGet(url, { json: true });
      if (pkg && pkg.version) return pkg;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  throw new Error('no versioned package.json found in ' + REPO);
}

async function checkForUpdate() {
  const local = getLocalVersion();
  const remotePkg = await fetchRemotePkg();
  const remote = remotePkg && remotePkg.version ? String(remotePkg.version) : null;
  const available = remote ? cmpVersions(local, remote) < 0 : false;
  return { available, local, remote };
}

// --- public: apply -----------------------------------------------------------
function depsSignature(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';
  return JSON.stringify({
    d: pkg.dependencies || {},
    dd: pkg.devDependencies || {},
    op: pkg.optionalDependencies || {}
  });
}

function extractTarball(tarPath, destDir) {
  // System tar: present on macOS, Linux, and Windows 10 1803+ (bsdtar).
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'ignore' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('tar exited with status ' + r.status);
}

function runNpmInstall(cwd) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd, stdio: 'ignore', shell: win
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('npm install exited with status ' + r.status);
}

// Download → extract → overlay onto APP_DIR → npm install if needed.
// Returns { newVersion, depsChanged }. Throws on any failure (the caller keeps
// running the current version; nothing is half-applied because the copy step is
// the last mutating action and only writes files that exist in the tarball).
async function applyUpdate() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowlgt-update-'));
  try {
    const tarPath = path.join(tmpRoot, 'source.tar.gz');
    const buf = await httpsGet(TARBALL_URL);
    fs.writeFileSync(tarPath, buf);

    extractTarball(tarPath, tmpRoot);

    // GitHub extracts to a single "<repo>-<branch>" dir. Find it, then locate
    // the dashboard sources inside — either under dashboard/ or at the root.
    const rootName = fs.readdirSync(tmpRoot)
      .find((n) => fs.statSync(path.join(tmpRoot, n)).isDirectory());
    if (!rootName) throw new Error('extracted tarball has no source root');
    const rootDir = path.join(tmpRoot, rootName);

    let srcDash = null;
    for (const cand of [path.join(rootDir, 'dashboard'), rootDir]) {
      if (fs.existsSync(path.join(cand, 'main.js')) &&
          fs.existsSync(path.join(cand, 'package.json'))) { srcDash = cand; break; }
    }
    if (!srcDash) throw new Error('extracted tarball has no dashboard/main.js');

    const oldPkg = readJsonSafe(path.join(APP_DIR, 'package.json'));
    const newPkg = readJsonSafe(path.join(srcDash, 'package.json'));
    const depsChanged = depsSignature(oldPkg) !== depsSignature(newPkg);

    // Overlay. The tarball's dashboard/ contains only version-controlled files
    // (no config.json / state.json / .pid / node_modules), so this never
    // touches the user's runtime state.
    fs.cpSync(srcDash, APP_DIR, { recursive: true, force: true });

    if (depsChanged) runNpmInstall(APP_DIR);

    recordCheck({ lastAppliedVersion: newPkg && newPkg.version });
    return { newVersion: (newPkg && newPkg.version) || null, depsChanged };
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

module.exports = {
  checkForUpdate,
  applyUpdate,
  shouldCheck,
  recordCheck,
  getLocalVersion,
  cmpVersions,      // exported for tests
  REPO,
  BRANCH
};
