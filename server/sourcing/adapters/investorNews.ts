import { z } from 'zod';
import { env } from '../../env';
import { politeFetch, classifyStatus } from '../politeness';
import { validateLeads } from '../validate';
import { checkEntityType } from '../classify';
import { parseFeed, mergeFundingEvents, eventIdentity, independentSourceFamilies, type FundingEvent } from '../fundingEvent';
import {
  extractInvestorEvent, INVESTOR_REASON_TEXT,
  type InvestorReasonCode,
} from '../investorAnnouncement';
import { investorForUrl, normalizeHost, registeredFeeds, INVESTOR_REGISTRY } from '../investorRegistry';
import type { SourceFailureKind } from '../errors';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Financing announcements published by the investors who took part in
 * them, read from each firm's own public feed.
 *
 * This adapter fetches and reports; every judgement about whether an item
 * is investor-primary evidence lives in ../investorAnnouncement.ts, which
 * is pure and therefore testable against the real announcement text.
 *
 * Only feeds listed in ../investorRegistry.ts are read, each one probed
 * for a robots.txt that permits it. Nothing here bypasses a login, a
 * paywall, or an access restriction, and no article page is fetched — the
 * feed carries the title, summary, link, and date, which is the material
 * a feed exists to syndicate.
 */

const UA = 'vamos-deal-radar (investor newsroom reader; contact: vamosventures.com)';

export function configuredInvestorFeeds(): string[] {
  const raw = env.INVESTOR_NEWS_FEEDS;
  if (!raw) return registeredFeeds();
  // An override is still subject to the registry: a feed on an
  // unregistered domain cannot produce investor-primary evidence, so
  // accepting one would only manufacture rejections.
  return raw
    .split(',').map((s) => s.trim())
    .filter((s) => z.string().url().safeParse(s).success)
    .filter((s) => investorForUrl(s) !== null);
}

export interface InvestorFeedReport {
  url: string;
  host: string;
  investor: string | null;
  status: 'ok' | 'failed';
  format: 'rss' | 'atom' | 'unknown' | null;
  items: number;
  events: number;
  rejections: Record<string, number>;
  failure?: SourceFailureKind;
  detail: string;
  /** Share of items that were not investor-primary financing events. 0–1. */
  failureRate: number;
}

export interface InvestorRunReport {
  feeds: InvestorFeedReport[];
  itemsRetrieved: number;
  eventsExtracted: number;
  eventsAfterMerge: number;
  mergedArticles: number;
  conflicted: number;
  rejections: Record<string, number>;
  deadFeeds: string[];
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Fetch and extract investor-primary funding events.
 *
 * Exported separately from the adapter so the dedicated service and the
 * live-verification script exercise the same code path the discovery
 * pipeline uses — a "live" claim that rests on a different code path is
 * not a live claim.
 */
export async function collectInvestorEvents(
  feeds: string[],
  today: string,
  maxResults: number,
): Promise<{ events: FundingEvent[]; report: InvestorRunReport; requests: number }> {
  const report: InvestorRunReport = {
    feeds: [], itemsRetrieved: 0, eventsExtracted: 0, eventsAfterMerge: 0,
    mergedArticles: 0, conflicted: 0, rejections: {}, deadFeeds: [],
  };
  const raw: FundingEvent[] = [];
  let requests = 0;

  for (const feed of feeds) {
    const investor = investorForUrl(feed);
    const host = (() => { try { return normalizeHost(new URL(feed).hostname); } catch { return feed; } })();

    // A feed that is not served from a registered domain cannot be
    // attributed to any firm, so it is refused before a request is spent.
    if (!investor) {
      report.feeds.push({
        url: feed, host, investor: null, status: 'failed', format: null, items: 0, events: 0,
        rejections: { 'investor-domain-unverified': 1 }, failure: 'not-configured',
        detail: INVESTOR_REASON_TEXT['investor-domain-unverified'], failureRate: 1,
      });
      bump(report.rejections, 'investor-domain-unverified');
      continue;
    }

    const res = await politeFetch(feed, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml' },
    });
    requests += res.requests;

    if (!res.ok) {
      const failure = res.failure ?? classifyStatus(res.status, res.body) ?? 'network';
      report.feeds.push({
        url: feed, host, investor: investor.name, status: 'failed', format: null, items: 0, events: 0,
        rejections: {},
        failure: failure === 'rate-limited-by-us' ? 'rate-limited'
          : failure === 'forbidden' || failure === 'service-unavailable' ? 'http-error'
            : failure === 'timeout' ? 'timeout' : 'network',
        detail: `HTTP ${res.status}: ${res.detail ?? INVESTOR_REASON_TEXT['feed-unreachable']}`,
        failureRate: 1,
      });
      bump(report.rejections, 'feed-unreachable');
      continue;
    }

    const parsed = parseFeed(res.body);
    const feedRejections: Record<string, number> = {};
    for (const r of parsed.rejected) { bump(feedRejections, r.code); bump(report.rejections, r.code); }

    if (parsed.format === 'unknown') {
      report.feeds.push({
        url: feed, host, investor: investor.name, status: 'failed', format: 'unknown', items: 0, events: 0,
        rejections: feedRejections, failure: 'invalid-response',
        detail: INVESTOR_REASON_TEXT['feed-not-a-feed'], failureRate: 1,
      });
      continue;
    }

    let events = 0;
    for (const item of parsed.items) {
      report.itemsRetrieved += 1;
      const out = extractInvestorEvent(item, today);
      if (!out.ok) {
        bump(feedRejections, out.rejection!.code);
        bump(report.rejections, out.rejection!.code);
        continue;
      }
      const entity = checkEntityType(out.event!.companyName);
      if (!entity.isOperatingCompany) {
        bump(feedRejections, 'not-operating-company');
        bump(report.rejections, 'not-operating-company');
        continue;
      }
      raw.push(out.event!);
      events += 1;
    }

    report.feeds.push({
      url: feed, host, investor: investor.name, status: 'ok', format: parsed.format,
      items: parsed.items.length, events, rejections: feedRejections,
      detail: `${parsed.format.toUpperCase()} feed, ${parsed.items.length} item(s), ${events} investor-primary financing event(s).`,
      failureRate: parsed.items.length > 0 ? Math.round((1 - events / parsed.items.length) * 100) / 100 : 1,
    });
    if (parsed.items.length === 0) report.deadFeeds.push(`${host} (parsed but empty)`);
  }

