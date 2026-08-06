import type { ReactNode } from 'react';
import type { Founder, PolicyFlag, VerifiedIdentity } from '../types';
import { flagLabel } from '../lib/scoring';

/**
 * Signature element: a radar-sweep gauge for the Vamos Fit Score. The
 * tick marks around the ring are literal — this is the "radar" the
 * product is named for, not an arbitrary donut chart.
 */
export function ScoreGauge({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const frac = Math.min(score, 10) / 10;
  const tone = score >= 7.5 ? 'var(--color-verde)' : score >= 5.5 ? 'var(--color-marigold)' : 'var(--color-slate-mid)';
  const ticks = 28;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} title={`Vamos Fit Score ${score.toFixed(1)} / 10`}>
      <svg width={size} height={size} className="-rotate-90">
        {Array.from({ length: ticks }).map((_, i) => {
          const a = (i / ticks) * 2 * Math.PI;
          const rInner = r - 1;
          const rOuter = r + 1.5;
          const x1 = size / 2 + rInner * Math.cos(a);
          const y1 = size / 2 + rInner * Math.sin(a);
          const x2 = size / 2 + rOuter * Math.cos(a);
          const y2 = size / 2 + rOuter * Math.sin(a);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--color-line)" strokeWidth="1" />;
        })}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="2.5"
          strokeDasharray={`${c * frac} ${c}`}
          style={{ transition: 'stroke-dasharray 400ms ease-out' }}
        />
      </svg>
      <span className="absolute font-mono font-bold tabular-nums" style={{ fontSize: size * 0.3, color: tone }}>
        {score.toFixed(1)}
      </span>
    </span>
  );
}

export function ExceptionBadge({ flag, compact = false }: { flag: PolicyFlag; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[2px] border border-alerta/30 bg-alerta-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-alerta">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <path d="M12 3 L22 20 H2 Z" strokeLinejoin="round" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <line x1="12" y1="17" x2="12" y2="17.2" />
      </svg>
      {compact ? 'Policy exception' : `Policy exception · ${flagLabel(flag)}`}
    </span>
  );
}

/**
 * Renders verified demographic indicators. Chips appear ONLY when a
 * founder self-identified or made a verified public statement; the
 * verification basis is always one hover away. When nothing is on
 * record, we say exactly that — the system never guesses.
 */
export function IdentityChips({ founders }: { founders: { identity?: VerifiedIdentity }[] }) {
  const ids = founders.map((f) => f.identity).filter((x): x is VerifiedIdentity => !!x);
  /**
   * Nothing is rendered when no indicator is on record.
   *
   * This used to print "Identity not on record — requires human
   * verification, never inferred" on every row, which was true and
   * useless: it appeared identically on 209 of 209 companies, told a
   * reviewer nothing they could act on, and took up the space where a
   * real finding belongs.
   *
   * The policy it described has not changed and is not softened — a
   * demographic indicator still requires explicit self-identification or
   * a verified public statement, and is NEVER inferred from a name, a
   * photograph, a language, a geography, or a surname. That rule is
   * enforced where it matters, in the data layer: nothing in the founder
   * enrichment pipeline can write one. Restating it as a caption on
   * every row was documentation in the wrong place.
   */
  if (ids.length === 0) return null;
  const chips: { label: string; source: string }[] = [];
  const latino = ids.find((i) => i.latinoLed);
  const female = ids.find((i) => i.femaleLed);
  const other = ids.find((i) => i.otherUnderrepresented);
  if (latino) chips.push({ label: 'Latino-led ✓', source: `${latino.basis} — ${latino.source}` });
  if (female) chips.push({ label: 'Female-led ✓', source: `${female.basis} — ${female.source}` });
  if (other) chips.push({ label: `${other.otherUnderrepresented} ✓`, source: `${other.basis} — ${other.source}` });
  return (
    <span className="inline-flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="cursor-help rounded-[2px] border border-verde/30 bg-verde-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-verde"
          title={`Publicly identified founder signal — ${chip.source}`}
        >
          {chip.label}
        </span>
      ))}
    </span>
  );
}

export function FounderLine({ f }: { f: Founder }) {
  return (
    <div className="text-sm">
      <span className="font-semibold text-ink">{f.name}</span>
      <span className="text-slate-mid"> · {f.role} — {f.background}</span>
      {f.identity && (
        <span className="ml-2 cursor-help font-mono text-[11px] text-verde" title={f.identity.source}>
          [{f.identity.basis}]
        </span>
      )}
    </div>
  );
}

/**
 * Priority strip: a single hairline-bordered ticker, not a card grid.
 * Segments are divided by rules, not by repeating boxes — the metric
 * itself (a dot, a mono numeral) carries the weight, not a container.
 */
