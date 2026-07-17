import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCompanies } from '../store/companies';
import { PIPELINE_STAGES } from '../types';
import type { Company, PipelineItem, PipelineStage } from '../types';
import { usePipeline } from '../store/pipeline';
import { PageHeader, ScoreGauge, StatCard } from '../components/ui';
import { scoreCompany } from '../lib/scoring';
import { api, ApiError } from '../lib/api';
import { useIntegrations } from '../store/integrations';
import { OutreachPanel } from '../components/OutreachPanel';
import { HubSpotModal } from '../components/HubSpotModal';
import { btnGhost, DemoBadge, ErrorNote } from '../components/Modal';
import { OUTREACH_STATUSES, type OutreachRecord } from '../../shared/integrations';

type Tab = 'tracker' | 'board';

export function OutreachPipeline() {
  const [tab, setTab] = useState<Tab>('tracker');
  return (
    <div>
      <PageHeader
        eyebrow="Relationship tracking"
        title="Outreach Pipeline"
        blurb="Every outreach email is drafted for review, saved to Outlook as a draft, and sent by a person — never automatically. The tracker below reflects HubSpot sync and Outlook draft activity from the backend."
        right={
          <div className="flex rounded-sm border border-line bg-panel p-0.5 font-mono text-[11px]">
            {(['tracker', 'board'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-sm px-3 py-1.5 font-semibold transition-colors ${tab === t ? 'bg-ink text-white' : 'text-slate-mid hover:text-ink'}`}
              >
                {t === 'tracker' ? 'Outreach tracker' : 'Kanban board'}
              </button>
            ))}
          </div>
        }
      />
      {tab === 'tracker' ? <TrackerView /> : <BoardView />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tracker — server-backed outreach records with follow-up tracking
// ═══════════════════════════════════════════════════════════════

interface Filters {
  owner: string;
  vertical: string;
  stage: string;
  hubspot: string;
  status: string;
  followUp: string; // all | due-today | overdue | this-week | none-set
  exception: string; // all | with | without
  minScore: number;
}

const DEFAULT_FILTERS: Filters = {
  owner: 'all', vertical: 'all', stage: 'all', hubspot: 'all',
  status: 'all', followUp: 'all', exception: 'all', minScore: 1,
};

function TrackerView() {
  const { backendUp } = useIntegrations();
  const { companies } = useCompanies();
  const byId = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  const [records, setRecords] = useState<OutreachRecord[]>([]);
  const [followUps, setFollowUps] = useState<{ dueToday: OutreachRecord[]; overdue: OutreachRecord[]; dueThisWeek: OutreachRecord[]; draftsNeverSent: OutreachRecord[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [modal, setModal] = useState<{ kind: 'outreach' | 'hubspot'; company: Company } | null>(null);
  const [followUpFor, setFollowUpFor] = useState<OutreachRecord | null>(null);
  const [statusNote, setStatusNote] = useState<{ companyId: string; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.outreach.records();
      setRecords(data.records);
      setFollowUps(data.followUps);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  const filtered = records.filter((r) => {
    if (filters.owner !== 'all' && r.owner !== filters.owner) return false;
    if (filters.vertical !== 'all' && r.vertical !== filters.vertical) return false;
    if (filters.stage !== 'all' && r.companyStage !== filters.stage) return false;
    if (filters.hubspot !== 'all' && r.hubspotStatus !== filters.hubspot) return false;
    if (filters.status !== 'all' && r.outreachStatus !== filters.status) return false;
    if (filters.exception === 'with' && !r.policyException) return false;
    if (filters.exception === 'without' && r.policyException) return false;
    if (r.fitScore < filters.minScore) return false;
    const due = r.followUp && !r.followUp.done ? r.followUp.dueDate : null;
    if (filters.followUp === 'due-today' && due !== today) return false;
    if (filters.followUp === 'overdue' && !(due && due < today)) return false;
    if (filters.followUp === 'this-week' && !(due && due >= today && due <= weekEnd)) return false;
    if (filters.followUp === 'none-set' && due) return false;
    return true;
  });

  const noActivity = companies.filter((c) => !records.some((r) => r.companyId === c.id));
  const owners = Array.from(new Set(records.map((r) => r.owner))).sort();
  const verticals = Array.from(new Set(records.map((r) => r.vertical))).sort();
  const stages = Array.from(new Set(records.map((r) => r.companyStage))).sort();
  const sel = 'rounded-sm border border-line bg-panel px-2 py-1.5 text-xs';

  if (backendUp === false) {
    return (
      <ErrorNote
        message="The Deal Radar backend is not running, so the tracker can't load."
        hint="Start it with `npm run dev` (runs the web app and API together). The Kanban board tab still works offline."
      />
    );
  }

  return (
    <div>
      {followUps && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Follow-ups due today" value={followUps.dueToday.length} sub={followUps.dueToday.map((r) => r.companyName).join(', ') || 'Nothing due today'} />
          <StatCard label="Overdue" value={<span className={followUps.overdue.length > 0 ? 'text-alerta' : ''}>{followUps.overdue.length}</span>} sub={followUps.overdue.map((r) => r.companyName).join(', ') || 'Nothing overdue'} />
          <StatCard label="Due this week" value={followUps.dueThisWeek.length} sub={followUps.dueThisWeek.map((r) => r.companyName).join(', ') || 'Clear week ahead'} />
          <StatCard label="Drafts never marked sent" value={followUps.draftsNeverSent.length} sub={followUps.draftsNeverSent.map((r) => r.companyName).join(', ') || 'All drafts accounted for'} />
          <StatCard label="Companies w/ no outreach" value={noActivity.length} sub="Surfaced companies not yet in the tracker" />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select className={sel} value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} aria-label="Filter by owner">
          <option value="all">All owners</option>
          {owners.map((o) => <option key={o}>{o}</option>)}
        </select>
        <select className={sel} value={filters.vertical} onChange={(e) => setFilters({ ...filters, vertical: e.target.value })} aria-label="Filter by vertical">
          <option value="all">All verticals</option>
          {verticals.map((v) => <option key={v}>{v}</option>)}
        </select>
        <select className={sel} value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })} aria-label="Filter by stage">
          <option value="all">All stages</option>
          {stages.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={sel} value={filters.hubspot} onChange={(e) => setFilters({ ...filters, hubspot: e.target.value })} aria-label="Filter by HubSpot status">
          <option value="all">HubSpot: all</option>
          <option>Not added</option><option>Added</option><option>Updated</option>
        </select>
        <select className={sel} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Filter by outreach status">
          <option value="all">Outreach status: all</option>
          {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={sel} value={filters.followUp} onChange={(e) => setFilters({ ...filters, followUp: e.target.value })} aria-label="Filter by follow-up due">
          <option value="all">Follow-up: all</option>
          <option value="due-today">Due today</option>
          <option value="overdue">Overdue</option>
          <option value="this-week">Due this week</option>
          <option value="none-set">None set</option>
        </select>
        <select className={sel} value={filters.exception} onChange={(e) => setFilters({ ...filters, exception: e.target.value })} aria-label="Filter by policy exception">
          <option value="all">Exceptions: all</option>
          <option value="with">With policy exception</option>
          <option value="without">Without exception</option>
        </select>
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-slate-mid">
          Fit ≥ {filters.minScore.toFixed(1)}
          <input type="range" min={1} max={10} step={0.5} value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: Number(e.target.value) })} aria-label="Minimum fit score" />
        </label>
        <button className="ml-auto font-mono text-[11px] text-slate-mid underline decoration-dotted hover:text-ink" onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </button>
      </div>

      {error && <div className="mb-3"><ErrorNote message={error.message} hint={error.hint} /></div>}

      <div className="overflow-x-auto rounded-md border border-line bg-panel">
        <table className="w-full min-w-[1080px] text-left text-sm">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-slate-mid">
              <th className="px-3 py-2">Company / founder</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">HubSpot</th>
              <th className="px-3 py-2">Outreach status</th>
              <th className="px-3 py-2">Dates</th>
              <th className="px-3 py-2">Meeting</th>
              <th className="px-3 py-2">Next action</th>
              <th className="px-3 py-2">Signals</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-sm text-slate-mid">
                  {records.length === 0
                    ? 'No tracked outreach yet. Open any company in a sector tab and use "Approve & add to HubSpot" or "Generate founder outreach" to start tracking.'
                    : 'No records match these filters.'}
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const company = byId.get(r.companyId);
              const due = r.followUp && !r.followUp.done ? r.followUp.dueDate : null;
              const overdue = due && due < today;
              return (
                <tr key={r.companyId} className="border-b border-line align-top">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ScoreGauge score={r.fitScore} size={30} />
                      <div>
                        <div className="font-semibold">{r.companyName}</div>
                        <div className="text-xs text-slate-mid">{r.founderName}{r.founderEmail ? ` · ${r.founderEmail}` : ' · no verified email'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">{r.owner}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold ${r.hubspotStatus === 'Not added' ? 'bg-paper text-slate-mid' : 'bg-verde-soft text-verde'}`}>
                      {r.hubspotStatus}
                    </span>
                    {r.hubspotUrl ? (
                      <a href={r.hubspotUrl} target="_blank" rel="noreferrer" className="mt-0.5 block text-verde underline decoration-dotted">Open record</a>
                    ) : r.hubspotCompanyId ? (
                      <span className="mt-0.5 block font-mono text-[10px] text-slate-mid">{r.hubspotCompanyId} <DemoBadge show /></span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusSelect record={r} onChanged={refresh} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10px] leading-relaxed text-slate-mid">
                    {r.draftCreatedAt && <div>Draft {r.draftCreatedAt.slice(0, 10)}</div>}
                    {r.emailSentAt && <div>Sent {r.emailSentAt.slice(0, 10)}</div>}
                    {due && <div className={overdue ? 'font-bold text-alerta' : ''}>Follow-up {due}{overdue ? ' — overdue' : ''}</div>}
                    {r.lastResponseAt && <div>Replied {r.lastResponseAt.slice(0, 10)}</div>}
                    {!r.draftCreatedAt && !r.emailSentAt && !due && '—'}
                  </td>
                  <td className="px-3 py-2.5 text-xs">{r.meetingStatus}</td>
                  <td className="max-w-[180px] px-3 py-2.5 text-xs text-slate-mid">{r.nextAction}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <div className="font-mono text-[10px] text-slate-mid">Source quality {r.sourceQuality}/10</div>
                    {r.policyException && (
                      <span className="mt-0.5 inline-block rounded-sm bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta" title={r.policyException}>
                        Policy exception
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-stretch gap-1">
                      {company && (
                        <button className={btnGhost} onClick={() => setModal({ kind: 'outreach', company })}>
                          {r.draftCreatedAt ? 'New draft' : 'Generate outreach'}
                        </button>
                      )}
                      {(r.outreachStatus === 'Saved to Outlook' || r.outlookWebLink) && !r.emailSentAt && (
                        <button
                          className={btnGhost}
                          onClick={async () => { await api.outreach.markSent(r.companyId, r.owner); await refresh(); }}
                        >
                          Mark sent (manual)
                        </button>
                      )}
                      {r.outlookDraftId && !r.emailSentAt && (
                        <button
                          className={btnGhost}
                          title="Ask Outlook whether this draft was sent — sent status is only confirmed this way or by manual marking"
                          onClick={async () => {
                            try {
                              const res = await api.outlook.syncStatus(r.companyId, r.owner);
                              setStatusNote({ companyId: r.companyId, text: res.status.detail });
                              await refresh();
                            } catch (e) {
                              setStatusNote({ companyId: r.companyId, text: (e as Error).message });
                            }
                          }}
                        >
                          Check Outlook status
                        </button>
                      )}
                      {statusNote?.companyId === r.companyId && (
                        <span className="text-[10px] leading-snug text-slate-mid">{statusNote.text}</span>
                      )}
                      {(r.draftCreatedAt || r.emailSentAt) && (
                        <button className={btnGhost} onClick={() => setFollowUpFor(r)}>Set follow-up</button>
                      )}
                      {r.outlookWebLink && (
                        <a href={r.outlookWebLink} target="_blank" rel="noreferrer" className="text-center text-xs text-verde underline">Open in Outlook</a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {noActivity.length > 0 && (
        <section className="mt-5 rounded-md border border-line bg-panel p-4">
          <h2 className="font-display text-sm font-bold">Companies with no outreach activity ({noActivity.length})</h2>
          <p className="mt-1 text-xs text-slate-mid">Surfaced by the radar but not yet reviewed for tracking. Open one to approve it for HubSpot.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {noActivity.map((c) => (
              <button
                key={c.id}
                className="rounded-sm border border-line bg-paper px-2 py-1 text-xs hover:border-marigold hover:text-marigold"
                onClick={() => setModal({ kind: 'hubspot', company: c })}
              >
                {c.name} <span className="font-mono text-[10px] text-slate-mid">{scoreCompany(c).score.toFixed(1)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {modal?.kind === 'outreach' && (
        <OutreachPanel c={modal.company} onClose={() => { setModal(null); void refresh(); }} onSaved={refresh} />
      )}
      {modal?.kind === 'hubspot' && (
        <HubSpotModal c={modal.company} onClose={() => { setModal(null); void refresh(); }} onSynced={refresh} />
      )}
      {followUpFor && (
        <FollowUpDialog record={followUpFor} onClose={() => setFollowUpFor(null)} onSaved={() => { setFollowUpFor(null); void refresh(); }} />
      )}
    </div>
  );
}

function StatusSelect({ record, onChanged }: { record: OutreachRecord; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <select
      value={record.outreachStatus}
      disabled={busy}
      onChange={async (e) => {
        setBusy(true);
        try { await api.outreach.setStatus(record.companyId, e.target.value, record.owner); await onChanged(); }
        finally { setBusy(false); }
      }}
      className="w-full max-w-[170px] rounded-sm border border-line bg-panel px-1.5 py-1 text-xs"
      aria-label={`Outreach status for ${record.companyName}`}
    >
      {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

function FollowUpDialog({ record, onClose, onSaved }: { record: OutreachRecord; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-md border border-line bg-panel p-4">
        <h3 className="font-display text-sm font-bold">Follow-up for {record.companyName}</h3>
        <p className="mt-1 text-xs text-slate-mid">A reminder only — follow-up emails are never sent automatically. A new draft goes through the same review flow.</p>
        <label className="mt-3 block font-mono text-[10px] uppercase text-slate-mid">
          Due date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 text-xs" />
        </label>
        <label className="mt-2 block font-mono text-[10px] uppercase text-slate-mid">
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case" placeholder="e.g. nudge if no reply" />
        </label>
        {error && <div className="mt-2"><ErrorNote message={error.message} /></div>}
        <div className="mt-3 flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="rounded-sm bg-marigold px-3 py-1.5 font-mono text-[11px] font-bold text-ink disabled:opacity-40"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await api.outreach.setFollowUp(record.companyId, date, note, record.owner); onSaved(); }
              catch (e) { setError(e as ApiError); }
              finally { setBusy(false); }
            }}
          >
            {busy ? 'Saving…' : 'Save follow-up'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Board — the original kanban view, preserved unchanged
// ═══════════════════════════════════════════════════════════════

function BoardView() {
  const { items, moveStage, updateItem, removeItem, reset } = usePipeline();
  const { companies } = useCompanies();
  const byId = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button onClick={reset} className="rounded-sm border border-line bg-panel px-3 py-1.5 font-mono text-[11px] text-slate-mid hover:border-marigold hover:text-marigold">
          Reset sample data
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PIPELINE_STAGES.map((stage) => {
          const col = items.filter((i) => i.stage === stage);
          return (
            <section key={stage} className="rounded-md border border-line bg-panel">
              <h2 className="flex items-center justify-between border-b border-line px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
                {stage}
                <span className="rounded-sm bg-paper px-1.5 font-bold text-ink">{col.length}</span>
              </h2>
              <div className="space-y-2 p-2.5">
                {col.length === 0 && <p className="px-1 py-2 text-xs text-slate-mid">Nothing here yet — add companies from any sector tab.</p>}
                {col.map((item) => (
                  <Card
                    key={item.companyId}
                    item={item}
                    name={byId.get(item.companyId)?.name ?? item.companyId}
                    score={byId.has(item.companyId) ? scoreCompany(byId.get(item.companyId)!).score : undefined}
                    onMove={(s) => moveStage(item.companyId, s)}
                    onUpdate={(patch) => updateItem(item.companyId, patch)}
                    onRemove={() => removeItem(item.companyId)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  item, name, score, onMove, onUpdate, onRemove,
}: {
  item: PipelineItem;
  name: string;
  score?: number;
  onMove: (s: PipelineStage) => void;
  onUpdate: (patch: Partial<PipelineItem>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-sm border border-line bg-paper p-2.5">
      <div className="flex items-center gap-2">
        {score !== undefined && <ScoreGauge score={score} size={32} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="font-mono text-[10px] text-slate-mid">Owner {item.owner} · last touch {item.lastTouch}</div>
        </div>
        <button onClick={onRemove} aria-label={`Remove ${name} from pipeline`} className="text-slate-mid hover:text-alerta">×</button>
      </div>
      <label className="mt-2 block font-mono text-[10px] uppercase text-slate-mid">
        Next step
        <input
          value={item.nextStep}
          onChange={(e) => onUpdate({ nextStep: e.target.value })}
          className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1 font-body text-xs normal-case"
        />
      </label>
      <label className="mt-1.5 block font-mono text-[10px] uppercase text-slate-mid">
        Move to
        <select
          value={item.stage}
          onChange={(e) => onMove(e.target.value as PipelineStage)}
          className="mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1 font-body text-xs normal-case"
        >
          {PIPELINE_STAGES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </label>
    </div>
  );
}
