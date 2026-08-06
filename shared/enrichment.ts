import { z } from 'zod';
import { VERTICAL_ID_VALUES } from './discovery';

/**
 * Founder, vertical, and stage enrichment contracts.
 *
 * WHY THIS EXISTS
 *
 * The dashboard was showing four different kinds of nothing as if they
 * were one kind:
 *
 *   "Identity not on record — requires human verification, never inferred"
 *   "Unknown founder"
 *   "Unknown" vertical
 *   "Unknown" stage
 *
 * Each of those is a true statement and a useless one. They collapse
 * "we researched this thoroughly and the fact is genuinely not public",
 * "we have a strong candidate we are not willing to assert", "two
 * sources disagree", and "nobody has looked yet" into a single grey
 * word. A reviewer reading `Unknown` cannot tell which of those they are
 * looking at, and therefore cannot tell whether opening the record is
 * worth their next ten minutes.
 *
 * The fix is NOT to fill the fields in. Fabricating a founder, a
 * financing event, a demographic identity, or a sector to make a column
 * look complete would be far worse than the placeholder — it would be a
 * false statement about a real company and a real person. The fix is to
 * make the ABSENCE specific: what was searched, when, what was found,
 * what is missing, and what a human should do next.
 *
 * So every enriched field carries a RESOLUTION STATE rather than a value
 * or a null, and the six states are not interchangeable.
 */

// ── The six resolution states ─────────────────────────────────────

/**
 * What kind of answer a field holds. The API returns this alongside
 * every enriched value, and the UI renders each state differently,
 * because representing all six as `null` (or all six as `unknown`) is
 * exactly the failure this module exists to correct.
 *
 *   confirmed          An attributable source states the fact directly.
 *   bounded-inference  Not stated anywhere, but the recorded evidence
 *                      constrains it to a labelled range. Always shown
 *                      as inferred; never presented as a fact.
 *   candidate          We found something plausible and are NOT willing
 *                      to assert it. Displayed as a candidate, with the
 *                      evidence, never as the answer.
 *   conflict           Two or more sources disagree. Shown as a
 *                      disagreement rather than silently picking one.
 *   research-exhausted Every applicable source family was attempted and
 *                      the fact is not publicly available. This is a
 *                      RESULT, not a failure.
 *   manual-review      A human has to look. Carries a next action.
 */
export const RESOLUTION_STATES = [
  'confirmed', 'bounded-inference', 'candidate', 'conflict', 'research-exhausted', 'manual-review',
] as const;
export type ResolutionState = (typeof RESOLUTION_STATES)[number];

export const RESOLUTION_STATE_LABELS: Record<ResolutionState, string> = {
  confirmed: 'Confirmed',
  'bounded-inference': 'Inferred',
  candidate: 'Candidate — unconfirmed',
  conflict: 'Sources conflict',
  'research-exhausted': 'Research completed — not public',
  'manual-review': 'Manual review required',
};

/** True when the value may be presented as a fact. Everything else needs a qualifier on screen. */
export function isAssertable(s: ResolutionState): boolean {
  return s === 'confirmed';
}

/** True when the state must be visibly labelled as inference rather than fact. */
export function isInferred(s: ResolutionState): boolean {
  return s === 'bounded-inference';
}

// ── Source families, in the order they are researched ─────────────

/**
 * The research plan, as data.
 *
 * Ordered deliberately: the sources that can CONFIRM a founder come
 * first, and the ones that can only suggest one come last. A company's
 * own leadership page and an SEC related-person record are attributable
 * to the company itself; a conference bio is not.
 *
 * `authoritative` marks the families whose statements can, on their own,
 * support `verified-founder`. The rest can only ever produce a
 * candidate, no matter how many of them agree — three blog posts
 * repeating one another is one source, and treating agreement between
 * downstream copies as corroboration is how a wrong name becomes
 * "verified".
 */
