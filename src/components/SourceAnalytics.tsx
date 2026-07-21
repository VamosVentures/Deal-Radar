import { useEffect, useState } from 'react';
import { api, type SourceAnalytics as SourceAnalyticsRow } from '../lib/api';
import { SourceStateBadge } from './ui';

/**
 * Source-quality analytics — operational, not decorative. Every
 * number here comes straight from persisted source_runs/
 * source_run_results and company/scoring records (see
 * server/services/sourceAnalytics.ts); nothing is estimated. A source
 * that has never been selected in any run shows zeros throughout,
 * which is the honest answer, not a loading state.
 */
export function SourceAnalyticsPanel() {
  const [rows, setRows] = useState<SourceAnalyticsRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.admin.sourceAnalytics().then((r) => setRows(r.sources)).catch((e) => setErr((e as Error).message));
  }, []);

  return (
    <section className="mt-6 border border-line bg-panel p-4">
      <h2 className="font-display text-base font-semibold text-ink">Source quality</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Computed from persisted sourcing-run history — never fabricated. A source with all zeros has simply
        never been selected in a run yet.
      </p>
      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
      {rows && (
        <div className="mt-3 overflow-x-auto border border-line">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-ink text-white">
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Source</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">State</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Runs</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Success</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Failed</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Skipped</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Failure rate</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Avg response</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Results</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Imported</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Approved/Synced</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Avg fit score</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Last success</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Last failure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sourceId} className="border-b border-line transition-colors hover:bg-paper/60">
                  <td className="px-2 py-1.5 font-medium text-ink">{r.name}</td>
                  <td className="px-2 py-1.5">
                    <SourceStateBadge state={r.state} />
                  </td>
                  <td className="px-2 py-1.5">{r.totalAppearances}</td>
                  <td className="px-2 py-1.5">{r.successfulRuns}</td>
                  <td className="px-2 py-1.5">{r.failedRuns}</td>
                  <td className="px-2 py-1.5">{r.skippedRuns}</td>
                  <td className="px-2 py-1.5">{r.failureRate === null ? '—' : `${Math.round(r.failureRate * 100)}%`}</td>
                  <td className="px-2 py-1.5">{r.avgResponseTimeMs === null ? '—' : `${r.avgResponseTimeMs}ms`}</td>
                  <td className="px-2 py-1.5">{r.resultsRetrieved}</td>
                  <td className="px-2 py-1.5">{r.companiesImported}</td>
                  <td className="px-2 py-1.5">{r.companiesApprovedOrSynced}</td>
                  <td className="px-2 py-1.5">{r.avgFitScoreOfImported === null ? '—' : r.avgFitScoreOfImported.toFixed(1)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.mostRecentSuccessfulRunAt ? r.mostRecentSuccessfulRunAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.mostRecentFailedRunAt ? r.mostRecentFailedRunAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
