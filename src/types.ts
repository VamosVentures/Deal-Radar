// ── VamosVentures Deal Radar: domain types ───────────────────────

/**
 * The five approved investment verticals — the single canonical list of
 * id strings. Everything else (shared/discovery.ts's Zod enum,
 * shared/enrichment.ts's PRIMARY_SECTORS, src/data/taxonomy.ts's display
 * metadata, the sidebar, filters, KPI breakdowns) derives from this
 * array rather than re-declaring its own copy.
 *
 * Robotics and Space Tech were combined into 'frontier'. General AI was
 * removed as a standalone vertical — AI is a technology attribute, not a
 * market, so an AI company is classified by the market it actually
 * serves (health/fintech/sustainability/frontier), defaulting to 'fow'
 * for genuinely horizontal AI. The legacy 'aoi' catch-all is retired
 * from the user-facing taxonomy entirely. See
 * src/data/taxonomy.ts's LEGACY_VERTICAL_ALIASES / normalizeVerticalId
 * for how old stored values (robotics, spacetech, space-tech, ai, aoi)
 * map onto this list.
 */
export const VERTICAL_ID_VALUES = ['health', 'fintech', 'fow', 'sustainability', 'frontier'] as const;
export type VerticalId = (typeof VERTICAL_ID_VALUES)[number];

// 'Stealth' means the company is deliberately operating in stealth.
// 'Unknown' means WE do not know the stage. Conflating the two was a
// real misrepresentation: the discovery importer mapped every
// stage-less candidate to 'Stealth', so a company that had publicly
// raised $117M was displayed as stealth.
export type Stage =
  | 'Pre-seed' | 'Seed' | 'Series A' | 'Stealth' | 'Unknown'
  /**
   * Researched stage results, written back by the enrichment pipeline.
   *
   * These exist on the company row because the scoring model reads the
   * ROW, not the enrichment tables — so without them, 195 companies whose
   * stage HAD been researched still scored as 'Unknown' and had the
   * 15-point stage component excluded entirely. The research was being
   * done and then ignored.
   *
   * `Early-stage — round not publicly disclosed` is the common one and is
   * a real finding, not a gap: the company is early and no source names
   * the round. It is scored as such rather than excluded.
   */
  | 'Series B+' | 'Bootstrapped' | 'Grant-funded' | 'Pre-launch'
  | 'Early-stage — round not publicly disclosed'
  | 'Stage conflict — manual review required';

export type PolicyFlag = 'defi-adjacent' | 'hardware-heavy' | 'outside-thesis';

/**
 * Demographic indicators are ONLY recorded when self-identified by the
 * founder or verified via a public statement / accelerator profile the
 * founder controls. They are never inferred from names, photos, or any
 * other proxy. `basis` + `source` are required for every indicator.
 */
export interface VerifiedIdentity {
  latinoLed?: boolean;
  femaleLed?: boolean;
  otherUnderrepresented?: string; // e.g. "Black-led", "veteran-led"
  basis: 'Self-identified' | 'Verified public statement';
  source: string; // where the verification lives
}

export interface Founder {
  name: string;
  role: string;
  background: string;
  identity?: VerifiedIdentity;
  /** Verified contact info only — populated via enrichment with a source. */
  email?: string;
  emailSource?: string;
  linkedin?: string;
}

export type EvidenceType =
  | 'Filing'
  | 'News'
  | 'Founder statement'
  | 'Product'
  | 'Accelerator'
  | 'Hiring signal'
  | 'Database record';

export interface Evidence {
  claim: string;
  source: string;
  url: string;
  date: string; // ISO
  type: EvidenceType;
}

export interface Company {
  id: string;
  name: string;
  oneLiner: string;
  vertical: VerticalId;
  subcategory: string;
  stage: Stage;
  city: string;
  state: string; // two-letter
  foundedYear: number;
  teamSize: number;
  raising?: string;
  /** 0–10 analyst-entered traction signal with justification */
  traction: { level: number; note: string };
  founders: Founder[];
  evidence: Evidence[];
  flags: PolicyFlag[];
  /** Optional recorded facts — absent means unknown, never guessed. */
  website?: string;
  accelerator?: string;
  lastFundingDate?: string;
  dateFirstSurfaced?: string;
  lastRefreshed?: string;
}

export interface StealthSignal {
  signal: string;
  source: string;
  url: string;
  date: string;
}

export interface StealthFounder {
  id: string;
  name: string;
  lastKnownRole: string;
  likelyVertical: VerticalId;
  likelyFocus: string;
  city: string;
  state: string;
  confidence: 'Low' | 'Medium' | 'High';
  signals: StealthSignal[];
  identity?: VerifiedIdentity;
}

// ── Scoring ──────────────────────────────────────────────────────

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  max: number;
  rationale: string;
  /**
   * False when the underlying data is ABSENT, so this component could not
   * be judged at all — as opposed to being judged and scoring badly.
   *
   * The distinction is the whole point. A company with no stage on record
   * is not a worse fit than one recorded as Series A; we simply do not
   * know. Scoring the unknown as a low value and then dividing by the full
   * 100 made every sparse record look mediocre, which is why 251 of 467
   * scores landed in a single half-point band and the number could not
   * rank anything.
   */
  assessable: boolean;
  /**
   * Whether this component describes the COMPANY or describes OUR OWN
   * evidence about it.
   *
   * Accelerator validation, evidence quality, and evidence recency are all
   * measured from the evidence set we hold, so they are always assessable
   * — which means a record with nothing else on file still produces a
   * confident-looking number derived entirely from how well WE sourced it.
   * A score with no company-descriptive component behind it is not a fit
   * score, and is marked provisional instead.
   */
  about: 'company' | 'our-evidence';
}

export interface FitScore {
  /**
   * 1.0–10.0 Vamos Fit Score, computed over the components that could
   * actually be judged. Read it together with `completeness`.
   */
  score: number;
  /** Absolute points earned, out of the full 100-point model. */
  totalPoints: number;
  /** Points available from assessable components only. */
  assessablePoints: number;
  /**
   * 0–1: the share of the 100-point model that could be judged at all.
   * A high score at low completeness is a confident answer about a small
   * amount of evidence, and must always be displayed alongside the score.
   */
  completeness: number;
  /**
   * True when NO company-descriptive component could be judged, so the
   * number reflects only the quality of our own sourcing. Such records
   * must not outrank genuinely-assessed companies.
   */
  provisional: boolean;
  /** Why the score is provisional, for display. Null when it is not. */
  provisionalReason: string | null;
  components: ScoreComponent[];
  exceptions: { flag: PolicyFlag; message: string }[];
  /** Scoring model version — stored with every snapshot. */
  version: string;
  /** 0–1: how well-sourced the record is. Distinct from thesis fit. */
  evidenceConfidence: number;
  /** Plain-language summary of how the number was produced. */
  explanation: string;
}

