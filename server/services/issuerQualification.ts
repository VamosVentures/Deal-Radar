import { getDb } from '../db/client';
import { listCompanies, getCompany, discoverySourceOf } from '../db/repos/companies';
import { listDealEvidence } from '../db/repos/opportunities';
import { politeFetch } from '../sourcing/politeness';
import { isSafeExternalUrlResolved } from '../lib/http';
import { isOperatingIssuer } from '../sourcing/formd';
import { checkEntityType } from '../sourcing/classify';
import { isThinPage, looksParkedOrPlaceholder, titleIsBareDomain } from '../sourcing/pageSignals';
import { familyOf } from '../../shared/opportunity';
import {
  explainQualification, isDisqualified, isQualifiedForOpportunity,
  MIN_INDEPENDENT_SOURCES, QUALIFICATION_LABELS, QUALIFICATION_VERSION,
  type IssuerQualification, type QualificationResult, type ReasonCode,
} from '../../shared/qualification';

/**
 * Turning "an entity filed a Form D" into a defensible verdict about
 * whether it is a venture-stage operating company.
 *
 * Order matters here, and it is deliberate. The cheap, certain
 * disqualifiers run first (the issuer's own SEC industry group, an
 * exchange ticker) so we never spend a network request confirming that a
 * public company is public. The expensive checks (website reachability)
 * run only for entities that could plausibly qualify.
 *
 * The one rule that does the most work: a Form D on its own is never
 * enough. Something INDEPENDENT — from a different source family — has
 * to also know this company exists.
 */

const SEC_UA = 'vamos-deal-radar research (contact: vamosventures.com)';

// ── Public-company detection ──────────────────────────────────────

export interface PublicCompanyCheck {
  isPubliclyTraded: boolean;
  ticker: string | null;
  exchanges: string[];
  /** Which periodic reports were seen, e.g. ['10-K','10-Q']. */
  periodicForms: string[];
  detail: string;
}

/** `"Adagio Medical Holdings, Inc.  (ADGM)  (CIK 0002006986)"` → `ADGM`. */
export function tickerFromDisplayName(display: string): string | null {
  // EDGAR full-text search embeds the ticker in a second parenthetical
  // when the filer has one. Free signal — no extra request needed.
  const withoutCik = display.replace(/\(CIK\s*\d+\)/i, '');
  const m = withoutCik.match(/\(([A-Z]{1,5}(?:\.[A-Z])?)\)/);
  return m ? m[1] : null;
}

/**
 * Ask SEC's submissions API whether this filer is a reporting public
 * company. Two independent signals: an exchange ticker, and the presence
 * of periodic reports (10-K/10-Q).
 *
 * Note the deliberate NON-rule: an S-1 alone does NOT make a company
 * public. Plenty of private companies file an S-1 and never list, or
 * withdraw it. Only a ticker or actual periodic reporting counts.
 */
export async function checkPublicCompany(cik: string): Promise<PublicCompanyCheck> {
  const padded = cik.replace(/\D/g, '').padStart(10, '0');
  const res = await politeFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    return {
      isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [],
      detail: `Could not check public status (${res.failure ?? res.status}). Treated as unknown, not as private.`,
    };
  }
  let data: {
    tickers?: string[]; exchanges?: string[];
    filings?: { recent?: { form?: string[] } };
  };
  try {
    data = JSON.parse(res.body);
  } catch {
    return { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'Submissions payload was not JSON.' };
  }

  const tickers = (data.tickers ?? []).filter(Boolean);
  const exchanges = (data.exchanges ?? []).filter(Boolean);
  const forms = data.filings?.recent?.form ?? [];
  const periodicForms = [...new Set(forms.filter((f) => /^10-[KQ]$/.test(f)))];

  const isPublic = tickers.length > 0 || periodicForms.length > 0;
  return {
    isPubliclyTraded: isPublic,
    ticker: tickers[0] ?? null,
    exchanges,
    periodicForms,
    detail: isPublic
      ? `Publicly traded: ${tickers.length > 0 ? `ticker ${tickers[0]}` : 'no ticker on record'}`
        + `${exchanges.length > 0 ? ` on ${exchanges.join('/')}` : ''}`
        + `${periodicForms.length > 0 ? `, files ${periodicForms.join(' and ')}` : ''}.`
      : 'No exchange ticker and no periodic reports — consistent with a private company.',
  };
}

