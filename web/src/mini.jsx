import React, { useEffect } from 'react';
import { money2, tokens, durClock, useTick } from './lib.js';

// Compact side overview (#mini) — stacked provider cards sized for a narrow
// docked window or an installed-app panel: official Claude/Codex windows as
// "% left" bars with true reset countdowns, plus a small spend line + 30-day
// trend. Read-only view over the same summary payload; no extra endpoints.
// Solid surfaces only (no backdrop-filter) so it is lite-graphics safe.

function stripProvider(label) {
  return String(label || '').replace(/^(Claude|Codex) · /, '');
}

function MiniRows({ buckets }) {
  return (
    <div className="minirows">
      {buckets.map((b) => {
        const left = Math.max(0, 100 - b.pct);
        const level = b.pct >= 85 ? 'hot' : b.pct >= 60 ? 'warm' : '';
        const remaining = b.resetsAt ? b.resetsAt - Date.now() : null;
        return (
          <div className={'minirow' + (b.stale ? ' stale' : '')} key={b.key}>
            <div className="minilbl">{stripProvider(b.label)}</div>
            <div className="minitrack"><i className={level} style={{ width: Math.max(1.5, left) + '%' }} /></div>
            <div className="minimeta">
              <span>{b.stale ? '—' : Math.round(left) + '% left'}</span>
              <span>
                {b.stale
                  ? 'stale — run a turn'
                  : remaining != null && remaining > 0
                    ? <>resets in <b>{durClock(remaining)}</b></>
                    : b.resetsAt ? 'resetting…' : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Daily spend as tiny bars (the trend at a glance; exact figures live in the
// full dashboard's chart).
function MiniTrend({ daily }) {
  const days = daily || [];
  const max = Math.max(0.0001, ...days.map((d) => d.total));
  return (
    <div className="minitrend">
      {days.map((d) => (
        <i key={d.date} style={{ height: Math.max(2, (d.total / max) * 34) + 'px' }}
           title={d.date + ' · $' + d.total.toFixed(2)} />
      ))}
    </div>
  );
}

export function MiniOverview({ data }) {
  useTick(1000); // live reset countdowns
  useEffect(() => {
    const prev = document.title;
    document.title = 'Pulse — mini';
    return () => { document.title = prev; };
  }, []);
  const m = data.meters;
  const cx = data.codexMeters;
  const last30 = (data.periods || []).find((p) => p.key === 'last30');
  const alerts = data.alerts || [];
  return (
    <div className="mini">
      <div className="minitop">
        <span className="minibrand">Pulse</span>
        <a className="minifull" href="#">full dashboard →</a>
      </div>
      {alerts.length > 0 && (
        <div className="minialert">
          ⚠ {alerts.length === 1 ? '1 alert' : alerts.length + ' alerts'} — see the full dashboard
        </div>
      )}
      <div className="minicard">
        <div className="minihead">Claude</div>
        {m && m.enabled && (m.buckets || []).length
          ? <MiniRows buckets={m.buckets} />
          : (
            <div className="minihint">
              {m && m.enabled
                ? (m.status === 'no-login'
                  ? 'No Claude Code login found — connect on the full dashboard.'
                  : m.status === 'expired'
                    ? 'Claude login expired — reconnect on the full dashboard.'
                    : m.status === 'error'
                      ? 'Meters unavailable — see the full dashboard.'
                      : 'Waiting for account meters…')
                : 'Enable account meters on the full dashboard to see official limits here.'}
            </div>
          )}
      </div>
      {cx && (cx.buckets || []).length > 0 && (
        <div className="minicard">
          <div className="minihead">Codex</div>
          <MiniRows buckets={cx.buckets} />
        </div>
      )}
      {last30 && (
        <div className="minicard">
          {/* The popup shares localStorage with the dashboard, so an active
              source filter carries over — the label must say what it shows. */}
          <div className="minihead">
            Spend · {data.sourceFilter && data.sourceFilter.length ? data.sourceFilter.join(' + ') : 'all sources'}
          </div>
          <div className="minispend">
            <span><b>{money2(data.today ? data.today.cost : 0)}</b> today</span>
            <span><b>{money2(last30.cost)}</b> · {tokens(last30.tokens)} tok · 30d</span>
          </div>
          <MiniTrend daily={last30.daily} />
        </div>
      )}
    </div>
  );
}
