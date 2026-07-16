#!/bin/bash
# Discord Rich Presence e2e via mock IPC socket.
# A: handshake + rotating SET_ACTIVITY pages (Today / Past 7 days / All-time).
# B: disable endpoint clears the activity (activity: null).
# C: no client id configured -> shipped default works out of the box.
# D: discord not running -> status discord-not-found, server unaffected.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
IPC=$TMP/dipc/discord-ipc-0
DLOG=$TMP/discord-frames.log
mkdir -p "$CL/projects/demo" "$PH"
echo '{"discordPresence": true, "discordClientId": "123456789012345678"}' > "$PH/config.json"

node -e '
const fs = require("fs"); const now = Date.now();
const iso = (m) => new Date(now - m * 60e3).toISOString();
const lines = [
  // recent (within the 15-min active window) so the active provider is Claude
  { type: "user", timestamp: iso(6), sessionId: "s1", cwd: "/p", message: { role: "user", content: "hello" } },
  { type: "assistant", timestamp: iso(5), sessionId: "s1", requestId: "r1", cwd: "/p",
    message: { id: "m1", model: "claude-fable-5", usage: { input_tokens: 500000, output_tokens: 250000 } } },
];
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", lines.map(JSON.stringify).join("\n") + "\n");
' "$CL"

node "$ROOT/test/mocks/mock-discord.js" "$IPC" "$DLOG" & MOCK=$!
sleep 0.5

PORT=4886
start_pulse() {
  CLAUDE_DIR=$CL PULSE_HOME=$PH CODEX_DIR=$TMP/no-codex \
  PULSE_DISCORD_IPC="$1" PULSE_DISCORD_TICK_MS=400 PULSE_DISCORD_ROTATE_MS=900 \
  node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
  SRV=$!
  sleep 2.5
}

# --- A: connect + publish (rotation: 0.9s pages, 0.4s ticks -> all 3 pages)
start_pulse "$IPC"
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/a.json"
sleep 3
# --- B: disable clears
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/discord/disable" > "$TMP/b.json"
sleep 0.7
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

# --- C: no client id -> shipped default kicks in, works out of the box
echo '{"discordPresence": true}' > "$PH/config.json"
start_pulse "$IPC"
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/c.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

# --- D: discord not running
echo '{"discordPresence": true, "discordClientId": "123456789012345678"}' > "$PH/config.json"
start_pulse "$TMP/dipc/nonexistent-sock"
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/d.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
kill $MOCK 2>/dev/null

node -e '
const fs = require("fs");
const SP = process.argv[1];
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fail = 1; };

const frames = fs.readFileSync(SP + "/discord-frames.log", "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const hs = frames.find((f) => f.op === 0);
ok(hs && hs.payload.v === 1 && hs.payload.client_id === "123456789012345678", "A: handshake with configured client id");
const acts = frames.filter((f) => f.op === 1 && f.payload.cmd === "SET_ACTIVITY");
ok(acts.length >= 1, "A: SET_ACTIVITY sent (" + acts.length + " frame(s))");
const a = acts[0] && acts[0].payload.args;
ok(a && a.pid > 0, "A: pid present");
const act = a && a.activity;
const detailSet = new Set(acts.filter((f) => f.payload.args.activity).map((f) => f.payload.args.activity.details.split(":")[0]));
ok(detailSet.has("Today") && detailSet.has("Past 7 days") && detailSet.has("All-time"),
   "A: rotation cycles Today / Past 7 days / All-time (saw: " + Array.from(detailSet).join(", ") + ")");
ok(act && /^(Today|Past 7 days|All-time): 750K tokens · \$17\.50$/.test(act.details), "A: page format label: tokens · spend (" + (act && act.details) + ")");
const anySessions = acts.some((f) => f.payload.args.activity && JSON.stringify(f.payload.args.activity).includes("sessions"));
ok(!anySessions, "A: session count removed everywhere");
const anyState = acts.some((f) => f.payload.args.activity && f.payload.args.activity.state !== undefined);
ok(!anyState, "A: no meters line — activity is always single-line");
const anyMeters = acts.some((f) => f.payload.args.activity && /5h|wk \d|%/.test(JSON.stringify(f.payload.args.activity)));
ok(!anyMeters, "A: no 5h/weekly text anywhere in the activity");
ok(act && act.buttons && act.buttons[0].url.includes("github.com/ReFxFrank"), "A: Get Pulse button");
ok(act && act.timestamps && act.timestamps.start > 0, "A: elapsed timestamp (continuous across pages)");
const A = require(SP + "/a.json").discord;
ok(A && A.enabled && A.status === "ok", "A: payload.discord.status ok (" + (A && A.status) + ")");
// provider logo: recent Claude activity -> claude art + "Using Claude Code"
ok(require(SP + "/a.json").activeProvider === "claude", "A: activeProvider = claude (recent Claude entry)");
ok(act && act.assets && act.assets.large_image === "claude" && act.assets.large_text === "Using Claude Code",
   "A: large logo tracks provider (img=" + (act && act.assets && act.assets.large_image) + ", text=" + (act && act.assets && act.assets.large_text) + ")");

const clear = acts.find((f) => f.payload.args.activity === null);
ok(!!clear, "B: disable sent SET_ACTIVITY(null) to clear presence");
const B = require(SP + "/b.json").discord;
ok(B && B.enabled === false, "B: disable response shows off");

const C = require(SP + "/c.json").discord;
ok(C && C.status === "ok", "C: NO config id -> shipped default works out of the box (" + (C && C.status) + ")");
const defaultHs = frames.filter((f) => f.op === 0).find((f) => f.payload.client_id === "1527236432375189535");
ok(!!defaultHs, "C: handshake used the shipped default application ID");

const D = require(SP + "/d.json").discord;
ok(D && (D.status === "discord-not-found" || D.status === "connecting"), "D: no Discord -> " + (D && D.status));
const dlog = fs.readFileSync(SP + "/srv.log", "utf8");
ok(/listening: http/.test(dlog), "D: server unaffected by missing Discord");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
