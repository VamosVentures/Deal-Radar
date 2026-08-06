import type { DiscoverySourceId } from '../../shared/discovery';
import type { VerticalId } from '../../src/types';

/**
 * Per-vertical, per-source query strategy.
 *
 * The problem this replaces: every adapter was driven by
 * `q.terms[0] ?? q.subcategory ?? q.vertical ?? 'startup'` — so a run
 * targeting Health & Wellness asked the YC directory for "health" and
 * asked SBIR for "health", and both returned whatever a one-word match
 * happened to surface. A single generic word is the worst possible query
 * for precision: it maximises volume and minimises signal, which is
 * exactly backwards for a funnel whose binding constraint is reviewer
 * attention (see MAX_RESULTS_PER_RUN in shared/discovery.ts).
 *
 * What these terms look for instead is EVIDENCE — pilots, contracts,
 * deployments, grants, spinouts, launches, named buyers — because those
 * are the phrases that distinguish a company with a customer from a
 * company with a landing page. Notably absent: "AI startup" and every
 * variant of it. AI is a technology, not a market, and a query for it
 * returns the undifferentiated middle of the funnel.
 *
 * Each source gets its own phrasing because each source indexes
 * different text:
 *   - `yc` matches the directory's own industry tags and one-liners, so
 *     terms are product/market nouns.
 *   - `grants` (SBIR/STTR) indexes award abstracts, so terms are the
 *     technical problem statements those abstracts are written in.
 *   - `research` (arXiv) indexes paper titles/abstracts, so terms are
 *     commercialisation-adjacent research topics.
 *   - `funding-news` / `investor-news` index headlines, so terms are the
 *     things headlines say about early rounds.
 *   - `github` indexes repository topics and descriptions.
 *
 * Nothing here changes what any source is ALLOWED to return, adds a
 * source, or touches rate limits or spend — it only chooses better words
 * for the queries the pipeline was already making.
 */

type SourceTerms = Partial<Record<DiscoverySourceId, string[]>>;

const STRATEGY: Record<VerticalId, SourceTerms> = {
  health: {
    yc: [
      'clinical workflow automation',
      'health system revenue cycle',
      'genomics diagnostics platform',
      'behavioral health infrastructure',
      'care delivery software pilot',
    ],
    grants: [
      'clinical decision support deployment',
      'point of care diagnostic device',
      'remote patient monitoring trial',
      'cancer early detection assay',
    ],
    research: [
      'clinical validation prospective cohort',
      'medical imaging segmentation deployment',
      'digital biomarker validation',
    ],
    'funding-news': [
      'health system pilot seed round',
      'clinical partnership pre-seed',
      'FDA clearance seed funding',
    ],
    'investor-news': ['digital health seed investment', 'healthcare infrastructure pre-seed'],
    github: ['fhir interoperability', 'clinical nlp pipeline'],
  },

  fintech: {
    yc: [
      'payments infrastructure API',
      'embedded lending platform',
      'compliance automation for banks',
      'capital markets workflow software',
      'underwriting data platform',
    ],
    grants: ['financial fraud detection system', 'secure payments infrastructure research'],
    research: ['payment fraud detection production', 'credit risk model fairness'],
    'funding-news': [
      'fintech seed round bank partnership',
      'payments startup pre-seed pilot',
      'lending infrastructure seed contract',
    ],
    'investor-news': ['fintech infrastructure seed investment', 'financial infrastructure pre-seed'],
    github: ['open banking api', 'ledger double entry'],
  },

  fow: {
    yc: [
      'enterprise workflow automation deployment',
      'frontline worker software',
      'developer productivity platform customers',
      'agent infrastructure enterprise',
      'system of record for operations',
    ],
    grants: ['workforce training simulation', 'human machine teaming'],
    research: ['human ai collaboration field study', 'agent evaluation benchmark deployment'],
    'funding-news': [
      'enterprise software seed round customers',
      'workflow automation pre-seed pilot',
      'developer tools seed contract',
    ],
    'investor-news': ['future of work seed investment', 'enterprise workflow pre-seed'],
    github: ['workflow orchestration engine', 'developer tooling platform'],
  },

  sustainability: {
    yc: [
      'grid software utility customers',
      'energy data infrastructure',
      'industrial decarbonization software',
      'circular economy recycling technology',
      'renewable asset operations platform',
    ],
    grants: [
      'grid modernization demonstration',
      'long duration energy storage pilot',
      'industrial process electrification',
      'carbon measurement verification',
    ],
    research: ['grid optimization field deployment', 'battery degradation modeling utility'],
    'funding-news': [
      'climate tech seed round utility pilot',
      'energy software pre-seed contract',
      'decarbonization startup seed customers',
    ],
    'investor-news': ['climate infrastructure seed investment', 'energy transition pre-seed'],
    github: ['grid simulation opendss', 'energy forecasting toolkit'],
  },

  frontier: {
    yc: [
      'warehouse robotics deployment',
      'agricultural robotics field trial',
      'perception software for autonomy',
      'earth observation data platform',
      'satellite ground segment software',
    ],
    grants: [
      'autonomous systems field demonstration',
      'robotic manipulation dexterity',
      'space situational awareness sensor',
      'geospatial analytics defense contract',
    ],
    research: ['robot manipulation real world deployment', 'satellite imagery foundation model'],
    'funding-news': [
      'robotics seed round customer deployment',
      'space startup pre-seed contract',
      'autonomy seed funding pilot',
    ],
    'investor-news': ['robotics seed investment', 'space infrastructure pre-seed'],
    github: ['ros2 manipulation stack', 'satellite telemetry processing'],
  },
};

/**
 * The search terms for one (vertical, source) pair, best-first.
 *
 * Returns an empty array when the strategy has nothing specific to say —
 * callers fall back to their existing behaviour rather than being handed
 * a guess. An explicit user-supplied term always wins over this table;
 * this is a better DEFAULT, not an override of what a human asked for.
 */
export function queryTermsFor(vertical: VerticalId | null, sourceId: DiscoverySourceId): string[] {
  if (!vertical) return [];
  return STRATEGY[vertical]?.[sourceId] ?? [];
}

/**
 * Resolve the single term an adapter should search, honouring precedence:
 * an explicit user term, then the vertical/source strategy, then the
 * caller's own fallback. Adapters that issue one query per run use this.
 */
export function resolveQueryTerm(
  userTerms: string[],
  vertical: VerticalId | null,
  sourceId: DiscoverySourceId,
  fallback: string,
): string {
  if (userTerms.length > 0) return userTerms[0];
  const strategy = queryTermsFor(vertical, sourceId);
  return strategy[0] ?? fallback;
}

/** Every vertical/source pair the strategy covers — used by tests and reporting. */
export function strategyCoverage(): { vertical: VerticalId; sources: DiscoverySourceId[] }[] {
  return (Object.keys(STRATEGY) as VerticalId[]).map((v) => ({
    vertical: v,
    sources: Object.keys(STRATEGY[v]) as DiscoverySourceId[],
  }));
}
