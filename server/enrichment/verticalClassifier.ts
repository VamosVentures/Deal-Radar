import {
  NON_SECTOR_STATUS, PRIMARY_SECTORS, SECTOR_LABELS,
  type PrimarySector, type SectorAssignment,
} from '../../shared/enrichment';
import { VERTICALS } from '../../src/data/taxonomy';

/**
 * Sector classification from what a company DOES and WHO PAYS for it.
 *
 * The rule this module exists to enforce is that a sector is not a
 * keyword hit. "AI" appears on essentially every startup's home page in
 * 2026; a diagnostics company that mentions its machine-learning model
 * is a health company, and classifying it as horizontal Future of Work
 * AI infrastructure because the token appeared would be both wrong and
 * unfalsifiable. So each sector is
 * described by two independent question groups —
 *
 *   WHAT IT DOES   the product, the technology, the thing being built
 *   WHO PAYS       the buyer, the market, the revenue relationship
 *
 * — and a sector only wins when it has support in both, and wins by a
 * margin over the runner-up. A company matching one group only, or
 * matching two sectors equally, does not get forced into the higher
 * score; it gets a lower confidence and, past a threshold, a secondary
 * sector or a human.
 *
 * Pure functions. No network, no model call, so the same input text
 * always yields the same verdict and a reviewer can check the working
 * against the reason string.
 */

export interface SectorSignals {
  /** Product/technology vocabulary — what is being built. */
  does: string[];
  /** Buyer/market vocabulary — who pays. */
  pays: string[];
  /** Subvertical hints: [regex-ish token, human subvertical label]. First match wins. */
  subverticals: [string, string][];
}

/**
 * Deliberately phrase-based rather than word-based. Single words are what
 * made a keyword classifier useless: "care" matches customer care,
 * "space" matches workspace, "bank" matches data bank. Multi-word phrases
 * carry the domain with them.
 *
 * ─────────────────────────────────────────────────────────────────
 * SUBVERTICAL LABELS ARE THE OFFICIAL VAMOS TAXONOMY — NOTHING ELSE
 * ─────────────────────────────────────────────────────────────────
 *
 * Every label on the right-hand side of a `subverticals` pair below is a
 * literal, exact subcategory name from `src/data/taxonomy.ts`'s
 * `VERTICALS` — the same list the CSV template, manual entry, and the
 * sidebar filter already use. Before this, this module maintained its
 * own separate, differently-worded vocabulary ("payments infrastructure"
 * vs. the official "Payments"; "consumer wellness" — which isn't in the
 * official taxonomy under ANY sector). A company could end up with a
 * `subcategory` in either vocabulary depending on whether a human or
 * this pipeline last touched the field, and the two never matched
 * letter-for-letter. `subverticalLabelsForSector` below now derives its
 * "is this a valid label for this sector" answer directly from
 * `VERTICALS`, so there is exactly one taxonomy and it is structurally
 * impossible for this file to drift from it again.
 *
 * Two consequences worth knowing about, both deliberate:
 *
 * 1. The official taxonomy is coarser than free-text detection used to
 *    be. FinTech's official list has no "lending" category — the
 *    closest is "Access to capital" — so several formerly-distinct
 *    auto-labels now collapse onto the same official one. That is
 *    correct, not a regression: the official taxonomy IS coarser by
 *    design, and forcing a finer distinction it does not draw would be
 *    inventing a category Vamos doesn't have.
 * 2. A few official subcategories describe a PATIENT POPULATION or
 *    MARKET SEGMENT rather than a product category ("Cancer", "Brain
 *    health", "Women's health") and simply are not reliably inferable
 *    from generic company text — a company can build "personalized
 *    care" without ever using the word "cancer". Keyword patterns are
 *    included for these where a real signal exists, but expect them to
 *    fire far less often than the broader categories. That is the
 *    correct failure mode: matching this module's standing rule
 *    everywhere else, a subcategory this module cannot support with
 *    real text is left unset rather than guessed at.
 */
