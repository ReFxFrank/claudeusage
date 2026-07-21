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
const net = require('net');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');

// Version — keep in sync with package.json (build/make-exe.mjs enforces this).
const PULSE_VERSION = '1.22.0';
const SERVER_START = Date.now();
let IS_DAEMON_CHILD = false; // set when running as the hidden background child
let IS_AFTER_UPDATE = false; // set on the relaunch right after a self-update
// Sources that are NOT the Claude Code subscription (each has its own limits /
// billing). Used to keep the Claude 5-hour block honest — it must count ONLY
// Claude Code usage, never Codex or the other ingested agents. GLM stays in
// (it flows through Claude Code itself).
const AGENT_SOURCES = new Set(['codex', 'gemini', 'cline', 'continue', 'roo']);
// Sources whose numbers are self-reported estimates (Continue computes token
// counts locally rather than reading provider billing). Constant so the "est"
// badge survives after the live logs are pruned and only the archive remains.
const KNOWN_ESTIMATE_SOURCES = new Set(['continue']);

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

// Runtime discovery file (~/.pulse/server.json): lets the short-lived
// `pulse --statusline` process find the running server's port. Best-effort.
function runtimeFilePath() { return path.join(pulseHome(), 'server.json'); }
function writeRuntimeFile(port, host) {
  try {
    fs.mkdirSync(pulseHome(), { recursive: true });
    // The statusline always connects over loopback; record 127.0.0.1 unless
    // bound loopback already, so a LAN bind still yields a reachable local URL.
    const connectHost = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
    fs.writeFileSync(runtimeFilePath(), JSON.stringify({ port, host: connectHost, pid: process.pid, startedAt: SERVER_START, version: PULSE_VERSION }));
  } catch (_) { /* non-fatal — statusline falls back to the default port */ }
}
function readRuntimeFile() {
  try { return JSON.parse(fs.readFileSync(runtimeFilePath(), 'utf8')); } catch (_) { return null; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(pulseHome(), { recursive: true });
    fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + '\n');
  } catch (e) {
    console.warn('[pulse] could not write config: ' + e.message);
  }
  // Config affects the summary payload (budget, meters, alerts, …) and the
  // statusline feed (trayEnabled/trayStyle drive the tray's handoff) — a
  // memoized copy must never outlive a settings change.
  summaryMemo = { at: 0, payload: null };
  statuslineMemo = { at: 0, data: null };
  return next;
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

  // Zhipu / Z.ai GLM — commonly used THROUGH Claude Code via Z.ai's
  // Anthropic-compatible endpoint, so glm-* model ids land in ~/.claude and are
  // priced here (Claude-style cache multipliers apply). Z.ai list prices
  // ($/MTok), 2026-07. priceFor picks the LONGEST key that prefixes the model,
  // so the specific variants (…-air/-airx/-x/-flash/-v) must each be listed or
  // a longer name would fall back to the base row.
  'glm-5.2':           { input: 1.4,  output: 4.4 },
  'glm-5.1':           { input: 1.4,  output: 4.4 },
  'glm-5-turbo':       { input: 1.2,  output: 4.0 },
  'glm-5':             { input: 1,    output: 3.2 },
  'glm-4.7-flashx':    { input: 0.07, output: 0.4 },
  'glm-4.7-flash':     { input: 0,    output: 0 },
  'glm-4.7':           { input: 0.6,  output: 2.2 },
  'glm-4.6v-flash':    { input: 0,    output: 0 },
  'glm-4.6v':          { input: 0.3,  output: 0.9 },
  'glm-4.6':           { input: 0.6,  output: 2.2 },
  'glm-4.5v':          { input: 0.6,  output: 1.8 },
  'glm-4.5-airx':      { input: 1.1,  output: 4.5 },
  'glm-4.5-air':       { input: 0.2,  output: 1.1 },
  'glm-4.5-flash':     { input: 0,    output: 0 },
  'glm-4.5-x':         { input: 2.2,  output: 8.9 },
  'glm-4.5':           { input: 0.6,  output: 2.2 },
  'glm-4-32b':         { input: 0.1,  output: 0.1 },

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
  if (e.provider === 'google') {
    const p = priceForGoogle(e.model);
    // Gemini context caching bills cached input at ~10% of the input rate.
    const cachedPrice = p.cachedInput != null ? p.cachedInput : p.input * GOOGLE_CACHE_READ_MULT;
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
  // Codex defaults (gpt-5.x family) — list prices as of July 2026.
  'gpt-5.6-sol':        { input: 5,    output: 30,  cachedInput: 0.5 },
  'gpt-5.6-terra':      { input: 2.5,  output: 15,  cachedInput: 0.25 },
  'gpt-5.6-luna':       { input: 1,    output: 6,   cachedInput: 0.1 },
  // Bare "gpt-5.6" is not an official API id (the family ships as
  // sol/terra/luna) — priced as terra, the mainstream tier.
  'gpt-5.6':            { input: 2.5,  output: 15,  cachedInput: 0.25 },
  'gpt-5.5-pro':        { input: 30,   output: 180, cachedInput: 30 },
  'gpt-5.5':            { input: 5,    output: 30,  cachedInput: 0.5 },
  'gpt-5.4-mini':       { input: 0.75, output: 4.5, cachedInput: 0.075 },
  'gpt-5.4-nano':       { input: 0.2,  output: 1.25, cachedInput: 0.02 },
  'gpt-5.4-pro':        { input: 30,   output: 180, cachedInput: 30 },
  'gpt-5.4':            { input: 2.5,  output: 15,  cachedInput: 0.25 },
  'gpt-5.3-codex':      { input: 1.75, output: 14,  cachedInput: 0.175 },
  // Codex's sandbox auto-reviewer: runs GPT-5.4 (low reasoning), which has no
  // published row of its own — priced at gpt-5.4 rates.
  'codex-auto-review':  { input: 2.5,  output: 15,  cachedInput: 0.25 },
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
// GOOGLE / GEMINI PRICING
// $/MTok at Google Gemini API list prices (ai.google.dev/gemini-api/docs/pricing),
// July 2026. Reached via the Gemini CLI (source 'gemini'), whose logs carry the
// real per-turn token counts. On a paid key these are actual API rates; on the
// free tier they express relative usage, same caveat as the other tables.
// Context caching bills cached input at ~10% of the input rate. Longest-prefix
// match, but fallback is allowed ONLY for snapshot-style suffixes
// (-preview/-latest/-exp/-thinking plus an optional date/build stamp, or a
// bare stamp like -001). Tier and modality suffixes (-lite, -8b, -image,
// -preview-tts, …) are DIFFERENT models at different prices: without a row of
// their own they fall through to the LOGGED default — "gemini-3.5-flash-lite"
// must never silently price at gemini-3.5-flash rates (same rule as the
// OpenAI table's -mini/-pro).
// ---------------------------------------------------------------------------
const PRICING_GOOGLE = {
  'gemini-3-pro':          { input: 2,    output: 12 },
  'gemini-3.1-pro':        { input: 2,    output: 12 },
  'gemini-3.5-flash':      { input: 1.5,  output: 9 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3-flash':        { input: 0.5,  output: 3 },
  'gemini-2.5-pro':        { input: 1.25, output: 10 }, // >200k prompt: 2.50/15 (not modelled)
  'gemini-2.5-flash-lite': { input: 0.1,  output: 0.4 },
  'gemini-2.5-flash':      { input: 0.3,  output: 2.5 },
  // Fallback for unknown / new gemini strings (logged once, same as the others).
  '__default__':           { input: 1.25, output: 10 },
};
const GOOGLE_CACHE_READ_MULT = 0.10;

function priceForGoogle(model) {
  let p = PRICING_GOOGLE[model];
  if (!p && model) {
    // Longest PRICING_GOOGLE key that prefixes the model string wins, but only
    // when the remainder is a snapshot-style suffix: -preview/-latest/-exp/
    // -thinking, optionally followed by ONE date/build stamp ("-preview-05-20",
    // "-exp-1206"), or a bare stamp ("-001", "-11-2025", "-20250520"). Any
    // other remainder — a tier like "-lite"/"-8b", a modality like "-image" or
    // "-preview-tts" — is a DIFFERENT model at a different price: mispricing
    // must be visible, never silent, so it falls through to the logged default
    // instead of the parent tier's rate.
    let best = '';
    for (const key of Object.keys(PRICING_GOOGLE)) {
      if (key === '__default__' || !model.startsWith(key) || key.length <= best.length) continue;
      const rest = model.slice(key.length);
      if (/^-(?:(?:preview|latest|exp|thinking)(?:-(?:\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2}|\d{8}|\d{3,4}))?|\d{3,4}|\d{1,2}-\d{2,4}|\d{4}-\d{2}-\d{2}|\d{8})$/.test(rest)) best = key;
    }
    if (best) p = PRICING_GOOGLE[best];
  }
  if (!p) {
    logUnknownModel(model);
    p = PRICING_GOOGLE.__default__;
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

// --- Other agents (all read-only, same as ~/.claude) --------------------------
// Pulse also ingests a few other coding agents whose local logs carry per-turn
// model + token counts in a plain-JSON format we can read with Node builtins:
// Gemini CLI, Continue, and Cline. Each shows up as its own `source`, only when
// its logs are actually present on the machine.

// Gemini CLI — ~/.gemini/tmp/<projectHash>/chats/session-*.jsonl (one JSON
// record per line, with a `tokens` object and a `model`). GEMINI_DIR /
// GEMINI_CLI_HOME relocate the home (mirrors Gemini CLI's own env var).
function geminiDir() {
  return process.env.GEMINI_DIR || process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini');
}
function geminiChatsRoot() { return path.join(geminiDir(), 'tmp'); }

// Continue — ~/.continue/dev_data/<version>/tokensGenerated.jsonl (one record
// per generation: model/provider + promptTokens/generatedTokens). These are
// Continue's own LOCAL estimates, not provider-billed, so entries are flagged
// `estimate`. CONTINUE_DIR / CONTINUE_GLOBAL_DIR relocate the home.
function continueDir() {
  return process.env.CONTINUE_DIR || process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), '.continue');
}
function continueDevDataRoot() { return path.join(continueDir(), 'dev_data'); }

// Cline — a VS Code extension: task history lives under the editor's
// globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/ as ui_messages.json (+
// task_metadata.json). We probe every common editor flavour × OS. CLINE_DIR
// overrides with an explicit .../saoudrizwan.claude-dev directory.
// Roo Code is a Cline fork with the SAME task layout, under its own extension
// ids (it shipped as roo-cline, later roo-code — probe both). ROO_DIR overrides.
const CLINE_EXT_ID = 'saoudrizwan.claude-dev';
const ROO_EXT_IDS = ['rooveterinaryinc.roo-cline', 'rooveterinaryinc.roo-code'];
function vscodeGlobalStorageBases() {
  const home = os.homedir();
  const editors = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];
  const bases = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const e of editors) bases.push(path.join(appdata, e, 'User', 'globalStorage'));
  } else if (process.platform === 'darwin') {
    for (const e of editors) bases.push(path.join(home, 'Library', 'Application Support', e, 'User', 'globalStorage'));
  } else {
    for (const e of editors) bases.push(path.join(home, '.config', e, 'User', 'globalStorage'));
    bases.push(path.join(home, '.vscode-server', 'data', 'User', 'globalStorage')); // remote/SSH/WSL
  }
  return bases;
}
function clineExtensionDirs() {
  if (process.env.CLINE_DIR) return [process.env.CLINE_DIR];
  return vscodeGlobalStorageBases().map((b) => path.join(b, CLINE_EXT_ID));
}
function rooExtensionDirs() {
  if (process.env.ROO_DIR) return [process.env.ROO_DIR];
  const out = [];
  for (const b of vscodeGlobalStorageBases()) for (const id of ROO_EXT_IDS) out.push(path.join(b, id));
  return out;
}
// Discover every task's ui_messages.json under the given extension dirs.
// READ-ONLY: readdirSync/statSync only.
function taskFilesUnder(extDirs) {
  const out = [];
  for (const ext of extDirs) {
    const tasksDir = path.join(ext, 'tasks');
    let ids;
    try { ids = fs.readdirSync(tasksDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of ids) {
      if (!d.isDirectory()) continue;
      const f = path.join(tasksDir, d.name, 'ui_messages.json');
      try { if (fs.statSync(f).isFile()) out.push(f); } catch (_) { /* no ui_messages here */ }
    }
  }
  return out;
}
function clineTaskFiles() { return taskFilesUnder(clineExtensionDirs()); }
function rooTaskFiles() { return taskFilesUnder(rooExtensionDirs()); }

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
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Detect a local-command user record (`/effort`, `/model`, …). Claude Code
// writes these into the transcript as XML-ish tags:
//   <command-name>/effort</command-name> ... <command-args>max</command-args>
// and echoes their output in a follow-up <local-command-stdout> record.
// Returns { name, args } for a command record, { name: '', args: '', stdout }
// for a stdout echo, or null for a real prompt.
function parseLocalCommand(txt) {
  const m = /<command-name>\s*(\/[\w:.-]+)\s*<\/command-name>/.exec(txt);
  if (m) {
    const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(txt);
    return { name: m[1], args: a ? a[1].trim() : '' };
  }
  if (txt.indexOf('<local-command-stdout>') !== -1) {
    const s = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(txt);
    return { name: '', args: '', stdout: s ? s[1].trim() : '' };
  }
  return null;
}

// Parse an /effort confirmation echo into an effort event, or null. Bare
// `/effort` opens an interactive picker — the command record carries NO args
// (so the args path yields nothing), but the CLI-generated confirmation names
// the chosen level:
//   "Set effort level to high (this session only)"
//   "Set effort level to ultracode (this session only): xhigh + dynamic ..."
//   "Kept effort level as max" · "Effort level set to auto"
// Only CLI-written stdout is matched (never prompt text), anchored at the
// start, so a user QUOTING these words can't forge an event.
function parseEffortStdout(stdout) {
  const m = /^(?:Set effort level to|Kept effort level as|Effort level set to)\s+([a-z]+)/i.exec(stdout || '');
  if (!m) return null;
  const lvl = m[1].toLowerCase();
  if (lvl === 'ultracode') return { effort: null, ultracode: true };
  if (lvl === 'auto') return { effort: null, ultracode: false }; // back to default → no chip
  if (EFFORT_LEVELS.has(lvl)) return { effort: lvl, ultracode: false };
  return null;
}

// String intern pool. model/source/project/sessionId values repeat across
// tens of thousands of retained entries, and JSON.parse allocates a FRESH
// string for each occurrence — interning keeps one copy per distinct value,
// which is a real RSS win on large histories. Capped so a pathological log
// (e.g. unique session ids forever) can't grow the pool unbounded; overflow
// strings simply skip the pool.
const _intern = new Map();
function intern(s) {
  if (typeof s !== 'string' || !s) return s;
  const hit = _intern.get(s);
  if (hit !== undefined) return hit;
  if (_intern.size < 50000) _intern.set(s, s);
  return s;
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
    model: intern(msg.model || 'unknown'),
    source: intern(rec.entrypoint || 'cli'), // §3.4 — default cli when absent
    // Execution mode as recorded by Claude Code. NOTE: reasoning effort
    // (high/xhigh/max) and "ultracode" are request-time settings NOT written to
    // the transcript — they are recovered separately from the effort sidecar
    // (see --effort-setup) and joined on in annotateModes(). `speed` (fast vs
    // standard) and `service_tier` are the only runtime modes logged here.
    speed: intern(u.speed || 'standard'),
    serviceTier: intern(u.service_tier || 'standard'),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(u.cache_read_input_tokens),
    webSearches: num(stu.web_search_requests),
    sessionId: intern(rec.sessionId || ''),
    project: intern(rec.cwd || ''),
    // messageId/requestId are folded into `key` (dedupKey) at parse time and
    // never read again — retaining two unique strings per entry was pure RSS.
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
        // Bare `/effort` (the interactive picker, the desktop-app default)
        // leaves args empty — the chosen level only exists in the CLI's
        // confirmation echo. Parse that too. Inline usage produces both a
        // command event and an echo event with the same value — harmless,
        // the join reads them as identical state snapshots.
        if (sid && cmd.stdout) {
          const ev = parseEffortStdout(cmd.stdout);
          const ts = Date.parse(rec.timestamp);
          if (ev && isFinite(ts)) effortEvents.push({ sessionId: sid, ts, ...ev });
        }
        // Command records and their stdout echoes are not prompt text —
        // never keyword-flag ultracode from them.
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
  // Codex token_count events also carry a rate_limits snapshot of the ChatGPT
  // account's Codex allowance (primary=session window, secondary=weekly) —
  // official meters, straight from the local log. Keep the newest one.
  let rateSnapshot = null;
  // token_count events can precede the first turn_context in a rollout; buffer
  // those entries and backfill the model (and cost) once it is known instead
  // of leaving a "gpt-unknown" row on the dashboard.
  const preModelEntries = [];

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
      if (p.model) {
        model = String(p.model);
        while (preModelEntries.length) {
          const pe = preModelEntries.pop();
          pe.model = model;
          pe.cost = costForEntry(pe);
        }
      }
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
      const rl = p.rate_limits;
      const rlUsable = rl && typeof rl === 'object' && [rl.primary, rl.secondary].some(
        (w) => w && typeof w === 'object' && typeof w.used_percent === 'number' && isFinite(w.used_percent));
      if (rlUsable && (!rateSnapshot || ts >= rateSnapshot.ts)) {
        rateSnapshot = { ts, limits: rl };
      }
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
      if (model === 'gpt-unknown') preModelEntries.push(e);
      continue;
    }
  }
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [], codexRateSnapshot: rateSnapshot };
}

// ---------------------------------------------------------------------------
// OTHER-AGENT PARSERS — Gemini CLI, Continue, Cline.
// Each returns the same shape as parseFile/parseCodexFile so parseAll() can
// treat them uniformly. Read-only; formats reverse-engineered from each tool's
// open-source logs. Entries carry provider/source so pricing + breakdowns route
// correctly; a synthetic per-agent fixture covers each in test/.
// ---------------------------------------------------------------------------

// Shared skeleton for an agent usage entry (fields every aggregation reads).
function agentEntry(fields) {
  const e = {
    speed: 'standard', serviceTier: 'standard',
    inputTokens: 0, outputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
    webSearches: 0, sessionId: '', project: '',
    ...fields,
  };
  // Same interning as normalize() — agent logs repeat these just as heavily.
  e.model = intern(e.model); e.source = intern(e.source);
  e.sessionId = intern(e.sessionId); e.project = intern(e.project);
  return e;
}

