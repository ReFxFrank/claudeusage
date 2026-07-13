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
 * Node >= 18 built-ins only. No dependencies, no telemetry. The ONLY network
 * call Pulse ever makes is an optional GitHub version check (see UPDATES;
 * disable with --no-update-check) — usage data never leaves the machine.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');

// Version — keep in sync with package.json (build/make-exe.mjs enforces this).
const PULSE_VERSION = '1.2.0';
const SERVER_START = Date.now();
let IS_DAEMON_CHILD = false; // set when running as the hidden background child

// ---------------------------------------------------------------------------
// LOGGING
// Everything logged via console.* is mirrored into a ring buffer — served at
// /api/logs for the dashboard's Server panel — and, when running as a hidden
// background process, appended to ~/.pulse/pulse.log.
// ---------------------------------------------------------------------------
const LOG_RING_MAX = 400;
const LOG_FILE_MAX = 2 * 1024 * 1024;
const logRing = [];
let logFileStream = null;
let logFilePath = null;
let logFileBytes = 0;
let logRotating = false;

function pushLogLine(level, args) {
  let text;
  try {
    text = args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || String(a))).join(' ');
  } catch (_) { text = '[unprintable]'; }
  logRing.push({ ts: Date.now(), level, text });
  if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  if (logFileStream) {
    const line = new Date().toISOString() + ' ' + level.toUpperCase().padEnd(5) + ' ' + text + '\n';
    try { logFileStream.write(line); logFileBytes += Buffer.byteLength(line); } catch (_) {}
    if (logFileBytes > LOG_FILE_MAX) rotateLogFile(); // rotate during the run, not just at open
  }
}

function rotateLogFile() {
  if (logRotating || !logFileStream || !logFilePath) return;
  logRotating = true;
  try {
    const old = logFileStream;
    logFileStream = null;
    try { old.end(); } catch (_) {}
    try { fs.unlinkSync(logFilePath + '.1'); } catch (_) {}
    try { fs.renameSync(logFilePath, logFilePath + '.1'); } catch (_) {}
  } catch (_) {}
  openLogFile();
  logRotating = false;
}

{
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { pushLogLine('info', a); try { origLog(...a); } catch (_) {} };
  console.warn = (...a) => { pushLogLine('warn', a); try { origWarn(...a); } catch (_) {} };
  console.error = (...a) => { pushLogLine('error', a); try { origErr(...a); } catch (_) {} };
}

// ~/.pulse — the ONLY place Pulse ever writes (sidecar log, config, logs).
function pulseHome() {
  return process.env.PULSE_HOME || path.join(os.homedir(), '.pulse');
}

function configFilePath() { return path.join(pulseHome(), 'config.json'); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) || {}; } catch (_) { return {}; }
}

function openLogFile() {
  try {
    fs.mkdirSync(pulseHome(), { recursive: true });
    const p = path.join(pulseHome(), 'pulse.log');
    logFilePath = p;
    try { // rotate an oversized file from a previous run
      const st = fs.statSync(p);
      if (st.size > LOG_FILE_MAX) { try { fs.unlinkSync(p + '.1'); } catch (_) {} fs.renameSync(p, p + '.1'); }
    } catch (_) {}
    logFileBytes = 0;
    try { logFileBytes = fs.statSync(p).size; } catch (_) {}
    const s = fs.createWriteStream(p, { flags: 'a' });
    // An async write error (disk full, folder removed) must never crash the
    // hidden daemon — drop file logging and keep the ring buffer working.
    s.on('error', () => {
      try { s.destroy(); } catch (_) {}
      if (logFileStream === s) logFileStream = null;
    });
    logFileStream = s;
  } catch (_) {}
}

