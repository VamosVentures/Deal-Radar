import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useCompanies } from '../store/companies';
import type { DiscoveryCandidate, DiscoveryQuery, DiscoveryRun } from '../../shared/discovery';
import { GEOGRAPHIES, PREFERRED_STATES_P4 } from '../../shared/discovery';

const VERTICALS = [
  { id: '', name: 'Any vertical' },
  { id: 'health', name: 'Health & Wellness' },
  { id: 'fintech', name: 'FinTech' },
  { id: 'fow', name: 'Future of Work' },
  { id: 'sustainability', name: 'Sustainability' },
  { id: 'aoi', name: 'Other Industries' },
] as const;

const STAGES = ['Pre-seed', 'Seed', 'Series A'] as const;

const statusChip: Record<string, string> = {
  Completed: 'bg-verde-soft text-verde',
  'Completed with warnings': 'bg-amber-100 text-amber-800',
  Simulated: 'bg-slate-100 text-slate-600',
  Cancelled: 'bg-slate-200 text-slate-700',
  Failed: 'bg-red-100 text-red-700',
  'Configured but inactive': 'bg-slate-100 text-slate-500',
};

const modeChip: Record<string, string> = {
  live: 'bg-verde-soft text-verde',
  simulated: 'bg-slate-100 text-slate-600',
  local: 'bg-slate-100 text-slate-600',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-amber-50 text-amber-700',
  mixed: 'bg-indigo-50 text-indigo-700',
};