// Gemini CLI — one JSON object per line; usage records carry a `tokens` object
// ({input,output,cached,thoughts,tool}) and a `model`. `input` includes cached
// (Gemini usageMetadata semantics), so uncached input = input - cached; thoughts
// (reasoning) bill as output. Dedup within a file by message id, LAST write wins
// (an edited turn is rewritten in place).
function parseGeminiFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const byId = new Map();
  let idx = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const tk = rec.tokens;
    if (!tk || typeof tk !== 'object') continue; // not a usage record
    const ts = Date.parse(rec.timestamp || rec.time || rec.createdAt || rec.date || '');
    if (!isFinite(ts)) continue;
    const cached = num(tk.cached);
    const input = num(tk.input);
    const inputTokens = Math.max(0, input - cached) + num(tk.tool);
    const outputTokens = num(tk.output) + num(tk.thoughts);
    if (inputTokens + outputTokens + cached <= 0) continue;
    const sid = String(rec.sessionId || rec.session_id || path.basename(filePath, '.jsonl'));
    const id = String(rec.id || rec.messageId || (sid + ':' + ts + ':' + idx));
    idx++;
    const e = agentEntry({
      ts, provider: 'google', model: String(rec.model || 'gemini-unknown'), source: 'gemini',
      inputTokens, outputTokens, cacheRead: cached,
      sessionId: sid, project: String(rec.projectRoot || rec.cwd || ''),
      key: 'gm:' + id, // the id lives on in the key; a separate field was pure RSS
    });
    e.cost = costForEntry(e);
    byId.set(id, e); // last write wins
  }
  const entries = [...byId.values()];
  const sessionMeta = {};
  for (const e of entries) if (e.sessionId && !sessionMeta[e.sessionId]) sessionMeta[e.sessionId] = { firstUserText: '', project: e.project };
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Continue — dev_data/<ver>/tokensGenerated.jsonl. Records are camelCase
// (model/provider + promptTokens/generatedTokens), sometimes wrapped in a
// {name,timestamp,data} envelope. These are Continue's OWN local estimates (not
// provider-billed), so every entry is flagged `estimate`. No per-record id →
// dedup by file path + line index (stable across appends).
function parseContinueFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const entries = [];
  let i = -1;
  for (const line of raw.split('\n')) {
    i++;
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const d = (rec.data && typeof rec.data === 'object') ? rec.data : rec;
    const model = String(d.model || rec.model || '');
    const promptTokens = num(d.promptTokens);
    const generatedTokens = num(d.generatedTokens);
    if (!model || promptTokens + generatedTokens <= 0) continue;
    const ts = Date.parse(rec.timestamp || d.timestamp || rec.eventTime || d.eventTime || '');
    if (!isFinite(ts)) continue;
    const prov = String(d.provider || rec.provider || '').toLowerCase();
    const m = model.toLowerCase();
    // Route to the right pricing table by model family (Continue's provider
    // label is a hint; the model string is authoritative).
    let provider = 'anthropic';
    if (/^(gpt|o[0-9]|codex|chatgpt)/.test(m) || prov.includes('openai')) provider = 'openai';
    else if (m.startsWith('gemini') || prov.includes('google') || prov.includes('gemini')) provider = 'google';
    const e = agentEntry({
      ts, provider, model, source: 'continue', estimate: true,
      inputTokens: promptTokens, outputTokens: generatedTokens,
      sessionId: 'continue', project: '',
      key: 'ct:' + filePath + ':' + i,
    });
    e.cost = costForEntry(e);
    entries.push(e);
  }
  const sessionMeta = entries.length ? { continue: { firstUserText: '', project: '' } } : {};
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Cline — VS Code extension. ui_messages.json is a JSON array of ClineMessage;
// usage lives on `api_req_started` "say" messages whose `text` is itself a
// JSON string ({tokensIn,tokensOut,cacheWrites,cacheReads,cost}). Cline records
// its OWN cost, so we use it directly. Model id comes from the sibling
// task_metadata.json `model_usage` (state-snapshot: latest entry ≤ req.ts).
// Roo Code (a Cline fork) writes the same task layout, so it parses through
// this same function with source 'roo'; if its api_req_started payload carries
// a modelId, that wins over the metadata timeline (Roo keeps precise model
// state in a SQLite DB Pulse deliberately does not read — zero-dep rule — so
// tasks without either fall back to the 'unknown' label).
function parseClineFile(filePath, source = 'cline') {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  let msgs;
  try { msgs = JSON.parse(raw); } catch (_) { return { entries: [], sessionMeta: {}, ultracodeSessions: [], effortEvents: [] }; }
  if (!Array.isArray(msgs)) return { entries: [], sessionMeta: {}, ultracodeSessions: [], effortEvents: [] };
  const taskDir = path.dirname(filePath);
  const taskId = path.basename(taskDir);
  // Model usage timeline from task_metadata.json (optional; older tasks lack it).
  let modelUsage = [];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'task_metadata.json'), 'utf8'));
    if (meta && Array.isArray(meta.model_usage)) {
      modelUsage = meta.model_usage
        .filter((u) => u && typeof u.ts === 'number' && u.model_id)
        .sort((a, b) => a.ts - b.ts);
    }
  } catch (_) { /* no metadata → model stays unknown */ }
  const modelAt = (ts) => {
    let m = null;
    for (const u of modelUsage) { if (u.ts <= ts) m = u.model_id; else break; }
    return m || (modelUsage.length ? modelUsage[0].model_id : 'unknown');
  };
  const entries = [];
  let i = -1;
  for (const msg of msgs) {
    i++;
    if (!msg || msg.type !== 'say' || msg.say !== 'api_req_started' || typeof msg.text !== 'string') continue;
    let info;
    try { info = JSON.parse(msg.text); } catch (_) { continue; }
    if (!info || typeof info !== 'object') continue;
    const ts = num(msg.ts);
    // ts is a raw numeric epoch here (not via Date.parse), so reject anything
    // outside JS's valid Date range — an out-of-range value from a corrupt file
    // would otherwise become NaN in `new Date(ts)` downstream (e.g. the heatmap).
    if (!ts || !isFinite(new Date(ts).getTime())) continue;
    const tokensIn = num(info.tokensIn), tokensOut = num(info.tokensOut);
    const cacheWrites = num(info.cacheWrites), cacheReads = num(info.cacheReads);
    if (tokensIn + tokensOut + cacheWrites + cacheReads <= 0) continue;
    // Roo can carry the model right on the request record; Cline relies on the
    // metadata timeline. The record-level probe is ROO-ONLY so a future Cline
    // that writes a modelId field with different semantics can't silently
    // override the metadata path for existing Cline users.
    const recModel = source === 'roo' && typeof info.modelId === 'string' && info.modelId ? info.modelId : null;
    const model = String(recModel || modelAt(ts));
    const mlow = model.toLowerCase();
    let provider = 'anthropic';
    if (/^(gpt|o[0-9]|codex|chatgpt)/.test(mlow)) provider = 'openai';
    else if (mlow.startsWith('gemini')) provider = 'google';
    const e = agentEntry({
      ts, provider, model, source,
      inputTokens: tokensIn, outputTokens: tokensOut, cacheWrite5m: cacheWrites, cacheRead: cacheReads,
      sessionId: taskId, project: '',
      key: source + ':' + taskId + ':' + ts + ':' + i,
    });
    // Cline records real per-request cost — trust it; fall back to our estimate
    // only if it's absent (very old tasks).
    e.cost = (typeof info.cost === 'number' && isFinite(info.cost)) ? info.cost : costForEntry(e);
    entries.push(e);
  }
  const sessionMeta = entries.length ? { [taskId]: { firstUserText: '', project: '' } } : {};
  return { entries, sessionMeta, ultracodeSessions: [], effortEvents: [] };
}

// Turn the newest Codex rate_limits snapshot into display buckets. resets_at
// has been absolute (epoch seconds or ISO) in recent versions and
// resets_in_seconds (relative to the event) in older ones — handle all three.
// used_percent is 0–100. A bucket whose reset time has already passed is
// marked stale: the window rolled over since the snapshot, so its percentage
// no longer means anything.
function codexMetersFromSnapshot(snap) {
  if (!snap || !snap.limits) return null;
  const buckets = [];
  const addWindow = (key, w) => {
    if (!w || typeof w !== 'object') return;
    const pct = w.used_percent;
    if (typeof pct !== 'number' || !isFinite(pct)) return;
    const mins = num(w.window_minutes || w.window_duration_mins);
    let resetsAt = null;
    const ra = w.resets_at;
    if (typeof ra === 'number' && isFinite(ra)) resetsAt = ra < 1e12 ? ra * 1000 : ra;
    else if (typeof ra === 'string') { const t = Date.parse(ra); if (isFinite(t)) resetsAt = t; }
    else if (typeof w.resets_in_seconds === 'number' && isFinite(w.resets_in_seconds)) {
      resetsAt = snap.ts + w.resets_in_seconds * 1000;
    }
    let label;
    if (mins && mins <= 360) label = 'Codex · session (5h)';
    else if (mins && mins >= 8000 && mins <= 12000) label = 'Codex · weekly';
    else if (mins) label = 'Codex · ' + (mins % 1440 === 0 ? (mins / 1440) + '-day' : mins + '-min');
    else label = key === 'primary' ? 'Codex · session' : 'Codex · weekly';
    buckets.push({
      key: 'codex_' + key,
      label,
      pct: Math.max(0, Math.min(100, pct)),
      resetsAt,
      stale: resetsAt != null && resetsAt < Date.now(),
    });
  };
  addWindow('primary', snap.limits.primary);
  addWindow('secondary', snap.limits.secondary);
  if (!buckets.length) return null;
  return { asOf: snap.ts, buckets };
}

