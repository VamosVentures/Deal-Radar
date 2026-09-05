import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { DEMO_MODE } from '../lib/demoMode';
import type { DiscoveryQuery, ScheduledJob } from '../../shared/discovery';
import { GEOGRAPHIES, PREFERRED_STATES_P4 } from '../../shared/discovery';
import { VERTICAL_OPTIONS } from '../data/taxonomy';

const STAGES = ['Pre-seed', 'Seed', 'Series A'] as const;

/**
 * Server-side scheduled sourcing (Settings — Admin Only). This does
 * NOT depend on an open browser tab: configuration is stored and, when
 * RUN_SCHEDULER=true on a persistently-hosted backend, an hourly
 * due-check executes jobs on cadence with no client involved. Runs
 * reuse the exact same discovery pipeline and guardrails as a manual
 * search — results always wait in the candidate preview for a human;
 * nothing here contacts founders, sends email, or changes HubSpot.
 */
export function SchedulePanel() {
  const [state, setState] = useState<{ active: boolean; label: string; jobs: ScheduledJob[] } | null>(null);
  const [sources, setSources] = useState<{ id: string; name: string; state: 'live' | 'credentials-required' | 'planned' | 'unavailable' }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  // New-job form state.
  const [cadence, setCadence] = useState<'weekly' | 'biweekly'>('weekly');
  const [jobType, setJobType] = useState<ScheduledJob['jobType']>('incremental-sourcing');
  const [picked, setPicked] = useState<string[]>(['yc', 'github', 'funding-news']);
  const [vertical, setVertical] = useState<DiscoveryQuery['vertical']>(null);
  const [stages, setStages] = useState<string[]>([...STAGES]);
  const [geography, setGeography] = useState<(typeof GEOGRAPHIES)[number]>('United States');
  const [terms, setTerms] = useState('');
  const [maxResults, setMaxResults] = useState(25);
  const [evidenceRecencyDays, setEvidenceRecencyDays] = useState<number | ''>('');
  const [refreshAgeDays, setRefreshAgeDays] = useState(30);

  const load = useCallback(() => {
    api.schedule.get().then(setState).catch((e) => setErr((e as Error).message));
    api.discovery.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
  }, []);
  useEffect(load, [load]);

  const query = useMemo<Partial<DiscoveryQuery>>(() => ({
    vertical,
    subcategory: null,
    areasOfInterest: [],
    terms: terms.split(',').map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 10),
    geography,
    states: geography === 'Preferred states' ? [...PREFERRED_STATES_P4] : [],
    stages: stages as DiscoveryQuery['stages'],
    sources: picked as DiscoveryQuery['sources'],
    maxResults,
    maxApiCalls: Math.min(30, Math.max(5, picked.length * 4)),
    minEvidenceRecencyDays: evidenceRecencyDays === '' ? null : evidenceRecencyDays,
    staleAfterDays: refreshAgeDays,
    // Biweekly full sourcing ignores new-only; weekly incremental keeps it; stale-refresh targets known companies overdue for a look.
    mode: jobType === 'full-sourcing' ? 'all' : jobType === 'stale-refresh' ? 'stale-only' : 'new-only',
  }), [vertical, terms, geography, stages, picked, maxResults, evidenceRecencyDays, refreshAgeDays, jobType]);

  const add = async () => {
    setErr(null);
    if (picked.length === 0) { setErr('Pick at least one source.'); return; }
    try {
      await api.schedule.save({ cadence, jobType, query: query as DiscoveryQuery, enabled: true });
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const runNow = async (id: string) => {
    setRunningId(id);
    setRunNote(null);
    try {
      const run = await api.schedule.runNow(id, 'admin');
      setRunNote(`Run ${run.id}: ${run.status} — ${run.discovered} discovered, ${run.duplicatesIdentified} duplicates identified, ${run.errors.length} error(s).`);
      load();
    } catch (e) {
      setRunNote(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setRunningId(null);
    }
  };

  const toggleSource = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleStage = (s: string) =>
    setStages((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));

  const input = 'rounded-[2px] border border-line bg-panel px-2 py-1';

  return (
    <section className="mb-4 border border-line bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Scheduled sourcing</h2>
        {state && (
          <span className={`rounded-[2px] px-2 py-0.5 font-mono text-[10px] font-semibold ${state.active ? 'bg-verde-soft text-verde' : 'bg-paper text-slate-mid'}`}>
            {state.active ? 'Active' : 'Configured but inactive'}
          </span>
        )}
      </div>
      {state && <p className="mt-1 text-[11px] text-slate-mid">{state.label} Runs happen server-side — no browser tab needs to stay open.</p>}
      <p className="text-[11px] text-slate-mid">
        Scheduled runs use the same pipeline, budgets, and guardrails as a manual run and cannot overlap another
        run in progress. Every run — scheduled or manual — auto-imports its new, non-duplicate candidates to
        Awaiting Review rather than leaving them in the candidate preview; they still never contact founders,
        send email, approve/reject deals, or change HubSpot stages.
      </p>

      <div className="mt-3 grid gap-2 rounded-[2px] border border-line bg-paper p-3 text-xs">
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Frequency</span>
            <select className={input} value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Job type</span>
            <select className={input} value={jobType} onChange={(e) => setJobType(e.target.value as ScheduledJob['jobType'])}>
              <option value="incremental-sourcing">Incremental sourcing (new records)</option>
              <option value="full-sourcing">Full sourcing</option>
              <option value="stale-refresh">Stale-record refresh</option>
              <option value="source-refresh">Selected-source refresh</option>
              <option value="vertical-refresh">Selected-vertical refresh</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Vertical focus</span>
            <select className={input} value={vertical ?? ''} onChange={(e) => setVertical((e.target.value || null) as DiscoveryQuery['vertical'])}>
              <option value="">Any vertical</option>
              {VERTICAL_OPTIONS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Geography</span>
            <select className={input} value={geography} onChange={(e) => setGeography(e.target.value as typeof geography)}>
              {GEOGRAPHIES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Keywords</span>
            <input className={input} placeholder="comma-separated" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Maximum results</span>
            <input type="number" min={1} max={200} className={input} value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))} />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Evidence-recency threshold (days, blank = no filter)</span>
            <input type="number" min={1} max={3650} className={input} placeholder="e.g. 90" value={evidenceRecencyDays}
              onChange={(e) => setEvidenceRecencyDays(e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase text-slate-mid">Refresh age — used by stale-record refresh (days)</span>
            <input type="number" min={1} max={365} className={input} value={refreshAgeDays} onChange={(e) => setRefreshAgeDays(Number(e.target.value))} />
          </label>
        </div>

        <div>
          <span className="mb-1 block font-mono text-[10px] uppercase text-slate-mid">Enabled sources</span>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => {
              const disabled = s.state === 'planned' || s.state === 'unavailable';
              return (
                <label
                  key={s.id}
                  className={`rounded-[2px] border px-1.5 py-0.5 ${disabled ? 'cursor-not-allowed opacity-50 border-line text-slate-mid' : 'cursor-pointer'} ${!disabled && picked.includes(s.id) ? 'border-verde bg-verde-soft text-verde' : !disabled ? 'border-line text-slate-mid' : ''}`}
                  title={
                    s.state === 'credentials-required' ? 'Credentials required — this source will be skipped until configured.'
                    : s.state === 'planned' ? 'Planned — no adapter built yet.'
                    : s.state === 'unavailable' ? 'Unavailable — not a discovery source.'
                    : undefined
                  }
                >
                  <input type="checkbox" className="mr-1 align-middle" disabled={disabled} checked={picked.includes(s.id)} onChange={() => toggleSource(s.id)} />
                  {s.name}{s.state === 'credentials-required' ? ' (credentials required)' : ''}
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <span className="mb-1 block font-mono text-[10px] uppercase text-slate-mid">Stage focus</span>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <label key={s} className={`cursor-pointer rounded-[2px] border px-1.5 py-0.5 ${stages.includes(s) ? 'border-verde bg-verde-soft text-verde' : 'border-line text-slate-mid'}`}>
                <input type="checkbox" className="mr-1 align-middle" checked={stages.includes(s)} onChange={() => toggleStage(s)} />
                {s}
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={add}
          disabled={DEMO_MODE}
          title={DEMO_MODE ? 'Disabled in demo — scheduled sourcing cannot be configured from this build.' : undefined}
          className="mt-1 w-fit rounded-[2px] border border-line bg-panel px-3 py-1.5 font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
        >
          {DEMO_MODE ? 'Disabled in demo' : 'Save schedule'}
        </button>
      </div>
      {err && <p className="mt-1 text-xs text-alerta">{err}</p>}
      {runNote && <p className="mt-1 text-xs text-slate-mid">{runNote}</p>}

      {state && state.jobs.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {state.jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-[2px] border border-line px-2 py-1">
              <span className="font-mono text-[10px] uppercase text-slate-mid">{j.cadence}</span>
              <span className="font-semibold">{j.jobType}</span>
              <span className="text-slate-mid">
                sources: {j.query?.sources.join(', ') ?? '—'} · last run: {j.lastRunAt ? j.lastRunAt.slice(0, 16).replace('T', ' ') : state.active ? 'pending' : 'will not run (inactive)'}
              </span>
              <button
                onClick={() => runNow(j.id)}
                disabled={runningId === j.id || DEMO_MODE}
                className="ml-auto rounded-[2px] border border-marigold px-2 py-0.5 font-mono text-[10px] font-semibold text-marigold hover:bg-marigold-soft disabled:opacity-40"
                title={DEMO_MODE ? 'Sourcing runs are disabled in this demo.' : "Administrator-only: run this schedule's search immediately, outside its normal cadence."}
              >
                {DEMO_MODE ? 'Disabled in demo' : runningId === j.id ? 'Running…' : 'Run sourcing now'}
              </button>
              <button
                onClick={async () => { await api.schedule.remove(j.id); load(); }}
                disabled={DEMO_MODE}
                title={DEMO_MODE ? 'Disabled in demo.' : undefined}
                className="text-alerta underline decoration-dotted disabled:opacity-40 disabled:no-underline"
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
