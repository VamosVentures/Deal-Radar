import { z } from 'zod';

/**
 * Evidence-based issuer qualification.
 *
 * A Form D filing proves that an entity reported an exempt offering. It
 * does NOT prove the entity is a venture-stage operating company. Real
 * runs turned up, all filing genuine Form Ds with genuine amounts:
 *
 *   - Adagio Medical Holdings, Inc. — publicly traded (ticker ADGM,
 *     files 10-Q), which a Form D filing says nothing about
 *   - Fresenius Medical Care North Dallas, LLC — a dialysis subsidiary
 *     of a listed multinational
 *   - PIMCO Asset-Based Lending Co LLC — a lending vehicle
 *   - Scenic Hill Solar LI, LLC — number 51 in a solar project series
 *   - AEGIS FINTECH LTD., DZHLWK FINTECH Ltd. — $100M offerings from
 *     entities with no discoverable product, website, or press
 *
 * The previous filter was name patterns only. Names are a cheap FIRST
 * pass — they can reject an obvious fund before we spend a request — but
 * they cannot be the final word, because a shell can be named anything
 * and a real startup can be named "Holdings".
 *
 * So qualification is now a structured verdict built from evidence:
 * does a real website exist, is the entity publicly traded, is there an
 * INDEPENDENT source that refers to the same entity. "Insufficient
 * evidence" is a first-class outcome and can never become a live
 * opportunity.
 */

export const QUALIFICATION_RESULTS = [
  'qualified-operating-company',
  'company-lead-requires-corroboration',
  'public-company',
  'investment-fund',
  'spv-or-project-entity',
  'corporate-subsidiary',
  'unverified-foreign-entity',
  'not-a-company-name',
  'insufficient-evidence',
  'human-review-required',
] as const;
export type QualificationResult = (typeof QUALIFICATION_RESULTS)[number];

export const QUALIFICATION_LABELS: Record<QualificationResult, string> = {
  'qualified-operating-company': 'Qualified operating company',
  'company-lead-requires-corroboration': 'Company lead — needs corroboration',
  'public-company': 'Publicly traded',
  'investment-fund': 'Investment fund',
  'spv-or-project-entity': 'SPV / project entity',
  'corporate-subsidiary': 'Corporate subsidiary',
  'unverified-foreign-entity': 'Unverified foreign entity',
  'not-a-company-name': 'Not a company name',
  'insufficient-evidence': 'Insufficient evidence',
  'human-review-required': 'Human review required',
};

/** Only this one may back a live opportunity. Everything else is a lead or worse. */
export function isQualifiedForOpportunity(r: QualificationResult): boolean {
  return r === 'qualified-operating-company';
}

/**
 * Results that mean "this is not a venture deal and should not sit in the
 * review queue as though it were". Quarantined rather than deleted — the
 * evidence stays for audit.
 */
export const DISQUALIFYING_RESULTS: QualificationResult[] = [
  'public-company', 'investment-fund', 'spv-or-project-entity',
  'corporate-subsidiary', 'unverified-foreign-entity', 'not-a-company-name',
];

/**
 * Verdicts that describe the ENTITY ITSELF rather than the state of the
 * evidence about it.
 *
 * The distinction matters because the two age differently. "Insufficient
 * evidence" is a rolling judgement — find a second source and it changes.
 * "This string is not a company name" is a property of the record that no
 * future filing can revise, so it must outrank the rolling verdict rather
 * than be overwritten by it every time requalification runs. It did get
 * overwritten, which is why this list exists.
 */
export const DURABLE_ENTITY_RESULTS: QualificationResult[] = [
  'not-a-company-name', 'investment-fund', 'spv-or-project-entity',
];

export function isDurableEntityFinding(r: QualificationResult): boolean {
  return DURABLE_ENTITY_RESULTS.includes(r);
}

export function isDisqualified(r: QualificationResult): boolean {
  return DISQUALIFYING_RESULTS.includes(r);
}

