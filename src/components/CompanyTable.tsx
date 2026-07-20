import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Company } from '../types';
import { scoreCompany } from '../lib/scoring';
import { verticalById, VERTICALS } from '../data/taxonomy';
import { ExceptionBadge, FounderLine, IdentityChips, ScoreGauge } from './ui';
import { HubSpotModal } from './HubSpotModal';
import { OutreachPanel } from './OutreachPanel';
import { AiAnalysis } from './AiAnalysis';
import { useCompanies } from '../store/companies';
import { btnGhost, btnPrimary } from './Modal';
import { api, ApiError, type PossibleDuplicateEntry, type RefreshResearchResult } from '../lib/api';
import type { CompanyStatus } from '../../shared/integrations';

const BULK_ACTIONS: CompanyStatus[] = ['Awaiting Review', 'Research Needed', 'Monitor', 'Passed'];
type SortMode = 'fit' | 'evidence-recency' | 'discovery-date';

function hasMissingInfo(c: Company): boolean {
  return !c.website || !c.raising || !c.accelerator
    || (c.city === 'Unknown' && c.state === '??')
    || !c.founders.some((f) => f.email)
    || !c.founders.some((f) => f.identity);
}

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/**
 * The company review table. Primary filters: vertical, stage, state,
 * plus review-queue filters (possible duplicate, missing info,
 * evidence confidence, staleness) and bulk status actions — still not
 * a CRM: HubSpot sync stays an individual, deliberate action never
 * exposed here. Search covers company, founder, website, and keywords.
 */
