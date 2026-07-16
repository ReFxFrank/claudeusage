# Changelog

## v1.6.0

- **Real account-wide token counts for Codex (opt-in):** the Account-limits
  card now shows your ChatGPT account's true token usage — today, past 7 days,
  lifetime, plus a 30-day daily mini-chart — fetched from the same endpoint
  that powers Codex's own usage chart. This covers every device, not just
  this machine's logs. Uses the ChatGPT login Codex already stores in
  `~/.codex/auth.json` (read-only, never logged, sent only to chatgpt.com),
  behind the same Account-meters switch as the Claude meters, polled once
  per 10 minutes with 429 backoff and expired-login handling. Consent stays
  explicit: the dashboard toggle enables both providers going forward, but a
  pre-existing meters opt-in (which named only api.anthropic.com) does NOT
  silently start the ChatGPT call — re-toggle once to add it.
- **Hardening (from an adversarial review of this feature):** a corrupted
  `~/.codex/auth.json` with header-invalid characters can no longer 500 the
  dashboard or wedge the fetch guard (sync throws inside fetches now route
  to the normal error path — this also hardens every other outbound call);
  malformed daily-bucket dates are dropped instead of polluting the 7/30-day
  sums; a brand-new account's empty stats read as "0 tokens", not an error;
  disabling meters mid-fetch can't resurrect cleared state.
- **Why there's no Claude equivalent:** Anthropic's usage API reports only
  utilization percentages — no token counts exist for individual accounts
  (verified against the endpoint schema; the token-denominated Admin API is
  organizations-only). The card says so honestly.

## v1.5.3

- **Pricing for the current Codex lineup:** added exact rows for
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`,
  `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro` and `gpt-5.3-codex` at
  OpenAI's July-2026 list prices, so these models stop falling back to
  default pricing (and stop warning in the server log). `codex-auto-review`
  — Codex's sandbox auto-reviewer, which runs GPT-5.4 — is priced at
  gpt-5.4 rates. Corrected the stale `gpt-5.6-sol` row ($1.25/$10 →
  $5/$30 per MTok); spend for Sol usage will read higher and more accurate
  after updating.

## v1.5.2

- **Per-model weekly meters (Fable & friends):** newer accounts report
  model-scoped weekly windows — the "Weekly · Fable" row in Claude Code's
  `/usage` panel — in a `limits[]` array instead of dedicated `seven_day_*`
  keys, so Pulse never showed them. The Account-limits card now renders every
  model-scoped weekly window the API emits ("Claude · weekly · Fable", …),
  deduplicated against the legacy keys, ordered 5-hour → overall weekly →
  scoped windows.

## v1.5.1

- **Codex meters no longer vanish at 100%:** when a window hits its limit,
  Codex can write a rate-limit snapshot without any `used_percent` fields;
  that newer-but-empty snapshot used to displace the last good one and the
  Codex rows disappeared from the Account-limits card right when they
  mattered most. Snapshots now only win if at least one window actually
  carries a parseable percentage.
- **Provider labels on every meter row:** with both providers on one card,
  rows now say whose limit they are — "Claude · 5-hour session",
  "Claude · weekly (all models)", "Codex · session (5h)", "Codex · weekly" —
  so a pinned Codex bar can't be mistaken for a Claude one (or vice versa).

## v1.5.0

- **The 5h-block tile syncs to Anthropic's official clock:** when account
  meters are enabled and report a live five-hour reset, the Current-5h-block
  window becomes [official reset − 5h → official reset] — the exact timer
  from /usage, covering usage on every device — with this machine's Claude
  cost/tokens scoped to that true window. A green "official" badge and a
  "synced to Anthropic's clock" footer mark the provenance; with meters off
  (or a stale reset) the tile falls back to the log-based reconstruction,
  labeled "reconstructed". The official reset keeps working during
  rate-limit backoffs — it's an absolute timestamp, not a countdown.

## v1.4.4

- **Account meters survive rate limiting (HTTP 429):** the card keeps showing
  your last good numbers with an honest age note ("showing numbers from 4m
  ago") instead of replacing them with an error. Pulse now honors the API's
  Retry-After header and otherwise backs off exponentially (10m doubling to
  1h) instead of retrying every minute; base polling relaxes to once per two
  minutes. Rate-limiting renders as a quiet note, not an alarm — and hints
  that something else on the machine (e.g. a statusline script) may be
  hammering the shared usage endpoint if it persists.

## v1.4.3

- **macOS account meters:** Claude Code stores its login in the macOS Keychain
  rather than a file — Pulse now reads it there too (via `/usr/bin/security`,
  asynchronously so a Keychain permission dialog can never block the server;
  results cached 5 minutes so the dialog never nags). Approve with "Always
  Allow" once and the Claude meters work on Macs out of the gate.
- **Codex-only machines:** the "no Claude Code login" state now renders as a
  neutral note with platform-appropriate guidance instead of an alarming
  macOS-flavored warning on every OS.

## v1.4.2

- **Effort chips redesigned — every level unique:** one heat ramp across both
  providers (minimal · dashed → low · teal → medium · blue → high · violet →
  xhigh · amber → max · red) plus two signature gradients: Claude's ultracode
  keeps its warm violet→pink→amber ULTRA, and Codex's ultra gets an equally
  premium cool green→blue→violet ULTRA. The fast chip moves to its own cyan.
  Sort order now covers minimal and ultra.

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
