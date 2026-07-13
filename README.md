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

## Download (easiest)

Grab the latest single-file executable from
**[Releases](https://github.com/refxfrank/claudeusage/releases)** — no Node, no
install:

- **Windows:** download `pulse.exe` and double-click it — the dashboard opens at
  `http://localhost:4747`. SmartScreen may warn because the binary is unsigned:
  click **More info → Run anyway**.
- **Linux:** `chmod +x pulse-linux && ./pulse-linux`

## Run from source

- **Node ≥ 18** for the server (zero runtime dependencies). The pre-built
  frontend is committed, so this is all you need:

```sh
node server.js
# then open http://localhost:4747
```

or

```sh
npm start          # same thing
./pulse.sh         # POSIX launcher (pulse.cmd on Windows)
```

To hack on the React frontend (`web/`): `npm run build` (Node ≥ 20) rebuilds it;
`npm run dev` runs Vite with hot reload. To produce a single-file executable
yourself: `node build/make-exe.mjs` (builds for the OS you run it on; the
release workflow does this on tag push).

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
curl -fsSL https://raw.githubusercontent.com/refxfrank/claudeusage/main/install.sh | bash
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

## Reasoning-effort logging (optional)

Claude Code never writes the reasoning effort level (`low`→`max`, ultracode) to
its transcripts, and does not put it in the hook payload either — but it *does*
persist the level you pick with `/effort` to `settings.json`. Pulse ships an
optional hook that reads that level so the dashboard can show effort chips per
model and session — for **every** model, Fable included:

```sh
node server.js --effort-setup     # or: pulse.exe --effort-setup
```

That prints a `hooks` snippet to paste into `~/.claude/settings.json` (Pulse
never edits `~/.claude` itself). Once added, sessions log their effort level to
`~/.pulse/modes.jsonl` and the dashboard picks it up automatically. The hook is
silent, always exits 0, and appends only when the level changes. It reads the
effort from `settings.json` (`effortLevel`), falling back to the hook payload /
`CLAUDE_CODE_EFFORT_LEVEL` env if a future Claude Code version exposes it there.

**One caveat:** `/effort` only stores a level when it *differs* from the model's
default (the default — `high` for the current top models — is stored as absent).
So a session left at the default has no explicit level to record and shows no
effort chip. Pick a non-default level, or type `ultracode`, and it appears.
Ultracode is additionally detected from prompt text, which works even for
history recorded before the hook was installed.

## What Pulse can and can't see

- Pulse reads the session logs on **this machine only** (`~/.claude/projects`).
  Usage from other computers, the claude.ai website, or the mobile app is not in
  those logs and won't appear.
- **Claude Code prunes old logs.** By default it deletes session transcripts
  after ~30 days (`cleanupPeriodDays`). Once a log is deleted, that usage is
  gone from Pulse too — past months will slowly shrink. To keep your history,
  add this to `~/.claude/settings.json`:

  ```json
  { "cleanupPeriodDays": 3650 }
  ```

- "Last 30 days" is a **rolling window** — heavy days age out of it daily. Use
  the month entries in the period dropdown for fixed calendar-month totals.
- The **Recent sessions** table shows whole-session totals (all of a session's
  messages, whenever they happened), so summing that column will not match a
  period total when sessions straddle the window edge.

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
| `web/`        | React frontend (Vite + Radix + Framer Motion); built output in `web/dist` is committed and served by the server. |
| `build/make-exe.mjs` | Packages server + frontend into a single executable (Node SEA). |
| `.github/workflows/release.yml` | Builds `pulse.exe` / `pulse-linux` and publishes a Release on `v*` tags. |
| `pulse.sh`    | POSIX launcher (`pulse.cmd` for Windows).                              |
| `install.sh`  | One-command Ubuntu/systemd VPS installer (service + boot + tunnel help).|
| `package.json`| Metadata + `npm start`. Declares **no** dependencies.                  |

## API

- `GET /` → the dashboard.
- `GET /api/summary` → the full JSON payload (all aggregations).
- `GET /api/health` → `{ "ok": true }`.
