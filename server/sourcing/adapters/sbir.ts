import { z } from 'zod';
import { validateExternal, validateLeads } from '../validate';
import { politeFetch, RequestBudget } from '../politeness';
import type { AdapterOutcome, SourceAdapter } from '../types';
import { resolveQueryTerm } from '../verticalQueries';

/**
 * SBIR/STTR public awards API (api.www.sbir.gov) — the U.S. government
 * database of Small Business Innovation Research awards. Public data
 * with a documented, key-free JSON API. Each award names a real small
 * business, an agency, and an award amount.
 */

const awardSchema = z.object({
  firm: z.string().min(1),
  award_title: z.string().optional().nullable(),
  agency: z.string().optional().nullable(),
  program: z.string().optional().nullable(),
  phase: z.string().optional().nullable(),
  award_amount: z.union([z.string(), z.number()]).optional().nullable(),
  award_year: z.union([z.string(), z.number()]).optional().nullable(),
  proposal_award_date: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  company_url: z.string().optional().nullable(),
  award_link: z.string().optional().nullable(),
  abstract: z.string().optional().nullable(),
  contract: z.string().optional().nullable(),
  branch: z.string().optional().nullable(),
  research_institution: z.string().optional().nullable(),
}).loose();

// The API returns either a bare array or an object with a results array.
const responseSchema = z.union([
  z.array(awardSchema),
  z.object({ results: z.array(awardSchema) }).loose().transform((o) => o.results),
]);

