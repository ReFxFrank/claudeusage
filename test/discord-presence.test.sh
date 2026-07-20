#!/bin/bash
# Discord presence elapsed-timer anchor persists across restarts so a self-update
# relaunch doesn't reset "Pulse for 3h" back to 0.
#   1. recent heartbeat  -> reuse the saved anchor (brief manual restart)
#   2. stale heartbeat    -> reset to a fresh anchor (long gap; no misleading age)
#   3. --after-update      -> reuse even a stale anchor (the update case)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude
mkdir -p "$CL/projects/demo"
node -e '
const fs=require("fs"); const now=Date.now(); const iso=(m)=>new Date(now-m*60e3).toISOString();
fs.writeFileSync(process.argv[1]+"/projects/demo/s.jsonl",[
  {type:"assistant",timestamp:iso(5),sessionId:"s1",requestId:"r1",cwd:"/p",
   message:{id:"m1",model:"claude-fable-5",usage:{input_tokens:500000,output_tokens:250000}}},
].map(JSON.stringify).join("\n")+"\n");
' "$CL"

# OLD anchor = 3h ago; a fresh anchor is ~now (>> OLD). Emit both for asserts.
read OLD FLOOR <<<"$(node -e 'const n=Date.now();process.stdout.write((n-3*3600e3)+" "+(n-5*60e3))')"

PORT=4890
run_case() { # $1=PH  $2=logfile  $3=ipc  $4=extra-server-flags
  node "$ROOT/test/mocks/mock-discord.js" "$3" "$2" & local MOCK=$!
  sleep 0.4
  CLAUDE_DIR=$CL PULSE_HOME=$1 CODEX_DIR=$TMP/no-codex \
  PULSE_DISCORD_IPC="$3" PULSE_DISCORD_TICK_MS=400 PULSE_DISCORD_ROTATE_MS=900 \
  node "$ROOT/server.js" --port $PORT --no-update-check $4 >"$1/srv.log" 2>&1 &
  local SRV=$!
  sleep 2.5
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  kill $MOCK 2>/dev/null; wait $MOCK 2>/dev/null
}

seed() { # $1=PH  $2=savedAtOffsetMs (0 = now)
  mkdir -p "$1"
  echo '{"discordPresence": true, "discordClientId": "123456789012345678"}' > "$1/config.json"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1]+"/discord-presence.json",JSON.stringify({start:Number(process.argv[2]),savedAt:Date.now()-Number(process.argv[3])}))' "$1" "$OLD" "$2"
}

# Windows: named pipes instead of unix-socket paths (see discord.test.sh).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) I1='\\.\pipe\pulse-dp-'$$'-1'; I2='\\.\pipe\pulse-dp-'$$'-2'; I3='\\.\pipe\pulse-dp-'$$'-3' ;;
  *)                    I1=$TMP/ipc1;                  I2=$TMP/ipc2;                  I3=$TMP/ipc3 ;;
esac

# 1: recent heartbeat -> reuse OLD
PH1=$TMP/ph1; seed "$PH1" 0;            run_case "$PH1" "$TMP/f1.log" "$I1" ""
# 2: stale heartbeat (30m > 10m grace), normal start -> reset (fresh, not OLD)
PH2=$TMP/ph2; seed "$PH2" $((30*60000)); run_case "$PH2" "$TMP/f2.log" "$I2" ""
# 3: stale heartbeat but --after-update -> reuse OLD anyway
PH3=$TMP/ph3; seed "$PH3" $((30*60000)); run_case "$PH3" "$TMP/f3.log" "$I3" "--after-update"

node -e '
const fs=require("fs"); const TMP=process.argv[1], OLD=Number(process.argv[2]), FLOOR=Number(process.argv[3]);
let fail=0; const ok=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c) fail=1;};
const startOf=(log)=>{
  const frames=fs.readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const act=frames.filter(f=>f.op===1&&f.payload.cmd==="SET_ACTIVITY"&&f.payload.args.activity).map(f=>f.payload.args.activity)[0];
  return act && act.timestamps && act.timestamps.start;
};
const s1=startOf(TMP+"/f1.log"), s2=startOf(TMP+"/f2.log"), s3=startOf(TMP+"/f3.log");
ok(s1===OLD, "recent heartbeat -> reuses saved anchor (got "+s1+", want "+OLD+")");
ok(s2 && s2!==OLD && s2>=FLOOR, "stale + normal restart -> fresh anchor, not the old age (got "+s2+", floor "+FLOOR+")");
ok(s3===OLD, "--after-update -> reuses anchor even when stale (got "+s3+", want "+OLD+")");
// the reused/fresh anchor is persisted back for the next relaunch
const p1=JSON.parse(fs.readFileSync(TMP+"/ph1/discord-presence.json","utf8"));
ok(p1.start===OLD, "anchor re-persisted after reuse (start="+p1.start+")");
process.exit(fail);
' "$TMP" "$OLD" "$FLOOR"
RES=$?
echo "---- exit $RES"
exit $RES
