import { useEffect, useState } from 'react';
import { api, type SourceAnalytics as SourceAnalyticsRow } from '../lib/api';

const STATE_LABEL: Record<string, string> = {
  live: 'Live', 'credentials-required': 'Credentials required', planned: 'Planned', unavailable: 'Unavailable',
};
const STATE_CLASS: Record<string, string> = {
  live: 'bg-verde-soft text-verde', 'credentials-required': 'bg-marigold-soft text-marigold',
  planned: 'bg-paper text-slate-mid', unavailable: 'bg-paper text-slate-mid',
};

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
    <section className="mt-6 rounded-md border border-line bg-panel p-4">
      <h2 className="font-display text-sm font-bold">Source quality</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Computed from persisted sourcing-run history — never fabricated. A source with all zeros has simply
        never been selected in a run yet.
      </p>
      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
      {rows && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className="border-b border-line font-mono uppercase tracking-wider text-slate-mid">
                <th className="px-2 py-1.5">Source</th>
                <th className="px-2 py-1.5">State</th>
                <th className="px-2 py-1.5">Runs</th>
                <th className="px-2 py-1.5">Success</th>
                <th className="px-2 py-1.5">Failed</th>
                <th className="px-2 py-1.5">Skipped</th>
                <th className="px-2 py-1.5">Failure rate</th>
                <th className="px-2 py-1.5">Avg response</th>
                <th className="px-2 py-1.5">Results</th>
                <th className="px-2 py-1.5">Imported</th>
                <th className="px-2 py-1.5">Approved/Synced</th>
                <th className="px-2 py-1.5">Avg fit score</th>
                <th className="px-2 py-1.5">Last success</th>
                <th className="px-2 py-1.5">Last failure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sourceId} className="border-b border-line">
                  <td className="px-2 py-1.5 font-medium">{r.name}</td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${STATE_CLASS[r.state]}`}>{STATE_LABEL[r.state]}</span>
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
