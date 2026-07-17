import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { DiscoveryQuery, ScheduledJob } from '../../shared/discovery';

/**
 * Weekly/biweekly sourcing schedules. Configuration is always stored;
 * execution happens ONLY when the backend runs with RUN_SCHEDULER=true
 * on persistent hosting. The active/inactive label comes from the
 * backend, so the UI can never pretend jobs will run when they won't.
 */
export function SchedulePanel({ currentQuery }: { currentQuery: Partial<DiscoveryQuery> }) {
  const [state, setState] = useState<{ active: boolean; label: string; jobs: ScheduledJob[] } | null>(null);
  const [cadence, setCadence] = useState<'weekly' | 'biweekly'>('weekly');
  const [jobType, setJobType] = useState<ScheduledJob['jobType']>('incremental-sourcing');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.schedule.get().then(setState).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setErr(null);
    try {
      await api.schedule.save({
        cadence,
        jobType,
        query: {
          ...currentQuery,
          // biweekly full sourcing ignores new-only; weekly incremental keeps it
          mode: jobType === 'full-sourcing' ? 'all' : jobType === 'stale-refresh' ? 'stale-only' : 'new-only',
        } as DiscoveryQuery,
        enabled: true,
      });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="mb-4 rounded-sm border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-ink">Scheduled sourcing</h2>
        {state && (
          <span className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold ${state.active ? 'bg-verde-soft text-verde' : 'bg-paper text-slate-mid'}`}>
            {state.active ? 'Active' : 'Configured but inactive'}
          </span>
        )}
      </div>
      {state && <p className="mt-1 text-[11px] text-slate-mid">{state.label}</p>}
      <p className="text-[11px] text-slate-mid">
        Scheduled runs use the same pipeline, budgets, and guardrails as manual runs: results wait in the candidate preview for human review. They never contact founders, send email, approve/reject deals, or change HubSpot stages.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select className="rounded-sm border border-line bg-panel px-2 py-1" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Biweekly</option>
        </select>
        <select className="rounded-sm border border-line bg-panel px-2 py-1" value={jobType} onChange={(e) => setJobType(e.target.value as ScheduledJob['jobType'])}>
          <option value="incremental-sourcing">Incremental sourcing (new records)</option>
          <option value="full-sourcing">Full sourcing</option>
          <option value="stale-refresh">Stale-record refresh</option>
          <option value="source-refresh">Selected-source refresh</option>
          <option value="vertical-refresh">Selected-vertical refresh</option>
        </select>
        <button onClick={add} className="rounded-sm border border-line px-2 py-1 font-semibold">
          Save schedule (uses the search configured above)
        </button>
      </div>
      {err && <p className="mt-1 text-xs text-alerta">{err}</p>}

      {state && state.jobs.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {state.jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-sm border border-line px-2 py-1">
              <span className="font-mono text-[10px] uppercase text-slate-mid">{j.cadence}</span>
              <span className="font-semibold">{j.jobType}</span>
              <span className="text-slate-mid">
                sources: {j.query?.sources.join(', ') ?? '—'} · last run: {j.lastRunAt ? j.lastRunAt.slice(0, 16).replace('T', ' ') : state.active ? 'pending' : 'will not run (inactive)'}
              </span>
              <button
                onClick={async () => { await api.schedule.remove(j.id); load(); }}
                className="ml-auto text-alerta underline decoration-dotted"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
