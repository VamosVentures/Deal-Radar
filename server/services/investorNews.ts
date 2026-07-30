import { collectInvestorEvents, configuredInvestorFeeds, describeInvestorRun, type InvestorRunReport } from '../sourcing/adapters/investorNews';
import { eventIdentity, type FundingEvent } from '../sourcing/fundingEvent';
import type { InvestorReasonCode } from '../sourcing/investorAnnouncement';
import { checkEntityType } from '../sourcing/classify';
import { matchCompany } from '../sourcing/identity';
import { familyOf, tierOf } from '../../shared/opportunity';
import { addDealEvidence, listDealEvidence, reclassifyCompany } from '../db/repos/opportunities';
import { saveCompany, matchRecords, listCompanies, getCompany } from '../db/repos/companies';
import { saveScore } from '../db/repos/operations';
import { importedCompanySchema } from './imports';
import { resolveCompanyWebsite, type WebsiteResolution } from './fundingNews';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * The investor-primary pipeline, end to end: registered investor feeds →
 * announcements the firm says it was part of → resolved company →
 * stored evidence.
 *
 * It deliberately mirrors fundingNews.ts rather than sharing its body.
 * The two differ in the only place that matters — what makes a page
 * evidence — and collapsing them into one parameterised function would
 * hide that difference behind a flag. What IS shared is shared for real:
 * feed parsing, event merging, conflict detection, website resolution,
 * company matching, and persistence all come from the same modules, so
 * the two families cannot drift apart on anything except their own rule.
 *
 * The most valuable thing this produces is often not a new company. It is
 * a SECOND FAMILY on a company the press already gave us — which is what
 * turns a single-sourced round into a corroborated one.
 */

export interface ImportedInvestorEvent {
  companyId: string;
  companyName: string;
  eventId: string;
  /** True when this attached to a company already on record. */
  attachedToExisting: boolean;
  investors: { name: string; domain: string; url: string; participation: string }[];
  website: string | null;
  websiteMethod: string | null;
  sector: string | null;
  amountUsd: number | null;
  amountText: string | null;
  roundType: string | null;
  announcedAt: string;
  conflicts: string[];
  evidenceRows: number;
  /** Source families on this company AFTER the import — the number this source exists to move. */
  familiesAfter: string[];
}

export interface InvestorNewsRun {
  report: InvestorRunReport;
  entityRejected: { company: string; reason: string }[];
  sectorRejected: { company: string; url: string }[];
  websiteResolved: number;
  websiteUnresolved: { company: string; detail: string }[];
  imported: ImportedInvestorEvent[];
  skipped: { company: string; code: InvestorReasonCode; detail: string }[];
  requests: number;
}

export interface InvestorRunOptions {
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
 * Run the whole investor-primary pipeline and report every stage.
 *
 * Nothing is silently dropped: an event either becomes an
 * ImportedInvestorEvent or appears in a rejection list with a named
 * reason code.
 */
export async function runInvestorNews(opts: InvestorRunOptions = {}): Promise<InvestorNewsRun> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const feeds = opts.feeds ?? configuredInvestorFeeds();
  const log = opts.onProgress ?? (() => {});

  const { events, report, requests } = await collectInvestorEvents(feeds, today, opts.maxResults ?? 60);
  log(describeInvestorRun(report));

  const run: InvestorNewsRun = {
    report,
    entityRejected: [], sectorRejected: [],
    websiteResolved: 0, websiteUnresolved: [],
    imported: [], skipped: [], requests,
  };

