import { SOURCE_FAMILIES, type SourceFamily } from '../../shared/enrichment';
import { TEAM_PAGE_PATHS } from './founderExtraction';
import { normalizeDomainKey } from '../sourcing/identity';

/**
 * Turning what we already hold about a company into an ordered list of
 * pages to ask about its founders.
 *
 * Pure. Building the plan and executing it are separated so the ORDER —
 * which is policy, and which the brief specifies precisely — can be
 * tested without a network, and so a dry run can show a reviewer exactly
 * what would be fetched before anything is.
 *
 * Every URL here comes from a record we already have: the company's own
 * website field, an SEC filing we already cited, a YC directory entry we
 * already imported, an investor announcement already in deal evidence.
 * Nothing is discovered by guessing addresses, nothing sits behind a
 * login wall, and no access control is worked around. A family with no
 * URL on record produces `no-source-url-known`, which is a truthful
 * result rather than a prompt to go looking somewhere we should not.
 */

export interface PlanCompany {
  id: string;
  name: string;
  website: string | null;
  accelerator: string | null;
  city: string | null;
  state: string | null;
  /** Evidence rows already on the company (claim/source/url/date/type). */
  evidence: { claim: string; source: string; url: string; date: string; type: string }[];
  /** Deal-evidence rows (source_id/source_name/url/published_at/summary). */
  dealEvidence: { sourceId: string; sourceName: string; url: string; publishedAt: string | null; summary: string }[];
}

export interface PlannedFetch {
  family: SourceFamily;
  url: string;
  /** The source's own label, stored with any candidate found here. */
  sourceType: string;
  /** Published/filed date when the originating record carries one. */
  publishedAt: string | null;
}

export interface FamilyPlan {
  family: SourceFamily;
  fetches: PlannedFetch[];
  /** Set when the family cannot be attempted, and why — recorded as the attempt outcome. */
  unavailableReason: 'no-source-url-known' | 'source-not-applicable' | null;
}

/**
 * `https://www.sec.gov/Archives/edgar/data/1869920/000186992025000002/0001869920-25-000002-index.htm`
 * → the machine-readable primary document in the same directory.
 *
 * The index page is HTML built for humans and lists documents; the
 * related-person records live in `primary_doc.xml`, which
 * sourcing/formd.ts already parses. Deriving one from the other avoids a
 * second request just to find a link we can compute.
 */
export function primaryDocFromIndexUrl(indexUrl: string): string | null {
  const m = indexUrl.match(/^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+)\/[^/]+-index\.htm$/i);
  return m ? `${m[1]}/primary_doc.xml` : null;
}

/** Root URL of the company's own site, normalised, or null. */
export function companyRoot(website: string | null): string | null {
  const domain = normalizeDomainKey(website);
  return domain ? `https://${domain}` : null;
}

/**
 * Is this URL on the company's own domain?
 *
 * Load-bearing for match scoring: a statement on the company's own site
 * is the company describing itself, which is the strongest founder
 * signal available. The same sentence on a news site is a third party
 * reporting, which is weaker and scored as such.
 */
export function isOnCompanyDomain(url: string, website: string | null): boolean {
  const site = normalizeDomainKey(website);
  const target = normalizeDomainKey(url);
  return site !== null && target !== null && (target === site || target.endsWith(`.${site}`));
}

const YC_HOSTS = ['ycombinator.com', 'www.ycombinator.com'];

function isAcceleratorUrl(url: string): boolean {
  const d = normalizeDomainKey(url) ?? '';
  return YC_HOSTS.some((h) => d === h || d.endsWith('.ycombinator.com'))
    || /techstars\.com|500\.co|alchemistaccelerator\.com|masschallenge\.org|plugandplaytechcenter\.com/i.test(d);
}

/**
 * Build the ordered research plan for one company.
 *
 * The order is exactly the brief's: the company's own pages, then the
 * SEC filing, then accelerator profiles, then investors, then founder
 * announcements, then funding press, then public and professional
 * profiles, then registries. Families that can CONFIRM come before
 * families that can only suggest.
 */