// Wrap a callback so multiple emission paths (stream error + end, request
// error + timeout) can never fire it twice — a double res.writeHead from a
// double callback would crash the whole server.
function once(fn) {
  let called = false;
  return function (...a) { if (called) return; called = true; return fn && fn(...a); };
}

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
  if (e.provider === 'openai') {
    const p = priceForOpenAI(e.model);
    const cachedPrice = p.cachedInput != null ? p.cachedInput : p.input * OPENAI_CACHE_READ_MULT;
    return (
      (e.inputTokens  / 1e6) * p.input +
      (e.outputTokens / 1e6) * p.output +
      (e.cacheRead    / 1e6) * cachedPrice
    );
  }
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
// OPENAI / CODEX PRICING
// $/MTok at OpenAI API list prices (platform.openai.com/pricing). On a
// ChatGPT Plus/Pro subscription these are relative-usage estimates, exactly
// like the Claude table above. Cached input bills at ~10% of the input price
// for the gpt-5 family; output prices include reasoning tokens.
// ---------------------------------------------------------------------------
// Each row: { input, output, cachedInput } in $/MTok. cachedInput is the
// published cached-input rate for that model (it is NOT a fixed fraction of
// input across the lineup: 10% for gpt-5 family, 25% for o3/o4-mini/gpt-4.1,
// 50% for gpt-4o/o3-mini; models without cache discounts bill cached at full
// input price). Rows without cachedInput default to 10% of input.
const PRICING_OPENAI = {
  // Codex defaults (gpt-5.x family)
  'gpt-5.6-sol':        { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.6':            { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2,   cachedInput: 0.025 },
  'gpt-5.1-codex-max':  { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.1-codex':      { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5.1':            { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5-codex':        { input: 1.25, output: 10,  cachedInput: 0.125 },
  'gpt-5-mini':         { input: 0.25, output: 2,   cachedInput: 0.025 },
  'gpt-5-nano':         { input: 0.05, output: 0.4, cachedInput: 0.005 },
  'gpt-5-pro':          { input: 15,   output: 120, cachedInput: 15 },
  'gpt-5':              { input: 1.25, output: 10,  cachedInput: 0.125 },
  'codex-mini-latest':  { input: 1.5,  output: 6,   cachedInput: 0.375 },
  // Older strings that can appear in history. NOTE: unlike Anthropic's dated
  // snapshots, OpenAI suffixes (-mini/-pro/-nano) are DIFFERENT models at
  // different prices — each needs its own exact row.
  'o3-deep-research':   { input: 10,   output: 40,  cachedInput: 2.5 },
  'o3-mini':            { input: 1.1,  output: 4.4, cachedInput: 0.55 },
  'o3-pro':             { input: 20,   output: 80,  cachedInput: 20 },
  'o3':                 { input: 2,    output: 8,   cachedInput: 0.5 },
  'o4-mini':            { input: 1.1,  output: 4.4, cachedInput: 0.275 },
  'gpt-4.1-mini':       { input: 0.4,  output: 1.6, cachedInput: 0.1 },
  'gpt-4.1-nano':       { input: 0.1,  output: 0.4, cachedInput: 0.025 },
  'gpt-4.1':            { input: 2,    output: 8,   cachedInput: 0.5 },
  'gpt-4o-mini':        { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'gpt-4o':             { input: 2.5,  output: 10,  cachedInput: 1.25 },
  // Fallback for unknown / new model strings (logged once, same as Claude).
  '__default__':        { input: 1.25, output: 10 },
};
const OPENAI_CACHE_READ_MULT = 0.10; // default when a row has no cachedInput

function priceForOpenAI(model) {
  let p = PRICING_OPENAI[model];
  if (!p) {
    // Prefix fallback ONLY for dated snapshots ("gpt-4.1-2025-04-14"). OpenAI
    // family suffixes (-mini/-pro/-nano) are different models at different
    // prices, so any non-date remainder falls through to the logged default —
    // mispricing must be visible, never silent.
    let best = '';
    for (const key of Object.keys(PRICING_OPENAI)) {
      if (key === '__default__' || !model.startsWith(key) || key.length <= best.length) continue;
      const rest = model.slice(key.length);
      if (/^-(\d{4}-\d{2}-\d{2}|\d{8})$/.test(rest)) best = key;
    }
    if (best) p = PRICING_OPENAI[best];
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING_OPENAI.__default__;
  }
  return p;
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

// OpenAI Codex CLI home (same read-only rules as ~/.claude). Codex writes
// rollout logs to ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
function codexDir() {
  return process.env.CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexSessionsRoot() {
  return path.join(codexDir(), 'sessions');
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

// Reasoning-effort level names Claude Code accepts for `/effort` (ultracode is
// handled separately — it is xhigh plus workflow orchestration, shown as ULTRA).
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Detect a local-command user record (`/effort`, `/model`, …). Claude Code
// writes these into the transcript as XML-ish tags:
//   <command-name>/effort</command-name> ... <command-args>max</command-args>
// and echoes their output in a follow-up <local-command-stdout> record.
// Returns { name, args } for a command record, { name: '', args: '' } for a
// stdout echo, or null for a real prompt.
function parseLocalCommand(txt) {
  const m = /<command-name>\s*(\/[\w:.-]+)\s*<\/command-name>/.exec(txt);
  if (m) {
    const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(txt);
    return { name: m[1], args: a ? a[1].trim() : '' };
  }
  if (txt.indexOf('<local-command-stdout>') !== -1) return { name: '', args: '' };
  return null;
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
    provider: 'anthropic',
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
  const effortEvents = [];      // time-stamped /effort changes parsed from the transcript

  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue; // partial/truncated line — skip
    }
    if (!rec || typeof rec !== 'object') continue;

    // Each user record is either a real prompt or a local-command invocation
    // (`/effort`, `/model`, …, plus their <local-command-stdout> echoes).
    if (rec.type === 'user') {
      const sid = rec.sessionId || '';
      const txt = userText(rec);
      const cmd = parseLocalCommand(txt);
      // First real prompt per session → title fallback (commands make bad titles).
      if (sid && !cmd && !sessionMeta[sid]) {
        sessionMeta[sid] = {
          firstUserText: txt.trim(),
          project: rec.cwd || '',
        };
      }
      if (cmd) {
        // `/effort <level>` applies to the live session only and is persisted
        // nowhere — but the invocation IS in the transcript. Parse it into a
        // time-stamped event: works retroactively, no hook required.
        if (sid && cmd.name === '/effort' && cmd.args) {
          const ts = Date.parse(rec.timestamp);
          const lvl = cmd.args.toLowerCase().split(/\s+/)[0];
          if (isFinite(ts)) {
            if (lvl === 'ultracode') effortEvents.push({ sessionId: sid, ts, effort: null, ultracode: true });
            else if (EFFORT_LEVELS.has(lvl)) effortEvents.push({ sessionId: sid, ts, effort: lvl, ultracode: false });
          }
        }
        // Command records (incl. stdout echoes like "Set effort level to
        // ultracode") are not prompt text — never keyword-flag from them.
      } else if (sid && /\bultracode\b/i.test(txt)) {
        // The keyword in a real prompt opts the whole session in — works
        // retroactively, even before any effort source was set up.
        ultracodeSessions.push(sid);
      }
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
  return { entries, sessionMeta, ultracodeSessions, effortEvents };
}

// ---------------------------------------------------------------------------
// OPENAI CODEX PARSER
// Codex rollout files are JSONL event streams:
//   {"timestamp":"ISO","type":"session_meta"|"turn_context"|"event_msg"|…,
//    "payload":{…}}
// Usage arrives in event_msg payloads of type "token_count":
//   payload.info.last_token_usage   — this turn's usage (preferred)
//   payload.info.total_token_usage  — cumulative session usage (delta fallback)
// with { input_tokens (INCLUDES cached), cached_input_tokens, output_tokens
// (includes reasoning), reasoning_output_tokens, total_tokens }.
// Model + reasoning effort come from turn_context; the session id, cwd and
// first user prompt from session_meta / user_message events.
// Shapes verified against a real rollout written by codex 0.144.3.
// ---------------------------------------------------------------------------
function diffUsage(tot, prev) {
  const d = {};
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
    d[k] = Math.max(0, num(tot[k]) - num(prev[k]));
  }
  return d;
}

function parseCodexFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null; // locked mid-write — retry next request, do not cache
  }
  const entries = [];
  const sessionMeta = {};
  let sid = '';
  let project = '';
  let model = 'gpt-unknown';
  let effort = null;
  let prevTotal = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; } // partial trailing write
    if (!rec || typeof rec !== 'object') continue;
    const p = rec.payload || {};

    if (rec.type === 'session_meta') {
      sid = p.session_id || p.id || sid;
      project = p.cwd || project;
      if (sid && !sessionMeta[sid]) sessionMeta[sid] = { firstUserText: '', project };
      continue;
    }
    if (rec.type === 'turn_context') {
      if (p.model) model = String(p.model);
      const eff = p.effort ||
        (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort);
      if (eff) effort = String(eff);
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'user_message') {
      if (sid && sessionMeta[sid] && !sessionMeta[sid].firstUserText && typeof p.message === 'string') {
        sessionMeta[sid].firstUserText = p.message.replace(/\s+/g, ' ').trim();
      }
      continue;
    }
    if (rec.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info || {};
      const ts = Date.parse(rec.timestamp);
      if (!isFinite(ts)) continue;
      const tot = info.total_token_usage || null;
      let u = info.last_token_usage || null;
      if (!u && tot) u = prevTotal ? diffUsage(tot, prevTotal) : tot;
      if (tot) prevTotal = tot;
      if (!u) continue;
      const input = num(u.input_tokens), cached = num(u.cached_input_tokens), output = num(u.output_tokens);
      if (input + output <= 0) continue;
      const e = {
        ts,
        provider: 'openai',
        model,
        source: 'codex',
        speed: 'standard',
        serviceTier: 'standard',
        // OpenAI semantics: input INCLUDES cached; split so tokensOf() and the
        // cache-discounted cost both come out right.
        inputTokens: Math.max(0, input - cached),
        outputTokens: output,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: cached,
        webSearches: 0,
        sessionId: sid || path.basename(filePath, '.jsonl'),
        project,
        // Parse-time effort lives in its own immutable field; annotateModes
        // seeds from it every pass, so e.effort stays a pure per-pass output
        // (cached entries are re-annotated on every request).
        parseEffort: effort,
        // Replay-safe key: a resumed rollout replaying the same cumulative
        // snapshot at the same timestamp dedups to one entry. Falls back to
        // the filename so sid-less files can never collide with each other.
        key: 'cx:' + (sid || path.basename(filePath, '.jsonl')) + ':' + ts + ':' + (tot ? num(tot.total_tokens) : input + output),
      };
      e.cost = costForEntry(e);
      entries.push(e);
      continue;
    }
  }
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Walk all files; reuse cached parse when mtime is unchanged. Returns the merged
// (globally deduped) entry list plus a merged sessionId->meta map. Logs a
// one-line "parsed X, skipped Y (cached)" so the mtime cache is observable.
function parseAll() {
  const walkT0 = Date.now();
  const claudeFiles = walkJsonl(projectsRoot());
  const codexFiles = walkJsonl(codexSessionsRoot());
  const walkMs = Date.now() - walkT0;
  const codexSet = new Set(codexFiles);
  const files = claudeFiles.concat(codexFiles);
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
    const result = codexSet.has(f) ? parseCodexFile(f) : parseFile(f);
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
      effortEvents: result.effortEvents || [],
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
  const effortEvents = [];
  for (const { entries, sessionMeta: sm, ultracodeSessions: us, effortEvents: ev } of fileCache.values()) {
    for (const e of entries) {
      if (globalSeen.has(e.key)) continue;
      globalSeen.add(e.key);
      merged.push(e);
    }
    for (const sid of us || []) ultracodeSessions.add(sid);
    for (const e of ev || []) effortEvents.push(e);
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

  console.log(`[pulse] walked ${files.length} file(s) (${claudeFiles.length} claude, ${codexFiles.length} codex) in ${walkMs}ms; parsed ${parsed}, skipped ${skipped} (cached)${failed ? `, ${failed} unreadable (will retry)` : ''}; ${merged.length} unique usage records`);
  return {
    entries: merged, sessionMeta, ultracodeSessions, effortEvents,
    fileCount: files.length, codexFileCount: codexFiles.length,
  };
}

// ---------------------------------------------------------------------------
// EFFORT / MODE SOURCES
//
// Two complementary sources reconstruct the reasoning effort level:
//   1. `/effort <level>` commands parsed straight out of the transcripts
//      (parseFile) — session-scoped changes, retroactive, zero setup.
//   2. An optional hook (see --effort-setup) that logs the settings-persisted
//      effortLevel to a sidecar JSONL — catches levels applied across sessions
//      without a per-session /effort command. One line per change:
//        { ts, sessionId, event, effort, ultracode?, model? }
// Both are merged (mergeModes) into per-session state snapshots and
// time-joined onto entries (annotateModes). The sidecar is cached by mtime
// like transcript files, and lives outside ~/.claude on purpose.
// ---------------------------------------------------------------------------

function modesFilePath() {
  return process.env.PULSE_MODES_FILE || path.join(pulseHome(), 'modes.jsonl');
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

// Merge the hook sidecar with transcript-parsed /effort events into one
// per-session, time-sorted snapshot list. Copies the cached sidecar arrays —
// never mutates them.
function mergeModes(sidecarBySession, effortEvents) {
  const out = {};
  for (const sid of Object.keys(sidecarBySession || {})) out[sid] = sidecarBySession[sid].slice();
  for (const ev of effortEvents || []) {
    if (!ev.sessionId) continue;
    (out[ev.sessionId] = out[ev.sessionId] || []).push({ ts: ev.ts, effort: ev.effort || null, ultracode: !!ev.ultracode });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.ts - b.ts);
  return out;
}

// Annotate entries in place with { effort, ultracode }. Mode records — hook
// sidecar lines and transcript /effort events — are state snapshots; each
// entry takes the latest snapshot at or before it in its session. So an
// /effort mid-session applies from that point on, and switching (e.g.
// ultracode → max) turns the previous state off. The ultracode keyword in a
// real prompt still opts the whole session in.
function annotateModes(entriesAsc, modesBySession, ultracodeSessions) {
  for (const e of entriesAsc) {
    // Codex entries carry effort from their rollout's turn_context, stored in
    // the immutable parseEffort field. Seed from THAT (never from e.effort,
    // which is this function's own output — cached entries are re-annotated
    // every request and must not feed a prior pass back in as input).
    let effort = e.parseEffort || null;
    let ultra = ultracodeSessions.has(e.sessionId);
    const recs = modesBySession[e.sessionId];
    if (recs && recs.length) {
      let chosen = null;
      for (const r of recs) {
        if (r.ts <= e.ts) chosen = r; else break;
      }
      if (chosen) {
        effort = chosen.effort;
        if (chosen.ultracode) ultra = true;
      }
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
  // Claude entries only: the 5h window is CLAUDE's rate-limit concept; Codex
  // has its own separate limits and must not distort the reset countdown.
  const claudeAsc = asc.filter((e) => e.provider !== 'openai');
  const rawBlocks = computeBlocks(claudeAsc);
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

  // every block's entries ⊆ Claude entries (blocks are Claude-only; Codex has
  // its own limit windows and is excluded from block reconstruction)
  const blockEntryCount = rawBlocks.reduce((a, b) => a + b.entries.length, 0);
  const claudeCount = asc.reduce((a, e) => a + (e.provider !== 'openai' ? 1 : 0), 0);
  if (blockEntryCount !== claudeCount) {
    issues.push(`block entries (${blockEntryCount}) != claude entries (${claudeCount})`);
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
  const { entries, sessionMeta, ultracodeSessions, effortEvents, fileCount, codexFileCount } = parseAll();
  const desktopTitles = readDesktopTitles();
  const now = Date.now();
  const payload = aggregate(entries, sessionMeta, desktopTitles, now,
    mergeModes(readModes(), effortEvents), ultracodeSessions);
  // Surface what Pulse is actually reading, so a wrong-directory setup (e.g.
  // Claude Code under WSL while Pulse runs in native Windows) is diagnosable.
  payload.claudeDir = claudeDir();
  payload.fileCount = fileCount;
  payload.codexDir = codexDir();
  payload.codexFileCount = codexFileCount || 0;
  payload.hasCodex = (codexFileCount || 0) > 0;
  // Server panel: identity + update state.
  payload.version = PULSE_VERSION;
  payload.serverStartTs = SERVER_START;
  payload.pid = process.pid;
  payload.daemon = IS_DAEMON_CHILD;
  payload.packaged = !!seaApi;
  payload.update = updateState;
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

// ---------------------------------------------------------------------------
// UPDATES
// The ONLY network calls Pulse ever makes, and only when enabled (default on;
// --no-update-check / PULSE_NO_UPDATE_CHECK / {"updateCheck":false} in
// ~/.pulse/config.json disable it):
//   - check: GET the GitHub Releases API for the latest version tag
//   - install (packaged builds, user-clicked): download the platform asset,
//     verify its sha256 digest from the API, swap executables via rename
//     (a running exe can be renamed, just not deleted), relaunch, exit.
// Any failure leaves the current install untouched and points at the
// releases page instead. No usage data is ever transmitted.
// ---------------------------------------------------------------------------
const UPDATE_REPO = 'ReFxFrank/claudeusage';
const RELEASES_PAGE = 'https://github.com/' + UPDATE_REPO + '/releases';
const UPDATE_API_URL = process.env.PULSE_UPDATE_API ||
  'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';

const updateState = {
  status: 'idle', // idle | checking | uptodate | available | downloading | installing | error
  current: PULSE_VERSION,
  latest: null,
  error: null,
  checkedAt: null,
  installSupported: false, // packaged build with a downloadable asset
  releasesUrl: RELEASES_PAGE,
};
let updateAsset = null; // { url, digest, size, name } for this platform

function versionNum(v) {
  const p = String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0);
}

// Minimal GET with redirect-following (release assets 302 to a CDN). http is
// accepted only for the PULSE_UPDATE_API test override; production URLs are
// https.
function fetchUrl(u, opts, cb) {
  cb = once(cb); // error + end / timeout can otherwise both fire it
  const { asStream = false, timeoutMs = 20000, redirects = 5 } = opts || {};
  let mod;
  try { mod = u.startsWith('https:') ? require('https') : http; } catch (e) { return cb(e); }
  const req = mod.get(u, {
    headers: {
      'User-Agent': 'pulse-usage-dashboard/' + PULSE_VERSION,
      'Accept': 'application/vnd.github+json, application/octet-stream, */*',
    },
    timeout: timeoutMs,
  }, (res) => {
    const sc = res.statusCode || 0;
    if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
      res.resume();
      let next;
      try { next = new URL(res.headers.location, u).toString(); } catch (e) { return cb(e); }
      return fetchUrl(next, { asStream, timeoutMs, redirects: redirects - 1 }, cb);
    }
    if (sc !== 200) { res.resume(); return cb(new Error('HTTP ' + sc)); }
    if (asStream) return cb(null, res);
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; if (body.length > 4e6) req.destroy(new Error('response too large')); });
    res.on('end', () => cb(null, body));
    res.on('error', (e) => cb(e));
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (e) => cb(e));
}

function platformAssetName() {
  if (process.platform === 'win32') return 'pulse.exe';
  if (process.platform === 'darwin') return 'pulse-macos';
  return 'pulse-linux';
}

function checkForUpdate(done) {
  if (['checking', 'downloading', 'installing'].includes(updateState.status)) {
    return done && done(updateState);
  }
  updateState.status = 'checking';
  updateState.error = null;
  fetchUrl(UPDATE_API_URL, {}, (err, body) => {
    updateState.checkedAt = Date.now();
    if (err) {
      updateState.status = 'error';
      updateState.error = 'update check failed: ' + err.message;
      console.warn('[pulse] ' + updateState.error);
      return done && done(updateState);
    }
    let rel = null;
    try { rel = JSON.parse(body); } catch (_) {}
    const tag = rel && (rel.tag_name || rel.name);
    if (!tag) {
      updateState.status = 'error';
      updateState.error = 'update check failed: unexpected API response';
      return done && done(updateState);
    }
    updateState.latest = String(tag).replace(/^v/i, '');
    const want = platformAssetName();
    const a = (Array.isArray(rel.assets) ? rel.assets : []).find((x) => x && x.name === want);
    updateAsset = a ? {
      url: a.browser_download_url || a.url,
      digest: typeof a.digest === 'string' ? a.digest.replace(/^sha256:/, '') : null,
      size: a.size || 0,
      name: a.name,
    } : null;
    if (versionNum(updateState.latest) > versionNum(PULSE_VERSION)) {
      updateState.status = 'available';
      // One-click install requires a verifiable download: no published sha256
      // digest → the UI offers the releases page instead (fail closed).
      updateState.installSupported = !!(seaApi && updateAsset && updateAsset.url && updateAsset.digest);
      console.log(`[pulse] update available: v${updateState.latest} (running v${PULSE_VERSION}) — ${RELEASES_PAGE}`);
    } else {
      updateState.status = 'uptodate';
      console.log(`[pulse] up to date (v${PULSE_VERSION})`);
    }
    done && done(updateState);
  });
}

function installUpdate(done) {
  done = once(done);
  if (updateState.status !== 'available') return done(new Error('no update staged — run a check first'));
  if (!seaApi) return done(new Error('running from source — update with git pull'));
  if (!updateAsset || !updateAsset.url) return done(new Error('no downloadable asset for this platform'));
  // Integrity is not optional: without a published digest there is nothing to
  // verify the download against, so refuse and point at the releases page.
  if (!updateAsset.digest) return done(new Error('release asset has no sha256 digest — download manually: ' + RELEASES_PAGE));

  const exePath = process.execPath;
  const downloadPath = exePath + '.download';
  const oldPath = exePath + '.old';
  updateState.status = 'downloading';
  updateState.error = null;
  console.log(`[pulse] downloading v${updateState.latest} (${updateAsset.name})…`);

  fetchUrl(updateAsset.url, { asStream: true, timeoutMs: 300000 }, (err, res) => {
    if (err) return failInstall('download failed: ' + err.message, done);
    let out;
    try { out = fs.createWriteStream(downloadPath); } catch (e) {
      return failInstall('cannot write next to the exe: ' + e.message, done);
    }
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    res.on('data', (d) => { hash.update(d); bytes += d.length; });
    res.on('error', (e) => { try { out.destroy(); } catch (_) {} failInstall('download failed: ' + e.message, done); });
    out.on('error', (e) => failInstall('write failed: ' + e.message, done));
    res.pipe(out);
    out.on('finish', () => {
      try {
        const digest = hash.digest('hex');
        if (bytes < 5 * 1024 * 1024) return failInstall(`download too small (${bytes} bytes)`, done);
        if (updateAsset.size > 0 && bytes !== updateAsset.size) {
          return failInstall(`size mismatch (got ${bytes}, expected ${updateAsset.size})`, done);
        }
        if (digest !== updateAsset.digest) { // digest presence enforced above
          return failInstall('sha256 mismatch — refusing to install', done);
        }
        updateState.status = 'installing';
        console.log(`[pulse] verified download (${(bytes / 1048576).toFixed(1)} MB, sha256 ok) — swapping executables`);
        try { fs.unlinkSync(oldPath); } catch (_) {}
        fs.renameSync(exePath, oldPath);
        try {
          fs.renameSync(downloadPath, exePath);
        } catch (e) {
          try { fs.renameSync(oldPath, exePath); } catch (_) {} // roll back
          throw e;
        }
        if (process.platform !== 'win32') { try { fs.chmodSync(exePath, 0o755); } catch (_) {} }
        done && done(null); // answer the HTTP request before the process exits
        if (process.env.PULSE_UPDATE_NO_RELAUNCH) {
          console.log('[pulse] PULSE_UPDATE_NO_RELAUNCH set — staying on the old process');
          return;
        }
        relaunchAfterUpdate(exePath);
      } catch (e) {
        try { fs.unlinkSync(downloadPath); } catch (_) {}
        failInstall('swap failed: ' + ((e && e.message) || e), done);
      }
    });
  });
}

function failInstall(msg, done) {
  updateState.status = 'error';
  updateState.error = msg + ' — download manually: ' + RELEASES_PAGE;
  console.error('[pulse] ' + updateState.error);
  try { fs.unlinkSync(process.execPath + '.download'); } catch (_) {}
  done && done(new Error(msg));
}

function relaunchAfterUpdate(exePath) {
  const passthrough = process.argv.slice(2).filter((a) => a !== '--after-update');
  // Respect an explicit console run: --no-daemon relaunches into a fresh
  // visible console window instead of silently going hidden.
  const wantConsole = passthrough.includes('--no-daemon');
  if (process.platform === 'win32' && !wantConsole && !passthrough.includes('--daemon-child')) {
    passthrough.push('--daemon-child');
  }
  console.log(`[pulse] restarting as v${updateState.latest}…`);
  if (wantConsole && process.platform === 'win32') {
    console.log('[pulse] (Pulse reopens in a new console window)');
  }
  const relaunchFailed = (e) => {
    updateState.status = 'error';
    updateState.error = 'relaunch failed: ' + ((e && e.message) || e) +
      ` — the new version is installed at ${exePath}; start it manually.`;
    console.error('[pulse] ' + updateState.error);
  };
  setTimeout(() => {
    let child;
    try {
      child = require('child_process').spawn(exePath, [...passthrough, '--after-update'],
        { detached: true, stdio: 'ignore', windowsHide: !wantConsole });
      child.unref();
    } catch (e) {
      relaunchFailed(e); // keep serving on the old process instead of dying
      return;
    }
    let failed = false;
    child.once('error', (e) => { failed = true; relaunchFailed(e); });
    // Exit only if the spawn didn't error out (ENOENT etc. fire quickly).
    setTimeout(() => { if (!failed) process.exit(0); }, 700);
  }, 300);
}

// After an update the previous exe sits renamed aside — remove it once it is
// no longer locked (called at startup; failures are retried on the next run).
function cleanupOldExecutable() {
  if (!seaApi) return;
  const oldPath = process.execPath + '.old';
  try {
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
      console.log('[pulse] removed previous version (' + path.basename(oldPath) + ')');
    }
  } catch (_) { /* still locked — next start */ }
  // A crash mid-download can strand a partial .download file too.
  try {
    const dl = process.execPath + '.download';
    if (fs.existsSync(dl)) fs.unlinkSync(dl);
  } catch (_) { /* next start */ }
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

// Guard for endpoints with side effects (stop, update). Any web page can fire
// simple POSTs at localhost, so require a custom header — that forces a CORS
// preflight no cross-origin page ever passes (we send no CORS headers) — plus
// a loopback source address and a localhost Host header (DNS-rebinding guard).
function allowMutation(req, res) {
  const ra = req.socket.remoteAddress || '';
  const isLoop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const hostHdr = String(req.headers.host || '')
    .replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (req.method === 'POST' && isLoop && LOOPBACK_HOSTS.has(hostHdr) && req.headers['x-pulse'] === '1') {
    return true;
  }
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
  return false;
}

// DNS-rebinding guard for data reads. A malicious page can point its own
// hostname at 127.0.0.1 and fetch same-origin — the browser then happily
// exposes the response. When Pulse is bound to loopback, only answer requests
// whose Host header is a loopback name. (An explicit --host network bind is
// the documented VPS opt-in, where foreign Hosts are expected.)
function allowRead(req, res, boundLoopback) {
  if (!boundLoopback) return true;
  const hostHdr = String(req.headers.host || '')
    .replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(hostHdr)) return true;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
  return false;
}

// Probe whether a running instance answers /api/health on the port.
// cb receives { kind: 'pulse', version } | { kind: 'other' } | { kind: 'free' }.
function probeInstance(port, cb) {
  cb = once(cb); // error/timeout/end can otherwise race a double call
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (j && j.ok) return cb({ kind: 'pulse', version: j.version || null });
      } catch (_) {}
      cb({ kind: 'other' });
    });
    res.on('error', () => cb({ kind: 'other' }));
  });
  req.on('timeout', () => { req.destroy(); cb({ kind: 'other' }); });
  req.on('error', (e) => cb(e && e.code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'other' }));
}

