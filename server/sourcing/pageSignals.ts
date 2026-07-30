/**
 * Telling a real company site apart from a page that merely responds.
 *
 * A 200 is not evidence. Registrar parking pages, "coming soon"
 * placeholders, and for-sale listings all return 200, and many of them
 * contain the very word being searched for — a parked bespoke.com
 * contains "bespoke", so a name-on-page check passes and a domain nobody
 * owns gets recorded as a company's official website.
 *
 * This module exists so the two places that ask the question — website
 * DISCOVERY (services/corroborate.ts, services/fundingNews.ts) and
 * website VERIFICATION (services/issuerQualification.ts) — cannot answer
 * it differently. Discovery previously had no parked check at all, which
 * is how a dry run proposed bespoke.com ("BESPOKE.COM - For Sale") for
 * Bespoke Labs and fervoenergy.io ("Coming Soon") for Fervo Energy.
 *
 * Pure functions, no network.
 */

export const PARKED_MARKERS = [
  'domain is for sale', 'buy this domain', 'parked domain', 'godaddy.com/domainfind',
  'this domain may be for sale', 'coming soon', 'under construction',
  'default web page', 'welcome to nginx', 'apache2 default',
  // Registrar and marketplace listings. Written against the real pages a
  // live run hit, not imagined: "BESPOKE.COM - For Sale" matched none of
  // the markers above.
  'is for sale', 'domain for sale', 'make an offer', 'inquire about this domain',
  'this domain is available', 'buy now for', 'dan.com', 'sedo.com',
  'afternic', 'hugedomains', 'domain parking', 'checking your browser',
];

/** Does this page look like parking, a placeholder, or a for-sale listing? */
export function looksParkedOrPlaceholder(html: string): boolean {
  const lower = html.slice(0, 20_000).toLowerCase();
  return PARKED_MARKERS.some((m) => lower.includes(m));
}

/**
 * A page that responded but served almost no readable text — typically a
 * client-rendered app. Deliberately distinct from "parked": one is an
 * absence of evidence, the other is an accusation, and reporting the
 * wrong one states something false about a real business.
 */
export function isThinPage(html: string, minChars = 200): boolean {
  return html.replace(/<[^>]*>/g, '').trim().length < minChars;
}

/**
 * A page whose only visible title is its own domain name.
 *
 * Parking services vary too much to enumerate, but nearly all of them
 * share this tell: `<title>lantern.com</title>`. A real business titles
 * its home page after itself, not after its DNS record.
 */
export function titleIsBareDomain(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim().toLowerCase();
  if (!title) return false;
  return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?$/.test(title);
}

/**
 * The single question website discovery needs answered: may this page be
 * recorded as a company's official site?
 *
 * Returns the reason it may NOT be, or null when it may — so a caller
 * can report the specific finding rather than a bare false.
 */
export function pageDisqualifiedAsOfficialSite(html: string): string | null {
  if (isThinPage(html)) return 'the page served almost no readable text';
  if (looksParkedOrPlaceholder(html)) return 'the page looks like a parked, placeholder, or for-sale domain';
  if (titleIsBareDomain(html)) return 'the page title is just the domain name, which is how parking pages present themselves';
  return null;
}
