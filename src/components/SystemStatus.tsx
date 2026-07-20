import { useEffect, useState } from 'react';
import { api, ApiError, type AdminStatus } from '../lib/api';
import { ErrorNote } from './Modal';

/**
 * Settings — Admin Only: the system panel. Every "Connected" here
 * reflects a real health check that succeeded on the server;
 * credentials appear only as present/absent booleans.
 */
export function SystemStatus() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () => {
    api.admin.status().then((s) => { setStatus(s); setError(null); }).catch((e) => setError(e as ApiError));
  };
  useEffect(load, []);

  if (error) {
    return (
      <section className="mt-6">
        <h2 className="mb-2 font-display text-base font-bold">System status</h2>
        <ErrorNote message={error.message} hint={error.hint} />
      </section>
    );
  }
  if (!status) return <p className="mt-6 text-sm text-slate-mid">Running health checks…</p>;

  const tone = (s: string) =>
    s === 'Connected' ? 'bg-verde-soft text-verde'
    : s === 'Error' ? 'bg-alerta-soft text-alerta'
    : 'bg-marigold-soft text-marigold';

  const s = status.sourcing;
  const fmt = (at?: string | null) => (at ? at.slice(0, 16).replace('T', ' ') : '—');

  return (
    <section className="mt-6">
      <h2 className="mb-2 font-display text-base font-bold">System status</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-line bg-panel p-4 text-xs">
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Connectors — Connected only after a real health check</h3>
          <div className="space-y-1.5">
            <Row label="Database" badge={status.database.ok ? 'Connected' : 'Error'} tone={tone(status.database.ok ? 'Connected' : 'Error')}
              detail={`${status.database.engine} at ${status.database.location} — ${status.database.companies} active compan${status.database.companies === 1 ? 'y' : 'ies'}, schema v${status.database.migrationVersion}`} />
            {(['github', 'hubspot', 'outlook', 'ai'] as const).map((k) => (
              <Row key={k} label={k === 'ai' ? 'AI provider' : k === 'github' ? 'GitHub' : k[0].toUpperCase() + k.slice(1)}
                badge={status.connectors[k].status} tone={tone(status.connectors[k].status)} detail={status.connectors[k].detail} />
            ))}
          </div>
          <h3 className="mb-1.5 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Credential presence (values never leave the server)</h3>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(status.credentials).map(([k, present]) => (
              <span key={k} className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${present ? 'bg-verde-soft text-verde' : 'bg-paper text-slate-mid'}`}>
                {k} {present ? '✓ set' : '— not set'}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-line bg-panel p-4 text-xs">
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Sourcing runs (persisted history)</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-slate-mid">Last run</span><span>{s.lastRun ? `${fmt(s.lastRun.at)} — ${s.lastRun.status} (by ${s.lastRun.initiatedBy})` : 'No run yet'}</span>
            <span className="text-slate-mid">Last successful run</span><span>{s.lastSuccessfulRun ? `${fmt(s.lastSuccessfulRun.at)} — ${s.lastSuccessfulRun.status}` : 'None yet'}</span>
            <span className="text-slate-mid">Last failed run</span><span>{s.lastFailedRun ? `${fmt(s.lastFailedRun.at)} — ${s.lastFailedRun.status}` : 'None'}</span>
            <span className="text-slate-mid">Records retrieved</span><span>{s.recordsRetrieved}</span>
            <span className="text-slate-mid">Records created</span><span>{s.recordsCreated}</span>
            <span className="text-slate-mid">Records updated</span><span>{s.recordsUpdated}</span>
            <span className="text-slate-mid">Rate-limit status</span>
            <span>{s.rateLimited.length === 0 ? 'No sources currently rate limited' : `Rate limited recently: ${s.rateLimited.join(', ')}`}</span>
          </div>
          <h3 className="mb-1 mt-3 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Source errors (latest run)</h3>
          {s.recentErrors.length === 0 ? (
            <p className="text-slate-mid">No errors recorded on the latest run.</p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4 text-slate-mid">
              {s.recentErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}

          <h3 className="mb-1 mt-3 font-mono text-[11px] uppercase tracking-widest text-slate-mid">HubSpot failed synchronizations</h3>
          {status.hubspotFailedSyncs.length === 0 ? (
            <p className="text-slate-mid">No failed synchronizations awaiting retry.</p>
          ) : (
            <ul className="space-y-1">
              {status.hubspotFailedSyncs.map((f) => (
                <li key={f.companyId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={f.detail}>{f.companyId} — {f.detail}</span>
                  <button
                    className="rounded-sm border border-line px-2 py-0.5 font-mono text-[10px] font-semibold hover:border-marigold hover:text-marigold disabled:opacity-40"
                    disabled={retrying === f.companyId}
                    onClick={async () => {
                      setRetrying(f.companyId);
                      setNote(null);
                      try {
                        const res = await api.hubspot.retrySync(f.companyId);
                        setNote(`Retry for ${f.companyId}: ${res.message}`);
                        load();
                      } catch (e) {
                        setNote(`Retry for ${f.companyId} failed again: ${(e as Error).message}`);
                      } finally {
                        setRetrying(null);
                      }
                    }}
                  >
                    {retrying === f.companyId ? 'Retrying…' : 'Retry'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {note && <p className="mt-1.5 text-[11px] text-slate-mid">{note}</p>}
        </div>
      </div>
    </section>
  );
}

function Row({ label, badge, tone, detail }: { label: string; badge: string; tone: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 pt-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-mid">{label}</span>
      <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${tone}`}>{badge}</span>
      <span className="min-w-0 text-slate-mid">{detail}</span>
    </div>
  );
}
