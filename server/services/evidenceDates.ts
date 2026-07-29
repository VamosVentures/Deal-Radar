import { getDb } from '../db/client';
import { politeFetch } from '../sourcing/politeness';
import { parseFeed } from '../sourcing/fundingEvent';
import { configuredFeeds } from '../sourcing/adapters/rss';
import { addDealEvidence, listDealEvidence } from '../db/repos/opportunities';

/**
 * Filling in publication dates the RSS date bug left empty.
 *
 * Phase 14 fixed the parser, but a fix to the parser cannot repair rows
 * already written: `addDealEvidence` deduplicates on (company, url,
 * type), so a later run re-reading the very same article found the row
 * already present and moved on. Two records — Natural and Enigma — were
 * left holding a real TechCrunch article with `published_at` NULL, and
 * an undated article cannot establish currency, so both were pinned to
 * "company lead" no matter what else was true about them.
 *
 * The date is not inferred, derived from the URL path, or guessed from
 * when we happened to fetch something. It is read back from the
 * PUBLISHER'S OWN FEED — the same `<pubDate>` the fixed parser would
 * have stored the first time. If the article has since rolled off the
 * feed, the row keeps its NULL and the company stays honestly blocked.
 *
 * Only funding-news rows are considered, because they are the only ones
 * whose dates come from a feed. Only NULL → non-null is written; the
 * storage layer enforces that, not this module.
 */

const UA = 'vamos-deal-radar (RSS reader; contact: vamosventures.com)';

export interface UndatedEvidenceRow {
  companyId: string;
  companyName: string;
  url: string;
  opportunityType: string;
}

/** Stored funding-news evidence that carries no publication date. */
export function undatedFundingNewsEvidence(): UndatedEvidenceRow[] {
  return getDb().prepare(`
    SELECT e.company_id AS companyId, c.name AS companyName, e.url AS url,
           e.opportunity_type AS opportunityType
      FROM deal_evidence e
      JOIN companies c ON c.id = e.company_id
     WHERE e.source_id = 'funding-news' AND e.published_at IS NULL
     ORDER BY c.name
  `).all() as unknown as UndatedEvidenceRow[];
}

export interface DateBackfillResult {
  /** Rows that were missing a date when the pass started. */
  considered: UndatedEvidenceRow[];
  filled: { companyId: string; companyName: string; url: string; publishedAt: string; feed: string }[];
  /** Still undated, with the reason — an article that has rolled off its feed. */
  unresolved: { companyId: string; companyName: string; url: string; detail: string }[];
  feedsRead: number;
  requests: number;
}

/**
 * Re-read the configured feeds and fill any missing publication date
 * whose article is still being syndicated.
 */
export async function backfillPublicationDates(
  opts: { dryRun?: boolean; onProgress?: (line: string) => void } = {},
): Promise<DateBackfillResult> {
  const considered = undatedFundingNewsEvidence();
  const result: DateBackfillResult = {
    considered, filled: [], unresolved: [], feedsRead: 0, requests: 0,
  };
  if (considered.length === 0) return result;

  // url → full ISO timestamp, as the publisher stated it.
  const dateByUrl = new Map<string, { publishedAt: string; feed: string }>();
  const wanted = new Set(considered.map((r) => r.url));

  for (const feed of configuredFeeds()) {
    // Every wanted URL is accounted for; no reason to keep spending
    // requests on the remaining feeds.
    if (wanted.size === 0) break;
    result.requests += 1;
    const res = await politeFetch(feed, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
    if (!res.ok) {
      opts.onProgress?.(`${feed}: ${res.failure ?? res.status} — skipped`);
      continue;
    }
    result.feedsRead += 1;
    const parsed = parseFeed(res.body);
    for (const item of parsed.items) {
      // parseFeed has already normalized <pubDate>/<published> to a full
      // ISO timestamp, or to null when it could not be parsed.
      if (!wanted.has(item.link) || !item.publishedAt) continue;
      dateByUrl.set(item.link, { publishedAt: item.publishedAt, feed });
      wanted.delete(item.link);
    }
    opts.onProgress?.(`${feed}: ${parsed.items.length} item(s), ${dateByUrl.size}/${considered.length} matched so far`);
  }

  for (const row of considered) {
    const hit = dateByUrl.get(row.url);
    if (!hit) {
      result.unresolved.push({
        companyId: row.companyId,
        companyName: row.companyName,
        url: row.url,
        detail: 'The article is no longer carried by any configured feed, so its publication date cannot be read from the publisher. Left undated rather than inferred from the URL.',
      });
      continue;
    }
    const day = hit.publishedAt.slice(0, 10);
    if (!opts.dryRun) {
      // Written back through the same append-only storage path, which
      // permits a NULL date to be filled and nothing else. Re-using the
      // stored row's own fields means this cannot accidentally create a
      // second evidence row or restate the claim.
      const stored = listDealEvidence(row.companyId)
        .find((e) => e.url === row.url && e.opportunityType === row.opportunityType);
      if (!stored) continue;
      const { dateBackfilled } = addDealEvidence(row.companyId, { ...stored, publishedAt: day });
      if (!dateBackfilled) continue;
    }
    result.filled.push({
      companyId: row.companyId, companyName: row.companyName,
      url: row.url, publishedAt: day, feed: hit.feed,
    });
  }
  return result;
}
