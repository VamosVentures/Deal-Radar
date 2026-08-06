import { useEffect, useState } from 'react';
import { api, type SourceHealth as SourceHealthRow } from '../lib/api';
import { SourceHealthBadge } from './ui';

/**
 * Source-health view: one combined status per intended source (enabled/
 * disabled/healthy/degraded/failed/blocked), last attempted/successful
 * sync, records returned, and a recent error summary — computed from
 * server/services/sourceHealth.ts, itself built entirely from persisted
 * run history. Never renders a token, credential, or stack trace: the
 * error summary is the same descriptive detail string already written
 * to source_run_results by the adapters (e.g. "HTTP 429"), nothing more.
 */
export function SourceHealthPanel() {
  const [rows, setRows] = useState<SourceHealthRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.admin.sourceHealth().then((r) => setRows(r.sources)).catch((e) => setErr((e as Error).message));
  }, []);

  return (
    <section className="mt-6 border border-line bg-panel p-4">
      <h2 className="font-display text-base font-semibold text-ink">Source health</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Every intended source, its current health, and what — if anything — is blocking it. Computed from
        persisted run history; nothing here is estimated or pre-populated.
      </p>
      {err && <p className="mt-2 text-xs text-alerta">Source health unavailable: {err}</p>}
      {!err && !rows && <p className="mt-2 text-xs text-slate-mid" role="status" aria-live="polite">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-2 text-xs text-slate-mid">No sources are configured.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto border border-line">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead>
              <tr className="border-b border-line bg-ink text-white">
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Source</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Health</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Auth/config</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Last attempted</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Last successful</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Records (latest)</th>
                <th className="px-2 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Recent error / note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sourceId} className="border-b border-line align-top transition-colors hover:bg-paper/60">
                  <td className="px-2 py-1.5 font-medium text-ink">{r.name}</td>
                  <td className="px-2 py-1.5"><SourceHealthBadge health={r.health} /></td>
                  <td className="px-2 py-1.5">{r.authOrConfigMissing ? <span className="text-marigold">Missing</span> : <span className="text-verde">OK</span>}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.lastAttemptedSyncAt ? r.lastAttemptedSyncAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.lastSuccessfulSyncAt ? r.lastSuccessfulSyncAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                  <td className="px-2 py-1.5">{r.recordsInLatestRun ?? '—'}</td>
                  <td className="px-2 py-1.5 max-w-xs text-slate-mid">{r.recentErrorSummary ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
