import { z } from 'zod';
import type { WebsiteEvidenceLevel } from './qualification';

/**
 * Telling a COMPANY LEAD apart from a LIVE DEAL.
 *
 * The dashboard previously listed 35 Y Combinator directory entries as
 * though they were investment opportunities. Every one was a real
 * company, but a YC directory listing proves only two things: the
 * company exists, and it went through YC. It says nothing about whether
 * the company is raising now. Presenting that as a deal pipeline is the
 * kind of quiet overstatement this codebase exists to avoid.
 *
 * So the two concepts are now separate types, and the rule for crossing
 * from one to the other is explicit: a record is only a current
 * opportunity when a source SAYS SO, recently, in writing, at a URL a
 * human can open.
 */

// ── Source quality tiers ──────────────────────────────────────────

/**
 * Not all evidence is equal. A Form D filing is a legal document; a
 * GitHub org is a hint. Tiers exist so the system can refuse to state a
 * financing amount on the strength of a repository.
 */
export const SOURCE_TIERS = [1, 2, 3] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const TIER_DESCRIPTIONS: Record<SourceTier, string> = {
  1: 'Primary record: regulatory filings, government award databases, official company announcements, official accelerator directories.',
  2: 'Reputable secondary reporting: established funding-news publications, investor portfolio announcements, product-launch platforms.',
  3: 'Supporting signal only: code repositories, preprints, unverified secondary mentions. Never sufficient on its own for a financing claim.',
};

/**
 * Which tier each source id belongs to. A source absent from this map
 * is treated as tier 3 — unknown provenance is weak provenance.
 */
export const SOURCE_TIER_BY_ID: Record<string, SourceTier> = {
  sec: 1,          // SEC EDGAR Form D — a filed legal document
  grants: 1,       // SBIR/STTR — a government award database
  yc: 1,           // official accelerator directory (of PARTICIPATION, not of financing)
  'funding-news': 2,
  /**
   * An investor's own announcement of a round it took part in. First
   * party to the transaction — but marketing copy, not a filing with
   * legal exposure behind it, so it sits alongside the funding press at
   * tier 2 rather than above a Form D. What makes it valuable is that it
   * is a DIFFERENT FAMILY, not that it is a stronger tier.
   */
  'investor-news': 2,
  producthunt: 2,
  upload: 2,       // human-curated import; a person vouched for it
  github: 3,
  research: 3,     // arXiv
  websites: 3,
};

export function tierOf(sourceId: string): SourceTier {
  return SOURCE_TIER_BY_ID[sourceId] ?? 3;
}

/** Tier 1 and 2 may establish a financing amount, round, or date. Tier 3 may not. */
export function canEstablishFinancing(sourceId: string): boolean {
  return tierOf(sourceId) <= 2;
}

// ── Opportunity classification ────────────────────────────────────

export const OPPORTUNITY_CLASSES = [
  'company-lead',
  'recent-financing-signal',
  'credible-fundraising-signal',
  'verified-current-opportunity',
  'unverified-opportunity',
] as const;
export type OpportunityClass = (typeof OPPORTUNITY_CLASSES)[number];

export const OPPORTUNITY_CLASS_LABELS: Record<OpportunityClass, string> = {
  'company-lead': 'Company lead',
  'recent-financing-signal': 'Recent financing signal',
  'credible-fundraising-signal': 'Credible fundraising signal',
  'verified-current-opportunity': 'Verified current opportunity',
  'unverified-opportunity': 'Unverified opportunity',
};

export const OPPORTUNITY_CLASS_MEANINGS: Record<OpportunityClass, string> = {
  'company-lead':
    'The company exists and is on our radar. No recent evidence that it is raising. NOT a live deal.',
  'recent-financing-signal':
    'A recent, dated, sourced financing event (a filing, an award, an announced round). Proof money moved — not proof they are raising right now.',
  'credible-fundraising-signal':
    'Recent evidence pointing at an active raise (a fresh accelerator batch, an explicit "we are raising" statement) without a completed financing on record.',
  'verified-current-opportunity':
    'Both: a recent financing event AND an explicit current-raise signal, each from tier 1 or tier 2 evidence.',
  'unverified-opportunity':
    'Something suggested an opportunity, but the evidence does not meet the bar. Shown so a human can judge — never counted as a live deal.',
};

