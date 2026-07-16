// Provider marks for the model families recognized in ./model-families.js.
// Marks are simple original glyphs in brand colors (evocative, not exact
// trademarked logos) so they stay tasteful, lightweight, and safe.
import { modelFamily, FAMILY_META } from './model-families.js';
export { modelFamily, FAMILY_META };

// A brand-colored monogram badge — the consistent fallback and the mark for
// families without a bespoke glyph.
function Monogram({ label, color, size }) {
  return (
    <span
      title={label}
      style={{
        display: 'inline-flex', width: size, height: size, borderRadius: Math.round(size * 0.28),
        background: color, color: '#fff', fontSize: Math.round(size * 0.62), lineHeight: 1,
        fontWeight: 700, alignItems: 'center', justifyContent: 'center', flex: 'none',
        fontFamily: 'var(--mono)',
      }}
    >{label[0]}</span>
  );
}

// Simple original SVG marks for the common families; monogram for the rest.
export function ModelLogo({ model, size = 16 }) {
  const fam = modelFamily(model);
  const { label, color } = FAMILY_META[fam];
  const common = { width: size, height: size, viewBox: '0 0 24 24', style: { flex: 'none', display: 'block' } };
  const svg = (children) => (
    <span title={label} style={{ display: 'inline-flex', flex: 'none' }} aria-label={label}>
      <svg {...common}>{children}</svg>
    </span>
  );
  switch (fam) {
    case 'claude': // sunburst
      return svg(
        <g stroke={color} strokeWidth="2" strokeLinecap="round">
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * Math.PI) / 4;
            const x = 12 + Math.cos(a) * 8, y = 12 + Math.sin(a) * 8;
            const x0 = 12 + Math.cos(a) * 3, y0 = 12 + Math.sin(a) * 3;
            return <line key={i} x1={x0} y1={y0} x2={x} y2={y} />;
          })}
        </g>
      );
    case 'openai': // six-petal rosette (approximate knot)
      return svg(
        <g fill="none" stroke={color} strokeWidth="1.8">
          {Array.from({ length: 6 }).map((_, i) => {
            const a = (i * Math.PI) / 3;
            const cx = 12 + Math.cos(a) * 4, cy = 12 + Math.sin(a) * 4;
            return <circle key={i} cx={cx} cy={cy} r="4.4" />;
          })}
        </g>
      );
    case 'google': // four-point sparkle (Gemini-style)
      return svg(
        <path d="M12 2 C13 8 16 11 22 12 C16 13 13 16 12 22 C11 16 8 13 2 12 C8 11 11 8 12 2 Z" fill={color} />
      );
    case 'meta': // infinity loop
      return svg(
        <path d="M7 8 C3 8 3 16 7 16 C11 16 13 8 17 8 C21 8 21 16 17 16 C13 16 11 8 7 8 Z"
          fill="none" stroke={color} strokeWidth="2" />
      );
    case 'xai': // bold X
      return svg(
        <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
          <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
        </g>
      );
    case 'deepseek': // ring with an offset eye
      return svg(
        <g fill="none" stroke={color} strokeWidth="2">
          <circle cx="12" cy="12" r="8" /><circle cx="14.5" cy="10" r="1.6" fill={color} stroke="none" />
        </g>
      );
    case 'mistral': // stacked colored bands
      return svg(
        <g>
          {['#F7D046', '#F2A73B', '#EE792F', '#EA3326'].map((c, i) => (
            <rect key={i} x="4" y={4 + i * 4} width="16" height="3.2" rx="1" fill={c} />
          ))}
        </g>
      );
    default:
      return <Monogram label={label} color={color} size={size} />;
  }
}