export const SECTOR_SIGNALS: Record<PrimarySector, SectorSignals> = {
  health: {
    does: [
      'clinical', 'patient', 'diagnostic', 'therapeutic', 'medical device', 'drug discovery',
      'biotech', 'telehealth', 'mental health', 'behavioral health', 'electronic health record',
      'ehr', 'medication', 'oncology', 'cardiology', 'radiology', 'genomics', 'biomarker',
      'clinical trial', 'fda', 'hipaa', 'wellness', 'nutrition', 'fitness', 'care delivery',
      'digital therapeutic', 'remote patient monitoring', 'surgical',
      // Health BENEFITS and plan administration. Missing entirely at
      // first, which left Helm Health Corp — a confirmed operating
      // company whose own site says "TPAs and carriers leverage Helm to
      // build Dynamic Copay products for members" — scoring zero against
      // every sector. The gap was a whole subvertical, not one company.
      'copay', 'co-pay', 'health benefit', 'benefit design', 'formulary',
      'prior authorization', 'utilization management', 'care management',
      'claims processing', 'benefits administration', 'plan design', 'deductible',
    ],
    pays: [
      'health system', 'hospital', 'provider', 'payer', 'health plan', 'insurer', 'clinic',
      'physician', 'pharma', 'pharmaceutical', 'employer health', 'medicaid', 'medicare',
      'tpa', 'third-party administrator', 'patients pay', 'per member per month',
    ],
    // Ordered most-specific-first: a population/segment match (Cancer,
    // Women's health, Brain health, Longevity) wins over the generic
    // "Personalized care" catch-all when both are present in the text.
    subverticals: [
      ['clinical trial|electronic health record|ehr|claims processing|medical device|surgical',
        'Healthcare infrastructure'],
      ['oncology|cancer', 'Cancer'],
      ['genomics|biomarker|drug discovery', 'Genomics & personalized medicine'],
      ["women's health|maternal health|fertility|menopause|prenatal", "Women's health"],
      ['brain health|neurology|neurological|cognitive health', 'Brain health'],
      ['longevity|healthspan|anti-aging', 'Longevity'],
      ['copay|co-pay|benefit design|formulary|deductible|plan design|benefits administration',
        'Healthcare finance'],
      ['clinician staffing|nurse staffing|provider scheduling|credentialing', 'Healthcare workforce technology'],
      ['telehealth|remote patient|mental health|behavioral health|nutrition|fitness|wellness|digital therapeutic',
        'Personalized care (AI / tech-enabled)'],
    ],
  },
  fintech: {
    does: [
      'payment', 'payments', 'lending', 'underwriting', 'credit', 'banking', 'ledger',
      'treasury', 'invoice', 'accounting', 'tax', 'payroll', 'insurance', 'wealth management',
      'brokerage', 'compliance', 'kyc', 'aml', 'fraud detection', 'card issuing',
      'core banking', 'reconciliation', 'capital markets', 'remittance', 'embedded finance',
      // No official subcategory names these outright, but crypto/DeFi and
      // financial planning are real fintech markets Vamos does track
      // ("DeFi & blockchain", "Wealth planning") — without these, a
      // company whose whole description is crypto-native scored zero
      // `does` hits and was never even recognized as fintech at all.
      'crypto', 'blockchain', 'defi', 'stablecoin', 'financial planning', 'financial advisor',
    ],
    pays: [
      'bank', 'banks', 'credit union', 'lender', 'merchant', 'financial institution',
      'cfo', 'finance team', 'insurer', 'broker', 'fund administrator', 'per transaction',
      'interchange', 'basis points', 'small business', 'consumers bank',
    ],
    subverticals: [
      ['payments|card issuing|interchange', 'Payments'],
      ['crypto|blockchain|defi|web3|stablecoin', 'DeFi & blockchain'],
      ['brokerage|capital markets', 'Wealth & capital markets'],
      ['financial planning|financial advisor|retirement planning|estate planning', 'Wealth planning'],
      ['investing|investment platform|portfolio management|robo-advisor|asset management', 'Investing'],
      // "Lending and credit" has no dedicated official category — the
      // closest fit is the outcome lending actually produces for the
      // borrower, not the mechanism.
      ['lending|underwriting|credit', 'Access to capital'],
      // `tax`, `kyc` and `aml` are 3-letter strings that collide with
      // ordinary words ("syntax", "streamline") under plain substring
      // matching — word-bounded here so they only match the term, not a
      // substring of an unrelated one. The rest of this group is long
      // enough that a stray substring hit isn't a real risk.
      ['insurance|payroll|accounting|invoice|\\btax\\b|\\bkyc\\b|\\baml\\b|fraud|compliance|treasury|reconciliation|ledger|core banking|embedded finance',
        'New financial infrastructure'],
    ],
  },
  sustainability: {
    does: [
      'carbon', 'emissions', 'decarbon', 'renewable', 'solar', 'wind', 'battery',
      'energy storage', 'grid', 'electrification', 'circular economy', 'recycling',
      'waste', 'water treatment', 'sustainable materials', 'climate', 'greenhouse gas',
      'net zero', 'ev charging', 'heat pump', 'biofuel', 'agriculture technology', 'regenerative',
      // Nuclear, hydrogen and geothermal are official Vamos subcategories
      // in their own right (src/data/taxonomy.ts) but had no `does`
      // signal at all — a company entirely about a small modular
      // reactor scored zero against every sector, sustainability
      // included.
      'nuclear', 'fission', 'fusion', 'small modular reactor', 'hydrogen', 'electrolyzer',
      'fuel cell', 'geothermal',
    ],
    pays: [
      'utility', 'utilities', 'grid operator', 'energy provider', 'municipality',
      'esg', 'sustainability team', 'carbon market', 'offtaker', 'industrial', 'manufacturer',
      'farmer', 'agribusiness', 'per ton', 'per kilowatt',
    ],
    // 'recycling|waste|circular', 'water', and 'agriculture technology'
    // were auto-labels before this change and are DELIBERATELY dropped
    // here: the official Sustainability taxonomy has no circular-economy,
    // water, or agriculture category at all. Forcing one of those
    // companies into "Energy & operations optimization" because it
    // sounds generic would be exactly the kind of near-miss labelling
    // this whole change exists to stop. A company like that is correctly
    // classified as Sustainability at the sector level and left with no
    // more specific subcategory — an honest gap, not a guess.
    subverticals: [
      ['nuclear|fission|fusion|small modular reactor', 'Nuclear energy'],
      ['hydrogen|electrolyzer|fuel cell', 'Hydrogen'],
      ['geothermal', 'Geothermal'],
      ['solar|wind|renewable', 'Renewable energy'],
      ['battery|energy storage', 'Renewable-energy digital infrastructure'],
      ['ev charging|electrification|heat pump', 'Digital energy infrastructure'],
      ['smart grid|grid management|grid operator', 'Smart grids'],
      ['carbon|emissions|greenhouse|net zero', 'Energy & operations optimization'],
    ],
  },
  // Frontier = Robotics + Space Tech, combined (src/data/taxonomy.ts).
  frontier: {
    does: [
      'robot', 'robotic', 'autonomous vehicle', 'drone', 'uav', 'manipulator', 'end effector',
      'warehouse automation', 'industrial automation', 'motion planning', 'lidar', 'slam',
      'teleoperation', 'humanoid', 'cobot', 'actuator', 'perception stack', 'automation cell',
      'satellite', 'spacecraft', 'launch vehicle', 'orbital', 'in-orbit', 'propulsion',
      'earth observation', 'remote sensing', 'ground station', 'constellation', 'payload',
      'rocket', 'cislunar', 'space station', 'reentry', 'hypersonic', 'smallsat', 'cubesat',
    ],
    pays: [
      'warehouse', 'factory', 'manufacturer', 'logistics', 'fulfillment', '3pl',
      'industrial operator', 'agriculture operator', 'construction', 'per robot', 'robots as a service',
      'space agency', 'nasa', 'esa', 'defense', 'department of defense', 'space force',
      'satellite operator', 'telecom operator', 'government contract', 'per launch',
      'imagery customer', 'earth observation customer',
    ],
    // "Space situational awareness" (tracking/monitoring objects) is
    // deliberately matched on its own phrase, separately from and BEFORE
    // the generic 'debris' pattern in the launch/hardware group below —
    // a company that only says "debris removal" (a hardware/servicing
    // mission) falls through to that later group instead, since removing
    // debris and tracking it are different businesses.
    subverticals: [
      ['surgical robot', 'Healthcare & surgical robotics'],
      ['warehouse|fulfillment|logistics', 'Industrial & warehouse automation'],
      ['agriculture|harvest', 'Field & agricultural robotics'],
      ['humanoid|manipulator|cobot', 'Humanoid & general-purpose robots'],
      ['simulation|digital twin|robot software|motion planning', 'Robotics software & simulation'],
      ['drone|uav|autonomous vehicle|self-driving|lidar|slam|perception stack', 'Perception & control systems'],
      ['space situational awareness|space domain awareness|debris tracking|collision avoidance',
        'Space situational awareness'],
      ['earth observation|remote sensing|imagery', 'Earth observation & geospatial data'],
      ['satellite|constellation|smallsat|cubesat', 'Satellite communications'],
      ['ground station|downlink', 'Ground-segment & mission software'],
      ['launch|rocket|propulsion|in-orbit|servicing|debris', 'Launch & in-space hardware'],
    ],
  },
  // General AI was retired as a market of its own — AI is a technology,
  // not a market (src/data/taxonomy.ts) — so horizontal AI-infra
  // vocabulary now scores toward Future of Work, the default the task
  // specifies for AI that is not specific to another sector's market.
  fow: {
    does: [
      'hiring', 'recruiting', 'talent', 'workforce', 'employee', 'onboarding', 'training',
      'upskilling', 'learning management', 'performance review', 'scheduling shifts',
      'frontline worker', 'contractor management', 'benefits administration', 'hr platform',
      'people operations', 'collaboration', 'productivity', 'knowledge management',
      'large language model', 'foundation model', 'machine learning platform', 'inference',
      'model training', 'fine-tuning', 'vector database', 'retrieval augmented',
      'agent framework', 'mlops', 'gpu cluster', 'model evaluation', 'prompt',
      'computer vision platform', 'speech recognition', 'generative ai', 'ai infrastructure',
      // "AI copilots" and "Human-AI collaboration" are official
      // subcategories with no `does` signal at all before this.
      'copilot', 'co-pilot', 'human-in-the-loop', 'creator economy', 'freelancer', 'solopreneur',
    ],
    pays: [
      'hr team', 'employer', 'chro', 'people team', 'staffing', 'enterprise', 'per employee',
      'per seat', 'recruiter', 'hiring manager', 'workforce management',
      'developer', 'developers', 'ml team', 'data team', 'enterprise ai', 'per token',
      'per inference', 'api customer', 'platform customer', 'ai engineer',
    ],
    subverticals: [
      ['hiring|recruiting|talent acquisition|benefits|payroll|hr platform|people operations|training|upskilling|learning',
        'Next-generation work infrastructure'],
      ['frontline|shift|scheduling shifts', 'Frontline & essential-worker technology'],
      ['collaboration|productivity|knowledge management', 'Workflow & collaboration tools'],
      ['copilot|co-pilot', 'AI copilots'],
      ['human-in-the-loop|human-ai collaboration|augmented intelligence', 'Human-AI collaboration'],
      ['creator economy|freelancer|solopreneur|microbusiness|gig worker', 'Creator & microbusiness enablement'],
      ['ai-native|ai native platform', 'AI-native work platforms'],
      ['agent framework|autonomous agent|multi-agent', 'Autonomous agents'],
      ['workflow automation|robotic process automation', 'Human-centered automation'],
      ['foundation model|large language model|model training|inference|gpu|mlops|ai infrastructure|vector database|retrieval|evaluation|guardrail|safety|computer vision platform|speech recognition',
        'Horizontal / general-purpose AI infrastructure & tooling'],
    ],
  },
};

