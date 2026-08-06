import { z } from 'zod';
import { env } from '../../env';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';
import { queryTermsFor } from '../verticalQueries';

/**
 * GitHub official REST API (search/repositories). Unauthenticated
 * access is permitted by GitHub for public data at low rate limits;
 * GITHUB_TOKEN raises them. This is an ENGINEERING SIGNAL only: an
 * active org repo is evidence someone is building, not proof a
 * company exists — confidence stays low and company facts stay
 * unknown.
 */

const responseSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      html_url: z.string().url(),
      description: z.string().nullable().optional(),
      pushed_at: z.string().optional(),
      owner: z.object({
        login: z.string(),
        type: z.string(),
        html_url: z.string().url(),
      }).nullable().optional(),
    }),
  ),
});

export const githubAdapter: SourceAdapter = {
  id: 'github',
  name: 'GitHub public API',
  sourceType: 'api',

  async run(q, budget): Promise<AdapterOutcome> {
    const term = [q.terms[0], q.subcategory].filter(Boolean).join(' ')
      || queryTermsFor(q.vertical, 'github')[0]
      || q.vertical || 'startup';
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(term)}+created:%3E2025-01-01&sort=updated&per_page=${Math.min(budget.maxResults, 10)}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'vamos-deal-radar',
          Accept: 'application/vnd.github+json',
          ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
      }, 8000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `GitHub search: ${message}` };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `GitHub search: ${message}` };
    }
    const body = await readJson(res);
    if (!body.ok) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'GitHub returned a non-JSON body.' };
    const parsed = validateExternal(responseSchema, body.data, 'GitHub search', 1);
    if (!parsed.ok) return parsed.failure;

    const now = new Date().toISOString();
    const orgRepos = parsed.data.items.filter((r) => r.owner?.type === 'Organization');
    const { valid, rejected } = validateLeads(orgRepos.map((r) => ({
      sourceId: 'github',
      sourceName: 'GitHub public API',
      sourceType: 'api',
      sourceUrl: r.html_url,
      externalId: `${r.owner!.login}/${r.name}`,
      companyName: r.owner!.login,
      description: r.description ?? undefined,
      tractionSignals: [`Active public repository: ${r.name}`],
      evidenceText: `Public GitHub organization "${r.owner!.login}" has recent activity on repository ${r.name}.`,
      publishedAt: r.pushed_at,
      discoveredAt: now,
      confidence: 0.4, // engineering signal — not proof a company exists
    })));
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} recently active public GitHub org repositor${valid.length === 1 ? 'y' : 'ies'} matching "${term}"${rejected > 0 ? ` (${rejected} invalid item(s) rejected)` : ''}. Engineering signal only — company facts stay Unknown.`,
    };
  },
};