// Walk all files; reuse cached parse when mtime is unchanged. Returns the merged
// (globally deduped) entry list plus a merged sessionId->meta map. Logs a
// one-line "parsed X, skipped Y (cached)" so the mtime cache is observable.
function parseAll() {
  const walkT0 = Date.now();
  const claudeFiles = walkJsonl(projectsRoot());
  const codexFiles = walkJsonl(codexSessionsRoot());
  // Other agents — each discovered independently; absent dirs yield [] so the
  // source simply never appears. Continue's dev_data holds several .jsonl kinds;
  // only tokensGenerated.jsonl carries usage. Cline's are .json (not .jsonl).
  const geminiFiles = walkJsonl(geminiChatsRoot());
  const continueFiles = walkJsonl(continueDevDataRoot()).filter((f) => path.basename(f) === 'tokensGenerated.jsonl');
  const clineFiles = clineTaskFiles();
  const rooFiles = rooTaskFiles();
  const walkMs = Date.now() - walkT0;
  const codexSet = new Set(codexFiles);
  const geminiSet = new Set(geminiFiles);
  const continueSet = new Set(continueFiles);
  const clineSet = new Set(clineFiles);
  const rooSet = new Set(rooFiles);
  const files = claudeFiles.concat(codexFiles, geminiFiles, continueFiles, clineFiles, rooFiles);
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
    const result = codexSet.has(f) ? parseCodexFile(f)
      : geminiSet.has(f) ? parseGeminiFile(f)
      : continueSet.has(f) ? parseContinueFile(f)
      : clineSet.has(f) ? parseClineFile(f)
      : rooSet.has(f) ? parseClineFile(f, 'roo')
      : parseFile(f);
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
      codexRateSnapshot: result.codexRateSnapshot || null,
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
  let codexRateSnapshot = null;
  for (const { entries, sessionMeta: sm, ultracodeSessions: us, effortEvents: ev, codexRateSnapshot: rs } of fileCache.values()) {
    for (const e of entries) {
      if (globalSeen.has(e.key)) continue;
      globalSeen.add(e.key);
      merged.push(e);
    }
    for (const sid of us || []) ultracodeSessions.add(sid);
    for (const e of ev || []) effortEvents.push(e);
    if (rs && (!codexRateSnapshot || rs.ts > codexRateSnapshot.ts)) codexRateSnapshot = rs;
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

  const agentBits = [];
  if (geminiFiles.length) agentBits.push(`${geminiFiles.length} gemini`);
  if (continueFiles.length) agentBits.push(`${continueFiles.length} continue`);
  if (clineFiles.length) agentBits.push(`${clineFiles.length} cline`);
  if (rooFiles.length) agentBits.push(`${rooFiles.length} roo`);
  const agentStr = agentBits.length ? ', ' + agentBits.join(', ') : '';
  console.log(`[pulse] walked ${files.length} file(s) (${claudeFiles.length} claude, ${codexFiles.length} codex${agentStr}) in ${walkMs}ms; parsed ${parsed}, skipped ${skipped} (cached)${failed ? `, ${failed} unreadable (will retry)` : ''}; ${merged.length} unique usage records`);
  return {
    entries: merged, sessionMeta, ultracodeSessions, effortEvents,
    fileCount: files.length, codexFileCount: codexFiles.length,
    codexRateSnapshot,
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

function aggregate(entries, sessionMeta, desktopTitles, now, modesBySession, ultracodeSessions, officialFiveHour, history) {
  const asc = entries.slice().sort((a, b) => a.ts - b.ts);
  annotateModes(asc, modesBySession || {}, ultracodeSessions || new Set());
  const modesLogged = Object.keys(modesBySession || {}).length > 0;
  // Days present in the live logs — the archive only fills days NOT here, so
  // live and archived data can never double-count.
  const hist = history && history.byDay ? history : EMPTY_HISTORY;
  const liveDays = new Set(asc.map((e) => localDateStr(e.ts)));

  // ---- 5-hour blocks + active block ----
  // Claude Code entries only: the 5h window is the Claude Code subscription's
  // rate-limit concept. Every other ingested agent (Codex, Gemini, Cline,
  // Continue) has its own separate limits/billing and must not distort the
  // reset countdown — gate by SOURCE, not provider (a Cline turn on a Claude
  // model is still not Claude Code usage).
  const claudeAsc = asc.filter((e) => !AGENT_SOURCES.has(e.source));
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
  // When the official account meter has a live five-hour reset time, IT is
  // the window — Anthropic's clock, not our reconstruction. The window spans
  // [reset - 5h, reset]; cost/tokens are this machine's contribution inside
  // it. Reconstruction remains the fallback (meters off, stale, or expired).
  const officialEnd = officialFiveHour && officialFiveHour.resetsAt;
  if (officialEnd && officialEnd > now && officialEnd - now <= BLOCK_MS + 5 * MINUTE_MS) {
    const start = officialEnd - BLOCK_MS;
    let cost = 0, tokens = 0, messages = 0;
    for (const e of claudeAsc) {
      if (e.ts >= start && e.ts <= now) { cost += e.cost; tokens += tokensOf(e); messages++; }
    }
    let peakCost = 0, peakTokens = 0;
    for (const b of blocks) {
      if (b.end > start) continue; // only fully-past reconstructed blocks compare fairly
      if (b.cost > peakCost) peakCost = b.cost;
      if (b.tokens > peakTokens) peakTokens = b.tokens;
    }
    currentBlock = {
      start,
      end: officialEnd,
      cost,
      tokens,
      messages,
      timeToReset: officialEnd - now,
      vsPeakCostPct: peakCost > 0 ? (cost / peakCost) * 100 : null,
      vsPeakTokensPct: peakTokens > 0 ? (tokens / peakTokens) * 100 : null,
      official: true,
    };
  } else if (activeBlock) {
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
      official: false,
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
  // Today / last-7-days tiles are LIVE-only: with any normal retention setting
  // (cleanupPeriodDays >= 7, incl. the default 30) the last week is always fully
  // on disk, so the archive would add nothing. The archive backfills the longer
  // windows and all-time totals, where pruning actually bites.
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
  // Sources whose numbers are self-reported estimates (e.g. Continue computes
  // its own token counts locally rather than reading provider billing). The UI
  // badges these so they aren't read as metered truth.
  const estimatedSourcesSet = new Set();
  for (const e of asc) {
    allSourcesSet.add(e.source);
    if (e.estimate) estimatedSourcesSet.add(e.source);
    if (!HIDDEN_MODELS.has(e.model)) allModelsSet.add(e.model);
    monthKeySet.add(localDateStr(e.ts).slice(0, 7)); // YYYY-MM
  }
  // Archived-only sources/models/months must appear too, so colors stay stable
  // and old months remain selectable after their logs are pruned.
  for (const s of hist.sources) allSourcesSet.add(s);
  for (const m of hist.models) allModelsSet.add(m);
  for (const ds of Object.keys(hist.byDay)) if (!liveDays.has(ds)) monthKeySet.add(ds.slice(0, 7));
  const allSources = Array.from(allSourcesSet).sort();
  const allModels = Array.from(allModelsSet).sort();

  // ---- §4.3 spend PERIODS: rolling windows + one entry per calendar month ----
  // Each period carries its own daily buckets (split by source), by-model and
  // by-source rollups, and totals — so the spend section can be re-scoped to a
  // rolling window or any past month. Day walks use setDate (DST-safe).
  // Note: Claude Code prunes transcripts after ~cleanupPeriodDays (30 by
  // default), so long windows only show what is still on disk — documented.
  const periods = [];
  // Build a period's totals for an arbitrary window and return just the
  // {cost,tokens,messages} — reusing buildPeriod so the PREVIOUS window is
  // merged (live + archive, per cell) exactly like a period's OWN cost. This
  // keeps the delta chip apples-to-apples with the figure it's compared against.
  const windowTotals = (dayList) => {
    const set = new Set(dayList);
    const inWin = asc.filter((e) => set.has(localDateStr(e.ts)));
    const p = buildPeriod('_prev', '', inWin, dayList, allSources, hist, liveDays);
    return { cost: p.cost, tokens: p.tokens, messages: p.messages };
  };

  // Rolling windows (newest first in the dropdown).
  for (const [key, label, nDays] of [
    ['last30', 'Last 30 days', 30],
    ['last90', 'Last 90 days', 90],
    ['last180', 'Last 180 days', 180],
  ]) {
    const days = localDayStartsBack(now, nDays);
    const daySet = new Set(days);
    const inWin = asc.filter((e) => daySet.has(localDateStr(e.ts)));
    const p = buildPeriod(key, label, inWin, days, allSources, hist, liveDays);
    // Previous equal-length window: the nDays immediately before this one.
    const prevAnchor = new Date(now); prevAnchor.setDate(prevAnchor.getDate() - nDays);
    p.prev = windowTotals(localDayStartsBack(prevAnchor.getTime(), nDays));
    periods.push(p);
  }
  // One period per calendar month present in the data (newest first, capped).
  const months = Array.from(monthKeySet).sort().reverse().slice(0, 24);
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const days = monthDayList(y, m - 1);
    const inMonth = asc.filter((e) => localDateStr(e.ts).slice(0, 7) === mk);
    periods.push(buildPeriod(mk, monthLabel(y, m), inMonth, days, allSources, hist, liveDays));
  }
  // Month-over-month prev: a month's previous window IS the prior calendar
  // month, already built above as its own period — reference it directly (same
  // merge, no recompute). Missing prior month (no data / beyond the cap) → zero.
  const periodByKey = {};
  for (const p of periods) periodByKey[p.key] = p;
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const pm = new Date(y, m - 2, 1);
    const pmk = pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0');
    const prev = periodByKey[pmk];
    periodByKey[mk].prev = prev
      ? { cost: prev.cost, tokens: prev.tokens, messages: prev.messages }
      : { cost: 0, tokens: 0, messages: 0 };
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

  // All-time totals include archived days the live logs no longer hold, so the
  // totals tile (and Discord's all-time page) reflect true history, not just
  // the ~30 days still on disk. Merged per (day, source, model) cell — the
  // more-complete of live vs archive — so a partially-pruned day isn't
  // undercounted and nothing double-counts. Sessions stays live-only (archived
  // per-day counts can't be de-duplicated across days).
  const liveCellsByDay = {};
  for (const e of asc) {
    const ds = localDateStr(e.ts);
    const k = cellKey(e.source, e.model);
    const day = liveCellsByDay[ds] || (liveCellsByDay[ds] = {});
    const cell = day[k] || (day[k] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
  }
  const totals = { cost: 0, tokens: 0, messages: 0, sessions: Object.keys(sessMap).length };
  const allDays = new Set(Object.keys(liveCellsByDay));
  for (const ds of Object.keys(hist.byDay)) allDays.add(ds);
  for (const ds of allDays) {
    const lc = liveCellsByDay[ds] || {};
    const ac = indexCells(hist.byDay[ds] && hist.byDay[ds].rows);
    const keys = new Set(Object.keys(lc));
    for (const k of Object.keys(ac)) keys.add(k);
    for (const k of keys) {
      const cell = pickCell(lc[k], ac[k]);
      totals.cost += cell.cost; totals.tokens += cell.tokens; totals.messages += cell.messages;
    }
  }

  // Which provider is in active use right now — the newest activity within the
  // last 15 minutes — for the Discord presence logo. null == idle.
  const ACTIVE_MS = 15 * 60 * 1000;
  let activeProvider = null;
  if (asc.length && now - asc[asc.length - 1].ts <= ACTIVE_MS) {
    // Only Claude Code / Codex have dedicated Discord art. The other agents map
    // to null (Pulse art) rather than falsely claiming "Using Claude Code".
    const lastSrc = asc[asc.length - 1].source;
    activeProvider = lastSrc === 'codex' ? 'codex' : AGENT_SOURCES.has(lastSrc) ? null : 'claude';
  }

  // Activity heatmap — cost/tokens/messages by local weekday (0=Sun … 6=Sat) ×
  // hour (0–23), over all live entries. Reveals when you actually work.
  const hmGrid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, tokens: 0, messages: 0 })));
  let hmMaxCost = 0, hmMaxMsgs = 0;
  for (const e of asc) {
    const d = new Date(e.ts);
    const dow = d.getDay(), hr = d.getHours();
    if (!(dow >= 0 && dow <= 6) || !(hr >= 0 && hr <= 23)) continue; // guard a bad ts (Invalid Date → NaN index)
    const cell = hmGrid[dow][hr];
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (cell.cost > hmMaxCost) hmMaxCost = cell.cost;
    if (cell.messages > hmMaxMsgs) hmMaxMsgs = cell.messages;
  }
  const heatmap = { grid: hmGrid, maxCost: hmMaxCost, maxMessages: hmMaxMsgs };

  const payload = {
    generatedAt: now,
    latestTs: asc.length ? asc[asc.length - 1].ts : null, // newest record on this machine
    activeProvider, // 'claude' | 'codex' | null (idle)
    totals,
    currentBlock,
    idle: activeBlock === null,
    burnRate,
    today,
    week,
    periods,
    budget: computeBudget(periods, week, now),
    allSources,
    allModels,
    // Union live-flagged estimate sources with the known set, over allSources —
    // so a source like Continue stays badged "est" even after its live logs are
    // pruned and only the (flag-less) archive remains.
    estimatedSources: allSources.filter((s) => estimatedSourcesSet.has(s) || KNOWN_ESTIMATE_SOURCES.has(s)),
    recentSessions,
    heatmap,
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
function buildPeriod(key, label, entries, dayList, allSources, hist, liveDays) {
  const index = {};
  const daily = [];
  for (const ds of dayList) {
    const bucket = { date: ds, total: 0, tokens: 0, bySource: {} };
    for (const s of allSources) bucket.bySource[s] = 0;
    index[ds] = bucket;
    daily.push(bucket);
  }
  const byModel = {}, bySource = {}, srcSet = new Set(), sess = new Set();
  let cost = 0, tokens = 0, messages = 0;
  // Analytics breakdowns — live-only (the archive keeps day/source/model totals,
  // not per-entry effort or project), so these cover the sessions still in your
  // logs. Effort bucket = ultracode | <level> | default (no explicit level).
  const effortSpend = {}, byProject = {};

  // Pass 1: fold live entries into per-(day,source,model) cells, and accumulate
  // the decorative chips (speed/tier/effort/ultracode) + distinct sessions from
  // the live logs only.
  const liveCells = {};
  for (const e of entries) {
    const ds = localDateStr(e.ts);
    const k = cellKey(e.source, e.model);
    const day = liveCells[ds] || (liveCells[ds] = {});
    const cell = day[k] || (day[k] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (e.sessionId) sess.add(e.sessionId);
    // Hidden placeholders (e.g. "<synthetic>") still count toward the daily/day
    // totals (they are $0 / 0-token) but never get a by-model row or chips.
    if (!HIDDEN_MODELS.has(e.model)) {
      const tk = tokensOf(e);
      const m = byModel[e.model] || (byModel[e.model] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
      m.speeds[e.speed] = (m.speeds[e.speed] || 0) + 1;
      m.tiers[e.serviceTier] = (m.tiers[e.serviceTier] || 0) + 1;
      if (e.effort) m.efforts = m.efforts || {}, m.efforts[e.effort] = (m.efforts[e.effort] || 0) + 1;
      if (e.ultracode) m.ultracode = (m.ultracode || 0) + 1;
      const eb = e.ultracode ? 'ultracode' : (e.effort || 'default');
      const es = effortSpend[eb] || (effortSpend[eb] = { cost: 0, tokens: 0, messages: 0 });
      es.cost += e.cost; es.tokens += tk; es.messages++;
      const proj = e.project || '(unknown)';
      const pb = byProject[proj] || (byProject[proj] = { cost: 0, tokens: 0, messages: 0, sessions: new Set() });
      pb.cost += e.cost; pb.tokens += tk; pb.messages++;
      if (e.sessionId) pb.sessions.add(e.sessionId);
    }
    const s = bySource[e.source] || (bySource[e.source] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
    s.speeds[e.speed] = (s.speeds[e.speed] || 0) + 1;
  }

  // Pass 2: for each day, take the MORE-COMPLETE observation of every cell —
  // live or archived — and fold it into the daily buckets and rollups. Merging
  // per cell (not all-or-nothing per day) recovers a provider/session pruned
  // from the live logs while another remains, and each cell contributes exactly
  // once, so nothing is double-counted.
  for (const ds of dayList) {
    const lc = liveCells[ds] || {};
    const ac = hist ? indexCells(hist.byDay[ds] && hist.byDay[ds].rows) : {};
    const keys = new Set(Object.keys(lc));
    for (const k of Object.keys(ac)) keys.add(k);
    const b = index[ds];
    for (const k of keys) {
      const cell = pickCell(lc[k], ac[k]);
      if (b) { b.total += cell.cost; b.tokens += cell.tokens; b.bySource[cell.source] = (b.bySource[cell.source] || 0) + cell.cost; }
      cost += cell.cost; tokens += cell.tokens; messages += cell.messages; srcSet.add(cell.source);
      if (!HIDDEN_MODELS.has(cell.model)) {
        const m = byModel[cell.model] || (byModel[cell.model] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
        m.cost += cell.cost; m.tokens += cell.tokens; m.messages += cell.messages;
      }
      const s = bySource[cell.source] || (bySource[cell.source] = { cost: 0, tokens: 0, messages: 0, speeds: {}, tiers: {} });
      s.cost += cell.cost; s.tokens += cell.tokens; s.messages += cell.messages;
    }
  }
  const sources = Array.from(srcSet).sort();
  // Project breakdown: resolve session Sets to counts, keep the top 30 by cost
  // and fold the long tail into "(other)" so the payload stays small.
  const projEntries = Object.keys(byProject).map((p) => {
    const v = byProject[p];
    return { project: p, cost: v.cost, tokens: v.tokens, messages: v.messages, sessions: v.sessions.size };
  }).sort((a, b) => b.cost - a.cost);
  const TOP_PROJECTS = 30;
  const byProjectOut = projEntries.slice(0, TOP_PROJECTS);
  if (projEntries.length > TOP_PROJECTS) {
    const rest = projEntries.slice(TOP_PROJECTS).reduce((a, p) => {
      a.cost += p.cost; a.tokens += p.tokens; a.messages += p.messages; a.sessions += p.sessions; return a;
    }, { project: '(other)', cost: 0, tokens: 0, messages: 0, sessions: 0 });
    byProjectOut.push(rest);
  }
  // Live-only spend covered by the effort/project breakdowns (period cost also
  // includes archived days, which don't retain effort/project) — lets the UI
  // say what fraction the breakdowns account for.
  const liveCost = Object.values(effortSpend).reduce((a, b) => a + b.cost, 0);
  // sessions is live-only: archived per-day session counts can't be de-duplicated
  // across days or split by source, so they are not summed here.
  return {
    key, label, cost, tokens, messages, sessions: sess.size,
    daily, byModel, bySource, sources, singleSource: sources.length <= 1,
    effortSpend, byProject: byProjectOut, liveCost,
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

// ---------------------------------------------------------------------------
// HISTORICAL RETENTION  (§5)
// Claude Code prunes transcripts after ~cleanupPeriodDays (30 by default),
// which would blank the 90/180-day windows and understate all-time totals for
// older data. Pulse keeps a daily rollup — cost/tokens/messages per
// (day, source, model), plus a per-day session count — under ~/.pulse/history,
// one JSON file per calendar month. Only SEALED (fully-past) days are written;
// today is always live. On read, a day is taken from the live logs if it has
// ANY entry, else from the archive — so live and archive never double-count.
// Writes ONLY to ~/.pulse; sources stay read-only. On by default; disable with
// {"history": false}. Test override: PULSE_HISTORY_DIR.
// ---------------------------------------------------------------------------
function historyEnabled() { return readConfig().history !== false; }
function historyDir() {
  return process.env.PULSE_HISTORY_DIR || path.join(pulseHome(), 'history');
}

const EMPTY_HISTORY = { byDay: {}, sources: new Set(), models: new Set(), months: new Set() };
let historyCache = { sig: '', data: null };

// Read every archived month into { byDay, sources, models, months }. Cached by
// the set of month files and their mtimes, so we reparse only on change.
function readHistory() {
  if (!historyEnabled()) return EMPTY_HISTORY;
  const dir = historyDir();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort(); }
  catch (_) { return EMPTY_HISTORY; }
  let sig = '';
  for (const f of files) {
    try { sig += f + ':' + fs.statSync(path.join(dir, f)).mtimeMs + ';'; } catch (_) {}
  }
  if (historyCache.sig === sig && historyCache.data) return historyCache.data;
  const byDay = {}, sources = new Set(), models = new Set(), months = new Set();
  for (const f of files) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!obj || typeof obj !== 'object') continue;
    months.add(f.slice(0, 7));
    for (const ds of Object.keys(obj)) {
      const rec = obj[ds];
      if (!rec || !Array.isArray(rec.rows)) continue;
      const rows = [];
      for (const r of rec.rows) {
        if (!r || typeof r.source !== 'string' || typeof r.model !== 'string') continue;
        rows.push({ source: r.source, model: r.model, cost: +r.cost || 0, tokens: +r.tokens || 0, messages: +r.messages || 0 });
        sources.add(r.source);
        if (!HIDDEN_MODELS.has(r.model)) models.add(r.model);
      }
      byDay[ds] = { rows, sessions: +rec.sessions || 0 };
    }
  }
  const data = { byDay, sources, models, months };
  historyCache = { sig, data };
  return data;
}

// Restrict an archive view to a set of sources (mirrors the dashboard's source
// filter). Session counts aren't source-split, so they carry over as-is.
function filterHistory(history, sourceSet) {
  const byDay = {}, sources = new Set(), models = new Set();
  for (const ds of Object.keys(history.byDay)) {
    const rows = history.byDay[ds].rows.filter((r) => sourceSet.has(r.source));
    if (!rows.length) continue;
    byDay[ds] = { rows, sessions: history.byDay[ds].sessions };
    for (const r of rows) { sources.add(r.source); if (!HIDDEN_MODELS.has(r.model)) models.add(r.model); }
  }
  return { byDay, sources, models, months: history.months };
}

// Live logs for a single past day can SHRINK over time — ~/.claude and ~/.codex
// prune independently, and Claude prunes per session file by mtime — so a day
// can be partial in the logs while the archive still holds the pruned cells.
// Both the seal (mergeDayRecord) and the read (pickCell) therefore merge per
// (source,model) cell and keep the more-complete observation, so a re-seal
// never shrinks a day and reads never miss a pruned cell. Keys are in-memory
// only (never persisted — rows store source/model separately); a space
// separator is safe since source/model identifiers contain none.
const cellKey = (source, model) => source + ' ' + model;
function indexCells(rows) {
  const o = {};
  if (Array.isArray(rows)) for (const r of rows) {
    if (r && typeof r.source === 'string' && typeof r.model === 'string') o[cellKey(r.source, r.model)] = r;
  }
  return o;
}
// Pruning only ever removes messages, so the observation with MORE messages
// (tie: more cost) is the more complete one.
function pickCell(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.messages > a.messages || (b.messages === a.messages && b.cost > a.cost)) ? b : a;
}
// Non-shrinking union of an archived day and a freshly-sealed one: keep the
// more-complete observation of every cell, so a cell since pruned from the live
// logs is preserved rather than overwritten with the now-partial value.
function mergeDayRecord(existing, fresh) {
  if (!existing || !Array.isArray(existing.rows)) return fresh;
  const cells = indexCells(existing.rows);
  for (const r of fresh.rows) { const k = cellKey(r.source, r.model); cells[k] = pickCell(cells[k], r); }
  return { rows: Object.values(cells), sessions: Math.max(+existing.sessions || 0, fresh.sessions || 0) };
}

// Fold live entries into per-(day,source,model) rollups for SEALED days only,
// then write the month files that changed. Gated so summary builds don't churn
// the disk; a still-present day is re-sealed (kept fresh) until it's pruned.
let lastSealAt = 0;
function sealHistory(entries) {
  if (!historyEnabled()) return;
  const now = Date.now();
  if (lastSealAt && now - lastSealAt < 5 * 60 * 1000) return; // at most every 5 min
  lastSealAt = now;
  const today = localDateStr(now);
  const byDay = {}, sessByDay = {};
  for (const e of entries) {
    const ds = localDateStr(e.ts);
    if (ds >= today) continue; // never seal today (still accumulating)
    const key = cellKey(e.source, e.model);
    const d = byDay[ds] || (byDay[ds] = {});
    const cell = d[key] || (d[key] = { source: e.source, model: e.model, cost: 0, tokens: 0, messages: 0 });
    cell.cost += e.cost; cell.tokens += tokensOf(e); cell.messages++;
    if (e.sessionId) (sessByDay[ds] || (sessByDay[ds] = new Set())).add(e.sessionId);
  }
  const months = {};
  for (const ds of Object.keys(byDay)) {
    (months[ds.slice(0, 7)] || (months[ds.slice(0, 7)] = {}))[ds] = {
      rows: Object.values(byDay[ds]),
      sessions: sessByDay[ds] ? sessByDay[ds].size : 0,
    };
  }
  let wrote = false;
  for (const mk of Object.keys(months)) {
    const file = path.join(historyDir(), mk + '.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    // Re-seal keeps the more-complete cell for each recomputed day (never
    // shrinks); days not recomputed (already pruned) are preserved untouched.
    const merged = { ...existing };
    for (const ds of Object.keys(months[mk])) merged[ds] = mergeDayRecord(existing[ds], months[mk][ds]);
    const ordered = {};
    for (const k of Object.keys(merged).sort()) ordered[k] = merged[k];
    const next = JSON.stringify(ordered);
    let prev = null;
    try { prev = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (prev === next) continue;
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      // Atomic write: a crash mid-write must never truncate the file and lose
      // already-pruned days. Write a temp, then rename over the target.
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, file);
      wrote = true;
    } catch (err) { console.warn('[pulse] history write failed: ' + err.message); }
  }
  if (wrote) historyCache = { sig: '', data: null }; // force reload on next read
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
  const claudeCount = asc.reduce((a, e) => a + (AGENT_SOURCES.has(e.source) ? 0 : 1), 0);
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

// sourceFilter: optional Set of source names — the dashboard's source filter.
// The WHOLE payload (blocks, burn, periods, sessions) reflects the filtered
// view, while allSources/allModels stay unfiltered so the filter UI can list
// every option and colors stay stable across filter changes.
// opts.background — true when a background consumer (status line, Discord)
// drives the build rather than the dashboard. Background builds only TRICKLE
// the account-meter refresh (see metersForPayload); the dashboard drives it at
// the normal cadence. This keeps Pulse from polling the shared, rate-limited
// usage endpoint every couple of minutes around the clock.
// Unfiltered payloads are shared this long. PULSE_SUMMARY_MEMO_MS is a test
// hook (0 disables) — timing-sensitive suites assert the METERS trickle
// discipline and must not race the memo window.
const _smm = parseInt(process.env.PULSE_SUMMARY_MEMO_MS || '', 10);
const SUMMARY_MEMO_MS = isFinite(_smm) && _smm >= 0 ? _smm : 2500;
let summaryMemo = { at: 0, payload: null };
function buildSummary(sourceFilter, opts) {
  const background = !!(opts && opts.background);
  // Unfiltered builds share a short-lived memo: the dashboard poll (10s), the
  // Discord tick (15s), and the statusline feed (3s memo of its own) all want
  // the same payload, and with several consumers active the full aggregation
  // used to run back-to-back — pure allocation churn for identical output.
  // Busted by writeConfig() so a settings change is never masked.
  if (!sourceFilter && summaryMemo.payload && Date.now() - summaryMemo.at < SUMMARY_MEMO_MS) {
    return summaryMemo.payload;
  }
  const buildT0 = Date.now();
  const { entries, sessionMeta, ultracodeSessions, effortEvents, fileCount, codexFileCount, codexRateSnapshot } = parseAll();
  const desktopTitles = readDesktopTitles();
  const now = Date.now();
  const history = readHistory();
  sealHistory(entries); // gated internally; archives sealed days to ~/.pulse
  let scoped = entries;
  let scopedHistory = history;
  let appliedFilter = null;
  if (sourceFilter && sourceFilter.size) {
    scoped = entries.filter((e) => sourceFilter.has(e.source));
    scopedHistory = filterHistory(history, sourceFilter);
    appliedFilter = Array.from(sourceFilter).sort();
  }
  const payload = aggregate(scoped, sessionMeta, desktopTitles, now,
    mergeModes(readModes(), effortEvents), ultracodeSessions, officialFiveHourBucket(), scopedHistory);
  if (appliedFilter) {
    // Recompute the all-time lists from UNFILTERED entries + archive: the filter
    // chips must keep showing every source (live or archived-only), and color
    // assignment must not reshuffle.
    const srcSet = new Set(history.sources), modelSet = new Set(history.models);
    for (const e of entries) {
      srcSet.add(e.source);
      if (!HIDDEN_MODELS.has(e.model)) modelSet.add(e.model);
    }
    payload.allSources = Array.from(srcSet).sort();
    payload.allModels = Array.from(modelSet).sort();
  }
  payload.sourceFilter = appliedFilter;
  // Surface what Pulse is actually reading, so a wrong-directory setup (e.g.
  // Claude Code under WSL while Pulse runs in native Windows) is diagnosable.
  payload.claudeDir = claudeDir();
  payload.fileCount = fileCount;
  payload.codexDir = codexDir();
  payload.codexFileCount = codexFileCount || 0;
  payload.hasCodex = (codexFileCount || 0) > 0;
  // Retention status: how many past days Pulse has archived beyond the logs.
  payload.history = { enabled: historyEnabled(), archivedDays: Object.keys(history.byDay).length };
  // Server panel: identity + update state.
  payload.version = PULSE_VERSION;
  payload.serverStartTs = SERVER_START;
  payload.pid = process.pid;
  payload.daemon = IS_DAEMON_CHILD;
  payload.packaged = !!seaApi;
  payload.update = updateState;
  // Community reach (public GitHub counters) — present only once fetched; the
  // fetch itself is scheduled alongside the update check and shares its opt-out.
  payload.reach = reachForPayload();
  payload.meters = metersForPayload(background);
  // Codex official meters come from rate_limits snapshots already present in
  // the local rollout logs — no opt-in needed, nothing leaves the machine.
  // Account-level, so computed from the unfiltered parse.
  payload.codexMeters = codexMetersFromSnapshot(codexRateSnapshot);
  // Codex account TOKEN totals (all devices) — opt-in, ChatGPT endpoint.
  payload.codexUsage = codexUsageForPayload(background);
  // Limit alerts: which windows are at/above a warning threshold right now.
  // Stateless — the dashboard de-dups notifications per reset cycle client-side.
  payload.alerts = computeAlerts(payload.meters, payload.codexMeters);
  // Spend anomaly (opt-in) leads the list — a runaway day outranks a window
  // that is merely approaching its limit. Computed ONLY on the unfiltered
  // view: like the meter alerts it is an account-level signal, and a
  // source-filtered baseline would fire spurious "unusual spend"
  // notifications (and burn the once-per-day dedup) off a scope the wording
  // never mentions.
  if (!appliedFilter) {
    const anomaly = computeSpendAnomaly(payload.periods, Date.now());
    if (anomaly) payload.alerts.unshift(anomaly);
  }
  // Discord Rich Presence status (opt-in) — state only, no work done here.
  payload.discord = discordForPayload();
  // Windows tray state — the Server panel shows the toggle only where the
  // feature exists.
  payload.tray = { supported: process.platform === 'win32', enabled: trayDesired !== null ? trayDesired : readConfig().tray === true, style: trayStyle() };
  // Server-panel visibility into the process footprint (RSS + JS heap).
  try {
    const mu = process.memoryUsage();
    payload.memory = { rss: mu.rss, heapUsed: mu.heapUsed };
  } catch (_) { /* never let a stats call break the payload */ }
  // Stamped BEFORE the memo store so memo hits carry the timing of the build
  // they actually serve — request handlers must never mutate a shared payload.
  payload.buildMs = Date.now() - buildT0;
  if (!sourceFilter) summaryMemo = { at: Date.now(), payload };
  return payload;
}

// ---------------------------------------------------------------------------
// LIMIT ALERTS
// Flag any usage window (Claude 5h/weekly/model-scoped, Codex session/weekly)
// that has crossed a warning threshold, so the dashboard can warn you before
// you hit a cap. Thresholds are configurable; on by default (disable with
// {"alerts": false}). This is purely a projection of the meters Pulse already
// has — account meters are account-wide, so alerts cover EVERY surface
// (Claude Code, claude.ai, Cowork, other devices), not just this machine.
// ---------------------------------------------------------------------------
function alertsEnabled() { return readConfig().alerts !== false; }
function alertThresholds() {
  const c = readConfig().alertThresholds;
  const list = Array.isArray(c) ? c.filter((n) => typeof n === 'number' && n > 0 && n <= 100) : [];
  return (list.length ? list : [80, 95]).slice().sort((a, b) => a - b);
}
function computeAlerts(meters, codexMeters) {
  if (!alertsEnabled()) return [];
  const thresholds = alertThresholds();
  const lowest = thresholds[0];
  const out = [];
  const consider = (b, provider) => {
    if (!b || typeof b.pct !== 'number' || b.stale) return;
    // A window that's already maxed out isn't one you're *approaching* — you've
    // hit it. Drop it from the warning banner (and its notifications) so a
    // reached limit doesn't sit stacked next to genuinely-approaching windows.
    // Keyed off the rounded pct so it matches the number the UI shows.
    if (Math.round(b.pct) >= 100) return;
    if (b.pct < lowest) return;
    // Highest threshold this window has reached.
    let hit = null;
    for (const t of thresholds) if (b.pct >= t) hit = t;
    if (hit == null) return;
    out.push({ key: (provider === 'codex' ? 'codex:' : 'claude:') + b.key, label: b.label, pct: b.pct, threshold: hit, resetsAt: b.resetsAt || null, provider });
  };
  if (meters && meters.enabled && Array.isArray(meters.buckets)) for (const b of meters.buckets) consider(b, 'claude');
  if (codexMeters && Array.isArray(codexMeters.buckets)) for (const b of codexMeters.buckets) consider(b, 'codex');
  // Most urgent first.
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

// ---------------------------------------------------------------------------
// SPEND-ANOMALY ALERT (opt-in) — flags a day whose spend is far above the
// user's own recent baseline (a runaway loop, an accidental ultracode
// marathon). Baseline = mean of ACTIVE days (spend > 0) in the trailing-30d
// window, excluding today — quiet weekends must not drag the average down and
// cause false alarms. Requires a real history and real money before it will
// ever fire; off unless {"anomalyAlerts": true} ({"anomalyMultiplier": N}
// tunes the trigger ratio, default 3, floor 1.5). Rides the master `alerts`
// switch and the same banner/notification plumbing as the limit alerts.
// ---------------------------------------------------------------------------
const ANOMALY_MIN_ACTIVE_DAYS = 5; // baseline needs at least this many active days
const ANOMALY_MIN_TODAY_USD = 5;   // never flag pocket change
function anomalyConfig() {
  const c = readConfig();
  // Coerce (a hand-edited "25" means 25) then CLAMP to the 1.5 floor — a user
  // asking for 1.2 gets the most sensitive supported setting, not a silent
  // reset to the default. Only non-numeric/absent falls back to 3.
  const n = Number(c.anomalyMultiplier);
  const m = isFinite(n) && n > 0 ? Math.max(1.5, n) : 3;
  return { enabled: c.anomalyAlerts === true, multiplier: m };
}
function computeSpendAnomaly(periods, now) {
  const { enabled, multiplier } = anomalyConfig();
  if (!enabled || !alertsEnabled()) return null;
  const p = (periods || []).find((x) => x.key === 'last30');
  if (!p || !Array.isArray(p.daily)) return null;
  const todayStr = localDateStr(now);
  let today = 0;
  const prior = [];
  for (const d of p.daily) {
    if (d.date === todayStr) today = d.total;
    else if (d.date < todayStr && d.total > 0) prior.push(d.total);
  }
  if (prior.length < ANOMALY_MIN_ACTIVE_DAYS || today < ANOMALY_MIN_TODAY_USD) return null;
  const baseline = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(baseline > 0) || today < baseline * multiplier) return null;
  const ratio = today / baseline;
  return {
    // Date in the key → the client's notification dedup fires once per day.
    key: 'pulse:anomaly:' + todayStr,
    kind: 'anomaly',
    provider: 'pulse',
    label: "Today's spend",
    detail: 'today $' + today.toFixed(2) + ' — ' + ratio.toFixed(1) + '× your recent daily average ($' + baseline.toFixed(2) + ')',
    ratio, todayCost: today, baseline,
    threshold: multiplier,
    pct: null,
    resetsAt: null,
  };
}

// ---------------------------------------------------------------------------
// BUDGET GOAL — an optional self-set spend target (`budget` USD +
// `budgetPeriod` month|week in ~/.pulse/config.json, set via the dashboard).
// Reports progress against the CURRENT period's spend across all sources.
// month = current calendar month (resets on the 1st); week = trailing 7 days
// (payload.week, rolling — no hard reset). Returns null when unset.
// ---------------------------------------------------------------------------
function budgetConfig() {
  const c = readConfig();
  const target = typeof c.budget === 'number' && isFinite(c.budget) && c.budget > 0 ? c.budget : null;
  const period = c.budgetPeriod === 'week' ? 'week' : 'month';
  return { target, period };
}
function computeBudget(periods, week, now) {
  const { target, period } = budgetConfig();
  if (!target) return null;
  let spent = 0, resetsAt = null, label, projected = null;
  if (period === 'week') {
    spent = (week && week.cost) || 0; // trailing 7 days
    label = 'last 7 days';
    // No projection for the rolling week: a trailing window has no fixed end
    // to project to (its "pace" IS its spend), so `projected` stays null.
  } else {
    const mk = localDateStr(now).slice(0, 7);
    const p = (periods || []).find((x) => x.key === mk);
    spent = p ? p.cost : 0;
    const d = new Date(now);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    resetsAt = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); // start of next month
    label = 'this month';
    // Straight-line month-end projection: spent scaled by the fraction of the
    // month elapsed. Suppressed for the first ~half day of a month, where the
    // tiny denominator would turn one morning session into an absurd figure.
    const elapsed = (now - monthStart) / (resetsAt - monthStart);
    if (elapsed > 0.017) projected = spent / elapsed;
  }
  const pct = (spent / target) * 100;
  const state = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
  return { target, period, label, spent, pct, remaining: Math.max(0, target - spent), resetsAt, state, projected };
}

// ---------------------------------------------------------------------------
// CSV EXPORT (GET /api/export) — serializes aggregations the dashboard already
// computes; no data is computed here, so an export always matches the screen.
// Hand-rolled CSV: RFC-4180 quoting, CRLF rows, cost rounded to 4 decimals so
// spreadsheets don't inherit float noise.
// ---------------------------------------------------------------------------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Formula-injection defusal (OWASP): a TEXT cell starting with = + - @ would
  // execute as a formula when the CSV is opened in Excel/Sheets — prefix it
  // with a quote. Only strings: numeric cells (costs, tokens) must stay
  // numeric, and a number can legitimately start with "-".
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvTable(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const csvMoney = (n) => Number((n || 0).toFixed(4));
function exportCsv(payload, period, data) {
  if (data === 'daily') {
    const srcs = period.sources || [];
    const rows = [['date', 'cost_usd', 'tokens', ...srcs.map((s) => 'cost_' + s)]];
    for (const d of period.daily || []) {
      rows.push([d.date, csvMoney(d.total), d.tokens, ...srcs.map((s) => csvMoney(d.bySource[s]))]);
    }
    return csvTable(rows);
  }
  if (data === 'models' || data === 'sources') {
    const map = (data === 'models' ? period.byModel : period.bySource) || {};
    const keys = Object.keys(map).sort((a, b) => map[b].cost - map[a].cost);
    const rows = [[data === 'models' ? 'model' : 'source', 'cost_usd', 'tokens', 'messages']];
    for (const k of keys) rows.push([k, csvMoney(map[k].cost), map[k].tokens, map[k].messages]);
    return csvTable(rows);
  }
  if (data === 'projects') {
    const rows = [['project', 'cost_usd', 'tokens', 'messages', 'sessions']];
    for (const p of period.byProject || []) rows.push([p.project, csvMoney(p.cost), p.tokens, p.messages, p.sessions]);
    return csvTable(rows);
  }
  if (data === 'sessions') {
    // Whole-session totals (the Recent-sessions table) — not period-scoped.
    const rows = [['title', 'source', 'models', 'effort', 'cost_usd', 'tokens', 'messages', 'last_activity']];
    for (const s of payload.recentSessions || []) {
      rows.push([s.title, s.source, (s.models || []).join('|'),
        (s.ultracode ? ['ultracode'] : []).concat(s.efforts || []).join('|'),
        csvMoney(s.cost), s.tokens, s.messages, new Date(s.lastTs).toISOString()]);
    }
    return csvTable(rows);
  }
  return null;
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
const UPDATE_REPO = 'ReFxFrank/Pulse-Usage-Monitor';
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
  const { asStream = false, timeoutMs = 20000, redirects = 5, headers = null } = opts || {};
  let mod;
  try { mod = u.startsWith('https:') ? require('https') : http; } catch (e) { return cb(e); }
  // mod.get can throw SYNCHRONOUSLY (bad URL, header values with invalid
  // characters → ERR_INVALID_CHAR). Route that to the callback like any other
  // fetch error — a corrupt credentials file must never 500 the caller or
  // strand its in-flight flag.
  let req;
  try {
  req = mod.get(u, {
    headers: {
      'User-Agent': 'pulse-usage-dashboard/' + PULSE_VERSION,
      'Accept': 'application/vnd.github+json, application/octet-stream, */*',
      ...(headers || {}),
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
    if (sc !== 200) {
      res.resume();
      const e = new Error('HTTP ' + sc);
      e.status = sc;
      if (res.headers && res.headers['retry-after']) e.retryAfter = res.headers['retry-after'];
      return cb(e);
    }
    if (asStream) return cb(null, res);
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; if (body.length > 4e6) req.destroy(new Error('response too large')); });
    res.on('end', () => cb(null, body));
    res.on('error', (e) => cb(e));
  });
  } catch (e) { return cb(e); }
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

// ---------------------------------------------------------------------------
// COMMUNITY REACH — how many people use Pulse, from PUBLIC GitHub data only.
// A live "who's online" counter would mean every install phoning home; Pulse
// promises the opposite ("usage data never leaves the machine"). So instead we
// read two PUBLIC, already-there numbers off the same GitHub API the update
// check uses: total release-asset download_count (the best proxy for "people
// using Pulse") and the repo star count. NOTHING about the user is sent — it's
// an outbound GET for public counters, gated by the SAME opt-out as the update
// check (--no-update-check / {"updateCheck":false}). Cached for hours so it
// never approaches GitHub's unauthenticated rate limit.
// ---------------------------------------------------------------------------
const REACH_RELEASES_API = process.env.PULSE_REACH_API ||
  'https://api.github.com/repos/' + UPDATE_REPO + '/releases?per_page=100';
const REACH_REPO_API = process.env.PULSE_REACH_REPO_API ||
  'https://api.github.com/repos/' + UPDATE_REPO;
const REACH_CACHE_MS = Number(process.env.PULSE_REACH_CACHE_MS) || 6 * 3600 * 1000;
const reachState = { downloads: null, stars: null, fetchedAt: 0, status: 'idle' };
let reachInFlight = false;

// Fetch the public counters. Downloads (sum over every release's assets) and
// stars come from two GETs; each independently retains its last-good value on
// error, exactly like the account meters, so a rate-limit blip never blanks the
// badge. Cheap and self-throttled via REACH_CACHE_MS.
function refreshReach(done) {
  if (reachInFlight) return done && done(reachState);
  if (reachState.fetchedAt && Date.now() - reachState.fetchedAt < REACH_CACHE_MS) {
    return done && done(reachState);
  }
  reachInFlight = true;
  fetchUrl(REACH_RELEASES_API, {}, (err, body) => {
    let downloads = null;
    if (!err) {
      try {
        const rels = JSON.parse(body);
        if (Array.isArray(rels)) {
          downloads = 0;
          for (const r of rels) for (const a of (Array.isArray(r.assets) ? r.assets : [])) {
            downloads += num(a.download_count);
          }
        }
      } catch (_) { /* leave null → keep last-good */ }
    }
    fetchUrl(REACH_REPO_API, {}, (err2, body2) => {
      let stars = null;
      if (!err2) {
        try {
          const repo = JSON.parse(body2);
          if (repo && typeof repo.stargazers_count === 'number') stars = repo.stargazers_count;
        } catch (_) { /* leave null → keep last-good */ }
      }
      reachInFlight = false;
      reachState.fetchedAt = Date.now();
      if (downloads != null) reachState.downloads = downloads;
      if (stars != null) reachState.stars = stars;
      reachState.status = (reachState.downloads != null || reachState.stars != null) ? 'ok' : 'error';
      if (downloads != null || stars != null) {
        console.log(`[pulse] community reach: ${reachState.downloads != null ? reachState.downloads : '?'} downloads, ${reachState.stars != null ? reachState.stars : '?'} stars`);
      }
      done && done(reachState);
    });
  });
}

// Payload view: expose the counters only once at least one has been fetched
// (so a disabled/never-fetched reach simply omits the badge).
function reachForPayload() {
  if (reachState.downloads == null && reachState.stars == null) return null;
  return {
    downloads: reachState.downloads,
    stars: reachState.stars,
    fetchedAt: reachState.fetchedAt,
    repo: UPDATE_REPO,
  };
}

// ---------------------------------------------------------------------------
// ACCOUNT METERS (opt-in) — Anthropic's OFFICIAL usage gauges.
// Claude Pro/Max limits are unified: claude.ai chats, Claude Code, cloud
// sessions and other machines all drain the same 5-hour and weekly windows.
// The same endpoint Claude Code's /usage command reads —
// GET api.anthropic.com/api/oauth/usage — reports that account-wide
// utilization with TRUE reset times, covering usage no local log ever sees.
//
// Privacy contract (documented in README, enforced here):
//   - OFF by default; enabled only via the dashboard toggle
//     ({"accountMeters": true} in ~/.pulse/config.json).
//   - The OAuth token is read from ~/.claude/.credentials.json READ-ONLY,
//     never logged, never included in any payload, and sent ONLY to the
//     meters endpoint. Pulse never refreshes tokens (that would mean writing
//     credentials): an expired login shows "open Claude Code to re-login".
//   - PULSE_METERS_API overrides the endpoint for tests (mock server).
// The endpoint is internal/undocumented — parse defensively, degrade quietly.
// ---------------------------------------------------------------------------
const METERS_API_URL = process.env.PULSE_METERS_API || 'https://api.anthropic.com/api/oauth/usage';
// Base cadence 120s; 429s back off (Retry-After honored, else 10m doubling to
// 1h) and other errors wait 5m — the endpoint is shared with Claude Code
// itself, so Pulse must be a polite citizen. Env override is a test hook.
const METERS_OK_MS = parseInt(process.env.PULSE_METERS_CACHE_MS, 10) || 120 * 1000;
const METERS_ERR_MS = Math.min(METERS_OK_MS * 2, 5 * 60 * 1000);
const METERS_429_BASE_MS = Math.min(METERS_OK_MS * 5, 10 * 60 * 1000);
const METERS_429_MAX_MS = 60 * 60 * 1000;

const metersState = {
  status: 'off',   // off | ok | no-login | expired | error | rate-limited
  buckets: [],     // [{ key, label, pct, resetsAt }] — kept through errors
  fetchedAt: null,
  lastGoodAt: null,
  nextAttemptAt: 0,
  error: null,
};
let metersInFlight = false;
let meters429Streak = 0;

function metersEnabled() {
  return readConfig().accountMeters === true;
}

// Parse a credentials JSON blob (file or Keychain item — same shape) into
// { token, expiresAt } or null. NEVER log or transmit the token anywhere
// except the meters endpoint.
function parseCredentials(raw) {
  try {
    const j = JSON.parse(String(raw).trim());
    const o = (j && j.claudeAiOauth) || j || {};
    const token = o.accessToken;
    if (typeof token !== 'string' || !token) return null;
    let expiresAt = typeof o.expiresAt === 'number' && isFinite(o.expiresAt) ? o.expiresAt : null;
    if (expiresAt && expiresAt < 1e12) expiresAt *= 1000; // tolerate seconds-unit stamps
    return { token, expiresAt };
  } catch (_) {
    return null;
  }
}

// Async token lookup: ~/.claude/.credentials.json first (Windows/Linux), then
// the macOS login Keychain, where Claude Code stores credentials by default on
// Macs. The Keychain read shells out to /usr/bin/security ASYNCHRONOUSLY — it
// can pop a one-time permission dialog, and that must never block the server.
// Results (including misses) are cached briefly so the dialog can't nag.
const IS_MAC = process.platform === 'darwin' || process.env.PULSE_FAKE_DARWIN === '1'; // env: test hook
const SECURITY_BIN = process.env.PULSE_SECURITY_BIN || '/usr/bin/security';
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'];
let credCache = { at: 0, cred: null };
const CRED_CACHE_MS = 5 * 60 * 1000;

function readOauthTokenAsync(cb) {
  cb = once(cb);
  if (Date.now() - credCache.at < CRED_CACHE_MS) return cb(credCache.cred);
  const remember = (cred) => { credCache = { at: Date.now(), cred }; cb(cred); };

  try {
    const raw = fs.readFileSync(path.join(claudeDir(), '.credentials.json'), 'utf8');
    const cred = parseCredentials(raw);
    if (cred) return remember(cred);
  } catch (_) { /* no file — fall through */ }

  if (!IS_MAC) return remember(null);

  // Try each known Keychain service name in turn.
  const tryService = (i) => {
    if (i >= KEYCHAIN_SERVICES.length) return remember(null);
    let fired = false;
    const child = require('child_process').execFile(
      SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICES[i], '-w'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }, // generous: a permission dialog may be up
      (err, stdout) => {
        if (fired) return;
        fired = true;
        const cred = !err && stdout ? parseCredentials(stdout) : null;
        if (cred) return remember(cred);
        tryService(i + 1);
      }
    );
    child.on('error', () => { if (!fired) { fired = true; tryService(i + 1); } });
  };
  tryService(0);
}

// Two providers share the Account-limits card — every row names its provider.
const METER_LABELS = {
  five_hour: 'Claude · 5-hour session',
  seven_day: 'Claude · weekly (all models)',
  seven_day_overall: 'Claude · weekly (all models)',
  seven_day_opus: 'Claude · weekly · Opus',
  seven_day_sonnet: 'Claude · weekly · Sonnet',
  seven_day_oauth_apps: 'Claude · weekly · apps',
};

// Normalize one usage bucket from the API response. utilization has been seen
// both as a 0–1 fraction and a 0–100 percent across versions; values ≤ 1 are
// treated as fractions (a true 0.x% reads the same either way at the bar).
function parseMeterBucket(key, v) {
  if (!v || typeof v !== 'object') return null;
  let u = v.utilization;
  if (typeof u !== 'number' || !isFinite(u)) return null;
  const pct = u <= 1 ? u * 100 : u;
  let resetsAt = null;
  if (v.resets_at) {
    const t = typeof v.resets_at === 'number' ? v.resets_at * (v.resets_at < 1e12 ? 1000 : 1) : Date.parse(v.resets_at);
    if (isFinite(t)) resetsAt = t;
  }
  return { key, label: METER_LABELS[key] || 'Claude · ' + key.replace(/_/g, ' '), pct: Math.max(0, Math.min(100, pct)), resetsAt };
}

function refreshAccountMeters(done) {
  if (!metersEnabled()) { metersState.status = 'off'; return done && done(metersState); }
  if (metersInFlight) return done && done(metersState);
  metersInFlight = true; // guards the credential lookup too (Keychain dialogs)
  const schedule = (ms) => { metersState.nextAttemptAt = Date.now() + ms; };
  readOauthTokenAsync((cred) => {
  if (!cred) {
    metersInFlight = false;
    schedule(METERS_OK_MS);
    metersState.status = 'no-login';
    metersState.error = IS_MAC
      ? 'No Claude Code login found — Pulse checked ~/.claude/.credentials.json and the macOS Keychain. ' +
        'If a Keychain permission dialog appeared, choose "Always Allow"; if you have never used Claude Code ' +
        'on this Mac, run `claude` in Terminal once.'
      : 'No Claude Code login found on this machine — run `claude` in a terminal once to log in.';
    return done && done(metersState);
  }
  // NOTE: even if the stored expiresAt looks past, ATTEMPT the request — the
  // API is the source of truth for token validity. A local timestamp (odd
  // units, clock skew, refreshed-out-of-band tokens) must never brick the
  // card; only a real 401/403 means expired.
  const looksExpired = !!(cred.expiresAt && cred.expiresAt < Date.now());
  fetchUrl(METERS_API_URL, {
    timeoutMs: 8000,
    headers: {
      'Authorization': 'Bearer ' + cred.token,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  }, (err, body) => {
    metersInFlight = false;
    // Disabled while the request was in flight: don't resurrect cleared state.
    if (!metersEnabled()) { metersState.status = 'off'; return done && done(metersState); }
    metersState.fetchedAt = Date.now();
    if (err) {
      if (err.status === 429) {
        // Rate-limited: honor Retry-After when given, else exponential backoff.
        // Last good buckets stay on screen — being throttled is not data loss.
        meters429Streak++;
        let waitMs = null;
        const ra = err.retryAfter;
        if (ra != null) {
          const sec = parseInt(ra, 10);
          if (isFinite(sec) && sec > 0) waitMs = sec * 1000;
          else { const t = Date.parse(ra); if (isFinite(t)) waitMs = t - Date.now(); }
        }
        if (waitMs == null || !isFinite(waitMs) || waitMs <= 0) {
          waitMs = Math.min(METERS_429_BASE_MS * Math.pow(2, meters429Streak - 1), METERS_429_MAX_MS);
        }
        waitMs = Math.max(5000, Math.min(waitMs, METERS_429_MAX_MS));
        schedule(waitMs);
        metersState.status = 'rate-limited';
        metersState.error = 'Anthropic rate-limited the usage check (HTTP 429) — retrying in ~' +
          Math.max(1, Math.round(waitMs / 60000)) + 'm. If this persists, something else on this machine ' +
          '(e.g. a statusline script) may be polling the usage endpoint heavily.';
        console.warn('[pulse] account meters: ' + metersState.error);
        return done && done(metersState);
      }
      schedule(METERS_ERR_MS);
      metersState.status = /HTTP 401|HTTP 403/.test(err.message) ? 'expired' : 'error';
      metersState.error = metersState.status === 'expired'
        ? 'Claude rejected the login (' + err.message + ')' +
          (looksExpired ? ' — the token file is stale. ' : ' — ') +
          'Start a Claude Code CLI session on this machine (run `claude` in a terminal) to refresh ' +
          '~/.claude/.credentials.json; the desktop app keeps its own login and may not update that file. ' +
          'Pulse never writes credentials.'
        : 'meters fetch failed: ' + err.message;
      console.warn('[pulse] account meters: ' + metersState.error);
      return done && done(metersState);
    }
    meters429Streak = 0;
    schedule(METERS_OK_MS);
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    if (!j || typeof j !== 'object') {
      schedule(METERS_ERR_MS);
      metersState.status = 'error';
      metersState.error = 'unexpected meters response';
      return done && done(metersState);
    }
    const buckets = [];
    for (const key of Object.keys(j)) {
      const b = parseMeterBucket(key, j[key]);
      if (b) buckets.push(b);
    }
    // Newer accounts report per-model weekly windows (the /usage panel's
    // "Weekly · Fable" row) in a limits[] array — kind "weekly_scoped" with
    // scope.model.display_name — not as dedicated seven_day_* keys.
    if (Array.isArray(j.limits)) {
      for (const lim of j.limits) {
        if (!lim || typeof lim !== 'object' || lim.kind !== 'weekly_scoped') continue;
        const name = lim.scope && lim.scope.model && typeof lim.scope.model.display_name === 'string'
          ? lim.scope.model.display_name.trim() : '';
        if (!name || typeof lim.percent !== 'number' || !isFinite(lim.percent)) continue;
        const pct = lim.percent <= 1 ? lim.percent * 100 : lim.percent;
        let resetsAt = null;
        if (lim.resets_at) {
          const t = typeof lim.resets_at === 'number'
            ? lim.resets_at * (lim.resets_at < 1e12 ? 1000 : 1) : Date.parse(lim.resets_at);
          if (isFinite(t)) resetsAt = t;
        }
        const label = 'Claude · weekly · ' + name;
        // Skip if a legacy key already produced this row (e.g. seven_day_opus).
        if (buckets.some((b) => b.label.toLowerCase() === label.toLowerCase())) continue;
        buckets.push({ key: 'model_scoped:' + name.toLowerCase(), label, pct: Math.max(0, Math.min(100, pct)), resetsAt });
      }
    }
    // Stable, meaningful order: 5h, then overall weekly, then scoped windows.
    const rank = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' || k === 'seven_day_overall' ? 1 : 2);
    buckets.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
    recordMeterSamples(buckets);
    metersState.buckets = buckets;
    metersState.status = 'ok';
    metersState.lastGoodAt = Date.now();
    metersState.error = buckets.length ? null : 'no usage buckets in response';
    console.log(`[pulse] account meters refreshed (${buckets.length} bucket(s))`);
    done && done(metersState);
  });
  }); // readOauthTokenAsync
}

// The freshest official five-hour bucket, if usable: its resets_at is an
// absolute timestamp, so even a snapshot fetched a while ago (or during a
// rate-limit backoff) keeps telling the exact true reset time.
function officialFiveHourBucket() {
  if (!metersEnabled()) return null;
  const b = (metersState.buckets || []).find((x) => x.key === 'five_hour');
  return b && b.resetsAt ? b : null;
}

// ---------------------------------------------------------------------------
// CODEX ACCOUNT TOKEN USAGE (opt-in — same switch as the account meters)
// GET chatgpt.com/backend-api/wham/profiles/me — the endpoint behind the
// Codex TUI's own token chart (TokenUsageProfile in openai/codex). Unlike
// Anthropic's usage endpoint (percentages only), this returns REAL token
// counts, account-wide across every device: lifetime, peak day, streaks and
// per-day buckets. The ChatGPT OAuth token is read from ~/.codex/auth.json
// READ-ONLY, never logged, and sent only to this endpoint. Polled gently —
// the numbers move at day granularity.
// ---------------------------------------------------------------------------
const CODEX_USAGE_API_URL = process.env.PULSE_CODEX_USAGE_API ||
  'https://chatgpt.com/backend-api/wham/profiles/me';
const CODEX_USAGE_OK_MS = parseInt(process.env.PULSE_CODEX_USAGE_CACHE_MS, 10) || 10 * 60 * 1000;
const CODEX_USAGE_ERR_MS = Math.min(CODEX_USAGE_OK_MS * 2, 20 * 60 * 1000);
const CODEX_USAGE_429_MAX_MS = 60 * 60 * 1000;

const codexUsageState = {
  status: 'off',   // off | ok | no-login | expired | error | rate-limited
  stats: null,     // normalized token totals — kept through errors
  fetchedAt: null,
  lastGoodAt: null,
  nextAttemptAt: 0,
  error: null,
};
let codexUsageInFlight = false;
let codexUsage429Streak = 0;

// ~/.codex/auth.json → { token, accountId } or null. An API-key-only login
// (no ChatGPT tokens) can't call the account endpoint — treated as no-login.
// Values go into HTTP headers, so anything with header-invalid characters
// (a corrupt or hand-edited file) is rejected here rather than allowed to
// blow up the request.
const HEADER_SAFE = /^[\x21-\x7e]+$/; // printable ASCII, no whitespace/CTLs
function readCodexAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(codexDir(), 'auth.json'), 'utf8'));
    const t = j && j.tokens;
    if (t && typeof t.access_token === 'string' && HEADER_SAFE.test(t.access_token)) {
      return {
        token: t.access_token,
        accountId: typeof t.account_id === 'string' && HEADER_SAFE.test(t.account_id) ? t.account_id : null,
      };
    }
  } catch (_) { /* missing/unreadable → no-login */ }
  return null;
}

// Normalize TokenUsageProfile.stats. All fields are optional server-side;
// aggregates (today / last 7 / last 30 days) are computed here so the UI
// stays dumb. Bucket dates are YYYY-MM-DD (UTC day keys).
function normalizeCodexUsage(j) {
  if (!j || typeof j !== 'object') return null;
  const hasStats = j.stats && typeof j.stats === 'object';
  const s = hasStats ? j.stats : j;
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const buckets = [];
  if (Array.isArray(s.daily_usage_buckets)) {
    for (const b of s.daily_usage_buckets) {
      if (!b || typeof b.start_date !== 'string' || typeof b.tokens !== 'number' || !isFinite(b.tokens)) continue;
      const date = b.start_date.slice(0, 10);
      // Aggregates compare dates lexicographically — a malformed string
      // (e.g. "N/A") would sort past every cutoff and pollute the sums.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      buckets.push({ date, tokens: b.tokens });
    }
    buckets.sort((a, b) => a.date.localeCompare(b.date));
  }
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = dayKey(Date.now());
  const cutoff7 = dayKey(Date.now() - 6 * 24 * 3600 * 1000);
  const cutoff30 = dayKey(Date.now() - 29 * 24 * 3600 * 1000);
  let todayTokens = 0, last7 = 0, last30 = 0;
  for (const b of buckets) {
    if (b.date === today) todayTokens += b.tokens;
    if (b.date >= cutoff7) last7 += b.tokens;
    if (b.date >= cutoff30) last30 += b.tokens;
  }
  // A response with a stats object is valid even when every field is absent
  // or zero (brand-new account) — that's "ok, zero usage", not an error.
  // Only a shape with no stats object AND no recognizable fields at the root
  // is genuinely unexpected.
  const hasSignal = buckets.length > 0 || n(s.lifetime_tokens) != null || n(s.peak_daily_tokens) != null;
  if (!hasStats && !hasSignal) return null;
  return {
    lifetimeTokens: n(s.lifetime_tokens),
    peakDailyTokens: n(s.peak_daily_tokens),
    currentStreakDays: n(s.current_streak_days),
    todayTokens, last7Tokens: last7, last30Tokens: last30,
    buckets: buckets.slice(-30), // enough for the daily mini-chart
  };
}

// Separate consent from the Claude meters: users who opted in before v1.6.0
// consented to api.anthropic.com only. The dashboard's enable button (a fresh
// gesture, with copy naming both endpoints) sets BOTH keys; a pre-existing
// {accountMeters: true} alone keeps the ChatGPT call off until re-toggled.
function codexUsageEnabled() {
  return readConfig().codexAccountUsage === true;
}

function refreshCodexUsage(done) {
  if (!codexUsageEnabled()) { codexUsageState.status = 'off'; return done && done(codexUsageState); }
  if (codexUsageInFlight) return done && done(codexUsageState);
  codexUsageInFlight = true;
  const schedule = (ms) => { codexUsageState.nextAttemptAt = Date.now() + ms; };
  const auth = readCodexAuth();
  if (!auth) {
    codexUsageInFlight = false;
    schedule(CODEX_USAGE_OK_MS);
    codexUsageState.status = 'no-login';
    codexUsageState.error = 'No ChatGPT login found in ~/.codex/auth.json — run `codex` once to sign in. ' +
      '(API-key-only logins have no account usage endpoint.)';
    return done && done(codexUsageState);
  }
  const headers = {
    'Authorization': 'Bearer ' + auth.token,
    'Content-Type': 'application/json',
    'User-Agent': 'pulse-usage-dashboard/' + PULSE_VERSION,
  };
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
  fetchUrl(CODEX_USAGE_API_URL, { timeoutMs: 8000, headers }, (err, body) => {
    codexUsageInFlight = false;
    // Disabled while the request was in flight: the off-handler already
    // cleared the state — don't resurrect it with a stale write.
    if (!codexUsageEnabled()) { codexUsageState.status = 'off'; return done && done(codexUsageState); }
    codexUsageState.fetchedAt = Date.now();
    if (err) {
      if (err.status === 429) {
        codexUsage429Streak++;
        let waitMs = null;
        const ra = err.retryAfter;
        if (ra != null) {
          const sec = parseInt(ra, 10);
          if (isFinite(sec) && sec > 0) waitMs = sec * 1000;
          else { const t = Date.parse(ra); if (isFinite(t)) waitMs = t - Date.now(); }
        }
        if (waitMs == null || !isFinite(waitMs) || waitMs <= 0) {
          waitMs = Math.min(CODEX_USAGE_OK_MS * Math.pow(2, codexUsage429Streak - 1), CODEX_USAGE_429_MAX_MS);
        }
        waitMs = Math.max(5000, Math.min(waitMs, CODEX_USAGE_429_MAX_MS));
        schedule(waitMs);
        codexUsageState.status = 'rate-limited';
        codexUsageState.error = 'ChatGPT rate-limited the usage check (HTTP 429) — retrying in ~' +
          Math.max(1, Math.round(waitMs / 60000)) + 'm.';
        console.warn('[pulse] codex account usage: ' + codexUsageState.error);
        return done && done(codexUsageState);
      }
      schedule(CODEX_USAGE_ERR_MS);
      codexUsageState.status = /HTTP 401|HTTP 403/.test(err.message) ? 'expired' : 'error';
      codexUsageState.error = codexUsageState.status === 'expired'
        ? 'ChatGPT rejected the Codex login (' + err.message + ') — run `codex` in a terminal once to ' +
          'refresh ~/.codex/auth.json. Pulse never writes credentials.'
        : 'codex usage fetch failed: ' + err.message;
      console.warn('[pulse] codex account usage: ' + codexUsageState.error);
      return done && done(codexUsageState);
    }
    codexUsage429Streak = 0;
    schedule(CODEX_USAGE_OK_MS);
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    const stats = normalizeCodexUsage(j);
    if (!stats) {
      schedule(CODEX_USAGE_ERR_MS);
      codexUsageState.status = 'error';
      codexUsageState.error = 'unexpected codex usage response';
      return done && done(codexUsageState);
    }
    codexUsageState.stats = stats;
    codexUsageState.status = 'ok';
    codexUsageState.lastGoodAt = Date.now();
    codexUsageState.error = null;
    console.log('[pulse] codex account usage refreshed (' + stats.buckets.length + ' day bucket(s))');
    done && done(codexUsageState);
  });
}

// Lazily refresh on summary builds; serve the cached state immediately.
// Same background trickle as the Claude meters — a status line / Discord build
// only pokes chatgpt.com when the token totals are already stale.
function codexUsageForPayload(background) {
  if (!codexUsageEnabled()) return { enabled: false };
  const due = Date.now() >= (codexUsageState.nextAttemptAt || 0);
  const bgOk = !background || (Date.now() - (codexUsageState.fetchedAt || 0) >= BACKGROUND_METERS_MS);
  if (due && bgOk) {
    refreshCodexUsage(); // async; next poll picks it up
  }
  return {
    enabled: true,
    status: codexUsageState.status === 'off' ? 'loading' : codexUsageState.status,
    stats: codexUsageState.stats,
    fetchedAt: codexUsageState.fetchedAt,
    lastGoodAt: codexUsageState.lastGoodAt,
    error: codexUsageState.error,
  };
}

// ---------------------------------------------------------------------------
// DISCORD RICH PRESENCE (opt-in, off by default)
// Talks the Discord desktop client's local IPC protocol directly — a named
// pipe on Windows, a Unix socket elsewhere; 8-byte header (op + length,
// little-endian) followed by JSON. No SDK, no network: the socket is local,
// and Discord's own client does the publishing. Zero-dependency by design.
// NOTE: presence is PUBLIC to anyone who can see your Discord profile —
// that's the whole point, but it's why this is opt-in and the copy says so.
// Requires a Discord Application ID (free, discord.com/developers) in
// config discordClientId — client IDs are public identifiers, not secrets.
// ---------------------------------------------------------------------------
// The official Pulse application (registered by the repo owner). Client IDs
// are public identifiers — every rich-presence tool ships one. Override with
// config discordClientId / env PULSE_DISCORD_CLIENT_ID to use your own app.
const DISCORD_CLIENT_ID_DEFAULT = '1527236432375189535';
const DISCORD_TICK_MS = parseInt(process.env.PULSE_DISCORD_TICK_MS, 10) || 15 * 1000;
const DISCORD_RETRY_MS = 30 * 1000;
const DISCORD_FAST_RETRY_MS = 4 * 1000; // quick re-sweeps right after a miss (startup race)
const PULSE_REPO_URL = 'https://github.com/ReFxFrank/Pulse-Usage-Monitor';

function discordEnabled() { return readConfig().discordPresence === true; }
function discordClientId() {
  const c = readConfig();
  return process.env.PULSE_DISCORD_CLIENT_ID ||
    (typeof c.discordClientId === 'string' && /^\d{5,25}$/.test(c.discordClientId) ? c.discordClientId : '') ||
    DISCORD_CLIENT_ID_DEFAULT;
}

const discordState = {
  status: 'off', // off | no-client-id | connecting | ok | discord-not-found | error
  error: null,
  connectedAt: null,
};
let discordSock = null;
let discordReady = false;
let discordConnecting = false;
let discordNonce = 0;
let discordLastActivity = '';
let discordNextAttemptAt = 0;
let discordNotFoundStreak = 0; // consecutive failed sweeps → fast retries first, then back off

// Candidate IPC socket paths, most likely first. Discord numbers them 0-9;
// Linux packagings (snap/flatpak) nest them one directory deeper.
function discordIpcCandidates() {
  if (process.env.PULSE_DISCORD_IPC) return [process.env.PULSE_DISCORD_IPC];
  const out = [];
  if (process.platform === 'win32') {
    // Discord's named pipe lives in the same object namespace under either
    // prefix; some Node/Windows combos connect via one but not the other, so
    // try both forms of each index (\\.\pipe\ then \\?\pipe\).
    for (let i = 0; i < 10; i++) {
      out.push('\\\\.\\pipe\\discord-ipc-' + i);
      out.push('\\\\?\\pipe\\discord-ipc-' + i);
    }
    return out;
  }
  const bases = [];
  for (const b of [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, '/tmp']) {
    if (b && !bases.includes(b)) bases.push(b);
  }
  for (const b of bases) {
    for (const sub of ['', 'snap.discord', 'app/com.discordapp.Discord']) {
      for (let i = 0; i < 10; i++) out.push(path.join(b, sub, 'discord-ipc-' + i));
    }
  }
  return out;
}

function discordFrame(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function discordDisconnect() {
  if (discordSock) { try { discordSock.destroy(); } catch (_) {} }
  discordSock = null;
  discordReady = false;
  discordLastActivity = '';
}

// Try each candidate socket in order; first successful handshake wins.
function discordConnect() {
  if (discordConnecting || discordSock) return;
  const id = discordClientId();
  if (!id) {
    discordState.status = 'no-client-id';
    discordState.error = 'No Discord application ID configured — set discordClientId in ~/.pulse/config.json ' +
      '(create one free at discord.com/developers/applications).';
    return;
  }
  discordConnecting = true;
  const candidates = discordIpcCandidates();
  let idx = 0;
  const tryNext = () => {
    if (idx >= candidates.length) {
      discordConnecting = false;
      discordState.status = 'discord-not-found';
      discordState.error = 'Discord desktop client not found — is it running? (Browser Discord has no local IPC.) ' +
        'If Discord is open, make sure it and Pulse run at the same privilege level (both normal, or both as admin). ' +
        'Pulse retries automatically.';
      // Fast re-sweeps for the first few misses (covers a Discord/Pulse startup
      // race — heals in seconds instead of leaving "not found" up for 30s),
      // then back off. A one-shot timer drives the quick retries so they don't
      // wait for the slower 15s tick.
      discordNotFoundStreak++;
      const wait = discordNotFoundStreak <= 4 ? DISCORD_FAST_RETRY_MS : DISCORD_RETRY_MS;
      discordNextAttemptAt = Date.now() + wait;
      if (wait < DISCORD_TICK_MS) {
        const t = setTimeout(() => {
          if (discordEnabled() && !discordSock && !discordConnecting && Date.now() >= discordNextAttemptAt) discordConnect();
        }, wait + 50);
        if (t.unref) t.unref();
      }
      return;
    }
    const p = candidates[idx++];
    let sock;
    try { sock = net.connect(p); } catch (_) { return tryNext(); } // bad path → next candidate
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = () => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch (_) {}
      tryNext();
    };
    sock.setTimeout(3000, fail); // connect + handshake; dead Windows pipes still error instantly
    sock.on('error', () => {
      if (settled) return fail();
      // post-handshake error: drop and retry later
      discordDisconnect();
      discordState.status = 'connecting';
      discordNextAttemptAt = Date.now() + DISCORD_RETRY_MS;
    });
    sock.on('connect', () => {
      sock.write(discordFrame(0, { v: 1, client_id: id }));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = null;
        try { msg = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch (_) {}
        buf = buf.slice(8 + len);
        if (!msg) continue;
        if (!settled && msg.evt === 'READY') {
          settled = true;
          discordConnecting = false;
          discordNotFoundStreak = 0; // connected — reset the fast-retry counter
          discordSock = sock;
          discordReady = true;
          discordState.status = 'ok';
          discordState.error = null;
          discordState.connectedAt = Date.now();
          console.log('[pulse] discord presence connected (' + p + ')');
          sock.setTimeout(0);
          discordTick(); // publish immediately
        } else if (msg.evt === 'ERROR') {
          // e.g. invalid client id — surface it, don't hammer
          discordState.status = 'error';
          discordState.error = 'Discord: ' + ((msg.data && msg.data.message) || 'unknown error');
          console.warn('[pulse] discord presence: ' + discordState.error);
        }
      }
    });
    sock.on('close', () => {
      if (!settled) return fail();
      // Discord quit or restarted — reconnect on a later tick.
      discordDisconnect();
      if (discordEnabled()) {
        discordState.status = 'connecting';
        discordNextAttemptAt = Date.now() + 5000;
      }
    });
  };
  discordState.status = 'connecting';
  tryNext();
}

// $ and token formatting for the activity strings (server-side, tiny).
function fmtMoney(v) { return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)); }
function fmtTok(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

// Compose the activity from the same aggregates the dashboard shows.
// buildSummary() is mtime-cached, so a 15s cadence costs ~the same as one
// dashboard poll. Numbers shown: today's spend/tokens + live window meters.
// Page rotation cadence: default 45s (comfortably above Discord's 15s update
// floor), configurable via discordRotateSecs (clamped 15–300) or the test
// hook PULSE_DISCORD_ROTATE_MS. Pages derive from the wall clock, so no
// rotation state survives reconnects — it just keeps cycling.
const DISCORD_ROTATE_MS_DEFAULT = 45 * 1000;
function discordRotateMs() {
  const env = parseInt(process.env.PULSE_DISCORD_ROTATE_MS, 10);
  if (isFinite(env) && env >= 500) return env;
  const c = readConfig().discordRotateSecs;
  if (typeof c === 'number' && isFinite(c)) return Math.min(300, Math.max(15, c)) * 1000;
  return DISCORD_ROTATE_MS_DEFAULT;
}

// Discord's elapsed-time counter is anchored to `timestamps.start`. Anchoring
// it to SERVER_START would reset the timer to 0 on every process restart —
// including the relaunch a self-update performs — which is jarring (your
// "Pulse for 3h" jumps back to 0s just because it updated). So we PERSIST the
// anchor to ~/.pulse and reuse it when Pulse was only briefly down: definitely
// on a post-update relaunch (IS_AFTER_UPDATE), and on a quick manual restart
// (last heartbeat within the grace window). A cold start after a long gap
// resets, so the counter never shows a misleading multi-day age.
const DISCORD_START_GRACE_MS = 10 * 60 * 1000;
function discordStartFilePath() { return path.join(pulseHome(), 'discord-presence.json'); }
let discordStart = null;         // resolved presence anchor (ms epoch)
let discordStartLastSaved = 0;   // last heartbeat write (throttle)
function persistDiscordStart(now) {
  if (discordStart == null) return;
  try {
    fs.mkdirSync(pulseHome(), { recursive: true });
    fs.writeFileSync(discordStartFilePath(), JSON.stringify({ start: discordStart, savedAt: now }));
    discordStartLastSaved = now;
  } catch (_) { /* ~/.pulse unwritable → timer just resets next relaunch */ }
}
function discordPresenceStart() {
  if (discordStart != null) return discordStart;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(discordStartFilePath(), 'utf8')); } catch (_) {}
  // Anchor must be a plausible recent epoch: not in the future, and not absurdly
  // old (a corrupt/zero value would otherwise show a nonsense multi-year timer).
  const validPrev = prev && typeof prev.start === 'number' && isFinite(prev.start)
    && prev.start <= SERVER_START && (SERVER_START - prev.start) < 400 * 86400e3;
  const recent = validPrev && typeof prev.savedAt === 'number' && (SERVER_START - prev.savedAt) < DISCORD_START_GRACE_MS;
  // Reuse the old anchor across an update relaunch or a brief restart; else
  // begin a fresh session at this process's start.
  discordStart = (validPrev && (IS_AFTER_UPDATE || recent)) ? prev.start : SERVER_START;
  persistDiscordStart(SERVER_START);
  return discordStart;
}