  for (const event of events) {
    // 1. Entity type, on the published name alone — the same rule every
    //    other source obeys. A firm announcing an investment in its own
    //    SPV is not announcing a company.
    const entity = checkEntityType(event.companyName);
    if (!entity.isOperatingCompany) {
      run.entityRejected.push({ company: event.companyName, reason: entity.reason });
      continue;
    }

    // 2. Sector. A company we cannot place has no shortlist to join.
    if (!event.sector) {
      run.sectorRejected.push({ company: event.companyName, url: event.articleUrl });
      continue;
    }

    // 3. Official website — identity and operations, not the financing.
    let website: WebsiteResolution = {
      url: null, method: null, tried: [],
      detail: 'Website resolution skipped (offline).', code: 'website-unresolved',
    };
    if (!opts.offline) {
      const links = event.sources.flatMap((s) => s.outboundLinks ?? []);
      website = await resolveCompanyWebsite(event, links, { allowDerivedDomain: false });
    }
    if (website.url) run.websiteResolved += 1;
    else run.websiteUnresolved.push({ company: event.companyName, detail: website.detail });

    if (opts.dryRun) {
      run.imported.push(describeImport(event, 'dry-run', false, website, 0, ['(not written)']));
      continue;
    }

    const persisted = persistInvestorEvent(event, website, today);
    if (!persisted) {
      run.skipped.push({
        company: event.companyName,
        code: 'company-name-not-extractable',
        detail: 'Failed company-record validation.',
      });
      continue;
    }
    run.imported.push(describeImport(
      event, persisted.companyId, persisted.attachedToExisting, website,
      persisted.evidenceRows, persisted.familiesAfter,
    ));
    log(
      `${persisted.attachedToExisting ? 'corroborated' : 'imported'} ${event.companyName} (${event.sector})`
      + ` — ${persisted.familiesAfter.length} source famil${persisted.familiesAfter.length === 1 ? 'y' : 'ies'}`,
    );
  }

  return run;
}

function describeImport(
  event: FundingEvent, companyId: string, attachedToExisting: boolean,
  website: WebsiteResolution, evidenceRows: number, familiesAfter: string[],
): ImportedInvestorEvent {
  return {
    companyId,
    companyName: event.companyName,
    eventId: eventIdentity(event),
    attachedToExisting,
    investors: event.sources
      .filter((s) => s.sourceId === 'investor-news')
      .map((s) => ({
        name: s.investor ?? s.publisher,
        domain: s.investorDomain ?? s.publisher,
        url: s.url,
        participation: s.participation ?? '',
      })),
    website: website.url,
    websiteMethod: website.method,
    sector: event.sector,
    amountUsd: event.amountUsd,
    amountText: event.amountText,
    roundType: event.roundType,
    announcedAt: event.announcedAt,
    conflicts: event.conflicts.map((c) => `${c.field}: ${c.values.join(' vs ')}`),
    evidenceRows,
    familiesAfter,
  };
}

/** Source families currently on record for a company. */
function familiesOf(companyId: string): string[] {
  return [...new Set(listDealEvidence(companyId).map((e) => familyOf(e.sourceId)))];
}

/**
 * Write one investor-primary event: a company record when it is new,
 * plus one deal-evidence row per announcing investor.
 *
 * When the company is ALREADY on record — which is the common and most
 * useful case — `matchCompany` returns it and the evidence attaches to
 * the existing row. That is how a press-only opportunity gains a second
 * source family without becoming a duplicate company.
 *
 * Storage deduplicates on (company, url, type), so re-running is safe and
 * the second run adds nothing.
 */
