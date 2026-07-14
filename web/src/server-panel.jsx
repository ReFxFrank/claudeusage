import { useEffect, useRef, useState } from 'react';
import { Card } from './panels.jsx';
import { postJson, useLogs, dur, clockTime, hm } from './lib.js';

// Small confirm-then-stop button, shared by the header and the Server panel.
// A dashboard can only ever offer STOP — a stopped server serves no page to
// put a start button on; starting is the exe (or its Desktop shortcut).
export function StopButton({ onStopped, compact = false, disabled = false }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function click() {
    if (!confirm) {
      setConfirm(true);
      setTimeout(() => setConfirm(false), 4000);
      return;
    }
    setBusy(true); setErr(null);
    try {
      await postJson('/api/shutdown');
      onStopped && onStopped();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <button
      className={'btn danger' + (compact ? ' compact' : '')}
      onClick={click}
      disabled={disabled || busy}
      title={err ? 'Stop failed: ' + err : 'Stop the Pulse server'}
    >
      {busy ? 'Stopping…' : confirm ? (compact ? 'Confirm?' : 'Click again to confirm') : (compact ? '⏻ Stop' : 'Stop server')}
    </button>
  );
}

// The Server card: identity (version / uptime / mode), update check + install,
// stop button, and a live tail of the server log — everything you would
// otherwise need the console window for.
export function ServerPanel({ data, onStopped, gfx, delay = 0.36 }) {
  const [busy, setBusy] = useState(null); // 'check' | 'install'
  const [note, setNote] = useState(null);
  const [showLogs, setShowLogs] = useState(true);
  const lines = useLogs(true);
  const boxRef = useRef(null);
  const stick = useRef(true); // auto-follow unless the user scrolled up

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, showLogs]);

  const upd = data.update || {};
  const updText =
    busy === 'install' ? (note || 'updating…')
    : upd.status === 'checking' ? 'checking…'
    : upd.status === 'available' ? `v${upd.latest} available`
    : upd.status === 'uptodate' ? `up to date${upd.checkedAt ? ' · checked ' + hm(upd.checkedAt) : ''}`
    : upd.status === 'downloading' ? 'downloading…'
    : upd.status === 'installing' ? 'installing…'
    : upd.status === 'error' ? 'check failed'
    : '—';

  async function onToggleMeters() {
    setBusy('meters');
    try {
      const on = !(data.meters && data.meters.enabled);
      await postJson('/api/meters/' + (on ? 'enable' : 'disable'));
      setNote(on
        ? 'Account meters enabled — the card appears at the top on the next refresh (~10s).'
        : 'Account meters disabled.');
    } catch (e) { setNote('Meters toggle failed: ' + e.message); }
    setBusy(null);
  }

  async function onCheck() {
    setBusy('check'); setNote(null);
    try {
      const st = await postJson('/api/update/check');
      setNote(st.status === 'available' ? `v${st.latest} is available.`
        : st.status === 'uptodate' ? 'You are on the latest version.'
        : st.error || st.status);
    } catch (e) { setNote('Check failed: ' + e.message); }
    setBusy(null);
  }

  async function onInstall() {
    setBusy('install');
    setNote('Downloading the update — this can take a minute…');
    const oldV = data.version;
    try {
      const r = await postJson('/api/update/install');
      if (!r || r.ok === false) {
        setNote((r && r.error) || 'Install failed — download manually from the releases page.');
        setBusy(null);
        return;
      }
      setNote('Installed — Pulse is restarting itself, hold on…');
      const t0 = Date.now();
      const poll = async () => {
        if (Date.now() - t0 > 120000) {
          setNote('The new version did not come back up — start it manually (it replaced the old exe).');
          setBusy(null);
          return;
        }
        try {
          const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json());
          if (h && h.ok && h.version && h.version !== oldV) { location.reload(); return; }
        } catch (_) { /* old server gone, new one not up yet */ }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2000);
    } catch (e) {
      // A real HTTP response (403/500) is a failure; only a DROPPED connection
      // means the server is swapping out from under the request.
      if (e.status) { setNote('Install failed: ' + e.message); setBusy(null); return; }
      setNote('Pulse is restarting…');
      const t0 = Date.now();
      const poll = async () => {
        if (Date.now() - t0 > 120000) { setNote('Install may have failed: ' + e.message); setBusy(null); return; }
        try {
          const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json());
          if (h && h.ok) { location.reload(); return; }
        } catch (_) {}
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2000);
    }
  }

  const uptime = data.generatedAt && data.serverStartTs ? dur(data.generatedAt - data.serverStartTs) : '—';

  return (
    <Card delay={delay} hover={false} id="server">
      <h2>Server</h2>
      <div className="facts srvfacts">
        <div className="fact">version<b>v{data.version || '?'}</b></div>
        <div className="fact">uptime<b>{uptime}</b></div>
        <div className="fact">mode<b>{data.daemon ? 'background' : 'console'}{data.packaged ? '' : ' · source'}</b></div>
        <div className="fact">updates<b className={upd.status === 'available' ? 'updavail' : ''}>{updText}</b></div>
      </div>

      <div className="btnrow">
        <button className="btn" onClick={onCheck} disabled={!!busy}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        {upd.status === 'available' && (upd.installSupported
          ? (
            <button className="btn primary" onClick={onInstall} disabled={!!busy}>
              {busy === 'install' ? 'Updating…' : `Update to v${upd.latest}`}
            </button>
          )
          : (
            <a className="btn primary" href={upd.releasesUrl} target="_blank" rel="noreferrer">
              Get v{upd.latest}
            </a>
          ))}
        <StopButton onStopped={onStopped} disabled={busy === 'install'} />
        <button className="btn ghost" onClick={onToggleMeters} disabled={busy === 'meters'}>
          {busy === 'meters' ? 'Saving…' : (data.meters && data.meters.enabled ? 'Disable account meters' : 'Enable account meters')}
        </button>
        {gfx && (
          <button
            className="btn ghost"
            onClick={() => gfx.set(gfx.mode === 'auto' ? (gfx.lite ? 'rich' : 'lite') : gfx.mode === 'lite' ? 'rich' : 'auto')}
            title="Lite mode removes blur effects and animations — use it when the browser runs without hardware acceleration."
          >
            Graphics: {gfx.mode === 'auto' ? `auto (${gfx.lite ? 'lite' : 'rich'})` : gfx.mode}
          </button>
        )}
        <button className="btn ghost" onClick={() => setShowLogs((s) => !s)}>
          {showLogs ? 'Hide logs' : 'Show logs'}
        </button>
      </div>
      <div className="sub" style={{ margin: '-4px 0 4px' }}>
        <b style={{ color: 'var(--text-2)' }}>Account meters</b> (opt-in) show Anthropic’s official 5-hour/weekly
        usage — including claude.ai chats and cloud sessions no local log can see. Uses your local Claude login
        read-only; talks only to api.anthropic.com.
      </div>
      <div className="sub" style={{ margin: '-4px 0 12px' }}>
        Starting again is the exe: double-click <code>pulse.exe</code>, or run{' '}
        <code>pulse.exe --install-shortcuts</code> once for “Pulse” / “Pulse — Stop” Desktop buttons.
      </div>

      {note && <div className="srvnote">{note}</div>}

      {showLogs && (
        <div
          className="logbox"
          ref={boxRef}
          onScroll={(e) => {
            const el = e.target;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {lines.length === 0
            ? <div className="ll">no log lines yet…</div>
            : lines.map((l, i) => (
              <div key={i} className={'ll ' + (l.level || 'info')}>
                <span className="lt">{clockTime(l.ts)}</span>{l.text}
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
