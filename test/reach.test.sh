#!/bin/bash
# Community reach: Pulse sums release-asset download_count across ALL releases
# and reads the repo star count from PUBLIC GitHub data, exposes them as
# payload.reach, and honours the update-check opt-out (--no-update-check /
# {"updateCheck":false}). Nothing about the user is sent — this only GETs
# public counters.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
mkdir -p "$CL/projects/demo" "$PH"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/projects/demo/s.jsonl",JSON.stringify({type:"assistant",timestamp:"2026-07-15T10:00:00Z",sessionId:"s",requestId:"r",cwd:"/p",message:{id:"m",model:"claude-fable-5",usage:{input_tokens:1000,output_tokens:500}}})+"\n");' "$CL"

# Mock GitHub: /releases returns two releases (3 assets each, varied counts);
# /repo returns stargazers_count. Two paths on one server.
node -e '
const http = require("http");
const releases = [
  { tag_name: "v1.13.0", assets: [ {download_count:10}, {download_count:20}, {download_count:30} ] },
  { tag_name: "v1.12.2", assets: [ {download_count:5},  {download_count:1},  {download_count:0}  ] },
];
// total = 66
http.createServer((q, s) => {
  s.writeHead(200, { "Content-Type": "application/json" });
  if (q.url.indexOf("/releases") !== -1) return s.end(JSON.stringify(releases));
  return s.end(JSON.stringify({ stargazers_count: 123, full_name: "ReFxFrank/Pulse-Usage-Monitor" }));
}).listen(4885, "127.0.0.1", () => console.log("mock up"));
' >/dev/null 2>&1 &
MOCK=$!
sleep 0.4

fail=0
ok() { if [ "$1" = "1" ]; then echo "PASS  $2"; else echo "FAIL  $2"; fail=1; fi; }

run() { # $1 = extra config json (merged), $2 = out file, $3 = updateCheck flag ("" or "--no-update-check")
  echo "$1" > "$PH/config.json"
  PORT=4905
  PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/no-codex \
  PULSE_REACH_API=http://127.0.0.1:4885/repos/x/releases \
  PULSE_REACH_REPO_API=http://127.0.0.1:4885/repos/x \
  PULSE_REACH_CACHE_MS=300 \
  node "$ROOT/server.js" --port $PORT $3 >"$TMP/srv.log" 2>&1 &
  local SRV=$!
  sleep 2
  # reach fetch fires ~3.2s after listen; poll for it
  for i in 1 2 3 4 5 6 7 8; do
    curl -s "http://127.0.0.1:$PORT/api/summary" > "$2"
    HAS=$(node -e 'const s=require(process.argv[1]);console.log(s.reach?"y":"n")' "$2")
    [ "$HAS" = "y" ] && break
    sleep 0.6
  done
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
}

# default: update check ON (no flag) → reach fetched
run '{}' "$TMP/on.json" ""
# opt-out via flag → reach never fetched
run '{}' "$TMP/off_flag.json" "--no-update-check"
# opt-out via config → reach never fetched
run '{"updateCheck": false}' "$TMP/off_cfg.json" ""
kill $MOCK 2>/dev/null

node -e '
const TMP = process.argv[1];
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const on = require(TMP + "/on.json");
ok(on.reach && on.reach.downloads === 66, "sums download_count across all releases+assets (got " + (on.reach && on.reach.downloads) + ", want 66)");
ok(on.reach && on.reach.stars === 123, "reads repo stargazers_count (got " + (on.reach && on.reach.stars) + ")");
ok(on.reach && typeof on.reach.fetchedAt === "number" && on.reach.fetchedAt > 0, "stamps fetchedAt");
ok(on.reach && on.reach.repo === "ReFxFrank/Pulse-Usage-Monitor", "carries repo slug for the link (" + (on.reach && on.reach.repo) + ")");

const offFlag = require(TMP + "/off_flag.json");
ok(!offFlag.reach, "--no-update-check -> no reach fetch (reach absent)");
const offCfg = require(TMP + "/off_cfg.json");
ok(!offCfg.reach, "{updateCheck:false} -> no reach fetch (reach absent)");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