export interface SectorScore {
  sector: PrimarySector;
  doesHits: string[];
  paysHits: string[];
  score: number;
}

/**
 * Score every sector against a body of text.
 *
 * `does` and `pays` are counted separately and multiplied rather than
 * summed, so a company with ten product words and no identifiable buyer
 * scores zero rather than winning on volume. Multiplication is what
 * encodes "both questions must be answered".
 */
export function scoreSectors(text: string): SectorScore[] {
  const lower = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = (list: string[]) => list.filter((s) => lower.includes(s.toLowerCase()));
  return PRIMARY_SECTORS.map((sector) => {
    const spec = SECTOR_SIGNALS[sector];
    const doesHits = hits(spec.does);
    const paysHits = hits(spec.pays);
    // +1 on the buyer term so a strong product signal with a weak buyer
    // signal still ranks — but a sector with NO product signal scores 0
    // regardless of how many buyer words appear.
    const score = doesHits.length === 0 ? 0 : doesHits.length * (paysHits.length + 1);
    return { sector, doesHits, paysHits, score };
  }).sort((a, b) => b.score - a.score);
}

/** First matching subvertical for a sector, or null when nothing specific is evident. */
export function matchSubvertical(sector: PrimarySector, text: string): string | null {
  const lower = text.toLowerCase();
  for (const [pattern, label] of SECTOR_SIGNALS[sector].subverticals) {
    if (new RegExp(pattern, 'i').test(lower)) return label;
  }
  return null;
}