// ── Website verification ──────────────────────────────────────────

export interface WebsiteCheck {
  verified: boolean;
  url: string | null;
  /** True when the page loaded but looks like a parked domain. */
  parked: boolean;
  /**
   * True when the page responded but served almost no readable text.
   * Kept separate from `parked` because they are different findings and
   * this checker was reporting the wrong one: infinity.inc is a real
   * company's real site that renders entirely in the browser, and
   * calling it "parked or placeholder" states something false about a
   * business. Neither verifies, but only one of them is an accusation.
   */
  thin?: boolean;
  detail: string;
}

/**
 * Confirm a company website actually resolves and looks like a real site.
 *
 * Runs through the DNS-aware SSRF guard first — the URL comes from an
 * external filing and must not be allowed to point at internal
 * infrastructure.
 */
export async function verifyWebsite(rawUrl: string | null | undefined): Promise<WebsiteCheck> {
  if (!rawUrl) return { verified: false, url: null, parked: false, detail: 'No website on record.' };
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  if (!(await isSafeExternalUrlResolved(url))) {
    return { verified: false, url, parked: false, detail: 'Website failed the SSRF safety check and was not fetched.' };
  }
  const res = await politeFetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) {
    return { verified: false, url, parked: false, detail: `Website did not respond (${res.failure ?? res.status}).` };
  }
  // The same detectors website DISCOVERY uses, so a domain cannot be
  // recorded by one path and rejected by the other.
  const parked = looksParkedOrPlaceholder(res.body) || titleIsBareDomain(res.body);
  // A real product site has some substance. A 200 that returns almost
  // nothing is not evidence of an operating business.
  const thin = isThinPage(res.body);

  if (parked) {
    return { verified: false, url, parked: true, thin: false, detail: 'Website appears to be a parked or placeholder domain.' };
  }
  if (thin) {
    return {
      verified: false, url, parked: false, thin: true,
      detail: 'Website responded but served almost no readable text — typically a client-rendered page. Not verified either way; needs a human.',
    };
  }
  return { verified: true, url, parked: false, thin: false, detail: 'Website responded with real content.' };
}

// ── Corroboration ─────────────────────────────────────────────────

export interface CorroborationResult {
  sources: IssuerQualification['corroboratingSources'];
  /**
   * Distinct independent sources. Usually one per source family, except
   * that two DIFFERENT news publishers count separately — see
   * corroborationKey below.
   */
  independentFamilies: string[];
  onlyEvidenceIsFormD: boolean;
}

/**
 * The identity that independence is counted by.
 *
 * Family alone is the right rule for filings: three SEC pages about one
 * Form D are one source, not three, and counting URLs is exactly the
 * trick that let single-filing entities look well-evidenced.
 *
 * The press family needs one refinement. TechCrunch and SiliconAngle
 * reporting the same round are two newsrooms that each decided the story
 * was true — that is real corroboration, and collapsing them to a single
 * "press" source would make a well-reported round look unverified. Two
 * syndicated copies from the SAME publisher still count once, which is
 * why the key is the publisher and not the URL.
 *
 * The investor-primary family gets the OPPOSITE treatment, deliberately.
 * Two firms that co-invested in one round are describing the transaction
 * they were both in; that is one account of one event from one side of
 * the table, however many websites it appears on. Splitting them per firm
 * — the mirror of what press gets — would let a syndicate of five
 * investors manufacture five "independent sources" for a single round.
 * So every investor announcement collapses to `investor-primary`.
 */
function corroborationKey(sourceId: string, sourceName: string): string {
  const family = familyOf(sourceId);
  if (family !== 'press') return family;
  const publisher = sourceName.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1]?.toLowerCase();
  return publisher ? `press:${publisher}` : 'press';
}

/**
 * Count independent corroboration for a company from its stored deal
 * evidence.
 */
