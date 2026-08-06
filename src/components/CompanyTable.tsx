import { useCallback, useEffect, useMemo, useState } from 'react';
import { isLiveDeal, OPPORTUNITY_CLASSES, OPPORTUNITY_CLASS_LABELS, type OpportunityClass } from '../../shared/opportunity';
import { OpportunityBadges, QualificationExplainer, EvidenceSummary, ReportingSources } from './OpportunityBadge';
import type { ReactNode } from 'react';
import type { Company, FitScore } from '../types';
import { scoreCompany } from '../lib/scoring';
import { assessPromising } from '../lib/promisingQueue';
import { assessQuality } from '../../shared/qualitySignals';
import { HOT_THRESHOLD, TRACK_THRESHOLD } from '../../shared/scoringThresholds';
import { downloadCsv } from '../lib/csvDownload';
import { verticalById, VERTICALS } from '../data/taxonomy';
import { ExceptionBadge, FounderLine, IdentityChips, ProvenanceTag, ScoreGauge, type ProvenanceKind } from './ui';
import { EnrichmentPanel, FounderCell, StageCell, VerticalCell } from './Enrichment';
import { HubSpotModal } from './HubSpotModal';
import { OutreachPanel } from './OutreachPanel';
import { AiAnalysis } from './AiAnalysis';
import { WebsiteConfirmationPanel } from './WebsiteConfirmation';
import { CompanyNotes } from './CompanyNotes';
import { TractionReview } from './TractionReview';
import { PendingEvidencePanel } from './PendingEvidencePanel';
import { DEMO_MODE } from '../lib/demoMode';
import { confirmLeaveUnsavedNotes } from '../lib/unsavedNotes';
import { useCompanies } from '../store/companies';
import { btnGhost, btnPrimary } from './Modal';
import { api, ApiError, type PossibleDuplicateEntry, type RefreshResearchResult } from '../lib/api';
import type { CompanyStatus } from '../../shared/integrations';
import { meetsOperatingCompanyStandard } from '../../shared/qualification';

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