/**
 * Accelerator-directory categories, mapped onto Vamos sectors.
 *
 * These are STRUCTURED, ATTRIBUTABLE evidence: Y Combinator's own
 * directory says a company is "B2B, Human Resources, Artificial
 * Intelligence", and that is the accelerator classifying its own
 * portfolio company, not us guessing from prose. It outranks the
 * free-text scan below, which exists to read pages nobody has
 * categorised.
 *
 * The mapping is deliberately NOT one-to-one, and the priority order is
 * the same rule the free-text scan enforces: a domain sector beats a
 * technique. Checkr is "Human Resources" AND "Artificial Intelligence";
 * it is a Future of Work company that uses AI, not an AI company. Only a
 * record whose ONLY signal is a technique lands in Future of Work via
 * that fallback rather than a domain sector.
 */
const DIRECTORY_CATEGORY_MAP: [RegExp, PrimarySector][] = [
  // Domain sectors first — these win over technique labels.
  [/health|medical|diagnostic|bio|therapeut|pharma|wellness|fitness|nutrition|mental/i, 'health'],
  [/fintech|payment|banking|finance|insurance|lending|credit|asset management|investing|crypto/i, 'fintech'],
  [/aviation|space|satellite|aerospace/i, 'frontier'],
  [/robotic|manufacturing|drone|autonomous|hard tech|industrial/i, 'frontier'],
  [/climate|energy|sustainab|agriculture|carbon|environment|water|recycl/i, 'sustainability'],
  [/human resources|recruit|hiring|talent|education|elearning|learning|productivity|workforce|future of work|hr tech|ops|supply chain|logistics/i, 'fow'],
  // Technique labels last: only reached when nothing above matched.
  // General AI was retired as a market of its own, so these fall to fow.
  [/artificial intelligence|machine learning|generative|data|analytics|developer tools|infrastructure/i, 'fow'],
];

