#!/usr/bin/env node
'use strict';

/*
 * Pulse — a local, zero-dependency Claude Code usage dashboard.
 *
 * Reads the newline-delimited JSON session logs Claude Code writes under
 * ~/.claude/projects, aggregates them, and serves a self-refreshing
 * dashboard on http://localhost:4747.
 *
 * HARD RULE: this tool only ever READS from ~/.claude. It never writes,
 * moves, or deletes anything under that tree.
 *
 * Node >= 18 built-ins only. No dependencies, no network calls, no telemetry.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const url = require('url');

// ---------------------------------------------------------------------------
// §5  COST MODEL  — the first of two areas that must be exactly right.
//
// Prices are Anthropic API list prices in US dollars per MILLION tokens.
// On a Pro/Max subscription these are NOT a bill — they express relative
// usage. This is stated in the UI.
//
// Verified against Anthropic list pricing (docs.claude.com) — 2026-07.
// This object is the single source of truth: updating a price is a one-line
// edit here.
// ---------------------------------------------------------------------------
const PRICING = {
  // model string : { input, output }  in $/MTok
  //
  // Current generation
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-opus-4-6':   { input: 5,  output: 25 },
  'claude-opus-4-5':   { input: 5,  output: 25 },
  // Sonnet 5 carries an introductory price valid through 2026-08-31; after
  // that it reverts to standard. This is applied per-entry, keyed on the
  // entry's OWN date (see priceFor), never on "now".
  'claude-sonnet-5':   { input: 3,  output: 15, introInput: 2, introOutput: 10, introUntil: '2026-08-31' },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-sonnet-4-5': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },

  // Older strings that still appear in real history
  'claude-opus-4-1':   { input: 15, output: 75 },
  'claude-opus-4-0':   { input: 15, output: 75 },
  'claude-sonnet-4-0': { input: 3,  output: 15 },
  'claude-3-7-sonnet': { input: 3,  output: 15 },
  'claude-3-5-sonnet': { input: 3,  output: 15 },
  'claude-3-5-haiku':  { input: 0.8, output: 4 },
  'claude-3-opus':     { input: 15, output: 75 },
  'claude-3-haiku':    { input: 0.25, output: 1.25 },

  // Claude Code's placeholder for non-billable internal turns — free, and not
  // a real model. Priced at zero and hidden from the by-model breakdown.
  '<synthetic>':       { input: 0, output: 0 },

  // Fallback for unknown / new model strings. The string is logged once so it
  // can be added to this map.
  '__default__':       { input: 3, output: 15 },
};

// Models excluded from the by-model list (internal placeholders, no real cost).
const HIDDEN_MODELS = new Set(['<synthetic>']);

// Cache-token multipliers, applied against the model's INPUT price.
const CACHE_WRITE_5M_MULT = 1.25; // 5-minute TTL cache write
const CACHE_WRITE_1H_MULT = 2.00; // 1-hour TTL cache write
const CACHE_READ_MULT     = 0.10; // cache read

const WEB_SEARCH_PER_1K = 10; // $ per 1000 web_search requests

const HOUR_MS  = 3600 * 1000;
const BLOCK_MS = 5 * HOUR_MS; // rolling 5-hour usage window
const MINUTE_MS = 60 * 1000;

const _unknownModels = new Set();
function logUnknownModel(model) {
  if (model && !_unknownModels.has(model)) {
    _unknownModels.add(model);
    console.warn(`[pulse] unknown model "${model}" — using __default__ pricing. Add it to PRICING.`);
  }
}

// Local-time YYYY-MM-DD for an epoch-ms timestamp (used for the Sonnet-5
// intro-price date check and for day bucketing).
function localDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolve the {input, output} price for a model at a given entry timestamp,
// honouring any time-limited introductory price.
function priceFor(model, ts) {
  let p = PRICING[model];
  if (!p && model) {
    // Dated / suffixed variants (e.g. claude-haiku-4-5-20251001) price as their
    // base model: longest PRICING key that prefixes the model string wins.
    let best = '';
    for (const key of Object.keys(PRICING)) {
      if (key !== '__default__' && model.startsWith(key) && key.length > best.length) best = key;
    }
    if (best) p = PRICING[best];
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING.__default__;
  }
  if (p.introUntil && localDateStr(ts) <= p.introUntil) {
    return { input: p.introInput, output: p.introOutput };
  }
  return { input: p.input, output: p.output };
}

// §5 per-entry cost. Cache-creation tokens without a TTL breakdown are treated
// as 5-minute writes (×1.25) — documented assumption, handled at normalize().
function costForEntry(e) {
  const price = priceFor(e.model, e.ts);
  return (
    (e.inputTokens  / 1e6) * price.input +
    (e.outputTokens / 1e6) * price.output +
    (e.cacheWrite5m / 1e6) * price.input * CACHE_WRITE_5M_MULT +
    (e.cacheWrite1h / 1e6) * price.input * CACHE_WRITE_1H_MULT +
    (e.cacheRead    / 1e6) * price.input * CACHE_READ_MULT +
    (e.webSearches  / 1000) * WEB_SEARCH_PER_1K
  );
}

// ---------------------------------------------------------------------------
// PATHS & FILE DISCOVERY
// ---------------------------------------------------------------------------

// Resolve the .claude directory. Precedence:
//   1. CLAUDE_DIR         — Pulse's own override
//   2. CLAUDE_CONFIG_DIR  — Claude Code's own env var (so if Claude Code writes
//                           to a custom location, Pulse follows it automatically)
//   3. ~/.claude          — the default
// IMPORTANT for Windows users running Claude Code under WSL: the WSL home is a
// different filesystem from C:\Users\<you>. Run Pulse inside the same
// environment as Claude Code, or point CLAUDE_DIR at the right .claude.
function claudeDir() {
  return process.env.CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Hand-rolled recursive walker for *.jsonl files. We deliberately avoid
// fs.readdir(..., {recursive:true}) because its availability varies across the
// Node 18.x line. READ-ONLY: only readdirSync/statSync/realpathSync, never a
// write op.
//
// Cycle-safe: symlinks and (on Windows) directory junctions can point back at
// an ancestor, which would make a naive recursion loop forever. We canonicalize
// each directory with realpathSync and skip any real path already visited, and
// cap recursion depth as a backstop. Without this, a single junction cycle in
// ~/.claude wedges the whole server (the request never returns).
const WALK_MAX_DEPTH = 40;
function walkJsonl(dir, out, seen, depth) {
  if (out === undefined) { out = []; seen = new Set(); depth = 0; }
  if (depth > WALK_MAX_DEPTH) return out;

  // Canonical path (breaks symlink / junction cycles).
  let real;
  try {
    real = (fs.realpathSync.native || fs.realpathSync)(dir);
  } catch (_) {
    real = dir;
  }
  if (seen.has(real)) return out; // already walked this directory — cycle
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out; // missing / unreadable dir — skip silently
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    // Resolve symlinks defensively (still read-only).
    if (ent.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (_) { continue; }
    }
    if (isDir) {
      walkJsonl(full, out, seen, depth + 1);
    } else if (isFile && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function projectsRoot() {
  return path.join(claudeDir(), 'projects');
}

// ---------------------------------------------------------------------------
// §3  RECORD ACCESSORS — read field names via small helpers with fallbacks.
// Field names have drifted across Claude Code versions; never assume a key
// exists. (Phase 0 confirmed the shapes on the target machine.)
// ---------------------------------------------------------------------------

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// Stable dedup key identifying a unique assistant message.
//
// The brief describes a composite `message.id + ":" + requestId`. In practice
// message.id is a globally-unique per-message id that is CONSISTENT across the
// duplicate lines the log writes as a message streams — so we key on it alone
// when present. Folding requestId into the key would SPLIT a message whose
// requestId is present on some copies but absent on others (a real log quirk),
// double-counting its usage; message.id alone dedups those copies correctly.
// We fall back to requestId, then uuid, then a timestamp+model+token-count
// composite so two genuinely-distinct messages at the same instant are not
// collapsed while true duplicate writes (identical counts) still dedup.
function dedupKey(rec) {
  const msg = rec.message || {};
  if (msg.id) return 'm:' + msg.id;
  if (rec.requestId) return 'r:' + rec.requestId;
  if (rec.uuid) return 'u:' + rec.uuid;
  const u = msg.usage || {};
  return 't:' + (rec.timestamp || '') + ':' + (msg.model || '') + ':' +
    num(u.input_tokens) + ':' + num(u.output_tokens);
}

// Extract the plain-text of a user record's content (string, or an array of
// blocks with {type:'text', text}). Used only for the title fallback.
function userText(rec) {
  const c = rec.message && rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const block of c) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block === 'string') return block;
    }
  }
  return '';
}

// Turn one assistant-with-usage record into a normalized Entry, or null if the
// record carries no usage.
function normalize(rec) {
  const msg = rec.message;
  if (!msg || !msg.usage) return null; // skip non-usage records for cost
  const u = msg.usage;

  const ts = Date.parse(rec.timestamp);
  if (!isFinite(ts)) return null;

  // Cache-creation TTL breakdown (§5). If the breakdown object is present, use
  // it and DO NOT also add the lump `cache_creation_input_tokens` (it is the
  // sum of the two). If absent, treat the whole lump as a 5-minute write.
  let cacheWrite5m, cacheWrite1h;
  const cc = u.cache_creation;
  if (cc && (typeof cc.ephemeral_5m_input_tokens === 'number' ||
             typeof cc.ephemeral_1h_input_tokens === 'number')) {
    cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
    cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = num(u.cache_creation_input_tokens);
    cacheWrite1h = 0;
  }

  const stu = u.server_tool_use || {};

  const e = {
    ts,
    model: msg.model || 'unknown',
    source: rec.entrypoint || 'cli', // §3.4 — default cli when absent
    // Execution mode as recorded by Claude Code. NOTE: reasoning effort
    // (high/xhigh/max) and "ultracode" are request-time settings NOT written to
    // the transcript — they are recovered separately from the effort sidecar
    // (see --effort-setup) and joined on in annotateModes(). `speed` (fast vs
    // standard) and `service_tier` are the only runtime modes logged here.
    speed: u.speed || 'standard',
    serviceTier: u.service_tier || 'standard',
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(u.cache_read_input_tokens),
    webSearches: num(stu.web_search_requests),
    sessionId: rec.sessionId || '',
    project: rec.cwd || '',
    messageId: (msg.id) || '',
    requestId: rec.requestId || '',
    key: dedupKey(rec),
  };
  e.cost = costForEntry(e);
  return e;
}

// ---------------------------------------------------------------------------
// PARSE + mtime CACHE
//
// In-memory cache keyed by filepath: { mtimeMs, entries, sessionMeta }.
// Parsing is the expensive part and is skipped entirely for files whose mtime
// is unchanged; the arithmetic rollup is cheap and redone every request.
// ---------------------------------------------------------------------------

const fileCache = new Map();

// Parse a single .jsonl file into normalized entries + per-session metadata,
// with per-file dedup applied. Malformed lines (incl. a partial trailing write
// on a live session) are caught and skipped — this is normal, not an error.
function parseFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    // Read failed — e.g. the file is locked mid-write by Claude Code (common on
    // Windows). Return null (not empty) so the caller does NOT cache this as
    // "no data" and instead retries on the next request.
    return null;
  }
  const lines = raw.split('\n');
  const entries = [];
  const seen = new Set();       // per-file dedup
  const sessionMeta = {};       // sessionId -> { firstUserText, project }
  const ultracodeSessions = []; // sessions whose prompts invoked ultracode

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue; // partial/truncated line — skip
    }
    if (!rec || typeof rec !== 'object') continue;

    // Capture first user prompt per session for the title fallback, and flag
    // ultracode sessions (the keyword in a prompt opts the session in — this
    // works retroactively, even before the mode hook is installed).
    if (rec.type === 'user') {
      const sid = rec.sessionId || '';
      const txt = userText(rec);
      if (sid && !sessionMeta[sid]) {
        sessionMeta[sid] = {
          firstUserText: txt.trim(),
          project: rec.cwd || '',
        };
      }
      if (sid && /\bultracode\b/i.test(txt)) ultracodeSessions.push(sid);
      continue;
    }

    if (rec.type !== 'assistant') continue;
    const e = normalize(rec);
    if (!e) continue;
    if (seen.has(e.key)) continue; // per-file dedup
    seen.add(e.key);
    entries.push(e);

    // Record project path for sessions even if no user record was seen.
    if (e.sessionId && !sessionMeta[e.sessionId]) {
      sessionMeta[e.sessionId] = { firstUserText: '', project: e.project };
    } else if (e.sessionId && sessionMeta[e.sessionId] && !sessionMeta[e.sessionId].project) {
      sessionMeta[e.sessionId].project = e.project;
    }
  }
  return { entries, sessionMeta, ultracodeSessions };
}

// Walk all files; reuse cached parse when mtime is unchanged. Returns the merged
// (globally deduped) entry list plus a merged sessionId->meta map. Logs a
// one-line "parsed X, skipped Y (cached)" so the mtime cache is observable.
function parseAll() {
  const walkT0 = Date.now();
  const files = walkJsonl(projectsRoot());
  const walkMs = Date.now() - walkT0;
  const liveFiles = new Set(files);

  let parsed = 0, skipped = 0, failed = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    const cached = fileCache.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      skipped++;
      continue;
    }
    const result = parseFile(f);
    if (result === null) {
      // Read failed this cycle (e.g. locked mid-write). Keep any prior cached
      // entries and retry next request — do NOT cache the failure.
      failed++;
      continue;
    }
    fileCache.set(f, {
      mtimeMs: st.mtimeMs,
      entries: result.entries,
      sessionMeta: result.sessionMeta,
      ultracodeSessions: result.ultracodeSessions || [],
    });
    parsed++;
  }
  // Drop cache entries for files that have disappeared.
  for (const key of fileCache.keys()) {
    if (!liveFiles.has(key)) fileCache.delete(key);
  }

  // Merge all cached files → global dedup.
  const merged = [];
  const globalSeen = new Set();
  const sessionMeta = {};
  const ultracodeSessions = new Set();
  for (const { entries, sessionMeta: sm, ultracodeSessions: us } of fileCache.values()) {
    for (const e of entries) {
      if (globalSeen.has(e.key)) continue;
      globalSeen.add(e.key);
      merged.push(e);
    }
    for (const sid of us || []) ultracodeSessions.add(sid);
    for (const sid of Object.keys(sm)) {
      const cur = sessionMeta[sid];
      const inc = sm[sid];
      if (!cur) {
        sessionMeta[sid] = { firstUserText: inc.firstUserText || '', project: inc.project || '' };
      } else {
        if (!cur.firstUserText && inc.firstUserText) cur.firstUserText = inc.firstUserText;
        if (!cur.project && inc.project) cur.project = inc.project;
      }
    }
  }

  console.log(`[pulse] walked ${files.length} file(s) in ${walkMs}ms; parsed ${parsed}, skipped ${skipped} (cached)${failed ? `, ${failed} unreadable (will retry)` : ''}; ${merged.length} unique usage records`);
  return { entries: merged, sessionMeta, ultracodeSessions, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// EFFORT / MODE SIDECAR LOG
//
// Claude Code never writes the reasoning effort level (low/medium/high/xhigh/
// max, or ultracode) into transcripts, but it DOES deliver it to hooks. The
// optional hook shipped at hooks/pulse-mode-hook.js (see --effort-setup)
// records it to a sidecar log — one JSONL line per change:
//   { ts, sessionId, event, effort, ultracode?, model? }
// Pulse reads that log and joins effort onto entries by sessionId + timestamp
// (latest mode record at or before the entry). Cached by mtime like the
// transcript files. Location is outside ~/.claude on purpose.
// ---------------------------------------------------------------------------

function modesFilePath() {
  return process.env.PULSE_MODES_FILE || path.join(os.homedir(), '.pulse', 'modes.jsonl');
}

let modesCache = { mtimeMs: -1, bySession: {} };
function readModes() {
  const f = modesFilePath();
  let st;
  try { st = fs.statSync(f); } catch (_) { return {}; } // no log — hook not installed
  if (st.mtimeMs === modesCache.mtimeMs) return modesCache.bySession;
  const bySession = {};
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { return modesCache.bySession; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !r.sessionId) continue;
    const ts = typeof r.ts === 'number' && isFinite(r.ts) ? r.ts : 0;
    (bySession[r.sessionId] = bySession[r.sessionId] || [])
      .push({ ts, effort: r.effort ? String(r.effort) : null, ultracode: !!r.ultracode });
  }
  for (const k of Object.keys(bySession)) bySession[k].sort((a, b) => a.ts - b.ts);
  modesCache = { mtimeMs: st.mtimeMs, bySession };
  return bySession;
}

// Annotate entries in place with { effort, ultracode } from the sidecar log
// (time-joined per session) plus transcript-detected ultracode sessions.
function annotateModes(entriesAsc, modesBySession, ultracodeSessions) {
  for (const e of entriesAsc) {
    let effort = null;
    let ultra = ultracodeSessions.has(e.sessionId);
    const recs = modesBySession[e.sessionId];
    if (recs && recs.length) {
      // latest record at or before this entry; else the session's first record
      let chosen = recs[0];
      for (const r of recs) {
        if (r.ts <= e.ts) chosen = r; else break;
      }
      effort = chosen.effort;
      if (recs.some((r) => r.ultracode && r.ts <= e.ts + HOUR_MS)) ultra = true;
    }
    e.effort = effort;
    e.ultracode = ultra;
  }
}

// ---------------------------------------------------------------------------
// §4.1  5-HOUR BLOCKS — the second area that must be exactly right.
// Implemented precisely as the usage monitor does.
// ---------------------------------------------------------------------------

function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0); // start of the local hour
  return d.getTime();
}

function computeBlocks(entriesAsc) {
  const blocks = [];
  let current = null;
  let lastTs = null;

  for (const e of entriesAsc) {
    if (current === null) {
      const start = floorToHour(e.ts);
      current = { start, end: start + BLOCK_MS, entries: [e] };
    } else {
      const newBlock = (e.ts - lastTs >= BLOCK_MS) || (e.ts >= current.end);
      if (newBlock) {
        blocks.push(current);
        const start = floorToHour(e.ts);
        current = { start, end: start + BLOCK_MS, entries: [e] };
      } else {
        current.entries.push(e);
      }
    }
    lastTs = e.ts;
  }
  if (current) blocks.push(current);
  return blocks;
}

function summarizeBlock(b) {
  let cost = 0, tokens = 0;
  for (const e of b.entries) {
    cost += e.cost;
    tokens += tokensOf(e);
  }
  return {
    start: b.start,
    end: b.end,
    cost,
    tokens,
    messages: b.entries.length,
  };
}

// Total billable tokens for an entry (input + output + all cache tokens).
function tokensOf(e) {
  return e.inputTokens + e.outputTokens + e.cacheWrite5m + e.cacheWrite1h + e.cacheRead;
}

// ---------------------------------------------------------------------------
// §4  AGGREGATIONS
// ---------------------------------------------------------------------------

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function aggregate(entries, sessionMeta, desktopTitles, now, modesBySession, ultracodeSessions) {
  const asc = entries.slice().sort((a, b) => a.ts - b.ts);
  annotateModes(asc, modesBySession || {}, ultracodeSessions || new Set());
  const modesLogged = Object.keys(modesBySession || {}).length > 0;

  // ---- 5-hour blocks + active block ----
  const rawBlocks = computeBlocks(asc);
  const blocks = rawBlocks.map(summarizeBlock);
  let activeBlock = null;
  for (const b of blocks) {
    if (b.start <= now && now < b.end) { activeBlock = b; break; }
  }
  const timeToReset = activeBlock ? (activeBlock.end - now) : null;

  // "vs your heaviest past block" — % of the max over all OTHER (completed)
  // blocks. Guard against a lone/first block (peak 0 → null).
  let currentBlock = null;
  if (activeBlock) {
    let peakCost = 0, peakTokens = 0;
    for (const b of blocks) {
      if (b === activeBlock) continue;
      if (b.cost > peakCost) peakCost = b.cost;
      if (b.tokens > peakTokens) peakTokens = b.tokens;
    }
    currentBlock = {
      start: activeBlock.start,
      end: activeBlock.end,
      cost: activeBlock.cost,
      tokens: activeBlock.tokens,
      messages: activeBlock.messages,
      timeToReset,
      vsPeakCostPct: peakCost > 0 ? (activeBlock.cost / peakCost) * 100 : null,
      vsPeakTokensPct: peakTokens > 0 ? (activeBlock.tokens / peakTokens) * 100 : null,
    };
  }

  // ---- §4.2 burn rate (trailing 60 minutes) ----
  const windowStart = now - 60 * MINUTE_MS;
  let brTokens = 0, brCost = 0, earliest = null;
  for (const e of asc) {
    if (e.ts >= windowStart && e.ts <= now) {
      brTokens += tokensOf(e);
      brCost += e.cost;
      if (earliest === null) earliest = e.ts; // asc → first is earliest
    }
  }
  let burnRate = null;
  if (earliest !== null) {
    const spanMin = (now - earliest) / MINUTE_MS;
    // min(60, span) with a 1-minute floor so early-session data isn't a
    // divide-by-near-zero blowup.
    const elapsedMin = Math.max(1, Math.min(60, spanMin));
    burnRate = {
      tokensPerMin: brTokens / elapsedMin,
      dollarsPerHour: brCost / (elapsedMin / 60),
      windowTokens: brTokens,
      windowCost: brCost,
      elapsedMin,
    };
  }

  // ---- rollups ----
  const midnight = startOfLocalDay(now);
  const sevenDaysAgo = now - 7 * 24 * HOUR_MS;

  const today = { cost: 0, tokens: 0, messages: 0 };
  const week  = { cost: 0, tokens: 0, messages: 0 };
  for (const e of asc) {
    const tk = tokensOf(e);
    if (e.ts >= midnight) { today.cost += e.cost; today.tokens += tk; today.messages++; }
    if (e.ts >= sevenDaysAgo) { week.cost += e.cost; week.tokens += tk; week.messages++; }
  }

  // ---- distinct sources / models across all time (stable color assignment) ----
  const allSourcesSet = new Set(), allModelsSet = new Set(), monthKeySet = new Set();
  for (const e of asc) {
    allSourcesSet.add(e.source);
    if (!HIDDEN_MODELS.has(e.model)) allModelsSet.add(e.model);
    monthKeySet.add(localDateStr(e.ts).slice(0, 7)); // YYYY-MM
  }
  const allSources = Array.from(allSourcesSet).sort();
  const allModels = Array.from(allModelsSet).sort();

  // ---- §4.3 spend PERIODS: "Last 30 days" + one entry per calendar month ----
  // Each period carries its own daily buckets (split by source), by-model and
  // by-source rollups, and totals — so the spend section can be re-scoped to a
  // rolling window or any past month. Day walks use setDate (DST-safe).
  const periods = [];

  // Rolling last-30-days.
  {
    const days = localDayStartsBack(now, 30);
    const daySet = new Set(days);
    const inWin = asc.filter((e) => daySet.has(localDateStr(e.ts)));
    periods.push(buildPeriod('last30', 'Last 30 days', inWin, days, allSources));
  }
  // One period per calendar month present in the data (newest first, capped).
  const months = Array.from(monthKeySet).sort().reverse().slice(0, 24);
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const days = monthDayList(y, m - 1);
    const inMonth = asc.filter((e) => localDateStr(e.ts).slice(0, 7) === mk);
    periods.push(buildPeriod(mk, monthLabel(y, m), inMonth, days, allSources));
  }

  // ---- recent sessions (newest first) ----
  const sessMap = {};
  for (const e of asc) {
    const sid = e.sessionId || '(unknown)';
    let s = sessMap[sid];
    if (!s) {
      s = sessMap[sid] = {
        sessionId: sid, cost: 0, tokens: 0, messages: 0,
        models: new Set(), sources: new Set(), speeds: new Set(), efforts: new Set(),
        ultracode: false, lastTs: 0, firstTs: e.ts,
      };
    }
    s.cost += e.cost; s.tokens += tokensOf(e); s.messages++;
    if (!HIDDEN_MODELS.has(e.model)) s.models.add(e.model);
    s.sources.add(e.source); s.speeds.add(e.speed);
    if (e.effort) s.efforts.add(e.effort);
    if (e.ultracode) s.ultracode = true;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
  }
  const recentSessions = Object.values(sessMap)
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 20)
    .map((s) => ({
      sessionId: s.sessionId,
      title: sessionTitle(s.sessionId, sessionMeta, desktopTitles),
      source: s.sources.size === 1 ? Array.from(s.sources)[0] : 'mixed',
      models: Array.from(s.models),
      speeds: Array.from(s.speeds).sort(),
      efforts: Array.from(s.efforts).sort(),
      ultracode: s.ultracode,
      cost: s.cost,
      tokens: s.tokens,
      messages: s.messages,
      lastTs: s.lastTs,
    }));

  const payload = {
    generatedAt: now,
    latestTs: asc.length ? asc[asc.length - 1].ts : null, // newest record on this machine
    totals: {
      cost: entries.reduce((a, e) => a + e.cost, 0),
      tokens: entries.reduce((a, e) => a + tokensOf(e), 0),
      messages: entries.length,
      sessions: Object.keys(sessMap).length,
    },
    currentBlock,
    idle: activeBlock === null,
    burnRate,
    today,
    week,
    periods,
    allSources,
    allModels,
    recentSessions,
    pricing: buildPricingView(now),
    hasData: entries.length > 0,
    // effort/mode sidecar status — lets the UI hint at setup when absent
    modesLogged,
    modesFile: modesFilePath(),
  };

  payload.selfCheck = selfCheck(payload, asc, rawBlocks);
  return payload;
}

// Build one spend period: daily buckets (split by source) + by-model/by-source
// rollups + totals, over the given entries and ordered day list.
function buildPeriod(key, label, entries, dayList, allSources) {
  const index = {};
  const daily = [];
  for (const ds of dayList) {
    const bucket = { date: ds, total: 0, tokens: 0, bySource: {} };
    for (const s of allSources) bucket.bySource[s] = 0;
    index[ds] = bucket;
    daily.push(bucket);
  }
  const byModel = {}, bySource = {}, srcSet = new Set(), sess = new Set();
  let cost = 0, tokens = 0;
  for (const e of entries) {
    const tk = tokensOf(e);
    const b = index[localDateStr(e.ts)];
    if (b) {
      b.total += e.cost;
      b.tokens += tk;
      b.bySource[e.source] = (b.bySource[e.source] || 0) + e.cost;
    }
    cost += e.cost; tokens += tk; srcSet.add(e.source);
    // Hidden placeholders (e.g. "<synthetic>") still count toward totals — they
    // are $0 / 0-token — but never appear as a row in the by-model breakdown.
    if (!HIDDEN_MODELS.has(e.model)) {
      const m = byModel[e.model] || (byModel[e.model] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
      m.cost += e.cost; m.tokens += tk; m.messages++;
      m.speeds[e.speed] = (m.speeds[e.speed] || 0) + 1;
      m.tiers[e.serviceTier] = (m.tiers[e.serviceTier] || 0) + 1;
      if (e.effort) m.efforts = m.efforts || {}, m.efforts[e.effort] = (m.efforts[e.effort] || 0) + 1;
      if (e.ultracode) m.ultracode = (m.ultracode || 0) + 1;
    }
    const s = bySource[e.source] || (bySource[e.source] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
    s.cost += e.cost; s.tokens += tk; s.messages++;
    s.speeds[e.speed] = (s.speeds[e.speed] || 0) + 1;
    if (e.sessionId) sess.add(e.sessionId);
  }
  const sources = Array.from(srcSet).sort();
  return {
    key, label, cost, tokens, messages: entries.length, sessions: sess.size,
    daily, byModel, bySource, sources, singleSource: sources.length <= 1,
  };
}

// Ordered list of the last n local calendar dates ending today (oldest first),
// DST-safe via setDate.
function localDayStartsBack(now, n) {
  const out = [];
  const c = new Date(now);
  c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push(localDateStr(c.getTime()));
    c.setDate(c.getDate() + 1);
  }
  return out;
}

// Ordered list of every local calendar date in a given month (oldest first).
function monthDayList(year, monthIdx) {
  const out = [];
  const c = new Date(year, monthIdx, 1); // local midnight, day 1
  while (c.getMonth() === monthIdx) {
    out.push(localDateStr(c.getTime()));
    c.setDate(c.getDate() + 1);
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(year, month /* 1-based */) {
  return (MONTH_NAMES[month - 1] || '?') + ' ' + year;
}

