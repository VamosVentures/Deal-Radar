import { z } from 'zod';
import { env } from '../../env';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * Product Hunt's official GraphQL API (api.producthunt.com/v2/api/graphql).
 * Confirmed reachable from this environment (2026-07-19): an
 * unauthenticated request returns a clean `invalid_oauth_token` error,
 * confirming the endpoint and its auth requirement — this adapter has
 * NOT been exercised with a real token (none is available here), so
 * the exact response shape below is built from Product Hunt's
 * documented, stable v2 schema rather than a live authenticated call.
 * Treat as "implemented, awaiting credentials" like HubSpot/Outlook/AI
 * until someone runs it with a real PRODUCTHUNT_TOKEN.
 *
 * Requires PRODUCTHUNT_TOKEN (a Product Hunt developer token — create
 * one at https://www.producthunt.com/v2/oauth/applications). Without
 * it, this adapter refuses to run rather than guessing at public data.
 */

const responseSchema = z.object({
  data: z.object({
    posts: z.object({
      edges: z.array(
        z.object({
          node: z.object({
            id: z.string(),
            name: z.string(),
            tagline: z.string().optional().nullable(),
            url: z.string(),
            website: z.string().optional().nullable(),
            votesCount: z.number().optional(),
            createdAt: z.string().optional(),
            makers: z.array(z.object({ name: z.string() })).default([]),
          }).loose(),
        }),
      ).default([]),
    }).loose(),
  }).nullable(),
  errors: z.array(z.object({ message: z.string() }).loose()).optional(),
}).loose();

// Product Hunt's `posts` connection doesn't expose a general keyword
// search (only exact url/twitterUrl lookups and topic-slug filters,
// neither of which map cleanly to an arbitrary query term) — like the
// RSS adapter, this fetches the newest launches and lets the pipeline's
// vertical/stage/keyword filters apply downstream, not at fetch time.
const QUERY = `
  query VamosDealRadarRecentLaunches($first: Int!) {
    posts(first: $first, order: NEWEST) {
      edges { node { id name tagline url website votesCount createdAt makers { name } } }
    }
  }
`;

export const productHuntAdapter: SourceAdapter = {
  id: 'producthunt',
  name: 'Product Hunt (authorized only)',
  sourceType: 'api',

  async run(_q, budget): Promise<AdapterOutcome> {
    if (!env.PRODUCTHUNT_TOKEN) {
      return {
        ok: false,
        failure: 'missing-credentials',
        apiCalls: 0,
        detail: 'PRODUCTHUNT_TOKEN is not configured — Product Hunt requires an authorized developer token; nothing is fetched without one.',
      };
    }
    let res: Response;
    try {
      res = await fetchWithTimeout('https://api.producthunt.com/v2/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.PRODUCTHUNT_TOKEN}`,
        },
        body: JSON.stringify({ query: QUERY, variables: { first: Math.min(budget.maxResults, 20) } }),
      }, 8000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `Product Hunt: ${message}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, failure: 'missing-credentials', apiCalls: 1, detail: 'Product Hunt rejected PRODUCTHUNT_TOKEN (401/403) — it may be expired or missing the required scope.' };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `Product Hunt: ${message}` };
    }
    const body = await readJson(res);
    if (!body.ok) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'Product Hunt returned a non-JSON body.' };
    const parsed = validateExternal(responseSchema, body.data, 'Product Hunt GraphQL API', 1);
    if (!parsed.ok) return parsed.failure;
    if (parsed.data.errors?.length) {
      return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: `Product Hunt GraphQL errors: ${parsed.data.errors.map((e) => e.message).join('; ')}` };
    }
    if (!parsed.data.data) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'Product Hunt returned no data.' };

    const now = new Date().toISOString();
    const rawLeads = parsed.data.data.posts.edges.slice(0, budget.maxResults).map(({ node }) => ({
      sourceId: 'producthunt',
      sourceName: 'Product Hunt',
      sourceType: 'api',
      sourceUrl: node.url,
      externalId: node.id,
      companyName: node.name,
      companyWebsite: node.website && z.string().url().safeParse(node.website).success ? node.website : undefined,
      founderNames: node.makers.map((m) => m.name),
      description: node.tagline ?? undefined,
      tractionSignals: node.votesCount ? [`${node.votesCount} Product Hunt upvotes`] : [],
      evidenceText: `Launched on Product Hunt${node.tagline ? `: "${node.tagline}"` : ''}.`,
      publishedAt: node.createdAt,
      discoveredAt: now,
      confidence: 0.5,
    }));
    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} recent Product Hunt launch(es)${rejected > 0 ? ` (${rejected} invalid rejected)` : ''}. Vertical/stage/keyword filters apply downstream, not at fetch time.`,
    };
  },
};