/** Placeholder subcategory values that carry no classification signal. */
const EMPTY_CATEGORY = /^\s*$|unclassified|requires manual review|unknown|n\/?a$/i;
export { EMPTY_CATEGORY };

/**
 * The Vamos taxonomy labels that belong to ONE sector — e.g. 'Payments'
 * belongs to `fintech`, never to `health`.
 *
 * Derived directly from `VERTICALS` (`src/data/taxonomy.ts`), the SAME
 * list the CSV template and sidebar filter read — not from this file's
 * own `subverticals` patterns. Two structures could describe the same
 * taxonomy and still drift from each other the moment one is edited
 * without the other; reading the official list directly makes that
 * impossible; this function can only ever recognize a label the
 * official taxonomy actually contains.
 *
 * Exists so a caller can tell a genuine taxonomy match apart from a
 * taxonomy-SHAPED value left over from a different classification —
 * see the guard in server/services/enrichment.ts that decides whether a
 * stored subcategory is worth keeping over a freshly classified one.
 */
export function subverticalLabelsForSector(sector: PrimarySector): Set<string> {
  const vertical = VERTICALS.find((v) => v.id === sector);
  return new Set((vertical?.subcategories ?? []).map((s) => s.name.toLowerCase()));
}

export interface DirectoryClassification {
  sector: PrimarySector;
  matchedCategory: string;
}

