import type { WebsiteEvidenceLevel } from '../../shared/qualification';

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
  // Registrar holding pages that never say "for sale". bluecoreenergy.io
  // served exactly "Reserved for bluecoreenergy.io" and nothing else.
  'reserved for', 'this page is parked', 'future home of',
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

// ── Identity: does this page belong to this issuer? ────────────────

/** Strip legal suffixes and punctuation: "Rythm Health, Inc." → "rythmhealth". */
export function domainStemFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|llc|l\.?l\.?c|ltd|limited|co|company|holdings?|group|technologies|technology|labs?|plc|gmbh)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** The distinctive words of a name — legal suffixes and filler removed. */
function distinctiveTokens(name: string): string[] {
  return name.toLowerCase()
    .replace(/\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|company|holdings?|group|plc|gmbh|the|and)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

/**
 * Does this page's TEXT name this company?
 *
 * Content identity: the company's distinctive name tokens appear in the
 * readable text. Lived here rather than in the discovery service because
 * verification asks the identical question and the two answering
 * differently is the whole failure mode this module exists to prevent.
 */
export function pageMentionsCompany(html: string, name: string): boolean {
  const text = readableText(html).toLowerCase();
  const stem = domainStemFromName(name);
  if (stem.length >= 6 && text.replace(/[^a-z0-9]+/g, '').includes(stem)) return true;

  // Fall back to requiring every distinctive word to be present —
  // "Pine Park Health" must find pine, park, health.
  const words = distinctiveTokens(name);
  if (words.length === 0) return false;
  return words.every((w) => text.includes(w));
}

/**
 * Does this URL's HOST belong to this issuer?
 *
 * Structural identity, and the check that was missing. A live run recorded
 * `resiliencemedia.co/agon-emerges-from-stealth-with-30m-.../` as Agon's
 * "official company website" because a funding article linked to it. That
 * page is a media outlet writing ABOUT Agon — it names the company, so a
 * text-only check passes it, and it then counted as web-family
 * corroboration of Agon's own filing. A page about a company is not that
 * company's site, and the tell is in the hostname rather than the prose.
 *
 * Deliberately generous about the exact spelling, because real companies
 * shorten: Venus Aerospace really does live at venusaero.com. Either the
 * host contains a distinctive name token, or one of the two stems contains
 * the other.
 */
export function hostBelongsToIssuer(url: string, name: string): boolean {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Drop www and the public suffix: "www.venusaero.com" → "venusaero".
  const labels = host.replace(/^www\./, '').split('.');
  const hostStem = labels.slice(0, Math.max(1, labels.length - 1)).join('');
  if (!hostStem) return false;

  const stem = domainStemFromName(name);
  if (stem.length >= 4 && (hostStem.includes(stem) || stem.includes(hostStem))) return true;
  return distinctiveTokens(name).some((t) => hostStem.includes(t));
}

// ── Operating substance ───────────────────────────────────────────

/**
 * Telling "this domain exists and belongs to them" apart from "this
 * company describes an actual business".
 *
 * A reachable domain proves a DNS record and a TLS certificate. It does
 * not prove anyone is building anything, and treating the two as the same
 * thing let a Form D plus a bare domain reach
 * `qualified-operating-company` — including AEGIS FINTECH LTD., a $100M
 * offering from an entity with no discoverable product.
 *
 * What counts here is that the issuer ITSELF describes a product, a
 * service, a technology, or an operating business. That is a question
 * about page content, so it is answered from page content: enough readable
 * prose to say something, a descriptive line that is not just the company
 * name, and the structural furniture a real business site has (something
 * to buy or read about, customers, an organisation behind it).
 *
 * No model and no scoring heuristic — a fixed set of signals, so the same
 * page always yields the same verdict and a reviewer can check the working.
 */

/** Minimum readable characters before a page can be called substantive. */
export const SUBSTANTIVE_MIN_CHARS = 500;

/**
 * What the issuer offers. The load-bearing group: a business that sells or
 * builds something says so somewhere on its home page. The other two
 * groups below are recorded for the audit trail but are not required —
 * demanding a careers page or a customer logo wall would reject plenty of
 * real early-stage companies.
 */
const OFFERING_MARKERS = [
  'product', 'products', 'platform', 'pricing', 'plans', 'features', 'solutions',
  'services', 'how it works', 'what we do', 'technology', 'use cases', 'integrations',
  'documentation', 'developers', 'api reference', 'get started', 'book a demo',
  'request a demo', 'schedule a demo', 'start free', 'sign up', 'our software',
  'our platform', 'capabilities',
];
/** Evidence other people use it. */
const TRACTION_MARKERS = [
  'customers', 'case study', 'case studies', 'testimonial', 'trusted by',
  'our clients', 'partners', 'success stories', 'used by',
];
/** Evidence an organisation stands behind it. */
const ORGANISATION_MARKERS = [
  'careers', 'we are hiring', "we're hiring", 'join our team', 'our team', 'about us',
  'leadership', 'contact us', 'privacy policy', 'terms of service', 'blog', 'newsroom',
];

/**
 * A page whose whole content is a corporate holding statement. Real
 * holding companies exist and file Form Ds; they are not venture-stage
 * operating businesses, and their sites say so plainly.
 */
const HOLDING_ONLY_MARKERS = [
  'holding company', 'investment holding', 'holding group', 'special purpose vehicle',
  'asset holding', 'we hold interests', 'portfolio of investments',
];

/** Readable page text: scripts, styles and markup removed. */
export function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39|lt|gt);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A line that says what the company does, as opposed to what it is called.
 *
 * Read from the page TEXT rather than from heading tags, which was the
 * first version and was wrong in both directions. Real sites put their
 * value proposition wherever their framework happens to render it:
 * helmhealth.com's "TPAs and carriers leverage Helm to build Dynamic Copay
 * products for members" sits in a plain div, and ramp.com serves a
 * machine-readable page with no headings at all. Both were reported as
 * describing nothing, which is a false statement about two real companies.
 */