// A compact view of the active price table, for the UI "estimates" note.
function buildPricingView(now) {
  const out = {};
  for (const model of Object.keys(PRICING)) {
    if (model === '__default__' || HIDDEN_MODELS.has(model)) continue;
    const p = priceFor(model, now);
    out[model] = { input: p.input, output: p.output };
  }
  return out;
}

// Resolve a human-readable session title, degrading gracefully:
//   desktop store title  ->  derived "<project> · <first prompt> · <short id>"
function sessionTitle(sessionId, sessionMeta, desktopTitles) {
  if (desktopTitles && desktopTitles[sessionId]) return desktopTitles[sessionId];
  const meta = sessionMeta[sessionId] || {};
  const proj = meta.project ? path.basename(meta.project) : '';
  let prompt = (meta.firstUserText || '').replace(/\s+/g, ' ').trim();
  if (prompt.length > 60) prompt = prompt.slice(0, 57) + '…';
  const shortId = sessionId ? sessionId.slice(0, 8) : '';
  const parts = [];
  if (proj) parts.push(proj);
  if (prompt) parts.push(prompt);
  if (shortId) parts.push(shortId);
  return parts.length ? parts.join(' · ') : (sessionId || 'session');
}

// §4 internal-consistency invariants. Logs warnings; returns a summary the UI
// can surface. Never throws.
function selfCheck(payload, asc, rawBlocks) {
  const issues = [];
  const EPS = 1e-6;

  // For each spend period, the daily buckets must sum to the period total.
  for (const p of payload.periods) {
    const dailySum = p.daily.reduce((a, b) => a + b.total, 0);
    if (Math.abs(dailySum - p.cost) > 1e-4) {
      issues.push(`period ${p.key}: daily sum ${dailySum.toFixed(6)} != total ${p.cost.toFixed(6)}`);
    }
  }

  // today ⊆ 7-day (cost & messages)
  if (payload.today.cost - payload.week.cost > EPS || payload.today.messages > payload.week.messages) {
    issues.push('today is not a subset of the 7-day window');
  }

  // every block's entries ⊆ all entries (count match)
  const blockEntryCount = rawBlocks.reduce((a, b) => a + b.entries.length, 0);
  if (blockEntryCount !== asc.length) {
    issues.push(`block entries (${blockEntryCount}) != all entries (${asc.length})`);
  }

  // no duplicate dedup keys remain
  const keys = new Set();
  let dups = 0;
  for (const e of asc) { if (keys.has(e.key)) dups++; else keys.add(e.key); }
  if (dups > 0) issues.push(`${dups} duplicate dedup key(s) survived`);

  if (issues.length) {
    for (const i of issues) console.warn('[pulse] self-check: ' + i);
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// §3.5  SESSION TITLES from the desktop store (cross-platform, optional).
// Attempt to read sessionId->title. Absent store or unrecognized format => {}.
// Purely additive; never blocks or throws.
// ---------------------------------------------------------------------------

function desktopStoreDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude-code-sessions');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return path.join(home, '.config', 'Claude', 'claude-code-sessions');
}

// Best-effort extraction of a sessionId->title map from an unknown-format store.
// We look for JSON files and pull common title-ish keys. READ-ONLY.
function readDesktopTitles() {
  const dir = desktopStoreDir();
  const map = {};
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return map; // no store (headless server) — expected
  }
  for (const ent of files) {
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }

    // Try whole-file JSON first, then line-delimited JSON.
    const candidates = [];
    try { candidates.push(JSON.parse(text)); }
    catch (_) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { candidates.push(JSON.parse(line)); } catch (_) {}
      }
    }
    for (const obj of candidates) collectTitles(obj, ent.name, map);
  }
  return map;
}