export const SOURCE_FAMILIES = [
  'company-site',
  'sec-form-d',
  'accelerator',
  'investor-portfolio',
  'founder-announcement',
  'funding-press',
  'public-profile',
  'professional-profile',
  'corporate-registry',
] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export interface SourceFamilySpec {
  id: SourceFamily;
  label: string;
  /** What this family is asked for, in one line, for the "sources attempted" display. */
  description: string;
  /** May a statement from this family alone establish `verified-founder`? */
  authoritative: boolean;
}

export const SOURCE_FAMILY_SPECS: Record<SourceFamily, SourceFamilySpec> = {
  'company-site': {
    id: 'company-site',
    label: 'Company website',
    description: 'About, Team, Leadership, Contact, press, legal, and footer pages on the company’s own domain.',
    authoritative: true,
  },
  'sec-form-d': {
    id: 'sec-form-d',
    label: 'SEC Form D',
    description: 'Related-person records and the filing’s primary document.',
    authoritative: true,
  },
  accelerator: {
    id: 'accelerator',
    label: 'Accelerator / incubator profile',
    description: 'Official accelerator and incubator directory profiles, including Y Combinator.',
    authoritative: true,
  },
  'investor-portfolio': {
    id: 'investor-portfolio',
    label: 'Investor portfolio / announcement',
    description: 'Portfolio pages and official investment announcements from investors in the round.',
    authoritative: true,
  },
  'founder-announcement': {
    id: 'founder-announcement',
    label: 'Founder-authored announcement',
    description: 'Founder-authored posts and verified company social profiles.',
    authoritative: false,
  },
  'funding-press': {
    id: 'funding-press',
    label: 'Funding press',
    description: 'Reputable funding announcements and business publications.',
    authoritative: false,
  },
  'public-profile': {
    id: 'public-profile',
    label: 'Public speaker / award profile',
    description: 'Conference, demo-day, university, podcast, and award profiles.',
    authoritative: false,
  },
  'professional-profile': {
    id: 'professional-profile',
    label: 'Public professional profile',
    description: 'Public professional profiles reachable without an account or a login wall.',
    authoritative: false,
  },
  'corporate-registry': {
    id: 'corporate-registry',
    label: 'Corporate registry',
    description: 'Public corporate registries where legally and technically accessible.',
    authoritative: false,
  },
};

/** Families that may, on their own, support a verified founder assertion. */
export function isAuthoritativeFamily(f: SourceFamily): boolean {
  return SOURCE_FAMILY_SPECS[f].authoritative;
}

// ── Founder resolution ────────────────────────────────────────────

export const FOUNDER_RESOLUTION_STATUSES = [
  'verified-founder',
  'probable-founder-candidate',
  'conflicting-founder-evidence',
  'research-exhausted',
  'manual-review-required',
] as const;
export type FounderResolutionStatus = (typeof FOUNDER_RESOLUTION_STATUSES)[number];

export const FOUNDER_STATUS_LABELS: Record<FounderResolutionStatus, string> = {
  'verified-founder': 'Verified founder',
  'probable-founder-candidate': 'Probable candidate — unconfirmed',
  'conflicting-founder-evidence': 'Conflicting evidence',
  'research-exhausted': 'Research completed — no attributable founder',
  'manual-review-required': 'Manual review required',
};

/** A probable candidate must never render as a verified founder. */
export function isVerifiedFounder(s: FounderResolutionStatus): boolean {
  return s === 'verified-founder';
}

export const FOUNDER_STATUS_TO_RESOLUTION: Record<FounderResolutionStatus, ResolutionState> = {
  'verified-founder': 'confirmed',
  'probable-founder-candidate': 'candidate',
  'conflicting-founder-evidence': 'conflict',
  'research-exhausted': 'research-exhausted',
  'manual-review-required': 'manual-review',
};