export function buildResearchPlan(c: PlanCompany, opts: { maxTeamPages?: number } = {}): FamilyPlan[] {
  const maxTeamPages = opts.maxTeamPages ?? 4;
  const plans = new Map<SourceFamily, FamilyPlan>();
  for (const family of SOURCE_FAMILIES) {
    plans.set(family, { family, fetches: [], unavailableReason: null });
  }
  const add = (family: SourceFamily, f: PlannedFetch) => {
    const plan = plans.get(family)!;
    if (!plan.fetches.some((x) => x.url === f.url)) plan.fetches.push(f);
  };

  // 1. The company's own site: home page first (many small companies put
  //    the team in the footer), then the conventional team paths.
  const root = companyRoot(c.website);
  if (root) {
    add('company-site', { family: 'company-site', url: root, sourceType: 'Company home page', publishedAt: null });
    for (const p of TEAM_PAGE_PATHS.slice(0, maxTeamPages)) {
      add('company-site', {
        family: 'company-site', url: `${root}${p}`,
        sourceType: `Company ${p.replace(/^\//, '')} page`, publishedAt: null,
      });
    }
  }

  // 2. SEC Form D — related persons, from the filing we already cite.
  for (const e of [...c.evidence, ...c.dealEvidence.map((d) => ({ url: d.url, date: d.publishedAt ?? '', source: d.sourceName }))]) {
    const doc = primaryDocFromIndexUrl(e.url);
    if (doc) {
      add('sec-form-d', {
        family: 'sec-form-d', url: doc,
        sourceType: 'SEC Form D related persons', publishedAt: e.date || null,
      });
    }
  }

  // 3. Accelerator / incubator official profiles.
  for (const e of [...c.evidence, ...c.dealEvidence.map((d) => ({ url: d.url, date: d.publishedAt ?? '', source: d.sourceName }))]) {
    if (isAcceleratorUrl(e.url)) {
      add('accelerator', {
        family: 'accelerator', url: e.url,
        sourceType: e.source || 'Accelerator directory profile', publishedAt: e.date || null,
      });
    }
  }

  // 4. Investor portfolio pages and official investment announcements.
  for (const d of c.dealEvidence) {
    if (d.sourceId === 'investor-news') {
      add('investor-portfolio', {
        family: 'investor-portfolio', url: d.url,
        sourceType: d.sourceName || 'Investor announcement', publishedAt: d.publishedAt,
      });
    }
  }

  // 5. Founder-authored announcements — press pages on the company's own
  //    domain that are not the team pages already queued.
  for (const e of c.evidence) {
    if (isOnCompanyDomain(e.url, c.website) && !plans.get('company-site')!.fetches.some((f) => f.url === e.url)) {
      add('founder-announcement', {
        family: 'founder-announcement', url: e.url,
        sourceType: e.source || 'Company announcement', publishedAt: e.date || null,
      });
    }
  }

  // 6. Funding press.
  for (const d of c.dealEvidence) {
    if (d.sourceId === 'funding-news') {
      add('funding-press', {
        family: 'funding-press', url: d.url,
        sourceType: d.sourceName || 'Funding press', publishedAt: d.publishedAt,
      });
    }
  }

  // 7. Public conference / demo-day / university / award profiles, and
  //    8/9 professional profiles and registries.
  //
  // These have no URL on record for any company in this dataset, so they
  // are reported as `no-source-url-known` rather than being satisfied by
  // guessing an address or by querying a service that requires an
  // account. That is a truthful description of our coverage, and it is
  // what the "sources attempted" display will show a reviewer.
  for (const [family, plan] of plans) {
    if (plan.fetches.length > 0) continue;
    if (family === 'accelerator' && !c.accelerator) {
      plan.unavailableReason = 'source-not-applicable';
    } else if (family === 'company-site' && !root) {
      plan.unavailableReason = 'no-source-url-known';
    } else {
      plan.unavailableReason = 'no-source-url-known';
    }
  }

  return SOURCE_FAMILIES.map((f) => plans.get(f)!);
}
