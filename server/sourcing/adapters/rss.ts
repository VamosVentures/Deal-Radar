import { z } from 'zod';
import { env } from '../../env';
import { politeFetch, classifyStatus } from '../politeness';
import { validateLeads } from '../validate';
import { checkEntityType } from '../classify';
import {
  parseFeed, extractFundingEvent, mergeFundingEvents, eventIdentity, independentPublishers,
  RSS_REASON_TEXT, type FundingEvent, type RssReasonCode,
} from '../fundingEvent';
import type { SourceFailureKind } from '../errors';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Funding announcements from public RSS/Atom feeds.
 *
 * History matters here. The first version of this adapter matched a
 * regex against headlines and returned whatever prefix preceded the word
 * "raises". It reported 77 candidates and produced zero opportunities,
 * and its "candidates" included things like "Edtech platform" and
 * "Travis Kalanick's robotics company". Nothing in the run report said
 * so, because there were no failure reasons to report.
 *
 * This version:
 *  - parses RSS and Atom with each format's own field names,
 *  - extracts a structured funding event (see ../fundingEvent.ts) and
 *    rejects non-events with a named reason code,
 *  - merges syndicated copies so one round counts once, and
 *  - reports per-feed item counts, event counts, and failure reasons.
 *
 * Only feeds whose publisher permits automated reading are listed, and
 * only the headline, summary, link, and date are stored — the material
 * a feed exists to syndicate. Article bodies are not fetched.
 */

/**
 * Default feeds, each probed live on 2026-07-29: reachable, returns a
 * parseable feed, and its robots.txt does not disallow the feed path.
 *
 * Deliberately excluded, with reasons, because an honest gap is better
 * than a silently broken source:
 *  - tech.eu           robots.txt disallows /feed
 *  - eu-startups.com   robots.txt returns 403, so permission is unverifiable
 *  - finsmes.com       403 to automated readers
 *  - axios.com         403 to automated readers
 *  - news.crunchbase.com  reachable, but Crunchbase is a RESTRICTED_SOURCE
 *                      for this project and that rule is not bent for the
 *                      editorial arm
 *  - venturebeat.com   reachable and permitted, but produced 0 funding
 *                      events across a full feed — it does not cover
 *                      rounds, so it would only cost a request
 *
 * The TechCrunch category feeds are one publisher and therefore ONE
 * source family; the additional publishers are what make independent
 * corroboration of a financing event possible at all.
 */
export const DEFAULT_FEEDS = [
  'https://techcrunch.com/category/venture/feed/',
  'https://techcrunch.com/category/startups/feed/',
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://techcrunch.com/category/fintech/feed/',
  'https://techcrunch.com/category/climate/feed/',
  'https://techcrunch.com/category/space/feed/',
  'https://techcrunch.com/category/robotics/feed/',
  'https://techcrunch.com/category/enterprise/feed/',
  'https://techcrunch.com/category/transportation/feed/',
  'https://techfundingnews.com/feed/',
  'https://siliconangle.com/feed/',
  'https://sifted.eu/feed',
];

/** Publishers approved as tier-2 sources for a financing claim. */
export const APPROVED_PUBLISHERS = [
  'techcrunch.com', 'techfundingnews.com', 'siliconangle.com', 'sifted.eu',
];

export function configuredFeeds(): string[] {
  const raw = env.FUNDING_NEWS_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw.split(',').map((s) => s.trim()).filter((s) => z.string().url().safeParse(s).success);
}

const UA = 'vamos-deal-radar (RSS reader; contact: vamosventures.com)';

// ── Per-feed health, reported honestly ────────────────────────────

export interface FeedReport {
  url: string;
  host: string;
  status: 'ok' | 'failed';
  format: 'rss' | 'atom' | 'unknown' | null;
  items: number;
  events: number;
  /** Rejections by reason code for this feed. */
  rejections: Record<string, number>;
  failure?: SourceFailureKind;
  detail: string;
  /** Share of items that were not financing events. 0–1. */
  failureRate: number;
}

