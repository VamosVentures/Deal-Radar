import { getCompany, applyFieldUpdate } from '../db/repos/companies';
import { addDealEvidence, listDealEvidence } from '../db/repos/opportunities';
import { politeFetch } from '../sourcing/politeness';
import { isSafeExternalUrlResolved } from '../lib/http';
import { normalizeCompanyKey, isHighConfidenceFuzzy } from '../sourcing/identity';
import { isAmbiguousCompanyName } from '../sourcing/classify';
import { domainStemFromName, pageDisqualifiedAsOfficialSite, pageMentionsCompany } from '../sourcing/pageSignals';
import { batchToApproxDate } from '../sourcing/adapters/ycombinator';
import { tierOf, familyOf } from '../../shared/opportunity';
import type { DealEvidence } from '../../shared/opportunity';

/**
 * Actively looking for a SECOND, independent source for a company we
 * already know about.
 *
 * This is the capability the pipeline was missing. Sourcing ran each
 * adapter separately and stored whatever each returned, so every company
 * ended up with evidence from exactly ONE source family — 176 out of 176.
 * Under the (correct) rule that a live opportunity needs two independent
 * sources, that meant nothing could ever qualify. The gap was not the
 * rule; it was that nobody ever went looking.
 *
 * So: given a company we found via SEC, ask the accelerator directory and
 * the funding press whether they know it too. A match is real
 * corroboration — a different organisation, with a different reason to
 * publish, describing the same company.
 *
 * Matching is deliberately strict. A false corroboration is worse than
 * none: it would manufacture confidence out of a name collision.
 */

const UA = 'vamos-deal-radar research (contact: vamosventures.com)';

export interface CorroborationAttempt {
  companyId: string;
  companyName: string;
  found: { sourceId: string; family: string; url: string; detail: string }[];
  /** A website discovered during corroboration, when the company had none. */
  discoveredWebsite: string | null;
  familiesBefore: number;
  familiesAfter: number;
  notes: string[];
}

function familiesOf(companyId: string): string[] {
  return [...new Set(listDealEvidence(companyId).map((e) => familyOf(e.sourceId)))];
}

/**
 * Is this YC record the same company? Requires either an exact
 * normalized-name match or a high-confidence fuzzy match — the same
 * identity logic the dedupe pipeline uses, so corroboration and
 * deduplication cannot disagree about what "the same company" means.
 */
export function sameCompany(a: string, b: string): boolean {
  const ka = normalizeCompanyKey(a);
  const kb = normalizeCompanyKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  return isHighConfidenceFuzzy(ka, kb);
}

interface YcRecord {
  name: string; website?: string | null; oneLiner?: string | null;
  batch?: string | null; url?: string | null; slug?: string | null;
  status?: string | null; industries?: string[] | null; tags?: string[] | null;
}

/**
 * Ask the YC directory whether it knows this company.
 *
 * Refuses to answer for a common single word. A live run "corroborated" a
 * TechCrunch-reported inference startup called Infinity against a YC
 * company also called Infinity — a consumer app in a different country —
 * and then adopted that company's website as its own. An exact match on
 * one common word is a name collision, not an identity, and a false
 * corroboration is worse than none: it manufactures confidence.
 */
export async function findInYc(companyName: string): Promise<{ record: YcRecord; url: string } | null> {
  if (isAmbiguousCompanyName(companyName)) return null;
  const res = await politeFetch(
    `https://api.ycombinator.com/v0.1/companies?q=${encodeURIComponent(companyName)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  );
  if (!res.ok) return null;
  let payload: { companies?: YcRecord[] };
  try { payload = JSON.parse(res.body); } catch { return null; }

  for (const r of payload.companies ?? []) {
    if (!r?.name || !sameCompany(companyName, r.name)) continue;
    // An inactive YC company is not corroboration of a current business.
    if ((r.status ?? 'Active') === 'Inactive') continue;
    const url = r.url && /^https?:\/\//.test(r.url)
      ? r.url
      : r.slug ? `https://www.ycombinator.com/companies/${r.slug}` : null;
    if (!url) continue;
    return { record: r, url };
  }
  return null;
}

/**
 * Try to corroborate one company from sources it did not come from.
 *
 * Only ADDS evidence — never removes or rewrites. Existing evidence is
 * deduplicated by (company, url, type) at the storage layer, so running
 * this twice is safe.
 */