export function assessCorroboration(companyId: string): CorroborationResult {
  const evidence = listDealEvidence(companyId);
  const byKey = new Map<string, typeof evidence[number]>();
  for (const e of evidence) {
    const key = corroborationKey(e.sourceId, e.sourceName);
    // Keep the strongest (lowest tier) example per source.
    const existing = byKey.get(key);
    if (!existing || e.tier < existing.tier) byKey.set(key, e);
  }
  const keys = [...byKey.keys()];
  const nonRegulatory = keys.filter((f) => f !== 'regulatory');

  return {
    sources: [...byKey.values()].map((e) => ({
      sourceId: e.sourceId, family: corroborationKey(e.sourceId, e.sourceName), url: e.url, publishedAt: e.publishedAt,
    })),
    independentFamilies: keys,
    // "Only a Form D" means: regulatory is the ONLY family present.
    onlyEvidenceIsFormD: keys.length > 0 && nonRegulatory.length === 0,
  };
}

// ── The verdict ───────────────────────────────────────────────────

export interface QualifyOptions {
  /** Skip network checks — used by tests and by bulk re-evaluation passes. */
  offline?: boolean;
  /** Injected for deterministic tests. */
  today?: string;
  /** Pre-fetched public-company answer, to avoid re-requesting. */
  publicCheck?: PublicCompanyCheck;
  /** Pre-fetched website answer. */
  websiteCheck?: WebsiteCheck;
}

const DAY = 86_400_000;

/**
 * Sources whose records always carry a registered address, so a missing
 * US state is informative rather than merely absent.
 */
const ADDRESS_BEARING_SOURCES = new Set(['sec', 'grants']);

