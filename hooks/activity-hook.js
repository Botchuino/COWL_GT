#!/usr/bin/env node
/**
 * hooks/activity-hook.js — PostToolUse hook for the COWL_GT dashboard.
 *
 * Claude Code invokes this after every tool call with a JSON blob on stdin
 * ({ tool_name, tool_input, session_id, cwd, ... }). We distill it into a tiny
 * "what is Claude doing right now" record and ATOMICALLY write it to
 * ~/.claude/dashboard/activity.json (pid-scoped tmp + rename, dir auto-created):
 *
 *   { tool, detail, sessionId, cwd, at }
 *
 * The dashboard's statewatch merges this into every emitted state as
 * state.activity (dropped when stale >120s).
 *
 * Design goals (same as statusline-tap.js): swallow ALL errors, ALWAYS exit 0,
 * NEVER hang — we act on stdin end, plus a 3s safety timeout that exits 0 even
 * if stdin never closes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DASH_DIR = path.join(os.homedir(), '.claude', 'dashboard');
const ACTIVITY_FILE = path.join(DASH_DIR, 'activity.json');
// Pid-scoped tmp name so concurrent sessions never clobber each other's write.
const ACTIVITY_TMP = path.join(DASH_DIR, 'activity.json.' + process.pid + '.tmp');

// Safety net: if stdin never ends (or anything stalls), bail out clean.
const safetyTimer = setTimeout(() => { process.exit(0); }, 3000);
// Don't let the timer itself keep the process alive after normal completion.
if (safetyTimer.unref) safetyTimer.unref();

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => { /* ignore; act on whatever we have */ });
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    let hook = null;
    try { hook = raw.trim() ? JSON.parse(raw) : null; } catch (_) { hook = null; }
    if (hook && typeof hook === 'object') writeActivity(hook);
  } catch (_) { /* never break a tool call */ }
  process.exit(0);
});

/** Derive a short human-readable detail string for the tool call. */
function deriveDetail(toolName, input) {
  try {
    const inp = (input && typeof input === 'object') ? input : {};
    switch (toolName) {
      case 'Edit':
      case 'Write':
      case 'Read':
      case 'NotebookEdit':
        return inp.file_path ? path.basename(String(inp.file_path)) : '';
      case 'Grep':
      case 'Glob':
        return inp.pattern != null ? String(inp.pattern) : '';
      case 'Bash': {
        if (inp.description) return String(inp.description);
        const cmd = inp.command != null ? String(inp.command) : '';
        return cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd;
      }
      case 'Task':
      case 'Agent':
        return inp.description != null ? String(inp.description) : '';
      default:
        return '';
    }
  } catch (_) {
    return '';
  }
}

/** Atomic write of the activity record (tmp + rename). Swallows everything. */
function writeActivity(hook) {
  const record = {
    tool: typeof hook.tool_name === 'string' ? hook.tool_name : '',
    detail: deriveDetail(hook.tool_name, hook.tool_input),
    sessionId: typeof hook.session_id === 'string' ? hook.session_id : '',
    cwd: typeof hook.cwd === 'string' ? hook.cwd : '',
    at: Date.now()
  };
  try { fs.mkdirSync(DASH_DIR, { recursive: true }); } catch (_) {}
  try {
    fs.writeFileSync(ACTIVITY_TMP, JSON.stringify(record, null, 2));
    fs.renameSync(ACTIVITY_TMP, ACTIVITY_FILE);
  } catch (_) {
    // Best-effort cleanup of a stranded tmp file; ignore failures.
    try { fs.unlinkSync(ACTIVITY_TMP); } catch (_e) {}
  }
}

// Absolute last resort: a hook must never fail the tool call.
process.on('uncaughtException', () => { process.exit(0); });