export function PriorityStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 border border-line bg-panel lg:flex lg:divide-x lg:divide-line">
      {children}
    </div>
  );
}

const DOT_TONE = { ink: 'bg-ink', marigold: 'bg-marigold', verde: 'bg-verde', alerta: 'bg-alerta' } as const;

export function PriorityStat({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: keyof typeof DOT_TONE;
}) {
  return (
    <div className="border-b border-line px-4 py-3.5 last:border-b-0 lg:flex-1 lg:border-b-0 lg:px-5 lg:py-4">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} aria-hidden />
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[28px] font-bold leading-none tabular-nums text-ink lg:text-[32px]">{value}</div>
      {sub && <div className="mt-1.5 text-xs leading-snug text-slate-mid">{sub}</div>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, blurb, right }: { eyebrow: string; title: string; blurb?: string; right?: ReactNode }) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-marigold">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-marigold opacity-40" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-marigold" />
          </span>
          {eyebrow}
        </div>
        <h1 className="mt-1 font-display text-[34px] font-semibold leading-[1.05] tracking-tight text-ink lg:text-[42px]">{title}</h1>
        {blurb && <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-slate-mid">{blurb}</p>}
      </div>
      {right}
    </header>
  );
}

export function ConfidenceMeter({ level }: { level: 'Low' | 'Medium' | 'High' }) {
  const n = level === 'High' ? 3 : level === 'Medium' ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1" title={`${level} confidence`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className="inline-block w-1.5 rounded-sm"
          style={{ height: 4 + i * 4, background: i <= n ? 'var(--color-marigold)' : 'var(--color-line)' }}
        />
      ))}
      <span className="ml-1 font-mono text-[11px] text-slate-mid">{level}</span>
    </span>
  );
}

/**
 * Distinguishes verified evidence from unverified claims, AI-inferred
 * assumptions, conflicts, and gaps — visually, not just in prose. Reused
 * everywhere a fact's origin needs to be unambiguous at a glance.
 */
export type ProvenanceKind = 'verified' | 'user-entered' | 'extracted' | 'ai-inferred' | 'unverified' | 'missing' | 'conflict';

const PROVENANCE: Record<ProvenanceKind, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'border-verde/40 bg-verde-soft text-verde' },
  'user-entered': { label: 'User-entered', cls: 'border-verde/25 bg-verde-soft/60 text-verde' },
  extracted: { label: 'Extracted public info', cls: 'border-marigold/40 bg-marigold-soft text-marigold' },
  'ai-inferred': { label: 'AI-inferred — assumption', cls: 'border-dashed border-marigold/50 bg-marigold-soft/40 text-marigold' },
  unverified: { label: 'Unverified', cls: 'border-marigold/30 bg-marigold-soft/50 text-marigold' },
  missing: { label: 'Missing', cls: 'border-line bg-paper italic text-slate-mid' },
  conflict: { label: 'Conflicting', cls: 'border-alerta/40 bg-alerta-soft text-alerta' },
};

export function ProvenanceTag({ kind, children, title }: { kind: ProvenanceKind; children?: ReactNode; title?: string }) {
  const s = PROVENANCE[kind];
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${s.cls}`}>
      {children ?? s.label}
    </span>
  );
}

/** A consistent legend for source availability across Discovery, Schedule, and Source quality. */
export type SourceState = 'live' | 'credentials-required' | 'planned' | 'unavailable';

const SOURCE_STATE: Record<SourceState, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'bg-verde-soft text-verde' },
  'credentials-required': { label: 'Credentials required', cls: 'bg-marigold-soft text-marigold' },
  planned: { label: 'Planned', cls: 'bg-line text-slate-mid' },
  unavailable: { label: 'Unavailable', cls: 'bg-line text-slate-mid' },
};

export function SourceStateBadge({ state }: { state: SourceState }) {
  const s = SOURCE_STATE[state];
  return <span className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>{s.label}</span>;
}

/** Combined health status (config + real run history) shown on the source-health view. */
export type SourceHealthStatus = 'disabled' | 'blocked' | 'healthy' | 'degraded' | 'failed' | 'enabled';

const SOURCE_HEALTH: Record<SourceHealthStatus, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'bg-verde-soft text-verde' },
  enabled: { label: 'Enabled — not yet run', cls: 'bg-line text-slate-mid' },
  degraded: { label: 'Degraded', cls: 'bg-marigold-soft text-marigold' },
  failed: { label: 'Failed', cls: 'bg-alerta-soft text-alerta' },
  blocked: { label: 'Blocked', cls: 'bg-marigold-soft text-marigold' },
  disabled: { label: 'Disabled', cls: 'bg-line text-slate-mid' },
};

export function SourceHealthBadge({ health }: { health: SourceHealthStatus }) {
  const s = SOURCE_HEALTH[health];
  return <span className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>{s.label}</span>;
}