function buildDiscordActivity() {
  let s = null;
  try { s = buildSummary(null, { background: true }); } catch (_) { return null; }
  if (!s) return null;
  // One period per page — Today / Past 7 days / All-time — alternating on
  // the shared clock. Single line: tokens + spend, nothing else.
  const pages = [
    { label: 'Today', tokens: s.today.tokens, cost: s.today.cost },
    { label: 'Past 7 days', tokens: s.week.tokens, cost: s.week.cost },
    { label: 'All-time', tokens: s.totals.tokens, cost: s.totals.cost },
  ];
  const p = pages[Math.floor(Date.now() / discordRotateMs()) % pages.length];
  const details = p.label + ': ' + fmtTok(p.tokens) + ' tokens · ' + fmtMoney(p.cost);
  // The large logo tracks who you're actively using: Claude → the Claude art,
  // Codex → the Codex art, idle → Pulse. Asset keys must exist in the Discord
  // application's Rich Presence art (upload images keyed claude / codex / pulse);
  // an unknown key just renders no image, so this degrades cleanly. Each key is
  // overridable in config (discordClaudeImage / discordCodexImage / discordLargeImage).
  const cfg = readConfig();
  const prov = s.activeProvider;
  const asset = prov === 'codex' ? (cfg.discordCodexImage || 'codex')
    : prov === 'claude' ? (cfg.discordClaudeImage || 'claude')
    : (cfg.discordLargeImage || 'pulse');
  const assetText = prov === 'codex' ? 'Using OpenAI Codex'
    : prov === 'claude' ? 'Using Claude Code'
    : 'Pulse — idle';
  return {
    details: details.slice(0, 128),
    timestamps: { start: discordPresenceStart() }, // persisted → survives update relaunches
    assets: {
      large_image: asset,
      large_text: assetText,
    },
    buttons: [{ label: 'Get Pulse', url: PULSE_REPO_URL }],
    instance: false,
  };
}

