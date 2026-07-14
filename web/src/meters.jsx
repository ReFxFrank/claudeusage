import { Card, InfoTip } from './panels.jsx';
import { durClock, useTick } from './lib.js';

// "Account limits · official" — Anthropic's own account-wide usage gauges
// (the numbers behind /usage in Claude Code). Unified across claude.ai chats,
// Claude Code, cloud sessions and other devices, so this covers usage no
// local log can see. Opt-in; toggled from the Server panel.
export function MetersCard({ meters, delay = 0.18 }) {
  useTick(1000); // live reset countdowns
  if (!meters || !meters.enabled) return null;

  const body = (() => {
    if (meters.status === 'loading') {
      return <div className="sub">Fetching official usage from your Claude account…</div>;
    }
    if (meters.status === 'no-login' || meters.status === 'expired' || meters.status === 'error') {
      return <div className="sub" style={{ color: 'var(--warn)' }}>{meters.error || meters.status}</div>;
    }
    if (!meters.buckets || !meters.buckets.length) {
      return <div className="sub">No usage buckets reported for this account.</div>;
    }
    return (
      <div className="mrows">
        {meters.buckets.map((b) => {
          const level = b.pct >= 85 ? 'hot' : b.pct >= 60 ? 'warm' : '';
          const remaining = b.resetsAt ? b.resetsAt - Date.now() : null;
          return (
            <div className="mrow" key={b.key}>
              <div className="ml">{b.label}</div>
              <div className="mtrack"><i className={level} style={{ width: Math.max(1.5, b.pct) + '%' }} /></div>
              <div className="mv">{b.pct.toFixed(0)}%</div>
              <div className="mr">
                {remaining != null && remaining > 0 ? <>resets in <b>{durClock(remaining)}</b></> : b.resetsAt ? 'resetting…' : ''}
              </div>
            </div>
          );
        })}
      </div>
    );
  })();

  return (
    <Card delay={delay} hover={false}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Account limits · official
        <InfoTip text="Anthropic's own account meter — the same numbers as /usage in Claude Code. Limits are unified, so these bars include claude.ai chats, cloud sessions and other devices: usage no local log can see. Fetched from api.anthropic.com with your local Claude login (read-only, never logged or sent anywhere else). Turn off in the Server panel.">
          <span style={{ color: 'var(--text-3)', cursor: 'help', textTransform: 'none' }}>ⓘ</span>
        </InfoTip>
      </h2>
      {body}
    </Card>
  );
}
