#!/bin/bash
# Limit alerts: the summary payload flags every window at/above a warning
# threshold (Claude meters + Codex snapshot), sorted most-urgent-first, with
# provider-correct labels; thresholds are configurable and the feature disables.
# Also: the opt-in SPEND-ANOMALY alert — today far above the recent daily
# average — leads the list when enabled, honors its multiplier, stays off by
# default, and obeys the master alerts switch.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; CX=$TMP/codex; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$CX/sessions/2026/07/15" "$PH"
echo '{"claudeAiOauth":{"accessToken":"sk-test-oauth-token","expiresAt":9999999999999}}' > "$CL/.credentials.json"

# Spend history for the anomaly detector: 6 prior days at exactly $1/day
# (fable-5 $50/MTok out, 20k output = $1) and TODAY at $20 (400k output) —
# 20x the baseline, well past the default 3x and the $5 floor. All entries are
# pinned to LOCAL NOON via setHours/setDate so the fixture can never straddle
# a midnight or DST boundary between being written and being asserted.
node -e '
const fs = require("fs");
const base = new Date(); base.setHours(12, 0, 0, 0); // local noon today
const lines = [];
for (let d = 1; d <= 6; d++) {
  const dt = new Date(base); dt.setDate(dt.getDate() - d); // DST-safe day walk
  lines.push({ type: "assistant", timestamp: dt.toISOString(),
    sessionId: "sp" + d, requestId: "rp" + d, cwd: "/p",
    message: { id: "mp" + d, model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: 20000 } } });
}
lines.push({ type: "assistant", timestamp: base.toISOString(),
  sessionId: "st", requestId: "rt", cwd: "/p",
  message: { id: "mt", model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: 400000 } } });
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", lines.map(JSON.stringify).join("\n") + "\n");
' "$CL"

# Codex rollout: weekly window pinned at 90% (secondary, window_minutes 10080).
node -e '
const fs = require("fs"); const now = Date.now();
const iso = (ms) => new Date(ms).toISOString(); const ep = (ms) => Math.round(ms/1000);
fs.writeFileSync(process.argv[1] + "/sessions/2026/07/15/r.jsonl", [
  { timestamp: iso(now-20*60e3), type: "session_meta", payload: { session_id: "s", cwd: "/p" } },
  { timestamp: iso(now-10*60e3), type: "event_msg", payload: { type: "token_count",
    info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: 20 },
            total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: 20 } },
    rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_at: ep(now+3600e3) },
                   secondary: { used_percent: 90, window_minutes: 10080, resets_at: ep(now+5*86400e3) } } } },
].map(JSON.stringify).join("\n") + "\n");
' "$CX"

# inline meters mock: 5h 82%, weekly 96%, Opus 40%
node -e '
const http = require("http");
http.createServer((q, s) => {
  if (q.headers["authorization"] !== "Bearer sk-test-oauth-token") { s.writeHead(401); s.end("{}"); return; }
  s.writeHead(200, { "Content-Type": "application/json" });
  s.end(JSON.stringify({
    five_hour:      { utilization: 0.82, resets_at: new Date(Date.now()+2*3600e3).toISOString() },
    seven_day:      { utilization: 0.96, resets_at: new Date(Date.now()+3*86400e3).toISOString() },
    seven_day_opus: { utilization: 0.40, resets_at: new Date(Date.now()+3*86400e3).toISOString() },
    // model-scoped Fable weekly MAXED OUT — a reached limit, must be dropped
    // from the alerts banner (you have hit it, not approaching it).
    limits: [ { kind: "weekly_scoped", group: "g", percent: 100,
                resets_at: new Date(Date.now()+4*86400e3).toISOString(),
                scope: { model: { display_name: "Fable" } } } ],
  }));
}).listen(4877, "127.0.0.1", () => console.log("mock up"));
' >/dev/null 2>&1 &
MOCK=$!
sleep 0.4

PORT=4896
fetch() { # $1 config, $2 out
  echo "$1" > "$PH/config.json"
  PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$CX \
  PULSE_METERS_API=http://127.0.0.1:4877/usage PULSE_METERS_CACHE_MS=400 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
  local SRV=$!
  sleep 2
  for i in 1 2 3 4 5 6; do
    curl -s "http://127.0.0.1:$PORT/api/summary" > "$2"
    ST=$(node -e 'const s=require(process.argv[1]);console.log(s.meters&&s.meters.status||"")' "$2")
    [ "$ST" = "ok" ] && break
    sleep 0.6
  done
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
}