/** The classes that may be presented to a user as a live deal. */
export const LIVE_DEAL_CLASSES: OpportunityClass[] = [
  'recent-financing-signal',
  'credible-fundraising-signal',
  'verified-current-opportunity',
];

export function isLiveDeal(c: OpportunityClass): boolean {
  return LIVE_DEAL_CLASSES.includes(c);
}

// ── Financing / opportunity events ────────────────────────────────

export const OPPORTUNITY_TYPES = [
  'form-d-filing',
  'funding-announcement',
  'accelerator-batch',
  'explicit-raising-statement',
  'institutional-investment',
  'government-award',
  'product-launch',
  'none',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/**
 * Which event types are financing events, as opposed to
 * commercialization signals. An SBIR award is real money and a real
 * validation signal, but it is non-dilutive — it is NOT equity
 * financing and must not be described as a round.
 */
export const FINANCING_EVENT_TYPES: OpportunityType[] = [
  'form-d-filing', 'funding-announcement', 'institutional-investment',
];

export const COMMERCIALIZATION_EVENT_TYPES: OpportunityType[] = [
  'government-award', 'product-launch', 'accelerator-batch',
];

/** Evidence is only "current" within this window. Beyond it, an opportunity is stale by definition. */
export const CURRENT_EVIDENCE_DAYS = 365;
/** Preferred freshness. The shortlist builder tries this window first. */
export const PREFERRED_EVIDENCE_DAYS = 180;

export const dealEvidenceSchema = z.object({
  /** What kind of event this evidence describes. */
  opportunityType: z.enum(OPPORTUNITY_TYPES),
  /** Which adapter produced it — determines the tier. */
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** A URL a human can open to check the claim. Required, always. */
  url: z.string().url(),
  /** When the SOURCE published/filed it (not when we fetched it). */
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** When we retrieved it. */
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** One or two sentences, quoted or closely paraphrased from the source. */
  summary: z.string().min(3),
  /** Plain-language reason this counts as a CURRENT signal. */
  whyCurrent: z.string().min(3),
  /** Only from tier 1/2, only when the source states it. */
  amountUsd: z.number().positive().nullable().default(null),
  amountText: z.string().nullable().default(null),
  roundType: z.string().nullable().default(null),
  investors: z.array(z.string()).default([]),
  /**
   * There is deliberately NO per-source confidence field.
   *
   * It used to exist and was assigned by each adapter from a small set
   * of hardcoded constants — 0.5, 0.55, 0.6, 0.65, 0.7 — with no stated
   * basis for any of them and no way to check whether one was right. A
   * number nobody can falsify is worse than no number: it reads as a
   * measurement, it sorts and filters as a measurement, and it is a
   * guess wearing a decimal point.
   *
   * What actually distinguishes these rows is already here and IS
   * checkable: `tier` (1 = filing or primary document, 2 = independent
   * press or a participating investor, 3 = the company's own site),
   * `publishedAt`, and whether other rows contradict it. Opportunity
   * confidence is derived from those — see deriveEvidenceConfidence().
   */
});
export type DealEvidence = z.infer<typeof dealEvidenceSchema>;

/**
 * Opportunity-level confidence, derived from facts we hold rather than
 * from a number an adapter made up.
 *
 * The tier IS the quality signal: a Form D is a filing, a funding
 * article is a third party who carries some cost for being wrong, and
 * the company's own website is the company talking about itself. A
 * recorded conflict lowers it, because sources disagreeing is a real
 * property of the evidence and not something to average away.
 */
export function deriveEvidenceConfidence(
  tier: 1 | 2 | 3 | undefined,
  conflictCount: number,
): number {
  const base = tier === 1 ? 0.9 : tier === 2 ? 0.7 : tier === 3 ? 0.4 : 0;
  const penalty = Math.min(0.3, conflictCount * 0.15);
  return Number(Math.max(0, base - penalty).toFixed(2));
}

export const opportunitySchema = z.object({
  companyId: z.string().min(1),
  classification: z.enum(OPPORTUNITY_CLASSES),
  /** The single source that justifies the classification. */
  primarySourceId: z.string().min(1),
  primaryTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  opportunityType: z.enum(OPPORTUNITY_TYPES),
  evidenceUrl: z.string().url(),
  evidencePublishedAt: z.string().nullable(),
  evidenceRetrievedAt: z.string(),
  evidenceSummary: z.string(),
  whyCurrent: z.string(),
  amountUsd: z.number().nullable().default(null),
  amountText: z.string().nullable().default(null),
  roundType: z.string().nullable().default(null),
  investors: z.array(z.string()).default([]),
  evidenceConfidence: z.number().min(0).max(1),
  /** Populated when two sources disagree. Shown to a human; never auto-resolved. */
  conflicts: z.array(z.string()).default([]),
  missingInformation: z.array(z.string()).default([]),
  classifiedAt: z.string(),
});
export type Opportunity = z.infer<typeof opportunitySchema>;

// ── The classification rule ───────────────────────────────────────

export interface ClassifyInput {
  evidence: DealEvidence[];
  /** Today, as YYYY-MM-DD. Injected so tests are deterministic. */
  today?: string;
  /**
   * What the issuer's own website established, from the qualification
   * verdict. Absent means nobody has looked yet, which is treated as not
   * established — never as established.
   */
  operatingEvidence?: WebsiteEvidenceLevel;
}

export interface ClassificationResult {
  classification: OpportunityClass;
  primary: DealEvidence | null;
  reason: string;
  /** Distinct source ids that contributed usable recent evidence. */
  contributingSources: string[];
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

/**
 * The single place that decides whether something is a deal.
 *
 * Deliberately conservative. Every branch that could round UP to a
 * stronger claim instead requires the evidence to say so explicitly.
 */
export function classifyOpportunity(input: ClassifyInput): ClassificationResult {
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  // Undated evidence cannot establish currency. We do not guess a date.
  const dated = input.evidence.filter((e) => e.publishedAt !== null);
  const current = dated.filter((e) => daysBetween(e.publishedAt!, today) <= CURRENT_EVIDENCE_DAYS
    && daysBetween(e.publishedAt!, today) >= 0);

  const contributingSources = [...new Set(current.map((e) => e.sourceId))];

  if (input.evidence.length === 0) {
    return { classification: 'company-lead', primary: null, reason: 'No evidence on record.', contributingSources: [] };
  }
  if (current.length === 0) {
    const newest = dated.sort((a, b) => (a.publishedAt! < b.publishedAt! ? 1 : -1))[0];
    return {
      classification: 'company-lead',
      primary: null,
      reason: newest
        ? `Newest dated evidence is ${daysBetween(newest.publishedAt!, today)} days old — beyond the ${CURRENT_EVIDENCE_DAYS}-day currency window. The company exists; nothing shows a current raise.`
        : 'No evidence carries a publication date, so currency cannot be established. Treated as a lead, not a deal.',
      contributingSources: [],
    };
  }

  // Financing must come from tier 1 or 2. A GitHub org does not prove a round.
  const financing = current.filter(
    (e) => FINANCING_EVENT_TYPES.includes(e.opportunityType) && e.tier <= 2,
  );
  /**
   * A recent accelerator batch only counts as a fundraising signal when we
   * have ALSO confirmed the company is an operating business. A directory
   * row on its own proves participation in a cohort, and a cohort is not a
   * raise — that conflation is what put 35 YC listings on the dashboard as
   * though they were deals.
   *
   * "Confirmed as operating" used to mean the mere PRESENCE of a website
   * evidence row, which is the same mistake qualification was making: a
   * row exists as soon as a domain responds, so a parked page satisfied
   * it. It now means what it says, on the shared scale — and the fact is
   * taken from the qualification verdict rather than re-derived here, so
   * there is one answer to the question in the codebase.
   */
  const hasSubstantiveOperatingEvidence = input.operatingEvidence === 'substantive';
  const raising = current.filter((e) => e.tier <= 2 && (
    e.opportunityType === 'explicit-raising-statement'
    || (e.opportunityType === 'accelerator-batch' && hasSubstantiveOperatingEvidence)
  ));
  const commercialization = current.filter(
    (e) => COMMERCIALIZATION_EVENT_TYPES.includes(e.opportunityType) && e.tier <= 2,
  );

  const strongest = (list: DealEvidence[]) =>
    [...list].sort((a, b) => a.tier - b.tier || (a.publishedAt! < b.publishedAt! ? 1 : -1))[0];

  if (financing.length > 0 && raising.length > 0) {
    return {
      classification: 'verified-current-opportunity',
      primary: strongest(financing),
      reason: 'A recent financing event AND a recent explicit raising/accelerator signal, both from tier 1–2 sources.',
      contributingSources,
    };
  }
  if (financing.length > 0) {
    const p = strongest(financing);
    return {
      classification: 'recent-financing-signal',
      primary: p,
      reason: `Recent ${p.opportunityType.replace(/-/g, ' ')} on ${p.publishedAt} from a tier-${p.tier} source. Proves financing occurred; does not by itself prove an open round.`,
      contributingSources,
    };
  }
  if (raising.length > 0) {
    const p = strongest(raising);
    return {
      classification: 'credible-fundraising-signal',
      primary: p,
      reason: `Recent ${p.opportunityType.replace(/-/g, ' ')} on ${p.publishedAt} suggests an active raise, but no completed financing is on record.`,
      contributingSources,
    };
  }
  if (commercialization.length > 0) {
    const p = strongest(commercialization);
    return {
      classification: 'unverified-opportunity',
      primary: p,
      reason: `Recent ${p.opportunityType.replace(/-/g, ' ')} is a commercialization signal, not a financing event. Surfaced for human judgement, not counted as a live deal.`,
      contributingSources,
    };
  }
  return {
    classification: 'company-lead',
    primary: null,
    reason: 'Recent evidence exists but none of it describes a financing or fundraising event.',
    contributingSources,
  };
}

/**
 * What an accelerator-derived opportunity does and does not establish.
 *
 * A recent batch plus a verified operating website is a credible reason to
 * believe a company is raising. It is NOT verified financing, and every
 * surface that shows one of these must say so in these words rather than
 * leaving a reader to assume the amount is simply missing from the page.
 */
export const ACCELERATOR_SIGNAL_LABELS = [
  'Recent accelerator signal',
  'Financing amount unknown',
  'Current fundraising not confirmed',
] as const;

/** True when this opportunity rests on an accelerator batch rather than a financing event. */
export function isAcceleratorSignal(o: Pick<Opportunity, 'opportunityType'>): boolean {
  return o.opportunityType === 'accelerator-batch';
}

// ── Source diversity ──────────────────────────────────────────────

/**
 * Source families, so "three distinct sources" cannot be satisfied by
 * three flavours of the same thing.
 */
export const SOURCE_FAMILY: Record<string, string> = {
  sec: 'regulatory',
  grants: 'government',
  yc: 'accelerator',
  'funding-news': 'press',
  /**
   * A financing announcement published by a firm that took part in the
   * financing, on that firm's own verified domain.
   *
   * Separate from `press` because the two answer different questions: a
   * publication REPORTS that a round happened, a participating investor
   * STATES that it happened and that they were in it. Two outlets
   * rewriting one press release remain one family; an outlet and an
   * investor are two.
   *
   * The corollary is enforced elsewhere and matters just as much: two
   * different investors announcing the SAME round are still one family.
   * See corroborationKey in server/services/issuerQualification.ts.
   */
  'investor-news': 'investor-primary',
  producthunt: 'launch-platform',
  github: 'code',
  research: 'academic',
  upload: 'manual',
  websites: 'web',
};

export function familyOf(sourceId: string): string {
  return SOURCE_FAMILY[sourceId] ?? 'other';
}

/**
 * Display names. The raw ids are internal handles ("funding-news",
 * "investor-primary") and reading them off a dashboard invites a viewer
 * to guess what they mean — which is how "press" and "an investor who
 * wrote the cheque" end up looking interchangeable.
 */
export const SOURCE_FAMILY_LABELS: Record<string, string> = {
  regulatory: 'Regulatory filing',
  government: 'Government award',
  accelerator: 'Accelerator directory',
  press: 'Funding press',
  'investor-primary': 'Investor (primary)',
  'launch-platform': 'Launch platform',
  code: 'Code repository',
  academic: 'Academic preprint',
  manual: 'Human-curated import',
  web: 'Company website',
  other: 'Other',
};

export function familyLabel(family: string): string {
  return SOURCE_FAMILY_LABELS[family] ?? family;
}

export const SOURCE_LABELS: Record<string, string> = {
  sec: 'SEC EDGAR (Form D)',
  grants: 'SBIR/STTR awards',
  yc: 'Y Combinator directory',
  'funding-news': 'Funding press (RSS)',
  'investor-news': 'Investor announcements',
  producthunt: 'Product Hunt',
  github: 'GitHub',
  research: 'arXiv',
  upload: 'Uploaded CSV/JSON',
  websites: 'Company website',
};

export function sourceLabel(sourceId: string): string {
  return SOURCE_LABELS[sourceId] ?? sourceId;
}

/** No single accelerator may dominate a sector's shortlist. */
export const MAX_YC_PRIMARY_PER_SECTOR = 2;
/** A healthy sector draws on at least this many distinct source families. */
export const TARGET_SOURCE_FAMILIES_PER_SECTOR = 3;
/** Warn when one source supplies more than this share of all opportunities. */
export const SINGLE_SOURCE_WARN_SHARE = 0.4;

export interface DiversityReport {
  total: number;
  bySource: Record<string, number>;
  byFamily: Record<string, number>;
  byTier: Record<string, number>;
  ycShare: number;
  distinctFamilies: number;
  warnings: string[];
}

export function assessDiversity(
  items: { primarySourceId: string; primaryTier: SourceTier }[],
  scope = 'the shortlist',
): DiversityReport {
  const bySource: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const i of items) {
    bySource[i.primarySourceId] = (bySource[i.primarySourceId] ?? 0) + 1;
    const f = familyOf(i.primarySourceId);
    byFamily[f] = (byFamily[f] ?? 0) + 1;
    byTier[`tier${i.primaryTier}`] = (byTier[`tier${i.primaryTier}`] ?? 0) + 1;
  }
  const total = items.length;
  const ycCount = bySource.yc ?? 0;
  const ycShare = total > 0 ? ycCount / total : 0;
  const distinctFamilies = Object.keys(byFamily).length;

  const warnings: string[] = [];
  for (const [src, n] of Object.entries(bySource)) {
    if (total > 0 && n / total > SINGLE_SOURCE_WARN_SHARE) {
      warnings.push(`${Math.round((n / total) * 100)}% of ${scope} comes from a single source (${src}). Concentration above ${Math.round(SINGLE_SOURCE_WARN_SHARE * 100)}% means the pipeline is really one source wearing a hat.`);
    }
  }
  if (total > 0 && distinctFamilies < TARGET_SOURCE_FAMILIES_PER_SECTOR) {
    warnings.push(`${scope} draws on only ${distinctFamilies} source famil${distinctFamilies === 1 ? 'y' : 'ies'}; the target is ${TARGET_SOURCE_FAMILIES_PER_SECTOR}.`);
  }
  return { total, bySource, byFamily, byTier, ycShare, distinctFamilies, warnings };
}
