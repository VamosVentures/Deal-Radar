/**
 * Founder contact details: an email address and a LinkedIn profile.
 *
 * Deal Radar used to throw these away at every step — research parsed
 * LinkedIn links off YC profiles and dropped them, the email/spreadsheet
 * extraction had no field for them, the founders table's `email` and
 * `linkedin` columns were never written, and anything a reviewer typed
 * into the "Add to HubSpot" popup went to HubSpot and nowhere else
 * (Andrew, 2026-11-19).
 *
 * The rule for every path that now keeps them: a contact detail is
 * recorded only when a source STATES it, and always with where it came
 * from. Nothing here guesses an address (no "firstname@domain"), and a
 * value that does not look like a real address or profile is dropped
 * rather than stored — a wrong email on a named person is worse than
 * none, because it flows into HubSpot and outreach.
 */

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A plausible single email address, lower-cased; null for anything else. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^mailto:/i, '').toLowerCase();
  if (v.length > 254 || !EMAIL.test(v)) return null;
  return v;
}

/**
 * A personal LinkedIn profile URL in canonical form
 * (https://www.linkedin.com/in/<slug>); null for anything else — company
 * pages, posts, search URLs, and other sites are all rejected. Accepts a
 * missing scheme or "www", country subdomains, and trailing paths/queries.
 */
export function normalizeLinkedInUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try { url = new URL(v); } catch { return null; }
  if (!/^([a-z]{2,3}\.|www\.)?linkedin\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/in\/([^/]+)\/?/i);
  if (!m) return null;
  let slug: string;
  try { slug = decodeURIComponent(m[1]); } catch { return null; }
  if (!/^[\p{L}\p{N}_-]{3,100}$/u.test(slug)) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

/** Lower-case ASCII name tokens: "José  O'Neil-Ruiz" → ["jose", "oneil", "ruiz"]. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Does this LinkedIn profile's URL name this person? Both the first and
 * the last name must appear in the slug ("/in/jane-doe-4a1b" for Jane
 * Doe). Used where a page links a profile but does not tie it to a name
 * in a way a text reader can trust — the slug is the tie.
 */
export function linkedInMatchesName(url: string, name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return false;
  const slug = decodeURIComponent(url.replace(/^.*\/in\//, '').replace(/\/.*$/, ''))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return slug.includes(tokens[0]) && slug.includes(tokens[tokens.length - 1]);
}

/**
 * Is this a published address for THIS person at THIS company? The domain
 * must be the company's own, and the local part must be one of the usual
 * shapes of the person's name (jane, jane.doe, jane_doe, janedoe, jdoe,
 * j.doe). A generic inbox (hello@, info@, founders@) never matches, so it
 * is never attached to a named founder.
 */
export function emailMatchesName(email: string, name: string, companyDomain: string | null | undefined): boolean {
  if (!companyDomain) return false;
  const [local, domain] = email.toLowerCase().split('@');
  const bare = (d: string) => d.replace(/^www\./, '');
  if (!domain || bare(domain) !== bare(companyDomain.toLowerCase())) return false;
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  const shapes = new Set([first]);
  if (last) {
    for (const sep of ['', '.', '_', '-']) {
      shapes.add(`${first}${sep}${last}`);
      shapes.add(`${first[0]}${sep}${last}`);
    }
  }
  return shapes.has(local);
}
