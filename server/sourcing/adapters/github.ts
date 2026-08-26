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

function githubHeaders(accept: string): Record<string, string> {
  return {
    'User-Agent': 'vamos-deal-radar',
    Accept: accept,
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

/**
 * A repo's search-result `description` is often too terse for the
 * keyword classifier to find a sector signal in ("a CLI tool for X"),
 * which is why GitHub-sourced candidates were refused as
 * unclassifiable more than any other source. The README is usually
 * where a project actually says what it does. Bounded to 800 chars —
 * enough for classification signal, not the whole file — and failures
 * (no README, rate limit, timeout) degrade silently to no excerpt
 * rather than failing the lead: a missing README is not evidence of
 * anything.
 */
async function fetchReadmeExcerpt(owner: string, repo: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      { headers: githubHeaders('application/vnd.github.raw+json') },
      5000,
    );
    if (!res.ok) return null;
    const text = await res.text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 800) : null;
  } catch {
    return null;
  }
}

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
      res = await fetchWithTimeout(url, { headers: githubHeaders('application/vnd.github+json') }, 8000);
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

    // One README fetch per repo, up to whatever's left of this
    // adapter's own call budget after the search itself. Sequential,
    // not parallel — this is one caller against one host, same as
    // every other request this adapter makes.
    let apiCalls = 1;
    const readmeBudget = Math.max(0, budget.maxApiCalls - apiCalls);
    let readmesFetched = 0;
    const readmeByRepo = new Map<string, string>();
    for (const r of orgRepos) {
      if (readmesFetched >= readmeBudget) break;
      readmesFetched += 1;
      apiCalls += 1;
      const excerpt = await fetchReadmeExcerpt(r.owner!.login, r.name);
      if (excerpt) readmeByRepo.set(`${r.owner!.login}/${r.name}`, excerpt);
    }

    const { valid, rejected } = validateLeads(orgRepos.map((r) => {
      const key = `${r.owner!.login}/${r.name}`;
      const readme = readmeByRepo.get(key);
      return {
        sourceId: 'github',
        sourceName: 'GitHub public API',
        sourceType: 'api',
        sourceUrl: r.html_url,
        externalId: key,
        companyName: r.owner!.login,
        description: r.description ?? undefined,
        tractionSignals: [`Active public repository: ${r.name}`],
        evidenceText: `Public GitHub organization "${r.owner!.login}" has recent activity on repository ${r.name}.`
          + (readme ? ` README: ${readme}` : ''),
        publishedAt: r.pushed_at,
        discoveredAt: now,
        confidence: 0.4, // engineering signal — not proof a company exists
      };
    }));
    return {
      ok: true,
      leads: valid,
      apiCalls,
      detail: `${valid.length} recently active public GitHub org repositor${valid.length === 1 ? 'y' : 'ies'} matching "${term}"${rejected > 0 ? ` (${rejected} invalid item(s) rejected)` : ''} (${readmeByRepo.size} README${readmeByRepo.size === 1 ? '' : 's'} fetched for classification signal). Engineering signal only — company facts stay Unknown.`,
    };
  },
};