export function Discovery() {
  const { refresh: refreshCompanies } = useCompanies();
  const [sources, setSources] = useState<{ id: string; name: string; state: 'live' | 'credentials-required' | 'planned' | 'unavailable'; needs: string }[]>([]);
  const [picked, setPicked] = useState<string[]>(['yc', 'github', 'funding-news', 'grants', 'research']);
  const [vertical, setVertical] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [terms, setTerms] = useState('');
  const [geography, setGeography] = useState<(typeof GEOGRAPHIES)[number]>('United States');
  const [states, setStates] = useState<string[]>([]);
  const [stages, setStages] = useState<string[]>([...STAGES]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [maxResults, setMaxResults] = useState(25);
  const [maxApiCalls, setMaxApiCalls] = useState(10);
  const [maxModelCalls, setMaxModelCalls] = useState(0);
  const [maxTokens, setMaxTokens] = useState(20000);
  const [minConfidence, setMinConfidence] = useState(0);
  const [mode, setMode] = useState<'new-only' | 'stale-only' | 'all'>('new-only');

  const [estimate, setEstimate] = useState<{ estimatedTokens: number; estimatedCostUsd: number; note: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<DiscoveryRun | null>(null);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dupAction, setDupAction] = useState<'skip' | 'merge-evidence' | 'import-anyway'>('skip');
  const [drawer, setDrawer] = useState<DiscoveryCandidate | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo<Partial<DiscoveryQuery>>(() => ({
    vertical: (vertical || null) as DiscoveryQuery['vertical'],
    subcategory: subcategory || null,
    areasOfInterest: [],
    terms: terms.split(',').map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 10),
    geography,
    states,
    stages: stages as DiscoveryQuery['stages'],
    sources: picked as DiscoveryQuery['sources'],
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    maxResults, maxApiCalls, maxModelCalls,
    maxEstimatedTokens: maxTokens,
    minConfidence,
    mode,
  }), [vertical, subcategory, terms, geography, states, stages, picked, dateFrom, dateTo, maxResults, maxApiCalls, maxModelCalls, maxTokens, minConfidence, mode]);

  const loadLists = useCallback(async () => {
    const [c, r] = await Promise.all([api.discovery.candidates({ status: 'pending' }), api.discovery.runs()]);
    setCandidates(c.candidates);
    setRuns(r.runs);
  }, []);

  useEffect(() => {
    api.discovery.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (picked.length === 0) { setEstimate(null); return; }
    const t = setTimeout(() => {
      api.discovery.estimate(query).then(setEstimate).catch(() => setEstimate(null));
    }, 300);
    return () => clearTimeout(t);
  }, [query, picked.length]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setImportMsg(null);
    try {
      const r = await api.discovery.run(query, 'team');
      setLastRun(r);
      await loadLists();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    try { await api.discovery.cancel(); } catch { /* surfaced via run result */ }
  };

  const doImport = async () => {
    if (selected.size === 0) return;
    setImportMsg(null);
    try {
      const out = await api.discovery.import([...selected], 'team', dupAction);
      const skippedNote = out.skipped.length > 0 ? ` Skipped: ${out.skipped.map((s) => s.reason).join(' ')}` : '';
      setImportMsg(`${out.imported.length} imported into Awaiting Review, ${out.merged.length} merged as evidence.${skippedNote} Nothing was approved, synced, or contacted automatically.`);
      setSelected(new Set());
      await Promise.all([loadLists(), refreshCompanies()]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const input = 'w-full rounded-sm border border-slate-300 px-2 py-1.5 text-sm';
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500';

  return (
    <div>
      <PageHeader
        eyebrow="Sourcing"
        title="Deal Discovery"
        blurb="Search authorized public sources only — YC, GitHub, SEC, grants, accelerators, funding news, uploads, and licensed exports. LinkedIn, PitchBook, and Crunchbase are never scraped. Every candidate keeps its evidence trail, unknowns stay Unknown, and imports always land in Awaiting Review for a human."
      />

      {/* ── Search configuration ── */}
      <section className="mb-4 rounded-sm border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-800">Search configuration</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className={label}>Vertical</label>
            <select className={input} value={vertical} onChange={(e) => setVertical(e.target.value)}>
              {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Subcategory</label>
            <input className={input} value={subcategory} onChange={(e) => setSubcategory(e.target.value)} placeholder="e.g. Personalized care" />
          </div>
          <div className="md:col-span-2">
            <label className={label}>Search terms (comma-separated)</label>
            <input className={input} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="bilingual telehealth, care navigation" />
          </div>
          <div>
            <label className={label}>Geography</label>
            <select className={input} value={geography} onChange={(e) => { setGeography(e.target.value as typeof geography); setStates([]); }}>
              {GEOGRAPHIES.map((g) => <option key={g}>{g}</option>)}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className={label}>States (optional narrowing)</label>
            <div className="flex flex-wrap gap-1 pt-1">
              {PREFERRED_STATES_P4.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStates((s) => (s.includes(st) ? s.filter((x) => x !== st) : [...s, st]))}
                  className={`rounded-sm border px-2 py-0.5 text-xs ${states.includes(st) ? 'border-verde bg-verde-soft text-verde' : 'border-slate-300 text-slate-600'}`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={label}>Stages</label>
            <div className="flex flex-wrap gap-1 pt-1">
              {STAGES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStages((s) => (s.includes(st) ? s.filter((x) => x !== st) : [...s, st]))}
                  className={`rounded-sm border px-2 py-0.5 text-xs ${stages.includes(st) ? 'border-verde bg-verde-soft text-verde' : 'border-slate-300 text-slate-600'}`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={label}>Date from</label>
            <input type="date" className={input} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className={label}>Date to</label>
            <input type="date" className={input} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div>
            <label className={label}>Record mode</label>
            <select className={input} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="new-only">New records only</option>
              <option value="stale-only">Stale records only</option>
              <option value="all">All (include known duplicates)</option>
            </select>
          </div>
          <div>
            <label className={label}>Min confidence ({minConfidence.toFixed(1)})</label>
            <input type="range" min={0} max={1} step={0.1} className="w-full" value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} />
          </div>
        </div>

        {/* Budgets */}
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ['Max results', maxResults, setMaxResults, 200],
            ['Max API calls', maxApiCalls, setMaxApiCalls, 100],
            ['Max model calls', maxModelCalls, setMaxModelCalls, 50],
            ['Max estimated tokens', maxTokens, setMaxTokens, 500000],
          ].map(([lbl, val, set, max]) => (
            <div key={lbl as string}>
              <label className={label}>{lbl as string}</label>
              <input
                type="number" min={lbl === 'Max model calls' || lbl === 'Max estimated tokens' ? 0 : 1} max={max as number} className={input}
                value={val as number}
                onChange={(e) => (set as (n: number) => void)(Number(e.target.value))}
              />
            </div>
          ))}
        </div>

        {/* Sources */}
        <div className="mt-3">
          <label className={label}>Sources (authorized only)</label>
          <div className="grid gap-1 md:grid-cols-2">
            {sources.map((s) => {
              const disabled = s.state === 'planned' || s.state === 'unavailable';
              return (
                <label key={s.id} className={`flex items-start gap-2 rounded-sm border border-slate-100 px-2 py-1 text-sm ${disabled ? 'opacity-60' : ''}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={disabled}
                    checked={picked.includes(s.id)}
                    onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                  />
                  <span>
                    <span className="font-medium text-slate-800">{s.name}</span>
                    {s.state === 'live' && <span className="ml-1 rounded-sm bg-verde-soft px-1 text-[10px] text-verde">live</span>}
                    {s.state === 'credentials-required' && <span className="ml-1 rounded-sm bg-marigold-soft px-1 text-[10px] text-marigold">credentials required — will be skipped</span>}
                    {s.state === 'planned' && <span className="ml-1 rounded-sm bg-slate-100 px-1 text-[10px] text-slate-500">planned — no adapter yet</span>}
                    {s.state === 'unavailable' && <span className="ml-1 rounded-sm bg-slate-100 px-1 text-[10px] text-slate-500">unavailable</span>}
                    <span className="block text-[11px] text-slate-500">{s.needs}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Estimate + run */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <div className="text-sm text-slate-600">
            {estimate
              ? <>Estimated ≤ {estimate.estimatedTokens.toLocaleString()} tokens ≈ ${estimate.estimatedCostUsd.toFixed(4)} <span className="text-[11px] text-slate-400">({estimate.note})</span></>
              : 'Select at least one source to estimate cost.'}
          </div>
          <div className="ml-auto flex gap-2">
            {running && (
              <button onClick={cancel} className="rounded-sm border border-slate-300 px-3 py-1.5 text-sm text-slate-700">
                Cancel run
              </button>
            )}
            <button
              onClick={run}
              disabled={running || picked.length === 0}
              className="rounded-sm bg-verde px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {running ? 'Running sources…' : 'Run discovery'}
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      </section>

      {/* ── Last run summary ── */}
      {lastRun && (
        <section className="mb-4 rounded-sm border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${statusChip[lastRun.status]}`}>{lastRun.status}</span>
            <span className={`rounded-sm px-2 py-0.5 text-xs ${modeChip[lastRun.mode]}`}>{lastRun.mode}</span>
            <span className="text-slate-700">
              {lastRun.discovered} discovered · {lastRun.duplicatesSkipped} duplicates skipped · {lastRun.rejectedByValidation} rejected by validation · {lastRun.apiCalls} API calls · {(lastRun.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
          <ul className="mt-2 space-y-1 text-[12px] text-slate-500">
            {lastRun.sourceResults.map((r) => (
              <li key={r.sourceId}>
                <span className={`mr-1 rounded-sm px-1.5 py-0.5 text-[10px] ${modeChip[r.mode]}`}>{r.mode}</span>
                <strong>{r.sourceId}</strong>: {r.found} found — {r.detail}
              </li>
            ))}
          </ul>
          {lastRun.errors.length > 0 && (
            <p className="mt-2 text-[12px] text-amber-700">Partial failures preserved: {lastRun.errors.join(' · ')}</p>
          )}
        </section>
      )}

      {/* ── Candidate preview ── */}
      <section className="mb-4 rounded-sm border border-slate-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold text-slate-800">Candidate preview ({candidates.length} pending)</h2>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Duplicates:</label>
            <select className="rounded-sm border border-slate-300 px-2 py-1 text-sm" value={dupAction} onChange={(e) => setDupAction(e.target.value as typeof dupAction)}>
              <option value="skip">Skip duplicates</option>
              <option value="merge-evidence">Merge evidence into existing record</option>
              <option value="import-anyway">Import anyway</option>
            </select>
            <button
              onClick={doImport}
              disabled={selected.size === 0}
              className="rounded-sm bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              Import {selected.size > 0 ? `${selected.size} ` : ''}selected → Awaiting Review
            </button>
          </div>
        </div>
        {importMsg && <p className="mb-2 rounded-sm bg-verde-soft px-2 py-1 text-sm text-verde">{importMsg}</p>}
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-500">No pending candidates. Run a discovery search above — results wait here for human review before anything is imported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-2"></th>
                  <th className="py-1 pr-3">Company</th>
                  <th className="py-1 pr-3">Vertical</th>
                  <th className="py-1 pr-3">Stage</th>
                  <th className="py-1 pr-3">State</th>
                  <th className="py-1 pr-3">Confidence</th>
                  <th className="py-1 pr-3">Duplicate</th>
                  <th className="py-1 pr-3">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 align-top">
                    <td className="py-1.5 pr-2">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="font-medium text-slate-800">{c.companyName}</div>
                      <div className="text-[11px] text-slate-500">{c.pitch !== 'Unknown' ? c.pitch : '— pitch unknown —'}</div>
                      <div className="mt-0.5 flex gap-1">
                        {c.simulated && <span className="rounded-sm bg-slate-100 px-1 text-[10px] text-slate-600">simulated</span>}
                        <span className="rounded-sm bg-slate-100 px-1 text-[10px] text-slate-600">{c.sourceId}</span>
                        <span className="rounded-sm bg-amber-50 px-1 text-[10px] text-amber-700">{c.verificationStatus}</span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">{c.vertical}</td>
                    <td className="py-1.5 pr-3">{c.stage}</td>
                    <td className="py-1.5 pr-3">{c.hqState}</td>
                    <td className="py-1.5 pr-3">{(c.confidence * 100).toFixed(0)}%</td>
                    <td className="py-1.5 pr-3">
                      {c.duplicateStatus === 'none' ? <span className="text-slate-400">—</span> : (
                        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${c.duplicateStatus === 'exact' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
                          {c.duplicateStatus} · {c.duplicateOfName}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <button onClick={() => setDrawer(c)} className="text-verde underline">
                        {c.evidence.length} item{c.evidence.length === 1 ? '' : 's'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Evidence drawer + duplicate comparison ── */}
      {drawer && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setDrawer(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">{drawer.companyName} — evidence</h3>
              <button className="text-slate-400" onClick={() => setDrawer(null)}>✕</button>
            </div>
            <p className="mb-3 text-[12px] text-slate-500">Suggested next step: {drawer.suggestedNextStep}</p>
            <ul className="space-y-2">
              {drawer.evidence.map((e, i) => (
                <li key={i} className="rounded-sm border border-slate-200 p-2 text-sm">
                  <div className="text-slate-800">{e.claim}</div>
                  <div className="text-[11px] text-slate-500">
                    {e.source} · accessed {e.dateAccessed} · confidence {(e.confidence * 100).toFixed(0)}% · {e.verificationStatus}
                  </div>
                  <a href={e.url} target="_blank" rel="noreferrer" className="break-all text-[11px] text-verde underline">{e.url}</a>
                  {e.notes && <div className="text-[11px] italic text-slate-400">{e.notes}</div>}
                </li>
              ))}
            </ul>
            {drawer.duplicateStatus !== 'none' && <DuplicateComparison cand={drawer} />}
          </div>
        </div>
      )}

      {/* ── Run history ── */}
      <section className="rounded-sm border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-bold text-slate-800">Sourcing run history</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-slate-500">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Type</th>
                  <th className="py-1 pr-3">Mode</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Found</th>
                  <th className="py-1 pr-3">Dup-skip</th>
                  <th className="py-1 pr-3">Rejected</th>
                  <th className="py-1 pr-3">Imported</th>
                  <th className="py-1 pr-3">API</th>
                  <th className="py-1 pr-3">Model</th>
                  <th className="py-1 pr-3">~Tokens</th>
                  <th className="py-1 pr-3">~Cost</th>
                  <th className="py-1 pr-3">Time</th>
                  <th className="py-1 pr-3">By</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="py-1 pr-3 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                    <td className="py-1 pr-3">{r.runType}</td>
                    <td className="py-1 pr-3"><span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${modeChip[r.mode]}`}>{r.mode}</span></td>
                    <td className="py-1 pr-3"><span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold ${statusChip[r.status]}`}>{r.status}</span></td>
                    <td className="py-1 pr-3">{r.discovered}</td>
                    <td className="py-1 pr-3">{r.duplicatesSkipped}</td>
                    <td className="py-1 pr-3">{r.rejectedByValidation}</td>
                    <td className="py-1 pr-3">{r.imported}</td>
                    <td className="py-1 pr-3">{r.apiCalls}</td>
                    <td className="py-1 pr-3">{r.modelCalls}</td>
                    <td className="py-1 pr-3">{r.estimatedTokens.toLocaleString()}</td>
                    <td className="py-1 pr-3">${r.estimatedCostUsd.toFixed(4)}</td>
                    <td className="py-1 pr-3">{(r.durationMs / 1000).toFixed(1)}s</td>
                    <td className="py-1 pr-3">{r.initiatedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Side-by-side comparison against the record the candidate likely duplicates. */
function DuplicateComparison({ cand }: { cand: DiscoveryCandidate }) {
  const { companies } = useCompanies();
  const existing = companies.find((c) => c.id === cand.duplicateOfId || c.name === cand.duplicateOfName);
  return (
    <div className="mt-4 rounded-sm border border-amber-200 bg-amber-50 p-2">
      <h4 className="mb-1 text-[12px] font-bold text-amber-800">
        Possible duplicate ({cand.duplicateStatus}) of {cand.duplicateOfName}
      </h4>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-amber-700">
            <th className="pr-2"></th><th className="pr-2">Candidate</th><th>Existing record</th>
          </tr>
        </thead>
        <tbody>
          {([
            ['Name', cand.companyName, existing?.name ?? cand.duplicateOfName ?? '—'],
            ['Website', cand.website, existing?.website ?? '—'],
            ['Vertical', cand.vertical, existing?.vertical ?? '—'],
            ['Stage', cand.stage, existing?.stage ?? '—'],
            ['State', cand.hqState, existing?.state ?? '—'],
          ] as const).map(([k, a, b]) => (
            <tr key={k}>
              <td className="pr-2 font-semibold text-amber-800">{k}</td>
              <td className="pr-2">{a}</td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-amber-700">
        Choose "Merge evidence" to append this candidate's sourced evidence to the existing record (conflicts are kept side by side, never overwritten).
      </p>
    </div>
  );
}