export async function corroborateCompany(companyId: string): Promise<CorroborationAttempt> {
  const company = getCompany(companyId);
  const attempt: CorroborationAttempt = {
    companyId,
    companyName: company?.name ?? '(unknown)',
    found: [],
    discoveredWebsite: null,
    familiesBefore: familiesOf(companyId).length,
    familiesAfter: 0,
    notes: [],
  };
  if (!company) {
    attempt.notes.push('Company not found.');
    return attempt;
  }

  const existingFamilies = new Set(familiesOf(companyId));

  // Accelerator directory. Skipped when the company already HAS
  // accelerator-family evidence — re-finding the same family adds nothing.
  if (!existingFamilies.has('accelerator')) {
    const yc = await findInYc(company.name);
    if (yc) {
      const batchDate = batchToApproxDate(yc.record.batch);
      const labels = [...(yc.record.industries ?? []), ...(yc.record.tags ?? [])];
      const evidence: DealEvidence = {
        opportunityType: 'accelerator-batch',
        sourceId: 'yc',
        sourceName: 'Y Combinator public directory',
        tier: tierOf('yc'),
        url: yc.url,
        publishedAt: batchDate,
        retrievedAt: new Date().toISOString().slice(0, 10),
        summary: [
          `Listed in the public Y Combinator directory${yc.record.batch ? `, batch ${yc.record.batch}` : ''}.`,
          labels.length > 0 ? `YC categories: ${labels.slice(0, 5).join(', ')}.` : '',
          yc.record.oneLiner ? `YC one-liner: ${yc.record.oneLiner}` : '',
        ].filter(Boolean).join(' '),
        whyCurrent: batchDate
          ? `Accelerator batch beginning approximately ${batchDate} (a batch season, not an exact day).`
          : 'A directory listing with no batch date proves participation, not a current raise.',
        amountUsd: null, amountText: null, roundType: null, investors: [],
      };
      const added = addDealEvidence(companyId, evidence);
      attempt.found.push({
        sourceId: 'yc', family: 'accelerator', url: yc.url,
        detail: added.added ? 'New accelerator-directory corroboration.' : 'Already on record.',
      });

      // A directory listing usually carries the official website — which
      // is exactly what SEC filings never provide. Recorded through the
      // provenance guard so it cannot overwrite a verified value.
      const site = yc.record.website;
      if (site && !company.website && /^https?:\/\//.test(site)) {
        const applied = applyFieldUpdate(companyId, 'website', site, 'extracted', 'yc-directory-corroboration');
        if (applied.applied) {
          attempt.discoveredWebsite = site;
          attempt.notes.push(`Discovered official website via the YC directory: ${site}`);
        }
      }
    } else if (isAmbiguousCompanyName(company.name)) {
      attempt.notes.push(
        `"${company.name}" is a common English word, so a directory entry with the same name would not `
        + 'establish identity. Not treated as corroboration; left for human lookup.',
      );
    } else {
      attempt.notes.push('Not found in the Y Combinator directory.');
    }
  } else {
    attempt.notes.push('Already has accelerator-family evidence; skipped the directory lookup.');
  }

  attempt.familiesAfter = familiesOf(companyId).length;
  return attempt;
}

// ── Official-website discovery ────────────────────────────────────

/**
 * Find and CONFIRM a company's official website when no source gave us
 * one.
 *
 * This matters because SEC Form D has no website field at all, so every
 * SEC-derived company arrives with nothing to verify — which is why 65 of
 * 176 records had no website and could never be confirmed as operating
 * businesses.
 *
 * The method is hypothesis-then-verification, not guessing. Candidate
 * domains are derived from the legal name, each is fetched, and a
 * candidate is only accepted when the page CONTENTS actually mention the
 * company. A domain that merely resolves proves nothing — plenty of
 * two-word .com domains are owned by someone unrelated. Requiring the
 * name on the page is what turns a guess into evidence.
 *
 * No credential and no search engine involved; this is only DNS and HTTP.
 */

export interface WebsiteDiscovery {
  url: string | null;
  confirmedBy: 'name-on-page' | null;
  tried: string[];
  detail: string;
}

