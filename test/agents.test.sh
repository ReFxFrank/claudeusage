#!/bin/bash
# Other-agent ingestion: Gemini CLI, Continue, and Cline logs are read from
# their own on-disk formats, priced, and folded in as sources. Continue is
# flagged as an estimate; Cline's own recorded cost is used verbatim.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse
GEM=$TMP/gemini; CONT=$TMP/continue; CLINE=$TMP/cline-ext
mkdir -p "$CL/projects/demo" "$PH" \
  "$GEM/tmp/projABC/chats" \
  "$CONT/dev_data/0.1" \
  "$CLINE/tasks/task-001"

node -e '
const fs=require("fs"); const now=Date.now(); const iso=(m)=>new Date(now-m*60e3).toISOString();
const G=process.argv[1], C=process.argv[2], K=process.argv[3];

// --- Gemini CLI: session-*.jsonl, tokens object + model + id ---
// gemini-3-pro ($2/$12, cached 10%). input INCLUDES cached (1.0M, 0.2M cached),
// output 0.5M + thoughts 0.1M. -> in 0.8M, out 0.6M, cacheRead 0.2M.
// cost = 0.8*2 + 0.6*12 + 0.2*0.2 = 8.84 ; tokens = 1.6M
fs.writeFileSync(G+"/tmp/projABC/chats/session-1.jsonl", [
  { id:"g1", sessionId:"gsess", timestamp: iso(10), model:"gemini-3-pro",
    tokens:{ input:1000000, output:500000, cached:200000, thoughts:100000, tool:0, total:1600000 } },
  // an edited turn rewritten with the SAME id -> last write wins (not double counted)
  { id:"g1", sessionId:"gsess", timestamp: iso(9), model:"gemini-3-pro",
    tokens:{ input:1000000, output:500000, cached:200000, thoughts:100000, tool:0, total:1600000 } },
].map(JSON.stringify).join("\n")+"\n");

// --- Continue: dev_data/<ver>/tokensGenerated.jsonl (envelope form) ---
// gpt-5.6-sol ($5/$30). prompt 0.2M, generated 0.1M -> cost = 0.2*5 + 0.1*30 = 4.00 ; tokens 0.3M
fs.writeFileSync(C+"/dev_data/0.1/tokensGenerated.jsonl", [
  { name:"tokensGenerated", timestamp: iso(8),
    data:{ model:"gpt-5.6-sol", provider:"openai", promptTokens:200000, generatedTokens:100000 } },
].map(JSON.stringify).join("\n")+"\n");

// --- Cline: ui_messages.json + task_metadata.json ---
// recorded cost 2.34 (deliberately != what re-pricing opus would give ~3.13),
// tokens 150k/80k/20k(cacheW)/500k(cacheR) = 750k. model from task_metadata.
fs.writeFileSync(K+"/tasks/task-001/ui_messages.json", JSON.stringify([
  { type:"say", say:"text", ts: now-7*60e3, text:"hello" },
  { type:"say", say:"api_req_started", ts: now-6*60e3,
    text: JSON.stringify({ tokensIn:150000, tokensOut:80000, cacheWrites:20000, cacheReads:500000, cost:2.34 }) },
  // corrupt: out-of-range epoch (beyond JS Date range). MUST be skipped, never
  // crash the heatmap / 500 the whole dashboard.
  { type:"say", say:"api_req_started", ts: 1e16,
    text: JSON.stringify({ tokensIn:999999, tokensOut:0, cacheWrites:0, cacheReads:0, cost:99 }) },
]));
fs.writeFileSync(K+"/tasks/task-001/task_metadata.json", JSON.stringify({
  files_in_context: [],
  model_usage: [ { ts: now-8*60e3, model_id:"claude-opus-4-8", model_provider_id:"anthropic", mode:"act" } ],
}));

// A real Claude Code (cli) turn, recent so it opens the current 5h block:
// claude-fable-5 ($10/$50), output 100k -> cost $5.00. The 5h block must count
// ONLY this, never the agent sources above (they have their own limits).
fs.writeFileSync(process.argv[4]+"/projects/demo/s.jsonl", JSON.stringify({
  type:"assistant", timestamp: iso(3), sessionId:"cc1", requestId:"rr1", cwd:"/p",
  message:{ id:"mm1", model:"claude-fable-5", usage:{ input_tokens:0, output_tokens:100000 } } })+"\n");
