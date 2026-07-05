#!/usr/bin/env bash
#
# launch-dashboard.sh — SessionStart hook launcher for the Claude GT Dashboard.
#
# Idempotent and safe to run anywhere:
#   - If an instance is already running, exit 0 (do nothing).
#   - If ~/.claude/dashboard or Electron isn't installed yet, exit 0 quietly.
#   - Otherwise launch the Electron app detached (nohup) and return immediately.
#
# It must NEVER block a Claude Code session start, so every path exits 0 fast.

set -u

DASH_DIR="$HOME/.claude/dashboard"
PIDFILE="$DASH_DIR/.pid"

# App dir must exist and contain the Electron entrypoint.
[ -d "$DASH_DIR" ] || exit 0
[ -f "$DASH_DIR/main.js" ] || exit 0

# --- already running? ---------------------------------------------------------
# Live pidfile check. (Electron's single-instance lock is the real backstop:
# a duplicate launch focuses the existing window and exits on its own.)
if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    exit 0
  fi
fi

# --- resolve a launcher -------------------------------------------------------
# Prefer a locally installed electron binary; else fall back to npx.
LAUNCH_CMD=""
if [ -x "$DASH_DIR/node_modules/.bin/electron" ]; then
  LAUNCH_CMD="$DASH_DIR/node_modules/.bin/electron ."
elif command -v npx >/dev/null 2>&1; then
  LAUNCH_CMD="npx electron ."
else
  # No way to launch yet (deps not installed). Don't error the session.
  exit 0
fi

# --- launch detached ----------------------------------------------------------
cd "$DASH_DIR" || exit 0
# shellcheck disable=SC2086
nohup $LAUNCH_CMD >/dev/null 2>&1 &
APP_PID=$!

# Record the pid for the next idempotency check (best-effort).
echo "$APP_PID" > "$PIDFILE" 2>/dev/null || true

# Detach the background job and return immediately.
disown "$APP_PID" 2>/dev/null || true
exit 0
