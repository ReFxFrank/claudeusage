# Changelog

## v1.13.0

- **Community reach on the dashboard:** a small header pill shows how far Pulse
  has spread — total release downloads and GitHub stars — pulled from GitHub's
  **public** API. This is the privacy-preserving version of a "who's using Pulse
  now" counter: **nothing about you is sent**, there's no backend and no
  phone-home. It rides the *same* network call and opt-out as the update check
  (`--no-update-check` / `{"updateCheck": false}` turns it off too) and is
  cached for hours, so it never approaches GitHub's rate limit.
- **By-model / by-source bars now say what they measure:** a caption — *"bar
  length = spend · numbers show $ · tokens"* — makes explicit that the bar
  encodes **spend**, not tokens. Previously a low-token but costly model (or the
  reverse) could look mis-sized next to its own numbers; the bars were always
  correct (sorted and sized by cost), this just removes the ambiguity.

## v1.12.2

- **Limit alerts drop maxed-out windows:** a window that's already at 100% is a
  limit you've *hit*, not one you're *approaching* — so it no longer appears in
  the alerts banner (and stops firing "approaching" desktop notifications). This
  keeps a reached limit from sitting stacked next to windows that are genuinely
  creeping up. The window still shows, at 100%, in the Account-limits gauges;
  it's only removed from the warning banner. (Supersedes v1.12.1's "Limit
  reached" wording, which is no longer reachable.)

## v1.12.1

- **Limit-alerts wording at 100%:** when the most-urgent window is maxed out the
  banner now reads **"Limit reached —"** instead of "Approaching a limit —"
  (you're not *approaching* a limit you've already hit). The headline follows
  the worst window shown, so it stays consistent with the percentages listed.

## v1.12.0

- **Limit alerts:** Pulse now flags every usage window that crosses a warning
  threshold — Claude account meters (5-hour, weekly, model-scoped weekly like
  Opus/Fable) *and* Codex rate-limit snapshots — in an amber banner at the top
  of the dashboard, most-urgent first, each labelled with its provider and reset
  time. Because the Claude meters are account-wide, this covers all your
  surfaces (Claude Code, claude.ai, Cowork, every device), not just this
  machine. Optional **desktop notifications**: click *Enable desktop alerts*
  once and Pulse fires a browser notification when a new window crosses a
  threshold (de-duplicated per threshold+reset, so you're not re-pinged for the
  same event). Thresholds default to 80% and 95% and are configurable via
  `alertThresholds` in `~/.pulse/config.json`; set `"alerts": false` to turn the
  whole feature off.
- **"When you work" activity heatmap:** a 7×24 grid (day-of-week × hour, your
  local time) shaded by spend, so you can see at a glance when your usage
  actually happens. Hover any cell for its exact cost, tokens, and message
  count. Live data only (the historical archive keeps no per-hour detail); the
  panel hides itself until there's something to show.

## v1.11.2

- **Meters stop background-polling the usage endpoint (fewer HTTP 429s):** the
  account-meters refresh used to fire from *any* summary build — including the
  status line (invoked constantly by Claude Code) and the Discord tick — so
  Pulse hit Anthropic's shared, rate-limited `/usage` endpoint every ~2 minutes
  around the clock even with the dashboard closed. Now the dashboard drives the
  refresh at the normal cadence while background consumers only **trickle** it
  (at most every 15 minutes), cutting Pulse's background footprint on that
  endpoint by ~7×. The same trickle applies to the Codex token-usage call
  (chatgpt.com). Meters still refresh promptly whenever the dashboard is open;
  the status line shows the last-known figures between dashboard views.

## v1.11.1

- **Zhipu / Z.ai GLM support:** GLM is commonly driven *through* Claude Code via
  Z.ai's Anthropic-compatible endpoint, so `glm-*` model ids already land in the
  `~/.claude` logs Pulse reads. Pulse now recognizes them — a Z.ai hexagon mark
  and "Z.ai GLM" label in the By-model list and Recent sessions — and prices
  them at Z.ai list rates (GLM-5/5.1/5.2, GLM-4.7/4.6/4.5 and the -air/-airx/-x/
  -flash/-v variants), so GLM usage stops falling back to default pricing.
  Longest-prefix matching keeps the variants distinct (`glm-4.5-air` ≠
  `glm-4.5` ≠ `glm-4.5-x`).

## v1.11.0

- **Model-family recognition — provider logos on every model:** each model now
  shows a small provider mark (Anthropic, OpenAI, Google, DeepSeek, Meta, xAI,
  Qwen, Mistral, Cohere, plus a generic fallback) in the **By model** list and
  the **Recent sessions** table, colored and labeled by family. Marks are simple
  original glyphs in brand colors — no heavyweight assets — and a family only
  ever appears when one of its models is actually in your logs. The classifier
  is unit-tested (`test/model-families.test.sh`).
  - Note: this recognizes any model that reaches Pulse. Seeing usage from other
    agent CLIs (Gemini CLI, Cursor, Aider, …) still requires ingesting their own
    logs — a separate, per-tool step.

## v1.10.1

- **Discord logo follows what you're using:** the large presence image now
  switches to Claude's logo while you're actively using Claude Code, Codex's
  while you're on Codex, and the Pulse logo when idle (no activity in the last
  15 minutes). Upload art keyed `claude` / `codex` / `pulse` under your Discord
  app's Rich Presence assets (overridable via `discordClaudeImage` /
  `discordCodexImage` / `discordLargeImage`); a missing key just shows no image.
  The summary payload gains `activeProvider` (`claude` | `codex` | null).

