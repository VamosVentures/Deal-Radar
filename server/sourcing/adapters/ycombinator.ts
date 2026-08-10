import { z } from 'zod';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import { classifyFromTaxonomy } from '../classify';
import { resolveQueryTerm } from '../verticalQueries';
import { resolveCityState } from '../../enrichment/companyFacts';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Y Combinator public company directory. YC publishes its portfolio
 * for public browsing; this adapter queries the same public endpoint
 * the directory uses (no login, no scraping of restricted pages).
 * If the endpoint is unavailable the source fails honestly.
 */

// Field names verified against a real response on 2026-07-28. The
// previous schema read `one_liner` (snake_case), which this API does
// NOT return — it returns `oneLiner`. Every YC company therefore
// arrived with no description at all, which in turn left the sector
// classifier nothing to work with outside the company's own name.
const responseSchema = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      website: z.string().optional().nullable(),
      oneLiner: z.string().optional().nullable(),
      longDescription: z.string().optional().nullable(),
      batch: z.string().optional().nullable(),
      slug: z.string().optional().nullable(),
      url: z.string().optional().nullable(),
      status: z.string().optional().nullable(),
      teamSize: z.number().optional().nullable(),
      industries: z.array(z.string()).optional().nullable(),
      tags: z.array(z.string()).optional().nullable(),
      locations: z.array(z.string()).optional().nullable(),
    }).loose(),
  ).default([]),
}).loose();

/**
 * YC batch code → an approximate start date, so a batch can be judged for
 * recency. "S26" is Summer 2026; "W12" is Winter 2012.
 *
 * The day is deliberately the 1st and the result is labelled approximate
 * wherever it is shown: YC publishes a batch season, not a date, and
 * inventing a precise day would be exactly the kind of false precision
 * this codebase avoids. It is accurate enough to answer "is this batch
 * recent?", which is the only question asked of it.
 */
function parseBatch(batch: string | null | undefined): { year: number; season: string } | null {
  if (!batch) return null;
  // 'P' (Pioneer-style batches, e.g. "P25") uses the same code shape as
  // the standard W/S/F seasons and is just as parseable — it was missing
  // here, which silently dropped ~5% of YC batches from every batch-derived
  // computation (recency and, since founded years are backfilled from this
  // same code, founding-year estimates too).
  const m = batch.trim().match(/^(W|S|F|Sp|P|X)(\d{2})$/i);
  if (!m) return null;
  const season = m[1].toUpperCase();
  const yy = Number(m[2]);
  // YC batch codes are 2-digit years; every batch is post-2005, so a
  // 2-digit year maps unambiguously into the 2000s.
  const year = 2000 + yy;
  return { year, season };
}

export function batchToApproxDate(batch: string | null | undefined): string | null {
  const parsed = parseBatch(batch);
  if (!parsed) return null;
  const { year, season } = parsed;
  const month = season === 'W' ? '01' : season === 'SP' ? '04' : season === 'S' ? '06' : season === 'F' ? '09' : season === 'P' ? '01' : '01';
  return `${year}-${month}-01`;
}

/**
 * Just the year out of a YC batch code, e.g. "W23" -> 2023. Used as a
 * founding-year proxy when a company's real founding date isn't public:
 * founders typically apply to YC within a year or so of starting the
 * company, so the batch year is a far better estimate than "unknown."
 */
export function batchToYear(batch: string | null | undefined): number | null {
  return parseBatch(batch)?.year ?? null;
}

/**
 * "San Francisco, CA, USA" → { city, state }, via the ONE shared
 * resolver the rest of the app already uses.
 *
 * This adapter previously had its own parser that took `parts[0]` as the
 * city and a state only when some comma-part was two uppercase letters.
 * The YC directory returns a bare city for most of its portfolio
 * (`["Los Angeles"]`, `["San Francisco"]`, `["New York City"]`), so that
 * parser produced a city with NO state for almost every YC company —
 * and geography is scored on the STATE. The visible result was a record
 * displaying "Los Angeles" while its geography component read
 * "not assessable", which looks like a contradiction and is really two
 * different location parsers disagreeing.
 *
 * `resolveCityState` is the curated, already-tested resolver
 * (server/enrichment/companyFacts.ts) the stored-company enrichment path
 * uses. It maps a short list of unambiguous US cities to their state and
 * returns a NULL state for anything else — a London company keeps its
 * city and gets no invented state. Using it here removes the duplicate
 * parser rather than adding a third.
 */
function splitLocation(loc?: string | null): { city?: string; state?: string } {
  if (!loc) return {};
  const resolved = resolveCityState(loc);
  if (!resolved) return {};
  return { city: resolved.city, state: resolved.state ?? undefined };
}

