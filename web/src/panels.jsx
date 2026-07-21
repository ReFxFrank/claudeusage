import { useEffect, useRef, useState } from 'react';
import { motion, animate } from 'framer-motion';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ProgressRing } from './charts.jsx';
import { money, money2, tokens, num, pct, dur, durClock, hm, ago, ACCENT, perf, postJson } from './lib.js';
import { ModelLogo, modelFamily, FAMILY_META } from './logos.jsx';

const EASE = [0.2, 0.7, 0.2, 1];

// glass card with staggered entrance + hover lift (framer handles transform)
export function Card({ delay = 0, hover = true, className = '', children, ...rest }) {
  return (
    <motion.div
      className={'card ' + className}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: EASE }}
      whileHover={hover ? { y: -3 } : undefined}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

// animates a number to its new value without per-frame React re-renders
export function AnimatedNumber({ value, format }) {
  const ref = useRef(null);
  const prev = useRef(value ?? 0);
  useEffect(() => {
    const from = prev.current;
    const to = value ?? 0;
    prev.current = to;
    // Lite mode / background tab: no 60fps text tween — jump to the value.
    if ((from === to || perf.lite || document.hidden) && ref.current) {
      ref.current.textContent = format(to);
      return;
    }
    const controls = animate(from, to, {
      duration: 0.9,
      ease: EASE,
      onUpdate: (v) => { if (ref.current) ref.current.textContent = format(v); },
    });
    return () => controls.stop();
  }, [value, format]);
  return <span ref={ref}>{format(value ?? 0)}</span>;
}

export function InfoTip({ children, text }) {
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="rtip" sideOffset={7}>
            {text}
            <Tooltip.Arrow style={{ fill: 'rgba(16,14,22,0.92)' }} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function Legend({ period, colorMap, single }) {
  if (single) {
    return (
      <div className="legend">
        <span><i style={{ background: ACCENT }} />{period.sources[0] || 'cli'}</span>
      </div>
    );
  }
  return (
    <div className="legend">
      {(period.sources || []).map((s) => (
        <span key={s}><i style={{ background: colorMap.get(s) }} />{s}</span>
      ))}
    </div>
  );
}

// ---- current 5h block with reset ring ----
export function CurrentBlock({ cb, delay }) {
  // live re-render each second for the countdown
  useTickLocal();
  if (!cb) {
    return (
      <Card delay={delay} className="tile">
        <div className="label">Current 5h block</div>
        <div className="big muted">idle</div>
        <div className="sub">No active usage window. A new block starts on your next request.</div>
      </Card>
    );
  }
  const now = Date.now();
  const remaining = cb.end - now;
  const frac = 1 - Math.max(0, Math.min(1, (cb.end - cb.start) ? remaining / (cb.end - cb.start) : 0));
  return (
    <Card delay={delay} className="tile">
      <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Current 5h block
        <InfoTip text={cb.official
          ? 'Window timing comes from Anthropic’s official account meter (the same reset as /usage) — the exact true reset, covering usage on every device. Cost/tokens shown are this machine’s Claude contribution within that window; Codex has separate limits.'
          : 'Claude usage only (Codex has separate limits). Reconstructed from this machine’s logs: the first message after a ≥5h gap opens a 5-hour window. Claude’s REAL window is opened by your first message on any surface — claude.ai, mobile, another computer — so the actual reset can be earlier than shown. Enable account meters in the Server panel and this tile switches to the official timer automatically.'}>
          <span style={{ color: 'var(--text-3)', cursor: 'help', textTransform: 'none' }}>ⓘ</span>
        </InfoTip>
        {cb.official && <span className="offbadge">official</span>}
      </div>
      <div className="blockrow">
        <div className="col">
          <div className="big grad"><AnimatedNumber value={cb.cost} format={money2} /></div>
          <div className="sub">
            <span className="mono">{tokens(cb.tokens)}</span> tokens · <span className="mono">{num(cb.messages)}</span> msgs
          </div>
          {cb.vsPeakCostPct != null && (
            <div className="chip">vs heaviest block&nbsp;<b>{pct(cb.vsPeakCostPct)}</b></div>
          )}
        </div>
        <ProgressRing fraction={frac} size={96} stroke={9}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
            <span style={{ fontSize: 8.5, color: 'var(--text-3)', letterSpacing: '0.11em', textTransform: 'uppercase' }}>resets in</span>
            <span className="mono" style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, whiteSpace: 'nowrap', letterSpacing: '-0.02em' }}>{durClock(remaining)}</span>
          </div>
        </ProgressRing>
      </div>
      <div className="sub" style={{ marginTop: 12 }}>
        {hm(cb.start)} → {hm(cb.end)}{cb.official ? ' · synced to Anthropic’s clock' : ' · reconstructed'}
      </div>
    </Card>
  );
}

