import { z } from 'zod';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Y Combinator public company directory. YC publishes its portfolio
 * for public browsing; this adapter queries the same public endpoint
 * the directory uses (no login, no scraping of restricted pages).
 * If the endpoint is unavailable the source fails honestly.
 */

const responseSchema = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      website: z.string().optional().nullable(),
      one_liner: z.string().optional().nullable(),
      batch: z.string().optional().nullable(),
    }).loose(),
  ).default([]),
}).loose();

export const ycAdapter: SourceAdapter = {
  id: 'yc',
  name: 'Y Combinator public directory',
  sourceType: 'directory',

  async run(q, budget): Promise<AdapterOutcome> {
    const term = q.terms[0] ?? q.subcategory ?? q.vertical ?? 'startup';
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
    const rawLeads = parsed.data.companies.slice(0, budget.maxResults).map((r) => ({
      sourceId: 'yc',
      sourceName: 'Y Combinator public directory',
      sourceType: 'directory',
      sourceUrl: `https://www.ycombinator.com/companies?q=${encodeURIComponent(r.name)}`,
      companyName: r.name,
      companyWebsite: r.website && z.string().url().safeParse(r.website).success ? r.website : undefined,
      description: r.one_liner ?? undefined,
      accelerator: `Y Combinator${r.batch ? ` (${r.batch})` : ''}`,
      evidenceText: `Listed in the public YC directory${r.batch ? `, batch ${r.batch}` : ''}.`,
      discoveredAt: now,
      confidence: 0.7,
    }));
    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} public YC directory entr${valid.length === 1 ? 'y' : 'ies'} for "${term}"${rejected > 0 ? ` (${rejected} invalid rejected)` : ''}.`,
    };
  },
};
