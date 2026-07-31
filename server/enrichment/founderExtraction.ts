import { readableText } from '../sourcing/pageSignals';

/**
 * Pulling named people with stated titles out of a public page.
 *
 * Pure functions over an HTML string, so every rule here is testable
 * against real captured pages with no network access — the same shape as
 * sourcing/formd.ts and sourcing/pageSignals.ts.
 *
 * THE BIAS OF THIS MODULE IS TOWARD RETURNING NOTHING.
 *
 * A missing founder is a gap a reviewer fills in ten minutes. A WRONG
 * founder is a false statement naming a private individual, attached to
 * a company they may have no connection to, which then flows into
 * outreach, a CRM, and a partner conversation. The two failures are not
 * symmetric and this module is not tuned as though they were: every rule
 * below requires the page to state the title explicitly, and anything
 * ambiguous is dropped rather than guessed.
 *
 * Specifically NOT done here, on purpose:
 *
 *   - No inference of demographic identity from a name, a photograph, a
 *     language, a geography, or a surname. Not implemented, not
 *     approximated, not left to a caller's discretion. The only route to
 *     a demographic indicator in this codebase remains explicit
 *     self-identification or a verified public statement (see
 *     VerifiedIdentity in src/types.ts).
 *   - No guessing a title. A person listed with no role is returned with
 *     `title: null`, never "Founder".
 *   - No treating an author byline, a testimonial, or an advisor block as
 *     leadership.
 */

/** A person as STATED by a page: a name, and a title only when the page gives one. */
export interface ExtractedPerson {
  fullName: string;
  /** Verbatim from the page. Null when the page names the person without a role. */
  title: string | null;
  /** The surrounding sentence or block, truncated. Untrusted plain text. */
  supportingText: string;
}

/**
 * Titles that indicate a founder or an officer.
 *
 * Ordered longest-first at match time so "Co-Founder & CEO" is captured
 * whole rather than as "Founder". Advisors, investors, and board
 * observers are deliberately absent — a board member is not a founder,
 * and a page that lists both would otherwise hand back the wrong person
 * with full confidence.
 */
const FOUNDER_TITLES = [
  'co-founder & ceo', 'co-founder and ceo', 'cofounder & ceo', 'cofounder and ceo',
  'founder & ceo', 'founder and ceo', 'founder, ceo', 'founder & cto', 'founder and cto',
  'co-founder & cto', 'co-founder and cto', 'founder & coo', 'co-founder & coo',
  'co-founder', 'cofounder', 'founding partner', 'founding engineer', 'founder',
  'chief executive officer', 'chief technology officer', 'chief operating officer',
  'chief scientific officer', 'chief medical officer', 'chief financial officer',
  'chief product officer', 'managing director', 'president', 'ceo', 'cto', 'coo', 'cso', 'cmo', 'cfo',
];

/**
 * Titles that must NOT be read as founder evidence even when they sit
 * next to a name on a team page. Checked before the list above, because
 * "Advisor to the Founder" contains "founder".
 */
const NON_FOUNDER_TITLES = [
  'advisor', 'adviser', 'board member', 'board observer', 'investor', 'mentor',
  'intern', 'contractor', 'consultant', 'emeritus', 'former', 'ex-', 'alumni',
];

/**
 * Words that are never part of a person's name. Marketing pages are full
 * of capitalised phrases that look exactly like names to a regex — "Our
 * Team", "Learn More", "Privacy Policy", "New York" — and every one of
 * them would otherwise be returned as a founder.
 */
