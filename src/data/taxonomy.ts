import { VERTICAL_ID_VALUES, type VerticalId } from '../types';

export interface Vertical {
  id: VerticalId;
  name: string;
  short: string;
  core: boolean;
  description: string;
  subcategories: { name: string; exception?: string }[];
}

/**
 * The five Marcos-approved investment verticals — the ONE canonical
 * configuration every consumer (sidebar, All Deals filters, vertical
 * pages, Overview KPI breakdowns, Cumulative filters, discovery/
 * enrichment classification, scoring, imports/exports, fixtures, tests)
 * derives from. Nothing else declares its own copy of this list.
 *
 * Frontier absorbs the old Robotics and Space Tech sectors — both were
 * physical/hard-tech categories the firm reviews the same way, and
 * splitting them served no distinct investment thesis. General AI was
 * retired as a standalone vertical: AI is a technology, not a market,
 * so what used to be classified 'ai' is reassigned to whichever market
 * it actually serves (health/fintech/sustainability/frontier), with
 * genuinely horizontal AI defaulting to Future of Work. See
 * LEGACY_VERTICAL_ALIASES / normalizeVerticalId below for how old
 * stored values (robotics, spacetech, space-tech, ai) map onto this
 * list, and server/db/migrations.ts version 15 for the one-time data
 * migration and its per-company AI-reassignment audit trail.
 *
 * `core` is kept (rather than removed) because CORE_VERTICAL_IDS is
 * still the name every KPI/breakdown consumer imports — it is simply
 * true for all five now that the non-core `aoi` catch-all is retired
 * from the user-facing taxonomy. A stray legacy value on an old row
 * (there should be none post-migration) still folds safely into
 * "Unassigned" wherever breakdowns are computed, exactly as `aoi` did
 * before this change.
 */
export const VERTICALS: Vertical[] = [
  {
    id: 'health',
    name: 'Health & Wellness',
    short: 'Health',
    core: true,
    description:
      'Technology-enabled care, prevention, and the infrastructure behind it.',
    subcategories: [
      { name: 'Personalized care (AI / tech-enabled)' },
      { name: 'Cancer' },
      { name: 'Brain health' },
      { name: 'Longevity' },
      { name: 'Genomics & personalized medicine' },
      { name: "Women's health" },
      { name: 'Healthcare infrastructure' },
      { name: 'Healthcare finance' },
      { name: 'Healthcare workforce technology' },
    ],
  },
  {
    id: 'fintech',
    name: 'FinTech',
    short: 'FinTech',
    core: true,
    description:
      'Financial infrastructure, access, and wealth-building for the next generation of customers.',
    subcategories: [
      { name: 'New financial infrastructure' },
      { name: 'Payments' },
      { name: 'Wealth & capital markets' },
      { name: 'Investing' },
      { name: 'Wealth planning' },
      { name: 'Access to capital' },
      {
        name: 'DeFi & blockchain',
        exception:
          'Adjacent / exception category — may conflict with current firm exclusions. Flag for partner review; do not auto-reject.',
      },
    ],
  },
  {
    id: 'fow',
    name: 'Future of Work',
    short: 'Work',
    core: true,
    description:
      'How people and AI systems work together, and the tools that make work better. Also the default home for horizontal, not-market-specific AI — enterprise, workflow, workforce, and productivity tooling that happens to be built on AI, rather than a market of its own.',
    subcategories: [
      { name: 'Human-AI collaboration' },
      { name: 'AI-native work platforms' },
      { name: 'AI copilots' },
      { name: 'Autonomous agents' },
      { name: 'Human-centered automation' },
      { name: 'Next-generation work infrastructure' },
      { name: 'Workflow & collaboration tools' },
      { name: 'Frontline & essential-worker technology' },
      { name: 'Creator & microbusiness enablement' },
      { name: 'Horizontal / general-purpose AI infrastructure & tooling' },
    ],
  },
  {
    id: 'sustainability',
    name: 'Sustainability',
    short: 'Sustain',
    core: true,
    description:
      'Energy transition software and digital infrastructure for a decarbonizing grid.',
    subcategories: [
      { name: 'Renewable energy' },
      { name: 'Nuclear energy' },
      { name: 'Hydrogen' },
      { name: 'Geothermal' },
      { name: 'Digital energy infrastructure' },
      { name: 'Energy & operations optimization' },
      { name: 'Smart grids' },
      { name: 'Renewable-energy digital infrastructure' },
    ],
  },
  {
    id: 'frontier',
    name: 'Frontier',
    short: 'Frontier',
    core: true,
    description:
      'Physical automation and space infrastructure — robotics and space tech, combined into one hard-tech sector rather than reviewed as two.',
    subcategories: [
      { name: 'Industrial & warehouse automation' },
      { name: 'Field & agricultural robotics' },
      { name: 'Healthcare & surgical robotics' },
      { name: 'Robotics software & simulation' },
      { name: 'Perception & control systems' },
      {
        name: 'Humanoid & general-purpose robots',
        exception:
          'Typically hardware-heavy — flag for partner review under the hardware-heavy policy exception; never auto-reject.',
      },
      { name: 'Earth observation & geospatial data' },
      { name: 'Satellite communications' },
      { name: 'Ground-segment & mission software' },
      { name: 'Space situational awareness' },
      {
        name: 'Launch & in-space hardware',
        exception:
          'Typically hardware-heavy and capital-intensive — flag for partner review under the hardware-heavy policy exception; never auto-reject.',
      },
    ],
  },
];