export function CompanyTable({
  companies,
  showVertical = false,
  initialVertical,
  initialOpenId,
}: {
  companies: Company[];
  showVertical?: boolean;
  initialVertical?: string;
  initialOpenId?: string;
}) {
  const { meta, refresh: refreshCompanies } = useCompanies();
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [vertical, setVertical] = useState(initialVertical ?? 'all');
  const [stage, setStage] = useState('all');
  const [state, setState] = useState('all');
  const [q, setQ] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const [possibleDuplicateOnly, setPossibleDuplicateOnly] = useState(false);
  const [missingInfoOnly, setMissingInfoOnly] = useState(false);
  const [minEvidenceConfidence, setMinEvidenceConfidence] = useState(0);
  const [notReviewedDays, setNotReviewedDays] = useState<number | ''>('');

  const [duplicates, setDuplicates] = useState<PossibleDuplicateEntry[]>([]);
  useEffect(() => {
    api.duplicates.list('pending').then((r) => setDuplicates(r.duplicates)).catch(() => setDuplicates([]));
  }, []);
  const duplicateCompanyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of duplicates) {
      ids.add(d.companyId);
      if (d.otherCompanyId) ids.add(d.otherCompanyId);
    }
    return ids;
  }, [duplicates]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulkAction, setPendingBulkAction] = useState<CompanyStatus | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ status: CompanyStatus; updated: number; skipped: { id: string; reason: string }[] } | null>(null);

  const states = useMemo(() => Array.from(new Set(companies.map((c) => c.state))).sort(), [companies]);

  const rows = useMemo(() => {
    const filtered = companies
      .map((c) => ({ c, fit: scoreCompany(c) }))
      .filter(({ c, fit }) => {
        if (vertical !== 'all' && c.vertical !== vertical) return false;
        if (stage !== 'all' && c.stage !== stage) return false;
        if (state !== 'all' && c.state !== state) return false;
        if (possibleDuplicateOnly && !duplicateCompanyIds.has(c.id)) return false;
        if (missingInfoOnly && !hasMissingInfo(c)) return false;
        if (minEvidenceConfidence > 0 && fit.evidenceConfidence < minEvidenceConfidence) return false;
        if (notReviewedDays !== '') {
          const lastTouch = meta[c.id]?.lastRefreshed ?? meta[c.id]?.discoveredAt;
          const age = daysSince(lastTouch);
          if (age === null || age < notReviewedDays) return false;
        }
        const hay = [
          c.name, c.oneLiner, c.subcategory, c.city, c.state,
          c.website ?? '', c.founders.map((f) => f.name).join(' '),
        ].join(' ').toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      });
    const evidenceRecency = (c: Company) => Math.max(0, ...c.evidence.map((e) => new Date(e.date).getTime() || 0));
    const discoveryDate = (c: Company) => new Date(meta[c.id]?.discoveredAt ?? 0).getTime() || 0;
    if (sortMode === 'evidence-recency') filtered.sort((a, b) => evidenceRecency(b.c) - evidenceRecency(a.c));
    else if (sortMode === 'discovery-date') filtered.sort((a, b) => discoveryDate(b.c) - discoveryDate(a.c));
    else filtered.sort((a, b) => b.fit.score - a.fit.score); // strongest opportunities first
    return filtered;
  }, [companies, vertical, stage, state, q, sortMode, possibleDuplicateOnly, missingInfoOnly, minEvidenceConfidence, notReviewedDays, duplicateCompanyIds, meta]);

  const select = 'rounded-sm border border-line bg-panel px-2 py-1.5 text-xs';
  const allVisibleSelected = rows.length > 0 && rows.every(({ c }) => selected.has(c.id));

  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map(({ c }) => c.id)));
  };
  const toggleSelectOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const runBulkAction = async () => {
    if (!pendingBulkAction) return;
    setBulkBusy(true);
    try {
      const res = await api.imports.bulkStatus(Array.from(selected), pendingBulkAction, 'team');
      setBulkResult({ status: res.status, updated: res.updated.length, skipped: res.skipped });
      setSelected(new Set());
      await refreshCompanies();
    } catch (e) {
      setBulkResult({ status: pendingBulkAction, updated: 0, skipped: [{ id: 'all', reason: e instanceof ApiError ? e.message : (e as Error).message }] });
    } finally {
      setBulkBusy(false);
      setPendingBulkAction(null);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, founder, website, keyword…"
          className={`${select} w-64`}
          aria-label="Search companies"
        />
        {showVertical && (
          <select className={select} value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Filter by vertical">
            <option value="all">All verticals</option>
            {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
        <select className={select} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
          <option value="all">All stages</option>
          {['Pre-seed', 'Seed', 'Series A', 'Stealth'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={select} value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state">
          <option value="all">All states</option>
          {states.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={select} value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)} aria-label="Sort by">
          <option value="fit">Sort: Vamos Fit Score</option>
          <option value="evidence-recency">Sort: Evidence recency</option>
          <option value="discovery-date">Sort: Discovery date</option>
        </select>
        <span className="ml-auto font-mono text-[11px] text-slate-mid">{rows.length} compan{rows.length === 1 ? 'y' : 'ies'}</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={possibleDuplicateOnly} onChange={(e) => setPossibleDuplicateOnly(e.target.checked)} />
          Possible duplicate only
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={missingInfoOnly} onChange={(e) => setMissingInfoOnly(e.target.checked)} />
          Missing information only
        </label>
        <label className="flex items-center gap-1.5">
          Min. evidence confidence
          <input
            type="number" min={0} max={100} step={5} className={`${select} w-16`}
            value={Math.round(minEvidenceConfidence * 100)}
            onChange={(e) => setMinEvidenceConfidence(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
          />%
        </label>
        <label className="flex items-center gap-1.5">
          Not reviewed in
          <input
            type="number" min={0} className={`${select} w-16`} placeholder="—"
            value={notReviewedDays}
            onChange={(e) => setNotReviewedDays(e.target.value === '' ? '' : Number(e.target.value))}
          />
          days
        </label>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-sm border border-marigold/40 bg-marigold-soft/40 px-3 py-2 text-xs">
          <span className="font-semibold">{selected.size} selected</span>
          {pendingBulkAction ? (
            <span className="flex items-center gap-2">
              Move {selected.size} compan{selected.size === 1 ? 'y' : 'ies'} to <strong>{pendingBulkAction}</strong>?
              <button className={btnPrimary} disabled={bulkBusy} onClick={runBulkAction}>{bulkBusy ? 'Applying…' : 'Confirm'}</button>
              <button className={btnGhost} disabled={bulkBusy} onClick={() => setPendingBulkAction(null)}>Cancel</button>
            </span>
          ) : (
            <span className="ml-auto flex flex-wrap gap-1.5">
              {BULK_ACTIONS.map((s) => (
                <button key={s} className={btnGhost} onClick={() => setPendingBulkAction(s)}>Bulk: {s}</button>
              ))}
              <button className={btnGhost} onClick={() => setSelected(new Set())}>Clear selection</button>
            </span>
          )}
        </div>
      )}
      {bulkResult && (
        <div className="mb-3 rounded-sm border border-line bg-panel px-3 py-2 text-xs">
          <span className="font-semibold">Bulk "{bulkResult.status}"</span>: {bulkResult.updated} updated
          {bulkResult.skipped.length > 0 && `, ${bulkResult.skipped.length} skipped (${bulkResult.skipped.map((s) => s.reason).join('; ')})`}.
          <button className="ml-2 text-slate-mid hover:text-ink" onClick={() => setBulkResult(null)}>Dismiss ✕</button>
        </div>
      )}

      <div
        className="overflow-x-auto rounded-md border border-line bg-panel"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          if (rows.length === 0) return;
          e.preventDefault();
          const idx = rows.findIndex(({ c }) => c.id === openId);
          const nextIdx = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
          setOpenId(rows[idx === -1 ? 0 : nextIdx].c.id);
        }}
        aria-label="Company review queue — arrow keys move between an expanded company and its neighbor"
      >
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-slate-mid">
              <th className="px-3 py-2"><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all visible companies" /></th>
              <th className="px-3 py-2">Fit</th>
              <th className="px-3 py-2">Company</th>
              {showVertical && <th className="px-3 py-2">Vertical</th>}
              <th className="px-3 py-2">Subcategory</th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">HQ</th>
              <th className="px-3 py-2">Verified team</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={showVertical ? 8 : 7} className="px-3 py-8 text-center text-slate-mid">
                  No companies are on record here. Clear a filter, run Deal Discovery, or import a CSV under Settings.
                </td>
              </tr>
            )}
            {rows.map(({ c, fit }, i) => {
              const open = openId === c.id;
              const isDuplicate = duplicateCompanyIds.has(c.id);
              return (
                <FragmentRow key={c.id}>
                  <tr
                    className={`border-b border-line align-top transition-colors hover:bg-marigold-soft/40 ${open ? 'bg-marigold-soft/40' : ''}`}
                    data-row-index={i}
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelectOne(c.id)} aria-label={`Select ${c.name}`} />
                    </td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => setOpenId(open ? null : c.id)}><ScoreGauge score={fit.score} /></td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => setOpenId(open ? null : c.id)}>
                      <div className="font-semibold">{c.name}</div>
                      <div className="max-w-xs text-xs text-slate-mid">{c.oneLiner}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} />)}
                        {isDuplicate && (
                          <span className="rounded-sm bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta" title="A possible duplicate is pending review — see the expanded row.">
                            Possible duplicate
                          </span>
                        )}
                      </div>
                    </td>
                    {showVertical && <td className="cursor-pointer px-3 py-2.5 text-xs" onClick={() => setOpenId(open ? null : c.id)}>{verticalById(c.vertical).name}</td>}
                    <td className="cursor-pointer px-3 py-2.5 text-xs" onClick={() => setOpenId(open ? null : c.id)}>{c.subcategory}</td>
                    <td className="cursor-pointer px-3 py-2.5 whitespace-nowrap text-xs font-medium" onClick={() => setOpenId(open ? null : c.id)}>{c.stage}</td>
                    <td className="cursor-pointer px-3 py-2.5 whitespace-nowrap text-xs" onClick={() => setOpenId(open ? null : c.id)}>{c.city}, {c.state}</td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => setOpenId(open ? null : c.id)}><IdentityChips founders={c.founders} /></td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={showVertical ? 8 : 7} className="px-4 py-4">
                        <CompanyDetail c={c} duplicates={duplicates.filter((d) => d.companyId === c.id || d.otherCompanyId === c.id)} onDuplicatesChange={setDuplicates} />
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// React fragments can't carry keys inside <tbody> mapping neatly with two rows,
// so wrap the pair. Using a plain fragment component keeps the table valid.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function CompanyDetail({ c, duplicates = [], onDuplicatesChange }: {
  c: Company;
  duplicates?: PossibleDuplicateEntry[];
  onDuplicatesChange?: (updater: (prev: PossibleDuplicateEntry[]) => PossibleDuplicateEntry[]) => void;
}) {
  const fit = scoreCompany(c);
  const { meta, refresh } = useCompanies();
  const m = meta[c.id];
  const [duplicateBusy, setDuplicateBusy] = useState<number | null>(null);

  const resolveDuplicate = async (id: number, resolution: 'confirmed-duplicate' | 'not-duplicate') => {
    setDuplicateBusy(id);
    try {
      await api.duplicates.resolve(id, resolution, 'team');
      onDuplicatesChange?.((prev) => prev.filter((d) => d.id !== id));
      await refresh();
    } catch {
      // Surfaced via the ambient statusNote pattern below is overkill here; a failed resolve just leaves the item pending for retry.
    } finally {
      setDuplicateBusy(null);
    }
  };
  const [modal, setModal] = useState<'hubspot' | 'outreach' | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshResearchResult | null>(null);

  const setStatus = async (status: CompanyStatus, then?: () => void) => {
    setStatusBusy(status);
    setStatusNote(null);
    try {
      await api.imports.setStatus(c.id, status, 'team');
      await refresh();
      then?.();
    } catch (e) {
      setStatusNote(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setStatusBusy(null);
    }
  };

  const markReviewed = async () => {
    setStatusBusy('Mark reviewed');
    setStatusNote(null);
    try {
      await api.imports.refresh(c.id, 'team');
      await refresh();
    } catch (e) {
      setStatusNote(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setStatusBusy(null);
    }
  };

  const refreshLiveResearch = async () => {
    setStatusBusy('Refresh live research');
    setStatusNote(null);
    setRefreshResult(null);
    try {
      const result = await api.imports.refreshResearch(c.id, 'team');
      setRefreshResult(result);
      await refresh();
    } catch (e) {
      setStatusNote(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setStatusBusy(null);
    }
  };

  const provenanceLabel: Record<string, string> = {
    verified: 'Verified',
    'user-entered': 'User-entered',
    extracted: 'Extracted public info',
    'ai-inferred': 'AI-inferred',
    unverified: 'Unverified',
    missing: 'Missing',
  };
  const origin = (field: string): string | null => {
    const o = m?.provenance?.[field];
    return o ? provenanceLabel[o] ?? o : null;
  };

  // ── The full fact sheet. Absent facts say Missing; nothing is guessed.
  const facts: { label: string; value: string | null; field?: string; href?: string }[] = [
    { label: 'Website', value: c.website ?? null, field: 'website', href: c.website },
    { label: 'Description', value: c.oneLiner, field: 'oneLiner' },
    { label: 'Stage', value: c.stage, field: 'stage' },
    { label: 'Geography', value: c.city !== 'Unknown' || c.state !== '??' ? `${c.city}, ${c.state}` : null, field: 'city' },
    { label: 'Vertical', value: `${verticalById(c.vertical).name} → ${c.subcategory}`, field: 'vertical' },
    { label: 'Funding', value: c.raising ?? null, field: 'raising' },
    { label: 'Last funding date', value: c.lastFundingDate ?? null, field: 'lastFundingDate' },
    { label: 'Accelerator', value: c.accelerator ?? null, field: 'accelerator' },
    { label: 'Discovered', value: m?.discoveredAt ? `${m.discoveredAt}${m.discoverySource ? ` via ${m.discoverySource}` : ''}` : null },
    { label: 'Last refreshed', value: c.lastRefreshed ?? m?.lastRefreshed ?? null },
    { label: 'Review status', value: m?.reviewStatus ?? 'New' },
    { label: 'HubSpot sync', value: m?.hubspotCompanyId ? `Synced — record ${m.hubspotCompanyId}` : 'Not synced' },
  ];

  // ── Missing information: exactly what we do not know.
  const missing: string[] = [];
  if (!c.website) missing.push('Website');
  if (c.city === 'Unknown' && c.state === '??') missing.push('Location');
  if (!c.raising) missing.push('Funding amount');
  if (!c.lastFundingDate) missing.push('Last funding date');
  if (!c.accelerator) missing.push('Accelerator participation (none recorded)');
  if (c.subcategory.toLowerCase().includes('unclassified')) missing.push('Subcategory classification');
  if (c.founders.some((f) => f.background.toLowerCase().includes('unknown'))) missing.push('Founder backgrounds (require manual research)');
  if (!c.founders.some((f) => f.email)) missing.push('Verified founder email');
  if (!c.founders.some((f) => f.identity)) missing.push('Founder identity signal (only added from explicit public statements — never inferred)');

  // ── Risks: policy exceptions + weak audited components.
  const risks: string[] = [
    ...fit.exceptions.map((e) => e.message),
    ...fit.components.filter((x) => x.max >= 10 && x.points / x.max < 0.4).map((x) => `Weak ${x.label.toLowerCase()} (${x.points}/${x.max}): ${x.rationale}`),
  ];

  const nextStep =
    fit.exceptions.length > 0 ? 'Route to partner review — a policy exception needs sign-off before anything else.'
    : m?.stale ? 'Stale — this record has gone unreviewed too long. Refresh it, or move it to Monitor / Passed / Research Needed.'
    : m?.reviewStatus === 'New' || m?.reviewStatus === 'Awaiting Review' ? 'Complete the first review: verify the website and pitch, classify the subcategory, then decide whether to track.'
    : fit.score >= 8 ? 'Prioritize: assign an owner, approve outreach, and add to HubSpot.'
    : fit.score >= 6.5 ? `Track actively and close the weakest evidence gap (${[...fit.components].sort((a, b) => a.points / a.max - b.points / b.max)[0].label.toLowerCase()}).`
    : 'Monitor; revisit when traction or evidence improves.';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-sm border border-line bg-panel px-3 py-2.5">
        <span className="font-display text-base font-bold">Vamos Fit Score: {fit.score.toFixed(1)}/10</span>
        <span
          className="cursor-help rounded-sm bg-paper px-1.5 py-0.5 font-mono text-[11px] text-slate-mid"
          title="How well-sourced this record is (count, primary sources, diversity, freshness). Separate from thesis fit — a perfect fit on thin evidence still needs research."
        >
          Evidence confidence {Math.round(fit.evidenceConfidence * 100)}%
        </span>
        <span className="rounded-sm bg-paper px-1.5 py-0.5 font-mono text-[10px] text-slate-mid" title={fit.explanation}>
          scoring model {fit.version}
        </span>
        {m?.reviewStatus && <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-marigold">{m.reviewStatus}</span>}
        {m?.stale && (
          <span className="rounded-sm bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta" title="Not reviewed or refreshed within the administrator-configured threshold (Settings → Stale-record settings).">
            Stale
          </span>
        )}
      </div>

      {duplicates.length > 0 && (
        <div className="mb-4 rounded-sm border border-alerta/40 bg-alerta-soft px-3 py-2.5 text-xs">
          <span className="font-mono uppercase tracking-wider text-alerta">Possible duplicate — pending review</span>
          {duplicates.map((d) => {
            const other = d.companyId === c.id ? d.otherCompany : d.company;
            return (
              <div key={d.id} className="mt-1.5 flex flex-wrap items-center gap-2">
                <span>Matched by <strong>{d.matchedBy}</strong> ({Math.round(d.similarity * 100)}% similar){other ? <> against <strong>{other.name}</strong></> : ''} — {d.detail}</span>
                <span className="ml-auto flex gap-1.5">
                  <button className={btnGhost} disabled={duplicateBusy === d.id} onClick={() => resolveDuplicate(d.id, 'confirmed-duplicate')}>
                    {duplicateBusy === d.id ? 'Saving…' : 'Confirm duplicate'}
                  </button>
                  <button className={btnGhost} disabled={duplicateBusy === d.id} onClick={() => resolveDuplicate(d.id, 'not-duplicate')}>
                    Not a duplicate
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-4 grid gap-x-6 gap-y-1.5 rounded-sm border border-line bg-panel px-3 py-2.5 text-xs sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.label} className="flex items-baseline gap-2">
            <span className="w-32 shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-mid">{f.label}</span>
            {f.value ? (
              <span className="min-w-0">
                {f.href ? (
                  <a href={f.href} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{f.value.replace('https://', '')}</a>
                ) : (
                  <span className={f.value.toLowerCase().includes('unknown') ? 'italic text-slate-mid' : ''}>{f.value}</span>
                )}
                {f.field && origin(f.field) && (
                  <span className="ml-1.5 rounded-sm bg-paper px-1 py-0.5 font-mono text-[9px] uppercase text-slate-mid" title={`Field origin: ${origin(f.field)}`}>
                    {origin(f.field)}
                  </span>
                )}
              </span>
            ) : (
              <span className="italic text-slate-mid">Missing</span>
            )}
          </div>
        ))}
      </div>

      {(m?.addedEvidence?.length ?? 0) > 0 && (
        <div className="mb-3 rounded-sm border border-marigold/40 bg-marigold-soft/50 px-3 py-2 text-xs">
          <span className="font-semibold text-ink">Evidence added from discovery (appended, never overwritten):</span>
          <ul className="mt-0.5 list-disc pl-4 text-slate-mid">
            {m!.addedEvidence!.map((e, i) => (
              <li key={i}>{e.claim} — {e.source}, {e.date} (<a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">source</a>)</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-line bg-panel px-3 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
          Review status — no CRM workflow, just the calls a reviewer actually makes
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1.5">
          <button className={btnGhost} disabled={!!statusBusy} onClick={markReviewed} title="Stamp this record reviewed as of today — no external lookup">
            {statusBusy === 'Mark reviewed' ? 'Marking…' : 'Mark reviewed'}
          </button>
          <button className={btnGhost} disabled={!!statusBusy} onClick={refreshLiveResearch} title="Re-query live sources for this company and report what changed">
            {statusBusy === 'Refresh live research' ? 'Researching…' : 'Refresh live research'}
          </button>
          <button className={btnGhost} disabled={!!statusBusy} onClick={() => setStatus('Research Needed')}>
            {statusBusy === 'Research Needed' ? 'Saving…' : 'Send for research'}
          </button>
          <button className={btnGhost} disabled={!!statusBusy} onClick={() => setStatus('Monitor')}>
            {statusBusy === 'Monitor' ? 'Saving…' : 'Monitor'}
          </button>
          <button className={btnGhost} disabled={!!statusBusy} onClick={() => setStatus('Passed')}>
            {statusBusy === 'Passed' ? 'Saving…' : 'Pass'}
          </button>
        </span>
      </div>

      {refreshResult && (
        <div className="mb-4 rounded-sm border border-verde/40 bg-verde-soft/30 px-3 py-2.5 text-xs">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono uppercase tracking-wider text-slate-mid">
              What changed — live research refresh ({refreshResult.refreshedAt})
            </span>
            <button className="text-slate-mid hover:text-ink" onClick={() => setRefreshResult(null)}>Dismiss ✕</button>
          </div>
          <div className="mb-1.5 font-semibold text-ink">
            Vamos Fit Score: {refreshResult.oldScore ? `${refreshResult.oldScore.score.toFixed(1)} → ` : ''}{refreshResult.newScore.score.toFixed(1)}
            {refreshResult.oldScore && refreshResult.oldScore.score === refreshResult.newScore.score ? ' (unchanged)' : ''}
            <span className="ml-1.5 font-mono text-[10px] font-normal text-slate-mid">model {refreshResult.newScore.version}</span>
          </div>
          <ul className="space-y-1 text-ink/80">
            <li><span className="font-semibold">{refreshResult.newEvidenceCount}</span> new evidence item(s){refreshResult.newEvidenceCount > 0 && ':'}</li>
            {refreshResult.newEvidence.map((e, i) => (
              <li key={i} className="pl-3">{e.claim} — {e.source} (<a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">source</a>)</li>
            ))}
            {refreshResult.updatedFields.length > 0 && (
              <li><span className="font-semibold">{refreshResult.updatedFields.length}</span> field(s) updated:
                <ul className="pl-3">
                  {refreshResult.updatedFields.map((f, i) => <li key={i}>{f.field}: "{f.from}" → "{f.to}" (via {f.source})</li>)}
                </ul>
              </li>
            )}
            <li><span className="font-semibold">{refreshResult.unchangedFieldCount}</span> field(s) unchanged</li>
            {refreshResult.conflictingFields.length > 0 && (
              <li className="text-alerta"><span className="font-semibold">{refreshResult.conflictingFields.length}</span> conflicting field(s) — kept existing value, requires human review:
                <ul className="pl-3">
                  {refreshResult.conflictingFields.map((f, i) => <li key={i}>{f.field}: kept "{f.existing}", source said "{f.attempted}" (via {f.source})</li>)}
                </ul>
              </li>
            )}
            {refreshResult.sourcesRan.length > 0 && <li>Ran successfully: {refreshResult.sourcesRan.map((s) => `${s.sourceId} (${s.found} match${s.found === 1 ? '' : 'es'})`).join(', ')}</li>}
            {refreshResult.sourcesFailed.length > 0 && <li className="text-alerta">Failed: {refreshResult.sourcesFailed.map((s) => s.sourceId).join(', ')}</li>}
            {refreshResult.sourcesSkipped.length > 0 && <li className="text-slate-mid">Skipped: {refreshResult.sourcesSkipped.map((s) => `${s.sourceId} (${s.detail})`).join('; ')}</li>}
            {refreshResult.fieldsRequiringHumanReview.length > 0 && (
              <li className="text-alerta">Requires human review: {refreshResult.fieldsRequiringHumanReview.join('; ')}</li>
            )}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-line bg-panel px-3 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">
          Team actions — every external step gets a human review screen first
        </span>
        <span className="ml-auto flex gap-2">
          <button
            className={btnPrimary}
            disabled={!!statusBusy}
            onClick={() => setStatus('Approved for HubSpot', () => setModal('hubspot'))}
          >
            Approve &amp; add to HubSpot
          </button>
          <button className={btnGhost} onClick={() => setModal('outreach')}>
            Generate founder outreach
          </button>
        </span>
      </div>
      {statusNote && <p className="mb-3 -mt-2 text-xs text-alerta">{statusNote}</p>}
      {modal === 'hubspot' && <HubSpotModal c={c} onClose={() => setModal(null)} />}
      {modal === 'outreach' && <OutreachPanel c={c} onClose={() => setModal(null)} />}
      <AiAnalysis c={c} />
      <div className="grid gap-5 lg:grid-cols-2">
      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
          Score breakdown — {fit.totalPoints}/100 pts → {fit.score.toFixed(1)}/10 · weights shown as points/max
        </h3>
        <ul className="space-y-2">
          {fit.components.map((comp) => (
            <li key={comp.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{comp.label}</span>
                <span className="font-mono text-xs font-semibold">{comp.points}/{comp.max}</span>
              </div>
              <div className="mt-0.5 h-1 w-full rounded-sm bg-line">
                <div className="h-1 rounded-sm bg-verde" style={{ width: `${(comp.points / comp.max) * 100}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-slate-mid">{comp.rationale}</p>
            </li>
          ))}
        </ul>
        {fit.exceptions.length > 0 && (
          <div className="mt-3 space-y-2">
            {fit.exceptions.map((e) => (
              <div key={e.flag} className="rounded-sm border border-alerta/40 bg-alerta-soft px-3 py-2 text-xs text-alerta">
                <ExceptionBadge flag={e.flag} /> <span className="mt-1 block text-ink/80">{e.message}</span>
              </div>
            ))}
          </div>
        )}

        <h3 className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Missing information</h3>
        {missing.length === 0 ? (
          <p className="text-xs text-slate-mid">No gaps detected in the recorded facts.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-4 text-xs text-slate-mid">
            {missing.map((x) => <li key={x}>{x}</li>)}
          </ul>
        )}

        <h3 className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Risks</h3>
        {risks.length === 0 ? (
          <p className="text-xs text-slate-mid">No risks flagged by the scoring model.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-4 text-xs text-slate-mid">
            {risks.map((x) => <li key={x}>{x}</li>)}
          </ul>
        )}

        <h3 className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Recommended next step</h3>
        <p className="rounded-sm border border-line bg-panel px-3 py-2 text-xs">{nextStep}</p>
      </section>

      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">Founders</h3>
        <div className="space-y-1.5">{c.founders.map((f) => <FounderLine key={f.name} f={f} />)}</div>
        <p className="mt-1.5 text-[11px] italic text-slate-mid">
          Founder identity indicators come only from explicit public statements, approved data, or user entry —
          never inferred from names, photos, appearance, language, or geography.
        </p>

        <h3 className="mb-2 mt-4 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
          Evidence &amp; source URLs ({c.evidence.length})
        </h3>
        <ul className="space-y-2">
          {c.evidence.map((e) => (
            <li key={e.url} className="rounded-sm border border-line bg-panel px-3 py-2 text-xs">
              <div className="font-medium text-ink">{e.claim}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-slate-mid">
                <span className="rounded-sm bg-paper px-1 py-0.5 font-mono text-[10px] uppercase">{e.type}</span>
                <a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{e.source}</a>
                <span className="font-mono">{e.date}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-xs text-slate-mid">
          Founded {c.foundedYear} · Team of {c.teamSize}
        </div>
      </section>
      </div>
    </div>
  );
}
