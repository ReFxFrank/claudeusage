# Changelog

## v1.2.1

- **Source filter:** chips above the dashboard scope EVERYTHING (spend, models,
  sessions, block, burn rate) to any combination of sources — e.g. only
  `claude-desktop`, or `cli` + `claude-desktop` for Claude-only. Multi-select,
  persisted locally, colors stay stable.
- **Chart tooltip fix:** the spend-chart hover tooltip was positioned with
  viewport coordinates under a CSS-transformed ancestor, landing far from the
  cursor. Now positioned container-relative — verified with a real-browser
  hover test.
- **No more `gpt-unknown`:** Codex usage recorded before the turn context is
  buffered and back-attributed to the right model (and re-priced) once known.

## v1.2.0

- **macOS binary:** releases now include `pulse-macos` (Apple Silicon), and the
  self-updater fetches the right asset per platform. Paths resolve per-user at
  runtime on every OS (`~/.claude` / `CLAUDE_CONFIG_DIR`, `~/.codex` / `CODEX_HOME`).
- **OpenAI Codex support:** Pulse now ingests Codex CLI session logs
  (`~/.codex/sessions`, override with `CODEX_DIR`) automatically — `gpt-*` model
  rows, a `codex` source, session titles, per-turn reasoning-effort chips, and
  costs at OpenAI list prices with the cached-input discount. Rollout parsing
  was validated against real files written by codex 0.144.3, replay-safe
  deduplication included. The Current-5h-block tile remains Claude-only (Codex
  has separate limit windows). ChatGPT web/mobile writes no local logs and is
  out of scope.

## v1.1.2

- **Docs:** professionalized README — logo, badges, demo screenshots (generated from
  synthetic data, no real usage), feature list, API/layout tables; added this changelog.
- **Current 5h block:** added an ⓘ explainer on the tile — the countdown is
  reconstructed from this machine's logs; usage on other surfaces (claude.ai, mobile,
  another computer) anchors Claude's *real* window, which can therefore reset earlier
  than shown. Claude Code does not persist the true reset time anywhere readable.

## v1.1.1

- **Easy start/stop:** Stop button in the dashboard header (confirm-on-second-click)
  with a dedicated "Pulse is stopped" page; `--stop` flag stops the running instance
  from any terminal or shortcut; `--install-shortcuts` (Windows) creates
  **"Pulse"** / **"Pulse — Stop"** Desktop buttons.

## v1.1.0

- **Background mode (Windows):** double-clicking `pulse.exe` no longer leaves a
  console window; a hidden process serves the dashboard and logs to `~/.pulse/pulse.log`.
  Double-clicking a newer exe over a running older one replaces it automatically.
  `--no-daemon` opts out.
- **Server panel in the dashboard:** version, uptime, mode, live server-log tail,
  Stop button, and update controls.
- **Self-update:** GitHub release check (the only network call Pulse makes;
  `--no-update-check` disables) with one-click install — sha256-verified download,
  atomic executable swap with rollback, automatic relaunch.
- **Hardening from an adversarial review (18 confirmed findings):** fail-closed
  update verification, DNS-rebinding guards on all API routes, double-callback crash
  fix, log-stream error handling and live rotation, correct handling of pre-1.1.0
  instances during takeover, no silent downgrades, and more.

## v1.0.3

- **Effort chips with zero setup:** `/effort <level>` commands are parsed straight
  from session transcripts — retroactive, every model, no hook required. Mid-session
  changes apply from that point on; switching turns the previous state off.

## v1.0.2

- **Effort logging for all models:** the optional hook reads the persisted
  `effortLevel` from settings (the hook payload doesn't carry effort), fixing missing
  chips on Fable.
- **`<synthetic>` hidden:** Claude Code's internal placeholder is priced at $0 and
  removed from the by-model list, session chips, and pricing view.

## v1.0.1

- **Pricing:** dated model variants (e.g. `claude-haiku-4-5-20251001`) price as their
  base model instead of falling back to default pricing.

## v1.0.0

- Initial release: zero-dependency local server, React dashboard (Vite + Radix +
  Framer Motion), 5-hour blocks with reset countdown, burn rate, daily/period spend,
  per-model/per-source breakdowns with speed and effort chips, recent sessions,
  mtime-cached parsing with global dedup, single-file executables for Windows and
  Linux, one-command Ubuntu VPS installer.