export function BurnRate({ burn, delay }) {
  return (
    <Card delay={delay} className="tile">
      <div className="label">Burn rate · 60 min</div>
      {!burn ? (
        <>
          <div className="big muted">—</div>
          <div className="sub">No activity in the last hour.</div>
        </>
      ) : (
        <>
          <div className="big">
            <AnimatedNumber value={burn.dollarsPerHour} format={money2} /><span className="unit">/hr</span>
          </div>
          <div className="sub">
            <span className="mono">{tokens(burn.tokensPerMin)}</span> tok/min · window {burn.elapsedMin.toFixed(0)}m
          </div>
        </>
      )}
    </Card>
  );
}

export function Rollup({ label, r, delay }) {
  return (
    <Card delay={delay} className="tile">
      <div className="label">{label}</div>
      <div className="big"><AnimatedNumber value={r.cost} format={money2} /></div>
      <div className="facts">
        <div className="fact">tokens<b>{tokens(r.tokens)}</b></div>
        <div className="fact">messages<b>{num(r.messages)}</b></div>
      </div>
    </Card>
  );
}

// speed chips — execution speed (fast vs standard) recorded in transcripts.
// `speeds` is a { speedName: count } map, or an array of names.
export function SpeedBadges({ speeds, align = 'flex-end' }) {
  let entries;
  if (Array.isArray(speeds)) entries = speeds.map((s) => [s, 0]);
  else entries = Object.entries(speeds || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <span className="spd" style={{ justifyContent: align }} />;
  return (
    <span className="spd" style={{ justifyContent: align }}>
      {entries.map(([sp]) => (
        <span key={sp} className={'spdb' + (sp !== 'standard' ? ' hot' : '')}>{sp}</span>
      ))}
    </span>
  );
}

// effort chips — reasoning effort captured by Pulse's optional hook logging
// (node server.js --effort-setup). `efforts` is a {level: count} map or an
// array of level names; `ultracode` adds the ULTRA chip.
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function EffortBadges({ efforts, ultracode, align = 'flex-end' }) {
  let names;
  if (Array.isArray(efforts)) names = efforts.slice();
  else names = Object.keys(efforts || {});
  names = names.filter((n) => n && n !== 'ultracode');
  names.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (!names.length && !ultracode) return null;
  return (
    <span className="spd" style={{ justifyContent: align }}>
      {ultracode && <span className="spdb ultra">ultra</span>}
      {names.map((n) => (
        <span key={n} className={'spdb e-' + n}>{n}</span>
      ))}
    </span>
  );
}

// Limit-alerts banner: the windows currently at/above a warning threshold.
// notifyState lets us offer to turn on desktop notifications inline.
export function AlertsBar({ alerts, notifyState, onEnableNotify }) {
  if (!alerts || !alerts.length) return null;
  // Only windows still *approaching* a limit reach here — the server drops any
  // that are already maxed out (a limit you've hit isn't one you're nearing).
  // Anomaly rows (opt-in spend spikes) carry their own `detail` text, no pct.
  // Headline follows the mix: anomaly-only, limits-only, or both.
  const hasAnomaly = alerts.some((a) => a.kind === 'anomaly');
  const anomalyOnly = hasAnomaly && alerts.every((a) => a.kind === 'anomaly');
  const headline = anomalyOnly ? 'Unusual spend —' : hasAnomaly ? 'Heads up —' : 'Approaching a limit —';
  return (
    <div className="alertbar" role="status">
      <span className="alertdot" />
      <span className="alerttxt">
        <b>{headline}</b>{' '}
        {alerts.map((a) => (a.kind === 'anomaly' ? a.detail : `${a.label} ${Math.round(a.pct)}%`)).join(' · ')}
      </span>
      {notifyState === 'default' && (
        <button className="btn ghost albtn" onClick={onEnableNotify}>Enable desktop alerts</button>
      )}
    </div>
  );
}

// Budget goal: progress toward a self-set monthly/weekly spend target, with an
// inline control to set/change/clear it. Colours shift ok → warn (≥80%) → over
// (≥100%). Renders a slim "set a budget" prompt when none is configured.
export function BudgetCard({ budget }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(budget ? String(budget.target) : '');
  const [period, setPeriod] = useState(budget ? budget.period : 'month');
  const [busy, setBusy] = useState(false);

  async function save(clear) {
    setBusy(true);
    try {
      const amt = clear ? 0 : parseFloat(amount);
      await postJson('/api/budget/set?amount=' + (isFinite(amt) ? amt : 0) + '&period=' + period);
      setEditing(false); // the 10s poll refreshes data.budget with the new spend
      if (clear) setAmount('');
    } catch (_) { /* leave the form open on failure */ }
    setBusy(false);
  }

  if (editing || !budget) {
    return (
      <div className="budgetcard set">
        <div className="bhead"><span className="blabel">Spend budget</span></div>
        {editing || !budget ? (
          <div className="bform">
            <span className="bcur">$</span>
            <input
              className="binput" type="number" min="0" step="1" inputMode="decimal"
              placeholder="e.g. 200" value={amount} autoFocus={editing}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(false); }}
            />
            <div className="bperiod">
              {['month', 'week'].map((p) => (
                <button key={p} className={'bpchip' + (period === p ? ' on' : '')} onClick={() => setPeriod(p)}>/{p === 'month' ? 'mo' : 'wk'}</button>
              ))}
            </div>
            <button className="btn albtn" disabled={busy || !(parseFloat(amount) > 0)} onClick={() => save(false)}>Save</button>
            {budget && <button className="btn ghost albtn" disabled={busy} onClick={() => save(true)}>Clear</button>}
            {budget && <button className="btn ghost albtn" disabled={busy} onClick={() => { setEditing(false); setAmount(String(budget.target)); }}>Cancel</button>}
          </div>
        ) : (
          <button className="btn albtn" onClick={() => setEditing(true)}>Set a spend budget</button>
        )}
      </div>
    );
  }

  const p = Math.min(100, budget.pct);
  const msLeft = budget.resetsAt ? budget.resetsAt - Date.now() : null;
  // Monthly resets are days out — show "Nd" rather than hundreds of hours.
  const resetTxt = msLeft != null
    ? 'resets in ' + (msLeft >= 48 * 3600e3 ? Math.round(msLeft / 86400e3) + 'd' : dur(msLeft))
    : 'rolling 7 days';
  return (
    <div className={'budgetcard state-' + budget.state}>
      <div className="bhead">
        <span className="blabel">Budget · {budget.label}</span>
        <span className="bfig">
          <b>{money2(budget.spent)}</b> <span className="bof">of {money(budget.target)}</span>
          <span className="bpct">{Math.round(budget.pct)}%</span>
        </span>
        <button className="bedit" title="Change budget" onClick={() => { setEditing(true); setAmount(String(budget.target)); setPeriod(budget.period); }}>edit</button>
      </div>
      <div className="btrack"><div className="bfill" style={{ width: p + '%' }} /></div>
      <div className="bsub">
        {budget.state === 'over'
          ? <span className="bover">over by {money2(budget.spent - budget.target)}</span>
          : <span>{money2(budget.remaining)} left</span>}
        <span className="bsep">·</span>{resetTxt}
        {budget.projected != null && (
          <>
            <span className="bsep">·</span>
            <span className={'bpace' + (budget.projected > budget.target ? ' bad' : budget.projected >= 0.8 * budget.target ? ' warn' : '')}>
              on pace for ~{money(budget.projected)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// Activity heatmap: weekday × hour, shaded by cost (messages on hover). A model
// only appears if it's in the logs, so the grid reflects real working hours.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function Heatmap({ heatmap }) {
  if (!heatmap || !heatmap.grid) return null;
  const max = heatmap.maxCost > 0 ? heatmap.maxCost : 1;
  const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
  const hourLabel = (h) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p');
  return (
    <div className="heatmap">
      <div className="hm-hours">
        <span className="hm-daylabel" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="hm-hlabel">{HOURS.includes(h) ? hourLabel(h) : ''}</span>
        ))}
      </div>
      {heatmap.grid.map((row, d) => (
        <div className="hm-row" key={d}>
          <span className="hm-daylabel">{WEEKDAYS[d]}</span>
          {row.map((c, h) => {
            const intensity = c.cost > 0 ? 0.14 + 0.86 * Math.sqrt(c.cost / max) : 0;
            return (
              <InfoTip key={h} text={`${WEEKDAYS[d]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} — ${money2(c.cost)} · ${tokens(c.tokens)} tokens · ${num(c.messages)} msgs`}>
                <span className="hm-cell" style={{ background: c.cost > 0 ? `rgba(155,140,255,${intensity})` : undefined }} />
              </InfoTip>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// horizontal bars for by-model / by-source. `modelLogos` swaps the color chip
// for a provider mark (recognized per model family) on the by-model list.
export function BarList({ rows, modelLogos = false, estimatedSources = [] }) {
  let max = 0;
  rows.forEach((r) => { if (r.cost > max) max = r.cost; });
  if (max <= 0) max = 1;
  const est = new Set(estimatedSources);
  return (
    <>
      {/* the bar encodes spend, not tokens — spell it out so a low-token but
          costly model (or vice-versa) never looks mis-sized next to its numbers. */}
      <div className="barhint">bar length = spend · numbers show $ · tokens</div>
      <div className="hbars">
      {rows.map((r) => (
        <InfoTip key={r.name} text={`${modelLogos ? FAMILY_META[modelFamily(r.name)].label + ' · ' : ''}${r.name} — ${money2(r.cost)} · ${tokens(r.tokens)} tokens · ${num(r.messages)} msgs`}>
          <div className="hbar">
            <div className="nm">{modelLogos ? <ModelLogo model={r.name} size={16} /> : <i style={{ background: r.color }} />}{r.name}{est.has(r.name) && <sup className="estmark" title="Locally-estimated usage, not provider-billed">est</sup>}</div>
            <div className="track">
              <motion.i
                style={{ background: r.color }}
                initial={{ width: 0 }}
                animate={{ width: Math.max(2, (r.cost / max) * 100) + '%' }}
                transition={{ duration: 0.7, ease: EASE }}
              />
            </div>
            <div className="v">{money2(r.cost)} <small>· {tokens(r.tokens)}</small></div>
            <span className="spd" style={{ justifyContent: 'flex-end' }}>
              <EffortBadges efforts={r.efforts} ultracode={!!r.ultracode} align="flex-end" />
              <SpeedBadges speeds={onlyNonStandard(r.speeds)} />
            </span>
          </div>
        </InfoTip>
      ))}
      </div>
    </>
  );
}

// Spend broken down by reasoning-effort level (incl. ultracode / default) —
// bars colored to match the effort-chip heat ramp.
const EFFORT_SPEND_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'default'];
const EFFORT_BAR_COLORS = {
  minimal: '#8a8f98', low: '#22b892', medium: '#4a9bf5', high: '#9b8cff',
  xhigh: '#e0a132', max: '#f27878', ultracode: '#c07be0', default: '#5b6270',
};
export function EffortSpendBars({ spend }) {
  const keys = EFFORT_SPEND_ORDER.filter((k) => spend && spend[k] && spend[k].cost > 0);
  if (!keys.length) {
    return <div className="sub" style={{ marginTop: 4 }}>No effort recorded in this window — set a level with <code>/effort</code> and it appears here.</div>;
  }
  let max = 0;
  keys.forEach((k) => { if (spend[k].cost > max) max = spend[k].cost; });
  if (max <= 0) max = 1;
  const label = (k) => (k === 'ultracode' ? 'ultra' : k);
  const cls = (k) => (k === 'ultracode' ? 'spdb ultra' : k === 'default' ? 'spdb' : 'spdb e-' + k);
  return (
    <div className="hbars">
      {keys.map((k) => (
        <InfoTip key={k} text={`${label(k)} — ${money2(spend[k].cost)} · ${tokens(spend[k].tokens)} tokens · ${num(spend[k].messages)} msgs`}>
          <div className="hbar">
            <div className="nm"><span className={cls(k)}>{label(k)}</span></div>
            <div className="track">
              <motion.i style={{ background: EFFORT_BAR_COLORS[k] }} initial={{ width: 0 }}
                animate={{ width: Math.max(2, (spend[k].cost / max) * 100) + '%' }} transition={{ duration: 0.7, ease: EASE }} />
            </div>
            <div className="v">{money2(spend[k].cost)} <small>· {tokens(spend[k].tokens)}</small></div>
          </div>
        </InfoTip>
      ))}
    </div>
  );
}

// Spend by project (working directory). Rows arrive pre-sorted by cost; we show
// the folder name and keep the full path in the tooltip.
function projectBase(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
export function ProjectBars({ rows }) {
  if (!rows || !rows.length) return <div className="sub" style={{ marginTop: 4 }}>No project activity in this window.</div>;
  let max = 0;
  rows.forEach((r) => { if (r.cost > max) max = r.cost; });
  if (max <= 0) max = 1;
  return (
    <div className="hbars">
      {rows.map((r) => {
        const special = r.project === '(other)' || r.project === '(unknown)';
        const name = special ? r.project : projectBase(r.project);
        return (
          <InfoTip key={r.project} text={`${r.project} — ${money2(r.cost)} · ${tokens(r.tokens)} tokens · ${num(r.messages)} msgs · ${num(r.sessions)} sessions`}>
            <div className="hbar">
              <div className="nm" style={special ? { color: 'var(--text-3)', fontStyle: 'italic' } : null}>{name}</div>
              <div className="track">
                <motion.i style={{ background: 'linear-gradient(90deg, #6f8cff, #9b8cff)' }} initial={{ width: 0 }}
                  animate={{ width: Math.max(2, (r.cost / max) * 100) + '%' }} transition={{ duration: 0.7, ease: EASE }} />
              </div>
              <div className="v">{money2(r.cost)} <small>· {tokens(r.tokens)}</small></div>
            </div>
          </InfoTip>
        );
      })}
    </div>
  );
}

// with effort chips present, a "standard" speed chip on every row is noise —
// keep speed chips for the interesting case (fast) only
function onlyNonStandard(speeds) {
  const out = {};
  for (const [k, v] of Object.entries(speeds || {})) if (k !== 'standard') out[k] = v;
  return out;
}

export function SessionsTable({ sessions }) {
  if (!sessions || !sessions.length) return <div className="sub">No sessions yet.</div>;
  return (
    <div className="scrollx">
      <table>
        <thead>
          <tr>
            <th>Session</th><th>Source</th><th>Mode</th><th>Model(s)</th>
            <th className="n">Cost</th><th className="n">Tokens</th><th className="n">Msgs</th><th className="n">Last</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.sessionId}>
              <td className="title">{s.title}</td>
              <td><span className="badge">{s.source}</span></td>
              <td>
                <span className="spd" style={{ justifyContent: 'flex-start' }}>
                  <EffortBadges efforts={s.efforts} ultracode={!!s.ultracode} align="flex-start" />
                  <SpeedBadges speeds={(s.speeds || []).filter((x) => x !== 'standard')} align="flex-start" />
                  {!(s.efforts && s.efforts.length) && !s.ultracode && !(s.speeds || []).some((x) => x !== 'standard') && (
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>—</span>
                  )}
                </span>
              </td>
              <td style={{ color: 'var(--text-3)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {s.models.map((mdl) => (
                    <span key={mdl} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <ModelLogo model={mdl} size={13} />{mdl}
                    </span>
                  ))}
                </span>
              </td>
              <td className="n">{money2(s.cost)}</td>
              <td className="n">{tokens(s.tokens)}</td>
              <td className="n">{num(s.messages)}</td>
              <td className="n tago">{ago(s.lastTs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PeriodSelect({ periods, value, onChange }) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="selTrigger" aria-label="Spend period">
        <Select.Value />
        <Select.Icon className="chev">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="selContent" position="popper" sideOffset={6} align="end">
          <Select.Viewport>
            {periods.map((p) => (
              <Select.Item key={p.key} value={p.key} className="selItem">
                <Select.ItemText>{p.label} — {money2(p.cost)}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

// local 1s ticker (useState/useEffect imported at the top of the file)
function useTickLocal() {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
}
