import { z } from 'zod';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

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
    const term = q.terms[0] ?? q.subcategory ?? q.vertical ?? 'technology';
    const rows = Math.min(budget.maxResults, 25);
    const url = `https://api.www.sbir.gov/public/api/awards?keyword=${encodeURIComponent(term)}&rows=${rows}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'vamos-deal-radar' } }, 10_000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `SBIR awards API: ${message}` };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `SBIR awards API: ${message}` };
    }
    const body = await readJson(res);
    if (!body.ok) return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'SBIR awards API returned a non-JSON body.' };
    const parsed = validateExternal(responseSchema, body.data, 'SBIR awards API', 1);
    if (!parsed.ok) return parsed.failure;

    const now = new Date().toISOString();
    const rawLeads = parsed.data.slice(0, budget.maxResults).map((a) => {
      const amount = toNumber(a.award_amount);
      const awardBits = [a.program, a.phase ? `Phase ${String(a.phase).replace(/^phase\s*/i, '')}` : null, a.agency]
        .filter(Boolean).join(' · ');
      const sourceUrl = normalizeUrl(a.award_link) ?? `https://www.sbir.gov/awards?keyword=${encodeURIComponent(a.firm)}`;
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
        fundingAmountText: amount !== undefined ? `$${amount.toLocaleString('en-US')} government award` : undefined,
        evidenceText: `SBIR/STTR award${a.award_title ? `: "${a.award_title}"` : ''}${awardBits ? ` (${awardBits})` : ''}${a.award_year ? `, ${a.award_year}` : ''}.`,
        publishedAt: a.proposal_award_date ?? undefined,
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