export interface RssRunReport {
  feeds: FeedReport[];
  articlesRetrieved: number;
  eventsExtracted: number;
  eventsAfterMerge: number;
  mergedArticles: number;
  conflicted: number;
  rejections: Record<string, number>;
  /** Feeds that returned nothing usable across the whole run. */
  deadFeeds: string[];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Fetch and extract funding events from the configured feeds.
 *
 * Exported separately from the adapter so live verification and the
 * dedicated funding-news service can use the same code path the
 * discovery pipeline uses — a "live" claim that rests on a different
 * code path is not a live claim.
 */
export async function collectFundingEvents(
  feeds: string[],
  today: string,
  maxResults: number,
): Promise<{ events: FundingEvent[]; report: RssRunReport; requests: number }> {
  const report: RssRunReport = {
    feeds: [], articlesRetrieved: 0, eventsExtracted: 0, eventsAfterMerge: 0,
    mergedArticles: 0, conflicted: 0, rejections: {}, deadFeeds: [],
  };
  const raw: FundingEvent[] = [];
  let requests = 0;

  for (const feed of feeds) {
    const host = hostOf(feed);
    const res = await politeFetch(feed, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
    requests += res.requests;

    if (!res.ok) {
      const failure = res.failure ?? classifyStatus(res.status, res.body) ?? 'network';
      report.feeds.push({
        url: feed, host, status: 'failed', format: null, items: 0, events: 0, rejections: {},
        failure: failure === 'rate-limited-by-us' ? 'rate-limited' : failure === 'forbidden' ? 'http-error' : failure === 'service-unavailable' ? 'http-error' : failure === 'timeout' ? 'timeout' : 'network',
        detail: `HTTP ${res.status}: ${res.detail ?? RSS_REASON_TEXT['feed-unreachable']}`,
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
        url: feed, host, status: 'failed', format: 'unknown', items: 0, events: 0,
        rejections: feedRejections, failure: 'invalid-response',
        detail: RSS_REASON_TEXT['feed-not-a-feed'], failureRate: 1,
      });
      continue;
    }

    let events = 0;
    for (const item of parsed.items) {
      report.articlesRetrieved += 1;
      const out = extractFundingEvent(item, today);
      if (!out.ok) { bump(feedRejections, out.rejection.code); bump(report.rejections, out.rejection.code); continue; }
      // Funds, universities, and government bodies are excluded on the
      // published name, the same rule every other source obeys.
      const entity = checkEntityType(out.event.companyName);
      if (!entity.isOperatingCompany) {
        bump(feedRejections, 'not-operating-company');
        bump(report.rejections, 'not-operating-company');
        continue;
      }
      raw.push(out.event);
      events += 1;
    }

    report.feeds.push({
      url: feed, host, status: 'ok', format: parsed.format,
      items: parsed.items.length, events, rejections: feedRejections,
      detail: `${parsed.format.toUpperCase()} feed, ${parsed.items.length} item(s), ${events} funding event(s).`,
      failureRate: parsed.items.length > 0 ? Math.round((1 - events / parsed.items.length) * 100) / 100 : 1,
    });
    if (parsed.items.length === 0) report.deadFeeds.push(`${host} (parsed but empty)`);
  }

  report.eventsExtracted = raw.length;
  const merged = mergeFundingEvents(raw);
  report.eventsAfterMerge = merged.events.length;
  report.mergedArticles = merged.mergedArticles;
  report.conflicted = merged.conflicted.length;
  for (let i = 0; i < merged.mergedArticles; i += 1) bump(report.rejections, 'duplicate-same-event');

  // Newest first, so a capped run keeps the most current events.
  const ordered = [...merged.events].sort((a, b) => b.announcedAt.localeCompare(a.announcedAt));
  return { events: ordered.slice(0, maxResults), report, requests };
}

/** Human-readable summary of a run, safe to store in the run log. */
export function describeRssRun(report: RssRunReport): string {
  const perFeed = report.feeds
    .map((f) => `${f.host}${f.status === 'failed' ? ` FAILED (${f.detail.slice(0, 40)})` : `: ${f.items} items → ${f.events} events (${Math.round(f.failureRate * 100)}% not events)`}`)
    .join('; ');
  const reasons = Object.entries(report.rejections)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code}=${n}`)
    .join(', ');
  return [
    `${report.articlesRetrieved} article(s) across ${report.feeds.length} feed(s); `,
    `${report.eventsExtracted} funding event(s) extracted, ${report.eventsAfterMerge} after merging `,
    `${report.mergedArticles} duplicate article(s); ${report.conflicted} with conflicting details. `,
    `Per feed — ${perFeed}. `,
    reasons ? `Non-events by reason — ${reasons}.` : '',
  ].join('');
}

/** Round labels the pipeline's Stage enum can represent. Others stay unset. */
function stageFor(roundType: string | null): 'Pre-seed' | 'Seed' | 'Series A' | undefined {
  if (roundType === 'Pre-seed') return 'Pre-seed';
  if (roundType === 'Seed') return 'Seed';
  if (roundType === 'Series A') return 'Series A';
  return undefined;
}

export const rssAdapter: SourceAdapter = {
  id: 'funding-news',
  name: 'Public funding announcements (RSS)',
  sourceType: 'rss',

  async run(_q, budget): Promise<AdapterOutcome> {
    // Feeds are firehoses of announcements; the query's vertical/stage
    // filters apply later in the pipeline, not at fetch time.
    const feeds = configuredFeeds().slice(0, Math.max(1, budget.maxApiCalls));
    if (feeds.length === 0) {
      return { ok: false, failure: 'not-configured', apiCalls: 0, detail: 'No RSS feeds are configured (FUNDING_NEWS_FEEDS is empty/invalid).' };
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const { events, report, requests } = await collectFundingEvents(feeds, today, budget.maxResults);

    const anySuccess = report.feeds.some((f) => f.status === 'ok');
    if (!anySuccess) {
      const first = report.feeds[0];
      return {
        ok: false,
        failure: first?.failure ?? 'network',
        apiCalls: requests,
        detail: `All ${feeds.length} configured feed(s) failed. ${describeRssRun(report)}`,
      };
    }

    const rawLeads = events.map((e) => ({
      sourceId: 'funding-news',
      sourceName: `${e.publisher} (public RSS)`,
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
      // A single named publication reporting a round. Real evidence, not
      // yet corroborated — the classifier decides what that is worth.
      confidence: independentPublishers(e).length >= 2 ? 0.75 : 0.55,
    }));

    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: requests,
      detail: `${valid.length} funding event(s)${rejected > 0 ? ` (${rejected} failed lead validation)` : ''}. ${describeRssRun(report)}`,
    };
  },
};

/** Re-exported so callers can name reason codes without importing two modules. */
export type { RssReasonCode };
