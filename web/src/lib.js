import { useEffect, useRef, useState } from 'react';

// ---- categorical palette (CVD-safe on dark surface) ----
export const SERIES = ['#9b8cff', '#22b892', '#e0a132', '#4a9bf5', '#f27878', '#e77c46'];
export const ACCENT = '#9b8cff';

// ---- formatters ----
export function money(v) {
  if (v == null) return '—';
  if (v >= 1000) return '$' + (v / 1000).toFixed(2) + 'k';
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 10) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}
export function money2(v) {
  return v == null ? '—' : '$' + v.toFixed(v < 10 ? 3 : 2);
}
export function tokens(v) {
  if (v == null) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
export function num(v) {
  return v == null ? '—' : v.toLocaleString();
}
export function pct(v) {
  return v == null ? '—' : v.toFixed(0) + '%';
}
const pad = (n) => (n < 10 ? '0' : '') + n;
export function clockTime(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
export function hm(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
export function dur(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
}
// compact H:MM:SS — fits inside the reset ring without overflowing
export function durClock(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + ':' + pad(m) + ':' + pad(sec);
}
export function ago(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}
export function dayLabel(ds) {
  const p = ds.split('-');
  return p[1] + '/' + p[2];
}

// Stable color-by-entity: assign in the order names first appear (from the
// payload's all-time lists), so a series keeps its colour across periods.
export function makeColorMap(names) {
  const map = {};
  (names || []).forEach((n, i) => {
    map[n] = SERIES[i % SERIES.length];
  });
  return { get: (n) => map[n] || SERIES[Object.keys(map).length % SERIES.length], map };
}

// ---- data hook: fetch /api/summary on mount + every 10s ----
// `sources` (array of source names) scopes the whole payload server-side;
// empty/null means all sources.
export function useSummary(intervalMs = 10000, sources = null) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const inFlight = useRef(false);
  const sourcesKey = (sources && sources.length) ? sources.slice().sort().join(',') : '';

  useEffect(() => {
    let alive = true;
    const url = '/api/summary' + (sourcesKey ? '?sources=' + encodeURIComponent(sourcesKey) : '');
    async function refresh() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 200));
        const data = await r.json();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: String(e.message || e), loading: false }));
      } finally {
        inFlight.current = false;
      }
    }
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, sourcesKey]);

  return state;
}

// POST to a Pulse mutation endpoint. The X-Pulse header is required by the
// server's cross-site guard (it forces a CORS preflight for foreign origins).
export async function postJson(path) {
  const r = await fetch(path, { method: 'POST', headers: { 'X-Pulse': '1' } });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (!r.ok) {
    const err = new Error((body && body.error) || 'HTTP ' + r.status);
    err.status = r.status; // lets callers tell an HTTP failure from a dropped connection
    throw err;
  }
  return body || {};
}

// Poll /api/logs on the same cadence as the summary.
export function useLogs(enabled, intervalMs = 10000) {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function refresh() {
      try {
        const r = await fetch('/api/logs', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && j && Array.isArray(j.lines)) setLines(j.lines);
      } catch (_) { /* server gone — summary hook surfaces it */ }
    }
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [enabled, intervalMs]);
  return lines;
}

// Re-render helper that ticks every second (for live countdowns / relative time).
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
