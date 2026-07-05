#!/usr/bin/env node
/**
 * statusline-tap.js — TRANSPARENT statusline proxy for Claude Code.
 *
 * Claude Code invokes the configured `statusLine.command` on every render and
 * pipes a JSON blob describing the live session on stdin. This script sits in
 * front of the real statusline (the ecc wrapper):
 *
 *   1. Collects ALL of stdin (binary-safe).
 *   2. Best-effort parses it as JSON, maps to the shared STATE shape, and
 *      ATOMICALLY writes ~/.claude/dashboard/state.json (tmp + rename). The
 *      Electron dashboard watches that file. All errors here are swallowed so
 *      we never break the user's statusline.
 *   3. Delegates to the real statusline by spawning
 *      `node ~/.claude/ecc-statusline-wrapper.js`, feeding it the SAME raw
 *      stdin bytes and inheriting stdout so its output becomes the statusline.
 *      Exits with the child's exit code.
 *   4. If the ecc wrapper is missing or fails to spawn, prints a minimal
 *      fallback line (model + cost) and exits 0 — the statusline must never go
 *      dark. If the wrapper RAN but exited non-zero, we do NOT print the
 *      fallback (its stdout was inherited, so that would double the line);
 *      we just propagate its exit code.
 *
 * Design goals: never hang, never throw uncaught.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const DASH_DIR = path.join(HOME, '.claude', 'dashboard');
const STATE_FILE = path.join(DASH_DIR, 'state.json');
// Pid-scoped tmp name so concurrent sessions never clobber each other's write.
const STATE_TMP = path.join(DASH_DIR, 'state.json.' + process.pid + '.tmp');
const ECC_WRAPPER = path.join(HOME, '.claude', 'ecc-statusline-wrapper.js');

// --- collect all of stdin (binary-safe) --------------------------------------
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => { /* ignore; we'll act on whatever we have */ });
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  let parsed = null;
  try {
    if (raw.length) parsed = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    parsed = null; // not JSON — that's fine, we still delegate raw bytes
  }

  // Step 2: tap the state (best-effort, swallow everything).
  try {
    if (parsed && typeof parsed === 'object') writeState(parsed);
  } catch (_) { /* never break */ }

  // Step 3/4: delegate to the real statusline, or fall back.
  delegate(raw, parsed);
});

/**
 * Map Claude Code statusline JSON -> shared STATE shape and write atomically.
 * Every field is guarded: statusline stdin may omit any of them.
 */
function writeState(d) {
  const model = d.model || {};
  const cost = d.cost || {};
  const ctx = d.context_window || {};
  const ws = d.workspace || {};

  const usedTokens = num(ctx.total_input_tokens) + num(ctx.total_output_tokens);

  const state = {
    modelId: str(model.id),
    modelName: str(model.display_name),
    costUsd: num(cost.total_cost_usd),
    contextPct: num(ctx.used_percentage),
    contextUsed: usedTokens,
    contextSize: num(ctx.context_window_size),
    sessionId: str(d.session_id),
    cwd: str(ws.current_dir),
    tokensIn: num(ctx.total_input_tokens),
    tokensOut: num(ctx.total_output_tokens),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
    updatedAt: Date.now()
  };

  try { fs.mkdirSync(DASH_DIR, { recursive: true }); } catch (_) {}
  // Atomic write: tmp then rename (rename is atomic on the same filesystem).
  fs.writeFileSync(STATE_TMP, JSON.stringify(state, null, 2));
  fs.renameSync(STATE_TMP, STATE_FILE);
}

/**
 * Spawn the real ecc statusline wrapper, pipe the same raw bytes to it, and let
 * its stdout become our stdout. Fall back to a minimal line on any failure.
 */
function delegate(raw, parsed) {
  let child;

  // If the wrapper file doesn't exist, skip straight to the fallback.
  let wrapperExists = false;
  try { wrapperExists = fs.existsSync(ECC_WRAPPER); } catch (_) {}
  if (!wrapperExists) return fallback(parsed);

  try {
    child = spawn(process.execPath, [ECC_WRAPPER], {
      stdio: ['pipe', 'inherit', 'inherit']
    });
  } catch (_) {
    return fallback(parsed);
  }

  child.on('error', () => fallback(parsed));

  child.on('close', (code) => {
    // The child ran (its stdout was inherited, so it may already have printed a
    // statusline). Printing the fallback here too would DOUBLE the statusline,
    // so on non-zero exit we just propagate the code. fallback() is reserved for
    // the cases where the child never ran: missing wrapper or spawn failure.
    process.exit(typeof code === 'number' ? code : 0);
  });

  // Feed the child the exact bytes we received.
  try {
    child.stdin.on('error', () => {}); // ignore EPIPE if child closed early
    child.stdin.write(raw);
    child.stdin.end();
  } catch (_) {
    // Child is already running with inherited stdout; do NOT fallback (risk of
    // a doubled statusline). Let the close handler propagate its exit code.
  }
}

let didFallback = false;
/** Print a minimal statusline so the bar never goes dark, then exit 0. */
function fallback(parsed) {
  if (didFallback) return; // guard against double-invocation from error+close
  didFallback = true;
  let line = 'Claude Code';
  try {
    const model = (parsed && parsed.model) || {};
    const cost = (parsed && parsed.cost) || {};
    const name = str(model.display_name) || str(model.id);
    const bits = [];
    if (name) bits.push(name);
    const c = num(cost.total_cost_usd);
    if (c) bits.push('$' + c.toFixed(2));
    if (bits.length) line = bits.join('  ');
  } catch (_) {}
  try { process.stdout.write(line + '\n'); } catch (_) {}
  process.exit(0);
}

// --- tiny guarded coercers ----------------------------------------------------
function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

// Absolute last resort: never let an uncaught error kill the statusline.
process.on('uncaughtException', () => { try { fallback(null); } catch (_) { process.exit(0); } });
