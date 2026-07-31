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