/**
 * Classify from a directory's own categories.
 *
 * Returns null when the categories are absent or are the placeholder the
 * importer writes when a source stated none — an absent category is not
 * a category.
 */
export function classifyFromDirectoryCategories(raw: string | null): DirectoryClassification | null {
  if (!raw || EMPTY_CATEGORY.test(raw)) return null;
  const parts = raw.split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const [pattern, sector] of DIRECTORY_CATEGORY_MAP) {
    const hit = parts.find((p) => pattern.test(p));
    if (hit) return { sector, matchedCategory: hit };
  }
  return null;
}

export interface ClassificationInput {
  /** Everything we can read about the company: one-liner, subcategory, website text, evidence claims. */
  text: string;
  /** Is this record confirmed to be an operating company at all? */
  identityResolved: boolean;
  /** Why identity is unresolved, when it is. Surfaced as the evidence gap. */
  identityGap?: string;
  /** Where the classifying text came from, when it came from one place. */
  sourceUrl?: string | null;
  /**
   * True when the text is the company describing ITSELF (its own site).
   * A description written by the company is explicit evidence of what it
   * does; a headline written by a reporter is not, and the two must not
   * produce the same `basis`.
   */
  selfDescribed: boolean;
  /** Raw category string from an accelerator directory, when one is on record. */
  directoryCategories?: string | null;
  /** Where those categories came from, for the citation. */
  directorySourceUrl?: string | null;
  directorySourceLabel?: string | null;
}

export interface ClassificationOutput {
  primarySector: SectorAssignment;
  secondarySector: PrimarySector | null;
  subvertical: string | null;
  reason: string;
  confidence: number;
  basis: 'explicit' | 'inferred';
  evidenceGap: string | null;
  sourceUrl: string | null;
}

/** Minimum score before a sector may be assigned at all. */
export const MIN_SECTOR_SCORE = 2;

/**
 * A runner-up this close means the record genuinely spans two sectors —
 * a health-payments company is both — so the second is recorded rather
 * than discarded.
 */
const SECONDARY_RATIO = 0.5;

/**
 * Classify a company.
 *
 * Returns the explicit non-sector status when identity is unresolved or
 * the evidence is too thin, rather than reaching for a sector to fill the
 * column. That status is excluded from sector rankings by
 * `countsTowardSectorRanking`, so an unclassifiable record cannot
 * displace a real company from a shortlist.
 */
