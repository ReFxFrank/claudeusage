# CLAUDE.md — working notes for agents on this repo

Pulse is a **local, zero-runtime-dependency usage dashboard** for Claude Code
and OpenAI Codex. One Node server file + a prebuilt React frontend, shipped as
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
6. **Network calls, exhaustively:** GitHub version check (opt-out),
   api.anthropic.com + chatgpt.com meters (opt-in), Discord local socket
   (opt-in, not network). Usage data never leaves the machine.

## Layout

- `server.js` — everything: parsers, pricing, aggregation, meters, Discord
  presence, self-update, daemon mode, HTTP server. ~3000 lines, organized in
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
| Pricing | `PRICING` (Anthropic), `PRICING_OPENAI` (exact rows; prefix fallback ONLY for date suffixes — OpenAI `-mini`/`-pro` are different models), unknown models log once + `__default__` |
| Effort chips | `parseLocalCommand`, `parseEffortStdout` (interactive-picker confirmation echoes), `mergeModes`, `annotateModes` (state-snapshot join: latest event ≤ entry.ts; `parseEffort` is the immutable Codex-side input) |
| Analytics breakdowns | `buildPeriod` also emits per-period `effortSpend` (bucket = ultracode\|level\|default), `byProject` (top 30 by cost + `(other)`), `liveCost` — all LIVE-only (archive keeps no per-entry effort/project); UI: `EffortSpendBars`/`ProjectBars` (panels.jsx) |
| 5h block | `aggregate` — official window from meters `five_hour.resets_at` when available (`official: true`), else log reconstruction |
| Historical retention | `sealHistory` (writes sealed past days → `~/.pulse/history/YYYY-MM.json`, gated 5 min, re-seals until pruned), `readHistory` (mtime-cached), `filterHistory`; merged in `aggregate`/`buildPeriod` — live day wins, archive fills gaps (never double-counts); augments `totals`; on by default (`{"history": false}` off) |
| Claude account meters (opt-in) | `refreshAccountMeters`, `parseMeterBucket`, `METER_LABELS` (provider-prefixed), `limits[]` array → model-scoped weekly rows (`kind === 'weekly_scoped'`, `scope.model.display_name`, e.g. Fable), 429 backoff + last-good retention, macOS Keychain via `readOauthTokenAsync` |
| Codex meters (automatic, local) | `codexMetersFromSnapshot` — newest rollout `rate_limits` snapshot; a snapshot only wins if a window has finite `used_percent` (at-limit snapshots can be empty) |
| Codex account tokens (opt-in) | `refreshCodexUsage` — GET chatgpt.com/backend-api/wham/profiles/me with `~/.codex/auth.json` token + `ChatGPT-Account-Id` header → `stats.{lifetime_tokens, peak_daily_tokens, daily_usage_buckets}`; `normalizeCodexUsage` (date-validated buckets, empty-stats = ok-with-zero) |
| Discord Rich Presence (opt-in) | `discordConnect` (hand-rolled IPC: 8-byte LE header + JSON over named pipe / unix socket, candidates incl. snap/flatpak), `buildDiscordActivity` (rotating pages Today / Past 7 days / All-time, wall-clock derived; large_image tracks `payload.activeProvider` — claude/codex art keys, else pulse), `DISCORD_CLIENT_ID_DEFAULT` = the official Pulse app (public identifier) |
| Self-update | `checkForUpdate`, `installUpdate` — sha256 digest fail-closed, rename swap + rollback, no downgrades |
| Windows daemon | `--daemon-child`, `windowsHide`, `~/.pulse/pulse.log`, `--stop`, `--install-shortcuts` |
| Status line | `--statusline` (reads Claude Code's stdin JSON, fetches slim `/api/statusline` from the running server via `~/.pulse/server.json` port, prints an ANSI line; fail-open, always exit 0), `statuslineData`/`statuslineMemo` (3s), `--statusline-setup` prints the settings.json snippet (never writes `~/.claude`); `NO_COLOR` respected |

## Config (`~/.pulse/config.json`) and env overrides

Config keys: `accountMeters`, `codexAccountUsage` (separate consent — the
dashboard toggle sets both, a pre-1.6.0 `accountMeters` alone must NOT enable
the chatgpt.com call), `discordPresence`, `discordClientId`,
`discordRotateSecs` (15–300), `discordLargeImage`, `history` (retention; on
unless `false`), `updateCheck`.

Test/dev env hooks: `PULSE_HOME`, `CLAUDE_DIR`/`CLAUDE_CONFIG_DIR`,
`CODEX_DIR`/`CODEX_HOME`, `PULSE_HISTORY_DIR`, `PULSE_METERS_API`,
`PULSE_METERS_CACHE_MS`, `PULSE_CODEX_USAGE_API`, `PULSE_CODEX_USAGE_CACHE_MS`,
`PULSE_DISCORD_IPC`, `PULSE_DISCORD_TICK_MS`, `PULSE_DISCORD_ROTATE_MS`,
`PULSE_DISCORD_CLIENT_ID`, `PULSE_MODES_FILE`, `PULSE_FAKE_DARWIN`.

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
  it only classifies models that reach Pulse. Ingesting other agent CLIs
  (Gemini CLI, Cursor, Aider) is a separate, un-started effort — each needs its
  own on-disk log format reverse-engineered against a real sample file.
