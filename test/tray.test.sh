#!/bin/bash
# Tray toggle endpoints + feed plumbing (cross-platform parts — the icon
# itself is Windows-only and manually verified):
# - payload.tray reports {supported, enabled}; enabled follows the config.
# - POST /api/tray/enable|disable writes the config and flips the state.
# - /api/statusline carries trayEnabled so a running tray can self-exit.
# - the endpoints are allowMutation-guarded (GET refused).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"
echo '{}' > "$PH/config.json"

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1] + "/projects/demo/s.jsonl", JSON.stringify({
  type: "assistant", timestamp: new Date().toISOString(), sessionId: "s", requestId: "r", cwd: "/p",
  message: { id: "m", model: "claude-fable-5", usage: { input_tokens: 0, output_tokens: 10000 } } }) + "\n");
' "$CL"

PORT=4887
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/nc PULSE_SUMMARY_MEMO_MS=0 PULSE_NO_TRAY_SPAWN=1 \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2.2

curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/before.json"
GETCODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/tray/enable")
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/tray/enable" > "$TMP/en.json"
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/on.json"
curl -s "http://127.0.0.1:$PORT/api/statusline" > "$TMP/sl-on.json"
curl -s -X POST -H 'X-Pulse: 1' "http://127.0.0.1:$PORT/api/tray/disable" > "$TMP/dis.json"
sleep 3.2
curl -s "http://127.0.0.1:$PORT/api/statusline" > "$TMP/sl-off.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

node -e '
const fs = require("fs"); const T = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const J = (f) => JSON.parse(fs.readFileSync(T + "/" + f, "utf8"));
const before = J("before.json");
ok(before.tray && before.tray.enabled === false && typeof before.tray.supported === "boolean",
   "payload.tray present, disabled by default (supported=" + before.tray.supported + ")");
ok(process.argv[2] === "403" || process.argv[2] === "404" || process.argv[2] === "405",
   "GET on the tray endpoint is refused (got " + process.argv[2] + ")");
ok(J("en.json").ok === true && J("en.json").tray.enabled === true, "POST enable -> enabled");
const cfg = JSON.parse(fs.readFileSync(process.argv[3] + "/config.json", "utf8"));
ok(cfg.tray === false, "config ends disabled after the disable call (persisted writes)");
ok(J("on.json").tray.enabled === true, "summary reflects enabled");
ok(J("sl-on.json").trayEnabled === true, "statusline carries trayEnabled:true while on");
ok(J("dis.json").tray.enabled === false, "POST disable -> disabled");
ok(J("sl-off.json").trayEnabled === false, "statusline flips to trayEnabled:false (tray self-exit signal)");
process.exit(fail);
' "$TMP" "$GETCODE" "$PH"
RES=$?
echo "---- exit $RES"
exit $RES