/**
 * Look up a vertical's display metadata.
 *
 * The non-null assertion this used to carry was a latent crash rather
 * than a guarantee. `ImportedCompany.vertical` is cast straight out of
 * the database row with no validation
 * (server/db/repos/companies.ts — `row.vertical as ...`), and migration
 * 15 deliberately leaves the legacy 'aoi' catch-all in place rather than
 * forcing those rows into one of the five. So a value outside the five
 * is reachable by design, and `VERTICALS.find(...)!.name` on it is a
 * TypeError in the middle of rendering a company row — the whole table
 * blanks out because one record holds an old string.
 *
 * A legacy value now resolves through the alias table, and anything
 * genuinely unrecognized returns an explicit "Unassigned" placeholder.
 * Callers that already guard with `?.name ?? …` are unaffected; the ones
 * that dereference directly stop being crash sites. The placeholder is
 * NOT added to VERTICALS, so it can never appear as a sixth vertical in
 * a filter, a breakdown, or a chart.
 */
const UNASSIGNED_VERTICAL: Vertical = {
  id: 'unassigned' as VerticalId,
  name: 'Unassigned',
  short: 'Unassigned',
  core: false,
  description:
    'No approved vertical is recorded for this company. Legacy or unrecognized stored value — '
    + 'needs classification before it can be reviewed as part of a sector.',
  subcategories: [],
};

export const verticalById = (id: VerticalId | string): Vertical => {
  const direct = VERTICALS.find((v) => v.id === id);
  if (direct) return direct;
  const normalized = normalizeVerticalId(typeof id === 'string' ? id : null);
  return (normalized && VERTICALS.find((v) => v.id === normalized)) || UNASSIGNED_VERTICAL;
};

/**
 * Legacy stored/raw values that map onto one of the five approved
 * verticals, keyed by lowercased, hyphen/space-insensitive form.
 * 'space-tech' and 'space_tech' are historical spelling variants seen in
 * older imports/exports; 'ai' is deliberately absent here because
 * reassigning an AI company is a per-company evidence judgment (see
 * migration 15's audit trail), not a blind alias — normalizeVerticalId
 * below falls back to 'fow' for 'ai' ONLY as the generic default the
 * task specifies for genuinely horizontal AI, never as a substitute for
 * that per-company review.
 */
export const LEGACY_VERTICAL_ALIASES: Record<string, VerticalId> = {
  robotics: 'frontier',
  spacetech: 'frontier',
  'space-tech': 'frontier',
  space_tech: 'frontier',
  'space tech': 'frontier',
  ai: 'fow',
};

/**
 * Normalize any raw stored/imported string to one of the five canonical
 * vertical ids, or null when it cannot be recognized at all (e.g. the
 * legacy 'aoi' catch-all, or genuine garbage) — callers fold a null into
 * their own "Unassigned" bucket rather than guessing. Case- and
 * whitespace-insensitive so historical spelling drift normalizes too.
 */
export function normalizeVerticalId(raw: string | null | undefined): VerticalId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if ((VERTICAL_ID_VALUES as readonly string[]).includes(key)) return key as VerticalId;
  return LEGACY_VERTICAL_ALIASES[key] ?? null;
}

/**
 * Read a `?vertical=` query parameter into canonical vertical ids.
 *
 * Lives here, next to the alias table it depends on, rather than in the
 * All Deals page: it is taxonomy logic, the server tests need it, and a
 * `.tsx` module cannot be imported from a server test (no `--jsx` in the
 * server tsconfig).
 *
 * Two defects lived in passing this parameter through raw:
 *
 *  - A legacy bookmark like `/companies?vertical=ai` (or `robotics`,
 *    `spacetech`, `aoi`) seeded the table's filter with a string no
 *    company row can hold post-migration. The result was an empty table
 *    with NO vertical chip highlighted and "All verticals" not
 *    highlighted either — which reads as a broken page rather than as a
 *    filter. The requirement is that old links resolve SAFELY, and
 *    `normalizeVerticalId` already existed for exactly this; it simply
 *    was never called from the client.
 *  - Only one vertical could be expressed, so a multi-vertical selection
 *    could not be linked to or restored. A comma-separated list is
 *    accepted so the multi-vertical view the table already supports is
 *    shareable.
 *
 * An unrecognized value is DROPPED rather than kept: falling back to the
 * unfiltered All Deals view shows real deals, where an unmatchable filter
 * shows nothing and explains nothing.
 */
export function verticalsFromParam(raw: string | null | undefined): VerticalId[] {
  if (!raw) return [];
  const seen = new Set<VerticalId>();
  for (const part of raw.split(',')) {
    const id = normalizeVerticalId(part);
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * Single source of truth for "what sectors exist", in canonical display
 * order. Before this existed, the same list was hand-copied into the
 * Discovery page, the Schedule editor, the Connectors panel, and the
 * Stealth Radar filter — five copies that had to be kept in sync by
 * hand. Derive from these instead of writing another literal list.
 */
export const VERTICAL_IDS: VerticalId[] = VERTICALS.map((v) => v.id);

/** The approved core investment sectors — all five; see header comment. */
export const CORE_VERTICAL_IDS: VerticalId[] = VERTICALS.filter((v) => v.core).map((v) => v.id);

/** `{ id, name }` pairs for rendering a <select>, in canonical order. */
export const VERTICAL_OPTIONS: { id: VerticalId; name: string }[] =
  VERTICALS.map((v) => ({ id: v.id, name: v.name }));

export const PREFERRED_STATES = ['NM', 'NY', 'NJ', 'OR', 'CA', 'TX', 'IL'];
