import { getDb } from '../db/client';
import { getCompany, listCompanies } from '../db/repos/companies';
import { addDealEvidence, listDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import { latestScore } from '../db/repos/operations';
import { tierOf } from '../../shared/opportunity';
import {
  assessDiversity, familyLabel, familyOf, isLiveDeal, sourceLabel,
  MAX_YC_PRIMARY_PER_SECTOR, TARGET_SOURCE_FAMILIES_PER_SECTOR,
  type DealEvidence, type DiversityReport, type Opportunity, type OpportunityType,
} from '../../shared/opportunity';
import {
  isSubstantiveOperatingEvidence, meetsOperatingCompanyStandard,
  MAX_SEC_PRIMARY_PER_SECTOR, MIN_INDEPENDENT_SOURCES,
  WEBSITE_EVIDENCE_LABELS, WEBSITE_EVIDENCE_MEANINGS,
  type WebsiteEvidenceLevel,
} from '../../shared/qualification';
import type { VerticalId } from '../../src/types';
import { NON_SECTOR_STATUS } from '../../shared/enrichment';

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
    // An investor stating it took part in a round is describing the same
    // KIND of event a press report describes; what differs is who is
    // saying it, which is captured by the source family, not the type.
    case 'investor-news': return 'funding-announcement';
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
  evidence: {
    claim: string; source: string; url: string; dateAccessed: string; confidence: number;
    /** The source's own publication date, when it gave one. */
    publishedAt?: string | null;
  }[];
  publicFunding?: string;
  mostRecentRound?: string;
  /** Investors the source explicitly named. Never inferred. */
  investors?: string[];
  fundingDate?: string;
  discoveredAt?: string;
}