const NAME_STOPWORDS = new Set([
  'our', 'team', 'about', 'us', 'the', 'and', 'meet', 'leadership', 'contact', 'careers',
  'privacy', 'policy', 'terms', 'service', 'cookie', 'learn', 'more', 'read', 'get',
  'started', 'sign', 'up', 'log', 'in', 'home', 'blog', 'news', 'press', 'company',
  'product', 'products', 'platform', 'solutions', 'pricing', 'features', 'resources',
  'support', 'help', 'docs', 'documentation', 'api', 'inc', 'llc', 'ltd', 'corp',
  'all', 'rights', 'reserved', 'copyright', 'follow', 'subscribe', 'newsletter',
  'view', 'see', 'join', 'book', 'demo', 'request', 'schedule', 'talk', 'sales',
  'new', 'york', 'san', 'francisco', 'los', 'angeles', 'united', 'states', 'america',

  /**
   * Role and page-structure words.
   *
   * These are here because of a real extraction from aoadx.com/our-team,
   * whose rendered text runs together as
   * "…Alex Fisher Position — Chief Operating Officer & Co-Founder
   * Categories: Leadership Alex…". A pattern that takes capitalised
   * tokens before a separator happily returned the NAME
   * "Co-Founder Alex Fisher Position" — four capitalised tokens, none of
   * them a stopword at the time. The person is real; the name was not.
   *
   * A malformed name is not a cosmetic bug. It is stored as a person,
   * shown as a founder, and matched against other sources, so it
   * corrupts the identity graph rather than merely looking wrong.
   */
  'founder', 'founders', 'cofounder', 'co-founder', 'officer', 'chief', 'president',
  'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cso', 'director', 'manager', 'head', 'vp',
  'partner', 'position', 'categories', 'category', 'role', 'title', 'bio', 'biography',
  'advisor', 'board', 'staff', 'people', 'executive', 'management', 'officers',

  /**
   * Company and legal-entity words.
   *
   * "Startup Co", "Brex Co", "Assort Health Co", and "Walt Disney Studios
   * Co" were all returned as PEOPLE on a live run — two capitalised
   * tokens, no stopword between them, so the name check passed. An
   * organisation stored as a founder is not a cosmetic error: it is
   * asserted on the company record, shown as a verified founder, and
   * matched against other sources under that key.
   */
  'co', 'inc', 'llc', 'ltd', 'lp', 'plc', 'gmbh', 'corp', 'corporation',
  'ventures', 'venture', 'capital', 'partners', 'holdings', 'studios',
  'systems', 'solutions', 'labs', 'lab', 'technologies', 'technology',
  'industries', 'enterprises', 'associates', 'agency', 'foundation',
  'institute', 'university', 'college', 'school', 'startup', 'startups',
]);

/**
 * Does this look like a person's name?
 *
 * Two to four capitalised tokens, no stopwords, no digits, plausible
 * lengths. Deliberately strict: single-token "Alex" is rejected because
 * it cannot be matched to a person across sources, and five-token
 * strings are almost always sentence fragments rather than names.
 *
 * This will reject some real names — mononyms, and names this pattern
 * does not anticipate. That is the correct direction to fail in: the
 * person is then absent from the record, which is honest, rather than
 * present and possibly wrong.
 */
export function looksLikePersonName(raw: string): boolean {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s.length < 4 || s.length > 60) return false;
  if (/\d/.test(s)) return false;
  if (/[@/\\|<>{}()[\]]/.test(s)) return false;

  const tokens = s.split(' ');
  if (tokens.length < 2 || tokens.length > 4) return false;

  for (const t of tokens) {
    const bare = t.replace(/[.,'’-]/g, '');
    if (bare.length === 0) return false;
    if (NAME_STOPWORDS.has(bare.toLowerCase())) return false;
    // Each token starts with an uppercase letter. Particles ("van",
    // "de", "bin") are allowed in non-initial position.
    const isParticle = tokens.indexOf(t) > 0 && /^(van|von|de|del|della|da|di|du|la|le|bin|ibn|al|el|mac|mc|st)$/i.test(bare);
    if (!isParticle && !/^[A-ZÀ-ɏ]/.test(t)) return false;
    // Reject ALL-CAPS runs longer than an initial — those are headings.
    if (bare.length > 3 && bare === bare.toUpperCase() && !/^[A-Z]\.?$/.test(bare)) return false;
  }
  return true;
}

/** Normalise a matched title fragment for comparison. */
function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
}

