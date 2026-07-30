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

// ── The three kinds of evidence ───────────────────────────────────

/**
 * Three questions that were being answered by one signal.
 *
 * A company's website was counted as "independent corroboration", which
 * quietly made a Form D plus a domain that merely LOADS into a qualified
 * operating company — AEGIS FINTECH LTD., a $100M offering with no
 * discoverable product, among them. The mistake is not the weighting; it
 * is that three different questions were being answered by one fact:
 *
 *   1. FINANCING evidence — did a financing event actually occur?
 *      A Form D, an announcement by an investor who was in the round,
 *      reporting by a funding publication. Answered by third parties who
 *      carry some cost for being wrong.
 *
 *   2. IDENTITY evidence — does this website belong to this issuer?
 *      A domain that resolves and names the company. Necessary, and
 *      worth nothing on its own: it establishes whose page it is, not
 *      that there is a business behind it.
 *
 *   3. OPERATING evidence — does the issuer describe a product, a
 *      service, a technology, or an operating business?
 *      This is the question a Form D cannot answer and a DNS record
 *      cannot answer, and it is the one that was going unasked.
 *
 * A company's own website can answer 2 and 3. It can never answer 1,
 * because an entity asserting its own financing is not a source.
 */

/**
 * What a fetched website established, from weakest to strongest.
 *
 * Everything below `substantive` fails the operating-company gate, but
 * they fail for different reasons and only some of them say anything bad
 * about the company. `thin` in particular is a statement about our
 * checker, not about the business.
 */
export const WEBSITE_EVIDENCE_LEVELS = [
  'absent', 'not-checked', 'unreachable', 'parked', 'thin', 'unrelated',
  'undetermined', 'identity-only', 'substantive',
] as const;
export type WebsiteEvidenceLevel = (typeof WEBSITE_EVIDENCE_LEVELS)[number];

export const WEBSITE_EVIDENCE_LABELS: Record<WebsiteEvidenceLevel, string> = {
  absent: 'No website on record',
  'not-checked': 'Not checked',
  unreachable: 'Did not respond',
  parked: 'Parked or placeholder',
  thin: 'Too little text to read',
  unrelated: 'Not the issuer’s own site',
  undetermined: 'Could not be read',
  'identity-only': 'Identity only',
  substantive: 'Substantive operating evidence',
};

export const WEBSITE_EVIDENCE_MEANINGS: Record<WebsiteEvidenceLevel, string> = {
  absent: 'No website is on record, so nothing about the business could be checked.',
  'not-checked': 'The website was not fetched — the entity was already settled on a cheaper, certain signal.',
  unreachable: 'The recorded address did not respond. Nothing follows about the business either way.',
  parked: 'The page is a parking, placeholder, or for-sale listing. It is not evidence of an operating business.',
  thin: 'The page responded with almost no readable text — typically client-rendered. This is a limit of the checker, not a finding about the company; a human can settle it in a minute.',
  unrelated: 'The page is not the issuer’s own site. A page ABOUT a company, on somebody else’s domain, is reporting rather than the company describing itself — and either the recorded address is wrong or the name is.',
  undetermined: 'The page has real content that this checker could not interpret — most often a language its vocabulary does not cover. Substance may well be there; we simply cannot claim it.',
  'identity-only': 'The site belongs to the issuer but describes no product, service, technology, or operating business. It establishes who owns a domain and nothing more.',
  substantive: 'The issuer’s own site describes a product, service, technology, or operating business.',
};

/** The only level that may satisfy the operating-company gate. */
export function isSubstantiveOperatingEvidence(l: WebsiteEvidenceLevel): boolean {
  return l === 'substantive';
}

/**
 * Levels where the honest answer is "we could not tell", as opposed to
 * "we looked and there is nothing there".
 *
 * The difference decides whether a record goes to a human or is simply
 * marked uncorroborated, and it matters more than it looks. A page that
 * would not render for us, or is written in a language our vocabulary does
 * not cover, or sits on a domain whose name does not match the record, is
 * a gap in the CHECK. Recording that as "this company describes no
 * business" would be stating something we did not find out. A parked
 * for-sale listing, by contrast, is a finding.
 */
