import { getDb } from '../db/client';
import { getCompany, listCompanies } from '../db/repos/companies';
import { addDealEvidence, listDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import { latestScore } from '../db/repos/operations';
import { tierOf } from '../../shared/opportunity';
import {
  assessDiversity, familyOf, isLiveDeal,
  MAX_YC_PRIMARY_PER_SECTOR, TARGET_SOURCE_FAMILIES_PER_SECTOR,
  type DealEvidence, type DiversityReport, type Opportunity, type OpportunityType,
} from '../../shared/opportunity';
import { MAX_SEC_PRIMARY_PER_SECTOR } from '../../shared/qualification';
import type { VerticalId } from '../../src/types';

/**
 * Turning candidates into a defensible per-sector shortlist.
 *
 * The rules here exist because the previous shortlist was five arbitrary
 * Y Combinator companies per sector. Each rule is a constraint on what
 * may be SHOWN as an opportunity, not on what may be stored — a company
 * that fails them stays in the database as a lead.
 */

/**
 * Map a candidate's originating source onto the kind of event its
 * evidence actually describes. This is where "what the source is" gets
 * translated into "what it proves", and it is deliberately conservative:
 * GitHub and arXiv can never assert a financing event.
 */
export function opportunityTypeForSource(sourceId: string): OpportunityType {
  switch (sourceId) {
    case 'sec': return 'form-d-filing';
    case 'funding-news': return 'funding-announcement';
    case 'grants': return 'government-award';
    case 'yc': return 'accelerator-batch';
    case 'producthunt': return 'product-launch';
    // GitHub and arXiv are supporting evidence only. 'none' keeps them
    // out of every financing branch of the classifier.
    case 'github':
    case 'research':
    default: return 'none';
  }
}

/**
 * The fields deal-evidence construction actually needs. Declared
 * structurally rather than as the full DiscoveryCandidate so it accepts
 * both an adapter's RawCandidate and a persisted candidate — the two
 * differ in fields this function never touches.
 */
export interface DealEvidenceSource {
  sourceId: string;
  evidence: { claim: string; source: string; url: string; dateAccessed: string; confidence: number }[];
  publicFunding?: string;
  mostRecentRound?: string;
  fundingDate?: string;
  discoveredAt?: string;
}

/** Build a DealEvidence row from a candidate's own evidence. */
export function candidateToDealEvidence(c: DealEvidenceSource): DealEvidence[] {
  const retrievedAt = (c.discoveredAt ?? new Date().toISOString()).slice(0, 10);
  const type = opportunityTypeForSource(c.sourceId);
  const tier = tierOf(c.sourceId);

  return c.evidence.map((e) => {
    // The source's own publication date if it gave one. `dateAccessed` is
    // when WE fetched it and must never be used as a publication date —
    // doing so made every candidate look brand new regardless of age.
    const published = /^\d{4}-\d{2}-\d{2}$/.test(e.dateAccessed) && e.dateAccessed !== retrievedAt
      ? e.dateAccessed
      : null;

    const amountText = c.publicFunding && c.publicFunding !== 'Unknown' ? c.publicFunding : null;
    const amountUsd = amountText ? parseAmount(amountText) : null;

    return {
      opportunityType: type,
      sourceId: c.sourceId,
      sourceName: e.source,
      tier,
      url: e.url,
      publishedAt: published ?? (c.fundingDate && /^\d{4}-\d{2}-\d{2}$/.test(c.fundingDate) ? c.fundingDate : null),
      retrievedAt,
      summary: e.claim,
      whyCurrent: whyCurrentFor(type, published ?? c.fundingDate ?? null),
      // Tier 3 may not assert an amount, however confidently it is worded.
      amountUsd: tier <= 2 ? amountUsd : null,
      amountText: tier <= 2 ? amountText : null,
      roundType: c.mostRecentRound && c.mostRecentRound !== 'Unknown' ? c.mostRecentRound : null,
      investors: [],
      confidence: e.confidence,
    };
  });
}

function whyCurrentFor(type: OpportunityType, date: string | null): string {
  if (!date) return 'No publication date on this evidence, so it cannot establish that the opportunity is current.';
  switch (type) {
    case 'form-d-filing':
      return `Form D filed ${date} — a dated regulatory record of an exempt offering.`;
    case 'funding-announcement':
      return `Funding reported ${date} by a named publication.`;
    case 'government-award':
      return `Government award dated ${date}. Non-dilutive: a commercialization signal, not an equity round.`;
    case 'accelerator-batch':
      return `Accelerator batch beginning approximately ${date}. Indicates a cohort actively raising; the date is a batch season, not an exact day.`;
    case 'product-launch':
      return `Public product launch on ${date} — commercialization progress, not financing.`;
    default:
      return `Dated ${date}, but this source type cannot establish a financing event.`;
  }
}

/** "$52,500,000 sold of a $75,000,000 offering" → 52500000. Absent → null. */
export function parseAmount(text: string): number | null {
  const m = text.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(k|m|b|million|billion|thousand)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit.startsWith('k') || unit === 'thousand') n *= 1_000;
  else if (unit.startsWith('m') || unit === 'million') n *= 1_000_000;
  else if (unit.startsWith('b') || unit === 'billion') n *= 1_000_000_000;
  return n > 0 ? n : null;
}