/**
 * Why we believe a PERSON belongs to a COMPANY.
 *
 * A shared name is not a match and can never be one. "David Chen is a
 * founder" plus "this company's page mentions David Chen" is two facts
 * about a common name, not one fact about a person, and matching on it
 * would attach a stranger's identity to a real company — a mistake that
 * is both wrong and, since it names a private individual, harmful.
 *
 * So a match needs a signal from this list that TIES the person to the
 * company: the statement is on the company's own domain, the person is a
 * related person on the company's own filing, the accelerator's own
 * profile for this company names them, and so on. `name-only` exists in
 * this list precisely so it can be scored at zero and rejected by name,
 * rather than being absent and rejected by accident.
 */
export const MATCH_SIGNALS = [
  'statement-on-company-domain',
  'sec-related-person',
  'accelerator-profile-for-company',
  'investor-announcement-names-company',
  'title-stated-in-source',
  'company-name-in-source-text',
  'geography-agrees',
  'domain-in-source',
  'name-only',
] as const;
export type MatchSignal = (typeof MATCH_SIGNALS)[number];

/**
 * Points per signal. The threshold below is what a match must clear;
 * `name-only` scores zero on purpose so that a name agreement can never
 * accumulate into a match by itself.
 */
export const MATCH_SIGNAL_WEIGHTS: Record<MatchSignal, number> = {
  'statement-on-company-domain': 5,
  'sec-related-person': 5,
  'accelerator-profile-for-company': 4,
  'investor-announcement-names-company': 3,
  'title-stated-in-source': 2,
  'company-name-in-source-text': 2,
  'geography-agrees': 1,
  'domain-in-source': 1,
  'name-only': 0,
};

/** Minimum score before a person may be attached to a company at all. */
export const MIN_MATCH_SCORE = 5;

export const MATCH_SIGNAL_TEXT: Record<MatchSignal, string> = {
  'statement-on-company-domain': 'The statement appears on the company’s own domain.',
  'sec-related-person': 'The person is a related person on this company’s own SEC filing.',
  'accelerator-profile-for-company': 'The accelerator’s official profile for this company names the person.',
  'investor-announcement-names-company': 'An investor’s announcement names both the person and this company.',
  'title-stated-in-source': 'The source states the person’s title at the company.',
  'company-name-in-source-text': 'The company name appears in the same source text as the person.',
  'geography-agrees': 'The source’s stated location agrees with the company’s recorded location.',
  'domain-in-source': 'The company’s domain appears in the source.',
  'name-only': 'Only the person’s name agrees. This is not corroboration and scores nothing on its own.',
};

/** Score a candidate match from its signals. */
export function scoreMatch(signals: MatchSignal[]): number {
  return [...new Set(signals)].reduce((sum, s) => sum + MATCH_SIGNAL_WEIGHTS[s], 0);
}

/**
 * Does this evidence tie the person to the company well enough to record
 * the pair at all? Below the threshold nothing is stored against the
 * company — an unattached person is not a weak fact, it is a different
 * person.
 */
export function meetsMatchThreshold(signals: MatchSignal[]): boolean {
  return scoreMatch(signals) >= MIN_MATCH_SCORE;
}

export const founderCandidateSchema = z.object({
  id: z.number().int(),
  companyId: z.string(),
  /** Stable key for the same human across sources — see personKey(). */
  personKey: z.string(),
  fullName: z.string().min(2),
  /** Current title as STATED by the source. Never inferred. */
  title: z.string().nullable(),
  sourceUrl: z.string(),
  sourceFamily: z.enum(SOURCE_FAMILIES),
  /** The source's own label, e.g. 'Company leadership page', 'SEC Form D'. */
  sourceType: z.string(),
  /** When the source published or filed it. Null when the source states no date. */
  publishedAt: z.string().nullable(),
  /** When WE fetched it. */
  retrievedAt: z.string(),
  /** The supporting text or structured field, verbatim and truncated. Always treated as untrusted plain text. */
  supportingText: z.string(),
  matchSignals: z.array(z.enum(MATCH_SIGNALS)),
  matchScore: z.number(),
  confidence: z.number().min(0).max(1),
  status: z.enum(FOUNDER_RESOLUTION_STATUSES),
  firstSeenAt: z.string(),
  lastCheckedAt: z.string(),
  /** Reviewer decision, when one has been made. Never overwrites the automated evidence above. */
  reviewDecision: z.enum(['confirmed', 'rejected']).nullable().default(null),
  reviewedBy: z.string().nullable().default(null),
  reviewedAt: z.string().nullable().default(null),
  reviewReason: z.string().nullable().default(null),
});
export type FounderCandidate = z.infer<typeof founderCandidateSchema>;

