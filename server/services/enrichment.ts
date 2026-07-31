import { getDb } from '../db/client';
import { applyFieldUpdate, setResolvedFounder } from '../db/repos/companies';
import { audit } from '../lib/guard';
import { politeFetch, RequestBudget } from '../sourcing/politeness';
import { parseFormD } from '../sourcing/formd';
import { isThinPage, readableText } from '../sourcing/pageSignals';
import { getQualification } from './issuerQualification';
import {
  classifyFormDRelationship, extractPeopleFromHtml, truncateSupport,
} from '../enrichment/founderExtraction';
import { classifyCompany } from '../enrichment/verticalClassifier';
import { extractDescription, extractLocation } from '../enrichment/companyFacts';
import { readStatedStage, resolveStage, type StageEvidenceItem } from '../enrichment/stageResolver';
import {
  buildResearchPlan, isOnCompanyDomain, type FamilyPlan, type PlanCompany,
} from '../enrichment/researchPlan';
import {
  completeEnrichmentRun, EMPTY_TOTALS, recordResearchAttempt, saveFounderResolution,
  saveStageResolution, saveVerticalClassification, startEnrichmentRun, upsertFounderCandidate,
  upsertRelationship, type EnrichmentRunTotals,
} from '../db/repos/enrichment';
import {
  ENRICHMENT_VERSION, isAuthoritativeFamily, meetsMatchThreshold, personKey, scoreMatch,
  SOURCE_FAMILY_SPECS, isClassified, NON_SECTOR_STATUS, outcomeAnswered, outcomeInconclusive,
  STAGE_LABELS,
  type FounderResolutionStatus, type MatchSignal, type ResearchOutcome, type SourceFamily,
  type StageResolution, type VerticalClassification,
} from '../../shared/enrichment';

/**
 * The founder / vertical / stage enrichment pipeline.
 *
 * Replaces four placeholders — "Identity not on record", "Unknown"
 * founder, "Unknown" vertical, "Unknown" stage — with either a sourced
 * fact, a labelled inference, a named candidate, a stated conflict, or a
 * research result that says what was searched and what to do next.
 *
 * WHAT THIS PIPELINE WILL NOT DO
 *
 * It will not invent a founder to empty a column. It will not translate a
 * Form D into "Seed". It will not attach a person to a company on a name
 * match. It will not infer demographic identity from anything, ever. Each
 * of those would turn a visibly empty field into an invisibly wrong one,
 * which is strictly worse: a reviewer can see a gap, and cannot see a
 * fabrication.
 *
 * Every network call goes through sourcing/politeness.ts — one request at
 * a time per host, minimum gaps, honoured Retry-After, bounded backoff,
 * and a hard per-run budget. Nothing here fetches anything behind a login
 * wall or works around an access control; a source that refuses is
 * recorded as having refused.
 */

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

/** Long-format date for the reviewer-facing summary sentence. */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export interface EnrichmentOptions {
  /** Nothing is written when false. The default everywhere. */
  apply: boolean;
  companyIds?: string[];
  limit?: number;
  /** Only companies with no research attempt on record. */
  resume?: boolean;
  /** Hard cap on real network requests for the whole run. */
  maxRequests?: number;
  initiatedBy: string;
  /** Progress line per company, for the CLI. */
  onProgress?: (line: string) => void;
  /**
   * How many companies to research at once.
   *
   * Concurrency here is across COMPANIES, which are overwhelmingly on
   * different hosts. The per-host queue in sourcing/politeness.ts is
   * untouched and still serializes every request to a shared host —
   * sec.gov and ycombinator.com appear in many companies' plans, and
   * they stay one-request-at-a-time with the same minimum gap. So this
   * costs nobody else anything, and it is the difference between a run
   * that takes minutes and one that takes most of a day: a dead domain
   * burns 10s per attempt, and a strictly sequential loop pays that
   * cost 209 times over with the network idle throughout.
   */
  concurrency?: number;
}

export interface CompanyEnrichmentResult {
  companyId: string;
  companyName: string;
  founderStatus: FounderResolutionStatus;
  founderSummary: string;
  founderNextAction: string;
  candidatesFound: number;
  sourcesAttempted: SourceFamily[];
  attempts: { family: SourceFamily; outcome: ResearchOutcome; detail: string }[];
  vertical: VerticalClassification;
  stage: StageResolution;
  /** Populated when this run changed a stored verdict — the before/after report reads this. */
  changes: { field: string; previous: string | null; next: string }[];
}

export interface EnrichmentRunResult {
  runId: string;
  mode: 'dry-run' | 'apply';
  companies: CompanyEnrichmentResult[];
  totals: EnrichmentRunTotals;
  sourceErrors: { sourceFamily: string; detail: string; count: number }[];
  requestsSpent: number;
  status: 'Completed' | 'Completed with warnings' | 'Failed';
}

// ── Loading a company's raw material ──────────────────────────────

interface RawCompany extends PlanCompany {
  oneLiner: string;
  subcategory: string;
  foundedYear: number | null;
  teamSize: number | null;
  quarantined: boolean;
}

