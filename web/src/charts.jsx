import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ACCENT, money, money2, tokens, dayLabel } from './lib.js';

// measure a container's width (responsive SVG without distortion)
function useMeasure() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(ref.current);
    setW(ref.current.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// rounded-top-only bar path
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  if (r <= 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

// ---------- circular progress ring (5h block reset) ----------
export function ProgressRing({ fraction, size = 96, stroke = 8, children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction || 0));
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8f7ff5" />
            <stop offset="100%" stopColor="#b3a5ff" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#ringg)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - f)}
          style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.2,0.7,0.2,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  );
}

// ---------- cumulative-spend sparkline ----------
export function Sparkline({ period, height = 92 }) {
  const [ref, W] = useMeasure();
  const pad = 5;
  const cum = [];
  let run = 0;
  (period.daily || []).forEach((b) => { run += b.total; cum.push(run); });
  const max = cum[cum.length - 1] || 1;
  const n = cum.length;
  const w = W || 400;
  const pts = cum.map((v, i) => {
    const x = pad + (n > 1 ? i / (n - 1) : 0) * (w - 2 * pad);
    const y = height - pad - (v / max) * (height - 2 * pad);
    return [x, y];
  });
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${w - pad},${height - pad} L${pad},${height - pad} Z`;
  const [len, setLen] = useState(0);
  const pathRef = useRef(null);
  useEffect(() => { if (pathRef.current) setLen(pathRef.current.getTotalLength()); }, [line]);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <div className="sub" style={{ marginTop: 0, marginBottom: 6 }}>
        Cumulative spend · {period.label} · <span className="mono" style={{ color: 'var(--text)' }}>{money2(max)}</span>
      </div>
      <svg width={w} height={height} role="img" aria-label="Cumulative spend">
        <defs>
          <linearGradient id="spg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.32" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#spg)" />
        <path
          ref={pathRef}
          d={line}
          fill="none"
          stroke={ACCENT}
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={len || undefined}
          strokeDashoffset={len || 0}
          style={{ animation: len ? 'draw 1.1s ease forwards' : undefined }}
        />
        <style>{`@keyframes draw { to { stroke-dashoffset: 0; } }`}</style>
      </svg>
    </div>
  );
}

// ---------- 30-day / month stacked bar chart ----------
export function SpendChart({ period, colorMap }) {
  const [ref, W] = useMeasure();
  const tipRef = useRef(null);
  const H = 214;
  const padT = 24, padB = 22, padX = 4; // padT leaves headroom for the max label
  const w = W || 900;
  const innerW = w - padX * 2;
  const innerH = H - padT - padB;
  const days = period.daily || [];
  const n = days.length || 1;
  const gap = n > 45 ? 2 : 3;
  const bw = Math.max(2, (innerW - gap * (n - 1)) / n);
  let max = 0;
  days.forEach((b) => { if (b.total > max) max = b.total; });
  if (max <= 0) max = 1;
  const srcs = period.sources || [];
  const single = period.singleSource;

  function showTip(ev, b) {
    const el = tipRef.current, wrap = ref.current;
    if (!el || !wrap) return;
    let rows = '';
    srcs.forEach((s) => {
      const c = (b.bySource && b.bySource[s]) || 0;
      if (c <= 0) return;
      const col = single ? ACCENT : colorMap.get(s);
      rows += `<div class="tr"><span><i style="background:${col}"></i>${escapeHtml(s)}</span><span class="tv">${money2(c)}</span></div>`;
    });
    if (!rows) rows = '<div class="tr" style="color:var(--text-3)">no spend</div>';
    el.innerHTML = `<div class="td">${b.date}</div>${rows}<div class="tr tot"><span>total</span><span class="tv">${money2(b.total)}</span></div><div class="tr" style="color:var(--text-3)"><span>tokens</span><span class="tv">${tokens(b.tokens)}</span></div>`;
    el.style.opacity = '1';
    // Position relative to the chart container, not the viewport: an ancestor
    // with a CSS transform (the framer-motion card) turns position:fixed into
    // ancestor-relative, which sent the tooltip far away from the cursor.
    const rect = wrap.getBoundingClientRect();
    const tw = el.offsetWidth, th = el.offsetHeight;
    let left = ev.clientX - rect.left + 14;
    let top = ev.clientY - rect.top + 14;
    if (left + tw > rect.width - 4) left = ev.clientX - rect.left - tw - 14;
    if (top + th > rect.height - 2) top = ev.clientY - rect.top - th - 12;
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(2, top) + 'px';
  }
  function hideTip() { if (tipRef.current) tipRef.current.style.opacity = '0'; }

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }} onMouseLeave={hideTip}>
      <svg width={w} height={H} role="img" aria-label={`Daily spend for ${period.label}`}>
        <defs>
          {srcs.map((s, i) => {
            const col = single ? ACCENT : colorMap.get(s);
            return (
              <linearGradient key={i} id={`bg${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={col} stopOpacity="1" />
                <stop offset="100%" stopColor={col} stopOpacity="0.72" />
              </linearGradient>
            );
          })}
        </defs>
        <line x1={padX} y1={padT + innerH} x2={w - padX} y2={padT + innerH} stroke="var(--stroke)" />
        <text x={padX} y={13} fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">{money(max)}</text>
        {days.map((b, i) => {
          const x = padX + i * (bw + gap);
          const segs = srcs
            .map((s) => ({ s, c: (b.bySource && b.bySource[s]) || 0 }))
            .filter((seg) => seg.c > 0);
          let drawn = 0;
          const parts = segs.map((seg, k) => {
            const segH = (seg.c / max) * innerH;
            const isTop = k === segs.length - 1;
            const yy = padT + innerH - drawn - segH;
            const r = isTop ? Math.min(4, bw / 2, segH) : 0;
            const si = srcs.indexOf(seg.s);
            drawn += segH + (k < segs.length - 1 ? 2 : 0);
            return (
              <path
                key={k}
                d={barPath(x, yy, bw, segH, r)}
                fill={single ? 'url(#bg0)' : `url(#bg${si})`}
                style={{ transition: 'd 0.5s ease' }}
              />
            );
          });
          return (
            <g key={i}>
              {parts}
              <rect
                x={x}
                y={padT}
                width={bw}
                height={innerH}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseMove={(e) => showTip(e, b)}
              />
              {n <= 31 && (i % 5 === 0 || i === n - 1) && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" fill="var(--text-3)" fontSize="10" fontFamily="var(--mono)">
                  {dayLabel(b.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div ref={tipRef} className="ctip" />
    </div>
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