/** Machine-readable reasons, so a verdict is auditable rather than a vibe. */
export const REASON_CODES = [
  'name-matches-fund-pattern',
  'name-matches-spv-pattern',
  'name-matches-subsidiary-pattern',
  'name-is-not-a-company',
  'sec-industry-group-is-pooled-fund',
  'has-exchange-ticker',
  'files-periodic-reports',
  'website-verified',
  'website-unreachable',
  'website-absent',
  'website-not-checked',
  'website-parked-or-placeholder',
  'website-thin-or-client-rendered',
  'has-independent-corroboration',
  'no-independent-corroboration',
  'only-evidence-is-form-d',
  'filing-within-12-months',
  'filing-older-than-12-months',
  'foreign-address-no-website',
  'jurisdiction-not-stated',
  'product-or-service-described',
  'no-product-description',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_TEXT: Record<ReasonCode, string> = {
  'name-matches-fund-pattern': 'The entity name matches a fund-vehicle naming pattern.',
  'name-matches-spv-pattern': 'The entity name matches a single-project or numbered-series vehicle.',
  'name-matches-subsidiary-pattern': 'The entity name matches a subsidiary of a known large operator.',
  'name-is-not-a-company': 'The stored name describes a company rather than naming one — usually a headline subject that attributes a company to a person. No corroboration can make this a deal, because there is no named entity to corroborate.',
  'sec-industry-group-is-pooled-fund': 'The issuer told the SEC its industry group is a pooled investment fund.',
  'has-exchange-ticker': 'The issuer has an exchange ticker on record with the SEC.',
  'files-periodic-reports': 'The issuer files 10-K/10-Q periodic reports — it is a public reporting company.',
  'website-verified': 'A reachable company website was verified.',
  'website-unreachable': 'The recorded website did not respond.',
  'website-absent': 'No company website is on record.',
  'website-not-checked': 'The website was not checked (the entity was already disqualified on a cheaper signal).',
  'website-parked-or-placeholder': 'The website appears parked or a placeholder rather than a real product site.',
  'website-thin-or-client-rendered': 'The website responded but served almost no readable text — typically a client-rendered page this checker cannot execute. That is not evidence the business is absent; it means the check could not answer, and a human can.',
  'has-independent-corroboration': 'At least one independent source, from a different source family, refers to this entity.',
  'no-independent-corroboration': 'No independent source corroborates the filing.',
  'only-evidence-is-form-d': 'The only evidence on record is the Form D filing itself.',
  'filing-within-12-months': 'The filing is dated within the last 12 months.',
  'filing-older-than-12-months': 'The filing is older than 12 months and cannot describe a current opportunity.',
  'foreign-address-no-website': 'A non-US address with no verifiable website — cannot confirm an operating business.',
  'jurisdiction-not-stated': 'No source stated where this company is based. Unknown, not foreign.',
  'product-or-service-described': 'A product or service description is on record.',
  'no-product-description': 'No product or service description is on record.',
};

export const issuerQualificationSchema = z.object({
  companyId: z.string(),
  result: z.enum(QUALIFICATION_RESULTS),
  /** 0–1. How confident we are this is a real operating company. */
  operatingConfidence: z.number().min(0).max(1),
  websiteVerified: z.boolean(),
  websiteUrl: z.string().nullable(),
  isPubliclyTraded: z.boolean(),
  ticker: z.string().nullable(),
  isFundOrSpv: z.boolean(),
  /** Parent entity when the issuer looks like a subsidiary. */
  parentEntity: z.string().nullable(),
  /**
   * Distinct INDEPENDENT sources. Multiple SEC pages describing one
   * filing count once — independence is measured by source family.
   */
  corroboratingSources: z.array(z.object({
    sourceId: z.string(),
    family: z.string(),
    url: z.string(),
    publishedAt: z.string().nullable(),
  })).default([]),
  reasonCodes: z.array(z.enum(REASON_CODES)).default([]),
  fieldsRequiringHumanReview: z.array(z.string()).default([]),
  qualifiedAt: z.string(),
  /** Bumped when the qualification RULES change, so old verdicts stay interpretable. */
  version: z.string(),
});
export type IssuerQualification = z.infer<typeof issuerQualificationSchema>;

/** Bump when the rules change. Stored per verdict so history stays readable. */
export const QUALIFICATION_VERSION = 'q1.0 (2026-07-29)';

/** A live opportunity needs at least this many independent sources. */
export const MIN_INDEPENDENT_SOURCES = 2;
/** At most this many opportunities per sector may have SEC as their primary source. */
export const MAX_SEC_PRIMARY_PER_SECTOR = 2;

/** Human-readable summary of a verdict, for the UI and the audit log. */
export function explainQualification(q: IssuerQualification): string {
  const head = QUALIFICATION_LABELS[q.result];
  const reasons = q.reasonCodes.map((c) => REASON_TEXT[c]).filter(Boolean);
  const corr = q.corroboratingSources.length;
  const corrText = corr === 0
    ? 'No independent corroboration.'
    : `${corr} independent source${corr === 1 ? '' : 's'} (${[...new Set(q.corroboratingSources.map((s) => s.family))].join(', ')}).`;
  return [head + '.', corrText, ...reasons].join(' ');
}
