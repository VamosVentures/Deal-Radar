/**
 * Company facts read out of text we already fetched.
 *
 * The SEC Form D states an issuer's address, so the 62 SEC-sourced
 * companies got a location for free. The other 147 did not, and the
 * dashboard showed "??" for 61% of the portfolio while the fit score
 * excluded the geography component for the same records — a gap in our
 * plumbing being displayed as a gap in the evidence.
 *
 * These functions read the company's own site text and the funding
 * coverage already on file. Pure, so every rule is testable against
 * captured text with no network access.
 *
 * THE BIAS IS TOWARD RETURNING NULL. A wrong headquarters sends a
 * partner to the wrong city and quietly changes a thesis-fit score,
 * because geography is a scored component. Every extractor below
 * requires an explicit cue — "based in", "headquartered in", a postal
 * address — and returns null when it only has a bare place name.
 */

/** US states and DC, by full name, mapped to the two-letter code stored on the row. */
const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

const STATE_CODES = new Set(Object.values(US_STATES));

/**
 * Cities whose name alone implies the state in ordinary business prose.
 *
 * Deliberately short. It exists for the very common "San Francisco-based"
 * and "NYC-based" constructions, where demanding an explicit state would
 * reject the clearest possible statement of location. Anything not on
 * this list needs its state spelled out.
 */
const IMPLIED_CITY_STATE: Record<string, { city: string; state: string }> = {
  'san francisco': { city: 'San Francisco', state: 'CA' },
  sf: { city: 'San Francisco', state: 'CA' },
  'new york': { city: 'New York', state: 'NY' },
  nyc: { city: 'New York', state: 'NY' },
  'new york city': { city: 'New York', state: 'NY' },
  brooklyn: { city: 'Brooklyn', state: 'NY' },
  boston: { city: 'Boston', state: 'MA' },
  cambridge: { city: 'Cambridge', state: 'MA' },
  chicago: { city: 'Chicago', state: 'IL' },
  seattle: { city: 'Seattle', state: 'WA' },
  austin: { city: 'Austin', state: 'TX' },
  denver: { city: 'Denver', state: 'CO' },
  'los angeles': { city: 'Los Angeles', state: 'CA' },
  la: { city: 'Los Angeles', state: 'CA' },
  'palo alto': { city: 'Palo Alto', state: 'CA' },
  'mountain view': { city: 'Mountain View', state: 'CA' },
  'menlo park': { city: 'Menlo Park', state: 'CA' },
  oakland: { city: 'Oakland', state: 'CA' },
  'san diego': { city: 'San Diego', state: 'CA' },
  'san jose': { city: 'San Jose', state: 'CA' },
  atlanta: { city: 'Atlanta', state: 'GA' },
  miami: { city: 'Miami', state: 'FL' },
  philadelphia: { city: 'Philadelphia', state: 'PA' },
  pittsburgh: { city: 'Pittsburgh', state: 'PA' },
  portland: { city: 'Portland', state: 'OR' },
  'salt lake city': { city: 'Salt Lake City', state: 'UT' },
  nashville: { city: 'Nashville', state: 'TN' },
  detroit: { city: 'Detroit', state: 'MI' },
  houston: { city: 'Houston', state: 'TX' },
  dallas: { city: 'Dallas', state: 'TX' },
  phoenix: { city: 'Phoenix', state: 'AZ' },
  'washington dc': { city: 'Washington', state: 'DC' },
};

/**
 * Resolve a directory-style location string into a city and, when it is
 * a US location, a state.
 *
 * The Y Combinator API returns "San Francisco" — a city with no state —
 * for most of its portfolio. Requiring an explicit state discarded every
 * one of those, which is why a lookup that was hitting on 8 of 8
 * companies changed nothing.
 *
 * Foreign locations ("London", "Barcelona, Spain") return a city and a
 * NULL state on purpose. The state column holds a two-letter US code, and
 * there is no honest value to put there for a London company — recording
 * the city is a real fact, and inventing a state to fill the column
 * would not be.
 */
export function resolveCityState(raw: string): { city: string; state: string | null } | null {
  const loc = raw.trim().replace(/\s+/g, ' ');
  if (!loc) return null;

  const parts = loc.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const state = normalizeState(parts[1]);
    // "Barcelona, Spain" — a real city, not a US state.
    return { city: titleCase(parts[0]), state };
  }

  const implied = IMPLIED_CITY_STATE[loc.toLowerCase()];
  if (implied) return { city: implied.city, state: implied.state };
  // A bare city we do not recognise. Still a fact worth recording.
  return { city: titleCase(loc), state: null };
}

export interface ExtractedLocation {
  city: string;
  state: string;
  /** The phrase the location was read from, for the audit trail. */
  evidence: string;
}