## v1.10.0

- **Spend by effort and by project:** the spend section gains two breakdowns
  that re-scope with the selected window. **By effort** groups your spend by the
  reasoning-effort level in force — `low → max`, `ultracode`, or `default` when
  none was set — with bars colored to match the effort chips, so you can finally
  see what ultracode actually costs versus plain runs. **By project** groups by
  working directory (folder name shown, full path on hover), top 30 by cost with
  the long tail folded into “(other)”. Both are computed from sessions still in
  your logs (the long-window archive keeps day/model totals, not per-entry
  effort or project) and each carries a `liveCost` so the coverage is honest.

## v1.9.0

- **Status line for Claude Code:** a compact line via `pulse --statusline` —
  `◉ Opus · ctx 25% · today $4.20 · 5h $1.10 2h24m · wk 41%`. Model and
  context come from Claude Code's own status-line payload; today's cross-tool
  spend, the current 5-hour block, and the official meter percentages come
  from the running Pulse server over loopback. Because the server is the
  single throttled poller, the line reflects **all** your usage (cli +
  desktop + Codex) and never calls a provider endpoint itself — so it can't
  add to the rate-limit pressure a naive per-render `/usage` call would. Runs
  in a few ms (the feed is memoized), respects `NO_COLOR`, and is fail-open:
  with Pulse stopped it still shows model + context, and it always exits
  cleanly so a status-line error can never blank the row. `pulse
  --statusline-setup` prints the settings.json snippet to paste (Pulse never
  writes under `~/.claude`).

## v1.8.0

- **Durable history — long windows survive log pruning:** Claude Code deletes
  transcripts after ~30 days (`cleanupPeriodDays`), which used to blank the
  90/180-day views and understate all-time totals for older data. Pulse now
  archives each sealed (fully past) day's totals — cost/tokens/messages per
  day, source and model — to `~/.pulse/history` (one small JSON file per
  month), and merges them back into the spend chart, by-model/by-source
  rollups, month entries, and all-time totals. Writes only to `~/.pulse`;
  sources stay strictly read-only. On by default — disable with
  `{"history": false}`; the Server panel shows how many days are archived.
- **Merge is per (day, source, model) cell.** Because `~/.claude` and
  `~/.codex` prune independently (and Claude prunes per session file), a single
  past day can go *partial* in the live logs while the archive still holds the
  pruned parts. Pulse keeps, for every cell, the more-complete of the live and
  archived observation — so a day is never undercounted, a re-seal never
  shrinks an already-archived day, and nothing double-counts. Month files are
  written atomically (temp + rename) so a crash can't corrupt them. Hardened
  after an adversarial review that caught a partial-prune undercount; the
  recovery, non-shrinking re-seal, dedup, and disable cases are covered by
  `test/history.test.sh`.

## v1.7.3

- **Cleaner presence:** removed the 5-hour/weekly meter line from the Discord
  activity — it's now a single rotating line (Today / Past 7 days / All-time
  tokens + spend), nothing else.

## v1.7.2

- **Rotating presence pages:** instead of cramming every number into two
  lines, the Discord activity now alternates — "Today: 80.0M tokens · $136" →
  "Past 7 days: …" → "All-time: …" — flipping every 45 s (configurable
  15–300 s via `discordRotateSecs`). Elapsed time stays continuous across
  pages. With account meters on, the second line carries the live windows
  ("Claude 5h 38% · wk 67% · Codex wk 71%"); session count is gone.

## v1.7.1

- **Discord presence now works out of the box:** Pulse ships with the official
  Pulse Discord application ID built in, so enabling Rich Presence is a single
  click in the Server panel — no registration, no config. (Application IDs are
  public identifiers; every rich-presence tool ships one.) Your own app can
  still be used instead via `discordClientId` in `~/.pulse/config.json`.

## v1.7.0

- **Discord Rich Presence (opt-in):** show your usage as a Discord activity —
  "Today 1.2M tokens · $4.20" / "All-time 812M tokens · $904 · 61 sessions",
  live window meters in the hover text, elapsed time, and a "Get Pulse"
  button. Pulse speaks the Discord desktop client's local IPC socket directly
  (named pipe on Windows, Unix socket elsewhere — snap/flatpak paths
  included): no SDK, zero new dependencies, and no network traffic from Pulse.
  Setup: create a free Discord application, drop its ID in
  `~/.pulse/config.json` (`discordClientId`), and flip **Discord presence**
  in the Server panel. Off by default — presence is visible to anyone who can
  see your profile, so it's a deliberate choice. Updates at most every 15 s
  and only when the numbers change; reconnects automatically when Discord
  restarts; disabling clears the activity instantly.

## v1.6.1

- **Effort chips from the interactive `/effort` picker:** typing bare
  `/effort` (the default in the desktop app) opens a level picker, and the
  transcript's command record then carries **no arguments** — so Pulse saw
  nothing and the session showed a "–" where the effort chip belonged. The
  chosen level does appear in the CLI's confirmation echo ("Set effort level
  to high (this session only)…"), which Pulse now parses: picker selections,
  "Kept effort level as …", and "… set to auto" (clears the chip) all count.
  Retroactive — existing sessions gain their chips on the next refresh.
  Only CLI-written stdout is matched, anchored, so quoting those words in a
  prompt can't forge a chip.

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