/** Is this title one we treat as founder/officer evidence? */
export function isFounderTitle(title: string): boolean {
  const t = normTitle(title);
  if (NON_FOUNDER_TITLES.some((n) => t.includes(n))) return false;
  return FOUNDER_TITLES.some((f) => t === f || t.startsWith(`${f} `) || t.endsWith(` ${f}`) || t.includes(f));
}

/**
 * The title pattern, built once from FOUNDER_TITLES sorted longest-first
 * so the most specific title wins.
 */
const TITLE_ALTERNATION = [...FOUNDER_TITLES]
  .sort((a, b) => b.length - a.length)
  .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s&]/g, '[-\\s&]+'))
  .join('|');

/**
 * "Jane Okonkwo, Co-Founder & CEO" / "Jane Okonkwo — Founder".
 *
 * The separator is required. Without it, "Founder Jane Okonkwo joined
 * Acme from…" and "…met founder Jane Okonkwo at a conference" both match,
 * and the second is a third party writing about a person, not a company
 * stating its own leadership.
 */
/**
 * The trailing `{0,40}?` is LAZY, and that matters more than it looks.
 *
 * Greedy, it ran past the end of one person's title and swallowed the
 * next person's name: on a page rendering as "…Jane Okonkwo — Co-Founder
 * & CEO Priya Raman, Chief Technology Officer…", the first match
 * consumed "Co-Founder & CEO Priya Raman, Chief Techno", and Priya was
 * never extracted at all. Silently dropping a real founder from a page
 * that plainly names her is the quieter half of getting founders wrong.
 *
 * The alternation has already captured the full title (it is ordered
 * longest-first), so the lazy tail contributes nothing in the common
 * case and cleanTitle trims whatever it does pick up.
 */
const NAME_THEN_TITLE = new RegExp(
  `([A-Z\\u00C0-\\u024F][\\w'’.-]+(?:\\s+[A-Z\\u00C0-\\u024F][\\w'’.-]+){1,3})`
  // The separator must be punctuation, or a hyphen with SPACE AROUND IT.
  //
  // A bare `-` in this class was splitting "Aidan Ng Co-Founder" into the
  // name "Aidan Ng Co" and the title "Founder" — gluing a fragment of the
  // word "Co-Founder" onto a real person's surname. It produced 19
  // malformed names out of 93 on a live run ("Paul Gross Co", "Ilia
  // Baranov Co"), each of which is a wrong statement about a named
  // individual and would have been matched against other sources under
  // that wrong key.
  + `(?:\\s*[,–—|·:]\\s*|\\s+[-–—]\\s+)`
  + `((?:${TITLE_ALTERNATION})[^.;|\\n]{0,40}?)(?=\\s+[A-Z\\u00C0-\\u024F]|[.;|\\n]|$)`,
  'gi',
);

/** "Founder and CEO Jane Okonkwo" — title first, name after. */
const TITLE_THEN_NAME = new RegExp(
  `\\b((?:${TITLE_ALTERNATION})(?:\\s+(?:and|&)\\s+\\w+)?)\\s*[,:]?\\s+([A-Z\\u00C0-\\u024F][\\w'’.-]+(?:\\s+[A-Z\\u00C0-\\u024F][\\w'’.-]+){1,3})`,
  'g',
);

/**
 * Reduce a run of capitalised tokens to the person's name, or null.
 *
 * The regexes below capture a WINDOW around a separator, and rendered
 * marketing pages routinely put role words, section headings, and the
 * previous person's title inside that window. This takes the trailing
 * two or three tokens — a name sits immediately before its separator —
 * and validates the result. Anything that still fails is discarded.
 *
 * Trailing rather than leading, because "…Categories: Leadership Alex
 * Fisher — COO" has the name at the END of the run, and taking the
 * leading tokens is what produced "Co-Founder Alex Fisher Position".
 */
export function trimToName(run: string): string | null {
  const tokens = run.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  // Try the longest plausible name first so "Maria de la Cruz" survives,
  // then fall back to shorter tails.
  for (const size of [4, 3, 2]) {
    if (tokens.length < size) continue;
    const candidate = tokens.slice(tokens.length - size).join(' ');
    if (looksLikePersonName(candidate)) return candidate;
  }
  return null;
}