export const ycAdapter: SourceAdapter = {
  id: 'yc',
  name: 'Y Combinator public directory',
  sourceType: 'directory',

  async run(q, budget): Promise<AdapterOutcome> {
    // An explicit user term still wins; otherwise the vertical/source
    // strategy supplies a precise product-and-evidence phrase instead of
    // the bare sector word this used to send (see verticalQueries.ts).
    const term = resolveQueryTerm(q.terms, q.vertical, 'yc', q.subcategory ?? q.vertical ?? 'startup');
    const url = `https://api.ycombinator.com/v0.1/companies?q=${encodeURIComponent(term)}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'vamos-deal-radar' } }, 8000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `YC directory: ${message}` };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `YC directory: ${message}` };
    }
    const body = await readJson(res);
    if (!body.ok) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'YC directory returned a non-JSON body.' };
    const parsed = validateExternal(responseSchema, body.data, 'YC public directory', 1);
    if (!parsed.ok) return parsed.failure;

    const now = new Date().toISOString();

    // Inactive YC companies are shut down or acquired — they are not
    // investable deals, so they are dropped here rather than shown to a
    // reviewer who would have to work that out for themselves.
    const active = parsed.data.companies.filter((r) => (r.status ?? 'Active') !== 'Inactive');
    const inactiveDropped = parsed.data.companies.length - active.length;

    /**
     * Batch-recency gate.
     *
     * The YC directory is a permanent alumni register, not a feed of new
     * companies, and nothing here previously said so. A direct audit of
     * this database found 70 of 111 stored YC records came from batches
     * S09–W23 — Brex (W17), Deel (W19), HealthSherpa and Newfront (W15)
     * are all sitting in the pipeline labelled "Early-stage — round not
     * publicly disclosed", scoring in the top band. They are real
     * companies and the directory is telling the truth about them; they
     * are simply a decade past the stage this firm leads.
     *
     * `dateFrom` is the query's existing "only things at least this
     * recent" control, and batchToApproxDate already turns a batch code
     * into a comparable date, so this needs no new knob — it just
     * connects two things that were never wired together. A company
     * whose batch cannot be parsed is KEPT, because an unreadable batch
     * code is a gap in the listing, not evidence of age.
     */
    const withinBatchWindow = active.filter((r) => {
      if (!q.dateFrom) return true;
      const approx = batchToApproxDate(r.batch);
      return approx === null || approx >= q.dateFrom;
    });
    const staleBatchDropped = active.length - withinBatchWindow.length;

    const rawLeads = withinBatchWindow.slice(0, budget.maxResults).map((r) => {
      const labels = [...(r.industries ?? []), ...(r.tags ?? [])];
      // YC's own category labels are structured evidence and beat
      // guessing from the name. Only a confident mapping is used.
      const taxonomy = classifyFromTaxonomy(labels);
      const { city, state } = splitLocation(r.locations?.[0]);
      const descriptionParts = [r.oneLiner, r.longDescription].filter(Boolean);
      return {
        sourceId: 'yc',
        sourceName: 'Y Combinator public directory',
        sourceType: 'directory',
        // The company's OWN page, not a search-results URL. A generic
        // "?q=Name" link is not evidence of anything in particular — it
        // is a query that happens to return the company today.
        sourceUrl: r.url && z.string().url().safeParse(r.url).success
          ? r.url
          : (r.slug ? `https://www.ycombinator.com/companies/${r.slug}` : `https://www.ycombinator.com/companies?q=${encodeURIComponent(r.name)}`),
        companyName: r.name,
        companyWebsite: r.website && z.string().url().safeParse(r.website).success ? r.website : undefined,
        description: descriptionParts.length > 0 ? descriptionParts.join(' — ').slice(0, 500) : undefined,
        vertical: taxonomy.confidence >= 0.5 ? taxonomy.vertical ?? undefined : undefined,
        subcategory: labels.length > 0 ? labels.slice(0, 3).join(', ') : undefined,
        hqCity: city,
        hqState: state,
        teamSize: r.teamSize ?? undefined,
        accelerator: `Y Combinator${r.batch ? ` (${r.batch})` : ''}`,
        evidenceText: [
          `Listed in the public YC directory${r.batch ? `, batch ${r.batch}` : ''}.`,
          labels.length > 0 ? `YC categories: ${labels.join(', ')}.` : '',
          r.oneLiner ? `YC one-liner: ${r.oneLiner}` : '',
        ].filter(Boolean).join(' '),
        // A batch season is the only dated fact a directory listing
        // carries. Without it, this record cannot establish currency and
        // the classifier will (correctly) treat it as a company lead.
        publishedAt: batchToApproxDate(r.batch) ?? undefined,
        retrievedAt: now.slice(0, 10),
        discoveredAt: now,
        confidence: 0.7,
      };
    });
    const { valid, rejected } = validateLeads(rawLeads);
    const classified = rawLeads.filter((l) => l.vertical).length;
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} active public YC directory entr${valid.length === 1 ? 'y' : 'ies'} for "${term}"`
        + ` (${classified} sector-classified from YC's own categories`
        + `${inactiveDropped > 0 ? `; ${inactiveDropped} inactive dropped` : ''}`
        + `${staleBatchDropped > 0 ? `; ${staleBatchDropped} dropped as alumni from batches earlier than ${q.dateFrom}` : ''}`
        + `${rejected > 0 ? `; ${rejected} invalid rejected` : ''}).`,
    };
  },
};
