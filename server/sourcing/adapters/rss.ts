import { z } from 'zod';
import { env } from '../../env';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus, type SourceFailureKind } from '../errors';
import { validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Public RSS feeds of startup funding announcements. RSS is published
 * explicitly for syndication; this adapter stores only the headline,
 * link, and publish date as evidence — never article bodies.
 *
 * A lead is created ONLY when the headline itself states a funding
 * event in a parseable form ("Acme raises $5M …"). Headlines that
 * don't match are skipped — company names are never guessed.
 *
 * Feeds are configurable via FUNDING_NEWS_FEEDS (comma-separated).
 */

// Verified reachable without bot-blocking (checked 2026-07-17). Feeds
// that reject automated readers (e.g. via 403) are simply not listed —
// we do not work around anti-bot protections.
export const DEFAULT_FEEDS = [
  'https://techcrunch.com/category/venture/feed/',
  'https://techcrunch.com/category/startups/feed/',
];

export function configuredFeeds(): string[] {
  const raw = env.FUNDING_NEWS_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw.split(',').map((s) => s.trim()).filter((s) => z.string().url().safeParse(s).success);
}

// ── Minimal RSS <item> extraction (title / link / pubDate) ───────

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"');
}

export interface RssItem { title: string; link: string; pubDate?: string }

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const pick = (tag: string): string | undefined => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(stripCdata(m[1])) : undefined;
    };
    const title = pick('title');
    const link = pick('link');
    if (!title || !link || !z.string().url().safeParse(link).success) continue;
    items.push({ title, link, pubDate: pick('pubDate') });
  }
  return items;
}

// ── Funding-headline extraction (no guessing) ────────────────────

const FUNDING_PATTERN =
  /^(.{2,60}?)\s+(?:raises|raised|lands|secures|closes|nabs|gets|banks)\s+(?:an?\s+)?\$([\d.,]+)\s*(k|m|b|million|billion|thousand)?\b/i;

export function extractFunding(title: string): { companyName: string; amount: number; amountText: string } | null {
  const m = title.match(FUNDING_PATTERN);
  if (!m) return null;
  const base = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = (m[3] ?? '').toLowerCase();
  const multiplier = unit.startsWith('b') ? 1e9 : unit.startsWith('m') ? 1e6 : unit.startsWith('k') || unit.startsWith('t') ? 1e3 : 1;
  const companyName = m[1].replace(/^(exclusive|report|breaking)[:,]\s*/i, '').trim();
  if (companyName.length < 2) return null;
  return {
    companyName,
    amount: Math.round(base * multiplier),
    amountText: `$${m[2]}${m[3] ? m[3].toUpperCase().slice(0, 1) : ''} (as stated in headline)`,
  };
}

function toIsoDate(pubDate?: string): string | undefined {
  if (!pubDate) return undefined;
  const d = new Date(pubDate);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
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
    const rawLeads: unknown[] = [];
    const feedNotes: string[] = [];
    let apiCalls = 0;
    let anySuccess = false;
    let lastFailure: { kind: SourceFailureKind; message: string } | null = null;

    for (const feed of feeds) {
      apiCalls += 1;
      let res: Response;
      try {
        res = await fetchWithTimeout(feed, { headers: { 'User-Agent': 'vamos-deal-radar (RSS reader)' } }, 8000);
      } catch (e) {
        lastFailure = classifyFetchError(e);
        feedNotes.push(`${feedHost(feed)}: ${lastFailure.message}`);
        continue;
      }
      if (!res.ok) {
        lastFailure = classifyHttpStatus(res);
        feedNotes.push(`${feedHost(feed)}: ${lastFailure.message}`);
        continue;
      }
      const xml = await res.text().catch(() => '');
      const items = parseRssItems(xml);
      if (items.length === 0 && !/<(rss|feed)[\s>]/i.test(xml)) {
        lastFailure = { kind: 'invalid-response', message: 'Body is not an RSS/Atom feed.' };
        feedNotes.push(`${feedHost(feed)}: not a valid feed.`);
        continue;
      }
      anySuccess = true;
      let matched = 0;
      for (const item of items) {
        const funding = extractFunding(item.title);
        if (!funding) continue; // headline doesn't state a funding event — skip, never guess
        matched += 1;
        rawLeads.push({
          sourceId: 'funding-news',
          sourceName: `Public RSS: ${feedHost(feed)}`,
          sourceType: 'rss',
          sourceUrl: item.link,
          companyName: funding.companyName,
          fundingAmount: funding.amount,
          fundingAmountText: funding.amountText,
          evidenceText: `Headline: "${item.title}"`,
          publishedAt: toIsoDate(item.pubDate),
          discoveredAt: now,
          confidence: 0.5, // headline claim, unverified
        });
      }
      feedNotes.push(`${feedHost(feed)}: ${items.length} item(s), ${matched} funding headline(s)`);
    }

    if (!anySuccess) {
      return {
        ok: false,
        failure: lastFailure?.kind ?? 'network',
        apiCalls,
        detail: `All ${feeds.length} configured feed(s) failed. ${feedNotes.join('; ')}`,
      };
    }
    const { valid, rejected } = validateLeads(rawLeads.slice(0, budget.maxResults));
    return {
      ok: true,
      leads: valid,
      apiCalls,
      detail: `${valid.length} funding headline(s) from public RSS${rejected > 0 ? ` (${rejected} invalid rejected)` : ''}. ${feedNotes.join('; ')}. Headlines are unverified claims until reviewed.`,
    };
  },
};

function feedHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