// ── Shortlist selection ───────────────────────────────────────────

export interface ShortlistCandidate {
  companyId: string;
  name: string;
  opportunity: Opportunity;
  fitScore: number;
}

export interface SectorShortlist {
  vertical: VerticalId;
  selected: ShortlistCandidate[];
  /** Qualified but not selected because a cap or the size limit bound first. */
  heldBack: { name: string; reason: string }[];
  shortfall: number;
  diversity: DiversityReport;
  /** Plain-language explanation of any shortage, for display. */
  shortageExplanation: string | null;
}

export interface SelectOptions {
  perSector?: number;
  /** Injected for deterministic tests. */
  today?: string;
}

/**
 * Choose up to `perSector` opportunities for one sector, enforcing:
 *  - only live-deal classifications qualify
 *  - at most two YC-primary records
 *  - a preference for tier 1 over tier 2, then higher fit score
 *  - a nudge toward unseen source families while slots remain
 *
 * Never pads. A sector with three qualifying opportunities shows three.
 */
export function selectSectorShortlist(
  vertical: VerticalId,
  pool: ShortlistCandidate[],
  opts: SelectOptions = {},
): SectorShortlist {
  const perSector = opts.perSector ?? 5;

  const qualified = pool.filter((c) => isLiveDeal(c.opportunity.classification));
  const heldBack: { name: string; reason: string }[] = [];

  // Rank: stronger evidence tier first, then fresher evidence, then fit.
  const ranked = [...qualified].sort((a, b) =>
    a.opportunity.primaryTier - b.opportunity.primaryTier
    || (b.opportunity.evidencePublishedAt ?? '').localeCompare(a.opportunity.evidencePublishedAt ?? '')
    || b.fitScore - a.fitScore);

  const selected: ShortlistCandidate[] = [];
  let ycUsed = 0;
  let secUsed = 0;
  const familiesUsed = new Set<string>();

  // Pass 1: prefer a NEW source family for each slot, so the shortlist
  // spreads across families instead of filling up from whichever source
  // happened to return the most rows.
  for (const pass of [1, 2] as const) {
    for (const c of ranked) {
      if (selected.length >= perSector) break;
      if (selected.some((s) => s.companyId === c.companyId)) continue;

      const src = c.opportunity.primarySourceId;
      const family = familyOf(src);

      if (pass === 1 && familiesUsed.has(family)) continue;

      if (src === 'yc' && ycUsed >= MAX_YC_PRIMARY_PER_SECTOR) {
        if (pass === 2 && !heldBack.some((h) => h.name === c.name)) {
          heldBack.push({
            name: c.name,
            reason: `Held back: already ${MAX_YC_PRIMARY_PER_SECTOR} Y Combinator-primary opportunities in this sector. Not padding the sector with a third.`,
          });
        }
        continue;
      }
      // The same cap applies to SEC. Without it a sector fills up with
      // Form D filers purely because EDGAR returns the most rows, which is
      // how "diversified" quietly became "82% one source".
      if (src === 'sec' && secUsed >= MAX_SEC_PRIMARY_PER_SECTOR) {
        if (pass === 2 && !heldBack.some((h) => h.name === c.name)) {
          heldBack.push({
            name: c.name,
            reason: `Held back: already ${MAX_SEC_PRIMARY_PER_SECTOR} SEC-primary opportunities in this sector. A shortlist of Form D filers is one source wearing a hat.`,
          });
        }
        continue;
      }

      selected.push(c);
      familiesUsed.add(family);
      if (src === 'yc') ycUsed++;
      if (src === 'sec') secUsed++;
    }
  }

  const diversity = assessDiversity(
    selected.map((s) => ({ primarySourceId: s.opportunity.primarySourceId, primaryTier: s.opportunity.primaryTier })),
    vertical,
  );

  const shortfall = Math.max(0, perSector - selected.length);
  let shortageExplanation: string | null = null;
  if (shortfall > 0) {
    const leads = pool.length - qualified.length;
    const parts = [
      `${selected.length} of ${perSector} slots filled.`,
      `${pool.length} candidate(s) considered; ${qualified.length} met the current-opportunity bar.`,
      leads > 0 ? `${leads} had no recent financing or fundraising evidence and remain company leads.` : '',
      heldBack.length > 0 ? `${heldBack.length} qualified but were held back by the ${MAX_YC_PRIMARY_PER_SECTOR}-per-sector Y Combinator cap.` : '',
      'Slots were left empty rather than filled with companies lacking current deal evidence.',
    ];
    shortageExplanation = parts.filter(Boolean).join(' ');
  }

  return { vertical, selected, heldBack, shortfall, diversity, shortageExplanation };
}

