import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Modal, ErrorNote } from './Modal';
import { CORE_VERTICAL_IDS, verticalById } from '../data/taxonomy';
import type { VerticalBreakdown } from '../../shared/executiveKpis';

/**
 * Per-vertical breakdown for one Executive Overview KPI card. Always
 * shows every APPROVED core vertical (including zero-count ones, from
 * CORE_VERTICAL_IDS — the same single source of truth the sidebar uses)
 * plus an "Unassigned" row, and always reconciles to the headline total
 * — if it ever doesn't, that's shown as an error rather than hidden.
 * The legacy 'aoi' bucket is deliberately NOT a row here — see
 * server/services/executiveKpis.ts's header comment.
 */
export function KpiBreakdownModal({
  title,
  eyebrow,
  breakdown,
  error,
  lastUpdated,
  detail,
  periodLabel,
  periodSelector,
  partialRunNote,
  onClose,
}: {
  title: string;
  eyebrow?: string;
  breakdown: VerticalBreakdown | null;
  error?: string | null;
  lastUpdated?: string | null;
  detail?: string;
  /** The active time window, when this metric has one (e.g. Cumulative's period filter, "Discovered This Week"'s calendar week). */
  periodLabel?: string | null;
  /** Optional controls rendered above the table — currently only Cumulative's All Time / This Month / Last Month / This Year / Last Year selector. */
  periodSelector?: ReactNode;
  /** Shown as a prominent warning banner, never blended into the normal detail text — a partial run must never read as a fully successful one. */
  partialRunNote?: { completedAt: string | null; warningCount: number; affectedSources: string[] } | null;
  onClose: () => void;
}) {
  const reconciles = breakdown
    ? breakdown.total === Object.values(breakdown.byVertical).reduce((a, b) => a + b, 0) + breakdown.unassigned
    : true;

  return (
    <Modal title={title} eyebrow={eyebrow} onClose={onClose}>
      {error && <ErrorNote message="KPI breakdown unavailable." hint={error} />}
      {!error && !breakdown && (
        <div className="py-6 text-center text-sm text-slate-mid" role="status" aria-live="polite">Loading…</div>
      )}
      {!error && breakdown && (
        <div>
          {detail && <p className="mb-3 text-xs leading-relaxed text-slate-mid">{detail}</p>}
          {periodLabel && (
            <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-marigold">{periodLabel}</div>
          )}
          {periodSelector && <div className="mb-3">{periodSelector}</div>}
          {partialRunNote && (
            <div className="mb-3 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft px-3 py-2 text-xs">
              <div className="font-mono font-bold uppercase tracking-widest text-marigold">⚠ Partial run — not fully successful</div>
              <div className="mt-1 text-ink/80">
                Completed {partialRunNote.completedAt ? new Date(partialRunNote.completedAt).toLocaleString() : 'at an unknown time'} with{' '}
                {partialRunNote.warningCount} warning{partialRunNote.warningCount === 1 ? '' : 's'}
                {partialRunNote.affectedSources.length > 0 ? ` across: ${partialRunNote.affectedSources.join(', ')}` : ''}.
                The count below reflects only what this run actually completed.
              </div>
              <Link to="/sources" className="mt-1 inline-block text-verde underline decoration-dotted">
                View Source Health for details →
              </Link>
            </div>
          )}
          {breakdown.total === 0 && (
            <p className="mb-3 border border-line bg-paper px-3 py-2 text-xs text-slate-mid">
              No records match this metric{periodLabel ? ' for the selected period' : ''} right now.
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-slate-mid">
                <th className="pb-1.5 font-semibold">Vertical</th>
                <th className="pb-1.5 text-right font-semibold">Count</th>
              </tr>
            </thead>
            <tbody>
              {CORE_VERTICAL_IDS.map((id) => {
                const v = verticalById(id);
                return (
                  <tr key={v.id} className="border-b border-line/60 last:border-b-0">
                    <td className="py-1.5 text-ink">{v.name}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink">{breakdown.byVertical[v.id] ?? 0}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-line/60">
                <td className="py-1.5 text-slate-mid">Unassigned</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-slate-mid">{breakdown.unassigned}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="font-semibold text-ink">
                <td className="pt-2">Total</td>
                <td className="pt-2 text-right font-mono tabular-nums">{breakdown.total}</td>
              </tr>
            </tfoot>
          </table>
          {!reconciles && (
            <ErrorNote
              message="Breakdown does not reconcile to the headline total."
              hint="This indicates a data integrity issue — please report it rather than trusting either number."
            />
          )}
          {lastUpdated && (
            <div className="mt-3 border-t border-line pt-2 font-mono text-[10px] uppercase tracking-wider text-slate-mid">
              Last updated {new Date(lastUpdated).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