function toNumber(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function normalizeUrl(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return z.string().url().safeParse(withProto).success ? withProto : undefined;
}

export const sbirAdapter: SourceAdapter = {
  id: 'grants',
  name: 'SBIR/STTR public awards (sbir.gov)',
  sourceType: 'award',

  async run(q, budget): Promise<AdapterOutcome> {
    const term = resolveQueryTerm(q.terms, q.vertical, 'grants', q.subcategory ?? q.vertical ?? 'technology');
    const rows = Math.min(budget.maxResults, 25);
    const url = `https://api.www.sbir.gov/public/api/awards?keyword=${encodeURIComponent(term)}&rows=${rows}`;

    // Politeness layer: one request at a time to this host, a 2s minimum
    // gap, bounded backoff, Retry-After honoured, responses cached for
    // 30 minutes, and a hard per-run request budget. It also draws the
    // distinction that matters in the run report — a 429 on our FIRST
    // request is the service refusing everyone, not us being greedy.
    const requestBudget = new RequestBudget(Math.max(1, Math.min(budget.maxApiCalls, 3)));
    const res = await politeFetch(url, {
      // sbir.gov returns 403 with no User-Agent at all, so identifying
      // ourselves is mandatory rather than merely polite.
      headers: {
        'User-Agent': 'vamos-deal-radar research (contact: vamosventures.com)',
        Accept: 'application/json',
      },
      budget: requestBudget,
    });

    if (!res.ok) {
      /**
       * Diagnose the failure HONESTLY, because the previous mapping did
       * not and the run report inherited the mistake.
       *
       * `forbidden` used to map to 'missing-credentials', which produced
       * "Missing credentials: … Usually a User-Agent or access-policy
       * requirement." That is false: the SBIR public API has no
       * credential, no key, and no account. Nothing we could configure
       * would change the outcome, so labelling it a credential problem
       * sends a reader off to fix something that does not exist.
       *
       * What the service actually returns, verified directly on
       * 2026-08-05 across spaced attempts from a cold session, is:
       *   HTTP 429 {"Code":"TooManyRequestsError",
       *             "Message":"The SBIR Public API is not available at this time."}
       * on the FIRST request — so it is the service declaring itself
       * unavailable to everyone, not us exceeding a rate. The older
       * documented path (www.sbir.gov/api/awards.json) now returns 404.
       * Both are outages to report and wait out, not controls to work
       * around, and this adapter does not attempt to.
       */
      const body = (res.body ?? '').slice(0, 400);
      const serviceDeclaredDown = /not available at this time|TooManyRequestsError/i.test(body);
      const failure =
        serviceDeclaredDown ? 'http-error'
        : res.failure === 'service-unavailable' ? 'http-error'
        // No credential exists for this API, so a 403 is an access
        // policy on THEIR side (CDN/geo/bot rule), not a missing secret.
        : res.failure === 'forbidden' ? 'http-error'
        : res.failure === 'rate-limited-by-us' ? 'rate-limited'
        : res.failure === 'timeout' ? 'timeout'
        : 'network';
      const detail = serviceDeclaredDown
        ? 'SBIR/STTR awards API is refusing all traffic — the service returns '
          + '"The SBIR Public API is not available at this time" on a first request from a cold session, '
          + 'so this is a sbir.gov-side outage, not our rate limit and not a missing credential '
          + '(this API has none). Zero awards were collected; nothing was inferred or substituted. '
          + 'Grant coverage for this run is ABSENT, not empty-but-checked.'
        : `SBIR/STTR awards API: ${res.detail ?? 'request failed'}`
          + (res.failure === 'forbidden' ? ' — note this API requires no credential, so this is an access policy on sbir.gov, not a missing secret.' : '');
      return { ok: false, failure, apiCalls: res.requests, detail };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(res.body);
    } catch {
      return { ok: false, failure: 'invalid-response', apiCalls: res.requests, detail: 'SBIR awards API returned a non-JSON body.' };
    }
    const parsed = validateExternal(responseSchema, payload, 'SBIR awards API', res.requests);
    if (!parsed.ok) return parsed.failure;

    const now = new Date().toISOString();
    const todayStr = now.slice(0, 10);
    const rawLeads = parsed.data.slice(0, budget.maxResults).map((a) => {
      const amount = toNumber(a.award_amount);
      const awardBits = [a.program, a.phase ? `Phase ${String(a.phase).replace(/^phase\s*/i, '')}` : null, a.agency, a.branch]
        .filter(Boolean).join(' · ');
      const sourceUrl = normalizeUrl(a.award_link) ?? `https://www.sbir.gov/awards?keyword=${encodeURIComponent(a.firm)}`;
      // An award date may arrive as a full date or only a year. A year
      // alone is NOT widened into a fake day — it stays absent.
      const awardDate = a.proposal_award_date && /^\d{4}-\d{2}-\d{2}/.test(a.proposal_award_date)
        ? a.proposal_award_date.slice(0, 10)
        : undefined;
      return {
        sourceId: 'grants',
        sourceName: 'SBIR/STTR awards (sbir.gov)',
        sourceType: 'award',
        sourceUrl,
        companyName: a.firm,
        companyWebsite: normalizeUrl(a.company_url),
        hqCity: a.city ?? undefined,
        hqState: a.state && /^[A-Z]{2}$/i.test(a.state.trim()) ? a.state.trim().toUpperCase() : undefined,
        fundingAmount: amount,
        // Deliberately worded as a government award, never as a round:
        // SBIR/STTR money is non-dilutive and is a commercialization
        // signal, not equity financing.
        fundingAmountText: amount !== undefined ? `$${amount.toLocaleString('en-US')} non-dilutive government award` : undefined,
        evidenceText: [
          `SBIR/STTR government award${a.award_title ? `: "${a.award_title}"` : ''}${awardBits ? ` (${awardBits})` : ''}${a.award_year ? `, ${a.award_year}` : ''}.`,
          a.abstract ? `Project: ${String(a.abstract).slice(0, 300)}` : '',
          'Non-dilutive award — a commercialization signal, not an equity round.',
        ].filter(Boolean).join(' '),
        publishedAt: awardDate,
        retrievedAt: todayStr,
        discoveredAt: now,
        confidence: 0.65, // a government award record names a real company
      };
    });
    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${valid.length} public SBIR/STTR award record(s) matching "${term}"${rejected > 0 ? ` (${rejected} invalid item(s) rejected)` : ''}.`,
    };
  },
};