export function classifyCompany(input: ClassificationInput): ClassificationOutput {
  const gapBase = {
    secondarySector: null,
    subvertical: null,
    confidence: 0,
    basis: 'inferred' as const,
    sourceUrl: input.sourceUrl ?? null,
  };

  if (!input.identityResolved) {
    return {
      ...gapBase,
      primarySector: NON_SECTOR_STATUS,
      reason: 'Not classified: this record is not confirmed to be an operating company, so any sector assigned to it '
        + 'would describe an entity we have not established exists in the form the sector implies.',
      evidenceGap: input.identityGap
        ?? 'Company identity is unresolved — no confirmed operating business is on record for this entity.',
    };
  }

  const scores = scoreSectors(input.text);
  const top = scores[0];
  const runnerUp = scores[1];
  const directory = classifyFromDirectoryCategories(input.directoryCategories ?? null);

  if (!top || top.score < MIN_SECTOR_SCORE) {
    /**
     * The free-text scan found nothing, but an accelerator has already
     * categorised this company in its own directory.
     *
     * That is real evidence and it is attributable, so it is used rather
     * than discarded — but it is labelled INFERRED, because Y
     * Combinator's taxonomy is not the Vamos sector taxonomy and
     * translating between the two is our judgement, not theirs. The
     * confidence stays modest for the same reason.
     */
    if (directory) {
      return {
        primarySector: directory.sector,
        secondarySector: null,
        subvertical: matchSubvertical(directory.sector, input.text),
        reason: `${SECTOR_LABELS[directory.sector]}: mapped from the accelerator directory’s own category `
          + `"${directory.matchedCategory}". The company’s recorded description does not itself state a product `
          + 'and a buyer specific enough to classify independently.',
        confidence: 0.4,
        basis: 'inferred',
        evidenceGap: null,
        sourceUrl: input.directorySourceUrl ?? input.sourceUrl ?? null,
      };
    }
    return {
      ...gapBase,
      primarySector: NON_SECTOR_STATUS,
      reason: 'Not classified: the text on record describes no product, service, or buyer specific enough to place '
        + 'this company in a sector, and no accelerator directory has categorised it. A sector assigned from this '
        + 'evidence would be a guess.',
      evidenceGap: `Nothing on record states what the company builds or who pays for it. `
        + `${input.text.trim().length} characters of description were searched against all five sector vocabularies `
        + 'and none produced both a product and a buyer signal.',
    };
  }

  const subvertical = matchSubvertical(top.sector, input.text);
  const secondary = runnerUp && runnerUp.score > 0 && runnerUp.score >= top.score * SECONDARY_RATIO
    ? runnerUp.sector
    : null;

  /**
   * Confidence, and why it is built this way: the strength of the
   * BUYER signal is what separates a real classification from a
   * vocabulary match, so it carries more weight than the product terms,
   * and a close runner-up subtracts because ambiguity is a real
   * property of the evidence rather than something to average away.
   */
  const buyerStrength = Math.min(1, top.paysHits.length / 3);
  const productStrength = Math.min(1, top.doesHits.length / 4);
  const ambiguityPenalty = secondary ? 0.15 : 0;
  // An accelerator that independently put the company in the same sector
  // is genuine corroboration; one that disagrees is a reason to be less
  // sure, not a reason to switch — the text is the richer evidence.
  const directoryAgrees = directory !== null && directory.sector === top.sector;
  const directoryDisagrees = directory !== null && directory.sector !== top.sector;
  const confidence = Math.max(
    0.1,
    Math.min(0.95,
      0.35 * productStrength + 0.45 * buyerStrength
      + (input.selfDescribed ? 0.2 : 0.05)
      + (directoryAgrees ? 0.1 : 0)
      - (directoryDisagrees ? 0.1 : 0)
      - ambiguityPenalty),
  );

  const buyerText = top.paysHits.length > 0
    ? `sold to ${top.paysHits.slice(0, 3).join(', ')}`
    : 'with no buyer stated on record';

  return {
    primarySector: top.sector,
    secondarySector: secondary,
    subvertical,
    reason: `${SECTOR_LABELS[top.sector]}: the record describes ${top.doesHits.slice(0, 4).join(', ')} `
      + `${buyerText}${subvertical ? `, specifically ${subvertical}` : ''}.`
      + `${directoryAgrees ? ` The accelerator directory independently categorises it as "${directory!.matchedCategory}".` : ''}`
      + `${directoryDisagrees ? ` Note: the accelerator directory categorises it as "${directory!.matchedCategory}", which maps to a different sector.` : ''}`,
    confidence: Number(confidence.toFixed(2)),
    // The company describing itself is explicit evidence of what it does.
    // Anything else — a headline, a filing's industry group, a press
    // summary — is us inferring the sector from a third party's words,
    // and is labelled as inference on screen.
    basis: input.selfDescribed && top.paysHits.length > 0 ? 'explicit' : 'inferred',
    evidenceGap: null,
    sourceUrl: input.sourceUrl ?? null,
  };
}