// Port taken — say WHO has it. The classic upgrade trap is double-clicking a
// new pulse.exe while the old one still runs; name that case explicitly.
function diagnosePortConflict(port) {
  probeInstance(port, (inst) => {
    if (inst.kind === 'pulse') {
      const v = inst.version ? 'v' + inst.version : 'an older version (v1.0.3 or earlier)';
      console.error(`\n[pulse] Another Pulse — ${v} — is already running on port ${port}.`);
      if (inst.version === PULSE_VERSION) {
        console.error(`[pulse] The dashboard is already available: http://localhost:${port}`);
      } else {
        console.error(`[pulse] This is v${PULSE_VERSION}. Stop the old one first — from its dashboard`);
        console.error('[pulse] (Server panel → Stop), its console window, or Task Manager →');
        console.error('[pulse] pulse.exe → End task — then run this again.');
      }
    } else {
      console.error(`\n[pulse] Port ${port} is already in use by another program.`);
      console.error('[pulse] Try: --port 4748   (or set PORT=)');
    }
    holdOpenAndExit(1);
  });
}

// A double-clicked exe's console closes with the process — pause so the
// message is actually readable. No-op when piped, scripted, or headless.
function holdOpenAndExit(code) {
  if (seaApi && process.platform === 'win32' && process.stdin.isTTY && !IS_DAEMON_CHILD) {
    console.error('\nPress Enter to close…');
    try {
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(code));
      return;
    } catch (_) {}
  }
  process.exit(code);
}

