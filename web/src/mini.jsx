import React, { useEffect, useState } from 'react';
import { money2, tokens, durClock, useTick, makeColorMap } from './lib.js';

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
            <div className="minilblrow">
              <span className="minilbl">{stripProvider(b.label)}</span>
              {b.projLeftAtReset != null && !b.stale && (
                <span className="miniproj" title="Straight-line projection from your recent burn rate — how much of this window would remain at reset if the current pace continues.">
                  ~{b.projLeftAtReset}% left at reset
                </span>
              )}
            </div>
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

// Donut of per-source spend for the selected tab. SVG stroke segments on a
// single circle — no chart lib, colors from the dashboard's own source map.
function MiniDonut({ slices, total, colorMap }) {
  const R = 42, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <svg className="minidonut" viewBox="0 0 110 110" role="img" aria-label="Spend by source">
      <circle cx="55" cy="55" r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" />
      {total > 0 && slices.map((s) => {
        const frac = s.cost / total;
        const seg = (
          <circle key={s.name} cx="55" cy="55" r={R} fill="none"
            stroke={colorMap.get(s.name) || '#9b8cff'} strokeWidth="12"
            strokeDasharray={`${Math.max(0.5, frac * C - 1.5)} ${C}`}
            strokeDashoffset={-acc * C}
            transform="rotate(-90 55 55)" strokeLinecap="butt" />
        );
        acc += frac;
        return seg;
      })}
      <text x="55" y="55" textAnchor="middle" dominantBaseline="central" className="minidonutlbl">
        {money2(total)}
      </text>
    </svg>
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

// Local YYYY-MM-DD (matches the server's daily-bucket dates).
function localDs(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function MiniOverview({ data }) {
  useTick(1000); // live reset countdowns
  const [tab, setTab] = useState('30d');
  useEffect(() => {
    const prev = document.title;
    document.title = 'Pulse — mini';
    return () => { document.title = prev; };
  }, []);
  const m = data.meters;
  const cx = data.codexMeters;
  const last30 = (data.periods || []).find((p) => p.key === 'last30');
  const alerts = data.alerts || [];
  const colorMap = makeColorMap(data.allSources);

  // Per-tab totals + per-source split, all from data already in the payload.
  const dayBucket = (ds) => (last30 && (last30.daily || []).find((b) => b.date === ds)) || null;
  const todayDs = localDs(new Date());
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const tabData = (() => {
    if (tab === '30d') {
      const bySrc = last30 ? Object.keys(last30.bySource || {}).map((s) => ({ name: s, cost: last30.bySource[s].cost })) : [];
      return { cost: last30 ? last30.cost : 0, tokens: last30 ? last30.tokens : 0, bySrc };
    }
    const b = dayBucket(tab === 'today' ? todayDs : localDs(yd));
    const bySrc = b ? Object.keys(b.bySource || {}).map((s) => ({ name: s, cost: b.bySource[s] })) : [];
    return { cost: b ? b.total : 0, tokens: b ? b.tokens : 0, bySrc };
  })();
  const slices = tabData.bySrc.filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost);
  const ydBucket = dayBucket(localDs(yd));
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
            Total spend · {data.sourceFilter && data.sourceFilter.length ? data.sourceFilter.join(' + ') : 'all sources'}
          </div>
          <div className="minitabs">
            {[['today', 'Today'], ['yesterday', 'Yesterday'], ['30d', '30 Days']].map(([k, lbl]) => (
              <button key={k} className={'minitab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{lbl}</button>
            ))}
          </div>
          <div className="minidonutrow">
            <MiniDonut slices={slices} total={tabData.cost} colorMap={colorMap} />
            <div className="minilegend">
              {slices.length ? slices.map((s) => (
                <div className="minilegrow" key={s.name}>
                  <i style={{ background: colorMap.get(s.name) }} />
                  <span className="minilegname">{s.name}</span>
                  <span className="minilegval">{money2(s.cost)}</span>
                </div>
              )) : <div className="minihint">no spend in this window</div>}
            </div>
          </div>
          <div className="ministats">
            <div className="ministat"><span>Today</span><b>{money2(data.today ? data.today.cost : 0)}</b><em>{tokens(data.today ? data.today.tokens : 0)} tokens</em></div>
            <div className="ministat"><span>Yesterday</span><b>{money2(ydBucket ? ydBucket.total : 0)}</b><em>{tokens(ydBucket ? ydBucket.tokens : 0)} tokens</em></div>
            <div className="ministat"><span>Last 30 Days</span><b>{money2(last30.cost)}</b><em>{tokens(last30.tokens)} tokens</em></div>
          </div>
          <div className="minitrendhead"><span>Usage trend</span><em>from your local usage history</em></div>
          <MiniTrend daily={last30.daily} />
        </div>
      )}
    </div>
  );
}
