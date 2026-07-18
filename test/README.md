# Pulse e2e tests

Each suite starts the REAL server against fixture homes in a temp dir
(fake transcripts, rollouts, and credentials — never real ones) plus mock
provider endpoints from `mocks/`, then asserts on `/api/summary` and, for
Discord, on the raw IPC frames the mock receives.

```
bash test/run-all.sh          # everything (Node >= 18 + curl, localhost only)
bash test/discord.test.sh     # one suite
```

| Suite | Covers |
|---|---|
| `meters.test.sh` | Claude account meters (labels, `limits[]` model-scoped rows, dedup, order) + Codex meters surviving at-limit snapshots |
| `pricing.test.sh` | Exact OpenAI list-price rows for the current Codex lineup; no unknown-model warnings |
| `codex-usage.test.sh` | ChatGPT account token usage: happy path, 401→expired, no-login, zero-usage=ok, corrupt auth.json (no 500, no wedge), legacy-consent gate, no token leakage into logs |
| `discord.test.sh` | Rich Presence: handshake, rotating pages, single-line activity, clear-on-disable, shipped default app ID, Discord-not-running degradation |
| `effort-echo.test.sh` | Effort chips from picker confirmation echoes; anti-forgery (quoted words in prompts) |
| `history.test.sh` | Retention: sealing past days (never today), non-shrinking re-seal, per-cell recovery of a pruned cell, dedup (no double count), window scoping, `history:false` disable |
| `statusline.test.sh` | `--statusline`: server-fed enrichment (today/5h/meter %), server-down fail-open, `NO_COLOR`, single line, always exit 0 |
| `analytics.test.sh` | Per-period spend by effort level (incl. ultracode/default) and by project (sorted by cost, session counts, `liveCost`) |
| `model-families.test.sh` | Model-string → provider-family classifier (Anthropic/OpenAI/Google/DeepSeek/GLM/Meta/xAI/Qwen/Mistral/Cohere/other) + family metadata |
| `meters-polling.test.sh` | Polling discipline: dashboard drives the usage-endpoint refresh; status line / Discord only trickle it (counting mock verifies no background polling) |
| `alerts.test.sh` | Limit alerts: Claude meters + Codex snapshot windows at/above a threshold are flagged, sorted most-urgent-first, provider-labelled; thresholds configurable; `alerts:false` disables |
| `heatmap.test.sh` | Activity heatmap: entries land in the right weekday×hour cell (local time), cells sum cost/tokens/messages, max tracking correct |
| `reach.test.sh` | Community reach: sums release-asset `download_count` across all releases + reads repo `stargazers_count` from public GitHub, exposes `payload.reach`, honours the update-check opt-out (flag + config) |

Conventions when adding tests: fixture homes via `mktemp -d` + `CLAUDE_DIR` /
`CODEX_DIR` / `PULSE_HOME` env; per-suite fixed port; fake tokens only, with
an assertion that they never appear in server logs; `PASS`/`FAIL` lines and a
non-zero exit on failure.
