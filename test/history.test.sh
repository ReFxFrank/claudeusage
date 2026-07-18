#!/bin/bash
# Historical retention e2e (per-cell merge — hardened after adversarial review):
#  - sealing writes sealed (past) days to ~/.pulse/history, never today
#  - PER-CELL recovery: a day partial in the live logs (one model/provider
#    pruned) is completed from the archive — the CORE fix for independent prune
#    windows (~/.claude vs ~/.codex, per-session-file mtime pruning)
#  - NON-SHRINKING re-seal: re-sealing that day from the now-partial live logs
#    must NOT erase the still-archived pruned cell
#  - a day in BOTH live and archive (same cell) counts ONCE (no double count)
#  - archived-only days reappear in the long windows + all-time totals
#  - window scoping: a 120-day-old archived day is in 180d, not in 90d
#  - {"history": false} disables sealing and merging
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CL=$TMP/claude; PH=$TMP/pulse; HIST=$PH/history
mkdir -p "$CL/projects/demo" "$HIST"

node -e '
const fs = require("fs");
const [CL, HIST] = [process.argv[1], process.argv[2]];
const now = Date.now();
const dayMs = 86400e3;
const ds = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
const mk = (dstr) => dstr.slice(0, 7);
const at = (days, h) => now - days * dayMs + (h || 0) * 3600e3;
const A = (ms, sid, id, model, inTok, outTok) => ({ type: "assistant", timestamp: new Date(ms).toISOString(),
  sessionId: sid, requestId: "r" + id, cwd: "/p",
  message: { id: "m" + id, model, usage: { input_tokens: inTok, output_tokens: outTok } } });
const FAB = "claude-fable-5", OPUS = "claude-opus-4-8";
// live entries (source defaults to "cli"): today 150k (FAB); H=40d 500k (FAB);
// F=50d 100k (FAB only — its OPUS usage has been pruned from the live logs).
// "earlier today", but anchored to local midnight and clamped to now so it
// can never slip into yesterday when the test runs just after midnight (which
// sealHistory would correctly seal, failing the "never seal today" check) or
// land in the future (which the <= now aggregation guards would drop).
const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
const tToday = Math.min(now, startToday.getTime() + 2 * 3600e3), tH = at(40), tF = at(50);
fs.writeFileSync(CL + "/projects/demo/s.jsonl", [
  A(tToday, "s-today", 1, FAB, 100000, 50000),
  A(tH, "s-H", 2, FAB, 300000, 200000),
  A(tF, "s-F", 3, FAB, 60000, 40000),
].map(JSON.stringify).join("\n") + "\n");
const dToday = ds(tToday), dH = ds(tH), dF = ds(tF), dE = ds(at(120));
const seed = {};
const put = (dstr, rec) => { (seed[mk(dstr)] = seed[mk(dstr)] || {})[dstr] = rec; };
// H: archive == live (dedup must count once)
put(dH, { rows: [{ source: "cli", model: FAB, cost: 9, tokens: 500000, messages: 1 }], sessions: 1 });
// F: FAB cell == live; OPUS cell archive-ONLY (pruned) -> per-cell merge = 100k+300k
put(dF, { rows: [
  { source: "cli", model: FAB,  cost: 2, tokens: 100000, messages: 1 },
  { source: "cli", model: OPUS, cost: 8, tokens: 300000, messages: 2 },
], sessions: 2 });
// E: 120 days ago, archive-only
put(dE, { rows: [{ source: "cli", model: FAB, cost: 7, tokens: 700000, messages: 5 }], sessions: 3 });
for (const m of Object.keys(seed)) fs.writeFileSync(HIST + "/" + m + ".json", JSON.stringify(seed[m]));
fs.writeFileSync(process.argv[3], JSON.stringify({ dToday, dH, dF, dE, mkF: mk(dF) }));
' "$CL" "$HIST" "$TMP/dates.json"

run() { # $1 config json, $2 out file
  echo "$1" > "$PH/config.json"
  PULSE_HOME=$PH CLAUDE_DIR=$CL CODEX_DIR=$TMP/no-codex \
  node "$ROOT/server.js" --port 4887 --no-update-check >"$TMP/srv.log" 2>&1 &
  local SRV=$!
  sleep 2.5
  curl -s "http://127.0.0.1:4887/api/summary" > "$2"
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
}

