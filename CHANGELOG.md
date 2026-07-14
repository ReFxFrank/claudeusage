# Changelog

## v1.4.1

- **Lite graphics mode — fixes heavy CPU use without hardware acceleration:**
  the glassmorphism `backdrop-filter` blur re-renders on the CPU on every
  repaint when the browser has no GPU compositing, which could peg a core and
  lag other windows (worst around the chart, which repaints constantly).
  Pulse now detects software rendering (SwiftShader/llvmpipe via the WebGL
  renderer string) and switches to a solid-surface look automatically: no
  blur, no entrance/hover animations, counters jump instead of tweening, and
  the header pulse/grain effects are disabled. Override any time with the
  **Graphics: auto/lite/rich** button in the Server panel (persisted).
  Number tweens also pause in background tabs now.

## v1.4.0

- **Official Codex meters (automatic):** the Account-limits card now also shows
  your ChatGPT plan's Codex allowance — session and weekly windows with true
  reset countdowns — parsed from the rate-limit snapshots Codex already writes
  into its local rollout logs on every turn. No login, no network call, nothing
  leaves the machine. Rows are labeled with snapshot freshness ("as of Xm ago");
  a window that rolled over since the last turn shows as stale instead of a
  stale percentage. Handles both absolute (ISO / epoch-seconds) and legacy
  relative reset formats.

## v1.3.1

- **Account meters no longer trust the local expiry stamp:** Pulse attempts the
  usage call regardless of the token file's `expiresAt` (odd units, clock skew
  or out-of-band refreshes must never brick the card) and reports "expired"
  only on a real 401/403 — with guidance to start a Claude Code **CLI** session
  (`claude` in a terminal), since the desktop app keeps its own login and may
  not refresh `~/.claude/.credentials.json`. Seconds-unit expiry stamps are
  now normalized too.

## v1.3.0

- **Official account meters (opt-in):** a new card shows Anthropic's own
  account-wide usage — 5-hour and weekly utilization with TRUE reset
  countdowns — via the same endpoint as Claude Code's `/usage`. Because
  Pro/Max limits are unified, the bars include claude.ai chats, browser-only
  cloud sessions, and other devices that local logs can never show. Off by
  default; toggle in the Server panel. The Claude OAuth token is read
  read-only, never logged, and sent only to api.anthropic.com (at most once
  a minute while the dashboard is open). Expired logins degrade to a
  re-login hint — Pulse never writes credentials.

## v1.2.2

- **Longer rolling windows:** the period dropdown now offers **Last 90 days**
  and **Last 180 days** alongside Last 30 — the whole spend section (chart,
  totals, by-model, by-source) re-scopes to the longer window. Chart axis
  labels and bar spacing adapt to the density. Reminder: Claude Code prunes
  transcripts after ~30 days by default — raise `cleanupPeriodDays` to keep
  long windows fully populated.

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