function hasDescriptiveLine(text: string, name: string): boolean {
  const stem = domainStemFromName(name);
  // Sentence-ish fragments. Splitting on terminators AND on the newline-free
  // runs typical of rendered markup, so a nav bar does not read as prose.
  const fragments = text.split(/(?<=[.!?])\s+|[|•·]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  return fragments.some((f) => {
    const words = f.split(/\s+/).filter(Boolean);
    if (words.length < 8) return false;
    // "Acme Robotics Inc." repeated is not a description of anything.
    const withoutName = f.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(stem, '');
    return withoutName.length >= 30;
  });
}

export interface OperatingEvidenceAssessment {
  level: WebsiteEvidenceLevel;
  /** True once we believe the page belongs to this issuer at all. */
  identityConfirmed: boolean;
  /** Which signal groups were found, for the audit trail and the UI. */
  signals: string[];
  /** Readable characters on the page. */
  textLength: number;
  detail: string;
}

/**
 * Judge a fetched page as operating evidence for a named issuer.
 *
 * Pure. The caller does the fetching and decides what a level MEANS for
 * qualification; this only reports what the page is.
 */
export function assessOperatingEvidence(
  html: string,
  companyName: string,
  url: string,
): OperatingEvidenceAssessment {
  const text = readableText(html);
  const textLength = text.length;
  const base = { identityConfirmed: false, signals: [] as string[], textLength };

  // Parking first, exactly as discovery orders it: a registrar page for
  // `lantern.com` contains the word "lantern", so an identity check would
  // pass it.
  if (looksParkedOrPlaceholder(html) || titleIsBareDomain(html)) {
    return { ...base, level: 'parked', detail: 'The page looks like a parked, placeholder, or for-sale domain.' };
  }
  if (isThinPage(html)) {
    return {
      ...base, level: 'thin',
      detail: 'The page responded but served almost no readable text — typically a client-rendered page this '
        + 'checker cannot execute. Not a finding about the business, a finding about the check.',
    };
  }

  const hostMatches = hostBelongsToIssuer(url, companyName);
  const namedOnPage = pageMentionsCompany(html, companyName);
  if (!hostMatches) {
    return {
      ...base, level: 'unrelated',
      detail: `The host of ${url} does not correspond to "${companyName}". `
        + `${namedOnPage ? 'The page names the company, which is what a page ABOUT a company does — that is not the company\'s own site.' : 'The page does not name the company either.'}`,
    };
  }
  if (!namedOnPage) {
    return {
      ...base, level: 'unrelated',
      detail: `The host matches "${companyName}" but the page text never names the company, so it cannot be confirmed as theirs.`,
    };
  }

  const identity = { ...base, identityConfirmed: true };
  const lower = text.toLowerCase();
  const found = (markers: string[]) => markers.filter((m) => lower.includes(m));
  const offering = found(OFFERING_MARKERS);
  const traction = found(TRACTION_MARKERS);
  const organisation = found(ORGANISATION_MARKERS);

  const signals: string[] = [];
  if (offering.length > 0) signals.push(`offering (${offering.slice(0, 4).join(', ')})`);
  if (traction.length > 0) signals.push(`customers (${traction.slice(0, 3).join(', ')})`);
  if (organisation.length > 0) signals.push(`organisation (${organisation.slice(0, 3).join(', ')})`);

  const descriptive = hasDescriptiveLine(text, companyName);
  if (descriptive) signals.push('describes what the company does');

  const holdingOnly = HOLDING_ONLY_MARKERS.some((m) => lower.includes(m)) && offering.length === 0;
  if (holdingOnly) {
    return {
      ...identity, signals, level: 'identity-only',
      detail: 'The page presents a holding or investment vehicle rather than an operating business — '
        + 'it describes no product, service, or technology.',
    };
  }

  // A page with almost nothing on it is a finding: whatever this domain is
  // for, the company is not describing a business on it. theker.ai's
  // "Details remain secured. They will be unveiled only when the time is
  // right." is the honest version of this — a stealth teaser, not a
  // product site.
  if (textLength < SUBSTANTIVE_MIN_CHARS) {
    return {
      ...identity, signals, level: 'identity-only',
      detail: `The site belongs to ${companyName} but carries only ${textLength} readable characters `
        + `(a substantive page has at least ${SUBSTANTIVE_MIN_CHARS}). It establishes who owns the domain and little else.`,
    };
  }

  /**
   * The offering vocabulary is what makes this an operating claim rather
   * than a page. Its absence means one of two quite different things, and
   * conflating them would put a false statement on a real company:
   *
   *   - The page really does not say what the business does.
   *   - The page says plenty, in a language this marker list does not
   *     cover. pascalmedical.com sells surgical lamps and loupes, entirely
   *     in Spanish; every marker here is English.
   *
   * A page with real prose but no recognised offering vocabulary is
   * reported as unread, not as empty, and goes to a human.
   */
  if (offering.length === 0) {
    if (descriptive) {
      return {
        ...identity, signals, level: 'undetermined',
        detail: `The site belongs to ${companyName} and carries ${textLength} readable characters of real prose, `
          + 'but none of the product, service, or technology vocabulary this checker recognises — most often a '
          + 'language it does not cover. Left for a human rather than recorded as an absence.',
      };
    }
    return {
      ...identity, signals, level: 'identity-only',
      detail: `The site belongs to ${companyName} but describes no product, service, or technology, `
        + 'and carries no line saying what the company does.',
    };
  }

  if (!descriptive) {
    return {
      ...identity, signals, level: 'undetermined',
      detail: `The site belongs to ${companyName} and uses product or service vocabulary, but carries no `
        + 'sentence describing the business — typically navigation and labels with the content rendered in the '
        + 'browser. Left for a human rather than counted either way.',
    };
  }

  return {
    ...identity, signals, level: 'substantive',
    detail: `${companyName}'s own site describes an operating business (${textLength} readable characters; ${signals.join('; ')}).`,
  };
}
