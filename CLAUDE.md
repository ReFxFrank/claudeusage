# CLAUDE.md — working notes for agents on this repo

Pulse is a **local, zero-runtime-dependency usage dashboard** for Claude Code
and OpenAI Codex (plus Gemini CLI, Continue, and Cline, read from their own
local logs). One Node server file + a prebuilt React frontend, shipped as
single-file executables. Owner: frank (ReFxFrank). Repo was renamed
`claudeusage` → `Pulse-Usage-Monitor` (session tooling may still address it by
the old name; git remotes redirect).

## Hard rules — never break these

1. **Read-only sources:** Pulse only ever READS `~/.claude` and `~/.codex`.
   Never write, move, or delete anything under those trees.
2. **Zero runtime dependencies:** `server.js` uses Node ≥ 18 builtins only.
   The React toolchain (web/) is build-time only. Don't add npm deps to the
   server, ever. New protocols get hand-rolled (see the Discord IPC client).
3. **`~/.pulse` is the ONLY writable location** (config, logs, effort sidecar).
4. **Binds 127.0.0.1** by default; all state-changing endpoints require
   POST + `X-Pulse: 1` + loopback + Host allowlist (`allowMutation`), and all
   GET /api routes have a DNS-rebinding guard (`allowRead`).
5. **Credentials:** OAuth tokens are read read-only, never logged, never in
   payloads, and sent ONLY to their own provider's endpoint. Sync throws in
   `fetchUrl` are routed to callbacks (corrupt cred files must never 500).
6. **Network calls, exhaustively:** GitHub version check + community-reach
   counters (both opt-out, same `updateCheck` gate, public data only),
   api.anthropic.com + chatgpt.com meters (opt-in), Discord local socket
   (opt-in, not network). Usage data never leaves the machine — the reach
   counters are PUBLIC GitHub numbers read IN, never anything sent OUT.

## Layout

- `server.js` — everything: parsers, pricing, aggregation, meters, Discord
  presence, self-update, daemon mode, HTTP server. ~4500 lines, organized in
  ALL-CAPS banner sections; grep for `---` banners to navigate.
- `web/` — Vite + React (Radix, framer-motion) frontend; `web/dist` is
  committed (the server serves it; the SEA build embeds it).
- `build/make-exe.mjs` — Node SEA single-executable build (postject); errors
  if `PULSE_VERSION` ≠ package.json version.
