import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ConnectorInfo, type RefreshLogEntry } from '../lib/api';
import { DEMO_MODE } from '../lib/demoMode';
import { useCompanies } from '../store/companies';
import { useIntegrations } from '../store/integrations';
import { VERTICAL_OPTIONS } from '../data/taxonomy';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';

/**
 * Refresh connectors + refresh runner. Every card is functional:
 * enable/disable, run sync, last sync, records imported, credential
 * requirements, setup instructions, and last error. Refreshes run
 * only when manually triggered — schedules are configuration only
 * (this backend has no job runner), and the log distinguishes
 * live / local / failed work per connector.
 */
export function ConnectorPanel() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [log, setLog] = useState<RefreshLogEntry[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [vertical, setVertical] = useState<string>('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [maxRecords, setMaxRecords] = useState(25);
  const { refresh: refreshStatus } = useIntegrations();
  const { refresh: refreshCompanies } = useCompanies();

  const load = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([api.refresh.connectors(), api.refresh.log()]);
      setConnectors(c.connectors);
      setLog(l.log);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(connectorIds: string[] | null) {
    setRunning(true);
    setError(null);
    try {
      await api.refresh.run({ connectorIds, vertical: vertical || null, staleOnly, maxRecords });
      await Promise.all([load(), refreshStatus(), refreshCompanies()]);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setRunning(false);
    }
  }

  if (error && connectors.length === 0) {
    return (
      <section className="mt-8">
        <h2 className="mb-2 font-display text-base font-semibold text-ink">Refresh connectors</h2>
        <ErrorNote message={error.message} hint={error.hint} />
      </section>
    );
  }

  return (
    <section className="mt-8">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Refresh connectors</h2>
        <div className="ml-auto flex gap-2">
          <button
            className={btnPrimary}
            disabled={running || DEMO_MODE}
            onClick={() => run(null)}
            title={DEMO_MODE ? 'Refresh runs are disabled in this demo build.' : undefined}
          >
            {DEMO_MODE ? 'Disabled in demo' : running ? 'Refreshing…' : 'Run refresh (all enabled)'}
          </button>
          <button
            className={btnGhost}
            disabled={!running}
            onClick={async () => { await api.refresh.cancel(); }}
            title="Stops before the next connector starts"
          >
            Cancel
          </button>
        </div>
      </div>
      <p className="mb-3 max-w-3xl text-xs text-slate-mid">
        Refreshes run only when you trigger them — there is no background scheduler in this backend, so the per-connector
        schedule below is stored as configuration only. Each run reports per-connector results as live, local, or failed —
        integrations that are not connected fail honestly; one failing connector never discards the others&rsquo; work.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-3 border border-line bg-panel px-3 py-2.5 text-xs">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase text-slate-mid">Vertical scope</span>
          <select value={vertical} onChange={(e) => setVertical(e.target.value)} className="rounded-[2px] border border-line bg-panel px-2 py-1">
            <option value="">All verticals</option>
            {VERTICAL_OPTIONS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase text-slate-mid">Max records / API calls</span>
          <input
            type="number" min={1} max={500} value={maxRecords}
            onChange={(e) => setMaxRecords(Math.max(1, Math.min(500, Number(e.target.value) || 25)))}
            className="w-24 rounded-[2px] border border-line bg-panel px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1.5 pb-1">
          <input type="checkbox" checked={staleOnly} onChange={(e) => setStaleOnly(e.target.checked)} />
          <span>Stale records only</span>
        </label>
        <span className="pb-1 font-mono text-[10px] text-slate-mid">Caps protect API rate limits and AI token budgets.</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {connectors.map((c) => (
          <ConnectorCard key={c.meta.id} c={c} running={running} onRun={() => run([c.meta.id])} onChanged={load} />
        ))}
      </div>

      {error && <div className="mt-3"><ErrorNote message={error.message} hint={error.hint} /></div>}

      <RefreshLog log={log} />
    </section>
  );
}

function ModeChip({ mode }: { mode: 'live' | 'local' | 'simulated' | 'failed' | null }) {
  if (!mode) return <span className="font-mono text-[10px] text-slate-mid">never run</span>;
  const cls =
    mode === 'live' ? 'bg-verde-soft text-verde'
    : mode === 'failed' ? 'bg-alerta-soft text-alerta'
    : 'bg-marigold-soft text-marigold';
  return <span className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${cls}`}>{mode}</span>;
}

const SCHEDULE_KEY = 'vamos-deal-radar:connector-schedules:v1';
function loadSchedules(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SCHEDULE_KEY) ?? '{}'); } catch { return {}; }
}

function ConnectorCard({ c, running, onRun, onChanged }: {
  c: ConnectorInfo;
  running: boolean;
  onRun: () => void;
  onChanged: () => Promise<void>;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [schedule, setSchedule] = useState(() => loadSchedules()[c.meta.id] ?? 'Manual');
  return (
    <div className="flex flex-col border border-line bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{c.meta.name}</h3>
        <span className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-mid">{c.meta.kind}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {!c.state.enabled && <span className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-mid">disabled</span>}
          <ModeChip mode={c.state.lastSyncMode} />
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">{c.meta.what}</p>
      <div className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-mid">
        {c.state.lastSyncAt ? <>Last sync {c.state.lastSyncAt.slice(0, 16).replace('T', ' ')} · {c.state.recordsImported} record{c.state.recordsImported === 1 ? '' : 's'}</> : 'Not synced yet'}
      </div>
      {c.state.lastError && (
        <div className="mt-1.5 rounded-[2px] border border-alerta/40 bg-alerta-soft px-2 py-1.5 text-[11px] text-alerta">{c.state.lastError}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/*
          A disabled control has to say why it is disabled. The
          "disabled" chip above and the adjacent Enable button imply the
          reason, but implying is not explaining — someone who clicks a
          greyed-out button and gets nothing has been told nothing.
        */}
        <button
          className={btnGhost}
          disabled={running || !c.state.enabled || DEMO_MODE}
          title={
            DEMO_MODE ? 'Refresh runs are disabled in this demo build.'
            : running ? 'A refresh run is already in progress — wait for it to finish.'
            : !c.state.enabled ? `${c.meta.name} is disabled. Use Enable first, then run a sync.`
            : `Run ${c.meta.name} now and import whatever it returns.`
          }
          onClick={onRun}
        >
          {DEMO_MODE ? 'Disabled in demo' : 'Run sync'}
        </button>
        <button
          className={btnGhost}
          disabled={DEMO_MODE}
          title={DEMO_MODE ? 'Connector configuration is disabled in this demo build.' : undefined}
          onClick={async () => { await api.refresh.setEnabled(c.meta.id, !c.state.enabled); await onChanged(); }}
        >
          {c.state.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="font-mono text-[10px] text-slate-mid underline decoration-dotted hover:text-ink" onClick={() => setShowSetup((s) => !s)}>
          {showSetup ? 'Hide setup' : 'Setup'}
        </button>
        <select
          value={schedule}
          onChange={(e) => {
            setSchedule(e.target.value);
            const all = loadSchedules();
            all[c.meta.id] = e.target.value;
            try { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(all)); } catch { /* non-fatal */ }
          }}
          className="ml-auto rounded-[2px] border border-line bg-panel px-1.5 py-0.5 font-mono text-[10px]"
          title="Stored as configuration only — no scheduler runs in this backend"
          aria-label={`Schedule for ${c.meta.name} (configuration only)`}
        >
          <option>Manual</option><option>Weekly</option><option>Biweekly</option>
        </select>
      </div>
      {showSetup && (
        <div className="mt-2 rounded-[2px] bg-paper px-2 py-1.5 text-[11px] leading-relaxed text-slate-mid">
          <div><span className="font-semibold text-ink">Needs:</span> {c.meta.needs}</div>
          <div className="mt-1"><span className="font-semibold text-ink">Setup:</span> {c.meta.setup}</div>
        </div>
      )}
      {c.meta.id === 'local-csv' && <CsvUpload onDone={onChanged} />}
      {c.meta.id === 'local-portfolio' && <PortfolioUpload onDone={onChanged} />}
    </div>
  );
}

function CsvUpload({ onDone }: { onDone: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { refresh } = useCompanies();
  return (
    <div className="mt-2 border-t border-line pt-2">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setError(null);
          setReport(null);
          try {
            const res = await api.imports.importCsv(await file.text());
            setReport(
              `${res.imported}/${res.total} rows imported.` +
              (res.skipped.length > 0 ? ` Rejected rows: ${res.skipped.map((s) => `row ${s.row} (${s.issues[0]})`).join('; ')}` : ''),
            );
            await Promise.all([refresh(), onDone()]);
          } catch (err) {
            setError(err as ApiError);
          } finally {
            e.target.value = '';
          }
        }}
      />
      <div className="flex gap-2">
        <button className={btnGhost} onClick={() => inputRef.current?.click()}>Upload CSV</button>
        <button
          className={btnGhost}
          onClick={async () => { await api.imports.clear(); setReport('Imported companies cleared.'); await Promise.all([refresh(), onDone()]); }}
        >
          Clear imported
        </button>
      </div>
      {report && <p className="mt-1.5 text-[11px] text-slate-mid">{report}</p>}
      {error && <div className="mt-1.5"><ErrorNote message={error.message} issues={error.issues} /></div>}
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-mid">
        Rows pass the same validation guardrails as every other source (sourced evidence required). Identity/demographic columns are
        refused — those fields require verified sources and can&rsquo;t come from a bulk file.
      </p>
    </div>
  );
}

function PortfolioUpload({ onDone }: { onDone: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="mt-2 border-t border-line pt-2">
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setError(null);
          try {
            const parsed = JSON.parse(await file.text());
            const res = await api.imports.savePortfolio(parsed);
            setMsg(`${res.count} portfolio companies loaded — the AI comparison uses them.`);
            await onDone();
          } catch (err) {
            setError(err instanceof ApiError ? err : new ApiError(400, { message: 'Could not read that file — expected a JSON array of {name, vertical, stage, status}.' }));
          } finally {
            e.target.value = '';
          }
        }}
      />
      <button className={btnGhost} onClick={() => inputRef.current?.click()}>Upload portfolio JSON</button>
      {msg && <p className="mt-1.5 text-[11px] text-slate-mid">{msg}</p>}
      {error && <div className="mt-1.5"><ErrorNote message={error.message} issues={error.issues} /></div>}
    </div>
  );
}

function RefreshLog({ log }: { log: RefreshLogEntry[] }) {
  if (log.length === 0) {
    return <p className="mt-4 text-xs text-slate-mid">No refresh has been run yet — trigger one above to populate the log.</p>;
  }
  return (
    <div className="mt-4 border border-line bg-panel">
      <h3 className="border-b border-line px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
        Refresh log (latest {log.length})
      </h3>
      <ul className="divide-y divide-line">
        {log.map((entry) => (
          <li key={entry.id} className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-[10px] text-slate-mid">{entry.at.slice(0, 16).replace('T', ' ')}</span>
              <span className={`rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                entry.status === 'ok' ? 'bg-verde-soft text-verde'
                : entry.status === 'partial' ? 'bg-marigold-soft text-marigold'
                : 'bg-alerta-soft text-alerta'
              }`}>{entry.status}</span>
              <span className="text-slate-mid">{entry.scope} · {entry.trigger}</span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {entry.results.map((r) => (
                <li key={r.connector} className="flex flex-wrap items-start gap-2 text-[11px]">
                  <span className="w-24 shrink-0 font-mono">{r.connector}</span>
                  <ModeChip mode={r.mode} />
                  <span className="text-slate-mid">{r.records} rec · {r.detail}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
