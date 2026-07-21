#!/bin/bash
# Meter burn-rate projection + summary memo + memory stat:
# - "~% left at reset": with rising utilization across meter refreshes, each
#   bucket gains projLeftAtReset (a straight-line projection), strictly less
#   than the current % left; a bucket with no reset time gets null.
# - unfiltered summary payloads are memoized ~2.5s (same generatedAt), and a
#   config write busts the memo immediately.
# - payload.memory carries rss/heapUsed for the Server panel.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"
echo '{"claudeAiOauth":{"accessToken":"sk-test-oauth-token","expiresAt":9999999999999}}' > "$CL/.credentials.json"
echo '{"accountMeters": true}' > "$PH/config.json"

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", JSON.stringify({
  type: "assistant", timestamp: new Date().toISOString(), sessionId: "s", requestId: "r", cwd: "/p",
  message: { id: "m", model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: 100000 } } }) + "\n");
' "$CL"

# Stateful meters mock: five_hour RISES fast (2%/fetch, resets in 2h) — its
# extrapolation saturates to 0 left. seven_day has NO resets_at -> never
# projects. seven_day_opus rises SLOWLY (0.1%/fetch) against a PINNED reset
# 60s out — its projection must land in a computable band, which pins the
# slope units (a pct-per-ms vs pct-per-s bug lands wildly outside it).
node -e '
const http = require("http");
let n = 0;
const opusReset = new Date(Date.now() + 60e3).toISOString(); // pinned once
http.createServer((q, s) => {
  n++;
  s.writeHead(200, { "Content-Type": "application/json" });
  s.end(JSON.stringify({
    five_hour: { utilization: 0.50 + n * 0.02, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() },
    seven_day: { utilization: 0.30 + n * 0.01 },
    seven_day_opus: { utilization: 0.40 + n * 0.002, resets_at: opusReset },
  }));
}).listen(4885, "127.0.0.1", () => console.log("mock up"));
' >/dev/null 2>&1 &
MOCK=$!
sleep 0.4

PORT=4904
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc \
PULSE_METERS_API=http://127.0.0.1:4885/usage PULSE_METERS_CACHE_MS=300 \
PULSE_METER_PROJ_MIN_MS=800 \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2

# Memo probe: two summaries 200ms apart must be the SAME build.
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/m1.json"; sleep 0.2
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/m2.json"

# Config write busts the memo: set a budget, refetch immediately.
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/budget/set?amount=50&period=month" >/dev/null
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/m3.json"

# Drive several meter refreshes spaced past the memo TTL so the sample span
# exceeds PULSE_METER_PROJ_MIN_MS, then read the projection.
for i in 1 2 3 4; do sleep 2.7; curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/proj.json"; done
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
kill $MOCK 2>/dev/null

node -e '
const fs = require("fs"); const T = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const m1 = JSON.parse(fs.readFileSync(T + "/m1.json")), m2 = JSON.parse(fs.readFileSync(T + "/m2.json"));
const m3 = JSON.parse(fs.readFileSync(T + "/m3.json"));
ok(m1.generatedAt === m2.generatedAt, "rapid summaries share one memoized build (same generatedAt)");
ok(m3.budget && m3.budget.target === 50, "config write busts the memo (budget visible immediately)");
ok(m1.memory && m1.memory.rss > 0 && m1.memory.heapUsed > 0, "payload.memory reports rss + heapUsed");

const P = JSON.parse(fs.readFileSync(T + "/proj.json"));
const buckets = (P.meters && P.meters.buckets) || [];
const fh = buckets.find((b) => b.key === "five_hour");
const wk = buckets.find((b) => b.key === "seven_day");
const op = buckets.find((b) => b.key === "seven_day_opus");
ok(fh && typeof fh.projLeftAtReset === "number", "rising 5h burn -> projLeftAtReset present (got " + (fh && fh.projLeftAtReset) + ")");
ok(fh && fh.projLeftAtReset < (100 - fh.pct), "projection is BELOW current % left (burning up the window)");
ok(fh && fh.projLeftAtReset >= 0, "projection clamped at 0");
ok(wk && wk.projLeftAtReset == null, "bucket without resets_at never projects");
// Slow burner vs a 60s-out reset: ~0.08 pct/s over the remaining ~45s adds a
// few pct, so the projection must land in a computable band AND measurably
// below the current % left — a pct/ms unit error slams it to 0, a flat/sign
// error leaves it at (100 - pct) ~ 58-59.
ok(op && typeof op.projLeftAtReset === "number" && op.projLeftAtReset >= 46 && op.projLeftAtReset <= 57,
   "slow burn lands in the computable band 46-57 (got " + (op && op.projLeftAtReset) + ")");
ok(op && op.projLeftAtReset < (100 - op.pct) - 1.5,
   "slow-burn projection sits clearly below the current % left (" + (op && op.projLeftAtReset) + " vs " + (op && (100 - op.pct).toFixed(1)) + ")");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