function persistInvestorEvent(
  event: FundingEvent, website: WebsiteResolution, today: string,
): { companyId: string; attachedToExisting: boolean; evidenceRows: number; familiesAfter: string[] } | null {
  const match = matchCompany(
    { name: event.companyName, domain: website.url ?? null },
    matchRecords(),
  );
  const existing = match.kind === 'exact' && match.record ? match.record : null;

  let companyId: string;
  if (existing) {
    companyId = existing.id;
  } else {
    const parsed = importedCompanySchema.safeParse({
      id: `investor-${event.companyKey.slice(0, 40) || event.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      name: event.companyName,
      oneLiner: event.articleTitle,
      vertical: event.sector,
      subcategory: 'Unclassified — requires manual review',
      stage: event.roundType === 'Pre-seed' || event.roundType === 'Seed' || event.roundType === 'Series A'
        ? event.roundType
        : 'Unknown',
      city: event.hqCity ?? 'Unknown',
      state: event.hqState ?? '??',
      // Not stated by an investment announcement. The schema needs a
      // number; the provenance layer marks it unverified.
      foundedYear: new Date(event.announcedAt).getFullYear(),
      teamSize: 1,
      website: website.url ?? undefined,
      raising: event.amountText ?? undefined,
      lastFundingDate: event.announcedAt,
      traction: { level: 0, note: 'Unknown — not yet researched' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
      evidence: event.sources.map((s) => ({
        claim: s.excerpt.slice(0, 500),
        source: `${s.investor ?? s.publisher} (official investor announcement)`,
        url: s.url,
        date: s.announcedAt,
        type: 'News' as const,
      })),
      flags: [],
      imported: true as const,
    });
    if (!parsed.success) return null;

    saveCompany(parsed.data, {
      origin: 'extracted',
      source: `investor-news:${event.sources[0]?.investorDomain ?? event.publisher}`,
      reviewStatus: 'Awaiting Review',
      discoverySource: 'investor-news',
      discoveredAt: today,
    });
    const stored = getCompany(parsed.data.id);
    saveScore(parsed.data.id, scoreCompany((stored ?? parsed.data) as unknown as Company), parsed.data.evidence.map((e) => e.url));
    companyId = parsed.data.id;
  }

  // One row per announcing investor, so a reviewer can open every page.
  let evidenceRows = 0;
  for (const source of event.sources) {
    const isInvestorSource = source.sourceId === 'investor-news';
    const who = isInvestorSource ? (source.investor ?? source.publisher) : source.publisher;
    const added = addDealEvidence(companyId, {
      opportunityType: 'funding-announcement',
      sourceId: isInvestorSource ? 'investor-news' : 'funding-news',
      sourceName: isInvestorSource
        ? `${who} (official investor announcement, ${source.investorDomain})`
        : `${who} (public RSS)`,
      tier: tierOf(isInvestorSource ? 'investor-news' : 'funding-news'),
      url: source.url,
      publishedAt: source.announcedAt,
      retrievedAt: today,
      // What THIS page said, attributed to the party that published it —
      // never the merged event's figure, which would misquote whoever
      // did not state it.
      summary: source.excerpt.slice(0, 500),
      whyCurrent: isInvestorSource
        ? `Announced ${source.announcedAt} on ${source.investorDomain}, ${who}'s own verified domain.`
          + ` ${who} states it took part in this financing: "${(source.participation ?? '').slice(0, 120)}".`
          + ' A first-party account of the round, not a report of one.'
        : `Funding reported ${source.announcedAt} by ${who}.`,
      amountUsd: source.amountUsd,
      amountText: source.amountText,
      roundType: source.roundType,
      investors: event.investors,
      // A disputed figure is not a fact, so a conflicted event carries
      // less confidence than a clean one.
      confidence: event.conflicts.length > 0 ? 0.55 : 0.7,
    });
    if (added.added) evidenceRows += 1;
  }

  // A confirmed website is web-family evidence that the company is a real
  // operating business. Undated, so it cannot make an opportunity current
  // and cannot verify the financing amount.
  if (website.url) {
    addDealEvidence(companyId, {
      opportunityType: 'none',
      sourceId: 'websites',
      sourceName: 'Official company website',
      tier: tierOf('websites'),
      url: website.url,
      publishedAt: null,
      retrievedAt: today,
      summary: website.detail,
      whyCurrent: 'Confirms the company is an operating business. Undated, so it cannot establish currency, and it cannot independently verify the financing amount.',
      amountUsd: null, amountText: null, roundType: null, investors: [],
      confidence: 0.6,
    });
  }

  reclassifyCompany(companyId);
  return { companyId, attachedToExisting: existing !== null, evidenceRows, familiesAfter: familiesOf(companyId) };
}

/** Total companies on record — used by the live-verification report. */
export function investorCompanyCount(): number {
  return listCompanies().length;
}

/**
 * Persist one already-extracted event, skipping the network entirely.
 *
 * Exported for tests so the storage rules — attach-to-existing, one row
 * per investor, idempotency — are exercised against the real repository
 * rather than a stand-in. Not used by the running application, which
 * always arrives here through runInvestorNews.
 */
export function __importInvestorEventForTests(
  event: FundingEvent, today: string,
): { companyId: string; attachedToExisting: boolean; evidenceRows: number; familiesAfter: string[] } | null {
  return persistInvestorEvent(
    event,
    { url: null, method: null, tried: [], detail: 'Website resolution skipped (test).', code: 'website-unresolved' },
    today,
  );
}
