# COWL_GT — a vintage cowl for Claude Code

> *Cowl* (n.) — on 1920s–30s automobiles, the section of coachwork between the
> hood and the windshield: **the part of the body that housed the instruments.**
> That's exactly what this is, for your LLM.

A floating macOS dashboard for **working better with LLMs in terminal
sessions**, styled as a vintage Italian grand tourer's instrument cowl. Live
gauges show what your model is actually doing — generation speed (tok/s),
sustained load (RPM), context "fuel level", running cost, tokens travelled and
lines of code as odometer mileage — and physical-looking controls let you
**shift gears** (switch models), hit **OVERDRIVE**, flip **skill switches**,
and pull the **wiper stalk** to clean your context, all without touching the
terminal. Built for Claude Code today; other engines later (see
[Future work](#future-work)).

```
      ┌──────────────────────────────────────────────────┐
      │  ◜ TACHIMETRO ◝     COWL · GT     ◜ CONTAGIRI ◝  │
      │   tok/s + odometer   ─────────     gen. load     │
      │   ◜FUEL◝ (context)   ◜ MOTORE ◝   ◜COST◝ ($)     │
      │                                                  │
      │   [1][2][3][4][5][6][7]        ⚡ OVERDRIVE       │
      │      gear shifter                                │
      │   ◦ DOCTOR  ◦ MCP  ◦ HELP        ⌁ TERGI ⌁      │
      │     skill switches                wipers         │
      └──────────────────────────────────────────────────┘
```

![COWL_GT dashboard](docs/screenshot.png)

**macOS only.** Made by botchuino.

---

## Why (the hard constraint)

**There is no API to switch models in a running Claude Code session.** No IPC,
no config hot-reload, no live "set model" hook — Claude Code reads its model at
session start.

The only mechanism that works against a *live* session is **macOS keystroke
injection**: the app activates your terminal and *types* into it — e.g.
`/model opus` + Return — exactly as if you had typed it yourself, via
`osascript` + System Events. Every gear, the OVERDRIVE button, each skill
switch, and the wipers work this way. That's also why the app needs the
**Accessibility permission** (see Requirements).

To make a gear choice stick for **future** sessions, shifting also writes the
model into `~/.claude/settings.json` (best-effort). Only the keystroke affects
the current session.

Live gauges come from a transparent **statusline tap**: Claude Code pipes
session JSON to its `statusLine.command` on every render; the tap records it to
`~/.claude/dashboard/state.json` (atomic write) and delegates the same bytes to
your real statusline, so your bar looks unchanged.

```
Claude Code ──statusline JSON──▶ statusline-tap.js ──▶ state.json ──▶ gauges
                                        │
                                        └──▶ your real statusline (unchanged)
Dashboard controls ──osascript keystrokes──▶ your terminal (Claude Code TUI)
```

---

## Requirements

- **macOS** (keystroke injection uses `osascript` + System Events)
- **Node.js 18+** and npm
- A supported terminal app (iTerm2, Terminal, Ghostty, WezTerm, kitty,
  Alacritty, Warp, Hyper, VS Code, Cursor — configurable)
- **Accessibility permission** for the app sending keystrokes (Electron and/or
  your terminal): *System Settings → Privacy & Security → Accessibility*

---

## Install

The app runs from `~/.claude/dashboard`:

```bash
git clone <this-repo>
cd <this-repo>
mkdir -p ~/.claude/dashboard
cp -R ./dashboard/. ~/.claude/dashboard/
cd ~/.claude/dashboard
npm install
chmod +x launch-dashboard.sh
```

Then wire up `~/.claude/settings.json` (merge with your existing blocks, don't
overwrite — and remember your previous statusline command so you can revert):

**Statusline tap** — point `statusLine.command` at the tap; it delegates to
your existing statusline wrapper (`~/.claude/ecc-statusline-wrapper.js`) and
prints a minimal fallback line if that's missing:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/dashboard/statusline-tap.js"
  }
}
```

**SessionStart hook** — auto-launch the dashboard, async so it never blocks
session start (the script is idempotent; a second launch just focuses the
existing window):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/dashboard/launch-dashboard.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

**PostToolUse hook** — feed the live **activity strip** (which tool Claude is
using right now, e.g. `Edit renderer.js` or `Bash npm test`), async so it never
slows tool calls:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/dashboard/hooks/activity-hook.js",
            "async": true
          }
        ]
      }
    ]
  }
}
```

Finally, grant **Accessibility permission**. If keystrokes silently do nothing,
this is almost always the cause — enable both Electron and your terminal app.

Test-run any time with `cd ~/.claude/dashboard && npm start`.

---

## Configure