fetch '{"accountMeters": true}' "$TMP/def.json"
fetch '{"accountMeters": true, "alerts": false, "anomalyAlerts": true}' "$TMP/off.json"
fetch '{"accountMeters": true, "alertThresholds": [50]}' "$TMP/t50.json"
fetch '{"accountMeters": true, "anomalyAlerts": true}' "$TMP/anom.json"
fetch '{"accountMeters": true, "anomalyAlerts": true, "anomalyMultiplier": 25}' "$TMP/anom25.json"
kill $MOCK 2>/dev/null

node -e '
const fs = require("fs"); const TMP = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const A = require(TMP + "/def.json").alerts || [];
const by = {}; for (const a of A) by[a.key] = a;
ok(by["claude:seven_day"] && by["claude:seven_day"].threshold === 95, "weekly 96% -> alert at threshold 95");
ok(by["claude:five_hour"] && by["claude:five_hour"].threshold === 80, "5h 82% -> alert at threshold 80 (not 95)");
ok(!by["claude:seven_day_opus"], "Opus 40% -> no alert (below 80)");
ok(by["codex:codex_secondary"] && by["codex:codex_secondary"].threshold === 80 && by["codex:codex_secondary"].provider === "codex",
   "Codex weekly 90% -> alert, provider codex (" + JSON.stringify(by["codex:codex_secondary"] && {t:by["codex:codex_secondary"].threshold,p:by["codex:codex_secondary"].provider}) + ")");
ok(/^Claude · /.test((by["claude:seven_day"]||{}).label || "") && /^Codex · /.test((by["codex:codex_secondary"]||{}).label || ""), "labels carry provider prefix");
ok(A.length >= 3 && A[0].pct >= A[A.length-1].pct, "sorted most-urgent-first (" + A.map(a=>Math.round(a.pct)).join(">=") + ")");

// maxed-out windows are dropped from the banner (reached, not approaching).
const buckets = (require(TMP + "/def.json").meters || {}).buckets || [];
const fableBucket = buckets.find((b) => b.key === "model_scoped:fable");
ok(fableBucket && Math.round(fableBucket.pct) === 100, "Fable weekly meter IS present at 100% (bucket exists)");
ok(!by["claude:model_scoped:fable"], "Fable 100% -> NOT in alerts (a reached limit is dropped from the banner)");

// Spend anomaly: OFF by default (opt-in) even with today at 20x baseline.
ok(!A.some((a) => a.kind === "anomaly"), "anomaly absent without opt-in (20x day, default config)");
// Enabled: leads the list, correct ratio/threshold/key shape.
const AN = require(TMP + "/anom.json").alerts || [];
const an = AN[0];
ok(an && an.kind === "anomaly" && an.provider === "pulse", "anomaly on -> leads the alerts list");
ok(an && Math.abs(an.ratio - 20) < 0.5 && an.threshold === 3, "ratio ~20x at default multiplier 3 (got " + (an && an.ratio && an.ratio.toFixed(1)) + ")");
ok(an && /^pulse:anomaly:\d{4}-\d{2}-\d{2}$/.test(an.key) && /20\.\dx|20\.\d×/.test(an.detail || ""), "date-keyed, detail carries the ratio (" + (an && an.detail) + ")");
ok(an && Math.abs(an.todayCost - 20) < 0.01 && Math.abs(an.baseline - 1) < 0.01, "today $20 vs $1/day baseline");
// Multiplier honored: 20x < configured 25x -> silent.
const AM = require(TMP + "/anom25.json").alerts || [];
ok(!AM.some((a) => a.kind === "anomaly"), "anomalyMultiplier 25 -> 20x day stays silent");

const off = require(TMP + "/off.json").alerts;
ok(Array.isArray(off) && off.length === 0, "alerts:false master switch -> no alerts, even with anomalyAlerts on (" + (off && off.length) + ")");

const t50 = require(TMP + "/t50.json").alerts || [];
const by50 = {}; for (const a of t50) by50[a.key] = a;
ok(!by50["claude:seven_day_opus"], "threshold [50]: Opus 40% still below 50 -> no alert");
ok(by50["claude:five_hour"] && by50["claude:five_hour"].threshold === 50, "threshold [50]: 5h 82% -> alert at 50");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