export function operatingEvidenceIsInconclusive(l: WebsiteEvidenceLevel): boolean {
  return l === 'thin' || l === 'unreachable' || l === 'not-checked'
    || l === 'undetermined' || l === 'unrelated';
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
  'website-unrelated-to-issuer',
  'website-not-interpretable',
  'website-identity-only',
  'website-substantive-operating-evidence',
  'operating-evidence-confirmed',
  'operating-evidence-unconfirmed',
  'strong-financing-evidence',
  'no-strong-financing-evidence',
  'self-published-evidence-excluded',
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
  'website-verified': 'A reachable company website was verified as belonging to this issuer. On its own this is identity evidence — it says who owns the domain, not that a business operates behind it.',
  'website-unreachable': 'The recorded website did not respond.',
  'website-absent': 'No company website is on record.',
  'website-not-checked': 'The website was not checked (the entity was already disqualified on a cheaper signal).',
  'website-parked-or-placeholder': 'The website appears parked or a placeholder rather than a real product site.',
  'website-thin-or-client-rendered': 'The website responded but served almost no readable text — typically a client-rendered page this checker cannot execute. That is not evidence the business is absent; it means the check could not answer, and a human can.',
  'website-unrelated-to-issuer': 'The recorded address is not the issuer\'s own site — the host does not correspond to the company, or the page never names it. A page written ABOUT a company is reporting, not the company describing itself.',
  'website-not-interpretable': 'The site has real content this checker could not interpret — most often a language its vocabulary does not cover. Left for a human rather than recorded as an absence of evidence.',
  'website-identity-only': 'The site belongs to this issuer but describes no product, service, technology, or operating business. A reachable domain, a certificate, a company name and a title tag are identity, not operations.',
  'website-substantive-operating-evidence': 'The issuer\'s own site describes a product, service, technology, or operating business.',
  'operating-evidence-confirmed': 'The issuer is confirmed to describe an actual operating business.',
  'operating-evidence-unconfirmed': 'Nothing on record shows this issuer describing a product, service, technology, or operating business.',
  'strong-financing-evidence': 'A financing event is on record from a tier 1–2 source that is not the company itself — a filing, a participating investor\'s announcement, or funding press.',
  'no-strong-financing-evidence': 'No financing event is on record from an independent tier 1–2 source.',
  'self-published-evidence-excluded': 'Evidence published on the company\'s own domain was not counted as an independent financing source. An entity announcing its own round is not a source for it.',
  'has-independent-corroboration': 'At least one independent FINANCING source, from a different source family, refers to this entity. The company\'s own website is never counted here.',
  'no-independent-corroboration': 'No independent financing source corroborates the filing.',
  'only-evidence-is-form-d': 'The only evidence on record is the Form D filing itself.',
  'filing-within-12-months': 'The filing is dated within the last 12 months.',
  'filing-older-than-12-months': 'The filing is older than 12 months and cannot describe a current opportunity.',
  'foreign-address-no-website': 'A non-US address with no verifiable website — cannot confirm an operating business.',
  'jurisdiction-not-stated': 'No source stated where this company is based. Unknown, not foreign.',
  /**
   * Deliberately narrow wording. This reads off `oneLiner`, which for a
   * press-sourced record is the ARTICLE HEADLINE — so it says a
   * description exists on OUR record, not that the issuer describes
   * itself. Without the distinction it sits next to
   * `operating-evidence-unconfirmed` looking like a contradiction.
   */
  'product-or-service-described': 'A one-line description is on our record. It may have come from a headline rather than from the company, so it is not operating evidence on its own.',
  'no-product-description': 'No product or service description is on our record.',
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
   * Distinct independent FINANCING sources. Multiple SEC pages describing
   * one filing count once — independence is measured by source family.
   *
   * The company's own website is deliberately absent from this list, and
   * so is anything published on the company's own domain. This array
   * answers "who other than the issuer says money moved", and the issuer
   * cannot be one of them. Operating evidence lives in
   * `operatingEvidence`, separately, because it answers a different
   * question and merging the two is what let a bare domain qualify.
   */
  corroboratingSources: z.array(z.object({
    sourceId: z.string(),
    family: z.string(),
    url: z.string(),
    publishedAt: z.string().nullable(),
  })).default([]),
  /**
   * What the issuer's own website established. Kept apart from
   * `corroboratingSources` on purpose — see the note above.
   */
  operatingEvidence: z.object({
    level: z.enum(WEBSITE_EVIDENCE_LEVELS),
    url: z.string().nullable(),
    /** Which content groups were found, for the audit trail. */
    signals: z.array(z.string()).default([]),
    detail: z.string(),
  }).default({ level: 'not-checked', url: null, signals: [], detail: 'Not checked.' }),
  reasonCodes: z.array(z.enum(REASON_CODES)).default([]),
  fieldsRequiringHumanReview: z.array(z.string()).default([]),
  qualifiedAt: z.string(),
  /** Bumped when the qualification RULES change, so old verdicts stay interpretable. */
  version: z.string(),
});
export type IssuerQualification = z.infer<typeof issuerQualificationSchema>;