/**
 * Cut a captured title at the point it stops being a title.
 *
 * Rendered pages run one person's title straight into the next section
 * ("Chief Operating Officer & Co-Founder Categories: Leadership Alex…"),
 * so the capture window has to be trimmed at the first structural
 * boundary rather than trusted whole. A title stored with another
 * person's name glued to it is a wrong quotation attributed to a real
 * individual.
 */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim().replace(/\s+/g, ' ');
  // Stop at a colon, a bullet, or a sentence end — all section boundaries.
  t = t.split(/[:•·|]/)[0];
  t = t.replace(/\s+(?:Categories|Category|Position|Team|Leadership|About|Bio|Biography)\b.*$/i, '');
  t = t.replace(/[,;\-–—\s]+$/, '').trim();
  if (t.length < 2 || t.length > 80) return null;
  return isFounderTitle(t) ? t : null;
}

/** Trim a supporting quote to something a person can read in a table cell. */
export function truncateSupport(s: string, max = 280): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Extract people with stated founder/officer titles from a page's HTML.
 *
 * Returns at most `limit` people, deduplicated by name, preferring the
 * first (usually most prominent) mention. An empty array is a completely
 * normal and expected result — most pages do not name their leadership,
 * and reporting that honestly is the whole point of this exercise.
 */
export function extractPeopleFromHtml(html: string, limit = 8): ExtractedPerson[] {
  const text = readableText(html);
  const found = new Map<string, ExtractedPerson>();

  const consider = (nameRun: string, titleRun: string, context: string) => {
    // Both halves of the capture are cleaned before either is trusted:
    // a window around a separator is not a name and a title, it is a
    // window that CONTAINS one of each.
    const fullName = trimToName(nameRun);
    if (!fullName) return;
    const title = cleanTitle(titleRun);
    if (!title) return;
    const key = fullName.toLowerCase();
    if (found.has(key)) return;
    found.set(key, { fullName, title, supportingText: truncateSupport(context) });
  };

  for (const m of text.matchAll(NAME_THEN_TITLE)) {
    const start = Math.max(0, (m.index ?? 0) - 60);
    consider(m[1], m[2], text.slice(start, (m.index ?? 0) + m[0].length + 60));
    if (found.size >= limit) break;
  }
  if (found.size < limit) {
    for (const m of text.matchAll(TITLE_THEN_NAME)) {
      const start = Math.max(0, (m.index ?? 0) - 60);
      consider(m[2], m[1], text.slice(start, (m.index ?? 0) + m[0].length + 60));
      if (found.size >= limit) break;
    }
  }
  return [...found.values()].slice(0, limit);
}

/**
 * Candidate paths for the pages that state leadership, in the order they
 * are worth trying. The company's own site is the first source family in
 * the research plan, and these are the pages within it that answer the
 * question.
 *
 * Kept short on purpose: each entry is a real network request against
 * somebody else's server, and a 30-path sweep of every company would be
 * both slow and rude. These eight cover the overwhelming majority of
 * real sites.
 */
export const TEAM_PAGE_PATHS = [
  '/about', '/team', '/about-us', '/our-team', '/leadership', '/company', '/people', '/founders',
] as const;

/**
 * Does a Form D relationship string indicate a founder-adjacent officer?
 *
 * Form D related persons are Executive Officers, Directors, and
 * Promoters. An Executive Officer of a startup is strong evidence of
 * involvement; a Director may be an investor's board seat, which is why
 * the two are scored differently by the caller rather than flattened
 * into "founder" here.
 */
export function classifyFormDRelationship(relationship: string): 'officer' | 'director' | 'promoter' | 'other' {
  const r = relationship.toLowerCase();
  if (r.includes('executive officer') || r.includes('officer')) return 'officer';
  if (r.includes('director')) return 'director';
  if (r.includes('promoter')) return 'promoter';
  return 'other';
}