run '{}' "$TMP/on.json"
cp -r "$HIST" "$TMP/hist-after"   # snapshot the re-sealed files
run '{"history": false}' "$TMP/off.json"

node -e '
const fs = require("fs");
const TMP = process.argv[1];
const D = JSON.parse(fs.readFileSync(TMP + "/dates.json", "utf8"));
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) fail = 1; };
const period = (s, key) => (s.periods || []).find((p) => p.key === key);
const bucket = (p, date) => p && p.daily.find((b) => b.date === date);

const on = JSON.parse(fs.readFileSync(TMP + "/on.json", "utf8"));
const p90 = period(on, "last90"), p180 = period(on, "last180");

// core per-cell recovery: F is partial in live (FAB 100k), archive has the
// pruned OPUS (300k) -> merged day = 400k
const bF = bucket(p90, D.dF);
ok(bF && bF.tokens === 400000, "PER-CELL: day-F = live FAB 100k + archived OPUS 300k = 400k (got " + (bF && bF.tokens) + ")");
ok(p90 && p90.byModel["claude-opus-4-8"] && p90.byModel["claude-opus-4-8"].tokens === 300000,
   "PER-CELL: pruned OPUS recovered into by-model (got " + (p90 && p90.byModel["claude-opus-4-8"] && p90.byModel["claude-opus-4-8"].tokens) + ")");

// dedup: H present in both live and archive (same cell) counts once
const bH = bucket(p90, D.dH);
ok(bH && bH.tokens === 500000, "DEDUP: day-H (live==archive) counted once = 500k (got " + (bH && bH.tokens) + ")");

// window totals + scoping
ok(p90 && p90.tokens === 1050000, "90d tokens = today 150k + H 500k + F 400k = 1.05M (got " + (p90 && p90.tokens) + ")");
ok(!bucket(p90, D.dE), "90d excludes 120-day-old archived day E");
const bE = bucket(p180, D.dE);
ok(bE && bE.tokens === 700000, "180d day-E from archive = 700k (got " + (bE && bE.tokens) + ")");
ok(p180 && p180.tokens === 1750000, "180d tokens = 1.05M + archived E 700k = 1.75M (got " + (p180 && p180.tokens) + ")");
ok(on.totals.tokens === 1750000, "all-time totals (per-cell) = 1.75M (got " + on.totals.tokens + ")");

// non-shrinking re-seal: after the run, F must STILL carry the OPUS cell
let fRec = null;
for (const f of fs.readdirSync(TMP + "/hist-after").filter((x) => /\.json$/.test(x))) {
  const obj = JSON.parse(fs.readFileSync(TMP + "/hist-after/" + f, "utf8"));
  if (obj[D.dF]) fRec = obj[D.dF];
  if (obj[D.dToday]) ok(false, "seal wrote today (" + D.dToday + ") — should never");
}
ok(fRec && fRec.rows.some((r) => r.model === "claude-opus-4-8" && r.tokens === 300000),
   "NON-SHRINK: re-seal from FAB-only live kept the archived OPUS cell (got " + JSON.stringify(fRec && fRec.rows.map((r) => r.model + ":" + r.tokens)) + ")");
ok(fRec && fRec.rows.some((r) => r.model === "claude-fable-5"), "NON-SHRINK: FAB cell present too");

// disabled: no merge, live-only
const off = JSON.parse(fs.readFileSync(TMP + "/off.json", "utf8"));
const off90 = period(off, "last90");
const offF = bucket(off90, D.dF);
ok(offF && offF.tokens === 100000, "history:false -> F live-only 100k, OPUS not merged (got " + (offF && offF.tokens) + ")");
ok(off.totals.tokens === 750000, "history:false -> totals live-only = 150k+500k+100k = 750k (got " + off.totals.tokens + ")");
process.exit(fail);
' "$TMP"
RES=$?
echo "---- exit $RES"
exit $RES