/** Title-case a captured city so "san francisco" is stored as "San Francisco". */
function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length <= 2 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * The cue words that make a place name a statement about THIS company.
 *
 * Without one of these, "we serve customers in Chicago" would set the
 * headquarters to Chicago.
 */
const LOCATION_CUES = String.raw`(?:head[- ]?quarter(?:ed|s)?(?:\s+in)?|based\s+in|located\s+in|offices?\s+in|hq(?:\s+in)?)`;

/**
 * Read a US headquarters out of prose.
 *
 * Four accepted shapes, all requiring an explicit cue or a postal form:
 *
 *   "headquartered in Austin, TX"        cue + City, ST
 *   "based in Austin, Texas"             cue + City, State
 *   "San Francisco-based"                well-known city + "-based"
 *   "1 Main St, Austin, TX 78701"        postal address
 */
export function extractLocation(text: string): ExtractedLocation | null {
  const clean = text.replace(/\s+/g, ' ');

  // 1. Cue + "City, ST" or "City, State".
  const cued = new RegExp(
    `${LOCATION_CUES}\\s+([A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,2}),\\s*([A-Za-z .]{2,20})\\b`,
    'i',
  ).exec(clean);
  if (cued) {
    const state = normalizeState(cued[2]);
    if (state) return { city: titleCase(cued[1]), state, evidence: cued[0].trim() };
  }

  // 2. Postal address: "…, Austin, TX 78701".
  const postal = /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?/.exec(clean);
  if (postal && STATE_CODES.has(postal[2])) {
    return { city: titleCase(postal[1]), state: postal[2], evidence: postal[0].trim() };
  }

  // 3. "<Well-known city>-based" / "<city> based".
  const based = /\b([A-Za-z][A-Za-z .]{1,22}?)[-\s]based\b/i.exec(clean);
  if (based) {
    const hit = IMPLIED_CITY_STATE[based[1].trim().toLowerCase()];
    if (hit) return { city: hit.city, state: hit.state, evidence: based[0].trim() };
  }

  // 4. Cue + a well-known city with no state.
  const cuedCity = new RegExp(`${LOCATION_CUES}\\s+([A-Za-z][A-Za-z .]{1,22}?)(?:[.,;]|\\s+and\\b|$)`, 'i').exec(clean);
  if (cuedCity) {
    const hit = IMPLIED_CITY_STATE[cuedCity[1].trim().toLowerCase()];
    if (hit) return { city: hit.city, state: hit.state, evidence: cuedCity[0].trim() };
  }

  return null;
}

/** "TX" / "Texas" / "texas" → "TX". Null for anything not a US state. */
export function normalizeState(raw: string): string | null {
  const s = raw.trim().replace(/\.$/, '');
  if (/^[A-Za-z]{2}$/.test(s) && STATE_CODES.has(s.toUpperCase())) return s.toUpperCase();
  return US_STATES[s.toLowerCase()] ?? null;
}

/**
 * A one-line description of what the company does, taken from its own
 * site.
 *
 * Used only where the stored one-liner is a placeholder. The company
 * describing itself is the best available source for this, and it is the
 * same text the sector classifier already reads.
 */
export function extractDescription(siteText: string, companyName: string): string | null {
  const clean = siteText.replace(/\s+/g, ' ').trim();
  if (clean.length < 40) return null;

  const stem = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sentences = clean.split(/(?<=[.!?])\s+/);

  for (const raw of sentences) {
    const sentence = raw.trim();
    const words = sentence.split(/\s+/).filter(Boolean);
    // Long enough to say something, short enough to be a summary rather
    // than a paragraph that happens to lack punctuation.
    if (words.length < 6 || words.length > 45) continue;
    if (sentence.length > 300) continue;
    // Navigation and legal boilerplate are not descriptions.
    if (/cookie|privacy policy|terms of service|all rights reserved|sign in|log in|subscribe/i.test(sentence)) continue;
    // A line that is only the company's own name says nothing.
    const withoutName = sentence.toLowerCase().replace(/[^a-z0-9]/g, '').replace(stem, '');
    if (withoutName.length < 30) continue;
    return sentence;
  }
  return null;
}

// ── Funding, read from the full article rather than a summary ─────

/**
 * A raise, extracted from press or investor text.
 *
 * WHY THIS IS SO NARROW
 *
 * A measurement across the live portfolio found that of 122 companies
 * with no funding on record, only three had a money figure with any
 * raise-adjacent word near it — and two of those three were not raises:
 *
 *   "$15B+ annually on symptom management"           market size
 *   "$86.1 million in binding commercial contracts"  revenue
 *
 * A money-plus-keyword extractor would have been wrong twice for every
 * once it was right, writing a market-size figure into a column labelled
 * "funding raised". That is worse than the blank it replaces, because a
 * reviewer can see a blank and cannot see a fabrication.
 *
 * So: the amount and the raise verb must sit in the same sentence and
 * within a few words of each other, and a set of look-alike
 * constructions is excluded outright.
 */
