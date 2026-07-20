import { z } from 'zod';
import { env } from '../../env';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * SEC EDGAR full-text search (efts.sec.gov), Form D filings. Public
 * government data with documented programmatic access; the SEC asks
 * automated clients to identify themselves via User-Agent (set
 * SEC_CONTACT_EMAIL) and to stay under 10 requests/second — this
 * adapter makes exactly one request per run.
 *
 * A Form D hit yields: company name + CIK (from display_names) and a
 * real filing-index URL a human can open. Everything else stays
 * Unknown — a filing proves an exempt offering was reported, nothing
 * more.
 */

const responseSchema = z.object({
  hits: z.object({
    hits: z.array(
      z.object({
        _id: z.string(),
        _source: z.object({
          display_names: z.array(z.string()).default([]),
          file_date: z.string().optional(),
          adsh: z.string().optional(),
          ciks: z.array(z.string()).default([]),
          /** Filer business state(s) as recorded on the filing, e.g. ["NM"]. */
          biz_states: z.array(z.string()).default([]),
        }).loose(),
      }),
    ),
  }).loose(),
}).loose();

/** "Acme Robotics Inc (CIK 0001234567)" → { name, cik } */
export function parseDisplayName(display: string): { name: string; cik: string | null } {
  const m = display.match(/^(.*?)\s*\(CIK\s*(\d+)\)\s*$/i);
  if (!m) return { name: display.trim(), cik: null };
  return { name: m[1].trim(), cik: m[2] };
}

export function filingIndexUrl(cik: string | null, adsh: string | undefined): string | null {
  if (!cik || !adsh) return null;
  const accessionNoDashes = adsh.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${adsh}-index.htm`;
}

export const secAdapter: SourceAdapter = {
  id: 'sec',
  name: 'SEC EDGAR (Form D)',
  sourceType: 'filing',

  async run(q, budget): Promise<AdapterOutcome> {
    const term = q.terms[0] ?? q.subcategory ?? q.vertical ?? 'technology';
    const params = new URLSearchParams({ q: `"${term}"`, forms: 'D' });
    // Full-text search is relevance-ranked; without a date window it
    // surfaces decade-old filings. Default to the last 18 months.
    // EFTS applies the window only when BOTH bounds are present.
    const defaultFrom = new Date(Date.now() - 540 * 86_400_000).toISOString().slice(0, 10);
    params.set('startdt', q.dateFrom ?? defaultFrom);
    params.set('enddt', q.dateTo ?? new Date().toISOString().slice(0, 10));
    const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
    const contact = env.SEC_CONTACT_EMAIL ?? 'contact-not-configured@example.com';

    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': `vamos-deal-radar research (${contact})` },
      }, 8000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `SEC EDGAR: ${message}` };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `SEC EDGAR: ${message}` };
    }
    const body = await readJson(res);
    if (!body.ok) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'SEC EDGAR returned a non-JSON body.' };
    const parsed = validateExternal(responseSchema, body.data, 'SEC EDGAR full-text search', 1);
    if (!parsed.ok) return parsed.failure;

    const now = new Date().toISOString();
    const rawLeads = parsed.data.hits.hits.slice(0, budget.maxResults).flatMap((hit) => {
      const display = hit._source.display_names[0];
      if (!display) return [];
      const { name, cik } = parseDisplayName(display);
      const filingUrl = filingIndexUrl(cik, hit._source.adsh ?? hit._id.split(':')[0]);
      if (!filingUrl) return []; // no verifiable URL → no lead, ever
      const bizState = hit._source.biz_states.find((s) => /^[A-Z]{2}$/.test(s));
      return [{
        sourceId: 'sec',
        sourceName: 'SEC EDGAR (Form D)',
        sourceType: 'filing',
        sourceUrl: filingUrl,
        externalId: hit._source.adsh ?? hit._id,
        companyName: name,
        hqState: bizState,
        lastFundingDate: hit._source.file_date && /^\d{4}-\d{2}-\d{2}$/.test(hit._source.file_date) ? hit._source.file_date : undefined,
        evidenceText: `Form D (exempt offering) filed with the SEC${hit._source.file_date ? ` on ${hit._source.file_date}` : ''} matching "${term}".`,
        publishedAt: hit._source.file_date,
        discoveredAt: now,
        confidence: 0.6,
      }];
    });
    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} Form D filing(s) matching "${term}" with verifiable filing URLs${rejected > 0 ? ` (${rejected} invalid item(s) rejected)` : ''}. A filing proves a reported offering, nothing more — all other fields stay Unknown.`,
    };
  },
};