/** A compact, table-row version of the same call the detail view makes in full — the next thing a reviewer should do, at a glance. */
function nextActionTag(
  fit: ReturnType<typeof scoreCompany>,
  m: { reviewStatus?: string; stale?: boolean } | undefined,
): { label: string; cls: string } {
  if (fit.exceptions.length > 0) return { label: 'Partner review', cls: 'border-alerta/30 bg-alerta-soft text-alerta' };
  if (m?.stale) return { label: 'Refresh — stale', cls: 'border-alerta/30 bg-alerta-soft text-alerta' };
  if (!m?.reviewStatus || m.reviewStatus === 'New' || m.reviewStatus === 'Awaiting Review') return { label: 'First review', cls: 'border-marigold/30 bg-marigold-soft text-marigold' };
  // A provisional score says nothing about the company, so it can never
  // earn "Prioritize" or "Track". What it needs is data.
  if (fit.provisional) return { label: 'Needs data to score', cls: 'border-line bg-paper text-slate-mid' };
  if (fit.score >= HOT_THRESHOLD) return { label: 'Prioritize', cls: 'border-verde/30 bg-verde-soft text-verde' };
  if (fit.score >= TRACK_THRESHOLD) return { label: 'Track', cls: 'border-line bg-paper text-ink' };
  return { label: 'Monitor watchlist', cls: 'border-line bg-paper text-slate-mid' };
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
  initialVerticals,
  initialOpenId,
}: {
  companies: Company[];
  showVertical?: boolean;
  /**
   * Canonical vertical ids to preselect. Already normalized by the
   * caller (see verticalsFromParam in src/pages/Companies.tsx) — a raw
   * URL value must never reach this component, because a legacy string
   * like 'ai' matches no company row and renders as an empty table with
   * no filter chip lit.
   */
  initialVerticals?: string[];
  initialOpenId?: string;
}) {
  const { meta, opportunities, qualifications, quarantine, enrichment, refresh: refreshCompanies } = useCompanies();
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  // Multi-select: an empty set means "all verticals" — the master
  // All Deals view. A vertical page (or a sidebar link) arrives with
  // exactly one preselected via initialVertical; a reviewer can then
  // add or remove verticals freely from the same control.
  const [verticals, setVerticals] = useState<Set<string>>(() => new Set(initialVerticals ?? []));
  // initialVertical is only the value at first mount — without this
  // effect, clicking a different vertical in the sidebar while already
  // on /companies (same route, same component instance, no remount)
  // updated the URL but left this filter showing the PREVIOUS vertical,
  // a silently wrong "dead" filter state.
  // Keyed on the JOINED value, not the array identity: a fresh array with
  // the same contents arrives on every render, and depending on identity
  // would reset a reviewer's added verticals on each one.
  const initialVerticalKey = (initialVerticals ?? []).join(',');
  useEffect(() => {
    setVerticals(new Set(initialVerticalKey ? initialVerticalKey.split(',') : []));
  }, [initialVerticalKey]);
  const toggleVertical = (id: string) => {
    setVerticals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [stage, setStage] = useState('all');
  const [state, setState] = useState('all');
  const [q, setQ] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const [possibleDuplicateOnly, setPossibleDuplicateOnly] = useState(false);
  const [missingInfoOnly, setMissingInfoOnly] = useState(false);
  const [minEvidenceConfidence, setMinEvidenceConfidence] = useState(0);
  const [notReviewedDays, setNotReviewedDays] = useState<number | ''>('');
  // Opportunity-trust filters. These answer the question the old queue
  // could not: "which of these is actually a deal?"
  const [oppClass, setOppClass] = useState<'all' | OpportunityClass>('all');
  const [primarySource, setPrimarySource] = useState('all');
  const [tierFilter, setTierFilter] = useState<'all' | '1' | '2' | '3'>('all');
  const [liveOnly, setLiveOnly] = useState(false);
  const [leadsOnly, setLeadsOnly] = useState(false);
  const [verifiedAmountOnly, setVerifiedAmountOnly] = useState(false);
  const [verifiedRoundOnly, setVerifiedRoundOnly] = useState(false);
  const [missingCorroboration, setMissingCorroboration] = useState(false);
  const [humanReviewOnly, setHumanReviewOnly] = useState(false);
  const [assessedOnly, setAssessedOnly] = useState(false);
  /**
   * "Promising — Needs Diligence" — a saved view inside All Deals, not a
   * new Overview card. See src/lib/promisingQueue.ts for the rule and
   * why sparse evidence must not mean invisible.
   */
  const [promisingOnly, setPromisingOnly] = useState(false);
  /** The broad queue. Promising is a strict subset of it. */
  const [needsDiligenceOnly, setNeedsDiligenceOnly] = useState(false);
  const [publicWarnOnly, setPublicWarnOnly] = useState(false);
  const [fundWarnOnly, setFundWarnOnly] = useState(false);
  const [includeQuarantined, setIncludeQuarantined] = useState(false);
  const [evidenceSince, setEvidenceSince] = useState('');

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
  // Options come from the data actually present, so the dropdown can never
  // offer a source that returned nothing.
  const primarySources = useMemo(
    () => Array.from(new Set(Object.values(opportunities).map((o) => o.primarySourceId))).sort(),
    [opportunities],
  );
  const quarantinedCount = useMemo(
    () => companies.filter((c) => quarantine[c.id]).length,
    [companies, quarantine],
  );

  /**
   * Build the Promising verdict for one row from the context the table
   * already holds. Kept as a callback (not inlined) so the row renderer
   * and the filter cannot disagree about who is in the queue.
   *
   * `qualityBand` is not available client-side for imported companies —
   * it lives on the discovery candidate, which is a different record —
   * so eligibility here rests on the preliminary score and the recorded
   * accelerator. That is a narrower rule than the server-side one, and
   * it is narrower in the safe direction: it can omit a promising
   * company, never invent one.
   */
  const promisingVerdict = useCallback(
    (c: Company, fit: FitScore) => {
      /**
       * Quality signals are computed from the company's OWN published
       * text, using the same shared assessor the discovery pipeline
       * runs on candidates. Passing an empty signal list here (the
       * first version) meant no stored company could ever be
       * "Promising", because the substantive-signal requirement could
       * never be met — the queue would have been silently empty.
       */
      const quality = assessQuality({
        pitch: c.oneLiner || 'Unknown',
        subcategory: c.subcategory || 'Unknown',
        accelerator: c.accelerator ?? 'Unknown',
        publicFunding: c.raising ?? 'Unknown',
        mostRecentRound: 'Unknown',
        website: c.website ?? 'Unknown',
        tractionSignals: c.traction?.note ? [c.traction.note] : [],
        evidence: c.evidence.map((e) => ({
          claim: e.claim, url: e.url, publishedAt: e.date ?? null,
        })),
      } as unknown as Parameters<typeof assessQuality>[0], new Date(), {
        /**
         * Founder biographies feed founder-market-fit, CITED ONLY.
         *
         * Without this the triage value was computed from the discovery
         * snippet alone and never saw the research that came after it —
         * a company with two researched founders looked identical to one
         * with none. The first cited evidence URL on the record is used
         * as the citation; a company with no cited source contributes no
         * founder signal at all.
         */
        founderBios: c.founders
          .filter((f) => !/unknown/i.test(f.name) && f.background && !/^unknown/i.test(f.background.trim()))
          .map((f) => ({ text: `${f.name} — ${f.role}. ${f.background}`, sourceUrl: c.evidence[0]?.url })),
      });

      return assessPromising({
        company: c,
        fit,
        reviewStatus: meta[c.id]?.reviewStatus,
        confirmedDuplicate: duplicateCompanyIds.has(c.id),
        inactive: !!quarantine[c.id],
        qualityBand: quality.band,
        qualityPriority: quality.priority,
        qualitySignals: quality.signals,
      });
    },
    [meta, duplicateCompanyIds, quarantine],
  );

  const rows = useMemo(() => {
    const filtered = companies
      .map((c) => ({ c, fit: scoreCompany(c) }))
      .filter(({ c, fit }) => {
        if (verticals.size > 0 && !verticals.has(c.vertical)) return false;
        if (stage !== 'all' && c.stage !== stage) return false;
        if (state !== 'all' && c.state !== state) return false;
        if (possibleDuplicateOnly && !duplicateCompanyIds.has(c.id)) return false;
        if (missingInfoOnly && !hasMissingInfo(c)) return false;
        if (minEvidenceConfidence > 0 && fit.evidenceConfidence < minEvidenceConfidence) return false;
        if (assessedOnly && fit.provisional) return false;
        if (needsDiligenceOnly && !promisingVerdict(c, fit).needsDiligence) return false;
        if (promisingOnly && !promisingVerdict(c, fit).eligible) return false;
        if (notReviewedDays !== '') {
          const lastTouch = meta[c.id]?.lastRefreshed ?? meta[c.id]?.discoveredAt;
          const age = daysSince(lastTouch);
          if (age === null || age < notReviewedDays) return false;
        }

        const opp = opportunities[c.id];
        const qual = qualifications[c.id];
        const quar = quarantine[c.id];

        // Quarantined records are hidden by default. They are disqualified
        // entities kept for audit, not review-queue material — but they
        // stay one checkbox away rather than being silently erased.
        if (quar && !includeQuarantined) return false;

        // An unclassified company counts as a lead, never as a deal.
        const cls: OpportunityClass = opp?.classification ?? 'company-lead';
        if (oppClass !== 'all' && cls !== oppClass) return false;
        if (liveOnly && !isLiveDeal(cls)) return false;
        if (leadsOnly && isLiveDeal(cls)) return false;
        if (primarySource !== 'all' && (opp?.primarySourceId ?? 'none') !== primarySource) return false;
        if (tierFilter !== 'all' && String(opp?.primaryTier ?? '') !== tierFilter) return false;
        if (verifiedAmountOnly && opp?.amountUsd == null) return false;
        if (verifiedRoundOnly && !opp?.roundType) return false;
        // "Corroborated" means the same thing here as it does in
        // qualification and on the shortlist — an independent financing
        // source AND the issuer describing a real business. It used to be a
        // bare count of >= 2 sources that included the company's own site.
        if (missingCorroboration && meetsOperatingCompanyStandard({
          independentFinancingSources: qual?.corroboratingSources.length ?? 0,
          operatingEvidence: qual?.operatingEvidence?.level ?? 'not-checked',
        })) return false;
        if (humanReviewOnly && qual?.result !== 'human-review-required') return false;
        if (publicWarnOnly && !qual?.isPubliclyTraded) return false;
        if (fundWarnOnly && !qual?.isFundOrSpv) return false;
        if (evidenceSince) {
          const d = opp?.evidencePublishedAt;
          if (!d || d < evidenceSince) return false;
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
    // Strongest opportunities first, with assessed companies always ahead
    // of provisional ones — a provisional score measures our sourcing, not
    // the company, so it must not lead the queue.
    else filtered.sort((a, b) =>
      Number(a.fit.provisional) - Number(b.fit.provisional)
      || b.fit.score - a.fit.score);
    return filtered;
  }, [companies, verticals, stage, state, q, sortMode, possibleDuplicateOnly, missingInfoOnly,
      minEvidenceConfidence, notReviewedDays, duplicateCompanyIds, meta,
      opportunities, qualifications, quarantine, oppClass, primarySource, tierFilter,
      liveOnly, leadsOnly, verifiedAmountOnly, verifiedRoundOnly, missingCorroboration,
      humanReviewOnly, publicWarnOnly, fundWarnOnly, includeQuarantined, evidenceSince, assessedOnly,
      promisingOnly, needsDiligenceOnly, promisingVerdict]);

  const select = 'rounded-[2px] border border-line bg-panel px-2 py-1.5 text-xs transition-colors focus:border-marigold';
  const allVisibleSelected = rows.length > 0 && rows.every(({ c }) => selected.has(c.id));

  // Exports the rows as filtered and sorted, so the file always matches
  // what the reviewer is looking at.
  const exportCsv = () => {
    downloadCsv(rows.map(({ c, fit }) => ({
      company: c,
      fit,
      opportunity: opportunities[c.id],
      qualification: qualifications[c.id],
      quarantine: quarantine[c.id],
      reviewStatus: meta[c.id]?.reviewStatus,
      // The export carries the resolution state alongside every enriched
      // value. A spreadsheet outlives the screen it came from, so a value
      // that needed a qualifier on screen needs it more here.
      enrichment: enrichment[c.id],
    })));
  };

  /**
   * Expand or collapse a company's detail panel.
   *
   * Every path that changes which panel is open goes through here, so
   * the unsaved-note check cannot be bypassed by whichever row cell or
   * keyboard shortcut a reviewer happens to use. Collapsing counts too:
   * the draft lives in the panel, so closing it loses the work just as
   * surely as switching companies does.
   */
  const requestOpen = (next: string | null) => {
    if (next === openId) return;
    if (!confirmLeaveUnsavedNotes()) return;
    setOpenId(next);
  };

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
      <div className="mb-3 border border-line bg-panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, founder, website, keyword…"
            className={`${select} w-64`}
            aria-label="Search companies"
          />
          {showVertical && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by vertical — select one or more">
              <button
                type="button"
                onClick={() => setVerticals(new Set())}
                aria-pressed={verticals.size === 0}
                className={`rounded-[2px] border px-2 py-1.5 text-xs font-semibold transition-colors ${
                  verticals.size === 0 ? 'border-marigold bg-marigold-soft text-marigold' : 'border-line bg-panel text-slate-mid hover:border-marigold hover:text-marigold'
                }`}
              >
                All verticals
              </button>
              {VERTICALS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => toggleVertical(v.id)}
                  aria-pressed={verticals.has(v.id)}
                  className={`rounded-[2px] border px-2 py-1.5 text-xs transition-colors ${
                    verticals.has(v.id) ? 'border-marigold bg-marigold-soft font-semibold text-marigold' : 'border-line bg-panel text-slate-mid hover:border-marigold hover:text-marigold'
                  }`}
                >
                  {v.name}
                </button>
              ))}
            </div>
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
          <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-mid">{rows.length} compan{rows.length === 1 ? 'y' : 'ies'}</span>
          <button
            type="button"
            className={btnGhost}
            disabled={rows.length === 0}
            onClick={exportCsv}
            title={rows.length === 0
              ? 'Nothing to export — no companies match the current filters.'
              : `Download these ${rows.length} row(s) as CSV, exactly as filtered and sorted. Includes the fit score with its completeness and provisional flag, the qualification verdict, any disqualification reason, and the evidence URL.`}
          >
            Export CSV
          </button>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-2.5 text-xs text-slate-mid">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={possibleDuplicateOnly} onChange={(e) => setPossibleDuplicateOnly(e.target.checked)} />
            Possible duplicate only
          </label>
          {!DEMO_MODE && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={missingInfoOnly} onChange={(e) => setMissingInfoOnly(e.target.checked)} />
              Missing information only
            </label>
          )}
          {!DEMO_MODE && (
            <label className="flex items-center gap-1.5">
              Min. evidence confidence
              <input
                type="number" min={0} max={100} step={5} className={`${select} w-16`}
                value={Math.round(minEvidenceConfidence * 100)}
                onChange={(e) => setMinEvidenceConfidence(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
              />%
            </label>
          )}
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

        {/* Opportunity-trust filters. Separated from the descriptive
            filters above because these answer a different question:
            not "which companies" but "which of these is actually a deal".
            Hidden in the demo build only — a simpler filter bar for a
            documentation/team-demo audience; the real analyst tool is
            unaffected (DEMO_MODE is a build-time constant). */}
        {!DEMO_MODE && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
            Opportunity &amp; evidence
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-mid">
            <select className={select} value={oppClass} onChange={(e) => setOppClass(e.target.value as typeof oppClass)}>
              <option value="all">All classifications</option>
              {OPPORTUNITY_CLASSES.map((c) => (
                <option key={c} value={c}>{OPPORTUNITY_CLASS_LABELS[c]}</option>
              ))}
            </select>
            <select className={select} value={primarySource} onChange={(e) => setPrimarySource(e.target.value)}>
              <option value="all">Any primary source</option>
              {primarySources.map((sid) => <option key={sid} value={sid}>{sid}</option>)}
            </select>
            <select className={select} value={tierFilter} onChange={(e) => setTierFilter(e.target.value as typeof tierFilter)}>
              <option value="all">Any source tier</option>
              <option value="1">Tier 1 only</option>
              <option value="2">Tier 2 only</option>
              <option value="3">Tier 3 only</option>
            </select>
            <label className="flex items-center gap-1.5">
              Evidence since
              <input type="date" className={select} value={evidenceSince} onChange={(e) => setEvidenceSince(e.target.value)} />
            </label>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-mid">
            <label className="flex items-center gap-1.5" title="Recent financing, fundraising signal, or verified opportunity.">
              <input type="checkbox" checked={liveOnly} onChange={(e) => { setLiveOnly(e.target.checked); if (e.target.checked) setLeadsOnly(false); }} />
              Live opportunities only
            </label>
            <label className="flex items-center gap-1.5" title="Companies that exist but show no current financing or fundraising evidence.">
              <input type="checkbox" checked={leadsOnly} onChange={(e) => { setLeadsOnly(e.target.checked); if (e.target.checked) setLiveOnly(false); }} />
              Company leads only
            </label>
            <label className="flex items-center gap-1.5" title="An amount actually stated by a tier 1–2 source.">
              <input type="checkbox" checked={verifiedAmountOnly} onChange={(e) => setVerifiedAmountOnly(e.target.checked)} />
              Verified amount
            </label>
            <label className="flex items-center gap-1.5" title="A round type actually stated by the source.">
              <input type="checkbox" checked={verifiedRoundOnly} onChange={(e) => setVerifiedRoundOnly(e.target.checked)} />
              Verified round
            </label>
            <label
              className="flex items-center gap-1.5"
              title="No independent financing source, or no substantive evidence that the issuer describes an operating business."
            >
              <input type="checkbox" checked={missingCorroboration} onChange={(e) => setMissingCorroboration(e.target.checked)} />
              Missing corroboration
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={humanReviewOnly} onChange={(e) => setHumanReviewOnly(e.target.checked)} />
              Human review required
            </label>
            <label
              className="flex items-center gap-1.5"
              title="Hide provisional scores. A score is fully assessed only when thesis fit, stage, traction, founders and geography could ALL be judged, at least 60% of the model was assessable, and the record cites a source. Anything short of that is normalized over too little evidence to compare with an assessed score, and is excluded from High-Fit."
            >
              <input type="checkbox" checked={assessedOnly} onChange={(e) => setAssessedOnly(e.target.checked)} />
              Fully assessed only (hide provisional)
            </label>
            <label
              className="flex items-center gap-1.5"
              title="Every provisional record that is in-thesis, active, not a confirmed duplicate, and still missing a critical component. This is the broad work list — Promising is a strict subset of it."
            >
              <input
                type="checkbox"
                data-testid="needs-diligence-filter"
                checked={needsDiligenceOnly}
                onChange={(e) => setNeedsDiligenceOnly(e.target.checked)}
              />
              Needs Diligence
            </label>
            <label
              className="flex items-center gap-1.5"
              title="Provisional records that still look worth researching: they pass the thesis filter, are active and not confirmed duplicates, show quality-priority signals or already score at or above the Track threshold on what could be judged, and are missing at least one critical component that could change the score. This is a work list — it never counts toward High-Fit and never changes a score."
            >
              <input
                type="checkbox"
                data-testid="promising-filter"
                checked={promisingOnly}
                onChange={(e) => setPromisingOnly(e.target.checked)}
              />
              Promising — Needs Diligence
            </label>
            <label className="flex items-center gap-1.5" title="Issuer has an exchange ticker or files periodic reports.">
              <input type="checkbox" checked={publicWarnOnly} onChange={(e) => setPublicWarnOnly(e.target.checked)} />
              Public-company warning
            </label>
            <label className="flex items-center gap-1.5" title="Fund, SPV, or project vehicle.">
              <input type="checkbox" checked={fundWarnOnly} onChange={(e) => setFundWarnOnly(e.target.checked)} />
              Fund/SPV warning
            </label>
            <label className="flex items-center gap-1.5" title="Disqualified records are kept for audit and hidden from the queue by default.">
              <input type="checkbox" checked={includeQuarantined} onChange={(e) => setIncludeQuarantined(e.target.checked)} />
              Show disqualified ({quarantinedCount})
            </label>
          </div>
        </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft px-3 py-2.5 text-xs">
          <span className="font-semibold text-ink">{selected.size} selected</span>
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
        <div className="mb-3 border border-line bg-panel px-3 py-2 text-xs">
          <span className="font-semibold">Bulk "{bulkResult.status}"</span>: {bulkResult.updated} updated
          {bulkResult.skipped.length > 0 && `, ${bulkResult.skipped.length} skipped (${bulkResult.skipped.map((s) => s.reason).join('; ')})`}.
          <button className="ml-2 text-slate-mid hover:text-ink" onClick={() => setBulkResult(null)}>Dismiss ✕</button>
        </div>
      )}

      <div
        className="overflow-x-auto border border-line bg-panel"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          if (rows.length === 0) return;
          e.preventDefault();
          const idx = rows.findIndex(({ c }) => c.id === openId);
          const nextIdx = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
          requestOpen(rows[idx === -1 ? 0 : nextIdx].c.id);
        }}
        aria-label="Company review queue — arrow keys move between an expanded company and its neighbor"
      >
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-ink text-white">
              <th className="px-3 py-2"><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all visible companies" /></th>
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Fit</th>
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Company</th>
              {showVertical && <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Vertical</th>}
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Subcategory</th>
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Stage</th>
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">HQ</th>
              <th className="px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">Founder</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={showVertical ? 8 : 7} className="px-3 py-12 text-center text-slate-mid">
                  <RadarEmptyGlyph />
                  <p className="mt-3">No companies are on record here. Clear a filter, run Deal Discovery, or import a CSV under Settings.</p>
                </td>
              </tr>
            )}
            {rows.map(({ c, fit }, i) => {
              const open = openId === c.id;
              const isDuplicate = duplicateCompanyIds.has(c.id);
              const next = nextActionTag(fit, meta[c.id]);
              return (
                <FragmentRow key={c.id}>
                  <tr
                    className={`border-b border-line align-top transition-colors hover:bg-marigold-soft/30 ${open ? 'bg-marigold-soft/30' : ''}`}
                    data-row-index={i}
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelectOne(c.id)} aria-label={`Select ${c.name}`} />
                    </td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => requestOpen(open ? null : c.id)}>
                      <ScoreGauge score={fit.score} size={38} />
                      {/*
                        Marked on the ROW, not only in the triage column.
                        Every company here is "Awaiting review", so the
                        triage label always resolves to "First review" and
                        would hide this entirely — leaving a provisional
                        6.7 looking exactly like an assessed 6.7.
                      */}
                      {fit.provisional && (
                        <div
                          className="mt-0.5 font-mono text-[9px] uppercase text-marigold"
                          title={fit.provisionalReason ?? undefined}
                        >
                          prov.
                        </div>
                      )}
                    </td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => requestOpen(open ? null : c.id)}>
                      <div className="font-semibold text-ink">{c.name}</div>
                      <div className="max-w-xs text-xs text-slate-mid">{c.oneLiner}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <OpportunityBadges
                          opportunity={opportunities[c.id]}
                          qualification={qualifications[c.id]}
                          quarantined={quarantine[c.id]}
                        />
                        <span className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide ${next.cls}`}>{next.label}</span>
                        {fit.exceptions.map((e) => <ExceptionBadge key={e.flag} flag={e.flag} />)}
                        {isDuplicate && (
                          <span className="rounded-[2px] border border-alerta/30 bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta" title="A possible duplicate is pending review — see the expanded row.">
                            Possible duplicate
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Vertical, stage, and founder read the ENRICHMENT payload, not the
                        raw company columns. The raw columns still hold 'Unknown' for most
                        records; the enrichment carries a resolution state and a summary, so
                        a cell can say what was searched instead of shrugging. */}
                    {showVertical && <td className="cursor-pointer px-3 py-2.5 text-xs" onClick={() => requestOpen(open ? null : c.id)}><VerticalCell enrichment={enrichment[c.id]} /></td>}
                    <td className="cursor-pointer px-3 py-2.5 text-xs" onClick={() => requestOpen(open ? null : c.id)}>{c.subcategory}</td>
                    <td className="cursor-pointer px-3 py-2.5 text-xs font-medium" onClick={() => requestOpen(open ? null : c.id)}><StageCell enrichment={enrichment[c.id]} /></td>
                    <td className="cursor-pointer px-3 py-2.5 whitespace-nowrap text-xs" onClick={() => requestOpen(open ? null : c.id)}>{c.city}, {c.state}</td>
                    <td className="cursor-pointer px-3 py-2.5" onClick={() => requestOpen(open ? null : c.id)}>
                      <FounderCell enrichment={enrichment[c.id]} />
                      <IdentityChips founders={c.founders} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={showVertical ? 8 : 7} className="px-4 py-5">
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

/** Empty-state glyph reusing the radar-sweep motif — an invitation, not a dead end. */
function RadarEmptyGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mx-auto text-line" aria-hidden>
      <circle cx="20" cy="20" r="17" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="10.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** One fact row: label, value (or an honest "Missing"), and its provenance — reused across memo sections. */
function FactRow({ label, value, kind, href }: { label: string; value: string | null; kind?: ProvenanceKind | null; href?: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="w-36 shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-mid">{label}</span>
      {value ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{value.replace('https://', '')}</a>
          ) : (
            <span className={value.toLowerCase().includes('unknown') ? 'italic text-slate-mid' : 'text-ink'}>{value}</span>
          )}
          {kind && <ProvenanceTag kind={kind} />}
        </span>
      ) : (
        <ProvenanceTag kind="missing" />
      )}
    </div>
  );
}

/** A memo section: an id for the table of contents, a mono section number, and a title. */
function MemoSection({ n, id, title, flag, children }: { n: string; id: string; title: string; flag?: boolean; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-line py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-slate-mid">
        <span className="text-marigold">{n}</span>
        {title}
        {flag && <span className="inline-block h-1.5 w-1.5 rounded-full bg-alerta" aria-hidden title="Needs attention" />}
      </h3>
      {children}
    </section>
  );
}

const TOC: { id: string; label: string }[] = [
  { id: 'overview', label: 'Company overview' },
  { id: 'thesis-fit', label: 'Thesis fit' },
  { id: 'founders', label: 'Founders' },
  { id: 'funding-traction', label: 'Funding & traction' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'risks', label: 'Risks & open questions' },
  { id: 'recommendation', label: 'Recommendation' },
  { id: 'notes', label: 'Internal notes' },
  { id: 'ai-analysis', label: 'AI analysis' },
  { id: 'provenance', label: 'Review history' },
];

export function CompanyDetail({ c, duplicates = [], onDuplicatesChange }: {
  c: Company;
  duplicates?: PossibleDuplicateEntry[];
  onDuplicatesChange?: (updater: (prev: PossibleDuplicateEntry[]) => PossibleDuplicateEntry[]) => void;
}) {
  const fit = scoreCompany(c);
  const { meta, opportunities, qualifications, dealEvidence, quarantine, enrichment, refresh } = useCompanies();
  const m = meta[c.id];
  const opportunity = opportunities[c.id];
  const qualification = qualifications[c.id];
  const evidenceRows = dealEvidence[c.id] ?? [];
  const quarantined = quarantine[c.id];
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

  const RECOGNIZED_KINDS = ['verified', 'user-entered', 'extracted', 'ai-inferred', 'unverified', 'missing'] as const;
  const originKind = (field: string): ProvenanceKind | null => {
    const o = m?.provenance?.[field];
    if (!o) return null;
    return (RECOGNIZED_KINDS as readonly string[]).includes(o) ? (o as ProvenanceKind) : null;
  };

  // ── Company overview — the facts a partner reads first.
  const overviewFacts: { label: string; value: string | null; field?: string; href?: string }[] = [
    { label: 'Website', value: c.website ?? null, field: 'website', href: c.website },
    { label: 'Description', value: c.oneLiner, field: 'oneLiner' },
    { label: 'Stage', value: c.stage, field: 'stage' },
    { label: 'Geography', value: c.city !== 'Unknown' || c.state !== '??' ? `${c.city}, ${c.state}` : null, field: 'city' },
    { label: 'Vertical', value: `${verticalById(c.vertical).name} → ${c.subcategory}`, field: 'vertical' },
  ];

  // ── Funding & traction — separate from overview so both get real room.
  const fundingFacts: { label: string; value: string | null; field?: string }[] = [
    { label: 'Funding', value: c.raising ?? null, field: 'raising' },
    { label: 'Last funding date', value: c.lastFundingDate ?? null, field: 'lastFundingDate' },
    { label: 'Accelerator', value: c.accelerator ?? null, field: 'accelerator' },
    { label: 'Founded', value: String(c.foundedYear) },
    { label: 'Team size', value: String(c.teamSize) },
  ];

  // ── Missing information: exactly what we do not know.
  const missing: string[] = [];
  if (!c.website) missing.push('Website');
  if (c.city === 'Unknown' && c.state === '??') missing.push('Location');
  if (!c.raising) missing.push('Funding amount');
  if (!c.lastFundingDate) missing.push('Last funding date');
  if (!c.accelerator) missing.push('Accelerator participation (none recorded)');
  // These read the RESEARCHED state, not the raw columns. "Founder
  // backgrounds require manual research" and "Subcategory classification"
  // were listed for almost every company and told a reviewer nothing about
  // which records were actually worth their next ten minutes.
  const enriched = enrichment[c.id];
  if (!enriched) {
    missing.push('Founder, sector, and stage (not yet researched — use “Research now” in the Founders section)');
  } else {
    if (enriched.founder.state !== 'confirmed') missing.push(`Founder — ${enriched.founder.summary}`);
    if (enriched.vertical.state !== 'confirmed') missing.push(`Sector — ${enriched.vertical.summary}`);
    if (enriched.stage.state !== 'confirmed') missing.push(`Stage — ${enriched.stage.summary}`);
  }
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
    : fit.score >= HOT_THRESHOLD ? 'Prioritize: assign an owner, approve outreach, and add to HubSpot.'
    : fit.score >= TRACK_THRESHOLD ? `Track actively and close the weakest evidence gap (${[...fit.components].sort((a, b) => a.points / a.max - b.points / b.max)[0].label.toLowerCase()}).`
    : 'Monitor; revisit when traction or evidence improves.';

  const scoreTone = fit.score >= 7.5 ? 'border-l-verde' : fit.score >= 5.5 ? 'border-l-marigold' : 'border-l-slate-mid';
  const hasOpenQuestions = missing.length > 0 || risks.length > 0 || duplicates.length > 0;

  return (
    <div>
      {refreshResult && (
        <div className="mb-4 border border-verde/40 border-l-[3px] border-l-verde bg-verde-soft/30 px-3 py-2.5 text-xs">
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

      <div className="lg:flex lg:items-start lg:gap-6">
        {/* ── Inspector rail: score, status, and every action, always in view. ── */}
        <aside className="mb-5 lg:sticky lg:top-12 lg:mb-0 lg:w-60 lg:shrink-0">
          <div className={`border border-line ${scoreTone} border-l-[3px] bg-panel px-3.5 py-3`}>
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Vamos Fit Score</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-display text-3xl font-bold leading-none text-ink">{fit.score.toFixed(1)}</span>
              <span className="font-mono text-xs text-slate-mid">/10</span>
              {fit.provisional && (
                <span className="ml-auto rounded-[2px] bg-marigold-soft px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-marigold">
                  Provisional
                </span>
              )}
            </div>
            {fit.provisional && (
              <p className="mt-1.5 text-[10px] leading-relaxed text-marigold">
                {fit.provisionalReason}
              </p>
            )}
            <div className="mt-2 space-y-1 border-t border-line pt-2 font-mono text-[10px] text-slate-mid">
              <div className="flex items-center justify-between gap-2">
                <span>Vamos Fit Score:</span><span className="text-ink">{fit.score.toFixed(1)}/10</span>
              </div>
              {/*
                Model-assessable %, evidence confidence, and the scoring
                model version were removed from this panel. They describe
                how the number was computed, not the company, and a
                reviewer deciding whether to take a meeting has no action
                to take on any of them.

                The per-component breakdown below still shows which parts
                could not be judged and why, which is the same
                information at the altitude where it is actionable.
              */}
            </div>
            <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2">
              {m?.reviewStatus && <span className="rounded-[2px] bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-marigold">{m.reviewStatus}</span>}
              {m?.stale && (
                <span className="rounded-[2px] bg-alerta-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-alerta" title="Not reviewed or refreshed within the administrator-configured threshold (Settings → Stale-record settings).">
                  Stale
                </span>
              )}
            </div>
          </div>

          {/* Opportunity status. Deliberately adjacent to the fit score:
              a high score on a company that is not raising is not a deal,
              and the two facts belong side by side. */}
          <div className="mt-3 border border-line bg-panel px-3.5 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Opportunity status</div>
            <div className="mt-1.5">
              <OpportunityBadges opportunity={opportunity} qualification={qualification} quarantined={quarantined} />
            </div>
            {opportunity && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                <EvidenceSummary opportunity={opportunity} />
              </div>
            )}
            <div className="mt-2.5 border-t border-line pt-2.5">
              <QualificationExplainer opportunity={opportunity} qualification={qualification} quarantined={quarantined} />
            </div>
            {evidenceRows.length > 0 && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                <ReportingSources evidence={evidenceRows} />
              </div>
            )}
            {/* An unverified website is the single most common reason a
                real company is held as a lead, and it is the one gap a
                person can close in a minute with a source in front of
                them. So the action lives here, next to the verdict that
                explains why it matters — not buried in an edit form. */}
            <div className="mt-2.5 border-t border-line pt-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Official website</div>
              <div className="mt-1.5">
                <WebsiteConfirmationPanel
                  companyId={c.id}
                  companyName={c.name}
                  currentWebsite={c.website ?? null}
                  onDone={refresh}
                />
              </div>
            </div>
          </div>

          <div className="mt-3 border border-line bg-panel px-3.5 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Review status</div>
            <div className="mt-2 flex flex-col gap-1.5">
              <button className={`${btnGhost} w-full`} disabled={!!statusBusy} onClick={markReviewed} title="Stamps today as the date this record was last looked at, which clears the Stale flag. It does not change the queue status — use Send for research, Monitor, or Pass for that.">
                {statusBusy === 'Mark reviewed' ? 'Stamping…' : 'Stamp reviewed today'}
              </button>
              {/*
                Previously labelled "Mark reviewed", which read as a
                decision. It only stamps the last-reviewed date (clearing
                staleness) — the queue status is unchanged, so a reviewer
                clicked it and saw the "Awaiting review" badge stay put
                with nothing explaining why. The three buttons below are
                the ones that actually move a company through the queue.
              */}
              <p className="text-[10px] leading-relaxed text-slate-mid">
                Records the date only — clears Stale. To move this company through the queue, use one of the three below.
              </p>
              <button className={`${btnGhost} w-full`} disabled={!!statusBusy} onClick={refreshLiveResearch} title="Re-query live sources for this company and report what changed">
                {statusBusy === 'Refresh live research' ? 'Researching…' : 'Refresh live research'}
              </button>
              <button className={`${btnGhost} w-full`} disabled={!!statusBusy} onClick={() => setStatus('Research Needed')}>
                {statusBusy === 'Research Needed' ? 'Saving…' : 'Send for research'}
              </button>
              <button className={`${btnGhost} w-full`} disabled={!!statusBusy} onClick={() => setStatus('Monitor')}>
                {statusBusy === 'Monitor' ? 'Saving…' : 'Monitor'}
              </button>
              <button className={`${btnGhost} w-full`} disabled={!!statusBusy} onClick={() => setStatus('Passed')}>
                {statusBusy === 'Passed' ? 'Saving…' : 'Pass'}
              </button>
            </div>
          </div>

          <div className="mt-3 border border-line bg-panel px-3.5 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Team actions</div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-mid">Every external step gets a human review screen first.</p>
            <div className="mt-2 flex flex-col gap-1.5">
              <button
                className={`${btnPrimary} w-full`}
                disabled={!!statusBusy}
                onClick={() => setStatus('Approved for HubSpot', () => setModal('hubspot'))}
              >
                Approve &amp; add to HubSpot
              </button>
              <button className={`${btnGhost} w-full`} onClick={() => setModal('outreach')}>
                Generate founder outreach
              </button>
            </div>
            {statusNote && <p className="mt-2 text-xs text-alerta">{statusNote}</p>}
          </div>

          <nav aria-label="Memo sections" className="mt-3 hidden border border-line bg-panel px-3.5 py-3 lg:block">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">On this record</div>
            <ul className="mt-1.5 space-y-1">
              {TOC.map((t) => (
                <li key={t.id}>
                  <a href={`#${c.id}-${t.id}`} className="flex items-center gap-1.5 text-xs text-slate-mid transition-colors hover:text-marigold">
                    {t.id === 'risks' && hasOpenQuestions && <span className="h-1 w-1 rounded-full bg-alerta" aria-hidden />}
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* ── Memo: the investment-committee read. ── */}
        <div className="min-w-0 flex-1">
          {modal === 'hubspot' && <HubSpotModal c={c} onClose={() => setModal(null)} />}
          {modal === 'outreach' && <OutreachPanel c={c} onClose={() => setModal(null)} />}

          <MemoSection n="01" id={`${c.id}-overview`} title="Company overview">
            <div className="grid gap-x-6 sm:grid-cols-2">
              {overviewFacts.map((f) => <FactRow key={f.label} label={f.label} value={f.value} kind={f.field ? originKind(f.field) : null} href={f.href} />)}
            </div>
          </MemoSection>

          <MemoSection
            n="02"
            id={`${c.id}-thesis-fit`}
            title={`Thesis fit — ${fit.score.toFixed(1)}/10 from ${fit.assessablePoints} assessable pts (${Math.round(fit.completeness * 100)}% of the model)`}
          >
            <p className="mb-2.5 text-xs text-slate-mid">
              Scored over the components that could be judged from what is on record. Components marked{' '}
              <span className="font-mono text-[10px] uppercase text-marigold">not assessed</span> are excluded from the
              score entirely rather than counted as zero — they are gaps in our data, not findings against the company.
            </p>
            <ul className="space-y-2.5">
              {fit.components.map((comp) => (
                <li key={comp.key} className={comp.assessable ? '' : 'opacity-70'}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium text-ink">
                      {comp.label}
                      {!comp.assessable && (
                        <span className="ml-1.5 rounded-[2px] border border-marigold/40 px-1 font-mono text-[9px] uppercase text-marigold">
                          not assessed
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-xs font-semibold tabular-nums">
                      {comp.assessable ? `${comp.points}/${comp.max}` : `— /${comp.max}`}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-line">
                    {comp.assessable && (
                      <div className="h-1 bg-verde" style={{ width: `${(comp.points / comp.max) * 100}%` }} />
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-mid">{comp.rationale}</p>
                </li>
              ))}
            </ul>
            {fit.exceptions.length > 0 && (
              <div className="mt-3 space-y-2">
                {fit.exceptions.map((e) => (
                  <div key={e.flag} className="border border-alerta/40 border-l-[3px] border-l-alerta bg-alerta-soft px-3 py-2 text-xs text-alerta">
                    <ExceptionBadge flag={e.flag} /> <span className="mt-1 block text-ink/80">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </MemoSection>

          <MemoSection n="03" id={`${c.id}-founders`} title="Founders, sector & stage">
            {/*
              The enrichment panel leads, because it is the sourced view:
              every field carries its resolution state, the evidence, the
              source families attempted, the last-researched date, and the
              next action. The raw founder rows below are what the original
              import recorded, kept for comparison.
            */}
            <EnrichmentPanel
              companyId={c.id}
              enrichment={enrichment[c.id]}
              onChanged={() => { void refresh(); }}
            />
            {c.founders.some((f) => !f.name.toLowerCase().includes('unknown')) && (
              <div className="mt-3 border-t border-line pt-2">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-slate-mid">
                  As originally imported
                </p>
                <div className="space-y-1.5">{c.founders.map((f) => <FounderLine key={f.name} f={f} />)}</div>
              </div>
            )}
            <p className="mt-1.5 text-[11px] italic text-slate-mid">
              Founder identity indicators come only from explicit public statements, approved data, or user entry —
              never inferred from names, photos, appearance, language, or geography.
            </p>
          </MemoSection>

          <MemoSection n="04" id={`${c.id}-funding-traction`} title="Funding & traction">
            <div className="grid gap-x-6 sm:grid-cols-2">
              {fundingFacts.map((f) => <FactRow key={f.label} label={f.label} value={f.value} kind={f.field ? originKind(f.field) : null} />)}
            </div>
            <div className="mt-2.5 border-t border-line pt-2.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-mid">Traction signal</span>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 w-32 bg-line"><div className="h-1 bg-verde" style={{ width: `${(c.traction.level / 10) * 100}%` }} /></div>
                <span className="font-mono text-xs tabular-nums text-ink">{c.traction.level}/10</span>
              </div>
              <p className="mt-1 text-xs text-slate-mid">{c.traction.note}</p>
            </div>
          </MemoSection>

          <MemoSection n="05" id={`${c.id}-evidence`} title={`Evidence & source URLs (${c.evidence.length})`}>
            {(m?.addedEvidence?.length ?? 0) > 0 && (
              <div className="mb-3 border border-marigold/40 border-l-[3px] border-l-marigold bg-marigold-soft/50 px-3 py-2 text-xs">
                <span className="font-semibold text-ink">Evidence added from discovery (appended, never overwritten):</span>
                <ul className="mt-0.5 list-disc pl-4 text-slate-mid">
                  {m!.addedEvidence!.map((e, i) => (
                    <li key={i}>{e.claim} — {e.source}, {e.date} (<a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">source</a>)</li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="space-y-2">
              {c.evidence.map((e) => (
                <li key={e.url} className="border border-line bg-panel px-3 py-2 text-xs transition-colors hover:border-verde/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-ink">{e.claim}</div>
                    <ProvenanceTag kind="verified">Sourced</ProvenanceTag>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-slate-mid">
                    <span className="rounded-[2px] bg-paper px-1 py-0.5 font-mono text-[10px] uppercase">{e.type}</span>
                    <a href={e.url} target="_blank" rel="noreferrer" className="text-verde underline decoration-dotted">{e.source}</a>
                    <span className="font-mono">{e.date}</span>
                  </div>
                </li>
              ))}
            </ul>
          </MemoSection>

          <MemoSection n="06" id={`${c.id}-risks`} title="Risks & open questions" flag={hasOpenQuestions}>
            {duplicates.length > 0 && (
              <div className="mb-3 border border-alerta/40 border-l-[3px] border-l-alerta bg-alerta-soft px-3 py-2.5 text-xs">
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
            <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-mid">Open questions — what we don't know</h4>
            {missing.length === 0 ? (
              <p className="text-xs text-slate-mid">No gaps detected in the recorded facts.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-slate-mid">
                {missing.map((x) => <li key={x}>{x}</li>)}
              </ul>
            )}
            <h4 className="mb-1.5 mt-4 font-mono text-[10px] uppercase tracking-wider text-slate-mid">Risks</h4>
            {risks.length === 0 ? (
              <p className="text-xs text-slate-mid">No risks flagged by the scoring model.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-slate-mid">
                {risks.map((x) => <li key={x}>{x}</li>)}
              </ul>
            )}
          </MemoSection>

          <MemoSection n="07" id={`${c.id}-recommendation`} title="Recommendation">
            <p className="border-l-2 border-marigold pl-4 font-display text-xl italic leading-snug text-ink">{nextStep}</p>
          </MemoSection>

          {/*
            Placed directly after the recommendation, because that is the
            moment a reviewer has an opinion worth writing down — and
            deliberately AFTER the evidence section, so a note is written
            against the record rather than instead of it.
          */}
          {/*
            Traction review sits immediately before internal notes: it is
            the one diligence step that changes a SCORING component, so it
            belongs with the record rather than in the notes a reviewer
            writes about it.
          */}
          <MemoSection n="08" id={`${c.id}-traction`} title="Traction review">
            <PendingEvidencePanel companyId={c.id} />
            <TractionReview companyId={c.id} onSaved={() => void refresh()} />
          </MemoSection>

          <MemoSection n="09" id={`${c.id}-notes`} title="Internal notes">
            <CompanyNotes companyId={c.id} />
          </MemoSection>

          <div id={`${c.id}-ai-analysis`} className="scroll-mt-16">
            <AiAnalysis c={c} />
          </div>

          <MemoSection n="10" id={`${c.id}-provenance`} title="Review history & sync">
            <div className="grid gap-x-6 sm:grid-cols-2">
              <FactRow label="Discovered" value={m?.discoveredAt ? `${m.discoveredAt}${m.discoverySource ? ` via ${m.discoverySource}` : ''}` : null} />
              <FactRow label="Last refreshed" value={c.lastRefreshed ?? m?.lastRefreshed ?? null} />
              <FactRow label="Review status" value={m?.reviewStatus ?? 'New'} />
              <FactRow label="HubSpot sync" value={m?.hubspotCompanyId ? `Synced — record ${m.hubspotCompanyId}` : 'Not synced'} />
            </div>
          </MemoSection>
        </div>
      </div>
    </div>
  );
}