/**
 * Build shortlists for every sector from what is already in the
 * database. Reads only — the caller decides what to do with the result.
 */
export function buildShortlists(verticals: VerticalId[], opts: SelectOptions = {}): SectorShortlist[] {
  const companies = listCompanies();
  return verticals.map((v) => {
    const pool: ShortlistCandidate[] = companies
      .filter((c) => c.vertical === v)
      .map((c) => {
        // Reclassify from stored evidence so the shortlist always reflects
        // the current evidence rather than a stale classification.
        const opportunity = reclassifyCompany(c.id, { today: opts.today });
        return {
          companyId: c.id,
          name: c.name,
          opportunity,
          fitScore: latestScore(c.id)?.score ?? 0,
        };
      });
    return selectSectorShortlist(v, pool, opts);
  });
}

/** Portfolio-wide diversity across every selected opportunity. */
export function overallDiversity(shortlists: SectorShortlist[]): DiversityReport {
  return assessDiversity(
    shortlists.flatMap((s) => s.selected.map((c) => ({
      primarySourceId: c.opportunity.primarySourceId,
      primaryTier: c.opportunity.primaryTier,
    }))),
    'all sectors',
  );
}

/** Companies present but not qualifying as opportunities. */
export function companyLeads(): { id: string; name: string; vertical: string; reason: string }[] {
  return listCompanies()
    .map((c) => {
      const o = reclassifyCompany(c.id);
      return { c, o };
    })
    .filter(({ o }) => !isLiveDeal(o.classification))
    .map(({ c, o }) => ({ id: c.id, name: c.name, vertical: c.vertical, reason: o.whyCurrent }));
}

export { addDealEvidence, listDealEvidence, getCompany, TARGET_SOURCE_FAMILIES_PER_SECTOR };

// ── Diversity analytics ───────────────────────────────────────────

export interface DiversityAnalytics {
  totalCompanies: number;
  totalOpportunities: number;
  companyLeads: number;
  quarantined: number;
  humanReview: number;
  byClassification: Record<string, number>;
  byPrimarySource: Record<string, number>;
  byTier: Record<string, number>;
  byQualification: Record<string, number>;
  sharePct: Record<string, number>;
  singleSourceOpportunities: number;
  multiSourceOpportunities: number;
  perSector: {
    vertical: string;
    qualified: number;
    families: string[];
    shortfall: number;
    warnings: string[];
  }[];
  publicCompaniesExcluded: number;
  fundsOrSpvsExcluded: number;
  warnings: string[];
}