- `.github/workflows/release.yml` — 3-OS matrix (win/linux/mac arm64) via
  `workflow_dispatch` with a `tag` input (tag pushes are blocked by the proxy
  in remote sessions — always dispatch, don't push tags).
- `test/` — self-contained e2e suites + mock provider servers. `bash
  test/run-all.sh` runs everything (needs only Node + curl; no real logins).

## Feature map (where things live in server.js)

| Feature | Key functions / constants |
|---|---|
| Claude transcript parsing | `parseFile`, `normalize`, `dedupKey`, mtime `fileCache` |
| Codex rollout parsing | `parseCodexFile` (token_count deltas, `turn_context` model+effort, replay-safe keys, `preModelEntries` backfill) |
| Other-agent parsing | `parseGeminiFile` (`~/.gemini/tmp/*/chats/session-*.jsonl`; `tokens{input(incl cached),output,cached,thoughts,tool}`+`model`; dedup by id last-write-wins; provider `google`/source `gemini`), `parseContinueFile` (`~/.continue/dev_data/*/tokensGenerated.jsonl`; camelCase, `{name,timestamp,data}` envelope; LOCAL ESTIMATES → `estimate:true`; dedup by path+lineIndex; provider inferred from model), `parseClineFile` (VS Code `globalStorage/saoudrizwan.claude-dev/tasks/*/ui_messages.json`; `api_req_started.text` is stringified JSON `{tokensIn,tokensOut,cacheWrites,cacheReads,cost}`; uses Cline's OWN `cost`; model from sibling `task_metadata.json` `model_usage` state-snapshot, else `unknown`), Roo Code = same function w/ `source='roo'` (Cline fork, same layout; ext ids `rooveterinaryinc.roo-cline` + `.roo-code`, `rooExtensionDirs`/`rooTaskFiles`, `ROO_DIR` override; trusts Roo's recorded cost; model precedence ROO-ONLY record-level `modelId` > metadata timeline > `unknown` — the record probe is deliberately not applied to Cline; precise Roo model state is in a SQLite DB Pulse deliberately doesn't read); `agentEntry` skeleton; `taskFilesUnder`/`vscodeGlobalStorageBases` (Code/Insiders/VSCodium/Cursor/Windsurf + `.vscode-server`); all dispatched by set-membership in `parseAll` |
| Pricing | `PRICING` (Anthropic + Zhipu/Z.ai `glm-*`, which arrive via Claude Code's Z.ai Anthropic-compatible proxy and price through the Claude path w/ longest-prefix match), `PRICING_OPENAI` (exact rows; prefix fallback ONLY for date suffixes — OpenAI `-mini`/`-pro` are different models), `PRICING_GOOGLE` (`priceForGoogle`, longest-prefix but fallback ONLY for snapshot suffixes — `-preview`/`-latest`/`-exp`/`-thinking` + optional date/build stamp, or a bare `-001`-style stamp; a tier/modality remainder like `-lite` or `-preview-tts` falls to the LOGGED default, never the parent tier's rate; cached=10% of input; July 2026 Gemini rates); `costForEntry` dispatches `openai`→OpenAI, `google`→Google, else Claude path; unknown models log once + `__default__` |
| Effort chips | `parseLocalCommand`, `parseEffortStdout` (interactive-picker confirmation echoes), `mergeModes`, `annotateModes` (state-snapshot join: latest event ≤ entry.ts; `parseEffort` is the immutable Codex-side input); CLI: `--effort-setup` (`effortSetup`) PRINTS (never writes) a Claude Code settings.json hook snippet, `--mode-hook` (`runModeHook`) is that hook — writes the settings-persisted effort level to the `~/.pulse` modes sidecar (covers the cross-session case transcript parsing can't; still never writes under `~/.claude`) |
| Analytics breakdowns | `buildPeriod` also emits per-period `effortSpend` (bucket = ultracode\|level\|default), `byProject` (top 30 by cost + `(other)`), `liveCost` — all LIVE-only (archive keeps no per-entry effort/project); UI: `EffortSpendBars`/`ProjectBars` (panels.jsx) |
| Period comparison | each period carries `prev` = `{cost,tokens,messages}` for the immediately-preceding equal-length window (rolling: the N days before; month: prior calendar month), via the `windowTotals` closure in `aggregate` (reuses `buildPeriod` so the prev baseline merges live+archive identically to a period's own cost; month prev just references the prior month's already-built period); UI: `PeriodDelta` chip on the Spend header (App.jsx), hidden when `prev.cost<=0` |
| Budget goal | `computeBudget(periods, week, now)` → `payload.budget` = `{target,period,label,spent,pct,remaining,resetsAt,state,projected}` (state ok\|warn≥80\|over≥100 on ACTUAL spend; `projected` = straight-line month-end pace `spent/elapsedFraction`, null for week budgets — a rolling window has no end to project to — and null in the first ~half day of a month); month = current calendar-month period cost (resets 1st), week = trailing-7d `week.cost` (rolling); config `budget`+`budgetPeriod`, set via POST `/api/budget/set?amount&period` (allowMutation; amount≤0 clears); UI: `BudgetCard` (panels.jsx, settable inline; "on pace for ~$X" line, amber ≥80% of target / red > target) |
| CSV/JSON export | GET `/api/export` (allowRead-guarded like every read; same `?sources=` scoping as summary) — `format=json` → full payload w/ attachment headers; `format=csv&data=daily\|models\|sources\|projects\|sessions&period=<key>` → `exportCsv` (RFC-4180 via `csvCell`/`csvTable`, CRLF, UTF-8 BOM, cost 4dp via `csvMoney`; daily = per-source cost columns; sessions = recentSessions, NOT period-scoped; unknown data → 400); UI: `ExportMenu` (App.jsx, plain same-origin GET links w/ `download`, carries active period + source filter) |
| 5h block | `aggregate` — official window from meters `five_hour.resets_at` when available (`official: true`), else log reconstruction |
| Historical retention | `sealHistory` (writes sealed past days → `~/.pulse/history/YYYY-MM.json`, gated 5 min, re-seals until pruned), `readHistory` (mtime-cached), `filterHistory`; merged in `aggregate`/`buildPeriod` — live day wins, archive fills gaps (never double-counts); augments `totals`; on by default (`{"history": false}` off) |
| Claude account meters (opt-in) | `refreshAccountMeters`, `parseMeterBucket`, `METER_LABELS` (provider-prefixed), `limits[]` array → model-scoped weekly rows (`kind === 'weekly_scoped'`, `scope.model.display_name`, e.g. Fable), 429 backoff + last-good retention, macOS Keychain via `readOauthTokenAsync`; refresh is DASHBOARD-driven — `metersForPayload(background)`/`buildSummary(_, {background})` make the status line & Discord only trickle it (`BACKGROUND_METERS_MS` 15m) so Pulse doesn't 24/7-poll the shared endpoint. Pulse only ever READS the token (never mints/refreshes one — no OAuth in Pulse); `no-login`/`expired`-without-bars render a `ConnectClaude` card (meters.jsx) whose **Recheck now** hits POST `/api/meters/recheck` (allowMutation) → clears `credCache` + backoff + re-fetches, so a fresh Claude Code login is picked up with no restart |
| Codex meters (automatic, local) | `codexMetersFromSnapshot` — newest rollout `rate_limits` snapshot; a snapshot only wins if a window has finite `used_percent` (at-limit snapshots can be empty) |
| Codex account tokens (opt-in) | `refreshCodexUsage` — GET chatgpt.com/backend-api/wham/profiles/me with `~/.codex/auth.json` token + `ChatGPT-Account-Id` header → `stats.{lifetime_tokens, peak_daily_tokens, daily_usage_buckets}`; `normalizeCodexUsage` (date-validated buckets, empty-stats = ok-with-zero) |
| Discord Rich Presence (opt-in) | `discordConnect` (hand-rolled IPC: 8-byte LE header + JSON over named pipe / unix socket, candidates incl. snap/flatpak), `buildDiscordActivity` (rotating pages Today / Past 7 days / All-time, wall-clock derived; large_image tracks `payload.activeProvider` — claude/codex art keys, else pulse), `DISCORD_CLIENT_ID_DEFAULT` = the official Pulse app (public identifier); reconnect is resilient — `discordIpcCandidates` tries both Windows pipe forms (`\\.\pipe\` + `\\?\pipe\`), `net.connect` is try/caught, and a failed sweep does fast re-sweeps (`DISCORD_FAST_RETRY_MS` 4s, `discordNotFoundStreak` ≤4 via a one-shot timer) before backing off to `DISCORD_RETRY_MS` 30s, so a Pulse-restart-while-Discord-runs race heals in seconds; elapsed-timer anchor (`discordPresenceStart`) PERSISTED to `~/.pulse/discord-presence.json` so a self-update relaunch (`IS_AFTER_UPDATE`) or brief restart (heartbeat < `DISCORD_START_GRACE_MS` 10m) CONTINUES the timer instead of resetting to 0; long-gap cold start resets |
| Self-update | `checkForUpdate`, `installUpdate` — sha256 digest fail-closed, rename swap + rollback, no downgrades |
| Community reach | `refreshReach`/`reachForPayload` → `payload.reach` = `{downloads, stars, fetchedAt, repo}` from PUBLIC GitHub only (sum of every release's asset `download_count` + repo `stargazers_count`); last-good retention per counter; scheduled beside `checkForUpdate` (startup + 6h) and gated by the SAME opt-out (`updateCheck`/`--no-update-check`); 6h cache (`PULSE_REACH_CACHE_MS`), endpoints overridable (`PULSE_REACH_API`, `PULSE_REACH_REPO_API`); NOT a phone-home — nothing about the user is sent; UI: `.reachpill` in the header (App.jsx) |
| Windows daemon | `--daemon-child`, `windowsHide`, `~/.pulse/pulse.log`, `--stop`, `--install-shortcuts` |
| Status line | `--statusline` (reads Claude Code's stdin JSON, fetches slim `/api/statusline` from the running server via `~/.pulse/server.json` port, prints an ANSI line; fail-open, always exit 0), `statuslineData`/`statuslineMemo` (3s), `--statusline-setup` prints the settings.json snippet (never writes `~/.claude`); `NO_COLOR` respected |
| Limit alerts | `computeAlerts(meters, codexMeters)` → `payload.alerts` (both Claude buckets + Codex snapshot buckets ≥ lowest threshold, deduped by `provider:key`, provider-labelled, sorted most-urgent-first, skips `stale`; **drops maxed windows** — rounded pct ≥ 100 is a reached limit, not "approaching", so it's excluded from the banner + notifications though it still shows in the meter gauges); `alertsEnabled()` (`{"alerts": false}` off), `alertThresholds()` (config `alertThresholds`, default `[80,95]`); **spend anomaly (opt-in)**: `computeSpendAnomaly(periods, now)` unshifted onto alerts — fires when today ≥ multiplier × mean of ACTIVE prior days in last30 (≥5 active days, today ≥ $5); config `anomalyAlerts === true` + `anomalyMultiplier` (default 3, floor 1.5); row has `kind:'anomaly'`, `detail`, `ratio`, pct null, date-keyed `pulse:anomaly:YYYY-MM-DD` so notifications fire once/day; UI: `AlertsBar` (panels.jsx — anomaly rows render `detail`, headline "Unusual spend —" when anomaly-only) + browser notifications in lib.js (`fireAlertNotifications` dedups via `localStorage` key `pulse-alerted`, alertKey `key\|threshold\|resetsAt`; anomaly body uses `detail`) |
| Activity heatmap | `aggregate` builds `payload.heatmap` = `{grid:[7][24]{cost,tokens,messages}, maxCost, maxMessages}` from `asc` entries via local `getDay()`/`getHours()`; LIVE-only (archive keeps no per-hour detail); UI: `Heatmap` (panels.jsx), gated on `heatmap.maxCost > 0` |
| Mini side overview | hash route `#mini`: `MiniOverview` (web/src/mini.jsx) renders Claude/Codex meter buckets as "% left" bars (`100 - pct`, hot/warm coloring by USED pct, stale rows dimmed, `~N% left at reset` line when `projLeftAtReset` present) + `MiniDonut` (SVG stroke segments, per-source colors via `makeColorMap`) with Today\|Yesterday\|30-Days tabs (day buckets from last30.daily) + Today/Yesterday/30d stat rows + `MiniTrend` daily bars; App.jsx hashchange listener + `◧ mini` header button (`window.open` 340×760 popup); degrades to hints when meters are off/no-login/expired; Spend label follows `payload.sourceFilter`; solid surfaces only (lite-safe) |
| Meter burn projection | `recordMeterSamples` (on each meters refresh; per-key ring buffer, 2h window, clears on pct DROP = window rolled) + `projectedLeftAtReset` (straight-line slope over ≥ `PULSE_METER_PROJ_MIN_MS` (default 10m) of samples → `projLeftAtReset` per bucket in `metersForPayload`, null without resetsAt/enough data; `Math.max(0, slope)` so a falling trend never projects a refill) |
| Windows tray (opt-in) | `--tray` flag, config `tray: true`, or the Server-panel toggle (POST `/api/tray/enable\|disable`, allowMutation; enable spawns immediately, disable flips `trayEnabled` in the statusline feed and the tray self-exits ≤30s) → `startTray(port)` (win32 + loopback; `PULSE_NO_TRAY_SPAWN` test hook): writes `trayScript(port)` to `~/.pulse/tray.ps1`, spawns detached hidden powershell w/ `child.on('error')` (NotifyIcon; named mutex `PulseTray<port>`; **live badge** — 5h used-% painted on the icon via GetHicon + P/Invoke DestroyIcon per repaint, green/amber≥60/red≥85/`!`≥100, base app icon when meters off; tooltip today $ + 5h/wk %; left-click + menu open `#mini` as an Edge `--app` window 380×800 w/ browser fallback; first paint immediate; self-exits after 6 failed polls or Stop). `payload.tray = {supported, enabled}` gates the UI toggle |
| Memory footprint | `intern()` pool (capped 50k) for model/source/speed/serviceTier/sessionId/project in `normalize` + `agentEntry` (JSON.parse allocates fresh strings per occurrence); entries no longer retain messageId/requestId (folded into `key` at parse); `summaryMemo` (`SUMMARY_MEMO_MS` 2.5s, unfiltered builds only, busted by `writeConfig`); `payload.memory` = `{rss, heapUsed}` → Server-panel "memory" fact. Measured 205→128 MB on a 50k-entry fixture |

## Config (`~/.pulse/config.json`) and env overrides

Config keys: `accountMeters`, `codexAccountUsage` (separate consent — the
dashboard toggle sets both, a pre-1.6.0 `accountMeters` alone must NOT enable
the chatgpt.com call), `discordPresence`, `discordClientId`,
`discordRotateSecs` (15–300), `discordLargeImage` (idle/fallback art key) +
`discordClaudeImage`/`discordCodexImage` (per-provider large_image overrides),
`history` (retention; on
unless `false`), `alerts` (limit alerts; on unless `false`), `alertThresholds`
(array of pct 1–100; default `[80,95]`), `anomalyAlerts` (spend-anomaly alert;
opt-in, `=== true` only) + `anomalyMultiplier` (trigger ratio; default 3, floor
1.5), `budget` (USD spend target; unset =
off) + `budgetPeriod` (`month`|`week`, default month; set via `/api/budget/set`),
`tray` (Windows notification-area icon; also `--tray`) + `trayStyle`
(`icon` default \| `strip` — a pill PARENTED INTO `Shell_TrayWnd` via
SetParent+WS_CHILD so it hides/moves with the taskbar (fullscreen apps, auto-hide);
`trayStripScript`: SetProcessDPIAware + dpi scale `$k` for all pixel sizes,
Explorer-restart resilience via relaunch-unless-`wantExit`, float fallback
hides while a fullscreen window is foreground, drag persists
`{mode:'taskbar', right}` \| `{mode:'float', x, y}` to `~/.pulse/tray-strip.json`;
style switches hand off via statusline `trayStyle` mismatch → relaunch; enable
route accepts `?style=`), `updateCheck`.

Test/dev env hooks: `PULSE_HOME`, `CLAUDE_DIR`/`CLAUDE_CONFIG_DIR`,
`CODEX_DIR`/`CODEX_HOME`, `GEMINI_DIR`/`GEMINI_CLI_HOME`,
`CONTINUE_DIR`/`CONTINUE_GLOBAL_DIR`, `CLINE_DIR`, `ROO_DIR`, `PULSE_HISTORY_DIR`, `PULSE_REACH_API`,
`PULSE_REACH_REPO_API`, `PULSE_REACH_CACHE_MS`, `PULSE_METERS_API`,
`PULSE_METERS_CACHE_MS`, `PULSE_CODEX_USAGE_API`, `PULSE_CODEX_USAGE_CACHE_MS`,
`PULSE_DISCORD_IPC`, `PULSE_DISCORD_TICK_MS`, `PULSE_DISCORD_ROTATE_MS`,
`PULSE_DISCORD_CLIENT_ID`, `PULSE_MODES_FILE`, `PULSE_FAKE_DARWIN`,
`PULSE_METER_PROJ_MIN_MS`, `PULSE_SUMMARY_MEMO_MS` (0 disables the memo — timing-sensitive suites),
`PULSE_UPDATE_API` (update-check endpoint override), `PULSE_NO_UPDATE_CHECK`
(env form of `--no-update-check`), `PULSE_UPDATE_NO_RELAUNCH` (test hook),
`PULSE_SECURITY_BIN` (macOS Keychain `security` binary override).

## Release process (established, do not improvise)

1. Bump BOTH version strings: `package.json` `version` AND `PULSE_VERSION` in
   `server.js` (make-exe errors on drift). Add a CHANGELOG.md entry.
2. `npm run build` (rebuilds web/dist), `node -c server.js`,
   `bash test/run-all.sh`.
3. Commit to `main`, push (`git push -u origin main`, retry w/ backoff on
   network errors). `main` is the default branch.
4. Dispatch the release: GitHub Actions `release.yml` on ref `main` with
   input `{"tag": "vX.Y.Z"}` (in remote sessions use the GitHub MCP
   `actions_run_trigger`; repo param may need the old name `claudeusage`).
5. Wait ~3–4 min, then verify via the release-by-tag API: all THREE assets
   (pulse.exe, pulse-linux, pulse-macos) uploaded with sha256 digests.

## Testing conventions

- Everything is tested e2e against the real server with fixture homes in a
  temp dir + env overrides + mock provider endpoints (`test/mocks/`): fake
  transcripts/rollouts, fake `.credentials.json` / `auth.json` (never real
  ones), mock Anthropic/ChatGPT/Discord servers on localhost.
- Never read real credentials, and never let a fake token string appear in
  server logs (there's an assertion for that).
- UI checks when needed: Playwright with the preinstalled Chromium
  (`executablePath: '/opt/pw-browsers/chromium'`, `--no-sandbox`).
- For risky/major features: adversarial review (independent finder lenses →
  verify each finding against the real code) has repeatedly found real bugs —
  fix confirmed findings before release.

## Domain knowledge worth keeping

- `/effort` is session-only, never persisted; bare `/effort` opens a picker
  whose chosen level appears ONLY in the `<local-command-stdout>` echo.
- Anthropic's usage API exposes **percentages only** — no token counts exist
  for individual accounts (Admin API is org-only). Codex's
  `/wham/profiles/me` DOES expose real account-wide token counts.
- Codex at 100% utilization can write `rate_limits` snapshots with no
  `used_percent` fields.
- OpenAI prices (July 2026): gpt-5.6 sol $5/$30, terra $2.50/$15, luna $1/$6;
  gpt-5.5 $5/$30; gpt-5.4 $2.50/$15 (mini $0.75/$4.50); gpt-5.3-codex
  $1.75/$14; `codex-auto-review` runs GPT-5.4. Cached input ≈ 10% of input.
- Claude Code prunes transcripts after ~30 days (`cleanupPeriodDays`) — long
  windows need users to raise it.
- The frontend has a lite-graphics mode (software-rendering detection) —
  avoid `backdrop-filter` and permanent animations in new UI.
- Model-family recognition lives in `web/src/model-families.js` (pure
  classifier + `FAMILY_META`, unit-tested) and `web/src/logos.jsx` (SVG marks);
  it only classifies models that reach Pulse.
- Other-agent ingestion (v1.14.0; Roo Code added v1.18.0): Gemini CLI,
  Continue, Cline, and Roo are read from their own local logs and folded in as
  sources (see the Other-agent parsing row). Feasibility gate = JSON/JSONL +
  default-on + Node-builtin-readable.
  Reverse-engineered format specifics worth remembering: Gemini `input`
  INCLUDES `cached`; Continue numbers are LOCAL ESTIMATES (badged `est`), not
  provider billing; Cline's `text` is double-encoded JSON and it records its own
  `cost` (trust it); Roo shares Cline's task layout (it's a fork) and also
  records its own cost — the per-request model id is `modelId` on the record
  when present, else task metadata, else a coarse `unknown` (Roo's exact model
  state lives in a SQLite DB we deliberately don't read). NOT feasible under
  the zero-dep rule (all SQLite-only):
  **Crush** (`crush.db`), **Goose** (`sessions.db`, v1.10+), **opencode** (v1.16+
  switched JSON→SQLite; only ≤1.15 was JSON). **Aider**'s exact per-call tokens
  need its `--analytics-log` opt-in (default history is rounded markdown).
  Adding the SQLite-only agents later
  means shipping a SQLite reader or raising the Node floor — deliberately not
  done.
