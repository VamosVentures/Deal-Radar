import { getDb } from '../client';
import {
  classifyOpportunity, isLiveDeal, tierOf, ACCELERATOR_SIGNAL_LABELS,
  type DealEvidence, type Opportunity, type OpportunityClass, type SourceTier,
} from '../../../shared/opportunity';
import { DISQUALIFYING_RESULTS } from '../../../shared/qualification';

/**
 * Persistence for deal evidence and the opportunity classification
 * derived from it.
 *
 * Two rules the read path enforces structurally rather than by
 * convention:
 *
 *  1. A company with NO classification row is a lead, not a deal. The
 *     default is the cautious one, so a company can never become a
 *     "deal" by omission.
 *  2. Evidence is append-only and deduplicated on (company, url, type),
 *     so re-running sourcing strengthens the record instead of
 *     overwriting it, and a weaker later source cannot erase a stronger
 *     earlier one.
 */

function nowIso(): string {
  return new Date().toISOString();
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Deal evidence ─────────────────────────────────────────────────

export function addDealEvidence(
  companyId: string,
  evidence: DealEvidence,
): { added: boolean; dateBackfilled: boolean } {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, published_at FROM deal_evidence WHERE company_id = ? AND url = ? AND opportunity_type = ?',
  ).get(companyId, evidence.url, evidence.opportunityType) as
    { id: number; published_at: string | null } | undefined;

  if (existing) {
    /**
     * Append-only means a stored FACT is never rewritten. A row carrying
     * no publication date is not a fact being contradicted — it is a
     * gap, and re-reading the same article with a parser that works can
     * fill it.
     *
     * This is not hypothetical. The RSS date bug fixed in Phase 14 wrote
     * every funding-news row with published_at NULL. Re-running sourcing
     * afterwards hit this ON CONFLICT path and changed nothing, so those
     * records stayed permanently undated and permanently un-current, and
     * no amount of correct code downstream could rescue them.
     *
     * Strictly null → non-null. A date already on record is never
     * touched, so a later source can never move an event in time.
     */
    if (existing.published_at === null && evidence.publishedAt !== null) {
      db.prepare('UPDATE deal_evidence SET published_at = ? WHERE id = ?')
        .run(evidence.publishedAt, existing.id);
      return { added: false, dateBackfilled: true };
    }
    return { added: false, dateBackfilled: false };
  }

  db.prepare(`
    INSERT INTO deal_evidence (
      company_id, opportunity_type, source_id, source_name, tier, url,
      published_at, retrieved_at, summary, why_current,
      amount_usd, amount_text, round_type, investors, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, evidence.opportunityType, evidence.sourceId, evidence.sourceName,
    evidence.tier, evidence.url, evidence.publishedAt, evidence.retrievedAt,
    evidence.summary, evidence.whyCurrent,
    evidence.amountUsd, evidence.amountText, evidence.roundType,
    JSON.stringify(evidence.investors), evidence.confidence,
  );
  return { added: true, dateBackfilled: false };
}

export function listDealEvidence(companyId: string): DealEvidence[] {
  return (getDb().prepare(
    'SELECT * FROM deal_evidence WHERE company_id = ? ORDER BY published_at DESC NULLS LAST, id DESC',
  ).all(companyId) as Record<string, unknown>[]).map(rowToEvidence);
}

function rowToEvidence(r: Record<string, unknown>): DealEvidence {
  return {
    opportunityType: r.opportunity_type as DealEvidence['opportunityType'],
    sourceId: String(r.source_id),
    sourceName: String(r.source_name),
    tier: Number(r.tier) as SourceTier,
    url: String(r.url),
    publishedAt: (r.published_at as string | null) ?? null,
    retrievedAt: String(r.retrieved_at),
    summary: String(r.summary),
    whyCurrent: String(r.why_current),
    amountUsd: r.amount_usd === null ? null : Number(r.amount_usd),
    amountText: (r.amount_text as string | null) ?? null,
    roundType: (r.round_type as string | null) ?? null,
    investors: JSON.parse(String(r.investors ?? '[]')) as string[],
    confidence: Number(r.confidence),
  };
}

// ── Classification ────────────────────────────────────────────────

export function getOpportunity(companyId: string): Opportunity | null {
  const r = getDb().prepare('SELECT * FROM company_opportunity WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    companyId: String(r.company_id),
    classification: r.classification as OpportunityClass,
    primarySourceId: String(r.primary_source_id),
    primaryTier: Number(r.primary_tier) as SourceTier,
    opportunityType: r.opportunity_type as Opportunity['opportunityType'],
    evidenceUrl: String(r.evidence_url),
    evidencePublishedAt: (r.evidence_published_at as string | null) ?? null,
    evidenceRetrievedAt: String(r.evidence_retrieved_at),
    evidenceSummary: String(r.evidence_summary),
    whyCurrent: String(r.why_current),
    amountUsd: r.amount_usd === null ? null : Number(r.amount_usd),
    amountText: (r.amount_text as string | null) ?? null,
    roundType: (r.round_type as string | null) ?? null,
    investors: JSON.parse(String(r.investors ?? '[]')) as string[],
    evidenceConfidence: Number(r.evidence_confidence),
    conflicts: JSON.parse(String(r.conflicts ?? '[]')) as string[],
    missingInformation: JSON.parse(String(r.missing_information ?? '[]')) as string[],
    classifiedAt: String(r.classified_at),
  };
}

/**
 * Recompute a company's classification from ALL of its stored evidence
 * and persist the result. Idempotent: running it twice on unchanged
 * evidence produces the same classification.
 */
export function reclassifyCompany(companyId: string, opts: { today?: string } = {}): Opportunity {
  const evidence = listDealEvidence(companyId);
  let result = classifyOpportunity({ evidence, today: opts.today });

  // QUALIFICATION GATE. Evidence-based classification decides what the
  // evidence SAYS; qualification decides whether the entity is the kind
  // of thing that can be a venture deal at all. A publicly traded
  // company, a fund, an SPV, or an entity nothing independent
  // corroborates cannot be a live opportunity however fresh its Form D
  // is — so a strong classification is demoted here rather than being
  // allowed to reach the shortlist.
  //
  // Read directly from the table to avoid a circular import with
  // server/services/issuerQualification.ts, which imports this module.
  const qual = getDb()
    .prepare('SELECT result FROM issuer_qualification WHERE company_id = ?')
    .get(companyId) as { result: string } | undefined;

  if (qual && isLiveDeal(result.classification)) {
    if (DISQUALIFYING_RESULTS.includes(qual.result as never)) {
      result = {
        ...result,
        classification: 'company-lead',
        reason: `Evidence would support "${result.classification}", but the issuer is qualified as ${qual.result.replace(/-/g, ' ')} — not a venture-stage operating company. Held as a lead.`,
      };
    } else if (qual.result === 'insufficient-evidence') {
      result = {
        ...result,
        classification: 'company-lead',
        reason: 'Insufficient evidence that this is an operating company (no verified website, no product description, no independent corroboration). Never promoted to a live opportunity.',
      };
    } else if (qual.result === 'company-lead-requires-corroboration') {
      result = {
        ...result,
        classification: 'company-lead',
        reason: `Evidence would support "${result.classification}", but no independent source corroborates it. A single filing is not a deal.`,
      };
    } else if (qual.result === 'human-review-required') {
      result = {
        ...result,
        classification: 'unverified-opportunity',
        reason: 'Corroborated but the company website could not be verified — surfaced for human review rather than counted as a live deal.',
      };
    }
  }

  // Conflicts: two tier-1/2 sources stating different amounts for the
  // same round. Surfaced for a human — never silently reconciled.
  const amounts = new Map<string, Set<number>>();
  for (const e of evidence) {
    if (e.amountUsd === null || e.tier > 2) continue;
    const key = e.roundType ?? 'unspecified round';
    const set = amounts.get(key) ?? new Set<number>();
    set.add(e.amountUsd);
    amounts.set(key, set);
  }
  const conflicts: string[] = [];
  for (const [round, set] of amounts) {
    if (set.size > 1) {
      conflicts.push(`Sources disagree on the amount for ${round}: ${[...set].map((n) => `$${n.toLocaleString()}`).join(' vs ')}. Left unresolved for human review.`);
    }
  }

  const primary = result.primary;
  const missing: string[] = [];
  if (!primary) missing.push('No qualifying current-opportunity evidence.');
  if (primary && primary.opportunityType === 'accelerator-batch') {
    // The mandated wording for an accelerator-derived signal. Stated
    // explicitly so no reader mistakes a missing amount for an
    // undisclosed one, or a cohort for a round.
    missing.push(...ACCELERATOR_SIGNAL_LABELS.slice(1));
  } else {
    if (primary && primary.amountUsd === null) missing.push('Financing amount not stated by the source.');
    if (primary && !primary.roundType) missing.push('Round type not stated by the source.');
  }
  if (evidence.every((e) => e.publishedAt === null)) missing.push('No evidence carries a publication date.');

  const record: Opportunity = {
    companyId,
    classification: result.classification,
    // A lead has no qualifying primary evidence; record the strongest
    // source we DO have so the UI can still say where it came from.
    primarySourceId: primary?.sourceId ?? evidence[0]?.sourceId ?? 'unknown',
    primaryTier: primary?.tier ?? (evidence[0] ? tierOf(evidence[0].sourceId) : 3),
    opportunityType: primary?.opportunityType ?? 'none',
    evidenceUrl: primary?.url ?? evidence[0]?.url ?? 'https://example.invalid/no-evidence',
    evidencePublishedAt: primary?.publishedAt ?? evidence[0]?.publishedAt ?? null,
    evidenceRetrievedAt: primary?.retrievedAt ?? evidence[0]?.retrievedAt ?? today(),
    evidenceSummary: primary?.summary ?? evidence[0]?.summary ?? 'No deal evidence on record.',
    whyCurrent: result.reason,
    amountUsd: primary?.amountUsd ?? null,
    amountText: primary?.amountText ?? null,
    roundType: primary?.roundType ?? null,
    investors: primary?.investors ?? [],
    evidenceConfidence: primary?.confidence ?? 0,
    conflicts,
    missingInformation: missing,
    classifiedAt: nowIso(),
  };

  getDb().prepare(`
    INSERT INTO company_opportunity (
      company_id, classification, primary_source_id, primary_tier, opportunity_type,
      evidence_url, evidence_published_at, evidence_retrieved_at, evidence_summary,
      why_current, amount_usd, amount_text, round_type, investors,
      evidence_confidence, conflicts, missing_information, classified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      classification = excluded.classification,
      primary_source_id = excluded.primary_source_id,
      primary_tier = excluded.primary_tier,
      opportunity_type = excluded.opportunity_type,
      evidence_url = excluded.evidence_url,
      evidence_published_at = excluded.evidence_published_at,
      evidence_retrieved_at = excluded.evidence_retrieved_at,
      evidence_summary = excluded.evidence_summary,
      why_current = excluded.why_current,
      amount_usd = excluded.amount_usd,
      amount_text = excluded.amount_text,
      round_type = excluded.round_type,
      investors = excluded.investors,
      evidence_confidence = excluded.evidence_confidence,
      conflicts = excluded.conflicts,
      missing_information = excluded.missing_information,
      classified_at = excluded.classified_at
  `).run(
    record.companyId, record.classification, record.primarySourceId, record.primaryTier,
    record.opportunityType, record.evidenceUrl, record.evidencePublishedAt,
    record.evidenceRetrievedAt, record.evidenceSummary, record.whyCurrent,
    record.amountUsd, record.amountText, record.roundType, JSON.stringify(record.investors),
    record.evidenceConfidence, JSON.stringify(record.conflicts),
    JSON.stringify(record.missingInformation), record.classifiedAt,
  );
  return record;
}

export function listOpportunities(): Opportunity[] {
  const ids = (getDb().prepare('SELECT company_id FROM company_opportunity').all() as { company_id: string }[])
    .map((r) => r.company_id);
  return ids.map((id) => getOpportunity(id)!).filter(Boolean);
}

/** Classification for every company, defaulting an unclassified company to a lead. */
export function opportunityMap(): Record<string, Opportunity | null> {
  const out: Record<string, Opportunity | null> = {};
  for (const o of listOpportunities()) out[o.companyId] = o;
  return out;
}