function loadCompanies(opts: EnrichmentOptions): RawCompany[] {
  const db = getDb();
  let sql = "SELECT * FROM companies WHERE status = 'active'";
  const params: string[] = [];
  if (opts.companyIds && opts.companyIds.length > 0) {
    sql += ` AND id IN (${opts.companyIds.map(() => '?').join(',')})`;
    params.push(...opts.companyIds);
  }
  if (opts.resume) {
    sql += ' AND NOT EXISTS (SELECT 1 FROM founder_research_attempts a WHERE a.company_id = companies.id)';
  }
  sql += ' ORDER BY created_at, id';
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Number(opts.limit)}`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => {
    const id = r.id as string;
    const evidence = db.prepare('SELECT claim, source, url, date, type FROM evidence WHERE company_id = ? ORDER BY id')
      .all(id) as RawCompany['evidence'];
    const dealRows = db.prepare('SELECT source_id, source_name, url, published_at, summary FROM deal_evidence WHERE company_id = ? ORDER BY id')
      .all(id) as { source_id: string; source_name: string; url: string; published_at: string | null; summary: string }[];
    const website = (r.website as string | null) || null;
    return {
      id,
      name: r.name as string,
      website: website && website !== 'Unknown' ? website : null,
      accelerator: (r.accelerator as string | null) || null,
      city: (r.city as string | null) || null,
      state: (r.state as string | null) || null,
      oneLiner: (r.one_liner as string) ?? '',
      subcategory: (r.subcategory as string) ?? '',
      foundedYear: typeof r.founded_year === 'number' && r.founded_year > 1900 ? r.founded_year : null,
      teamSize: typeof r.team_size === 'number' && r.team_size > 0 ? r.team_size : null,
      quarantined: Number(r.quarantined ?? 0) === 1,
      evidence,
      dealEvidence: dealRows.map((d) => ({
        sourceId: d.source_id, sourceName: d.source_name, url: d.url,
        publishedAt: d.published_at, summary: d.summary,
      })),
    };
  });
}

// ── Founder research ──────────────────────────────────────────────

/**
 * Facts about the COMPANY (not its founders) that the research already
 * has in hand, and that the scoring model reads off the company row.
 *
 * These were being parsed and thrown away. The SEC Form D primary
 * document states the issuer's city, state, amount sold, and date of
 * first sale; the YC directory states the batch. Meanwhile the dashboard
 * showed N/A for location on 62% of companies and no funding on 69%, and
 * the fit score excluded the geography and funding components for the
 * same records — a gap in our plumbing being reported as a gap in the
 * evidence.
 *
 * Every value here is copied from a source we fetched and cited. Nothing
 * is inferred, and nothing overwrites a value with stronger provenance.
 */
interface ResearchedFacts {
  city?: string;
  state?: string;
  amountText?: string;
  fundingDate?: string;
  accelerator?: string;
  /** The phrase a location was read from, cited when the value is stored. */
  locationEvidence?: string;
  description?: string;
}

interface FoundCandidate {
  personKey: string;
  fullName: string;
  title: string | null;
  sourceUrl: string;
  sourceFamily: SourceFamily;
  sourceType: string;
  publishedAt: string | null;
  supportingText: string;
  matchSignals: MatchSignal[];
  matchScore: number;
  confidence: number;
}

/**
 * Which signals tie this person, found in this source, to this company.
 *
 * A shared name contributes `name-only`, which is worth zero. That is
 * deliberate and it is the safety property of the whole pipeline: a
 * person can never be attached to a company because their name matched.
 */
function signalsFor(args: {
  company: RawCompany;
  family: SourceFamily;
  url: string;
  pageText: string;
  titleStated: boolean;
  geographyAgrees: boolean;
}): MatchSignal[] {
  const signals: MatchSignal[] = ['name-only'];
  if (args.family === 'sec-form-d') signals.push('sec-related-person');
  if (isOnCompanyDomain(args.url, args.company.website)) signals.push('statement-on-company-domain');
  if (args.family === 'accelerator') signals.push('accelerator-profile-for-company');
  if (args.family === 'investor-portfolio') signals.push('investor-announcement-names-company');
  if (args.titleStated) signals.push('title-stated-in-source');

  const lowerPage = args.pageText.toLowerCase();
  if (args.company.name.length > 3 && lowerPage.includes(args.company.name.toLowerCase())) {
    signals.push('company-name-in-source-text');
  }
  if (args.company.website) {
    const domain = args.company.website.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0];
    if (domain.length > 4 && lowerPage.includes(domain.toLowerCase())) signals.push('domain-in-source');
  }
  if (args.geographyAgrees) signals.push('geography-agrees');
  return [...new Set(signals)];
}

/** Does the page's text agree with the company's recorded city/state? */
function geographyAgrees(pageText: string, c: RawCompany): boolean {
  const lower = pageText.toLowerCase();
  const city = c.city && c.city !== 'Unknown' ? c.city.toLowerCase() : null;
  return city !== null && city.length > 3 && lower.includes(city);
}

/**
 * Confidence for one candidate.
 *
 * Driven by the match score and whether the family is authoritative,
 * and capped below certainty for non-authoritative families no matter
 * how many signals fire — a conference bio naming someone as founder is
 * good evidence and is still not the company saying it.
 */
function candidateConfidence(score: number, family: SourceFamily, titleStated: boolean): number {
  const base = Math.min(0.9, score / 10);
  const authoritative = isAuthoritativeFamily(family);
  const value = base * (authoritative ? 1 : 0.6) + (titleStated ? 0.08 : 0);
  return Number(Math.max(0.05, Math.min(authoritative ? 0.95 : 0.6, value)).toFixed(2));
}

async function researchFamily(
  c: RawCompany,
  plan: FamilyPlan,
  budget: RequestBudget,
): Promise<{ outcome: ResearchOutcome; detail: string; candidates: FoundCandidate[]; url: string | null; pageText: string; facts: ResearchedFacts }> {
  if (plan.unavailableReason) {
    return {
      outcome: plan.unavailableReason,
      detail: plan.unavailableReason === 'source-not-applicable'
        ? `${SOURCE_FAMILY_SPECS[plan.family].label} does not apply to this company — nothing on record connects it to this family.`
        : `No ${SOURCE_FAMILY_SPECS[plan.family].label.toLowerCase()} URL is on record for this company, so there was nothing to fetch. `
          + 'No address was guessed and no service requiring an account was queried.',
      candidates: [],
      url: null,
      pageText: '',
      facts: {},
    };
  }

  const candidates: FoundCandidate[] = [];
  /**
   * Per-family accounting rather than "whatever the last URL did".
   *
   * The first version reported the LAST page's detail for the whole
   * family, so a company whose home page was read fine and whose /about
   * timed out was described as "did not respond within 10000ms" while
   * simultaneously being recorded as answered. The two halves of that
   * contradicted each other, and the sentence a reviewer would read was
   * the false one.
   */
  let readOk = 0;
  let unreadable = 0;
  let failed = 0;
  let blocked = 0;
  const notes: string[] = [];
  let lastUrl: string | null = null;
  let firstReadUrl: string | null = null;
  /**
   * The readable text actually gathered from this family.
   *
   * Returned separately from `detail` because the two are different
   * things and conflating them was a real bug: the classifier was being
   * handed the attempt SUMMARY ("5 page(s) attempted: 1 read…") instead
   * of the page content, so a company describing itself in full on its
   * own home page was scored against a sentence about our fetching. Only
   * 3 of 209 records reached an `explicit` classification as a result.
   */
  const gatheredText: string[] = [];
  const facts: ResearchedFacts = {};

  for (const fetchPlan of plan.fetches) {
    lastUrl = fetchPlan.url;
    const res = await politeFetch(fetchPlan.url, {
      budget,
      headers: {
        // The SEC requires a declared identity on automated requests, and
        // it is the right courtesy for every other host too.
        'user-agent': 'VamosDealRadar/1.0 (deal sourcing research; contact: matthew@vamosventures.com)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      if (res.failure === 'forbidden') blocked += 1; else failed += 1;
      notes.push(`${fetchPlan.url}: ${res.detail ?? 'request failed'}`);
      if (res.failure === 'budget-exhausted') break;
      continue;
    }

    if (plan.family === 'sec-form-d') {
      // Structured field, not prose: the SEC tells us the related
      // persons and their relationship to the issuer directly.
      const filing = parseFormD(res.body);
      for (const p of filing.relatedPersons) {
        const kind = classifyFormDRelationship(p.relationship);
        // A director may be an investor's board seat rather than a
        // founder, so directors are recorded as candidates but never
        // reach the verified bar on their own — see deriveFounderStatus.
        if (kind === 'other') continue;
        const signals = signalsFor({
          company: c, family: plan.family, url: fetchPlan.url,
          pageText: res.body, titleStated: true,
          geographyAgrees: filing.city !== null && c.city !== null
            && filing.city.toLowerCase() === c.city.toLowerCase(),
        });
        if (!meetsMatchThreshold(signals)) continue;
        const score = scoreMatch(signals);
        candidates.push({
          personKey: personKey(p.name),
          fullName: p.name,
          title: p.relationship,
          sourceUrl: fetchPlan.url,
          sourceFamily: plan.family,
          sourceType: fetchPlan.sourceType,
          publishedAt: fetchPlan.publishedAt,
          supportingText: truncateSupport(
            `Form D related person: ${p.name}, relationship "${p.relationship}", issuer "${filing.entityName ?? c.name}".`,
          ),
          matchSignals: signals,
          matchScore: score,
          confidence: candidateConfidence(score, plan.family, true),
        });
      }
      // The issuer's own filing states these. Recorded rather than
      // discarded — see ResearchedFacts.
      if (filing.city && !facts.city) facts.city = filing.city.trim();
      if (filing.stateOrCountry && !facts.state) facts.state = filing.stateOrCountry.trim();
      if (filing.totalAmountSoldUsd && !facts.amountText) {
        facts.amountText = `$${(filing.totalAmountSoldUsd / 1_000_000).toFixed(2)}M sold (Form D)`;
      }
      if (filing.dateOfFirstSale && !facts.fundingDate) facts.fundingDate = filing.dateOfFirstSale;

      readOk += 1;
      firstReadUrl ??= fetchPlan.url;
      notes.push(filing.relatedPersons.length > 0
        ? `${fetchPlan.url}: ${filing.relatedPersons.length} related person(s) on the Form D primary document.`
        : `${fetchPlan.url}: the Form D primary document lists no related persons.`);
      continue;
    }

    // Every other family is an HTML page.
    const pageText = readableText(res.body);

    /**
     * A page that responded with almost nothing is not an answer.
     *
     * The Y Combinator directory serves a 39-character shell and renders
     * its listings in the browser, which this checker does not execute.
     * Counting that as "the accelerator profile names no founder" would
     * be a false statement about a page that in fact names several, and
     * it would inflate the exhaustion claim — the one claim in this whole
     * pipeline that has to be trustworthy.
     */
    if (isThinPage(res.body)) {
      unreadable += 1;
      notes.push(`${fetchPlan.url}: responded with ${pageText.length} readable characters — rendered in the browser, not readable here.`);
      continue;
    }

    readOk += 1;
    firstReadUrl ??= fetchPlan.url;
    gatheredText.push(pageText);
    const people = extractPeopleFromHtml(res.body);
    for (const person of people) {
      const signals = signalsFor({
        company: c, family: plan.family, url: fetchPlan.url,
        pageText, titleStated: person.title !== null,
        geographyAgrees: geographyAgrees(pageText, c),
      });
      if (!meetsMatchThreshold(signals)) continue;
      const score = scoreMatch(signals);
      candidates.push({
        personKey: personKey(person.fullName),
        fullName: person.fullName,
        title: person.title,
        sourceUrl: fetchPlan.url,
        sourceFamily: plan.family,
        sourceType: fetchPlan.sourceType,
        publishedAt: fetchPlan.publishedAt,
        supportingText: person.supportingText,
        matchSignals: signals,
        matchScore: score,
        confidence: candidateConfidence(score, plan.family, person.title !== null),
      });
    }
    notes.push(people.length > 0
      ? `${fetchPlan.url}: ${pageText.length} characters read, ${people.length} person(s) with a stated founder or officer title.`
      : `${fetchPlan.url}: ${pageText.length} characters read, no person named with a founder or officer title.`);
  }

  /**
   * One sentence describing what happened across the WHOLE family,
   * followed by the per-URL notes. Both halves matter: the sentence is
   * what a reviewer skims, and the notes are what they check.
   */
  const attempted = plan.fetches.length;
  const headline = `${attempted} page(s) attempted: ${readOk} read`
    + `${unreadable > 0 ? `, ${unreadable} rendered in the browser and unreadable here` : ''}`
    + `${failed > 0 ? `, ${failed} did not respond` : ''}`
    + `${blocked > 0 ? `, ${blocked} refused access` : ''}.`;
  const detail = `${headline} ${notes.slice(0, 6).join(' ')}`.trim();
  const url = firstReadUrl ?? lastUrl;
  // Capped: the classifier needs a description, not a whole site, and an
  // unbounded string here would be held in memory for every company in
  // the concurrent pool.
  const pageText = gatheredText.join(' \n ').slice(0, 20_000);

  if (candidates.length > 0) return { outcome: 'found-candidate', detail, candidates, url, pageText, facts };

  // A family that read at least one real page HAS answered: it was
  // readable and it names nobody.
  if (readOk > 0) return { outcome: 'reached-no-founder-stated', detail, candidates: [], url, pageText, facts };

  // Everything below is an attempt, NOT a finding about the company —
  // see the note on founder_research_attempts in migration 11.
  if (unreadable > 0 && failed === 0 && blocked === 0) {
    return { outcome: 'source-unreadable', detail, candidates: [], url, pageText, facts };
  }
  if (blocked > 0 && failed === 0) return { outcome: 'source-blocked', detail, candidates: [], url, pageText, facts };
  return { outcome: 'source-unreachable', detail, candidates: [], url, pageText, facts };
}

/**
 * Roles that only one person can hold at a time. Two different people
 * asserted into the same one is a real disagreement between sources;
 * two people both described as "Co-Founder" is a company with two
 * founders, which is not a conflict and must not be reported as one.
 */
/**
 * Singular roles, and the spellings that mean the same one.
 *
 * Canonicalised rather than listed flat, because "CEO" and "Chief
 * Executive Officer" are one role. Matched as separate keys they land in
 * separate buckets, and two sources naming two different chief
 * executives — a genuine disagreement, and the exact case this check
 * exists for — sailed through as agreement.
 */
const SINGULAR_ROLE_ALIASES: [string, string[]][] = [
  ['ceo', ['ceo', 'chief executive officer']],
  ['cto', ['cto', 'chief technology officer']],
  ['coo', ['coo', 'chief operating officer']],
  ['cfo', ['cfo', 'chief financial officer']],
  ['president', ['president']],
];

/**
 * Word-boundary matched, and that is not a stylistic preference.
 *
 * A plain substring test reads "Director" as "CTO" — d-i-r-e-**c-t-o**-r —
 * so every Form D director became a competing CTO claim, and any company
 * with two directors on its filing was reported as having conflicting
 * founder evidence. AOA Dx surfaced exactly that in a dry run: three
 * people, none of whom the filing calls a CTO, presented as a
 * disagreement about who the CTO is.
 *
 * A false conflict is not a harmless over-caution. It buries a real
 * answer under a warning and sends a reviewer to arbitrate a dispute
 * that does not exist.
 */
function singularRoleOf(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [canonical, spellings] of SINGULAR_ROLE_ALIASES) {
    if (spellings.some((s) => new RegExp(`\\b${s}\\b`).test(t))) return canonical;
  }
  return null;
}

export interface FounderVerdict {
  status: FounderResolutionStatus;
  resolvedPersonKey: string | null;
  resolvedName: string | null;
  resolvedTitle: string | null;
  summary: string;
  nextAction: string;
}

/**
 * Turn candidates plus attempt outcomes into a verdict.
 *
 * Exported and pure so the policy is unit-testable independently of any
 * fetching.
 */
export function deriveFounderStatus(
  companyName: string,
  candidates: FoundCandidate[],
  attempts: { family: SourceFamily; outcome: ResearchOutcome }[],
  atIso: string,
): FounderVerdict {
  const attemptedLabels = attempts.map((a) => SOURCE_FAMILY_SPECS[a.family].label);
  const answered = attempts.filter((a) => outcomeAnswered(a.outcome));
  // Unreadable counts as unanswered alongside unreachable and blocked:
  // a browser-rendered page we could not execute has not told us
  // anything, and folding it into "we looked and found nothing" is what
  // would make the exhaustion claim untrue.
  const unanswered = attempts.filter((a) => outcomeInconclusive(a.outcome));

  // ── Conflict: one singular role, two different people ────────────
  const byRole = new Map<string, Set<string>>();
  for (const c of candidates) {
    const role = singularRoleOf(c.title);
    if (!role) continue;
    (byRole.get(role) ?? byRole.set(role, new Set()).get(role)!).add(c.personKey);
  }
  const conflicted = [...byRole.entries()].find(([, people]) => people.size > 1);
  if (conflicted) {
    const [role, people] = conflicted;
    const names = candidates.filter((c) => people.has(c.personKey)).map((c) => c.fullName);
    return {
      status: 'conflicting-founder-evidence',
      resolvedPersonKey: null,
      resolvedName: null,
      resolvedTitle: null,
      summary: `Sources disagree about who holds the ${role.toUpperCase()} role at ${companyName}: `
        + `${[...new Set(names)].join(' and ')} are each named by a different source. `
        + 'No person has been selected, because picking one would hide a real disagreement behind a confident-looking field.',
      nextAction: 'Open the candidate evidence, compare the source dates, and confirm or reject each candidate. '
        + 'A leadership change between the two source dates is the most common explanation.',
    };
  }

  // ── Verified: an authoritative family states the person AND title ──
  //
  // A director on a Form D is deliberately excluded: a board seat is
  // frequently an investor's, and calling that person a founder would be
  // wrong about a real individual.
  const verified = candidates
    .filter((c) => isAuthoritativeFamily(c.sourceFamily) && c.title !== null && c.matchScore >= 7)
    .filter((c) => !(c.sourceFamily === 'sec-form-d' && classifyFormDRelationship(c.title ?? '') === 'director'))
    .sort((a, b) => b.matchScore - a.matchScore || b.confidence - a.confidence);

  if (verified.length > 0) {
    const best = verified[0];
    const corroborators = new Set(
      candidates.filter((c) => c.personKey === best.personKey).map((c) => c.sourceFamily),
    );
    return {
      status: 'verified-founder',
      resolvedPersonKey: best.personKey,
      resolvedName: best.fullName,
      resolvedTitle: best.title,
      summary: `${best.fullName} — ${best.title}, attributed to ${SOURCE_FAMILY_SPECS[best.sourceFamily].label} `
        + `(${best.sourceUrl})${corroborators.size > 1 ? `, corroborated across ${corroborators.size} source families` : ''}.`,
      nextAction: corroborators.size > 1
        ? 'No action required. Re-check if the company announces a leadership change.'
        : 'Confirmed by a single authoritative source. A second independent source would strengthen it before outreach.',
    };
  }

  // ── Candidate: something plausible, not assertable ────────────────
  if (candidates.length > 0) {
    const best = [...candidates].sort((a, b) => b.matchScore - a.matchScore || b.confidence - a.confidence)[0];
    return {
      status: 'probable-founder-candidate',
      resolvedPersonKey: null,
      resolvedName: null,
      resolvedTitle: null,
      summary: `${candidates.length} probable candidate${candidates.length === 1 ? '' : 's'} found; none is confirmed. `
        + `The strongest is ${best.fullName}${best.title ? ` (${best.title})` : ''}, from `
        + `${SOURCE_FAMILY_SPECS[best.sourceFamily].label}. This is a candidate, not a verified founder — `
        + `${isAuthoritativeFamily(best.sourceFamily) ? 'the source is authoritative but states no title, or the match evidence is below the confirmation bar' : 'the source is not one that can confirm a founder on its own'}.`,
      nextAction: 'Review the candidate evidence and confirm or reject. Do not use an unconfirmed candidate for outreach.',
    };
  }

  // ── No candidates ─────────────────────────────────────────────────
  if (unanswered.length > 0) {
    return {
      status: 'manual-review-required',
      resolvedPersonKey: null,
      resolvedName: null,
      resolvedTitle: null,
      summary: `Founder research on ${longDate(atIso)} reached ${answered.length} of ${attempts.length} source families `
        + `for ${companyName} and found no attributable founder. `
        + `${unanswered.length} source${unanswered.length === 1 ? '' : 's'} did not respond `
        + `(${unanswered.map((u) => SOURCE_FAMILY_SPECS[u.family].label).join(', ')}), so the research is incomplete rather than exhausted.`,
      nextAction: `Re-run enrichment for this company to retry the ${unanswered.length} unreachable source`
        + `${unanswered.length === 1 ? '' : 's'}. If it keeps failing, check the source manually.`,
    };
  }

  return {
    status: 'research-exhausted',
    resolvedPersonKey: null,
    resolvedName: null,
    resolvedTitle: null,
    summary: `Founder research completed ${longDate(atIso)}. No attributable founder was confirmed across `
      + `${attemptedLabels.join(', ')}. Manual review queued.`,
    nextAction: 'Every applicable public source family has been searched and none names a founder. '
      + 'Resolve manually from a source outside this pipeline, or record the company as having no public founder attribution.',
  };
}

// ── Vertical + stage inputs ───────────────────────────────────────

/** Everything readable about a company, for classification. */
function classificationText(c: RawCompany, siteText: string | null): string {
  return [
    c.name, c.oneLiner, c.subcategory,
    ...c.evidence.map((e) => e.claim),
    ...c.dealEvidence.map((d) => d.summary),
    siteText ?? '',
  ].join(' \n ');
}

function buildStageEvidence(c: RawCompany): StageEvidenceItem[] {
  const items: StageEvidenceItem[] = [];
  for (const d of c.dealEvidence) {
    const family: SourceFamily =
      d.sourceId === 'investor-news' ? 'investor-portfolio'
        : d.sourceId === 'funding-news' ? 'funding-press'
          : d.sourceId === 'yc' ? 'accelerator'
            : d.sourceId === 'websites' ? 'company-site'
              : 'sec-form-d';
    items.push({
      sourceFamily: family,
      url: d.url,
      date: d.publishedAt,
      // A Form D's text can contain the word "seed" without naming a
      // round; readStatedStage is applied to every family, and
      // isExplicitStageClaim then refuses to let the SEC family name one.
      statedStage: readStatedStage(d.summary),
      supportingText: truncateSupport(d.summary),
    });
  }
  for (const e of c.evidence) {
    const family: SourceFamily = /sec\.gov/i.test(e.url) ? 'sec-form-d'
      : /ycombinator/i.test(e.url) ? 'accelerator'
        : isOnCompanyDomain(e.url, c.website) ? 'company-site'
          : 'funding-press';
    items.push({
      sourceFamily: family,
      url: e.url,
      date: e.date || null,
      statedStage: readStatedStage(e.claim),
      supportingText: truncateSupport(e.claim),
    });
  }
  return items;
}

// ── The pipeline ──────────────────────────────────────────────────

export async function runEnrichment(opts: EnrichmentOptions): Promise<EnrichmentRunResult> {
  const runId = `enr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const mode = opts.apply ? 'apply' : 'dry-run';
  const budget = new RequestBudget(opts.maxRequests ?? 600);
  const totals: EnrichmentRunTotals = { ...EMPTY_TOTALS };
  const errorCounts = new Map<string, { detail: string; count: number }>();
  const results: CompanyEnrichmentResult[] = [];

  const companies = loadCompanies(opts);
  const scope = opts.companyIds?.length
    ? `${opts.companyIds.length} company id(s)`
    : opts.resume ? 'resume: companies with no prior research attempt' : 'all active companies';

  if (opts.apply) startEnrichmentRun({ id: runId, mode, scope, initiatedBy: opts.initiatedBy });

  const enrichOne = async (c: RawCompany): Promise<CompanyEnrichmentResult> => {
    totals.companiesAttempted += 1;
    const at = now();
    const plans = buildResearchPlan(c);
    const attempts: { family: SourceFamily; outcome: ResearchOutcome; detail: string; url: string | null; found: number }[] = [];
    const candidates: FoundCandidate[] = [];
    const facts: ResearchedFacts = {};
    let siteText: string | null = null;

    for (const plan of plans) {
      const r = await researchFamily(c, plan, budget);
      attempts.push({ family: plan.family, outcome: r.outcome, detail: r.detail, url: r.url, found: r.candidates.length });
      candidates.push(...r.candidates);
      // First source to state a fact wins; families run in confirming
      // order, so this prefers the filing over the press write-up.
      for (const [k, v] of Object.entries(r.facts)) {
        if (v && !(k in facts)) (facts as Record<string, string>)[k] = v;
      }
      if (r.outcome === 'source-unreachable' || r.outcome === 'source-blocked') {
        const key = `${plan.family}:${r.detail.slice(0, 80)}`;
        const prev = errorCounts.get(key);
        errorCounts.set(key, { detail: `${SOURCE_FAMILY_SPECS[plan.family].label}: ${r.detail}`, count: (prev?.count ?? 0) + 1 });
      }
      // Keep the company's own page TEXT for classification — it is the
      // only source that counts as the company describing ITSELF.
      if (plan.family === 'company-site' && r.pageText.length > 0) siteText = r.pageText;
    }

    const verdict = deriveFounderStatus(c.name, candidates, attempts, at);

    // ── Vertical ────────────────────────────────────────────────────
    const qual = getQualification(c.id);
    /**
     * "Identity resolved" is deliberately strict: a quarantined record,
     * or one whose qualification says the entity is not a company, must
     * not be given a sector. Forcing those into a bucket is exactly what
     * produced sector rankings full of SPVs and subsidiaries.
     */
    const identityResolved = !c.quarantined
      && qual !== null
      && qual.result !== 'not-a-company-name'
      && qual.result !== 'insufficient-evidence';
    const identityGap = c.quarantined
      ? 'The record is quarantined, so it is not treated as an operating company for classification.'
      : qual === null
        ? 'This company has not been through issuer qualification, so it is not established as an operating company.'
        : `Issuer qualification returned "${qual.result}", which does not establish an operating company.`;

    /**
     * Did the company describe ITSELF, in text we actually read?
     *
     * Either the qualification pass already judged its site substantive,
     * or this run read real prose from its own domain. Both are the
     * company speaking; a headline written by a reporter is not, and the
     * two must not produce the same `basis`.
     */
    const selfDescribed = qual?.operatingEvidence?.level === 'substantive'
      || (siteText !== null && siteText.length >= 500);
    const vertical: VerticalClassification = {
      companyId: c.id,
      ...classifyCompany({
        text: classificationText(c, siteText),
        identityResolved,
        identityGap,
        sourceUrl: c.website ?? null,
        selfDescribed,
        // The accelerator's own categorisation of its own portfolio
        // company — structured evidence, cited to the directory entry.
        directoryCategories: c.subcategory,
        directorySourceUrl: c.dealEvidence.find((d) => d.sourceId === 'yc')?.url
          ?? c.evidence.find((e) => /ycombinator/i.test(e.url))?.url
          ?? null,
        directorySourceLabel: 'Accelerator directory',
      }),
      classifiedAt: at,
      version: ENRICHMENT_VERSION,
    };

    // ── Stage ───────────────────────────────────────────────────────
    const stageEvidence = buildStageEvidence(c);
    const financingFamilies = new Set(stageEvidence
      .filter((s) => s.sourceFamily !== 'company-site')
      .map((s) => s.sourceFamily));
    const stageOutcome = resolveStage(stageEvidence, {
      companyAgeYears: c.foundedYear ? Math.max(0, new Date().getUTCFullYear() - c.foundedYear) : null,
      teamSize: c.teamSize,
      accelerator: c.accelerator,
      hasShippingProduct: selfDescribed,
      hasFinancingEvidence: financingFamilies.size > 0,
      onlyFinancingIsFormD: financingFamilies.size === 1 && financingFamilies.has('sec-form-d'),
      hasGrantFunding: c.evidence.some((e) => /sbir|sttr|nsf award|grant/i.test(e.claim)),
    });
    const stage: StageResolution = {
      companyId: c.id, ...stageOutcome, lastCheckedAt: at, version: ENRICHMENT_VERSION,
    };

    /**
     * Facts the records already carry, filled in only where the company
     * row has nothing. Deal evidence states an amount and a publication
     * date; the YC directory states a batch.
     */
    if (!facts.amountText) {
      const withAmount = c.dealEvidence.find((d) => /\$[\d.]+\s*[MBK]/i.test(d.summary));
      const m = withAmount?.summary.match(/\$[\d.]+\s*[MBK]/i);
      if (m) facts.amountText = m[0];
    }
    if (!facts.fundingDate) {
      const dated = c.dealEvidence.filter((d) => d.publishedAt).sort((a, b) =>
        (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
      if (dated[0]?.publishedAt) facts.fundingDate = dated[0].publishedAt;
    }
    /**
     * Location and description from text already fetched — the company's
     * own site first, then the funding coverage on file. Only consulted
     * where the SEC filing did not already state it.
     */
    if (!facts.city || !facts.state) {
      const haystacks = [siteText ?? '', ...c.dealEvidence.map((d) => d.summary), c.oneLiner];
      for (const h of haystacks) {
        const loc = extractLocation(h);
        if (loc) {
          facts.city ??= loc.city;
          facts.state ??= loc.state;
          facts.locationEvidence = loc.evidence;
          break;
        }
      }
    }
    if (siteText && /unknown/i.test(c.oneLiner)) {
      const desc = extractDescription(siteText, c.name);
      if (desc) facts.description = desc;
    }
    if (!facts.accelerator) {
      const yc = c.dealEvidence.find((d) => d.sourceId === 'yc' && /batch\s+([A-Z]\d{2})/i.test(d.summary));
      const batch = yc?.summary.match(/batch\s+([A-Z]\d{2})/i);
      if (batch) facts.accelerator = `Y Combinator (${batch[1].toUpperCase()})`;
    }

    // ── Totals ──────────────────────────────────────────────────────
    if (verdict.status === 'verified-founder') totals.foundersVerified += 1;
    else if (verdict.status === 'probable-founder-candidate') totals.foundersCandidate += 1;
    else if (verdict.status === 'conflicting-founder-evidence') totals.foundersConflicting += 1;
    else if (verdict.status === 'research-exhausted') totals.foundersExhausted += 1;
    else totals.foundersManualReview += 1;

    if (isClassified(vertical.primarySector)) totals.verticalsClassified += 1;
    else totals.verticalsUnclassifiable += 1;

    if (stage.stage === 'stage-conflict-manual-review') totals.stagesConflicting += 1;
    else if (stage.basis === 'explicit') totals.stagesNamed += 1;
    else totals.stagesBounded += 1;

    // ── Write (apply only) ──────────────────────────────────────────
    const changes: CompanyEnrichmentResult['changes'] = [];
    if (opts.apply) {
      const db = getDb();
      const prevVertical = db.prepare('SELECT primary_sector FROM company_vertical_classification WHERE company_id = ?')
        .get(c.id) as { primary_sector: string } | undefined;
      const prevStage = db.prepare('SELECT stage FROM company_stage_resolution WHERE company_id = ?')
        .get(c.id) as { stage: string } | undefined;
      const prevFounder = db.prepare('SELECT status FROM company_founder_resolution WHERE company_id = ?')
        .get(c.id) as { status: string } | undefined;

      for (const cand of candidates) {
        upsertFounderCandidate({
          companyId: c.id,
          personKey: cand.personKey,
          fullName: cand.fullName,
          title: cand.title,
          sourceUrl: cand.sourceUrl,
          sourceFamily: cand.sourceFamily,
          sourceType: cand.sourceType,
          publishedAt: cand.publishedAt,
          supportingText: cand.supportingText,
          matchSignals: cand.matchSignals,
          matchScore: cand.matchScore,
          confidence: cand.confidence,
          status: verdict.resolvedPersonKey === cand.personKey ? 'verified-founder' : verdict.status,
        });
        // Evidence-backed edges: person ↔ company, and company ↔ domain.
        upsertRelationship({
          fromType: 'person', fromId: cand.personKey,
          toType: 'company', toId: c.id,
          relation: cand.title ? `stated-${singularRoleOf(cand.title) ?? 'founder-or-officer'}` : 'named-in-source',
          sourceFamily: cand.sourceFamily,
          evidenceUrl: cand.sourceUrl,
          detail: cand.supportingText,
          confidence: cand.confidence,
        });
      }
      if (c.website) {
        upsertRelationship({
          fromType: 'company', fromId: c.id,
          toType: 'domain', toId: c.website.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0],
          relation: 'operates-domain',
          sourceFamily: 'company-site',
          evidenceUrl: c.website,
          detail: 'Website recorded on the company row.',
          confidence: qual?.websiteVerified ? 0.9 : 0.4,
        });
      }
      for (const a of attempts) {
        recordResearchAttempt({
          companyId: c.id, runId, sourceFamily: a.family, url: a.url,
          outcome: a.outcome, detail: a.detail, candidatesFound: a.found,
        });
      }
      saveFounderResolution({
        companyId: c.id,
        status: verdict.status,
        resolvedPersonKey: verdict.resolvedPersonKey,
        resolvedName: verdict.resolvedName,
        resolvedTitle: verdict.resolvedTitle,
        summary: verdict.summary,
        nextAction: verdict.nextAction,
        sourcesAttempted: attempts.map((a) => a.family),
        researchedAt: at,
        version: ENRICHMENT_VERSION,
      });
      saveVerticalClassification(vertical);
      saveStageResolution(stage);

      /**
       * Write the researched facts onto the company row.
       *
       * The scoring model reads the ROW, not these tables, so without
       * this step the research was being done and then ignored: 195
       * companies had a resolved stage and still scored as 'Unknown'
       * with the 15-point stage component excluded, and the dashboard
       * showed N/A for a location the SEC filing had stated all along.
       *
       * applyFieldUpdate enforces provenance, so `extracted` never
       * overwrites a `verified` or `user-entered` value — a reviewer's
       * correction and a human-confirmed website both survive this.
       */
      const stamp = (field: Parameters<typeof applyFieldUpdate>[1], value: string, source: string) => {
        const res = applyFieldUpdate(c.id, field, value, 'extracted', source);
        if (res.applied) changes.push({ field: String(field), previous: null, next: value });
      };

      // Stage, as the label the row and the score both understand.
      if (stage.stage !== 'stage-conflict-manual-review') {
        stamp('stage', STAGE_LABELS[stage.stage], stage.evidenceUrl ?? `enrichment:${ENRICHMENT_VERSION}`);
      }
      /**
       * The subvertical fills the subcategory ONLY where the stored one
       * is a placeholder.
       *
       * A value already matching the Vamos taxonomy is the stronger
       * statement and scores higher, so overwriting it with a
       * free-text subvertical would trade a taxonomy match for a
       * near-miss — which is exactly what happened on the first run and
       * took thesis fit from 47% assessable to 0%.
       */
      if (vertical.subvertical && /unclassified|unknown/i.test(c.subcategory)) {
        stamp('subcategory', vertical.subvertical, vertical.sourceUrl ?? `enrichment:${ENRICHMENT_VERSION}`);
      }
      const secUrl = attempts.find((a) => a.family === 'sec-form-d')?.url ?? 'SEC Form D';
      // Cite the phrase a location was read from when it came from prose,
      // and the filing when it came from the filing.
      const locSource = facts.locationEvidence ? `"${facts.locationEvidence}"` : secUrl;
      if (facts.city && (!c.city || c.city === 'Unknown')) stamp('city', facts.city, locSource);
      if (facts.state && (!c.state || c.state === '??' || c.state === 'Unknown')) stamp('state', facts.state, locSource);
      if (facts.amountText) stamp('raising', facts.amountText, secUrl);
      if (facts.fundingDate) stamp('lastFundingDate', facts.fundingDate, secUrl);
      if (facts.accelerator && !c.accelerator) stamp('accelerator', facts.accelerator, 'Y Combinator public directory');
      if (facts.description) {
        stamp('oneLiner', facts.description, c.website ?? `enrichment:${ENRICHMENT_VERSION}`);
      }

      /**
       * A verified founder replaces the "Unknown founder" placeholder on
       * the founders table, so the score, the HubSpot contact builder,
       * and the outreach drafter can all see them. Only verified — a
       * candidate is never written anywhere that treats it as fact.
       */
      if (verdict.status === 'verified-founder' && verdict.resolvedName) {
        const replaced = setResolvedFounder(c.id, {
          name: verdict.resolvedName,
          role: verdict.resolvedTitle ?? '',
          background: verdict.summary,
        });
        if (replaced) {
          changes.push({ field: 'founder-row', previous: 'Unknown founder', next: verdict.resolvedName });
        }
      }

      if (prevFounder?.status !== verdict.status) {
        changes.push({ field: 'founder-status', previous: prevFounder?.status ?? null, next: verdict.status });
      }
      if (prevVertical?.primary_sector !== vertical.primarySector) {
        changes.push({ field: 'vertical', previous: prevVertical?.primary_sector ?? null, next: vertical.primarySector });
      }
      if (prevStage?.stage !== stage.stage) {
        changes.push({ field: 'stage', previous: prevStage?.stage ?? null, next: stage.stage });
      }
    }

    opts.onProgress?.(
      `${c.name} — founder: ${verdict.status}; vertical: ${vertical.primarySector}; stage: ${stage.stage}`,
    );

    return {
      companyId: c.id,
      companyName: c.name,
      founderStatus: verdict.status,
      founderSummary: verdict.summary,
      founderNextAction: verdict.nextAction,
      candidatesFound: candidates.length,
      sourcesAttempted: attempts.map((a) => a.family),
      attempts: attempts.map((a) => ({ family: a.family, outcome: a.outcome, detail: a.detail })),
      vertical,
      stage,
      changes,
    };
  };

  /**
   * Bounded worker pool over the company list.
   *
   * Results are written back by INDEX rather than pushed, so the report
   * order matches the input order regardless of which company finishes
   * first — a summary whose row order changes between runs is needlessly
   * hard to diff.
   *
   * A company that throws is recorded and skipped rather than aborting
   * the run. One unparseable page must not cost 208 other companies
   * their research.
   */
  const ordered: (CompanyEnrichmentResult | null)[] = new Array(companies.length).fill(null);
  const workers = Math.max(1, Math.min(opts.concurrency ?? 8, companies.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= companies.length) return;
      try {
        ordered[i] = await enrichOne(companies[i]);
      } catch (e) {
        const detail = `${companies[i].name}: ${(e as Error).message}`;
        const prev = errorCounts.get(`company:${detail}`);
        errorCounts.set(`company:${detail}`, { detail: `Company error — ${detail}`, count: (prev?.count ?? 0) + 1 });
      }
    }
  }));
  results.push(...ordered.filter((r): r is CompanyEnrichmentResult => r !== null));

  const sourceErrors = [...errorCounts.values()].map((e) => ({
    sourceFamily: e.detail.split(':')[0], detail: e.detail, count: e.count,
  }));
  const status = sourceErrors.length > 0 ? 'Completed with warnings' : 'Completed';

  if (opts.apply) {
    completeEnrichmentRun(runId, totals, sourceErrors, status);
    audit({
      provider: 'system', mode: 'local', action: 'enrichment-run', subject: runId, outcome: 'ok',
      detail: `${mode}; ${totals.companiesAttempted} companies; `
        + `founders verified ${totals.foundersVerified}, candidates ${totals.foundersCandidate}, `
        + `conflicting ${totals.foundersConflicting}, exhausted ${totals.foundersExhausted}, `
        + `manual review ${totals.foundersManualReview}; ${sourceErrors.length} source error group(s).`,
    });
  }

  return {
    runId, mode, companies: results, totals, sourceErrors,
    requestsSpent: budget.spent, status,
  };
}

export { NON_SECTOR_STATUS, today };