' "$GEM" "$CONT" "$CLINE" "$CL"

PORT=4893
PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/no-codex \
GEMINI_DIR=$GEM CONTINUE_DIR=$CONT CLINE_DIR=$CLINE \
node "$ROOT/server.js" --port $PORT --no-update-check >"$TMP/srv.log" 2>&1 &
SRV=$!
sleep 2.5
curl -s "http://127.0.0.1:$PORT/api/summary" > "$TMP/out.json"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

node -e '
const s=require(process.argv[1]+"/out.json");
let fail=0; const ok=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c) fail=1;};
const near=(a,b)=>typeof a==="number"&&Math.abs(a-b)<0.01;
const src=s.allSources||[];
ok(["gemini","continue","cline"].every(x=>src.includes(x)), "all three sources present ("+src.join(",")+")");
ok(Array.isArray(s.estimatedSources)&&s.estimatedSources.length===1&&s.estimatedSources[0]==="continue",
   "estimatedSources = [continue] (got "+JSON.stringify(s.estimatedSources)+")");
// widest period that carries these sources
const per=(s.periods||[]).filter(p=>p.bySource&&p.bySource.gemini).sort((a,b)=>Object.keys(b.bySource).length-Object.keys(a.bySource).length)[0];
ok(!!per, "found a period with the agent sources ("+(per&&per.label)+")");
const bs=per?per.bySource:{}, bm=per?per.byModel:{};
ok(near(bs.gemini&&bs.gemini.cost,8.84), "gemini cost = 8.84 (got "+(bs.gemini&&bs.gemini.cost)+")");
ok(near(bs.continue&&bs.continue.cost,4.00), "continue cost = 4.00 (got "+(bs.continue&&bs.continue.cost)+")");
ok(near(bs.cline&&bs.cline.cost,2.34), "cline uses its OWN recorded cost 2.34, not re-priced (got "+(bs.cline&&bs.cline.cost)+")");
ok(bs.gemini&&bs.gemini.tokens===1600000, "gemini tokens 1.6M, dup id counted once (got "+(bs.gemini&&bs.gemini.tokens)+")");
ok(bs.cline&&bs.cline.tokens===750000, "cline tokens 750k (got "+(bs.cline&&bs.cline.tokens)+")");
ok(bm["gemini-3-pro"]&&near(bm["gemini-3-pro"].cost,8.84), "by-model gemini-3-pro priced via Google table");
ok(bm["gpt-5.6-sol"]&&near(bm["gpt-5.6-sol"].cost,4.00), "by-model gpt-5.6-sol (Continue) priced via OpenAI table");
ok(bm["claude-opus-4-8"]&&near(bm["claude-opus-4-8"].cost,2.34), "by-model opus (Cline) = recorded cost");
// no unknown-model pricing warnings for the agent models
const log=require("fs").readFileSync(process.argv[1]+"/srv.log","utf8");
ok(!/unknown model.*gemini-3-pro/i.test(log), "no unknown-model warning for gemini-3-pro");
// Claude 5h block counts ONLY Claude Code usage (the $5 cli turn), NOT the
// agent sources (gemini 8.84 / continue 4 / cline 2.34 on a Claude model).
const cb=s.currentBlock;
ok(cb && near(cb.cost,5.00), "5h block = Claude Code only ($5.00), agents excluded (got "+(cb&&cb.cost)+")");
ok(!s.selfCheck || !(s.selfCheck.issues||[]).some(x=>/block entries/.test(x)), "selfCheck: block-entry count matches (no agent leak)");
// corrupt Cline ts (1e16) must be skipped, not counted and not a 500:
ok(s.hasData===true && Array.isArray(s.periods), "summary served OK despite a corrupt Cline ts (no 500)");
ok(bs.cline && bs.cline.tokens===750000, "corrupt out-of-range Cline entry skipped (tokens still 750k, not +999999)");
ok(bs.cline && near(bs.cline.cost,2.34), "corrupt entry did not inflate cline cost (still 2.34)");
ok(s.heatmap && s.heatmap.grid && s.heatmap.grid.length===7, "heatmap built fine (bad ts guarded)");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