export async function qualifyIssuer(companyId: string, opts: QualifyOptions = {}): Promise<IssuerQualification> {
  const company = getCompany(companyId);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const reasons: ReasonCode[] = [];
  const humanReview: string[] = [];

  if (!company) {
    return persist({
      companyId, result: 'insufficient-evidence', operatingConfidence: 0,
      websiteVerified: false, websiteUrl: null, isPubliclyTraded: false, ticker: null,
      isFundOrSpv: false, parentEntity: null, corroboratingSources: [],
      reasonCodes: [], fieldsRequiringHumanReview: ['Company record not found.'],
      qualifiedAt: new Date().toISOString(), version: QUALIFICATION_VERSION,
    });
  }

  // 1. Name patterns — a cheap first pass ONLY. Never the final word, but
  //    it saves a request on entities that are obviously vehicles.
  //
  //    The entity-name check runs first and is the one exception to
  //    "never the final word": if the stored string does not NAME a
  //    company, there is no entity for any later check to be about. This
  //    uses the same detector the RSS extractor uses (see
  //    server/sourcing/classify.ts), so the finding is re-derivable on
  //    every pass instead of being discovered once at import time and
  //    then overwritten by the rolling evidence verdict.
  const entityVerdict = checkEntityType(company.name);
  const nameIsNotACompany = entityVerdict.kind === 'person-possessive';
  if (nameIsNotACompany) reasons.push('name-is-not-a-company');

  const nameVerdict = isOperatingIssuer(company.name);
  let nameFundOrSpv = false;
  if (!nameVerdict.isOperatingCompany) {
    nameFundOrSpv = true;
    if (/fund|partnership|asset|lending|manager/i.test(nameVerdict.reason)) reasons.push('name-matches-fund-pattern');
    else if (/project|series|capacity|numbered/i.test(nameVerdict.reason)) reasons.push('name-matches-spv-pattern');
    else reasons.push('name-matches-subsidiary-pattern');
  }

  // 2. Recency. Evidence older than a year cannot describe a CURRENT
  //    opportunity, whatever else is true.
  const evidence = listDealEvidence(companyId);
  const dated = evidence.map((e) => e.publishedAt).filter((d): d is string => !!d);
  const newest = dated.sort().at(-1) ?? null;
  const withinYear = newest !== null && (Date.parse(today) - Date.parse(newest)) <= 365 * DAY;
  reasons.push(withinYear ? 'filing-within-12-months' : 'filing-older-than-12-months');

  // 3. Public-company status. Checked BEFORE the website so we never pay
  //    for a website request on a company we are going to reject anyway.
  const cik = extractCik(companyId, evidence.map((e) => e.url));
  let publicCheck: PublicCompanyCheck = opts.publicCheck
    ?? { isPubliclyTraded: false, ticker: null, exchanges: [], periodicForms: [], detail: 'Not checked.' };
  if (!opts.publicCheck && !opts.offline && cik) {
    publicCheck = await checkPublicCompany(cik);
  }
  if (publicCheck.isPubliclyTraded) {
    if (publicCheck.ticker) reasons.push('has-exchange-ticker');
    if (publicCheck.periodicForms.length > 0) reasons.push('files-periodic-reports');
  }

  // 4. Corroboration.
  const corr = assessCorroboration(companyId);
  if (corr.onlyEvidenceIsFormD) reasons.push('only-evidence-is-form-d');
  const independentCount = corr.independentFamilies.length;
  reasons.push(independentCount >= MIN_INDEPENDENT_SOURCES ? 'has-independent-corroboration' : 'no-independent-corroboration');

  // 5. Website — the expensive check, so it runs last.
  //
  //    Deliberately NOT gated on filing recency. Whether a company is a
  //    real operating business is independent of when it last filed: a
  //    2012 YC company with a live product site is still a real company,
  //    it is just not a current opportunity. An earlier version skipped
  //    the check whenever the newest evidence was over a year old and
  //    then recorded "website-unreachable" — reporting a failure for a
  //    request it never made, and wrongly pushing 107 real companies into
  //    "insufficient evidence". Recency governs the OPPORTUNITY verdict,
  //    not whether the entity exists.
  //
  //    It IS skipped for entities already disqualified on a cheaper,
  //    certain signal (public ticker, fund/SPV name), because no website
  //    could change that answer — and that case is recorded honestly as
  //    "not checked" rather than as a failure.
  const alreadyDisqualified = publicCheck.isPubliclyTraded || nameFundOrSpv || nameIsNotACompany;
  let websiteCheck: WebsiteCheck = opts.websiteCheck
    ?? { verified: false, url: company.website ?? null, parked: false, detail: 'Not checked.' };
  let websiteChecked = !!opts.websiteCheck;
  if (!opts.websiteCheck && !opts.offline && !alreadyDisqualified && company.website) {
    websiteCheck = await verifyWebsite(company.website);
    websiteChecked = true;
  }
  if (websiteCheck.verified) reasons.push('website-verified');
  else if (!company.website) reasons.push('website-absent');
  else if (!websiteChecked) reasons.push('website-not-checked');
  else if (websiteCheck.parked) reasons.push('website-parked-or-placeholder');
  else if (websiteCheck.thin) reasons.push('website-thin-or-client-rendered');
  else reasons.push('website-unreachable');

  const hasProductDescription = !!company.oneLiner
    && !/^unknown/i.test(company.oneLiner)
    && company.oneLiner.trim().length > 12;
  reasons.push(hasProductDescription ? 'product-or-service-described' : 'no-product-description');

  // A non-US address with no verifiable website is exactly the shape of
  // AEGIS FINTECH LTD. and DZHLWK FINTECH Ltd. — large offerings, no
  // discoverable business.
  //
  // But a blank state only MEANS a foreign address when the source always
  // records one. An SEC Form D does; a funding article usually does not.
  // Applying this rule to press-derived records labelled Ramp and Venus
  // Aerospace "unverified foreign entity", which is simply false — we did
  // not know where they were based, which is a different statement.
  const addressAlwaysOnFile = ADDRESS_BEARING_SOURCES.has(discoverySourceOf(companyId) ?? '');
  const jurisdictionUnknown = company.state === '??';
  const foreignNoWebsite = jurisdictionUnknown && addressAlwaysOnFile && !websiteCheck.verified;
  if (foreignNoWebsite) reasons.push('foreign-address-no-website');
  else if (jurisdictionUnknown) reasons.push('jurisdiction-not-stated');

  // ── Decide, most-certain disqualifier first ────────────────────
  //
  // "Not a company name" leads, ahead even of the public-company check.
  // Everything below this line reasons about an entity; this branch is
  // the one that says there isn't one. It is also the only verdict here
  // that cannot be revised by new evidence, which is precisely why it
  // must be re-derived every pass rather than remembered.
  let result: QualificationResult;
  if (nameIsNotACompany) {
    result = 'not-a-company-name';
  } else if (publicCheck.isPubliclyTraded) {
    result = 'public-company';
  } else if (nameFundOrSpv && reasons.includes('name-matches-fund-pattern')) {
    result = 'investment-fund';
  } else if (nameFundOrSpv && reasons.includes('name-matches-spv-pattern')) {
    result = 'spv-or-project-entity';
  } else if (nameFundOrSpv) {
    result = 'corporate-subsidiary';
  } else if (!withinYear) {
    result = 'company-lead-requires-corroboration';
  } else if (foreignNoWebsite && independentCount < MIN_INDEPENDENT_SOURCES) {
    result = 'unverified-foreign-entity';
    humanReview.push('Foreign or unknown-jurisdiction entity with an unverifiable website and no independent corroboration.');
  } else if (!websiteCheck.verified && !hasProductDescription && independentCount < MIN_INDEPENDENT_SOURCES) {
    // Nothing about this entity is confirmable.
    result = 'insufficient-evidence';
  } else if (websiteCheck.verified && independentCount >= MIN_INDEPENDENT_SOURCES) {
    result = 'qualified-operating-company';
  } else if (independentCount >= MIN_INDEPENDENT_SOURCES && hasProductDescription) {
    // Corroborated and describes a product, but we could not confirm the
    // site. A human can settle it quickly.
    result = 'human-review-required';
    humanReview.push('Independent corroboration exists but the website could not be verified — confirm the company is operating.');
  } else {
    result = 'company-lead-requires-corroboration';
  }

  const operatingConfidence = scoreOperating({
    websiteVerified: websiteCheck.verified,
    independentCount,
    hasProductDescription,
    isPublic: publicCheck.isPubliclyTraded,
    isFundOrSpv: nameFundOrSpv,
    isNotACompany: nameIsNotACompany,
    withinYear,
  });

  if (!websiteCheck.verified && company.website) humanReview.push(`Website ${company.website} did not verify: ${websiteCheck.detail}`);

  return persist({
    companyId,
    result,
    operatingConfidence,
    websiteVerified: websiteCheck.verified,
    websiteUrl: websiteCheck.url,
    isPubliclyTraded: publicCheck.isPubliclyTraded,
    ticker: publicCheck.ticker,
    isFundOrSpv: nameFundOrSpv,
    parentEntity: null,
    corroboratingSources: corr.sources,
    reasonCodes: [...new Set(reasons)],
    fieldsRequiringHumanReview: humanReview,
    qualifiedAt: new Date().toISOString(),
    version: QUALIFICATION_VERSION,
  });
}

