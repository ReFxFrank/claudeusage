<div align="center">
  <img src=".github/assets/logo.svg" alt="Pulse logo" width="88" height="88" />

# Pulse

**A live, local, zero-dependency usage dashboard for [Claude Code](https://claude.com/claude-code).**

See what you're spending, which models you're burning it on, your 5-hour block, and
which sessions ran at which reasoning effort — all from the logs already on your machine.

[![Release](https://img.shields.io/github/v/release/ReFxFrank/claudeusage?color=8f7ff5&label=release)](https://github.com/ReFxFrank/claudeusage/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ReFxFrank/claudeusage/total?color=8f7ff5&label=downloads)](https://github.com/ReFxFrank/claudeusage/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22b892.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-4a9bf5)](https://github.com/ReFxFrank/claudeusage/releases/latest)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-e0a132)](package.json)

  <img src=".github/assets/hero.png" alt="Pulse dashboard" width="920" />
</div>

---

## ✨ Features

- 💸 **Live spend tracking** — current 5-hour block with reset countdown, burn rate,
  today / last 7 days, and a 30-day stacked spend chart. Refreshes every 10 seconds.
- 📅 **Any period** — rolling 30 days or any past calendar month from the dropdown.
- 🤖 **Per-model & per-source breakdowns** — cost, tokens, and messages for every model
  and entry point (CLI, desktop app), with stable colors.
- 🧠 **Reasoning-effort chips** — see which sessions ran at `low → max`, ultracode, or
  fast mode. Works **out of the box, retroactively**: Pulse reads your `/effort`
  commands straight from the session transcripts.
- 🗂 **Recent sessions table** — titles, models, mode, cost, tokens, and recency.
- 🖥 **No console window** — on Windows the exe runs hidden in the background; logs,
  version, uptime, **Stop**, and updates live in the dashboard's **Server panel**.
- 🔄 **Self-updating** — one click installs new releases (sha256-verified against the
  GitHub API). Double-clicking a newer exe over a running old one takes over cleanly.
- ⏯ **Easy start/stop** — Stop button in the header; `--install-shortcuts` puts
  **"Pulse"** / **"Pulse — Stop"** buttons on your Desktop; `--stop` for scripts.
- 🪶 **Zero runtime dependencies** — one Node process, built-ins only (`npm ls` is empty).
- 🔒 **Local-first** — binds to `127.0.0.1`, reads `~/.claude` strictly read-only, and
  makes **no network calls** except an optional GitHub version check.

<div align="center">
  <img src=".github/assets/panels.png" alt="Model breakdowns, effort chips and sessions" width="920" />
</div>

## 🚀 Quick start

### Download (easiest — no Node required)

Grab the latest single-file executable from
**[Releases](https://github.com/ReFxFrank/claudeusage/releases/latest)**:

| Platform | Get running |
| --- | --- |
| **Windows** | Download `pulse.exe`, put it in a permanent folder, double-click. Pulse starts in the background and opens `http://localhost:4747`. SmartScreen may warn (unsigned binary): **More info → Run anyway**. |
| **Linux** | `chmod +x pulse-linux && ./pulse-linux` |

Then, optionally, on Windows:

```bat
pulse.exe --install-shortcuts
```

adds **"Pulse"** (start / open dashboard) and **"Pulse — Stop"** buttons to your Desktop.
Starting is idempotent — if Pulse is already running, double-clicking just opens the dashboard.

### Run from source

Node ≥ 18, zero runtime dependencies; the pre-built frontend is committed:

```sh
git clone https://github.com/ReFxFrank/claudeusage && cd claudeusage
node server.js          # → http://localhost:4747
```

To hack on the React frontend (`web/`): `npm run build` (Node ≥ 20) rebuilds it,
`npm run dev` runs Vite with hot reload, `node build/make-exe.mjs` packages a
single-file executable for your OS.

### Deploy on an Ubuntu VPS (one command)

```sh
curl -fsSL https://raw.githubusercontent.com/refxfrank/claudeusage/main/install.sh | bash
```

Installs Pulse as a systemd service bound to `127.0.0.1` (auto-restart, start on
boot). Reach it over an SSH tunnel — the dashboard exposes usage metadata, so it
is deliberately **not** internet-facing:

```sh
ssh -N -L 4747:localhost:4747 <you>@<your-vps-ip>
```

Manage with `sudo systemctl status|restart pulse`, logs via `journalctl -u pulse -f`.
Overrides: `PULSE_PORT`, `PULSE_HOST`, `PULSE_DIR`, `PULSE_BRANCH`, `CLAUDE_DIR`.
Re-running the installer updates and restarts the service.

## 🎛 Options

| Flag / env         | Effect                                                        |
| ------------------ | ------------------------------------------------------------- |
| `--port N` / `PORT`| Listen port (default `4747`).                                 |
| `--host H` / `HOST`| Bind address (default `127.0.0.1`). `0.0.0.0` exposes it on the network — see the warning it prints; prefer an SSH tunnel. |
| `--stop`           | Stop the running Pulse instance and exit.                     |
| `--install-shortcuts` | (Windows) add **"Pulse"** and **"Pulse — Stop"** Desktop shortcuts. |
| `--no-daemon`      | (Windows exe) stay in the console window instead of backgrounding. |
| `--no-update-check`| Disable the GitHub version check — Pulse then makes zero network calls. Also: `PULSE_NO_UPDATE_CHECK=1`, or `{"updateCheck": false}` in `~/.pulse/config.json`. |
| `--no-open`        | Don't auto-open the browser (packaged exe).                   |
| `--effort-setup`   | Print the optional effort-logging hooks snippet.              |
| `--version` / `--help` | The usual.                                               |
| `--inspect-schema` | Print the record schema observed in your logs, then exit.     |
| `CLAUDE_DIR`       | Override the `~/.claude` location for non-standard installs.  |

## 🖥 The Server panel

Everything you'd normally need a console for lives at the bottom of the dashboard:
version, uptime, mode, live server logs, **Stop**, **Check for updates**, and
one-click **Update now** (downloads the release asset, verifies its sha256 digest
against the GitHub API, swaps the executable atomically with rollback, restarts,
and your page reloads on the new version).

<div align="center">
  <img src=".github/assets/server.png" alt="Server panel: logs, stop, updates" width="920" />
</div>

## 🧠 Reasoning-effort chips

Claude Code never writes the effort level (`low`→`max`, ultracode) into its
transcripts as data — but the `/effort` **commands you type are recorded in
them**. Pulse parses those directly, so effort chips work with **zero setup**,
**retroactively**, and for **every model**:

- `/effort max` mid-session → entries from that point on carry a `max` chip.
- `/effort ultracode` → the ULTRA chip, until you switch levels again.
- Typing `ultracode` in a prompt flags the whole session (also retroactive).
- A session that never set a level shows no chip — Pulse won't guess.

One case transcripts can't cover: an effort level persisted in `settings.json`
(applied across sessions) rather than set per-session. For that, Pulse ships an
optional hook — `node server.js --effort-setup` prints a snippet to paste into
`~/.claude/settings.json` (Pulse never edits `~/.claude` itself). New sessions
then log their level to `~/.pulse/modes.jsonl` automatically.

## 🔍 How it works — and how accurate it is

- **Source of truth.** Claude Code writes newline-delimited JSON session logs under
  `~/.claude/projects/`. Pulse walks that tree, parses every assistant message
  carrying a `usage` block, and normalizes it. Parsed files are cached by mtime —
  unchanged files are never re-read, so even large histories rebuild in milliseconds.
- **Deduplication.** The same message is written multiple times as it streams.
  Pulse dedupes globally on `message.id + requestId` — without this, costs would be
  inflated ~3×.
- **Cost model.** Per-message cost from Anthropic API list prices, with cache-write
  (×1.25 / ×2.0) and cache-read (×0.1) multipliers and web-search pricing. All
  prices live in one commented `PRICING` object at the top of `server.js`; dated
  model variants (`claude-*-20251001`) price as their base model. Unknown models
  fall back to a default price and are logged once.
- **5-hour blocks.** Claude's usage limits reset on 5-hour windows opened by your
  first message. Pulse reconstructs them from this machine's logs: the first
  message after a ≥ 5h gap (or past the previous window's end) opens a block,
  floored to the hour.

  > ⚠ **Why the reset countdown can differ from Claude's.** The *real* window is
  > opened by your first message on **any** surface — claude.ai in the browser,
  > mobile, or another computer. Those messages aren't in this machine's logs, so
  > if they anchored the real window earlier, the actual reset happens **earlier**
  > than Pulse shows. Claude Code receives the true reset time from the API but
  > does not persist it anywhere a local tool can read — so a reconstruction is
  > the best any offline dashboard can do. Treat the countdown as an upper bound
  > from this machine's point of view.

## 👁 What Pulse can and can't see

- Pulse reads the session logs on **this machine only**. Usage from other
  computers, claude.ai in the browser, or the mobile app won't appear.
- **Claude Code prunes old logs** (~30 days by default via `cleanupPeriodDays`).
  Deleted logs are gone from Pulse too. To keep history, add to `~/.claude/settings.json`:

  ```json
  { "cleanupPeriodDays": 3650 }
  ```

- "Last 30 days" is a **rolling window**; use the month entries in the dropdown for
  fixed calendar-month totals.
- The **Recent sessions** table shows whole-session totals, so summing that column
  will not match a period total when sessions straddle the window edge.

## 💵 Costs are estimates, not a bill

Costs are computed at Claude API list prices. On a Pro/Max subscription they express
your **relative** usage — which sessions, models, and time windows are heavy — not an
amount you'll be charged. Verify current list prices at
[docs.claude.com](https://docs.claude.com) before relying on absolute figures.

## 🔒 Privacy & security

- Binds to `127.0.0.1` only — not reachable from the network.
- Reads `~/.claude` **read-only**; never writes, moves, or deletes anything there.
  Pulse's own files (config, logs, effort sidecar) live in `~/.pulse`.
- The **only** outbound request is the optional GitHub version check (plus the
  release download if you click *Update now*, verified against its GitHub sha256
  digest). **No usage data ever leaves your machine.** `--no-update-check` gives
  you zero network calls; everything else works fully offline. No CDN, no fonts,
  no analytics, no telemetry.
- Endpoints with side effects (stop, update) are POST-only, loopback-only,
  Host-header-checked, and require a custom header — web pages you visit cannot
  trigger them (CSRF/DNS-rebinding hardened; data reads are Host-checked too).

## 🌐 API

| Route | Method | Description |
| --- | --- | --- |
| `/` | GET | The dashboard. |
| `/api/summary` | GET | Full JSON payload — all aggregations + server/update state. |
| `/api/health` | GET | `{ ok, version, pid }` |
| `/api/logs` | GET | Recent server log lines (the Server panel's log view). |
| `/api/shutdown` | POST | Stop the server. Requires `X-Pulse: 1`, loopback only. |
| `/api/update/check` · `/api/update/install` | POST | Update flow. Same guards. |

## 📁 Repository layout

| Path | What it is |
| --- | --- |
| `server.js` | The whole backend: parsing, cache, aggregation, HTTP, updates, background mode. Zero runtime dependencies. |
| `web/` | React frontend (Vite + Radix + Framer Motion). Built output in `web/dist` is committed and served. |
| `build/make-exe.mjs` | Packages server + frontend into a single executable (Node SEA). |
| `.github/workflows/release.yml` | Builds `pulse.exe` / `pulse-linux` and publishes a Release. |
| `install.sh` / `pulse.sh` / `pulse.cmd` | VPS installer and launchers. |

## 📝 License

[MIT](LICENSE) — do what you like, no warranty. Not affiliated with Anthropic.