function openBrowser(port) {
  if (process.platform !== 'win32') return;
  // windowsHide: launched from the hidden daemon, cmd.exe must not flash a
  // console; `start` (ShellExecute) still opens the default browser fine.
  try { require('child_process').exec(`start "" "http://localhost:${port}"`, { windowsHide: true }); } catch (_) {}
}

function startServer(port, host, opts) {
  const boundLoopback = LOOPBACK_HOSTS.has(host);
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    const route = parsed.pathname;

    try {
      // Every API route — including plain reads — refuses foreign Host
      // headers on a loopback bind (DNS-rebinding guard). Mutations add
      // stricter checks on top (allowMutation).
      if (route.startsWith('/api/') && !allowRead(req, res, boundLoopback)) return;
      if (route === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: PULSE_VERSION, pid: process.pid }));
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
      if (route === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ lines: logRing }));
        return;
      }
      if (route === '/api/shutdown') {
        if (!allowMutation(req, res)) return;
        console.log('[pulse] stop requested — shutting down');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stopping: true }));
        setTimeout(() => {
          try { server.close(() => process.exit(0)); } catch (_) {}
          setTimeout(() => process.exit(0), 1000);
        }, 200);
        return;
      }
      if (route === '/api/update/check') {
        if (!allowMutation(req, res)) return;
        checkForUpdate((st) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(st));
        });
        return;
      }
      if (route === '/api/update/install') {
        if (!allowMutation(req, res)) return;
        installUpdate((err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err
            ? { ok: false, error: err.message, state: updateState }
            : { ok: true, state: updateState }));
        });
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

  // After an update (or when replacing an older instance) the old process may
  // hold the port for a moment — retry briefly instead of giving up.
  const retryBindUntil = (opts && opts.retryBindUntil) || 0;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      if (Date.now() < retryBindUntil) {
        setTimeout(() => { try { server.listen(port, host); } catch (_) {} }, 400);
        return;
      }
      diagnosePortConflict(port);
      return;
    }
    throw err;
  });

  // Local-only by default: bind to loopback (§2). A non-loopback host is an
  // explicit opt-in (--host / HOST) for VPS/LAN use and is warned about.
  server.listen(port, host, () => {
    console.log(`\n  Pulse v${PULSE_VERSION} — Claude Code usage dashboard`);
    console.log(`  reading (read-only): ${claudeDir()}`);
    console.log(`  listening: http://${host}:${port}${IS_DAEMON_CHILD ? '  (background)' : ''}`);
    // Packaged exe on Windows: open the dashboard for the user.
    if (seaApi && process.platform === 'win32' && (!opts || opts.open !== false) && LOOPBACK_HOSTS.has(host)) {
      openBrowser(port);
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
    cleanupOldExecutable();
    if (opts && opts.updateCheck) {
      setTimeout(() => checkForUpdate(), 2500);
      const iv = setInterval(() => checkForUpdate(), 24 * 3600 * 1000);
      if (iv.unref) iv.unref();
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
// BACKGROUND MODE (Windows packaged exe)
// Double-clicking pulse.exe should not leave a console window around: the
// visible parent preflights the port (so conflicts are readable — including
// auto-replacing an older running Pulse), then hands off to a hidden child
// (--daemon-child) that logs to ~/.pulse/pulse.log and is controlled from the
// dashboard's Server panel. --no-daemon keeps it in the console.
// ---------------------------------------------------------------------------
function shouldDaemonize(args) {
  return !!(seaApi && process.platform === 'win32' && !args.daemonChild && !args.noDaemon);
}

function daemonize(args, port, host) {
  probeInstance(port, (inst) => {
    // Same version OR NEWER already running → just open its dashboard. Never
    // auto-replace a newer Pulse with an older exe (silent downgrade).
    if (inst.kind === 'pulse' && versionNum(inst.version) >= versionNum(PULSE_VERSION)) {
      console.log(`[pulse] v${inst.version || PULSE_VERSION} is already running — opening the dashboard.`);
      openBrowser(port);
      setTimeout(() => process.exit(0), 1200);
      return;
    }
    if (inst.kind === 'pulse') {
      // An OLDER Pulse holds the port. v1.1.0+ accepts a local stop request;
      // anything older must be closed by hand.
      console.log(`[pulse] replacing running Pulse ${inst.version ? 'v' + inst.version : '(pre-1.1.0)'}…`);
      requestShutdown(port, (ok) => {
        if (!ok) {
          console.error('\n[pulse] The running Pulse is too old to stop automatically.');
          console.error('[pulse] Close it (Task Manager → pulse.exe → End task), then run this again.');
          holdOpenAndExit(1);
          return;
        }
        waitForPortFree(port, 8000, (free) => {
          if (!free) {
            console.error('[pulse] The old instance did not exit — close it manually and retry.');
            holdOpenAndExit(1);
            return;
          }
          spawnDaemon(args, port, host);
        });
      });
      return;
    }
    if (inst.kind === 'other') {
      console.error(`\n[pulse] Port ${port} is already in use by another program.`);
      console.error('[pulse] Try: pulse.exe --port 4748');
      holdOpenAndExit(1);
      return;
    }
    spawnDaemon(args, port, host);
  });
}

function requestShutdown(port, cb) {
  cb = once(cb);
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST',
    headers: { 'X-Pulse': '1', 'Host': 'localhost' }, timeout: 2500,
  }, (res) => {
    // Pre-1.1.0 Pulse serves the SPA fallback (200 text/html) for unknown
    // routes — only a real {ok:true} JSON acknowledgment counts as stopped.
    let body = '';
    res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    res.on('end', () => {
      let ok = false;
      try { ok = res.statusCode === 200 && JSON.parse(body).ok === true; } catch (_) {}
      cb(ok);
    });
    res.on('error', () => cb(false));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}

function waitForPortFree(port, ms, cb) {
  const deadline = Date.now() + ms;
  (function poll() {
    probeInstance(port, (inst) => {
      if (inst.kind === 'free') return cb(true);
      if (Date.now() > deadline) return cb(false);
      setTimeout(poll, 350);
    });
  })();
}

function spawnDaemon(args, port, host) {
  const passthrough = process.argv.slice(2).filter((a) => a !== '--no-daemon');
  try {
    const child = require('child_process').spawn(process.execPath, [...passthrough, '--daemon-child'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    console.error('[pulse] failed to start the background process: ' + e.message);
    console.error('[pulse] falling back to running in this window.');
    startServer(port, host, serverOpts(args));
    return;
  }
  console.log(`\n  Pulse v${PULSE_VERSION} is starting in the background.`);
  console.log(`  Dashboard: http://localhost:${port}  (opens automatically)`);
  console.log(`  Logs, updates and Stop live in the dashboard's Server panel.`);
  console.log('  Tip: pulse.exe --install-shortcuts adds Start/Stop buttons to your Desktop.');
  console.log('  (Run with --no-daemon to keep it in a console window.)');
  setTimeout(() => process.exit(0), 2500);
}

// ---------------------------------------------------------------------------
// START / STOP CONVENIENCES
// `--stop` stops a running instance from anywhere (shortcut, script, console).
// `--install-shortcuts` (Windows) drops "Pulse" (start / open dashboard —
// starting is idempotent) and "Pulse - Stop" shortcuts on the Desktop: a real
// start/stop button pair, since a stopped server cannot render one.
// ---------------------------------------------------------------------------
function stopRunning(port) {
  // Double-clicked stop shortcut: keep the window up long enough to read.
  const exitSoon = (code) => setTimeout(() => process.exit(code),
    seaApi && process.platform === 'win32' && process.stdin.isTTY ? 1600 : 0);
  probeInstance(port, (inst) => {
    if (inst.kind === 'free') {
      console.log(`[pulse] nothing is running on port ${port}.`);
      return exitSoon(0);
    }
    if (inst.kind === 'other') {
      console.log(`[pulse] port ${port} is in use by another program — nothing to stop.`);
      return exitSoon(1);
    }
    requestShutdown(port, (ok) => {
      if (!ok) {
        console.error(`[pulse] the running Pulse (${inst.version ? 'v' + inst.version : 'pre-1.1.0'}) does not support remote stop.`);
        console.error('[pulse] Close it via Task Manager → pulse.exe → End task.');
        return exitSoon(1);
      }
      waitForPortFree(port, 8000, (free) => {
        console.log(free
          ? `[pulse] stopped Pulse ${inst.version ? 'v' + inst.version + ' ' : ''}on port ${port}.`
          : '[pulse] stop acknowledged — the instance is taking a while to exit.');
        exitSoon(free ? 0 : 1);
      });
    });
  });
}

function installShortcuts() {
  if (process.platform !== 'win32') {
    console.log('[pulse] Desktop shortcuts are Windows-only.');
    console.log('[pulse] Start: run the binary (idempotent). Stop: --stop.');
    return;
  }
  if (!seaApi) {
    console.log('[pulse] run this from the packaged pulse.exe so shortcuts point at it.');
    return;
  }
  const exe = process.execPath.replace(/'/g, "''"); // PS single-quote escape
  const ps = [
    "$W = New-Object -ComObject WScript.Shell;",
    "$d = [Environment]::GetFolderPath('Desktop');",
    "$s = $W.CreateShortcut((Join-Path $d 'Pulse.lnk'));",
    `$s.TargetPath = '${exe}';`,
    "$s.Description = 'Start Pulse (opens the dashboard if already running)';",
    "$s.Save();",
    "$t = $W.CreateShortcut((Join-Path $d 'Pulse - Stop.lnk'));",
    `$t.TargetPath = '${exe}';`,
    "$t.Arguments = '--stop';",
    "$t.Description = 'Stop the running Pulse';",
    "$t.Save();",
  ].join(' ');
  try {
    require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    console.log('[pulse] created Desktop shortcuts:');
    console.log('  "Pulse"        — start (or open the dashboard if already running)');
    console.log('  "Pulse - Stop" — stop the running Pulse');
  } catch (e) {
    console.error('[pulse] could not create shortcuts: ' + ((e && e.message) || e));
  }
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
  console.log('Pulse already reads `/effort <level>` commands straight from your');
  console.log('session transcripts — that needs NO setup and works retroactively.');
  console.log('This optional hook covers the one remaining case: an effort level');
  console.log('persisted in settings.json (applied across sessions) rather than');
  console.log('set per-session with /effort.');
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
  const out = {
    port: null, host: null, inspectSchema: false, modeHook: false, effortSetup: false,
    noOpen: false, noDaemon: false, daemonChild: false, afterUpdate: false,
    noUpdateCheck: false, version: false,
  };
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
    else if (a === '--no-daemon') { out.noDaemon = true; }
    else if (a === '--daemon-child') { out.daemonChild = true; }
    else if (a === '--after-update') { out.afterUpdate = true; }
    else if (a === '--no-update-check') { out.noUpdateCheck = true; }
    else if (a === '--stop') { out.stop = true; }
    else if (a === '--install-shortcuts') { out.installShortcuts = true; }
    else if (a === '--version' || a === '-v') { out.version = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function updateCheckEnabled(args) {
  if (args.noUpdateCheck || process.env.PULSE_NO_UPDATE_CHECK) return false;
  return readConfig().updateCheck !== false;
}

function serverOpts(args) {
  return {
    // After a self-update the existing dashboard tab reloads itself — opening
    // another tab would duplicate it.
    open: !args.noOpen && !args.afterUpdate,
    updateCheck: updateCheckEnabled(args),
    // an updated/replacing instance may need a moment for the old one's port
    retryBindUntil: (args.afterUpdate || args.daemonChild) ? Date.now() + 10000 : 0,
  };
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
    console.log(`Pulse v${PULSE_VERSION} — local Claude Code usage dashboard\n`);
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
    console.log('  --stop            stop the running Pulse instance and exit');
    console.log('  --install-shortcuts  (Windows) add "Pulse" and "Pulse - Stop"');
    console.log('                    shortcuts to the Desktop');
    console.log('  --no-daemon       (Windows exe) keep running in this console window');
    console.log('                    instead of backgrounding');
    console.log('  --no-update-check disable the GitHub version check (the only network');
    console.log('                    call Pulse makes; also: PULSE_NO_UPDATE_CHECK=1 or');
    console.log('                    {"updateCheck":false} in ~/.pulse/config.json)');
    console.log('  --version         print the version and exit');
    console.log('  --inspect-schema  print observed record schema and exit');
    console.log('  env CLAUDE_DIR    override ~/.claude location');
    console.log('  env CODEX_DIR     override ~/.codex location (OpenAI Codex CLI logs,');
    console.log('                    ingested automatically when present)');
    return;
  }
  if (args.version) { console.log('pulse v' + PULSE_VERSION); return; }
  if (args.modeHook) { runModeHook(); return; }
  if (args.effortSetup) { effortSetup(); return; }
  if (args.inspectSchema) { inspectSchema(); return; }
  if (args.installShortcuts) { installShortcuts(); return; }
  const port = resolvePort(args);
  const host = resolveHost(args);
  if (args.stop) { stopRunning(port); return; }
  if (args.daemonChild) IS_DAEMON_CHILD = true;
  // Detached processes (hidden daemon, post-update relaunch on any platform)
  // have no console — their output must land in ~/.pulse/pulse.log.
  if (args.daemonChild || args.afterUpdate) openLogFile();
  if (shouldDaemonize(args)) { daemonize(args, port, host); return; }
  startServer(port, host, serverOpts(args));
}

if (require.main === module) main();

// Exported for tests / self-check harnesses.
module.exports = {
  PRICING, priceFor, costForEntry, normalize, dedupKey,
  computeBlocks, floorToHour, aggregate, parseAll, tokensOf, localDateStr,
};