function discordSetActivity(activity) {
  if (!discordSock || !discordReady) return;
  try {
    discordSock.write(discordFrame(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: String(++discordNonce),
    }));
  } catch (_) { discordDisconnect(); }
}

function discordTick() {
  if (!discordEnabled()) return;
  if (!discordSock) {
    if (Date.now() >= discordNextAttemptAt) discordConnect();
    return;
  }
  const act = buildDiscordActivity();
  if (!act) return;
  // Heartbeat the persisted anchor (throttled) so a brief manual restart also
  // continues the timer, not just post-update relaunches.
  const nowTs = Date.now();
  if (nowTs - discordStartLastSaved >= 60000) persistDiscordStart(nowTs);
  const key = JSON.stringify(act);
  if (key === discordLastActivity) return; // only send real changes
  discordLastActivity = key;
  discordSetActivity(act);
}

let discordTimer = null;
function startDiscordLoop() {
  if (discordTimer) return;
  discordTimer = setInterval(discordTick, DISCORD_TICK_MS);
  if (discordTimer.unref) discordTimer.unref(); // never keep the process alive
  if (discordEnabled()) discordTick();
}

function discordForPayload() {
  if (!discordEnabled()) return { enabled: false, status: 'off' };
  return { enabled: true, status: discordState.status === 'off' ? 'connecting' : discordState.status, error: discordState.error };
}