export async function discoverOfficialWebsite(companyName: string): Promise<WebsiteDiscovery> {
  const stem = domainStemFromName(companyName);
  if (stem.length < 4) {
    return { url: null, confirmedBy: null, tried: [], detail: 'Company name too short to derive a candidate domain.' };
  }


  // Common single words are not identifying. A real run "confirmed"
  // natural.com for a company called "Natural" and enigma.com for
  // "Enigma" — both pass a name-on-page check trivially, because the
  // word appears on any page about anything.
  //
  // The guard used to be "at least two meaningful words, or one stem of
  // twelve characters", which was the wrong test: it also refused
  // "Greyparrot", "Theker", and "Antares", where finding the name on the
  // page IS real confirmation. The question is whether the WORD is
  // common, so that is what is checked.
  if (isAmbiguousCompanyName(companyName)) {
    return {
      url: null, confirmedBy: null, tried: [],
      detail: `"${companyName}" is a common English word — a matching domain would not be evidence of identity. Left for human lookup rather than guessed.`,
    };
  }

  // The STEM can be ambiguous even when the NAME is not. "Bespoke Labs"
  // is two words and passes the check above, but stripping the generic
  // "Labs" leaves "bespoke" — and bespoke.com is a for-sale listing whose
  // page contains the word "bespoke", so the name-on-page test passes on
  // a domain nobody operates. The real question is whether the string we
  // are about to guess a domain FROM identifies anyone, so that is what
  // is asked.
  if (isAmbiguousCompanyName(stem)) {
    return {
      url: null, confirmedBy: null, tried: [],
      detail: `"${companyName}" reduces to the common word "${stem}" once generic suffixes are removed — `
        + 'a matching domain would not be evidence of identity. Left for human lookup rather than guessed.',
    };
  }
  // A small, ordered candidate set. Deliberately short: this runs per
  // company and each miss costs a request.
  const candidates = [
    `https://${stem}.com`,
    `https://www.${stem}.com`,
    `https://${stem}.ai`,
    `https://${stem}.io`,
    `https://${stem}.health`,
  ];
  const tried: string[] = [];
  const refused: string[] = [];

  for (const url of candidates) {
    tried.push(url);
    if (!(await isSafeExternalUrlResolved(url))) continue;
    const res = await politeFetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const body = res.body.slice(0, 60_000);
    // Parking first. A registrar page for `lantern.com` contains the word
    // "lantern", so the name check below would confirm it — the order
    // here is what stops a for-sale listing becoming a company's site.
    const disqualified = pageDisqualifiedAsOfficialSite(body);
    if (disqualified) { refused.push(`${url} (${disqualified})`); continue; }
    if (!pageMentionsCompany(body, companyName)) continue;
    return {
      url, confirmedBy: 'name-on-page', tried,
      detail: `Confirmed: ${url} responds with real content that names the company.`,
    };
  }
  return {
    url: null, confirmedBy: null, tried,
    detail: `No candidate domain both responded and named the company (tried ${tried.length})`
      + `${refused.length > 0 ? `; refused ${refused.join(', ')}` : ''}.`,
  };
}

/**
 * Discover-and-record an official website, and register it as
 * web-family evidence that the company is a real operating business.
 *
 * The financing claim still rests on the tier-1 filing. This only
 * corroborates that the filer is a going concern with a product — which
 * is precisely the question a Form D cannot answer.
 */
export async function corroborateViaWebsite(companyId: string): Promise<{ url: string | null; added: boolean; detail: string }> {
  const company = getCompany(companyId);
  if (!company) return { url: null, added: false, detail: 'Company not found.' };
  if (company.website) return { url: company.website, added: false, detail: 'Website already on record.' };

  const found = await discoverOfficialWebsite(company.name);
  if (!found.url) return { url: null, added: false, detail: found.detail };

  applyFieldUpdate(companyId, 'website', found.url, 'extracted', 'website-discovery');
  const added = addDealEvidence(companyId, {
    // Not a financing event — an existence-and-operation signal.
    opportunityType: 'none',
    sourceId: 'websites',
    sourceName: 'Official company website',
    tier: tierOf('websites'),
    url: found.url,
    // A website has no publication date; claiming one would be invented.
    publishedAt: null,
    retrievedAt: new Date().toISOString().slice(0, 10),
    summary: `Official website ${found.url} responds with real content naming ${company.name}.`,
    whyCurrent: 'Confirms the company is an operating business. Carries no date, so it cannot by itself make an opportunity current.',
    amountUsd: null, amountText: null, roundType: null, investors: [],
  });
  return { url: found.url, added: added.added, detail: found.detail };
}