/** Build a DealEvidence row from a candidate's own evidence. */
export function candidateToDealEvidence(c: DealEvidenceSource): DealEvidence[] {
  const retrievedAt = (c.discoveredAt ?? new Date().toISOString()).slice(0, 10);
  const type = opportunityTypeForSource(c.sourceId);
  const tier = tierOf(c.sourceId);

  return c.evidence.map((e) => {
    // Prefer the source's OWN publication date. Falling back to
    // `dateAccessed` was the old behaviour and it is wrong in both
    // directions: it is the run time, so it either invents currency for
    // stale evidence or — because it equals retrievedAt — evaluates to
    // null and destroys currency for fresh evidence. The latter is what
    // silently killed every funding-news candidate.
    const published = e.publishedAt
      ?? (/^\d{4}-\d{2}-\d{2}$/.test(e.dateAccessed) && e.dateAccessed !== retrievedAt ? e.dateAccessed : null);

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
      // Tier 3 may not assert who invested, for the same reason it may
      // not assert an amount.
      investors: tier <= 2 ? (c.investors ?? []) : [],
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
  /** Taken out of the live shortlist without destroying its evidence. */
  quarantined?: boolean;
  /** Independent FINANCING sources on the qualification verdict — never the company itself. */
  independentSources?: number;
  /** What the issuer's own site established, from the qualification verdict. */
  operatingEvidence?: WebsiteEvidenceLevel;
  /**
   * False when enrichment recorded the explicit non-sector status for
   * this company. Undefined means enrichment has not run, which is NOT
   * the same as unclassifiable and must not exclude anything — a record
   * nobody has classified keeps whatever standing it already had.
   */
  sectorClassifiable?: boolean;
  /** The specific evidence gap behind a false `sectorClassifiable`. */
  sectorEvidenceGap?: string | null;
}

/**
 * Which half of the bar this candidate missed.
 *
 * "Insufficient corroboration" covers two quite different situations and
 * saying the same thing about both would send a reviewer looking for the
 * wrong missing piece: a company with no independent account of its
 * financing needs a second source, and a company whose site proves only
 * that it owns a domain needs somebody to look at the business.
 */
function insufficientCorroborationReason(c: ShortlistCandidate): string {
  const n = c.independentSources ?? 0;
  const level = c.operatingEvidence ?? 'not-checked';
  if (n >= 1 && !isSubstantiveOperatingEvidence(level)) {
    return `Financing evidence is on record, but operating evidence is not: ${WEBSITE_EVIDENCE_LABELS[level].toLowerCase()}. `
      + `${WEBSITE_EVIDENCE_MEANINGS[level]} A live opportunity needs the issuer to describe an actual product, `
      + 'service, technology, or operating business — a domain that resolves is not that.';
  }
  return `Insufficient corroboration: ${n} independent financing source${n === 1 ? '' : 's'} on record `
    + `and no substantive operating evidence. A live opportunity needs an independent account of the financing `
    + `plus the issuer describing a real business, or ${MIN_INDEPENDENT_SOURCES} independent financing sources `
    + 'and a human confirmation. One account of an event is not corroboration of it.';
}

/**
 * Why an eligible candidate is not on the shortlist.
 *
 * Every one of these is a display decision about a company that IS a live
 * deal. None of them is a judgement that the company is not real — that
 * judgement belongs to qualification, and a candidate carrying one of
 * these codes has already passed it.
 */
export const HOLD_BACK_REASONS = [
  'ranked-below-cutoff',
  'source-family-cap',
  'sector-limit',
  'insufficient-corroboration',
  'quarantined',
  'sector-unclassifiable',
] as const;
export type HoldBackReason = (typeof HOLD_BACK_REASONS)[number];

export const HOLD_BACK_LABELS: Record<HoldBackReason, string> = {
  'ranked-below-cutoff': 'Ranked below the cutoff',
  'source-family-cap': 'Source-family cap',
  'sector-limit': 'Sector limit',
  'insufficient-corroboration': 'Insufficient corroboration',
  quarantined: 'Quarantined',
  'sector-unclassifiable': 'Sector not classifiable',
};

export interface HeldBackCandidate {
  companyId: string;
  name: string;
  reasonCode: HoldBackReason;
  /** The specific, per-candidate sentence. Never a generic category. */
  reason: string;
  /** 1-based position among the sector's contenders. 0 when it never ranked. */
  rank: number;
  primarySourceId: string;
  classification: Opportunity['classification'];
  evidenceUrl: string;
  evidencePublishedAt: string | null;
}

export interface SectorShortlist {
  vertical: VerticalId;
  selected: ShortlistCandidate[];
  /**
   * Every live deal in this sector that is NOT selected, each with the
   * specific reason it lost its slot.
   *
   * The invariant this type exists to carry: `selected.length +
   * heldBack.length` equals the number of live deals in the pool, so a
   * qualifying company can never simply vanish between the database and
   * the shortlist. It used to — only the two source caps ever pushed a
   * name in here, so anything that merely ranked too low disappeared with
   * no record that it had been considered at all.
   */
  heldBack: HeldBackCandidate[];
  /** Live deals in this sector, selected + held back. */
  eligible: number;
  /** Pool members with no current financing evidence. Not held back — not eligible. */
  leads: number;
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

/** Slots per sector. A target, never a quota — sectors are shown short. */
export const DEFAULT_PER_SECTOR = 5;

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
  const perSector = opts.perSector ?? DEFAULT_PER_SECTOR;

  const qualified = pool.filter((c) => isLiveDeal(c.opportunity.classification));
  const heldBack: HeldBackCandidate[] = [];

  // Rank: stronger evidence tier first, then fresher evidence, then fit.
  const ranked = [...qualified].sort((a, b) =>
    a.opportunity.primaryTier - b.opportunity.primaryTier
    || (b.opportunity.evidencePublishedAt ?? '').localeCompare(a.opportunity.evidencePublishedAt ?? '')
    || b.fitScore - a.fitScore);

  const hold = (c: ShortlistCandidate, reasonCode: HoldBackReason, reason: string, rank: number) => {
    heldBack.push({
      companyId: c.companyId,
      name: c.name,
      reasonCode,
      reason,
      rank,
      primarySourceId: c.opportunity.primarySourceId,
      classification: c.opportunity.classification,
      evidenceUrl: c.opportunity.evidenceUrl,
      evidencePublishedAt: c.opportunity.evidencePublishedAt,
    });
  };

  // ── Display guards ────────────────────────────────────────────────
  // Checked before any slot is handed out, because these are reasons a
  // live deal should not be SHOWN as one at all — not reasons it lost a
  // contest. Recorded per candidate so the record still exists.
  const contenders: ShortlistCandidate[] = [];
  for (const c of ranked) {
    if (c.quarantined) {
      hold(c, 'quarantined', 'Quarantined: taken out of the live shortlist pending review. Its evidence is retained — see the company record for the specific quarantine reason.', 0);
      continue;
    }
    // The same bar qualification applies, read from the same function, so
    // the two locks cannot drift apart. It used to be a bare count of
    // sources, and once the company's own website stopped counting as one
    // of them a bare count would have held back every legitimate record
    // that had a filing and a real product site — the opposite error to
    // the one being fixed.
    if (c.independentSources !== undefined && !meetsOperatingCompanyStandard({
      independentFinancingSources: c.independentSources,
      operatingEvidence: c.operatingEvidence ?? 'not-checked',
    })) {
      hold(c, 'insufficient-corroboration', insufficientCorroborationReason(c), 0);
      continue;
    }
    /**
     * Enrichment could not place this company in a sector, because its
     * identity as an operating company is unresolved.
     *
     * This can only ever REMOVE a record from a sector ranking, never add
     * one — a company enrichment classified successfully still has to
     * clear every gate above before it reaches this line. That direction
     * is the point: enrichment must not be able to promote anything, and
     * the only way to guarantee that is for its influence here to be
     * one-way.
     */
    if (c.sectorClassifiable === false) {
      hold(
        c, 'sector-unclassifiable',
        c.sectorEvidenceGap
          ? `Excluded from the sector ranking: ${c.sectorEvidenceGap}`
          : 'Excluded from the sector ranking: enrichment could not confirm this record as an operating company, '
            + 'so it carries the explicit non-sector status rather than a sector.',
        0,
      );
      continue;
    }
    contenders.push(c);
  }
  const rankOf = new Map(contenders.map((c, i) => [c.companyId, i + 1]));

  const selected: ShortlistCandidate[] = [];
  let ycUsed = 0;
  let secUsed = 0;
  const familiesUsed = new Set<string>();
  /** companyId → the cap sentence, for candidates a per-source cap blocked. */
  const cappedBy = new Map<string, string>();

  // Pass 1: prefer a NEW source family for each slot, so the shortlist
  // spreads across families instead of filling up from whichever source
  // happened to return the most rows.
  for (const pass of [1, 2] as const) {
    for (const c of contenders) {
      if (selected.length >= perSector) break;
      if (selected.some((s) => s.companyId === c.companyId)) continue;

      const src = c.opportunity.primarySourceId;
      const family = familyOf(src);

      if (pass === 1 && familiesUsed.has(family)) continue;

      if (src === 'yc' && ycUsed >= MAX_YC_PRIMARY_PER_SECTOR) {
        cappedBy.set(c.companyId, `Source-family cap: this sector already has ${MAX_YC_PRIMARY_PER_SECTOR} Y Combinator-primary opportunities, the maximum. Not padding the sector with a third from the same directory.`);
        continue;
      }
      // The same cap applies to SEC. Without it a sector fills up with
      // Form D filers purely because EDGAR returns the most rows, which is
      // how "diversified" quietly became "82% one source".
      if (src === 'sec' && secUsed >= MAX_SEC_PRIMARY_PER_SECTOR) {
        cappedBy.set(c.companyId, `Source-family cap: this sector already has ${MAX_SEC_PRIMARY_PER_SECTOR} SEC-primary opportunities, the maximum. A shortlist of Form D filers is one source wearing a hat.`);
        continue;
      }

      selected.push(c);
      familiesUsed.add(family);
      if (src === 'yc') ycUsed++;
      if (src === 'sec') secUsed++;
    }
  }

  // ── Account for every contender that did not get a slot ───────────
  // This loop is the fix. Previously only the two cap branches recorded
  // anything, so a live deal that merely ranked below the cutoff — Sila
  // and General Intuition among them — was dropped silently and a reader
  // could not tell it had ever been a candidate.
  const selectedIds = new Set(selected.map((s) => s.companyId));
  for (const c of contenders) {
    if (selectedIds.has(c.companyId)) continue;
    const rank = rankOf.get(c.companyId) ?? 0;
    const cap = cappedBy.get(c.companyId);
    if (cap) {
      hold(c, 'source-family-cap', cap, rank);
    } else if (rank > perSector) {
      hold(c, 'ranked-below-cutoff', `Ranked #${rank} of ${contenders.length} live deals in this sector and only ${perSector} slots exist. Order is decided by evidence tier first, then how recent the evidence is, then Vamos fit score.`, rank);
    } else {
      // Inside the top `perSector` by rank, yet not selected: pass 1 gave
      // the slot to a lower-ranked candidate from a source family this
      // sector did not yet represent.
      hold(c, 'sector-limit', `Sector limit of ${perSector} reached. This candidate ranked #${rank}, inside the cutoff, but a lower-ranked candidate from a source family not yet represented in this sector took the slot so the shortlist would not rest on a single family.`, rank);
    }
  }

  const diversity = assessDiversity(
    selected.map((s) => ({ primarySourceId: s.opportunity.primarySourceId, primaryTier: s.opportunity.primaryTier })),
    vertical,
  );

  const leads = pool.length - qualified.length;
  const shortfall = Math.max(0, perSector - selected.length);
  let shortageExplanation: string | null = null;
  if (shortfall > 0) {
    const byReason = new Map<HoldBackReason, number>();
    for (const h of heldBack) byReason.set(h.reasonCode, (byReason.get(h.reasonCode) ?? 0) + 1);
    const heldParts = [...byReason.entries()]
      .map(([code, n]) => `${n} ${HOLD_BACK_LABELS[code].toLowerCase()}`)
      .join(', ');
    const parts = [
      `${selected.length} of ${perSector} slots filled.`,
      `${pool.length} candidate(s) considered; ${qualified.length} met the current-opportunity bar.`,
      leads > 0 ? `${leads} had no recent financing or fundraising evidence and remain company leads.` : '',
      heldBack.length > 0 ? `${heldBack.length} held back (${heldParts}) — each is listed with its specific reason.` : '',
      'Slots were left empty rather than filled with companies lacking current deal evidence.',
    ];
    shortageExplanation = parts.filter(Boolean).join(' ');
  }

  return {
    vertical, selected, heldBack,
    eligible: qualified.length, leads,
    shortfall, diversity, shortageExplanation,
  };
}

/**
 * Build shortlists for every sector from what is already in the
 * database. Reads only — the caller decides what to do with the result.
 */
export function buildShortlists(verticals: VerticalId[], opts: SelectOptions = {}): SectorShortlist[] {
  const companies = listCompanies();

  // Quarantine and corroboration live outside the Opportunity record, and
  // the selector cannot reach them without a circular import. Read them
  // once here rather than per candidate.
  const db = getDb();
  const quarantinedIds = new Set(
    (db.prepare('SELECT id FROM companies WHERE quarantined = 1').all() as { id: string }[])
      .map((r) => r.id),
  );
  const standing = new Map(
    (db.prepare('SELECT company_id, corroborating_sources, operating_evidence FROM issuer_qualification').all() as
      { company_id: string; corroborating_sources: string; operating_evidence: string | null }[])
      .map((q) => {
        let n = 0;
        try { n = (JSON.parse(q.corroborating_sources) as unknown[]).length; } catch { n = 0; }
        let level: WebsiteEvidenceLevel = 'not-checked';
        try {
          if (q.operating_evidence) level = (JSON.parse(q.operating_evidence) as { level: WebsiteEvidenceLevel }).level;
        } catch { level = 'not-checked'; }
        return [q.company_id, { n, level }] as const;
      }),
  );

  /**
   * Enrichment's sector verdict, read the same way and for the same
   * reason as the two above.
   *
   * Only the explicit non-sector status is recorded here. A company with
   * NO row is left undefined, not false: "enrichment has not run" and
   * "enrichment could not classify this" are different facts, and
   * treating the first as the second would empty every shortlist the
   * moment this table was added.
   */
  const unclassifiable = new Map(
    (db.prepare(
      "SELECT company_id, evidence_gap FROM company_vertical_classification WHERE primary_sector = ?",
    ).all(NON_SECTOR_STATUS) as { company_id: string; evidence_gap: string | null }[])
      .map((r) => [r.company_id, r.evidence_gap] as const),
  );

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
          quarantined: quarantinedIds.has(c.id),
          // Absent verdict → 0 sources and unchecked operating evidence,
          // which the guard reads as uncorroborated. The reclassify gate
          // already demotes such a record off the live list; this is the
          // second lock on the same door.
          independentSources: standing.get(c.id)?.n ?? 0,
          operatingEvidence: standing.get(c.id)?.level ?? 'not-checked',
          // Undefined when enrichment has no row — see the note above.
          sectorClassifiable: unclassifiable.has(c.id) ? false : undefined,
          sectorEvidenceGap: unclassifiable.get(c.id) ?? null,
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
  /**
   * The same opportunities counted by source FAMILY.
   *
   * Concentration is only meaningful at this level. Splitting the funding
   * press across four publisher ids would make no source look dominant
   * while the pipeline still rested entirely on journalism — which is the
   * exact illusion these numbers exist to prevent.
   */
  byFamily: Record<string, number>;
  byTier: Record<string, number>;
  byQualification: Record<string, number>;
  sharePct: Record<string, number>;
  familySharePct: Record<string, number>;
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
  const byFamily: Record<string, number> = {};
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
      const family = familyOf(o.primarySourceId);
      byFamily[family] = (byFamily[family] ?? 0) + 1;
      byTier[`tier${o.primaryTier}`] = (byTier[`tier${o.primaryTier}`] ?? 0) + 1;
      const n = q ? (JSON.parse(q.corroborating_sources) as unknown[]).length : 0;
      if (n >= 2) multiSource++; else singleSource++;
    } else {
      leads++;
    }
  }

  const pct = (n: number) => (opportunities > 0 ? Math.round((n / opportunities) * 1000) / 10 : 0);
  const sharePct: Record<string, number> = {};
  for (const [src, n] of Object.entries(byPrimarySource)) sharePct[src] = pct(n);
  const familySharePct: Record<string, number> = {};
  for (const [fam, n] of Object.entries(byFamily)) familySharePct[fam] = pct(n);

  const shortlists = buildShortlists(verticals, opts);
  const perSector = shortlists.map((s) => ({
    vertical: s.vertical,
    qualified: s.selected.length,
    families: Object.keys(s.diversity.byFamily),
    shortfall: s.shortfall,
    warnings: s.diversity.warnings,
  }));

  const warnings: string[] = [];
  for (const [src, share] of Object.entries(sharePct)) {
    if (share > 40) warnings.push(`${share}% of all opportunities come from a single source (${sourceLabel(src)}). Above 40% the pipeline is really one source wearing a hat.`);
  }
  // The family-level warning is the one that cannot be gamed by adding
  // publishers. Reported separately so a reader sees both numbers.
  for (const [fam, share] of Object.entries(familySharePct)) {
    if (share > 40) warnings.push(`${share}% of all opportunities rest on one source family (${familyLabel(fam)}). Adding more sources of the same kind would not change this.`);
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
    byClassification, byPrimarySource, byFamily, byTier, byQualification, sharePct, familySharePct,
    singleSourceOpportunities: singleSource,
    multiSourceOpportunities: multiSource,
    perSector,
    publicCompaniesExcluded: byQualification['public-company'] ?? 0,
    fundsOrSpvsExcluded: (byQualification['investment-fund'] ?? 0) + (byQualification['spv-or-project-entity'] ?? 0),
    warnings,
  };
}
