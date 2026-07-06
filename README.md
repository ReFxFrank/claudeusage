# Pulse

A live, local, **zero-dependency** usage dashboard for [Claude Code](https://claude.com/claude-code).

Pulse reads the session logs Claude Code writes to disk, aggregates them, and serves a
self-refreshing dashboard on `http://localhost:4747`: your current 5-hour block with a
reset countdown, burn rate, today / last 7 days, a 30-day spend chart, model & source
splits, and recent sessions.

It is a single Node process with **no dependencies** (`npm ls` shows an empty tree),
makes **no network calls**, and only ever **reads** from `~/.claude` — it never writes,
moves, or deletes anything there.

```
┌────────────────────────────────────────────────────────────┐
│  Pulse           Claude Code usage        updated 14:22:01   │
│  ● live                                   9 msgs · 1 session  │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ Current 5h   │ Burn rate    │ Today        │ Last 7 days     │
│  $5.42       │  $55.51/hr   │  $5.42       │  $5.42          │
│  resets 4h32 │  289K tok/m  │  1.7M · 9    │  1.7M · 9       │
├──────────────┴──────────────┴──────────────┴────────────────┤
│ 30-day spend           ▁▁▂▁▃▅▂▁▇█▃▂▁                         │
│ By model  ▏████████ claude-opus-4-8   $5.42                  │
│ Recent sessions …                                            │
└──────────────────────────────────────────────────────────────┘
```

## Requirements

- **Node ≥ 18** (built-ins only — `fs`, `http`, `path`, `os`, `url`). No build step.

## Run

```sh
node server.js
# then open http://localhost:4747
```

or

```sh
npm start          # same thing
./pulse.sh         # POSIX launcher (pulse.cmd on Windows)
```

The dashboard fetches fresh data and re-renders **every 10 seconds** — leave it open
in a tab while you work.

### Options

| Flag / env         | Effect                                                        |
| ------------------ | ------------------------------------------------------------- |
| `--port N` / `PORT`| Listen port (default `4747`). Use if the port is taken.       |
| `--host H` / `HOST`| Bind address (default `127.0.0.1`). `0.0.0.0` exposes it on the network — see the warning it prints; prefer an SSH tunnel. |
| `--inspect-schema` | Print the record schema observed in your logs, then exit.     |
| `CLAUDE_DIR`       | Override the `~/.claude` location for non-standard installs.  |
| `--help`           | Usage.                                                        |

```sh
node server.js --port 5000
CLAUDE_DIR=/mnt/claude node server.js
```

## Deploy on an Ubuntu VPS (one command)

If you run Claude Code on a headless VPS, install Pulse as a background service
with a single command:

```sh
curl -fsSL https://raw.githubusercontent.com/refxfrank/claudeusage/claude/pulse-usage-dashboard-g0xxtk/install.sh | bash
```

(or clone the repo and run `./install.sh`). The installer:

1. Fetches Pulse and ensures Node ≥ 18 (installs Node 20 LTS via NodeSource if needed).
2. Installs a **systemd service** that runs as the user whose `~/.claude` holds
   your usage, restarts on failure, and starts on boot. (No systemd? It falls
   back to a `systemctl --user` service, then to `nohup`.)
3. Binds to `127.0.0.1` and prints how to reach it.

**Reaching it securely.** Pulse binds to localhost on the VPS by default — it is
*not* exposed to the internet, because the dashboard reveals usage metadata
(project paths, session titles, cost estimates). Open an SSH tunnel from your own
machine:

```sh
ssh -N -L 4747:localhost:4747 <you>@<your-vps-ip>
# then open http://localhost:4747 in your browser
```

**Managing the service:**

```sh
sudo systemctl status pulse      # or: systemctl --user status pulse
sudo systemctl restart pulse
journalctl -u pulse -f           # live logs
```

**Overrides** (env vars before the command): `PULSE_PORT`, `PULSE_HOST`,
`PULSE_DIR`, `PULSE_BRANCH`, `CLAUDE_DIR`. To expose Pulse directly instead of
tunnelling (not recommended — put a firewall or authenticating reverse proxy in
front), install with `PULSE_HOST=0.0.0.0`.

Re-running the installer updates to the latest version and restarts the service.

## How it works

- **Source of truth.** Claude Code writes newline-delimited JSON (`.jsonl`) session logs
  under `~/.claude/projects/<project>/<session>.jsonl`. Pulse walks that tree, parses each
  assistant message that carries a `usage` block, and normalizes it.
- **Deduplication.** The same message is written to the log multiple times as it streams
  (and can be duplicated across resumed sessions). Pulse dedupes on `message.id + requestId`
  globally, counting each unique message once — without this, cost would be inflated ~3×.
- **5-hour blocks.** Claude usage limits reset on rolling 5-hour windows. Pulse reconstructs
  those blocks (gap ≥ 5h **or** past the window opens a new block) and shows the active
  block, its reset countdown, and how it compares to your heaviest past block.
- **Cost model.** Per-message cost is computed from Anthropic API list prices, with the
  standard cache multipliers (write-5m ×1.25, write-1h ×2.0, read ×0.1) and web-search
  pricing. All prices live in one clearly-commented `PRICING` object at the top of
  `server.js` — updating a price is a one-line edit. Unknown model strings fall back to a
  default price and are logged once so you can add them.
- **Fast on large histories.** Parsed files are cached by mtime; unchanged files are never
  re-read. The server logs `parsed X files, skipped Y (cached)` so you can see the cache
  working. The arithmetic rollup is cheap and redone on every request.
- **Degrades cleanly.** If no desktop-app records exist (e.g. a headless VPS running Claude
  Code over `tmux`), Pulse runs in single-source mode and derives session titles from the
  first user prompt. No desktop app is required.

## Costs are estimates, not a bill

Costs are **estimates** at Claude API list prices. On a Pro/Max subscription they express
your **relative** usage — which sessions, models, and time windows are heavy — not an amount
you will be charged. Verify current list prices at
[docs.claude.com](https://docs.claude.com) before relying on absolute dollar figures.

## Privacy & local-only

- Binds to `127.0.0.1` only — not reachable from the network.
- Makes **no** outbound requests. No CDN, no fonts, no analytics, no telemetry. Works fully
  offline.
- Reads `~/.claude` **read-only**. Pulse never writes, moves, or deletes anything under that
  tree.

## Files

| File          | What it is                                                             |
| ------------- | ---------------------------------------------------------------------- |
| `server.js`   | Zero-dependency backend: parsing, mtime cache, aggregation, HTTP.      |
| `index.html`  | Self-contained dashboard — HTML + inline CSS + vanilla JS + SVG charts.|
| `pulse.sh`    | POSIX launcher (`pulse.cmd` for Windows).                              |
| `install.sh`  | One-command Ubuntu/systemd VPS installer (service + boot + tunnel help).|
| `package.json`| Metadata + `npm start`. Declares **no** dependencies.                  |

## API

- `GET /` → the dashboard.
- `GET /api/summary` → the full JSON payload (all aggregations).
- `GET /api/health` → `{ "ok": true }`.
