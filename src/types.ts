// ── VamosVentures Deal Radar: domain types ───────────────────────

// Keep in lockstep with VERTICAL_ID_VALUES in shared/discovery.ts —
// that array is the runtime (Zod) source of truth and this union is the
// compile-time one; a mismatch is a type error at the import sites.
export type VerticalId =
  | 'health'
  | 'fintech'
  | 'fow'
  | 'sustainability'
  | 'robotics'
  | 'spacetech'
  | 'ai'
  | 'aoi';

// 'Stealth' means the company is deliberately operating in stealth.
// 'Unknown' means WE do not know the stage. Conflating the two was a
// real misrepresentation: the discovery importer mapped every
// stage-less candidate to 'Stealth', so a company that had publicly
// raised $117M was displayed as stealth.
export type Stage = 'Pre-seed' | 'Seed' | 'Series A' | 'Stealth' | 'Unknown';

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
}

export interface FitScore {
  /** 1.0–10.0 Vamos Fit Score */
  score: number;
  totalPoints: number; // out of 100
  components: ScoreComponent[];
  exceptions: { flag: PolicyFlag; message: string }[];
  /** Scoring model version — stored with every snapshot. */
  version: string;
  /** 0–1: how well-sourced the record is. Distinct from thesis fit. */
  evidenceConfidence: number;
  /** Plain-language summary of how the number was produced. */
  explanation: string;
}