// Pull {sessionId -> title} out of an arbitrary parsed object. Handles a map
// keyed by session id, an array of records, or a single record.
function collectTitles(obj, fileName, map) {
  if (!obj || typeof obj !== 'object') return;

  const titleOf = (r) => (r && typeof r === 'object')
    ? (r.title || r.name || r.summary || r.displayName || null) : null;
  const idOf = (r, fallbackKey) => (r && typeof r === 'object')
    ? (r.sessionId || r.session_id || r.id || r.uuid || fallbackKey) : fallbackKey;

  if (Array.isArray(obj)) {
    for (const r of obj) {
      const id = idOf(r, null);
      const t = titleOf(r);
      if (id && t) map[id] = String(t);
    }
    return;
  }

  // A single record that looks like a session?
  const directTitle = titleOf(obj);
  const directId = obj.sessionId || obj.session_id || obj.id || obj.uuid ||
    (fileName.endsWith('.json') ? fileName.slice(0, -5) : null);
  if (directTitle && directId) {
    map[directId] = String(directTitle);
  }

  // Or a map keyed by session id -> record/string.
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      // heuristically only treat as title if key looks like a session id
      if (/^[0-9a-f-]{8,}$/i.test(k)) map[k] = v;
    } else if (v && typeof v === 'object') {
      const t = titleOf(v);
      if (t) map[k] = String(t);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP SERVER  (§6)
// ---------------------------------------------------------------------------

function buildSummary() {
  const { entries, sessionMeta, ultracodeSessions, fileCount } = parseAll();
  const desktopTitles = readDesktopTitles();
  const now = Date.now();
  const payload = aggregate(entries, sessionMeta, desktopTitles, now, readModes(), ultracodeSessions);
  // Surface what Pulse is actually reading, so a wrong-directory setup (e.g.
  // Claude Code under WSL while Pulse runs in native Windows) is diagnosable.
  payload.claudeDir = claudeDir();
  payload.fileCount = fileCount;
  return payload;
}

// ---------------------------------------------------------------------------
// SINGLE-EXECUTABLE (SEA) SUPPORT
// When packaged as pulse.exe / pulse-linux (see build/make-exe.mjs), the
// frontend is embedded as SEA assets keyed "web/dist/<relpath>" and read via
// node:sea instead of the filesystem. In a normal checkout seaApi is null and
// everything reads from disk as before.
// ---------------------------------------------------------------------------
let seaApi = null;
try {
  const sea = require('node:sea');
  if (sea.isSea && sea.isSea()) seaApi = sea;
} catch (_) { /* Node 18 has no node:sea — repo mode only */ }

function seaAsset(key) {
  if (!seaApi) return null;
  try { return Buffer.from(seaApi.getRawAsset(key)); } catch (_) { return null; }
}

// The built React frontend (Vite output). Served as static files; the server
// itself keeps zero RUNTIME dependencies — the React toolchain is build-time
// only (see web/). Run `npm run build` if this directory is missing.
const WEB_DIR = path.join(__dirname, 'web', 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// Serve a file from WEB_DIR for the given request path. Returns true if handled.
// Path-traversal safe: the resolved path must stay within WEB_DIR. Unknown
// non-asset routes fall back to index.html (SPA). Returns false only when the
// frontend build is missing entirely.
function serveStatic(route, res) {
  let rel = decodeURIComponent(route);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Packaged binary: serve from embedded SEA assets.
  if (seaApi) {
    let target = rel;
    let buf = seaAsset('web/dist' + rel);
    if (!buf) { target = '/index.html'; buf = seaAsset('web/dist/index.html'); } // SPA fallback
    if (!buf) return false;
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': target === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    res.end(buf);
    return true;
  }

  const indexFile = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(indexFile)) return false; // not built
  // Resolve within WEB_DIR and reject anything that escapes it.
  const resolved = path.normalize(path.join(WEB_DIR, rel));
  let target = resolved;
  if (!target.startsWith(WEB_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = indexFile; // SPA fallback (also covers deep links / unknown routes)
  }
  const ext = path.extname(target).toLowerCase();
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  // Immutable hashed assets can cache hard; index.html must not.
  const cache = target === indexFile ? 'no-store' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(fs.readFileSync(target));
  return true;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function startServer(port, host, opts) {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    const route = parsed.pathname;

    try {
      if (route === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (route === '/api/summary') {
        const t0 = Date.now();
        const payload = buildSummary();
        payload.buildMs = Date.now() - t0;
        console.log(`[pulse] /api/summary built in ${payload.buildMs}ms`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      // Everything else: the built frontend (SPA).
      if (serveStatic(route, res)) return;

      // Frontend not built.
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Pulse frontend not built</h1><p>Run <code>npm run build</code> (installs and builds <code>web/</code>), then reload.</p>');
    } catch (err) {
      console.error('[pulse] request error:', err && err.stack ? err.stack : err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[pulse] port ${port} is already in use. Try: node server.js --port <other>  (or set PORT=)`);
      process.exit(1);
    }
    throw err;
  });

  // Local-only by default: bind to loopback (§2). A non-loopback host is an
  // explicit opt-in (--host / HOST) for VPS/LAN use and is warned about.
  server.listen(port, host, () => {
    console.log(`\n  Pulse — Claude Code usage dashboard`);
    console.log(`  reading (read-only): ${claudeDir()}`);
    console.log(`  listening: http://${host}:${port}`);
    // Packaged exe double-clicked on Windows: open the dashboard for the user.
    if (seaApi && process.platform === 'win32' && (!opts || opts.open !== false) && LOOPBACK_HOSTS.has(host)) {
      try {
        require('child_process').exec(`start "" "http://localhost:${port}"`);
      } catch (_) {}
    }
    if (LOOPBACK_HOSTS.has(host)) {
      console.log(`  open: http://localhost:${port}\n`);
    } else {
      console.log('');
      console.log(`  ⚠  Bound to ${host} — reachable from the network.`);
      console.log('     The dashboard exposes usage metadata (project paths, session');
      console.log('     titles, costs). Prefer 127.0.0.1 + an SSH tunnel, or put a');
      console.log('     firewall / authenticating reverse proxy in front of it.\n');
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
// CONFIG + CLI ENTRY
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EFFORT / MODE HOOK  (`--mode-hook`)
//
// Claude Code does NOT write the reasoning effort level to transcripts, and
// (verified against the installed CLI) does not currently put it in the hook
// payload either. It DOES persist the level chosen with /effort to settings.json
// as `effortLevel`. Registered as a SessionStart + UserPromptSubmit hook (see
// --effort-setup), this subcommand reads that level (plus any payload/env source)
// and appends changes to the sidecar log that readModes() joins in. Reading
// settings.json is model-independent, so it captures effort for Fable too.
// It must never disturb a session: always exits 0, prints nothing, swallows
// every error. Writes ONLY to ~/.pulse — reads ~/.claude but never writes there.
// ---------------------------------------------------------------------------

// Read the configured reasoning effort (`effortLevel`) from Claude Code's
// settings, honoring project-local overrides over the user-level file. Purely
// read-only. Returns a level string (e.g. "max") or null if none is set —
// which is also the case when the level equals the model default (the /effort
// picker stores the default as absent).
function readConfiguredEffort(cwd) {
  const files = [];
  if (cwd && typeof cwd === 'string') {
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
    files.push(path.join(cwd, '.claude', 'settings.json'));
  }
  files.push(path.join(claudeDir(), 'settings.json'));
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const v = j && j.effortLevel;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
  }
  return null;
}

function runModeHook() {
  try {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
    let p = {};
    try { p = raw.trim() ? JSON.parse(raw) : {}; } catch (_) {}

    const sessionId = p.session_id || '';
    if (!sessionId) return;

    // Where the effort level comes from, in priority order:
    //   1. p.effort.level / p.effort — the hook payload field. NOTE: current
    //      Claude Code (verified against 2.1.x) does NOT put effort in the hook
    //      payload; this is future-proofing for versions/docs that do.
    //   2. CLAUDE_CODE_EFFORT_LEVEL / CLAUDE_EFFORT — env, if the CLI exports it.
    //   3. settings.json `effortLevel` — the value the /effort picker persists.
    //      This is the reliable source TODAY and is model-independent, so it is
    //      what makes Fable (and every other model) show real effort. Caveat:
    //      the picker only writes effortLevel when it differs from the model's
    //      default (default "high" is stored as absent), so a session left at
    //      the default has no explicit level to record.
    // Recorded verbatim so any future level name is preserved.
    let effort = null;
    if (p.effort && typeof p.effort === 'object' && p.effort.level) effort = String(p.effort.level);
    else if (typeof p.effort === 'string') effort = p.effort;
    else if (process.env.CLAUDE_CODE_EFFORT_LEVEL) effort = String(process.env.CLAUDE_CODE_EFFORT_LEVEL);
    else if (process.env.CLAUDE_EFFORT) effort = String(process.env.CLAUDE_EFFORT);
    else effort = readConfiguredEffort(p.cwd);

    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    const ultracode = /\bultracode\b/i.test(prompt) || /^ultracode$/i.test(effort || '');
    if (!effort && !ultracode) return;

    const rec = { ts: Date.now(), sessionId, event: p.hook_event_name || '', effort: effort || null };
    if (ultracode) rec.ultracode = true;
    if (p.model) rec.model = String(p.model);

    const file = modesFilePath();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}

    // Append only when something changed for this session (hooks fire every
    // prompt; the log should only grow on change).
    try {
      const st = fs.statSync(file);
      if (st.size > 0 && st.size < 10 * 1024 * 1024) {
        const tail = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        for (let i = tail.length - 1; i >= 0 && i >= tail.length - 200; i--) {
          let last;
          try { last = JSON.parse(tail[i]); } catch (_) { continue; }
          if (last.sessionId !== sessionId) continue;
          if (last.effort === rec.effort && !!last.ultracode === !!rec.ultracode) return;
          break;
        }
      }
    } catch (_) {}

    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (_) {}
}

// `--effort-setup` — print (never write) the settings.json snippet that
// enables effort logging. Pulse never modifies ~/.claude itself.
function effortSetup() {
  const cmdValue = seaApi
    ? `${q(process.execPath)} --mode-hook`
    : `${q(process.execPath)} ${q(__filename)} --mode-hook`;
  const hookEntry = [{ hooks: [{ type: 'command', command: cmdValue }] }];
  const snippet = { hooks: { SessionStart: hookEntry, UserPromptSubmit: hookEntry } };

  const settingsPath = path.join(claudeDir(), 'settings.json');
  console.log('\nPulse — effort logging setup');
  console.log('─'.repeat(64));
  console.log('Claude Code never writes the reasoning effort level to its');
  console.log('transcripts, but it does persist it (via /effort) to settings.json.');
  console.log('Add the hooks below and Pulse records that level per session — for');
  console.log('every model, Fable included — plus any "ultracode" you type.');
  console.log('');
  console.log(`1. Open:  ${settingsPath}`);
  console.log('   (create it if missing; if a "hooks" section exists, merge the');
  console.log('   two entries into it instead of replacing it)');
  console.log('');
  console.log('2. Add:');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('');
  console.log('3. Restart your Claude Code sessions. New sessions log their');
  console.log(`   effort level to ${modesFilePath()}`);
  console.log('   and Pulse picks it up automatically (nothing is ever written');
  console.log('   under ~/.claude by Pulse).');
  console.log('');
  console.log('Note: /effort only stores a level when it differs from the model');
  console.log('default, so a session left at the default has no explicit level to');
  console.log('record and shows no effort chip. Pick a non-default level (or type');
  console.log('"ultracode") and it appears.');
  console.log('');
}

function q(s) {
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function parseArgs(argv) {
  const out = { port: null, host: null, inspectSchema: false, modeHook: false, effortSetup: false, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { out.port = parseInt(argv[++i], 10); }
    else if (a.startsWith('--port=')) { out.port = parseInt(a.slice(7), 10); }
    else if (a === '--host') { out.host = argv[++i]; }
    else if (a.startsWith('--host=')) { out.host = a.slice(7); }
    else if (a === '--inspect-schema') { out.inspectSchema = true; }
    else if (a === '--mode-hook') { out.modeHook = true; }
    else if (a === '--effort-setup') { out.effortSetup = true; }
    else if (a === '--no-open') { out.noOpen = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function resolvePort(args) {
  if (args.port && !isNaN(args.port)) return args.port;
  if (process.env.PORT && !isNaN(parseInt(process.env.PORT, 10))) return parseInt(process.env.PORT, 10);
  return 4747;
}

function resolveHost(args) {
  return args.host || process.env.HOST || '127.0.0.1';
}

// Phase 0 helper: print the observed top-level keys and usage keys from a
// handful of real records so accessors can be confirmed against real data.
function inspectSchema() {
  const files = walkJsonl(projectsRoot());
  console.log(`[pulse] --inspect-schema: found ${files.length} .jsonl file(s) under ${projectsRoot()}`);
  const topKeys = {}, msgKeys = {}, usageKeys = {}, entrypoints = {}, models = {};
  let sampled = 0, assistantWithUsage = 0;
  const SAMPLE_FILES = 8, SAMPLE_RECS = 200;

  for (const f of files.slice(0, SAMPLE_FILES)) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line || n >= SAMPLE_RECS) continue;
      n++;
      let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
      sampled++;
      for (const k of Object.keys(rec)) topKeys[k] = (topKeys[k] || 0) + 1;
      if (rec.entrypoint) entrypoints[rec.entrypoint] = (entrypoints[rec.entrypoint] || 0) + 1;
      if (rec.message && typeof rec.message === 'object') {
        for (const k of Object.keys(rec.message)) msgKeys[k] = (msgKeys[k] || 0) + 1;
        if (rec.message.model) models[rec.message.model] = (models[rec.message.model] || 0) + 1;
        if (rec.message.usage) {
          assistantWithUsage++;
          for (const k of Object.keys(rec.message.usage)) usageKeys[k] = (usageKeys[k] || 0) + 1;
        }
      }
    }
  }
  const show = (label, obj) => {
    console.log(`\n${label}:`);
    for (const [k, v] of Object.entries(obj).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}  (${v})`);
    }
  };
  console.log(`\nsampled ${sampled} record(s); ${assistantWithUsage} assistant records with usage`);
  show('top-level keys', topKeys);
  show('message.* keys', msgKeys);
  show('message.usage.* keys', usageKeys);
  show('entrypoint values', entrypoints);
  show('models', models);
  console.log('');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Pulse — local Claude Code usage dashboard\n');
    console.log('Usage: node server.js [--port N] [--host H] [--inspect-schema]');
    console.log('  --port N          listen port (default 4747, or $PORT)');
    console.log('  --host H          bind address (default 127.0.0.1, or $HOST).');
    console.log('                    Use 0.0.0.0 to expose on the network — see the');
    console.log('                    warning it prints; prefer an SSH tunnel instead.');
    console.log('  --effort-setup    print the Claude Code hooks snippet that enables');
    console.log('                    reasoning-effort logging (Pulse never edits ~/.claude)');
    console.log('  --mode-hook       (internal) run as a Claude Code hook — records the');
    console.log('                    effort level to ' + modesFilePath());
    console.log('  --no-open         do not auto-open the browser (packaged exe only)');
    console.log('  --inspect-schema  print observed record schema and exit');
    console.log('  env CLAUDE_DIR    override ~/.claude location');
    return;
  }
  if (args.modeHook) { runModeHook(); return; }
  if (args.effortSetup) { effortSetup(); return; }
  if (args.inspectSchema) { inspectSchema(); return; }
  startServer(resolvePort(args), resolveHost(args), { open: !args.noOpen });
}

if (require.main === module) main();

// Exported for tests / self-check harnesses.
module.exports = {
  PRICING, priceFor, costForEntry, normalize, dedupKey,
  computeBlocks, floorToHour, aggregate, parseAll, tokensOf, localDateStr,
};