function scoreOperating(f: {
  websiteVerified: boolean; independentCount: number; hasProductDescription: boolean;
  isPublic: boolean; isFundOrSpv: boolean; isNotACompany?: boolean; withinYear: boolean;
}): number {
  // No confidence is expressible about an entity that was never named.
  if (f.isPublic || f.isFundOrSpv || f.isNotACompany) return 0;
  let s = 0;
  if (f.websiteVerified) s += 0.45;
  if (f.hasProductDescription) s += 0.2;
  s += Math.min(0.3, f.independentCount * 0.15);
  if (f.withinYear) s += 0.05;
  return Math.round(Math.min(1, s) * 100) / 100;
}

/** Recover a CIK from a stored SEC filing URL: /edgar/data/1699390/... */
function extractCik(companyId: string, urls: string[]): string | null {
  for (const u of urls) {
    const m = u.match(/\/edgar\/data\/(\d+)\//);
    if (m) return m[1];
  }
  void companyId;
  return null;
}

// ── Persistence ───────────────────────────────────────────────────

function persist(q: IssuerQualification): IssuerQualification {
  getDb().prepare(`
    INSERT INTO issuer_qualification (
      company_id, result, operating_confidence, website_verified, website_url,
      is_publicly_traded, ticker, is_fund_or_spv, parent_entity,
      corroborating_sources, reason_codes, fields_requiring_human_review,
      qualified_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      result = excluded.result,
      operating_confidence = excluded.operating_confidence,
      website_verified = excluded.website_verified,
      website_url = excluded.website_url,
      is_publicly_traded = excluded.is_publicly_traded,
      ticker = excluded.ticker,
      is_fund_or_spv = excluded.is_fund_or_spv,
      parent_entity = excluded.parent_entity,
      corroborating_sources = excluded.corroborating_sources,
      reason_codes = excluded.reason_codes,
      fields_requiring_human_review = excluded.fields_requiring_human_review,
      qualified_at = excluded.qualified_at,
      version = excluded.version
  `).run(
    q.companyId, q.result, q.operatingConfidence, q.websiteVerified ? 1 : 0, q.websiteUrl,
    q.isPubliclyTraded ? 1 : 0, q.ticker, q.isFundOrSpv ? 1 : 0, q.parentEntity,
    JSON.stringify(q.corroboratingSources), JSON.stringify(q.reasonCodes),
    JSON.stringify(q.fieldsRequiringHumanReview), q.qualifiedAt, q.version,
  );
  return q;
}

export function getQualification(companyId: string): IssuerQualification | null {
  const r = getDb().prepare('SELECT * FROM issuer_qualification WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    companyId: String(r.company_id),
    result: r.result as QualificationResult,
    operatingConfidence: Number(r.operating_confidence),
    websiteVerified: Number(r.website_verified) === 1,
    websiteUrl: (r.website_url as string | null) ?? null,
    isPubliclyTraded: Number(r.is_publicly_traded) === 1,
    ticker: (r.ticker as string | null) ?? null,
    isFundOrSpv: Number(r.is_fund_or_spv) === 1,
    parentEntity: (r.parent_entity as string | null) ?? null,
    corroboratingSources: JSON.parse(String(r.corroborating_sources ?? '[]')),
    reasonCodes: JSON.parse(String(r.reason_codes ?? '[]')),
    fieldsRequiringHumanReview: JSON.parse(String(r.fields_requiring_human_review ?? '[]')),
    qualifiedAt: String(r.qualified_at),
    version: String(r.version),
  };
}

// ── Quarantine ────────────────────────────────────────────────────

/**
 * The reason to store when quarantining, given a fresh verdict.
 *
 * One helper rather than a format string at each call site, because the
 * two call sites disagreeing is how the specific finding got lost.
 *
 * For an evidence-based verdict the rolling explanation is the whole
 * answer, and it SHOULD be rewritten on every pass — that is what makes
 * "insufficient evidence" honest as evidence arrives. For
 * `not-a-company-name` the useful part is which string failed and why,
 * so the entity sentence leads. It is re-derived from the stored name by
 * the same pure detector the extractor uses, so it is stable across runs
 * without anything having to remember it.
 */
export function quarantineReasonFor(companyId: string, q: IssuerQualification): string {
  const evidenceVerdict = explainQualification(q);
  if (q.result === 'not-a-company-name') {
    const company = getCompany(companyId);
    const specific = company ? checkEntityType(company.name).reason : '';
    if (specific) return `${specific} ${evidenceVerdict}`;
  }
  return `${QUALIFICATION_LABELS[q.result]} — ${evidenceVerdict}`;
}

export function quarantine(companyId: string, reason: string): void {
  getDb().prepare('UPDATE companies SET quarantined = 1, quarantine_reason = ?, quarantined_at = ? WHERE id = ?')
    .run(reason, new Date().toISOString(), companyId);
}

export function unquarantine(companyId: string): void {
  getDb().prepare('UPDATE companies SET quarantined = 0, quarantine_reason = NULL, quarantined_at = NULL WHERE id = ?')
    .run(companyId);
}

export function isQuarantined(companyId: string): boolean {
  const r = getDb().prepare('SELECT quarantined FROM companies WHERE id = ?').get(companyId) as { quarantined: number } | undefined;
  return Number(r?.quarantined ?? 0) === 1;
}

export function listQuarantined(): { id: string; name: string; reason: string; at: string }[] {
  return (getDb().prepare(
    'SELECT id, name, quarantine_reason AS reason, quarantined_at AS at FROM companies WHERE quarantined = 1 ORDER BY name',
  ).all() as { id: string; name: string; reason: string; at: string }[]);
}

/** Record a classification change so "why did this stop being a deal?" is answerable later. */
export function recordClassificationChange(args: {
  companyId: string;
  previousClassification: string | null;
  newClassification: string;
  previousQualification: string | null;
  newQualification: string | null;
  reason: string;
}): void {
  getDb().prepare(`
    INSERT INTO classification_history (
      company_id, at, previous_classification, new_classification,
      previous_qualification, new_qualification, reason, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.companyId, new Date().toISOString(), args.previousClassification, args.newClassification,
    args.previousQualification, args.newQualification, args.reason, QUALIFICATION_VERSION,
  );
}

export function classificationHistory(companyId: string) {
  return getDb().prepare(
    'SELECT * FROM classification_history WHERE company_id = ? ORDER BY at DESC',
  ).all(companyId);
}

export { isQualifiedForOpportunity, isDisqualified, listCompanies };