**Language.** The chrome plate labels speak four languages — set `"language"`
in `config.json` to `it` (default), `en`, `pt` or `es`, or just pick one from
the in-app ⚙ panel. The enamel gauge faces stay Italian on purpose: a vintage
Italian instrument exported abroad still says *benzina* on the dial.
User-configurable labels (gears, switches, the wiper plate) are yours to
write in any language.


Everything is editable in `~/.claude/dashboard/config.json` (seeded from
`config.default.json` on first run) **or via the in-app config panel**. Map
your **own** skills, slash commands, and MCP tools — the defaults are just a
starting point.

- **`gears`** — the model shifter. Each gear has a `modelArg` (typed as
  `/model <modelArg>`), a `label`/`sublabel` for the dial, and `match` tokens
  that highlight the currently *engaged* gear from the live model id (the gear
  whose tokens all match, with the most tokens, wins).
- **`nos`** — the OVERDRIVE button: types `keystrokes`, optionally + Return.
- **`skillButtons`** — quick switches. `type:"text"` types a string
  (optionally + Return); `type:"chord"` sends a key chord like `ctrl+8` or
  `cmd+shift+k`. Ship your own `/mycommand` or MCP triggers here.
- **`wipers`** — the context wipers:
  - **INT** (intermittent) → `/compact` — squeegee the context down.
  - **FULL** → `/clear` — full wash; destructive, so the UI requires a
    **double-click to confirm**.
- **`targetTerminal`** — `"auto"` picks the first running app from
  `knownTerminals`; set an exact app name (e.g. `"iTerm2"`) to force one. Also
  switchable from the UI. It must be the terminal running your Claude Code
  session.
- **`injectEnterDelayMs` / `activateDelayMs`** — timing knobs; increase if
  keystrokes land before the terminal is focused.

---

## Live data (state fields & gauges)

The statusline tap writes `~/.claude/dashboard/state.json` with:

- `modelId` / `modelName` — the live model (drives the engaged-gear highlight).
- `costUsd` — running session cost (the COST gauge).
- `contextPct` / `contextUsed` / `contextSize` — context-window usage.
- `tokensIn` / `tokensOut` — cumulative session input/output tokens; the
  renderer differentiates successive states to show a live tokens-per-second
  rate.
- `linesAdded` / `linesRemoved` — cumulative lines of code changed.
- `sessionId` / `cwd` / `updatedAt` — session identity and freshness.

The PostToolUse hook writes `~/.claude/dashboard/activity.json`
(`{ tool, detail, sessionId, cwd, at }`); it is merged into the pushed state as
`state.activity` and dropped when older than 120 s. The main process also
attaches `state.targetApp` — the resolved keystroke-injection target terminal
(cached, refreshed at most every 5 s).

**Fuel gauge semantics:** the FUEL needle reads like a real tank — it starts at
**F** (full, empty context) and swings toward **E** as the context window fills.
When less than **20%** of the context remains, the amber **RISERVA** (reserve)
lamp lights up: time to pull the TERGI stalk (`/compact` or `/clear`).

---

## Reverting

1. Restore your statusline in `~/.claude/settings.json` (point
   `statusLine.command` back at your previous command — the tap only ever wrote
   `~/.claude/dashboard/state.json` and delegated, so removal is clean).
2. Remove the `SessionStart` hook entry that calls `launch-dashboard.sh` and
   the `PostToolUse` hook entry that calls `activity-hook.js`.
3. Quit the app (its close button quits everything) and optionally delete
   `~/.claude/dashboard`.

---

## Caveats

- **macOS only.**
- **Multi-session:** all sessions write the single
  `~/.claude/dashboard/state.json`, so with multiple concurrent Claude Code
  sessions the gauges show whichever session rendered last, and keystrokes go
  to the one configured target terminal. Best with one active session at a
  time.
- **Fully offline.** No network, no CDN, no webfonts — everything is local.
- **VS Code integrated terminal:** works (target app `Code`), with one focus
  caveat — macOS restores focus to wherever you last were inside VS Code. If
  you last touched the editor (not the terminal), injected keystrokes would
  land in your file. If you normally interact with Claude Code in the
  integrated terminal, focus is already right; otherwise click into the
  terminal once before shifting.

---

## Future work

- **Other engines.** The cowl is engine-agnostic by design — keystroke
  injection doesn't care what's running in the terminal. Planned: variants for
  other terminal LLM CLIs (Codex CLI, Gemini CLI, opencode, …); each needs only
  its own telemetry tap and a gear map.
- **VS Code extension.** A native COWL_GT extension: same gauge cluster in a
  webview panel, but driving the integrated terminal through
  `terminal.sendText()` — no Accessibility permission, no osascript, no focus
  caveat. The cleanest possible transmission.
- **More instruments** as richer session telemetry becomes available (active
  subagents, queue depth, per-turn timing).

---

MIT — made by **botchuino**.