export interface ExtractedFunding {
  /** Display text, e.g. "$12.5M Series A". */
  amountText: string;
  /** The round name when the same sentence states one, else null. */
  roundType: string | null;
  /** The sentence it came from, for the audit trail. */
  evidence: string;
}

/** Money the company RECEIVED. "Valued at" and "manages" are not raises. */
const RAISE_VERB = String.raw`(?:rais(?:e[sd]?|ing)|secur(?:e[sd]|ing)|clos(?:e[sd]|ing)|land(?:e[sd]|ing)|nett(?:e[sd])|announc(?:e[sd]|ing)\s+(?:a|an|its))`;

const MONEY_SRC = String.raw`\$\s?\d[\d.,]*\s*(?:million|billion|[MBK])\b`;

/**
 * Constructions that contain money and a plausible verb but are not a
 * raise. Every entry here was observed in the live corpus or is a direct
 * near-miss of one.
 */
const NOT_A_RAISE: RegExp[] = [
  /\bannually\b/i, /\ba year\b/i, /\bmarket\b/i, /\bTAM\b/, /\bindustry\b/i,
  /\bcontracts?\b/i, /\brevenue\b/i, /\bARR\b/, /\bsaves?\b/i, /\bsavings\b/i,
  /\bspend(?:ing|s)?\b/i, /\bcosts?\b/i, /\bvalu(?:ation|ed)\b/i,
  /\bassets under management\b/i, /\bAUM\b/, /\bfund\s+(?:size|of)\b/i,
  /\bmanages?\b/i, /\bportfolio of\b/i, /\bworth\b/i, /\bdeal size\b/i,
];

const ROUND_NAME = /\b(pre-?seed|seed|series\s+[a-e](?:-\d)?|bridge|growth|strategic)\b/i;

/** "$ 12.5 million" → "$12.5M". */
function tidyMoney(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*million\b/i, 'M')
    .replace(/\s*billion\b/i, 'B')
    .replace(/\$\s+/, '$');
}

/**
 * Distinctive words of a company name — legal suffixes and filler out.
 * "Antares Industries, Inc." → ["antares", "industries"].
 */
function nameTokens(name: string): string[] {
  return name.toLowerCase()
    .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|holdings?|group|the|and)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

/**
 * Read a raise out of text, requiring the sentence to name THIS company.
 *
 * The name requirement is not belt-and-braces; it is the whole
 * correctness property. A first version without it wrote two wrong
 * values out of six on the live corpus, and both were the same failure —
 * a funding article naming somebody else's round:
 *
 *   Antares ← "In April, X-energy raised $1 billion through an IPO"
 *   Agon    ← a sentence about UK MoD procurement friction
 *
 * An article about a funding event routinely lists comparable rounds,
 * investor portfolios, and market context. Money in the same document is
 * not money raised by the subject of the document, in exactly the way a
 * person named on a page is not that page's founder.
 */
export function extractFunding(text: string, companyName: string): ExtractedFunding | null {
  const clean = text.replace(/\s+/g, ' ');
  const tokens = nameTokens(companyName);
  // A company whose name has no distinctive token cannot be tied to a
  // sentence, so no amount may be attributed to it from prose.
  if (tokens.length === 0) return null;

  // Sentence-scoped: a verb three paragraphs from a number says nothing
  // about that number.
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > 400) continue;
    if (NOT_A_RAISE.some((p) => p.test(sentence))) continue;

    // The sentence must name this company. Without it, the extractor
    // happily reports a competitor's round as our company's.
    const lower = sentence.toLowerCase();
    if (!tokens.some((t) => lower.includes(t))) continue;

    // Verb and amount adjacent, in either order: "raised $12M" or
    // "$12M was raised".
    const forward = new RegExp(`${RAISE_VERB}[^.]{0,40}?(${MONEY_SRC})`, 'i').exec(sentence);
    const backward = new RegExp(`(${MONEY_SRC})[^.]{0,30}?${RAISE_VERB}`, 'i').exec(sentence);
    const hit = forward ?? backward;
    if (!hit) continue;

    const amount = tidyMoney(hit[1]);
    const round = ROUND_NAME.exec(sentence);
    const roundType = round ? titleCase(round[1]) : null;
    return {
      amountText: roundType ? `${amount} ${roundType}` : amount,
      roundType,
      evidence: sentence.trim().slice(0, 240),
    };
  }
  return null;
}