/**
 * Bump when the rules change. Stored per verdict so history stays readable.
 *
 * q2.0 separated financing evidence from operating evidence. Under q1.0 a
 * company's own website counted as an independent source, so a Form D plus
 * a domain that merely responded reached `qualified-operating-company`.
 */
export const QUALIFICATION_VERSION = 'q2.0 (2026-07-30)';

/**
 * A live opportunity needs at least this many independent financing
 * sources when no substantive operating evidence is on record. See
 * `meetsCorroborationStandard` for why the number alone is not the rule.
 */
export const MIN_INDEPENDENT_SOURCES = 2;
/** At most this many opportunities per sector may have SEC as their primary source. */
export const MAX_SEC_PRIMARY_PER_SECTOR = 2;

export interface CorroborationStanding {
  /** Independent financing sources — never the company itself. */
  independentFinancingSources: number;
  /** What the issuer's own site established. */
  operatingEvidence: WebsiteEvidenceLevel;
}

/**
 * The bar for calling something a qualified operating company, in one
 * place, because two places had it and disagreed.
 *
 * Qualification enforces it, and the shortlist builder enforces it again as
 * a second lock on the same door. That redundancy is deliberate and worth
 * keeping — but only while both locks are cut to the same key, so both read
 * this function rather than counting sources themselves.
 *
 * Both halves are required, and they are required because they answer
 * different questions:
 *
 *   - At least one INDEPENDENT FINANCING source. Something other than the
 *     issuer says money moved: a filing, a participating investor, funding
 *     press.
 *
 *   - SUBSTANTIVE OPERATING evidence. The issuer describes an actual
 *     product, service, technology, or business.
 *
 * Note what is deliberately NOT required: a second news article. One
 * strong financing source plus a real product site is two different
 * questions each answered well, and holding out for press coverage on top
 * would reject real companies for the crime of not being written about
 * yet. Two independent financing sources with no confirmable operating
 * evidence does not clear the bar either — it goes to a human, because
 * "several people say they raised" is not "we know there is a business".
 *
 * What no longer clears it, and used to: one financing source plus a
 * domain that resolves.
 */
export function meetsOperatingCompanyStandard(s: CorroborationStanding): boolean {
  return s.independentFinancingSources >= 1 && isSubstantiveOperatingEvidence(s.operatingEvidence);
}

/** Human-readable summary of a verdict, for the UI and the audit log. */
export function explainQualification(q: IssuerQualification): string {
  const head = QUALIFICATION_LABELS[q.result];
  const reasons = q.reasonCodes.map((c) => REASON_TEXT[c]).filter(Boolean);
  const corr = q.corroboratingSources.length;
  const corrText = corr === 0
    ? 'No independent financing source.'
    : `${corr} independent financing source${corr === 1 ? '' : 's'} (${[...new Set(q.corroboratingSources.map((s) => s.family))].join(', ')}).`;
  const level = q.operatingEvidence?.level ?? 'not-checked';
  const opText = `Operating evidence: ${WEBSITE_EVIDENCE_LABELS[level].toLowerCase()}.`;
  return [head + '.', corrText, opText, ...reasons].join(' ');
}
