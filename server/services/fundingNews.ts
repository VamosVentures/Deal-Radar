import { politeFetch } from '../sourcing/politeness';
import { isSafeExternalUrlResolved } from '../lib/http';
import { checkEntityType } from '../sourcing/classify';
import { domainStemFromName, pageDisqualifiedAsOfficialSite } from '../sourcing/pageSignals';
import { matchCompany } from '../sourcing/identity';
import { normalizeDomain } from '../../shared/integrations';
import {
  collectFundingEvents, configuredFeeds, describeRssRun, APPROVED_PUBLISHERS,
  type RssRunReport,
} from '../sourcing/adapters/rss';
import { eventIdentity, independentPublishers, type FundingEvent, type RssReasonCode } from '../sourcing/fundingEvent';
import { discoverOfficialWebsite } from './corroborate';
import { addDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import { saveCompany, matchRecords, listCompanies } from '../db/repos/companies';
import { saveScore } from '../db/repos/operations';
import { importedCompanySchema } from './imports';
import { candidateToDealEvidence } from './shortlist';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * The funding-news pipeline, end to end: feeds → events → resolved
 * company → corroboration → stored opportunity.
 *
 * Kept as one service rather than spread across the generic discovery
 * pipeline because RSS needs work no other source needs — resolving which
 * company an article is about, and finding a second publisher that
 * reported the same round. Both are network steps with their own failure
 * modes, and both have to be REPORTED, not silently skipped. The old
 * adapter reported "77 candidates" and delivered nothing.
 */

const UA = 'vamos-deal-radar research (contact: vamosventures.com)';

// ── Company resolution ────────────────────────────────────────────

export interface WebsiteResolution {
  url: string | null;
  method: 'article-link' | 'derived-domain' | null;
  tried: string[];
  detail: string;
  /** Reason code when resolution failed, for the run report. */
  code: RssReasonCode | null;
}

/**
 * Does this page belong to this company?
 *
 * Requires the company's own name in the page text. A domain that merely
 * resolves proves nothing — plenty of short .com domains belong to
 * someone unrelated, which is how an earlier run "confirmed"
 * natural.com for a company called Natural.
 */
function pageNamesCompany(html: string, name: string): boolean {
  const text = html.replace(/<[^>]*>/g, ' ').toLowerCase();
  const squashed = text.replace(/[^a-z0-9]+/g, '');
  const stem = domainStemFromName(name);
  if (stem.length >= 5 && squashed.includes(stem)) return true;
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  return words.length > 0 && words.every((w) => text.includes(w));
}

/**
 * Find the company's official website.
 *
 * Order matters and follows §5: structured evidence first, guessing last
 * (and never for an ambiguous name).
 *
 *  1. A link the ARTICLE ITSELF points at. The reporter knew which
 *     company they were writing about; we should use that rather than
 *     re-deriving it.
 *  2. A domain derived from the company name, confirmed by fetching it
 *     and finding the name on the page.
 *
 * A single common word like "Natural" or "Cascade" skips step 2
 * entirely: a matching domain would be a coincidence, not evidence.
 */
export interface ResolveWebsiteOptions {
  /**
   * Whether a domain may be DERIVED from the company name and confirmed
   * by finding the name on the page.
   *
   * The investor-primary pipeline sets this to false. The reason is not
   * caution for its own sake: an investor's own announcement is a source
   * that KNOWS which company it funded, so accepting a guess alongside it
   * trades that certainty for a coin flip. A live dry run proposed
   * bespoke.health for Bespoke Labs (real site: bespokelabs.ai) and
   * lantern.ai for Lantern — both pages name a real company, neither
   * names THIS one. Recording a wrong website is worse than recording
   * none, because every later check then verifies the wrong business.
   */
  allowDerivedDomain?: boolean;
}

export async function resolveCompanyWebsite(
  event: FundingEvent,
  articleLinks: string[],
  opts: ResolveWebsiteOptions = {},
): Promise<WebsiteResolution> {
  const tried: string[] = [];
  const stem = domainStemFromName(event.companyName);

  // Rank article links: one whose domain resembles the company name is
  // very likely the company's own site.
  const ranked = [...new Set(articleLinks)].sort((a, b) => {
    const score = (u: string) => {
      const host = normalizeDomain(u) ?? '';
      if (stem.length >= 4 && host.replace(/[^a-z0-9]/g, '').includes(stem)) return 0;
      return 1;
    };
    return score(a) - score(b);
  }).slice(0, 5);

  for (const url of ranked) {
    tried.push(url);
    if (!(await isSafeExternalUrlResolved(url))) continue;
    const res = await politeFetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const body = res.body.slice(0, 60_000);
    // Even a link the publisher chose can have lapsed into parking by the
    // time we follow it. Same test as derived-domain discovery uses.
    if (pageDisqualifiedAsOfficialSite(body)) continue;
    if (!pageNamesCompany(body, event.companyName)) continue;
    return {
      url, method: 'article-link', tried, code: null,
      detail: `Confirmed via a link in the ${event.publisher} article: ${url} names ${event.companyName}.`,
    };
  }

  if (event.nameAmbiguous) {
    return {
      url: null, method: null, tried, code: 'website-unresolved',
      detail: `"${event.companyName}" is a single common word. The article linked no company site, and a guessed domain would not be evidence of identity — left for human lookup.`,
    };
  }

  if (opts.allowDerivedDomain === false) {
    return {
      url: null, method: null, tried, code: 'website-unresolved',
      detail: `The announcement linked no site for ${event.companyName}. Domain guessing is not used for investor-primary `
        + 'evidence: the announcing firm knows which company it funded, and a domain derived from the name does not. '
        + 'Left for human lookup.',
    };
  }

  const derived = await discoverOfficialWebsite(event.companyName);
  tried.push(...derived.tried);
  if (derived.url) {
    return { url: derived.url, method: 'derived-domain', tried, code: null, detail: derived.detail };
  }
  return {
    url: null, method: null, tried,
    code: tried.length > 0 ? 'website-not-confirmed' : 'website-unresolved',
    detail: derived.detail,
  };
}

// ── Import ────────────────────────────────────────────────────────

export interface ImportedEvent {
  companyId: string;
  companyName: string;
  eventId: string;
  website: string | null;
  websiteMethod: string | null;
  publishers: string[];
  sector: string | null;
  amountUsd: number | null;
  roundType: string | null;
  announcedAt: string;
  conflicts: string[];
  evidenceRows: number;
}

export interface FundingNewsRun {
  report: RssRunReport;
  /** Approved-publisher check, per event. */
  publisherRejected: { company: string; publisher: string }[];
  sectorRejected: { company: string; url: string }[];
  entityRejected: { company: string; reason: string }[];
  websiteResolved: number;
  websiteUnresolved: { company: string; detail: string }[];
  imported: ImportedEvent[];
  /** Events that resolved but were not persisted, with the reason. */
  skipped: { company: string; code: RssReasonCode; detail: string }[];
  requests: number;
}

export interface RunOptions {
  feeds?: string[];
  today?: string;
  maxResults?: number;
  /** Report what would happen without writing to the database. */
  dryRun?: boolean;
  /** Skip website resolution (used by offline tests). */
  offline?: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Run the whole funding-news pipeline and report every stage honestly.
 *
 * Nothing here silently drops a candidate: an event either becomes an
 * ImportedEvent or appears in one of the rejection lists with a reason
 * code. That property is the actual fix for "77 candidates, 0
 * opportunities".
 */
export async function runFundingNews(opts: RunOptions = {}): Promise<FundingNewsRun> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const feeds = opts.feeds ?? configuredFeeds();
  const log = opts.onProgress ?? (() => {});

  const { events, report, requests } = await collectFundingEvents(feeds, today, opts.maxResults ?? 60);
  log(describeRssRun(report));

  const run: FundingNewsRun = {
    report,
    publisherRejected: [], sectorRejected: [], entityRejected: [],
    websiteResolved: 0, websiteUnresolved: [],
    imported: [], skipped: [], requests,
  };

  for (const event of events) {
    // 1. Approved tier-2 publisher. An unapproved outlet is not a
    //    financing source, however plausible the article looks.
    const publishers = independentPublishers(event);
    const approved = publishers.filter((p) => APPROVED_PUBLISHERS.includes(p));
    if (approved.length === 0) {
      run.publisherRejected.push({ company: event.companyName, publisher: publishers.join(', ') });
      continue;
    }

    // 2. Entity type, on the published name alone.
    const entity = checkEntityType(event.companyName);
    if (!entity.isOperatingCompany) {
      run.entityRejected.push({ company: event.companyName, reason: entity.reason });
      continue;
    }

    // 3. Sector. A company we cannot place has no shortlist to join, and
    //    forcing it into one would corrupt that sector.
    if (!event.sector) {
      run.sectorRejected.push({ company: event.companyName, url: event.articleUrl });
      continue;
    }

    // 4. Official website — identity and operations, not the financing.
    let website: WebsiteResolution = { url: null, method: null, tried: [], detail: 'Website resolution skipped (offline).', code: 'website-unresolved' };
    if (!opts.offline) {
      const links = event.sources.flatMap((s) => s.outboundLinks ?? []);
      website = await resolveCompanyWebsite(event, links);
    }
    if (website.url) run.websiteResolved += 1;
    else run.websiteUnresolved.push({ company: event.companyName, detail: website.detail });

    if (opts.dryRun) {
      run.imported.push(describeImport(event, 'dry-run', website, publishers, 0));
      continue;
    }

    const persisted = persistEvent(event, website, today);
    if (!persisted) {
      run.skipped.push({ company: event.companyName, code: 'company-name-not-extractable', detail: 'Failed company-record validation.' });
      continue;
    }
    run.imported.push(describeImport(event, persisted.companyId, website, publishers, persisted.evidenceRows));
    log(`imported ${event.companyName} (${event.sector}) — ${publishers.length} publisher(s), website ${website.url ?? 'unresolved'}`);
  }

  return run;
}

function describeImport(
  event: FundingEvent, companyId: string, website: WebsiteResolution,
  publishers: string[], evidenceRows: number,
): ImportedEvent {
  return {
    companyId,
    companyName: event.companyName,
    eventId: eventIdentity(event),
    website: website.url,
    websiteMethod: website.method,
    publishers,
    sector: event.sector,
    amountUsd: event.amountUsd,
    roundType: event.roundType,
    announcedAt: event.announcedAt,
    conflicts: event.conflicts.map((c) => `${c.field}: ${c.values.join(' vs ')}`),
    evidenceRows,
  };
}

/**
 * Write one event to the database as a company plus one deal-evidence row
 * per reporting article.
 *
 * One row per article on purpose: a reviewer must be able to open every
 * source, and corroboration counts distinct publishers. Storage
 * deduplicates on (company, url, type), so re-running is safe.
 */
function persistEvent(event: FundingEvent, website: WebsiteResolution, today: string): { companyId: string; evidenceRows: number } | null {
  const parsed = importedCompanySchema.safeParse({
    id: `news-${event.companyKey.slice(0, 40) || event.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
    name: event.companyName,
    oneLiner: event.articleTitle,
    vertical: event.sector,
    subcategory: 'Unclassified — requires manual review',
    // The round the article stated, mapped only where the Stage enum can
    // represent it. A Series D is recorded as the round, not the stage.
    stage: event.roundType === 'Pre-seed' || event.roundType === 'Seed' || event.roundType === 'Series A'
      ? event.roundType
      : 'Unknown',
    city: event.hqCity ?? 'Unknown',
    state: event.hqState ?? '??',
    // Not stated by a funding article. The schema needs a number; the
    // provenance layer marks it unverified.
    foundedYear: new Date(event.announcedAt).getFullYear(),
    teamSize: 1,
    website: website.url ?? undefined,
    raising: event.amountText ?? undefined,
    lastFundingDate: event.announcedAt,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
    evidence: event.sources.map((s) => ({
      claim: s.excerpt.slice(0, 500), source: `${s.publisher} (public RSS)`, url: s.url,
      date: s.announcedAt, type: 'News' as const,
    })),
    flags: [],
    imported: true as const,
  });
  if (!parsed.success) return null;

  const match = matchCompany({ name: parsed.data.name, domain: parsed.data.website ?? null }, matchRecords());
  const record = match.kind === 'exact' && match.record ? { ...parsed.data, id: match.record.id } : parsed.data;

  saveCompany(record, {
    origin: 'extracted', source: `funding-news:${event.publisher}`,
    reviewStatus: 'Awaiting Review', discoverySource: 'funding-news',
    discoveredAt: today,
  });
  saveScore(record.id, scoreCompany(record as unknown as Company), record.evidence.map((e) => e.url));

  // One deal-evidence row per reporting article.
  let evidenceRows = 0;
  for (const source of event.sources) {
    const [ev] = candidateToDealEvidence({
      sourceId: 'funding-news',
      evidence: [{
        claim: source.excerpt.slice(0, 500),
        source: `${source.publisher} (public RSS)`,
        url: source.url,
        dateAccessed: today,
        publishedAt: source.announcedAt,
        confidence: event.conflicts.length > 0 ? 0.5 : 0.65,
      }],
      // What THIS outlet said, not the merged event's primary figure. The
      // panel used to print "$27M (as stated by siliconangle.com)" on a
      // TechFundingNews row, which misquotes both of them.
      publicFunding: source.amountText ?? event.amountText ?? undefined,
      mostRecentRound: source.roundType ?? event.roundType ?? undefined,
      investors: event.investors,
      fundingDate: event.announcedAt,
      discoveredAt: `${today}T00:00:00.000Z`,
    });
    if (addDealEvidence(record.id, ev).added) evidenceRows += 1;
  }

  // A confirmed website is web-family evidence that the company is a real
  // operating business. It carries no date, so it cannot make an
  // opportunity current, and it cannot verify the financing amount.
  if (website.url) {
    addDealEvidence(record.id, {
      opportunityType: 'none',
      sourceId: 'websites',
      sourceName: 'Official company website',
      tier: 3,
      url: website.url,
      publishedAt: null,
      retrievedAt: today,
      summary: website.detail,
      whyCurrent: 'Confirms the company is an operating business. Undated, so it cannot establish currency, and it cannot independently verify the financing amount.',
      amountUsd: null, amountText: null, roundType: null, investors: [],
      confidence: 0.6,
    });
  }

  reclassifyCompany(record.id);
  return { companyId: record.id, evidenceRows };
}

/** Total companies on record — used by the live-verification report. */
export function companyCount(): number {
  return listCompanies().length;
}