// ---------------------------------------------------------------------------
// STATUSLINE FEED (§7)
// A tiny projection for `pulse --statusline` — today's cross-tool spend, the
// current 5-hour block, and the official meter percentages Pulse already
// caches. Memoized ~3s so the frequently-invoked statusline never triggers a
// heavy rebuild, and (crucially) so it reads Pulse's CACHED meters rather than
// hitting the provider endpoints itself — one shared poller, no 429 storms.
// ---------------------------------------------------------------------------
let statuslineMemo = { at: 0, data: null };
function statuslineMeterPcts(s) {
  const out = {};
  if (s.meters && s.meters.enabled && Array.isArray(s.meters.buckets)) {
    const fh = s.meters.buckets.find((b) => b.key === 'five_hour');
    const wk = s.meters.buckets.find((b) => b.key === 'seven_day' || b.key === 'seven_day_overall');
    if (fh) out.claudeFiveHour = Math.round(fh.pct);
    if (wk) out.claudeWeekly = Math.round(wk.pct);
  }
  if (s.codexMeters && Array.isArray(s.codexMeters.buckets)) {
    const cw = s.codexMeters.buckets.find((b) => b.key === 'codex_secondary' && !b.stale);
    if (cw) out.codexWeekly = Math.round(cw.pct);
  }
  return out;
}
function statuslineData() {
  const now = Date.now();
  if (statuslineMemo.data && now - statuslineMemo.at < 3000) return statuslineMemo.data;
  let s = null;
  try { s = buildSummary(null, { background: true }); } catch (_) {}
  const d = s ? {
    today: { cost: s.today.cost, tokens: s.today.tokens },
    week: { cost: s.week.cost, tokens: s.week.tokens },
    block: (s.currentBlock && s.currentBlock.end > now)
      ? { cost: s.currentBlock.cost, endsAt: s.currentBlock.end, official: !!s.currentBlock.official }
      : null,
    meters: statuslineMeterPcts(s),
    // The tray polls this feed; when the toggle turns the tray off it sees
    // trayEnabled:false here and exits itself. trayDesired covers a
    // flag-started tray with no config key. trayStyle drives the icon↔strip
    // handoff (a mismatch relaunches the tray from the rewritten script).
    trayEnabled: trayDesired !== null ? trayDesired : readConfig().tray === true,
    trayStyle: trayStyle(),
    version: PULSE_VERSION,
  } : { today: null, trayEnabled: trayDesired !== null ? trayDesired : readConfig().tray === true, trayStyle: trayStyle(), version: PULSE_VERSION };
  statuslineMemo = { at: now, data: d };
  return d;
}

