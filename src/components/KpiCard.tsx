import type { KeyboardEvent, ReactNode } from 'react';

// Mirrors ui.tsx's PriorityStat tone map (kept local, not exported from
// there, to avoid tripping the fast-refresh-only-exports-components lint
// rule ui.tsx is otherwise clean of).
const DOT_TONE = { ink: 'bg-ink', marigold: 'bg-marigold', verde: 'bg-verde', alerta: 'bg-alerta' } as const;

/**
 * A clickable, keyboard-accessible KPI tile — same visual language as
 * PriorityStat (src/components/ui.tsx), but interactive: every card opens
 * a KpiBreakdownModal showing that exact metric's per-vertical breakdown.
 */
export function KpiCard({
  label,
  value,
  sub,
  tone = 'ink',
  onOpen,
  loading = false,
  tooltip,
  warning,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: keyof typeof DOT_TONE;
  onOpen: () => void;
  loading?: boolean;
  /** Native title tooltip — used to explain what a metric actually measures (e.g. what "run" means for this entity). */
  tooltip?: string;
  /**
   * A short warning label shown when this card's underlying run was
   * partial (Completed with warnings) — must never be silently absorbed
   * into a normal-looking number. See KpiBreakdownModal for the detail.
   */
  warning?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-label={`${label}: ${typeof value === 'number' || typeof value === 'string' ? value : '…'}.${warning ? ` ${warning}.` : ''} View breakdown by vertical.`}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className="group cursor-pointer border-b border-line px-4 py-3.5 outline-none transition-colors last:border-b-0 hover:bg-paper focus-visible:bg-paper focus-visible:ring-2 focus-visible:ring-marigold focus-visible:ring-inset lg:flex-1 lg:border-b-0 lg:px-5 lg:py-4"
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_TONE[tone]}`} aria-hidden />
        {label}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="font-mono text-[28px] font-bold leading-none tabular-nums text-ink lg:text-[32px]">
          {loading ? <span className="inline-block h-7 w-12 animate-pulse rounded-[2px] bg-line/60" aria-hidden /> : value}
        </span>
        {warning && (
          <span className="rounded-[2px] bg-marigold-soft px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-marigold" title={warning}>
            ⚠ Partial
          </span>
        )}
      </div>
      {sub && <div className="mt-1.5 text-xs leading-snug text-slate-mid">{sub}</div>}
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-marigold opacity-0 transition-opacity group-hover:opacity-100">
        View by vertical →
      </div>
    </div>
  );
}

export function KpiSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">{title}</h2>
      <div className="grid grid-cols-2 border border-line bg-panel lg:flex lg:divide-x lg:divide-line">
        {children}
      </div>
    </section>
  );
}
