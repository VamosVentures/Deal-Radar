import { z } from 'zod';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import { classifyFromTaxonomy } from '../classify';
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
      status: z.string().optional().nullable(),
      teamSize: z.number().optional().nullable(),
      industries: z.array(z.string()).optional().nullable(),
      tags: z.array(z.string()).optional().nullable(),
      locations: z.array(z.string()).optional().nullable(),
    }).loose(),
  ).default([]),
}).loose();

/** "San Francisco, CA, USA" → { city, state }. Absent parts stay absent. */
function splitLocation(loc?: string | null): { city?: string; state?: string } {
  if (!loc) return {};
  const parts = loc.split(',').map((p) => p.trim()).filter(Boolean);
  const city = parts[0] || undefined;
  const state = parts.find((p) => /^[A-Z]{2}$/.test(p));
  return { city, state };
}

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

    // Inactive YC companies are shut down or acquired — they are not
    // investable deals, so they are dropped here rather than shown to a
    // reviewer who would have to work that out for themselves.
    const active = parsed.data.companies.filter((r) => (r.status ?? 'Active') !== 'Inactive');
    const inactiveDropped = parsed.data.companies.length - active.length;

    const rawLeads = active.slice(0, budget.maxResults).map((r) => {
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
        sourceUrl: `https://www.ycombinator.com/companies?q=${encodeURIComponent(r.name)}`,
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
        + `${rejected > 0 ? `; ${rejected} invalid rejected` : ''}).`,
    };
  },
};