/**
 * Operational analytics computed ENTIRELY from persisted evidence and
 * qualification verdicts. Nothing here is estimated or modelled — if a
 * number cannot be derived from a stored row it is not shown.
 */
export function diversityAnalytics(verticals: VerticalId[], opts: SelectOptions = {}): DiversityAnalytics {
  const db = getDb();
  const companies = listCompanies();

  const quals = db.prepare('SELECT company_id, result, corroborating_sources FROM issuer_qualification').all() as
    { company_id: string; result: string; corroborating_sources: string }[];
  const qualByCompany = new Map(quals.map((q) => [q.company_id, q]));

  const quarantinedRows = db.prepare('SELECT id FROM companies WHERE quarantined = 1').all() as { id: string }[];
  const quarantinedIds = new Set(quarantinedRows.map((r) => r.id));

  const byClassification: Record<string, number> = {};
  const byPrimarySource: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byQualification: Record<string, number> = {};
  let opportunities = 0;
  let leads = 0;
  let singleSource = 0;
  let multiSource = 0;
  let humanReview = 0;

  for (const c of companies) {
    const o = reclassifyCompany(c.id, opts);
    byClassification[o.classification] = (byClassification[o.classification] ?? 0) + 1;

    const q = qualByCompany.get(c.id);
    if (q) {
      byQualification[q.result] = (byQualification[q.result] ?? 0) + 1;
      if (q.result === 'human-review-required') humanReview++;
    }

    if (isLiveDeal(o.classification) && !quarantinedIds.has(c.id)) {
      opportunities++;
      byPrimarySource[o.primarySourceId] = (byPrimarySource[o.primarySourceId] ?? 0) + 1;
      byTier[`tier${o.primaryTier}`] = (byTier[`tier${o.primaryTier}`] ?? 0) + 1;
      const n = q ? (JSON.parse(q.corroborating_sources) as unknown[]).length : 0;
      if (n >= 2) multiSource++; else singleSource++;
    } else {
      leads++;
    }
  }

  const sharePct: Record<string, number> = {};
  for (const [src, n] of Object.entries(byPrimarySource)) {
    sharePct[src] = opportunities > 0 ? Math.round((n / opportunities) * 1000) / 10 : 0;
  }

  const shortlists = buildShortlists(verticals, opts);
  const perSector = shortlists.map((s) => ({
    vertical: s.vertical,
    qualified: s.selected.length,
    families: Object.keys(s.diversity.byFamily),
    shortfall: s.shortfall,
    warnings: s.diversity.warnings,
  }));

  const warnings: string[] = [];
  for (const [src, pct] of Object.entries(sharePct)) {
    if (pct > 40) warnings.push(`${pct}% of all opportunities come from a single source (${src}). Above 40% the pipeline is really one source wearing a hat.`);
  }
  for (const s of perSector) {
    if (s.families.length > 0 && s.families.length < TARGET_SOURCE_FAMILIES_PER_SECTOR) {
      warnings.push(`${s.vertical} draws on only ${s.families.length} source famil${s.families.length === 1 ? 'y' : 'ies'} (target ${TARGET_SOURCE_FAMILIES_PER_SECTOR}).`);
    }
    if (s.shortfall > 0) warnings.push(`${s.vertical} has ${s.qualified} qualified opportunit${s.qualified === 1 ? 'y' : 'ies'} — short by ${s.shortfall}. Shown short rather than padded.`);
  }
  if (singleSource > 0) {
    warnings.push(`${singleSource} opportunit${singleSource === 1 ? 'y' : 'ies'} rest on a single source family. A lone filing is not corroboration.`);
  }

  return {
    totalCompanies: companies.length,
    totalOpportunities: opportunities,
    companyLeads: leads,
    quarantined: quarantinedIds.size,
    humanReview,
    byClassification, byPrimarySource, byTier, byQualification, sharePct,
    singleSourceOpportunities: singleSource,
    multiSourceOpportunities: multiSource,
    perSector,
    publicCompaniesExcluded: byQualification['public-company'] ?? 0,
    fundsOrSpvsExcluded: (byQualification['investment-fund'] ?? 0) + (byQualification['spv-or-project-entity'] ?? 0),
    warnings,
  };
}