/**
 * Stable identity key for a person across sources.
 *
 * Deliberately conservative: case and punctuation are folded, but
 * nothing else. Nicknames are NOT expanded and middle names are NOT
 * dropped, because "Rob Smith" and "Robert Smith" may or may not be one
 * person and this function has no way to tell. Two keys that should
 * merge but do not produce a visible duplicate a reviewer can resolve;
 * two keys that merge but should not silently fuse two people's
 * identities, which nothing downstream can undo.
 */
export function personKey(fullName: string): string {
  return fullName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Outcome of one attempt against one source family, for one company. */
export const RESEARCH_OUTCOMES = [
  'found-candidate',
  'reached-no-founder-stated',
  'source-not-applicable',
  'source-unreadable',
  'source-unreachable',
  'source-blocked',
  'no-source-url-known',
] as const;
export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

export const RESEARCH_OUTCOME_TEXT: Record<ResearchOutcome, string> = {
  'found-candidate': 'Reached the source and found at least one attributable person.',
  'reached-no-founder-stated': 'Reached the source; it names no founder or officer.',
  'source-not-applicable': 'This family does not apply to this company (for example, no accelerator on record).',
  'source-unreadable': 'The source responded but served almost no readable text — typically a page rendered in the '
    + 'browser, which this checker does not execute. That is a limit of the check, not a finding about the company.',
  'source-unreachable': 'The source did not respond, timed out, or returned an error.',
  'source-blocked': 'The source refused access. No attempt was made to bypass it.',
  'no-source-url-known': 'No URL is on record for this family, so there was nothing to fetch.',
};

/**
 * Outcomes that mean the source ANSWERED. Only these count toward
 * "research exhausted" — a company whose website timed out has not been
 * researched, it has been attempted, and calling that exhausted would
 * dress a network failure up as a finding about the company.
 *
 * `source-unreadable` is deliberately NOT an answer, for the same reason
 * `thin` is not operating evidence in shared/qualification.ts. The Y
 * Combinator directory serves 39 characters of shell and renders its
 * content in the browser; counting that as "we looked and the profile
 * names nobody" would put a false statement about a real page into the
 * exhaustion claim.
 */
export function outcomeAnswered(o: ResearchOutcome): boolean {
  return o === 'found-candidate' || o === 'reached-no-founder-stated' || o === 'source-not-applicable';
}

/** Outcomes where the check could not settle the question and a retry or a human might. */
export function outcomeInconclusive(o: ResearchOutcome): boolean {
  return o === 'source-unreadable' || o === 'source-unreachable' || o === 'source-blocked';
}

export const researchAttemptSchema = z.object({
  companyId: z.string(),
  sourceFamily: z.enum(SOURCE_FAMILIES),
  url: z.string().nullable(),
  attemptedAt: z.string(),
  outcome: z.enum(RESEARCH_OUTCOMES),
  detail: z.string(),
  candidatesFound: z.number().int().min(0),
});
export type ResearchAttempt = z.infer<typeof researchAttemptSchema>;

export const founderResolutionSchema = z.object({
  companyId: z.string(),
  status: z.enum(FOUNDER_RESOLUTION_STATUSES),
  /** The asserted person, when and only when status is verified-founder. */
  resolvedPersonKey: z.string().nullable(),
  resolvedName: z.string().nullable(),
  resolvedTitle: z.string().nullable(),
  /**
   * The sentence shown where the canned placeholder used to be. Written
   * from the attempt record, so it names real dates and real families.
   */
  summary: z.string(),
  /** What a human should do next. Never empty. */
  nextAction: z.string(),
  sourcesAttempted: z.array(z.enum(SOURCE_FAMILIES)),
  researchedAt: z.string(),
  version: z.string(),
});
export type FounderResolution = z.infer<typeof founderResolutionSchema>;

// ── Vertical classification ───────────────────────────────────────

/**
 * The five Vamos sectors, as the enrichment layer names them. These map
 * directly onto `VerticalId` (src/types.ts) — this table is the display
 * contract, that one is the storage contract, and both list the same
 * five ids so they can never drift.
 *
 * `aoi` is deliberately absent: it is the legacy catch-all, and a
 * catch-all is exactly what a classification with a stated reason is
 * supposed to replace. Robotics and Space Tech are combined into
 * `frontier`; General AI is retired as a sector of its own (AI is a
 * technology, not a market) — see src/data/taxonomy.ts's header comment.
 */
export const PRIMARY_SECTORS = [
  'health', 'fintech', 'fow', 'sustainability', 'frontier',
] as const;
export type PrimarySector = (typeof PRIMARY_SECTORS)[number];

export const SECTOR_LABELS: Record<PrimarySector, string> = {
  health: 'Health & Wellness',
  fintech: 'FinTech',
  fow: 'Future of Work',
  sustainability: 'Sustainability',
  frontier: 'Frontier',
};

/**
 * The explicit non-sector status.
 *
 * A record whose company identity is unresolved does not get forced into
 * a sector so the column looks full. It gets this, it is excluded from
 * sector rankings, and it carries the exact evidence gap. The literal
 * string `unknown` is never stored or displayed.
 */
export const NON_SECTOR_STATUS = 'not-classifiable-company-identity-unresolved' as const;
export type NonSectorStatus = typeof NON_SECTOR_STATUS;

export const NON_SECTOR_LABEL = 'Not classifiable — company identity unresolved';

export type SectorAssignment = PrimarySector | NonSectorStatus;

export function isClassified(s: SectorAssignment): s is PrimarySector {
  return s !== NON_SECTOR_STATUS;
}

/** Companies with this assignment are excluded from every sector ranking and shortlist. */
export function countsTowardSectorRanking(s: SectorAssignment): boolean {
  return isClassified(s);
}

export const verticalClassificationSchema = z.object({
  companyId: z.string(),
  primarySector: z.union([z.enum(PRIMARY_SECTORS), z.literal(NON_SECTOR_STATUS)]),
  secondarySector: z.enum(PRIMARY_SECTORS).nullable().default(null),
  /** Specific subvertical, e.g. 'claims automation for TPAs'. Null only when unclassified. */
  subvertical: z.string().nullable(),
  /** One sentence, grounded in what the product does and who pays for it. */
  reason: z.string(),
  sourceUrl: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  /** Explicit = the source says what the company does. Inferred = we bounded it from evidence. */
  basis: z.enum(['explicit', 'inferred']),
  /** Populated only when primarySector is the non-sector status. */
  evidenceGap: z.string().nullable().default(null),
  classifiedAt: z.string(),
  version: z.string(),
});
export type VerticalClassification = z.infer<typeof verticalClassificationSchema>;

// ── Stage resolution ──────────────────────────────────────────────

/**
 * Permitted stage results.
 *
 * `early-stage-round-not-disclosed` is the load-bearing one. An SEC Form
 * D proves a securities offering was reported — it does not name a
 * venture stage, and translating every Form D into "Seed" would invent a
 * financing event that no source states. When only company age, offering
 * size, launch status, or operational maturity is available, this is the
 * honest answer and the explanation says which of those it rests on.
 */
export const STAGE_RESULTS = [
  'Pre-seed', 'Seed', 'Series A', 'Series B+',
  'Bootstrapped', 'Grant-funded', 'Pre-launch',
  'early-stage-round-not-disclosed',
  'stage-conflict-manual-review',
] as const;
export type StageResult = (typeof STAGE_RESULTS)[number];

export const STAGE_LABELS: Record<StageResult, string> = {
  'Pre-seed': 'Pre-seed',
  Seed: 'Seed',
  'Series A': 'Series A',
  'Series B+': 'Series B+',
  Bootstrapped: 'Bootstrapped',
  'Grant-funded': 'Grant-funded',
  'Pre-launch': 'Pre-launch',
  'early-stage-round-not-disclosed': 'Early-stage — round not publicly disclosed',
  'stage-conflict-manual-review': 'Stage conflict — manual review required',
};

/** The named venture stages. Only these require a strong, explicit source. */
export const NAMED_VENTURE_STAGES: StageResult[] = ['Pre-seed', 'Seed', 'Series A', 'Series B+'];

export function isNamedVentureStage(s: StageResult): boolean {
  return NAMED_VENTURE_STAGES.includes(s);
}

/**
 * Source families whose statement can support a NAMED venture stage.
 *
 * Note that `sec-form-d` is absent, and that absence is the entire
 * point: a Form D is an offering report, not a round name. It can
 * support `early-stage-round-not-disclosed` and it can contribute an
 * amount, but it cannot by itself say "Seed".
 */
export const STAGE_AUTHORITATIVE_FAMILIES: SourceFamily[] = [
  'company-site', 'accelerator', 'investor-portfolio', 'founder-announcement', 'funding-press',
];

export function canNameStage(f: SourceFamily): boolean {
  return STAGE_AUTHORITATIVE_FAMILIES.includes(f);
}

export const stageResolutionSchema = z.object({
  companyId: z.string(),
  stage: z.enum(STAGE_RESULTS),
  basis: z.enum(['explicit', 'inferred']),
  confidence: z.number().min(0).max(1),
  evidenceUrl: z.string().nullable(),
  evidenceDate: z.string().nullable(),
  /** Why this stage, in plain language, naming what the evidence did and did not establish. */
  explanation: z.string(),
  /** Populated when sources disagree — each entry names a source and what it claimed. */
  conflicts: z.array(z.object({ stage: z.string(), sourceUrl: z.string(), detail: z.string() })).default([]),
  lastCheckedAt: z.string(),
  version: z.string(),
});
export type StageResolution = z.infer<typeof stageResolutionSchema>;

// ── Reviewer corrections ──────────────────────────────────────────

/**
 * A human correcting an enriched field.
 *
 * The automated evidence is NEVER deleted or rewritten. A correction is
 * an additional, attributed layer on top of it, so six months from now a
 * reader can see both what the research concluded and what a reviewer
 * decided — and can tell which is which. Overwriting would destroy the
 * only record of why the machine got it wrong, which is the thing you
 * need in order to stop it happening again.
 */
export const CORRECTABLE_FIELDS = ['founder', 'vertical', 'stage'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export const fieldCorrectionSchema = z.object({
  id: z.number().int(),
  companyId: z.string(),
  field: z.enum(CORRECTABLE_FIELDS),
  previousValue: z.string().nullable(),
  newValue: z.string(),
  reason: z.string().min(3),
  /** Where the reviewer got it. Required — a correction without a source is an opinion. */
  sourceUrl: z.string().nullable(),
  reviewerId: z.string(),
  reviewerLabel: z.string(),
  reviewerSource: z.string(),
  at: z.string(),
});
export type FieldCorrection = z.infer<typeof fieldCorrectionSchema>;

// ── Versioning ────────────────────────────────────────────────────

/**
 * Bumped when the enrichment RULES change, and stored on every row, so a
 * verdict written under old rules stays interpretable rather than being
 * silently re-read under new ones.
 */
export const ENRICHMENT_VERSION = 'e1.0 (2026-07-30)';

// ── The API envelope ──────────────────────────────────────────────

/**
 * How an enriched field travels to the client.
 *
 * `value` is null for every state except `confirmed` and
 * `bounded-inference`, and the client is expected to read `state` first.
 * A client that reads `value` alone sees a null and can say "not on
 * record" — which is the old behaviour, and is why `state`, `summary`,
 * and `nextAction` are not optional.
 */
export interface EnrichedField<T> {
  state: ResolutionState;
  value: T | null;
  /** Visible "inferred" labelling comes from here, not from the caller's judgement. */
  inferred: boolean;
  confidence: number;
  /** Human sentence explaining the state. Never a canned placeholder. */
  summary: string;
  /** What to do next. Present for every state, including confirmed ("re-check after…"). */
  nextAction: string;
  evidence: { url: string; family: SourceFamily; label: string; publishedAt: string | null }[];
  sourcesAttempted: SourceFamily[];
  lastResearchedAt: string | null;
  conflicts: { detail: string; sourceUrl: string }[];
}

/** The vertical ids that exist on the company row, for cross-checking this module against storage. */
export const STORAGE_VERTICAL_IDS = VERTICAL_ID_VALUES;

/**
 * A company's complete enrichment state, as served and as rendered.
 *
 * Declared here rather than on either tier so the API contract has ONE
 * definition. The server builds it (services/enrichmentView.ts) and the
 * client consumes it; a drift between two hand-maintained copies is how
 * a field quietly starts rendering as blank.
 */
export interface CompanyEnrichment {
  founder: EnrichedField<{ name: string; title: string | null }> & {
    candidates: FounderCandidate[];
    status: FounderResolutionStatus | 'not-researched';
  };
  vertical: EnrichedField<{
    primarySector: string;
    primaryLabel: string;
    secondarySector: string | null;
    subvertical: string | null;
    /** False when the record carries the explicit non-sector status. */
    countsTowardRanking: boolean;
    evidenceGap: string | null;
  }>;
  stage: EnrichedField<{ stage: string; label: string }>;
  /** Every reviewer correction on this company, newest first. Never removed. */
  corrections: FieldCorrection[];
  attempts: ResearchAttempt[];
}

// ── Stealth Founder Radar ─────────────────────────────────────────

export const RADAR_FILTERS = [
  'all', 'verified', 'probable', 'conflicting', 'research-exhausted', 'manual-review',
] as const;
export type RadarFilter = (typeof RADAR_FILTERS)[number];

export const RADAR_FILTER_LABELS: Record<RadarFilter, string> = {
  all: 'All',
  verified: 'Verified',
  probable: 'Probable',
  conflicting: 'Conflicting',
  'research-exhausted': 'Research exhausted',
  'manual-review': 'Manual review',
};

export interface RadarPerson {
  candidateId: number;
  personKey: string;
  fullName: string;
  title: string | null;
  sourceUrl: string;
  sourceFamily: SourceFamily;
  sourceFamilyLabel: string;
  publishedAt: string | null;
  supportingText: string;
  /** Plain-language reasons this person is tied to this company. */
  matchEvidence: string[];
  matchScore: number;
  confidence: number;
  verified: boolean;
  reviewDecision: 'confirmed' | 'rejected' | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface RadarEntry {
  companyId: string;
  companyName: string;
  website: string | null;
  city: string | null;
  state: string | null;
  stealthReason: string;
  status: FounderResolutionStatus | 'not-researched';
  statusLabel: string;
  /**
   * Verified and candidate people are separated STRUCTURALLY, into two
   * arrays, rather than by a flag a template might forget to read. A
   * probable candidate cannot render as a verified founder, because it
   * is not in the verified list.
   */
  verifiedFounders: RadarPerson[];
  candidates: RadarPerson[];
  conflicts: { detail: string; sourceUrl: string }[];
  progress: {
    answered: number;
    total: number;
    families: { family: SourceFamily; label: string; outcome: string; detail: string }[];
  };
  lastCheckedAt: string | null;
  nextAction: string;
  relationships: {
    relation: string; to: string; toType: string;
    evidenceUrl: string; sourceFamily: SourceFamily; confidence: number;
  }[];
  financing: {
    amountText: string | null; roundType: string | null; investors: string[];
    url: string; publishedAt: string | null;
  }[];
  filingFacts: { label: string; value: string; url: string }[];
}