// How stale a background consumer (status line / Discord) tolerates before it
// trickles a refresh. The dashboard refreshes at the normal cadence
// (METERS_OK_MS); background paths only poll the shared usage endpoint this
// rarely, so Pulse isn't hammering it 24/7 when no one's watching the card.
const BACKGROUND_METERS_MS = 15 * 60 * 1000;

// Lazily refresh on summary builds; serve the cached state immediately.
// background=true (status line, Discord) only triggers a refresh when the data
// is already quite stale; the dashboard (background=false) uses the normal gate.
// Per-bucket (ts, pct) sample history for the "~N% left at reset" projection.
// In-memory only, bounded, and self-clearing when a window rolls over (a pct
// DROP means the window reset — earlier samples describe a dead window).
const METER_PROJ_MIN_MS = parseInt(process.env.PULSE_METER_PROJ_MIN_MS || '', 10) || 10 * 60e3;
const METER_PROJ_WINDOW_MS = 2 * 3600e3; // project from at most the last 2h
const _meterSamples = new Map(); // key -> { resetsAt, arr: [{ts, pct}] }
function recordMeterSamples(buckets) {
  const now = Date.now();
  for (const b of buckets) {
    if (typeof b.pct !== 'number' || !isFinite(b.pct)) continue;
    let st = _meterSamples.get(b.key);
    if (!st) { st = { resetsAt: b.resetsAt || null, arr: [] }; _meterSamples.set(b.key, st); }
    // A window roll shows up as the pct FALLING or resets_at JUMPING a whole
    // window forward — and a roll under load can land the new pct HIGHER than
    // the old one, so the pct check alone is not enough. Dead-window samples
    // must never pollute the new window's slope. The 2-minute tolerance
    // absorbs server-side jitter in the reported reset time.
    const resetJumped = b.resetsAt && st.resetsAt && Math.abs(b.resetsAt - st.resetsAt) > 120e3;
    const pctDropped = st.arr.length && b.pct < st.arr[st.arr.length - 1].pct - 0.5;
    if (resetJumped || pctDropped) st.arr.length = 0;
    if (b.resetsAt) st.resetsAt = b.resetsAt;
    st.arr.push({ ts: now, pct: b.pct });
    while (st.arr.length && now - st.arr[0].ts > METER_PROJ_WINDOW_MS) st.arr.shift();
    if (st.arr.length > 200) st.arr.splice(0, st.arr.length - 200);
  }
}
// Straight-line projection of "% left when the window resets" from the recent
// burn rate. Only offered with enough observation time and a real reset time;
// a flat or falling trend projects to the CURRENT remaining (no invention).
function projectedLeftAtReset(b) {
  if (typeof b.pct !== 'number' || !b.resetsAt) return null;
  const st = _meterSamples.get(b.key);
  const arr = st && st.arr;
  if (!arr || arr.length < 2) return null;
  const first = arr[0], last = arr[arr.length - 1];
  if (last.ts - first.ts < METER_PROJ_MIN_MS) return null;
  const slope = (last.pct - first.pct) / (last.ts - first.ts); // pct per ms
  const remainingMs = b.resetsAt - Date.now();
  if (remainingMs <= 0) return null;
  const projUsed = b.pct + Math.max(0, slope) * remainingMs;
  return Math.max(0, Math.round(100 - projUsed));
}

function metersForPayload(background) {
  if (!metersEnabled()) return { enabled: false };
  const due = Date.now() >= (metersState.nextAttemptAt || 0);
  const bgOk = !background || (Date.now() - (metersState.fetchedAt || 0) >= BACKGROUND_METERS_MS);
  if (due && bgOk) {
    refreshAccountMeters(); // async; next poll picks it up
  }
  return {
    enabled: true,
    status: metersState.status === 'off' ? 'loading' : metersState.status,
    // Attach the burn-rate projection per bucket (null until observed long
    // enough). Fresh objects — the state buckets stay unclobbered.
    buckets: (metersState.buckets || []).map((b) => ({ ...b, projLeftAtReset: projectedLeftAtReset(b) })),
    fetchedAt: metersState.fetchedAt,
    lastGoodAt: metersState.lastGoodAt,
    error: metersState.error,
  };
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

// ---------------------------------------------------------------------------
// WINDOWS TRAY (opt-in: --tray or {"tray": true})
// A hand-rolled notification-area icon with zero dependencies: Pulse writes a
// PowerShell script to ~/.pulse (the only writable location) and spawns it
// detached. The script owns a WinForms NotifyIcon: tooltip refreshed from the
// slim /api/statusline feed (loopback only — the tray never talks to any
// provider), left-click opens the mini overview, right-click menu offers the
// dashboard / mini / Stop Pulse / Exit tray. A named mutex (per port) makes it
// single-instance, and it exits by itself once the server stops answering.
// ---------------------------------------------------------------------------
// Effective tray state: --tray starts it without touching config, and the
// dashboard toggle must override either source — the statusline feed reports
// THIS (falling back to config when nothing has decided yet), or a
// flag-started tray would read config tray!==true and kill itself in 30s.
let trayDesired = null;
function trayScript(port) {
  return [
    "$mtx = New-Object System.Threading.Mutex($false, 'PulseTray" + port + "')",
    // 10s (not 0): during a version handoff the new instance starts before
    // the old one has released the mutex.
    'if (-not $mtx.WaitOne(10000)) { exit }',
    "$myVer = '" + PULSE_VERSION + "'",
    "$myStyle = 'icon'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    // GetHicon handles must be destroyed or every badge repaint leaks a GDI
    // handle (2880/day at a 30s tick).
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PulseIconUtil{[DllImport(\"user32.dll\")]public static extern bool DestroyIcon(IntPtr h);}'",
    "$base = 'http://127.0.0.1:" + port + "'",
    '$ni = New-Object System.Windows.Forms.NotifyIcon',
    'try {',
    '  $exe = (Get-Process -Id ' + process.pid + ' -ErrorAction Stop).Path',
    '  $baseIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)',
    '} catch { $baseIcon = [System.Drawing.SystemIcons]::Application }',
    '$script:curIcon = $baseIcon',
    '$ni.Icon = $baseIcon',
    "$ni.Text = 'Pulse'",
    '$ni.Visible = $true',
    // Live badge: the Claude 5h used-% painted on the icon, colored by level —
    // the number is readable at a glance without hovering.
    'function New-PulseBadge([string]$txt, [string]$hex) {',
    '  $bmp = New-Object System.Drawing.Bitmap -ArgumentList 16, 16',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    "  $g.SmoothingMode = 'AntiAlias'",
    '  $bg = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.ColorTranslator]::FromHtml($hex))',
    '  $g.FillEllipse($bg, 0, 0, 15, 15)',
    "  $f = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 6.5, ([System.Drawing.FontStyle]::Bold)",
    '  $sf = New-Object System.Drawing.StringFormat',
    "  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'",
    '  $rect = New-Object System.Drawing.RectangleF -ArgumentList 0, 0.5, 16, 15',
    '  $g.DrawString($txt, $f, [System.Drawing.Brushes]::White, $rect, $sf)',
    '  $g.Dispose(); $bg.Dispose(); $f.Dispose()',
    '  $h = $bmp.GetHicon()',
    '  $icon = [System.Drawing.Icon]::FromHandle($h).Clone()',
    '  [void][PulseIconUtil]::DestroyIcon($h)',
    '  $bmp.Dispose()',
    '  return $icon',
    '}',
    'function Set-PulseIcon($icon) {',
    '  $old = $script:curIcon',
    '  $ni.Icon = $icon',
    '  $script:curIcon = $icon',
    '  if ($old -and -not [object]::ReferenceEquals($old, $baseIcon) -and -not [object]::ReferenceEquals($old, $icon)) { $old.Dispose() }',
    '}',
    // Left-click opens the mini overview as a chromeless app window (Edge is
    // on every Windows 11 box); falls back to the default browser.
    'function Open-PulseMini {',
    "  try { Start-Process 'msedge' -ArgumentList ('--app=' + $base + '/#mini'), '--window-size=380,800' -ErrorAction Stop }",
    '  catch { Start-Process ($base + \'/#mini\') }',
    '}',
    '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
    "[void]$menu.Items.Add('Open dashboard', $null, { Start-Process ($base + '/') })",
    "[void]$menu.Items.Add('Open mini overview', $null, { Open-PulseMini })",
    "[void]$menu.Items.Add('-')",
    "[void]$menu.Items.Add('Stop Pulse', $null, { try { Invoke-RestMethod -Method Post -Uri ($base + '/api/shutdown') -Headers @{ 'X-Pulse' = '1' } -TimeoutSec 3 | Out-Null } catch {}; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })",
    "[void]$menu.Items.Add('Exit tray', $null, { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })",
    '$ni.ContextMenuStrip = $menu',
    "$ni.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-PulseMini } })",
    '$script:fails = 0',
    'function Update-PulseTray {',
    '  try {',
    "    $s = Invoke-RestMethod -Uri ($base + '/api/statusline') -TimeoutSec 3",
    // The dashboard toggle turns the tray off by flipping this field.
    '    if ($s.trayEnabled -eq $false) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }',
    // Server updated OR the tray style changed under us: the server rewrote
    // tray.ps1, so relaunch from the fresh file and hand over the mutex.
    '    if (($s.version -and $s.version -ne $myVer) -or ($s.trayStyle -and $s.trayStyle -ne $myStyle)) {',
    "      Start-Process 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $PSCommandPath",
    '      $ni.Visible = $false; [System.Windows.Forms.Application]::Exit(); return',
    '    }',
    "    $t = 'Pulse'",
    "    if ($s.today) { $t = 'Pulse - today $' + [math]::Round([double]$s.today.cost, 2) }",
    '    $m = $s.meters',
    "    if ($m -and $m.claudeFiveHour -ne $null) { $t = $t + ' - 5h ' + $m.claudeFiveHour + '%' }",
    "    if ($m -and $m.claudeWeekly -ne $null) { $t = $t + ' - wk ' + $m.claudeWeekly + '%' }",
    '    if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }',
    '    $ni.Text = $t',
    '    if ($m -and $m.claudeFiveHour -ne $null) {',
    '      $p = [int]$m.claudeFiveHour',
    "      $txt = if ($p -ge 100) { '!' } else { [string]$p }",
    "      $hex = if ($p -ge 85) { '#f27878' } elseif ($p -ge 60) { '#e0a132' } else { '#22b892' }",
    '      Set-PulseIcon (New-PulseBadge $txt $hex)',
    '    } else { Set-PulseIcon $baseIcon }',
    '    $script:fails = 0',
    '  } catch {',
    '    $script:fails = $script:fails + 1',
    "    $ni.Text = 'Pulse - server not responding'",
    '    if ($script:fails -ge 6) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }',
    '  }',
    '}',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 30000',
    '$timer.add_Tick({ Update-PulseTray })',
    'Update-PulseTray', // first paint immediately, not 30s in
    '$timer.Start()',
    '[System.Windows.Forms.Application]::Run()',
    '$ni.Visible = $false',
  ].join('\r\n') + '\r\n';
}
// 'icon' = a notification-area NotifyIcon with a % badge; 'strip' = an
// always-on-top mini readout drawn over the taskbar itself (glyph + rotating
// pages, draggable, click opens the mini panel) — the openusage-windows look.
function trayStyle() {
  return readConfig().trayStyle === 'strip' ? 'strip' : 'icon';
}
// The taskbar STRIP (openusage-windows style): a slim borderless always-on-top
// form positioned over the taskbar's right end — a colored status dot + text
// rotating through pages (Claude 5h %, weekly %, Codex weekly %, today's $).
// Drag to reposition (persisted to ~/.pulse/tray-strip.json; a <5px move
// counts as a click); left-click opens the mini overview as an app window
// anchored above the strip; right-click menu mirrors the icon tray. Same
// mutex, version-handoff, trayEnabled self-exit, and statusline feed as the
// icon style.
function trayStripScript(port) {
  return [
    "$mtx = New-Object System.Threading.Mutex($false, 'PulseTray" + port + "')",
    'if (-not $mtx.WaitOne(10000)) { exit }',
    "$myVer = '" + PULSE_VERSION + "'",
    "$myStyle = 'strip'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$base = 'http://127.0.0.1:" + port + "'",
    "$posFile = Join-Path (Split-Path -Parent $PSCommandPath) 'tray-strip.json'",
    '$scr = [System.Windows.Forms.Screen]::PrimaryScreen',
    '$tbH = $scr.Bounds.Height - $scr.WorkingArea.Height',
    'if ($tbH -lt 24 -or $tbH -gt 96) { $tbH = 48 } # side/top/hidden taskbar -> float above the corner',
    '$H = [Math]::Min(34, $tbH - 6); if ($H -lt 24) { $H = 24 }',
    '$W = 190',
    '$form = New-Object System.Windows.Forms.Form',
    "$form.FormBorderStyle = 'None'",
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $false',
    "$form.StartPosition = 'Manual'",
    '$form.Size = New-Object System.Drawing.Size -ArgumentList $W, $H',
    "$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#14131c')",
    '$x = $scr.WorkingArea.Right - $W - 260',
    '$y = $scr.Bounds.Bottom - $tbH + [int](($tbH - $H) / 2)',
    'if ($scr.Bounds.Height -eq $scr.WorkingArea.Height) { $y = $scr.WorkingArea.Bottom - $H - 8 }',
    'try {',
    '  $saved = Get-Content -Raw $posFile | ConvertFrom-Json',
    '  if ($saved.x -ge 0 -and $saved.x -lt ($scr.Bounds.Width - 40) -and $saved.y -ge 0 -and $saved.y -lt $scr.Bounds.Height) { $x = $saved.x; $y = $saved.y }',
    '} catch {}',
    '$form.Location = New-Object System.Drawing.Point -ArgumentList $x, $y',
    // Rounded pill silhouette so it reads as a widget, not a gray box.
    '$gp = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '$r = [int]($H / 2)',
    '$gp.AddArc(0, 0, $r * 2, $r * 2, 90, 180)',
    '$gp.AddArc($W - $r * 2, 0, $r * 2, $r * 2, 270, 180)',
    '$gp.CloseFigure()',
    '$form.Region = New-Object System.Drawing.Region -ArgumentList $gp',
    '$dot = New-Object System.Windows.Forms.Label',
    "$dot.Text = [char]0x25CF",
    "$dot.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 10, ([System.Drawing.FontStyle]::Bold)",
    "$dot.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#9b8cff')",
    '$dot.AutoSize = $false',
    '$dot.Size = New-Object System.Drawing.Size -ArgumentList 22, $H',
    '$dot.Location = New-Object System.Drawing.Point -ArgumentList 8, 0',
    "$dot.TextAlign = 'MiddleCenter'",
    '$lbl = New-Object System.Windows.Forms.Label',
    "$lbl.Text = 'Pulse'",
    "$lbl.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 9",
    "$lbl.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#e8e6f2')",
    '$lbl.AutoSize = $false',
    '$lbl.Size = New-Object System.Drawing.Size -ArgumentList ($W - 34), $H',
    '$lbl.Location = New-Object System.Drawing.Point -ArgumentList 28, 0',
    "$lbl.TextAlign = 'MiddleLeft'",
    '$form.Controls.Add($dot)',
    '$form.Controls.Add($lbl)',
    '$script:pages = @()',
    '$script:pageIdx = 0',
    '$script:fails = 0',
    '$script:dotHex = @()',
    'function Open-PulseMini {',
    '  $px = [Math]::Max(0, $form.Location.X - 100)',
    '  $py = [Math]::Max(0, $scr.WorkingArea.Bottom - 780)',
    "  try { Start-Process 'msedge' -ArgumentList ('--app=' + $base + '/#mini'), '--window-size=380,760', ('--window-position=' + $px + ',' + $py) -ErrorAction Stop }",
    '  catch { Start-Process ($base + \'/#mini\') }',
    '}',
    'function Show-PulsePage {',
    '  if ($script:pages.Count -eq 0) { return }',
    '  $script:pageIdx = $script:pageIdx % $script:pages.Count',
    '  $lbl.Text = $script:pages[$script:pageIdx]',
    '  $hex = $script:dotHex[$script:pageIdx]',
    '  if ($hex) { $dot.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($hex) }',
    '  $script:pageIdx = ($script:pageIdx + 1) % $script:pages.Count',
    '}',
    'function Update-PulseStrip {',
    '  try {',
    "    $s = Invoke-RestMethod -Uri ($base + '/api/statusline') -TimeoutSec 3",
    '    if ($s.trayEnabled -eq $false) { [System.Windows.Forms.Application]::Exit(); return }',
    '    if (($s.version -and $s.version -ne $myVer) -or ($s.trayStyle -and $s.trayStyle -ne $myStyle)) {',
    "      Start-Process 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $PSCommandPath",
    '      [System.Windows.Forms.Application]::Exit(); return',
    '    }',
    '    $p = @(); $c = @()',
    '    $m = $s.meters',
    "    function LevelHex([int]$v) { if ($v -ge 85) { '#f27878' } elseif ($v -ge 60) { '#e0a132' } else { '#22b892' } }",
    "    if ($m -and $m.claudeFiveHour -ne $null) { $p += ('Claude 5h  ' + (100 - [int]$m.claudeFiveHour) + '% left'); $c += (LevelHex $m.claudeFiveHour) }",
    "    if ($m -and $m.claudeWeekly -ne $null) { $p += ('Claude wk  ' + (100 - [int]$m.claudeWeekly) + '% left'); $c += (LevelHex $m.claudeWeekly) }",
    "    if ($m -and $m.codexWeekly -ne $null) { $p += ('Codex wk  ' + (100 - [int]$m.codexWeekly) + '% left'); $c += (LevelHex $m.codexWeekly) }",
    "    if ($s.today) { $p += ('$' + [math]::Round([double]$s.today.cost, 2) + ' today'); $c += '#9b8cff' }",
    "    if ($p.Count -eq 0) { $p = @('Pulse'); $c = @('#9b8cff') }",
    '    $script:pages = $p; $script:dotHex = $c',
    '    if ($script:pageIdx -ge $p.Count) { $script:pageIdx = 0 }',
    '    $script:fails = 0',
    '  } catch {',
    '    $script:fails = $script:fails + 1',
    "    $script:pages = @('server not responding'); $script:dotHex = @('#f27878'); $script:pageIdx = 0",
    '    if ($script:fails -ge 6) { [System.Windows.Forms.Application]::Exit() }',
    '  }',
    '}',
    // Drag anywhere on the strip; a tiny move is a click -> open the panel.
    '$script:dragStart = $null; $script:formStart = $null; $script:moved = $false',
    '$down = {',
    '  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {',
    '    $script:dragStart = [System.Windows.Forms.Cursor]::Position',
    '    $script:formStart = $form.Location',
    '    $script:moved = $false',
    '  }',
    '}',
    '$move = {',
    '  if ($script:dragStart -ne $null -and $_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {',
    '    $cur = [System.Windows.Forms.Cursor]::Position',
    '    $dx = $cur.X - $script:dragStart.X; $dy = $cur.Y - $script:dragStart.Y',
    '    if ([Math]::Abs($dx) -gt 4 -or [Math]::Abs($dy) -gt 4) { $script:moved = $true }',
    '    if ($script:moved) { $form.Location = New-Object System.Drawing.Point -ArgumentList ($script:formStart.X + $dx), ($script:formStart.Y + $dy) }',
    '  }',
    '}',
    '$up = {',
    '  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {',
    '    if ($script:moved) {',
    '      try { @{ x = $form.Location.X; y = $form.Location.Y } | ConvertTo-Json | Set-Content -Path $posFile } catch {}',
    '    } else { Open-PulseMini }',
    '    $script:dragStart = $null',
    '  }',
    '}',
    '$form.add_MouseDown($down); $form.add_MouseMove($move); $form.add_MouseUp($up)',
    '$dot.add_MouseDown($down); $dot.add_MouseMove($move); $dot.add_MouseUp($up)',
    '$lbl.add_MouseDown($down); $lbl.add_MouseMove($move); $lbl.add_MouseUp($up)',
    '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
    "[void]$menu.Items.Add('Open dashboard', $null, { Start-Process ($base + '/') })",
    "[void]$menu.Items.Add('Open mini overview', $null, { Open-PulseMini })",
    "[void]$menu.Items.Add('Refresh now', $null, { Update-PulseStrip; Show-PulsePage })",
    "[void]$menu.Items.Add('-')",
    "[void]$menu.Items.Add('Stop Pulse', $null, { try { Invoke-RestMethod -Method Post -Uri ($base + '/api/shutdown') -Headers @{ 'X-Pulse' = '1' } -TimeoutSec 3 | Out-Null } catch {}; [System.Windows.Forms.Application]::Exit() })",
    "[void]$menu.Items.Add('Exit strip', $null, { [System.Windows.Forms.Application]::Exit() })",
    '$form.ContextMenuStrip = $menu',
    '$dataTimer = New-Object System.Windows.Forms.Timer',
    '$dataTimer.Interval = 30000',
    '$dataTimer.add_Tick({ Update-PulseStrip })',
    '$pageTimer = New-Object System.Windows.Forms.Timer',
    '$pageTimer.Interval = 4000',
    '$pageTimer.add_Tick({ Show-PulsePage })',
    'Update-PulseStrip',
    'Show-PulsePage',
    '$dataTimer.Start()',
    '$pageTimer.Start()',
    '$form.Show()',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\r\n') + '\r\n';
}

function startTray(port) {
  trayDesired = true;
  if (process.platform !== 'win32') {
    console.log('[pulse] --tray is Windows-only (notification-area icon) — ignored on this OS.');
    return;
  }
  if (process.env.PULSE_NO_TRAY_SPAWN) {
    console.log('[pulse] tray spawn suppressed (PULSE_NO_TRAY_SPAWN — test hook)');
    return;
  }
  const style = trayStyle();
  const scriptPath = path.join(pulseHome(), 'tray.ps1');
  try {
    fs.mkdirSync(pulseHome(), { recursive: true });
    fs.writeFileSync(scriptPath, style === 'strip' ? trayStripScript(port) : trayScript(port));
  } catch (e) {
    console.warn('[pulse] tray: could not write script: ' + e.message);
    return;
  }
  try {
    const child = require('child_process').spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true });
    // Spawn failures surface as an ASYNC 'error' event, not a throw — without
    // this listener a blocked/missing powershell.exe would crash the whole
    // server (and with {"tray": true} persisted, crash-loop every start).
    child.on('error', (e) => console.warn('[pulse] tray failed to start: ' + e.message));
    child.unref();
    console.log('[pulse] tray icon started (Windows notification area) — right-click it for the menu.');
  } catch (e) {
    console.warn('[pulse] tray failed to start: ' + e.message);
  }
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
        // ?sources=cli,codex — scope the whole payload to those sources.
        let sourceFilter = null;
        const rawSources = new URLSearchParams(parsed.query || '').get('sources');
        if (rawSources) {
          const names = rawSources.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
          if (names.length) sourceFilter = new Set(names);
        }
        const payload = buildSummary(sourceFilter);
        console.log(`[pulse] /api/summary built in ${payload.buildMs}ms`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (route === '/api/statusline') {
        // Slim, memoized feed for `pulse --statusline` (see STATUSLINE FEED).
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(statuslineData()));
        return;
      }
      if (route === '/api/export') {
        // Download the dashboard's aggregations. Read-only: covered by the
        // allowRead DNS-rebinding guard above like every /api route. Accepts
        // the same ?sources= scoping as /api/summary so a download matches
        // exactly what the dashboard shows.
        const q = new URLSearchParams(parsed.query || '');
        let sourceFilter = null;
        const rawSources = q.get('sources');
        if (rawSources) {
          const names = rawSources.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
          if (names.length) sourceFilter = new Set(names);
        }
        const payload = buildSummary(sourceFilter);
        const stamp = localDateStr(Date.now()).replace(/-/g, '');
        if (q.get('format') === 'json') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="pulse-export-' + stamp + '.json"',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload, null, 2));
          return;
        }
        const periodKey = q.get('period') || '';
        const period = (payload.periods || []).find((p) => p.key === periodKey) || (payload.periods || [])[0];
        const data = q.get('data') || 'daily';
        if (!period) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no data to export yet' }));
          return;
        }
        const csv = exportCsv(payload, period, data);
        if (!csv) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown data set "' + data + '" — use daily|models|sources|projects|sessions' }));
          return;
        }
        // Sessions is the whole-session recent list, not period-scoped — its
        // filename must not imply a period.
        const fname = data === 'sessions'
          ? 'pulse-sessions-' + stamp + '.csv'
          : 'pulse-' + data + '-' + period.key + '-' + stamp + '.csv';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + fname + '"',
          'Cache-Control': 'no-store',
        });
        res.end(String.fromCharCode(0xFEFF) + csv); // UTF-8 BOM so Excel opens the file correctly
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
      if (route === '/api/meters/enable' || route === '/api/meters/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        // One dashboard gesture covers both providers — the button copy names
        // both endpoints. Pre-1.6.0 configs with accountMeters alone never
        // gain the ChatGPT call until the user re-toggles here.
        writeConfig({ accountMeters: on, codexAccountUsage: on });
        console.log('[pulse] account meters ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        if (!on) {
          metersState.status = 'off';
          metersState.buckets = [];
          metersState.error = null;
          metersState.fetchedAt = null;
          codexUsageState.status = 'off';
          codexUsageState.stats = null;
          codexUsageState.error = null;
          codexUsageState.fetchedAt = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: { enabled: false } }));
          return;
        }
        // Fresh credential lookup + immediate attempt on every enable.
        credCache = { at: 0, cred: null };
        meters429Streak = 0;
        metersState.nextAttemptAt = 0;
        codexUsage429Streak = 0;
        codexUsageState.nextAttemptAt = 0;
        refreshCodexUsage(); // async; the summary poll picks it up
        // Respond after the first fetch so the card can render immediately.
        refreshAccountMeters(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
        });
        return;
      }
      if (route === '/api/meters/recheck') {
        if (!allowMutation(req, res)) return;
        // "Recheck now" from the connect card: force a fresh credential lookup +
        // immediate attempt (e.g. the user just logged into Claude Code) so
        // meters light up without restarting or waiting for the poll cadence.
        if (!metersEnabled()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
          return;
        }
        credCache = { at: 0, cred: null };
        meters429Streak = 0;
        metersState.nextAttemptAt = 0;
        codexUsage429Streak = 0;
        codexUsageState.nextAttemptAt = 0;
        refreshCodexUsage();
        refreshAccountMeters(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, meters: metersForPayload() }));
        });
        return;
      }
      if (route === '/api/discord/enable' || route === '/api/discord/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        writeConfig({ discordPresence: on });
        console.log('[pulse] discord presence ' + (on ? 'enabled' : 'disabled') + ' from the dashboard');
        if (!on) {
          discordSetActivity(null); // clear the presence before dropping the socket
          discordDisconnect();
          discordState.status = 'off';
          discordState.error = null;
        } else {
          discordNextAttemptAt = 0;
          discordState.error = null;
          discordTick(); // connect + publish now, not on the next 15s tick
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, discord: discordForPayload() }));
        return;
      }
      if (route === '/api/tray/enable' || route === '/api/tray/disable') {
        if (!allowMutation(req, res)) return;
        const on = route.endsWith('enable');
        const styleQ = new URLSearchParams(parsed.query || '').get('style');
        const patch = { tray: on };
        if (on && (styleQ === 'strip' || styleQ === 'icon')) patch.trayStyle = styleQ;
        writeConfig(patch);
        trayDesired = on;
        console.log('[pulse] tray ' + (on ? 'enabled (' + trayStyle() + ')' : 'disabled') + ' from the dashboard');
        // Enable starts it right now (Windows only). Disable and style
        // switches are picked up by the running tray's own poll: the feed
        // carries trayEnabled + trayStyle, and a style mismatch triggers the
        // same relaunch-from-rewritten-tray.ps1 handoff as a version change.
        if (on && process.platform === 'win32' && boundLoopback) startTray(port);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tray: { supported: process.platform === 'win32', enabled: on, style: trayStyle() } }));
        return;
      }
      if (route === '/api/budget/set') {
        if (!allowMutation(req, res)) return;
        const q = url.parse(req.url, true).query || {};
        const amount = parseFloat(q.amount);
        const period = q.period === 'week' ? 'week' : 'month';
        // amount <= 0 / blank / NaN clears the budget.
        const target = isFinite(amount) && amount > 0 ? amount : null;
        writeConfig({ budget: target, budgetPeriod: period });
        console.log('[pulse] budget ' + (target ? '$' + target + '/' + period : 'cleared') + ' from the dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, budget: target ? { target, period } : null }));
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
    // Record where this instance is listening so the short-lived `--statusline`
    // process (and any other helper) can find it. Writes ONLY to ~/.pulse.
    writeRuntimeFile(port, host);
    // Packaged exe on Windows: open the dashboard for the user.
    if (seaApi && process.platform === 'win32' && (!opts || opts.open !== false) && LOOPBACK_HOSTS.has(host)) {
      openBrowser(port);
    }
    // Windows notification-area icon (opt-in) — loopback only, self-exits
    // when the server stops.
    if (opts && opts.tray && LOOPBACK_HOSTS.has(host)) startTray(port);
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
      // Community reach shares the update check's opt-out and network path.
      // Its own 6h cache means the interval is just a ceiling, never a poll.
      setTimeout(() => refreshReach(), 3200);
      const riv = setInterval(() => refreshReach(), 6 * 3600 * 1000);
      if (riv.unref) riv.unref();
    }
    startDiscordLoop(); // no-ops every tick unless discordPresence is on
    // Seal history even on a headless daemon that no one is viewing (viewers
    // and the Discord tick would otherwise be the only triggers).
    try { sealHistory(parseAll().entries); } catch (_) {}
    const sealIv = setInterval(() => { try { sealHistory(parseAll().entries); } catch (_) {} }, 30 * 60 * 1000);
    if (sealIv.unref) sealIv.unref();
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

// ---------------------------------------------------------------------------
// `--statusline` — a Claude Code status line fed by Pulse.
// Claude Code pipes a JSON payload on stdin (model, context %, cost,
// rate_limits, …) and displays our stdout. We enrich it with Pulse's CACHED
// numbers — today's cross-tool spend, the current 5-hour block, official meter
// percentages — fetched from the running server over loopback, so the status
// line reflects ALL your usage without ever hitting a provider endpoint itself
// (the server is the single, throttled poller). Fast, and fail-open: any error
// still prints a useful line from the stdin payload alone, and we always exit 0
// (a non-zero exit blanks the status line).
// ---------------------------------------------------------------------------
function slHttpGetJson(url, timeoutMs, cb) {
  let done = false;
  const finish = (e, d) => { if (!done) { done = true; cb(e, d); } };
  try {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(new Error('too large')); });
      res.on('end', () => { try { finish(null, JSON.parse(body)); } catch (e) { finish(e); } });
      res.on('error', finish);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', finish);
  } catch (e) { finish(e); }
}

function slDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h' + (m ? m + 'm' : '');
  if (m > 0) return m + 'm';
  return s + 's';
}
function formatStatusline(ctx, data) {
  const noColor = !!process.env.NO_COLOR;
  const wrap = (open, s) => noColor ? s : '\x1b[' + open + 'm' + s + '\x1b[0m';
  const dim = (s) => wrap('2', s);
  const bold = (s) => wrap('1', s);
  const accent = (s) => wrap('38;5;141', s);
  const heat = (pct) => (s) => wrap(pct >= 85 ? '38;5;167' : pct >= 60 ? '38;5;179' : '38;5;71', s);
  const seg = [];

  const model = (ctx.model && (ctx.model.display_name || ctx.model.id)) || 'Claude';
  seg.push(accent('◉ ' + model));

  const cw = ctx.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    const p = Math.round(cw.used_percentage);
    seg.push(dim('ctx ') + heat(p)(p + '%'));
  }

  if (data && data.today) {
    seg.push(dim('today ') + bold(fmtMoney(data.today.cost)));
    if (data.block) {
      const left = data.block.endsAt - Date.now();
      seg.push(dim('5h ') + bold(fmtMoney(data.block.cost)) + (left > 0 ? dim(' ' + slDur(left)) : ''));
    }
  }

  // Weekly %: prefer Pulse's official meter (all devices); fall back to the
  // rate_limits Claude Code itself passes on stdin.
  let wk = data && data.meters && typeof data.meters.claudeWeekly === 'number' ? data.meters.claudeWeekly : null;
  if (wk == null && ctx.rate_limits && ctx.rate_limits.seven_day && typeof ctx.rate_limits.seven_day.used_percentage === 'number') {
    wk = Math.round(ctx.rate_limits.seven_day.used_percentage);
  }
  if (wk != null) seg.push(dim('wk ') + heat(wk)(wk + '%'));
  if (data && data.meters && typeof data.meters.codexWeekly === 'number') {
    seg.push(dim('cx ') + heat(data.meters.codexWeekly)(data.meters.codexWeekly + '%'));
  }

  return seg.join(noColor ? ' · ' : dim(' · '));
}

function runStatusline() {
  let input = '';
  let finished = false;
  const guard = setTimeout(() => finish(), 1500); // stdin should be instant; never hang the shell
  const finish = () => {
    if (finished) return; finished = true; clearTimeout(guard);
    let ctx = {};
    try { ctx = JSON.parse(input) || {}; } catch (_) {}
    const rt = readRuntimeFile();
    const host = (rt && rt.host) || '127.0.0.1';
    const port = (rt && rt.port) || (process.env.PORT ? parseInt(process.env.PORT, 10) : 4747);
    slHttpGetJson('http://' + host + ':' + port + '/api/statusline', 700, (err, data) => {
      let line;
      try { line = formatStatusline(ctx, err ? null : data); }
      catch (_) { line = (ctx.model && (ctx.model.display_name || ctx.model.id)) || 'Pulse'; }
      // Exit from the write callback: process.exit() before stdout (a pipe)
      // flushes would truncate the line to nothing. A short backstop timer
      // guarantees we still exit if the callback never fires.
      const bail = setTimeout(() => process.exit(0), 400);
      if (bail.unref) bail.unref();
      try { process.stdout.write(line + '\n', () => process.exit(0)); }
      catch (_) { process.exit(0); }
    });
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; if (input.length > 1e6) finish(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  } catch (_) { finish(); }
}

// `--statusline-setup` — print (never write) the settings.json snippet. As with
// --effort-setup, Pulse never edits ~/.claude itself.
function statuslineSetup() {
  const cmdValue = seaApi
    ? `${q(process.execPath)} --statusline`
    : `${q(process.execPath)} ${q(__filename)} --statusline`;
  const snippet = { statusLine: { type: 'command', command: cmdValue, padding: 0, refreshInterval: 30 } };
  const settingsPath = path.join(claudeDir(), 'settings.json');
  console.log('\nPulse — status line setup');
  console.log('─'.repeat(64));
  console.log('Adds a Claude Code status line fed by Pulse: your model + context');
  console.log('from Claude Code, plus today\'s cross-tool spend, the current 5-hour');
  console.log('block, and official meter %s that Pulse already caches (so the status');
  console.log('line never polls a provider endpoint itself).');
  console.log('');
  console.log(`1. Make sure Pulse is running (the status line reads it over loopback).`);
  console.log('');
  console.log(`2. Open:  ${settingsPath}`);
  console.log('   (create it if missing; merge this key if the file already exists)');
  console.log('');
  console.log('3. Add:');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('');
  console.log('4. Start a new Claude Code session. Pulse never writes under ~/.claude;');
  console.log('   if Pulse is stopped the line still shows model + context from Claude');
  console.log('   Code alone. Set NO_COLOR=1 to disable the ANSI colors.');
  console.log('');
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
    else if (a === '--statusline') { out.statusline = true; }
    else if (a === '--statusline-setup') { out.statuslineSetup = true; }
    else if (a === '--no-open') { out.noOpen = true; }
    else if (a === '--tray') { out.tray = true; }
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
    // Windows tray icon: --tray flag or {"tray": true} in config.
    tray: !!args.tray || readConfig().tray === true,
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
    console.log('  --statusline      run as a Claude Code status line (reads the JSON on');
    console.log('                    stdin, prints a line enriched with Pulse\'s numbers)');
    console.log('  --statusline-setup  print the settings.json snippet to enable it');
    console.log('  --mode-hook       (internal) run as a Claude Code hook — records the');
    console.log('                    effort level to ' + modesFilePath());
    console.log('  --no-open         do not auto-open the browser (packaged exe only)');
    console.log('  --stop            stop the running Pulse instance and exit');
    console.log('  --tray               (Windows) notification-area icon: live spend/limit');
  console.log('                       tooltip, open dashboard/mini, stop. Or {"tray": true}.');
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
  if (args.statusline) { runStatusline(); return; }
  if (args.statuslineSetup) { statuslineSetup(); return; }
  if (args.effortSetup) { effortSetup(); return; }
  if (args.inspectSchema) { inspectSchema(); return; }
  if (args.installShortcuts) { installShortcuts(); return; }
  const port = resolvePort(args);
  const host = resolveHost(args);
  if (args.stop) { stopRunning(port); return; }
  if (args.daemonChild) IS_DAEMON_CHILD = true;
  if (args.afterUpdate) IS_AFTER_UPDATE = true;
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
