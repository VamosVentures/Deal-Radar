import type { ReactNode } from 'react';
import type { Founder, PolicyFlag, VerifiedIdentity } from '../types';
import { flagLabel } from '../lib/scoring';

/** Signature element: a small radar-sweep gauge for the Vamos Fit Score. */
export function ScoreGauge({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const frac = Math.min(score, 10) / 10;
  const tone = score >= 7.5 ? 'var(--color-verde)' : score >= 5.5 ? 'var(--color-marigold)' : 'var(--color-slate-mid)';
  return (
    <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }} title={`Vamos Fit Score ${score.toFixed(1)} / 10`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth="3" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
        />
      </svg>
      <span className="absolute font-mono font-bold" style={{ fontSize: size * 0.3, color: tone }}>
        {score.toFixed(1)}
      </span>
    </span>
  );
}

export function ExceptionBadge({ flag, compact = false }: { flag: PolicyFlag; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-alerta-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-alerta">
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
  if (ids.length === 0) {
    return <span className="text-xs text-slate-mid italic">Identity not on record — never inferred</span>;
  }
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
          className="cursor-help rounded-sm bg-verde-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-verde"
          title={`Verification: ${chip.source}`}
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
      <span className="font-semibold">{f.name}</span>
      <span className="text-slate-mid"> · {f.role} — {f.background}</span>
      {f.identity && (
        <span className="ml-2 cursor-help font-mono text-[11px] text-verde" title={f.identity.source}>
          [{f.identity.basis}]
        </span>
      )}
    </div>
  );
}

export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-panel px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-widest text-slate-mid">{label}</div>
      <div className="mt-1 font-display text-2xl font-bold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-mid">{sub}</div>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, blurb, right }: { eyebrow: string; title: string; blurb?: string; right?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-marigold">{eyebrow}</div>
        <h1 className="font-display text-[26px] font-bold leading-tight">{title}</h1>
        {blurb && <p className="mt-1 max-w-2xl text-sm text-slate-mid">{blurb}</p>}
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
