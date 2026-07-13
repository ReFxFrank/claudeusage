import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useSummary, makeColorMap, ACCENT, money2, tokens, num, clockTime, ago } from './lib.js';
import { SpendChart, Sparkline } from './charts.jsx';
import {
  Card, CurrentBlock, BurnRate, Rollup, BarList, SessionsTable, PeriodSelect, Legend, InfoTip,
} from './panels.jsx';
import { ServerPanel, StopButton } from './server-panel.jsx';

export default function App() {
  // Source filter — empty array means "all sources". Persisted locally.
  const [srcFilter, setSrcFilter] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pulse-source-filter')) || []; } catch (_) { return []; }
  });
  const { data, error, loading } = useSummary(10000, srcFilter);
  const [periodKey, setPeriodKey] = useState('last30');
  const [stopped, setStopped] = useState(false);

  function updateFilter(next) {
    setSrcFilter(next);
    try { localStorage.setItem('pulse-source-filter', JSON.stringify(next)); } catch (_) {}
  }

  const colorMaps = useMemo(() => ({
    src: makeColorMap(data?.allSources),
    model: makeColorMap(data?.allModels),
  }), [data?.allSources, data?.allModels]);

  if (stopped) {
    return (
      <Shell version={data?.version}>
        <div className="center">
          <div>
            <h2>Pulse is stopped</h2>
            <p>
              This page can’t restart a stopped server. To start Pulse again, double-click{' '}
              <code>pulse.exe</code> — or your <b>“Pulse”</b> Desktop shortcut
              (create the shortcut pair once with <code>pulse.exe --install-shortcuts</code>).
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <div className="center">
          {error ? (
            <div>
              <h2>Can’t reach the server</h2>
              <p>Is <code>node server.js</code> running? {error}</p>
            </div>
          ) : (
            <h2>Reading your Claude Code history…</h2>
          )}
        </div>
      </Shell>
    );
  }

  const latest = data.latestTs;
  const stale = latest && data.generatedAt - latest > 3 * 3600 * 1000;
  const allSrc = data.allSources || [];

  return (
    <Shell
      version={data.version}
      codex={data.hasCodex}
      header={
        <div className="hmeta">
          <div className="hactions">
            {data.update?.status === 'available' && (
              <a className="updpill" href="#server">v{data.update.latest} available ↓</a>
            )}
            <StopButton compact onStopped={() => setStopped(true)} />
          </div>
          <div>updated <b>{clockTime(data.generatedAt)}</b> · refreshes every 10s</div>
          <div>
            {latest
              ? <>latest activity: <b className={stale ? 'warnc' : ''}>{ago(latest)}</b></>
              : 'no usage recorded on this machine'}
          </div>
          <div>{num(data.totals.messages)} msgs · {num(data.totals.sessions)} sessions · {allSrc.length <= 1 ? `source: ${allSrc[0] || 'cli'}` : `${allSrc.length} sources`}</div>
        </div>
      }
      footer={data}
    >
      {error && (
        <div className="warnbar">
          ⚠ Server unreachable ({error}) — if you stopped it, double-click <code>pulse.exe</code> to start it again.
        </div>
      )}
      <SourceFilter
        allSources={data.allSources || []}
        active={srcFilter}
        colorMap={colorMaps.src}
        onChange={updateFilter}
      />
      {!data.hasData ? (
        <>
          <div className="center">
            <div>
              <h2>No usage yet</h2>
              <p>Pulse is watching <code>{data.claudeDir}</code>. Run Claude Code and your usage appears here — the page refreshes every 10 seconds.</p>
            </div>
          </div>
          {/* the background process must stay controllable even with no data */}
          <ServerPanel data={data} onStopped={() => setStopped(true)} delay={0.2} />
        </>
      ) : (
        <Dashboard data={data} colorMaps={colorMaps} periodKey={periodKey} setPeriodKey={setPeriodKey} onStopped={() => setStopped(true)} />
      )}
    </Shell>
  );
}

// Multi-select source filter chips. Empty selection = all sources. The list
// always shows every source ever seen (server keeps allSources unfiltered),
// so a chip never disappears because you just filtered it out.
function SourceFilter({ allSources, active, colorMap, onChange }) {
  if (!allSources || allSources.length < 2) return null;
  const set = new Set(active);
  function toggle(s) {
    const next = new Set(set);
    if (next.has(s)) next.delete(s); else next.add(s);
    // selecting everything = no filter
    onChange(next.size === allSources.length ? [] : Array.from(next));
  }
  return (
    <div className="srcfilter">
      <span className="sflabel">sources</span>
      <button
        className={'sfchip' + (set.size === 0 ? ' on' : '')}
        onClick={() => onChange([])}
      >
        all
      </button>
      {allSources.map((s) => (
        <button
          key={s}
          className={'sfchip' + (set.has(s) ? ' on' : '')}
          onClick={() => toggle(s)}
          title={set.has(s) ? 'Click to remove from filter' : 'Click to show only selected sources'}
        >
          <i style={{ background: colorMap.get(s) }} />{s}
        </button>
      ))}
      {set.size > 0 && (
        <span className="sfnote">showing {Array.from(set).join(' + ')} only</span>
      )}
    </div>
  );
}

