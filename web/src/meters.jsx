import { Card, InfoTip } from './panels.jsx';
import { durClock, useTick, ago } from './lib.js';

// "Account limits · official" — provider-issued usage gauges.
//  - Claude (opt-in): Anthropic's account meter via your local login — unified
//    across claude.ai chats, Claude Code, cloud sessions and other devices.
//  - Codex (automatic): the rate_limits snapshot each Codex turn writes into
//    its local rollout log — your ChatGPT plan's Codex allowance. Only as
//    fresh as your last Codex turn, so rows carry an "as of" tag.
export function MetersCard({ meters, codex, delay = 0.18 }) {
  useTick(1000); // live reset countdowns
  const anth = meters && meters.enabled ? meters : null;
  if (!anth && !codex) return null;

  const anthBody = anth && (() => {
    if (anth.status === 'loading') {
      return <div className="sub">Fetching official usage from your Claude account…</div>;
    }
    if (anth.status === 'no-login' || anth.status === 'expired' || anth.status === 'error') {
      return <div className="sub" style={{ color: 'var(--warn)' }}>{anth.error || anth.status}</div>;
    }
    if (!anth.buckets || !anth.buckets.length) {
      return <div className="sub">No usage buckets reported for this account.</div>;
    }
    return <MeterRows buckets={anth.buckets} />;
  })();

  return (
    <Card delay={delay} hover={false}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Account limits · official
        <InfoTip text="Provider-issued meters, not estimates. Claude rows (opt-in, Server panel): Anthropic's own account gauge — unified across claude.ai chats, cloud sessions and every device; fetched with your local Claude login, read-only. Codex rows: the official allowance snapshot each Codex turn records in its local log — nothing leaves your machine, but it's only as fresh as your last Codex turn.">
          <span style={{ color: 'var(--text-3)', cursor: 'help', textTransform: 'none' }}>ⓘ</span>
        </InfoTip>
      </h2>
      {anthBody}
      {codex && codex.buckets && codex.buckets.length > 0 && (
        <>
          {anth && <div style={{ height: 10 }} />}
          <MeterRows buckets={codex.buckets} asOf={codex.asOf} />
          <div className="sub" style={{ marginTop: 8 }}>
            Codex meters are read from your local Codex logs — snapshot from your last turn,{' '}
            <span className="mono">{ago(codex.asOf)}</span>. Run any Codex turn to refresh.
          </div>
        </>
      )}
    </Card>
  );
}

function MeterRows({ buckets, asOf }) {
  return (
    <div className="mrows">
      {buckets.map((b) => {
        const stale = !!b.stale;
        const level = b.pct >= 85 ? 'hot' : b.pct >= 60 ? 'warm' : '';
        const remaining = b.resetsAt ? b.resetsAt - Date.now() : null;
        return (
          <div className={'mrow' + (stale ? ' stale' : '')} key={b.key}>
            <div className="ml">{b.label}</div>
            <div className="mtrack"><i className={level} style={{ width: Math.max(1.5, b.pct) + '%' }} /></div>
            <div className="mv">{stale ? '—' : b.pct.toFixed(0) + '%'}</div>
            <div className="mr">
              {stale
                ? 'window rolled over — run a turn to refresh'
                : remaining != null && remaining > 0
                  ? <>resets in <b>{durClock(remaining)}</b></>
                  : b.resetsAt ? 'resetting…' : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