  report.eventsExtracted = raw.length;
  // The SAME merge the press pipeline uses, so a round announced by two
  // investors counts once — and so the conflict rules cannot differ
  // between the two families.
  const merged = mergeFundingEvents(raw);
  report.eventsAfterMerge = merged.events.length;
  report.mergedArticles = merged.mergedArticles;
  report.conflicted = merged.conflicted.length;
  for (let i = 0; i < merged.mergedArticles; i += 1) bump(report.rejections, 'duplicate-same-event');

  const ordered = [...merged.events].sort((a, b) => b.announcedAt.localeCompare(a.announcedAt));
  return { events: ordered.slice(0, maxResults), report, requests };
}

/** Human-readable summary of a run, safe to store in the run log. */
export function describeInvestorRun(report: InvestorRunReport): string {
  const perFeed = report.feeds
    .map((f) => `${f.host}${f.status === 'failed' ? ` FAILED (${f.detail.slice(0, 40)})` : `: ${f.items} items → ${f.events} events`}`)
    .join('; ');
  const reasons = Object.entries(report.rejections)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code}=${n}`)
    .join(', ');
  return [
    `${report.itemsRetrieved} item(s) across ${report.feeds.length} investor feed(s); `,
    `${report.eventsExtracted} investor-primary financing event(s), ${report.eventsAfterMerge} after merging `,
    `${report.mergedArticles} duplicate announcement(s); ${report.conflicted} with conflicting details. `,
    `Per feed — ${perFeed}. `,
    reasons ? `Non-events by reason — ${reasons}.` : '',
  ].join('');
}

function stageFor(roundType: string | null): 'Pre-seed' | 'Seed' | 'Series A' | undefined {
  if (roundType === 'Pre-seed') return 'Pre-seed';
  if (roundType === 'Seed') return 'Seed';
  if (roundType === 'Series A') return 'Series A';
  return undefined;
}

export const investorNewsAdapter: SourceAdapter = {
  id: 'investor-news',
  name: 'Investor funding announcements (official newsrooms)',
  sourceType: 'rss',

  async run(_q, budget): Promise<AdapterOutcome> {
    const feeds = configuredInvestorFeeds().slice(0, Math.max(1, budget.maxApiCalls));
    if (feeds.length === 0) {
      return {
        ok: false, failure: 'not-configured', apiCalls: 0,
        detail: `No investor feeds are configured. ${INVESTOR_REGISTRY.length} firm(s) are registered; INVESTOR_NEWS_FEEDS overrode them with nothing on a registered domain.`,
      };
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const { events, report, requests } = await collectInvestorEvents(feeds, today, budget.maxResults);

    if (!report.feeds.some((f) => f.status === 'ok')) {
      return {
        ok: false,
        failure: report.feeds[0]?.failure ?? 'network',
        apiCalls: requests,
        detail: `All ${feeds.length} investor feed(s) failed. ${describeInvestorRun(report)}`,
      };
    }

    const rawLeads = events.map((e) => {
      const primary = e.sources[0];
      return {
        sourceId: 'investor-news',
        sourceName: `${primary?.investor ?? e.publisher} (official investor announcement)`,
        sourceType: 'rss',
        sourceUrl: e.articleUrl,
        externalId: eventIdentity(e),
        companyName: e.companyName,
        description: e.evidenceExcerpt,
        vertical: e.sector ?? undefined,
        stage: stageFor(e.roundType),
        hqCity: e.hqCity ?? undefined,
        hqState: e.hqState ?? undefined,
        fundingAmount: e.amountUsd ?? undefined,
        fundingAmountText: e.amountText ?? undefined,
        lastFundingDate: e.announcedAt,
        roundType: e.roundType ?? undefined,
        investors: e.investors,
        publisher: e.publisher,
        articleTitle: e.articleTitle,
        corroboratingUrls: e.sources.map((s) => s.url).filter((u) => u !== e.articleUrl),
        conflictNotes: e.conflicts.map((c) => `Sources disagree on ${c.field}: ${c.values.join(' vs ')}`),
        nameAmbiguous: e.nameAmbiguous,
        evidenceText: e.evidenceExcerpt,
        publishedAt: `${e.announcedAt}T00:00:00.000Z`,
        discoveredAt: now,
        // A participant stating its own investment. Higher than a single
        // press report because the publisher was in the room; not higher
        // than a filing, because nothing was filed.
        confidence: independentSourceFamilies(e).length >= 2 ? 0.8 : 0.7,
      };
    });

    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: requests,
      detail: `${valid.length} investor-primary financing event(s)${rejected > 0 ? ` (${rejected} failed lead validation)` : ''}. ${describeInvestorRun(report)}`,
    };
  },
};

export type { InvestorReasonCode };