function Dashboard({ data, colorMaps, periodKey, setPeriodKey, onStopped }) {
  const periods = data.periods || [];
  let period = periods.find((p) => p.key === periodKey);
  if (!period) period = periods[0];

  const modelRows = period
    ? Object.keys(period.byModel).sort((a, b) => period.byModel[b].cost - period.byModel[a].cost)
        .map((m) => ({ name: m, ...period.byModel[m], color: colorMaps.model.get(m) }))
    : [];
  const sourceRows = period
    ? Object.keys(period.bySource).sort((a, b) => period.bySource[b].cost - period.bySource[a].cost)
        .map((s) => ({ name: s, ...period.bySource[s], color: colorMaps.src.get(s) }))
    : [];

  return (
    <>
      {data.selfCheck && !data.selfCheck.ok && (
        <div className="warnbar">⚠ internal self-check: {data.selfCheck.issues.join('; ')}</div>
      )}

      <div className="grid stats">
        <CurrentBlock cb={data.currentBlock} delay={0} />
        <BurnRate burn={data.burnRate} delay={0.05} />
        <Rollup label="Today" r={data.today} delay={0.1} />
        <Rollup label="Last 7 days" r={data.week} delay={0.15} />
      </div>

      {period && (
        <>
          <Card delay={0.2} hover={false}>
            <div className="h2row">
              <h2 style={{ marginBottom: 0 }}>
                Spend&nbsp;
                <InfoTip text="Estimated at Claude API list prices. On a Pro/Max plan this reflects relative usage, not a bill. Pick a month to see fixed calendar-month totals.">
                  <span style={{ color: 'var(--text-3)', cursor: 'help' }}>ⓘ</span>
                </InfoTip>
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <PeriodSelect periods={periods} value={period.key} onChange={setPeriodKey} />
                <Legend period={period} colorMap={colorMaps.src} single={period.singleSource} />
              </div>
            </div>
            <div className="sub" style={{ margin: '2px 0 14px' }}>
              <span className="mono" style={{ color: 'var(--text)', fontSize: 17 }}>{money2(period.cost)}</span>
              {' · '}<span className="mono">{tokens(period.tokens)}</span> tokens
              {' · '}<span className="mono">{num(period.messages)}</span> msgs
              {' · '}<span className="mono">{num(period.sessions)}</span> sessions
            </div>
            <SpendChart period={period} colorMap={colorMaps.src} />
          </Card>

          <div className="grid cols-2">
            <Card delay={0.24}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                By model · {period.label}
                <InfoTip
                  text={
                    data.modesLogged
                      ? 'Chips show the reasoning effort (low → max, plus ultracode) from /effort commands in your session transcripts — and from Pulse’s optional hook — plus execution speed when fast mode was used.'
                      : 'Effort chips appear when a session sets a level with /effort (Pulse reads those commands from the transcripts automatically) or via Pulse’s optional hook (--effort-setup). Ultracode is also detected from prompt text.'
                  }
                >
                  <span style={{ color: 'var(--text-3)', cursor: 'help', textTransform: 'none' }}>ⓘ</span>
                </InfoTip>
              </h2>
              <BarList rows={modelRows} />
            </Card>
            {period.singleSource ? (
              <Card delay={0.28}>
                <h2>By source · {period.label}</h2>
                <div className="sub" style={{ marginTop: 2, marginBottom: 4 }}>
                  Single source — <b style={{ color: 'var(--text-2)' }}>{period.sources[0] || 'cli'}</b> accounts for 100% of this period.
                </div>
                <Sparkline period={period} />
              </Card>
            ) : (
              <Card delay={0.28}>
                <h2>By source · {period.label}</h2>
                <BarList rows={sourceRows} />
              </Card>
            )}
          </div>
        </>
      )}

      <Card delay={0.32} hover={false}>
        <h2>Recent sessions</h2>
        <SessionsTable sessions={data.recentSessions} />
      </Card>

      <ServerPanel data={data} onStopped={onStopped} delay={0.36} />
    </>
  );
}

function Shell({ children, header, footer, version, codex }) {
  return (
    <div className="wrap">
      <motion.header className="hdr" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="brand">
          <div className="logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M3 12h4l2-6 4 14 2-8h6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <h1>Pulse</h1>
            <div className="tag"><span className="dot" />{codex ? 'Claude Code + Codex' : 'Claude Code usage'} · live{version ? <span className="ver">v{version}</span> : null}</div>
          </div>
        </div>
        {header}
      </motion.header>

      {children}

      {footer && (
        <footer>
          <div className="disc">
            Costs are <b>estimates</b> at Claude API list prices — on a Pro/Max subscription they express
            relative usage, not a bill. Pulse runs entirely on your machine and reads <code>~/.claude</code> read-only.
            Its only network call is a GitHub version check — usage data never leaves this machine
            (disable with <code>--no-update-check</code>).
          </div>
          <div className="reading">
            reading: {footer.claudeDir} · {num((footer.fileCount || 0) - (footer.codexFileCount || 0))} session file{(footer.fileCount || 0) - (footer.codexFileCount || 0) === 1 ? '' : 's'}
            {footer.hasCodex ? <> &nbsp;+&nbsp; {footer.codexDir} · {num(footer.codexFileCount)} codex file{footer.codexFileCount === 1 ? '' : 's'}</> : null}
          </div>
        </footer>
      )}
    </div>
  );
}
