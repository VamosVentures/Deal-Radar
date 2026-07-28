import { z } from 'zod';
import { env } from '../../env';
import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { readJson, validateExternal, validateLeads } from '../validate';
import { filingIndexUrl, isOperatingIssuer, parseFormD, primaryDocUrl, type FormDFiling } from '../formd';
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
    const todayStr = now.slice(0, 10);

    // Full-text search gives a name, a CIK, and a date. The facts that
    // make a filing worth surfacing — offering size, amount SOLD, first
    // sale date, officers — are only in the filing's primary document,
    // so each promising hit costs one extra request. That is budgeted:
    // the SEC asks clients to stay under 10 req/s, and we stay far under
    // by capping detail fetches and spacing them out.
    const DETAIL_BUDGET = Math.max(0, Math.min(budget.maxApiCalls - 1, budget.maxResults, 12));
    let detailCalls = 0;

    const hits = parsed.data.hits.hits.slice(0, budget.maxResults);
    const leads: Record<string, unknown>[] = [];
    let rejectedFunds = 0;

    for (const hit of hits) {
      const display = hit._source.display_names[0];
      if (!display) continue;
      const { name, cik } = parseDisplayName(display);
      const adsh = hit._source.adsh ?? hit._id.split(':')[0];
      const filingUrl = filingIndexUrl(cik, adsh);
      if (!filingUrl) continue; // no verifiable URL → no lead, ever

      // Cheap name-only rejection first, so obvious funds never cost a request.
      const quick = isOperatingIssuer(name);
      if (!quick.isOperatingCompany) { rejectedFunds++; continue; }

      let filing: FormDFiling | null = null;
      const docUrl = primaryDocUrl(cik, adsh);
      if (docUrl && detailCalls < DETAIL_BUDGET) {
        detailCalls++;
        try {
          // ~120ms between detail requests: comfortably inside the SEC's
          // published limit without needing a full rate limiter here.
          if (detailCalls > 1) await new Promise((r) => setTimeout(r, 120));
          const docRes = await fetchWithTimeout(docUrl, {
            headers: { 'User-Agent': `vamos-deal-radar research (${contact})` },
          }, 8000);
          if (docRes.ok) filing = parseFormD(await docRes.text());
        } catch {
          // A detail fetch failing is not fatal — the filing still exists
          // and the search-level facts are still true. It just stays thinner.
          filing = null;
        }
      }

      // The issuer's OWN industry-group answer is the strongest fund
      // signal available, and it catches funds with operational-sounding
      // names that the pattern check above cannot.
      if (filing) {
        const verdict = isOperatingIssuer(name, filing);
        if (!verdict.isOperatingCompany) { rejectedFunds++; continue; }
      }

      const bizState = hit._source.biz_states.find((s2) => /^[A-Z]{2}$/.test(s2));
      const sold = filing?.totalAmountSoldUsd ?? null;
      const offered = filing?.totalOfferingAmountUsd ?? null;
      const amountText = sold !== null
        ? `$${sold.toLocaleString()} sold${offered !== null ? ` of a $${offered.toLocaleString()} offering` : ''}`
        : offered !== null ? `$${offered.toLocaleString()} offering` : undefined;

      const evidenceText = [
        `Form D exempt-offering filing with the SEC${hit._source.file_date ? ` on ${hit._source.file_date}` : ''}.`,
        amountText ? `Amount: ${amountText}.` : '',
        filing?.dateOfFirstSale ? `First sale ${filing.dateOfFirstSale}.` : (filing?.firstSaleYetToOccur ? 'Issuer states the first sale has not yet occurred.' : ''),
        filing?.industryGroupType ? `Industry group: ${filing.industryGroupType}.` : '',
        filing && filing.relatedPersons.length > 0
          ? `Related persons: ${filing.relatedPersons.slice(0, 4).map((p) => `${p.name} (${p.relationship})`).join(', ')}.`
          : '',
      ].filter(Boolean).join(' ');

      leads.push({
        sourceId: 'sec',
        sourceName: 'SEC EDGAR (Form D)',
        sourceType: 'filing',
        sourceUrl: filingUrl,
        externalId: adsh,
        companyName: filing?.entityName ?? name,
        hqCity: filing?.city ?? undefined,
        hqState: bizState ?? (filing?.stateOrCountry && /^[A-Z]{2}$/.test(filing.stateOrCountry) ? filing.stateOrCountry : undefined),
        // Only ever the filing's own dates — never inferred.
        lastFundingDate: filing?.dateOfFirstSale && /^\d{4}-\d{2}-\d{2}$/.test(filing.dateOfFirstSale)
          ? filing.dateOfFirstSale
          : (hit._source.file_date && /^\d{4}-\d{2}-\d{2}$/.test(hit._source.file_date) ? hit._source.file_date : undefined),
        // LeadEvidence's own field names — normalize.ts maps
        // fundingAmountText onto the candidate's publicFunding. Writing
        // publicFunding directly here silently lost every amount, since
        // Zod strips keys the LeadEvidence schema does not declare.
        fundingAmount: sold ?? offered ?? undefined,
        fundingAmountText: amountText,
        founderNames: filing?.relatedPersons
          .filter((p) => /officer|founder|promoter/i.test(p.relationship))
          .map((p) => p.name)
          .slice(0, 5),
        evidenceText,
        publishedAt: hit._source.file_date,
        retrievedAt: todayStr,
        discoveredAt: now,
        confidence: filing ? 0.8 : 0.6,
      });
    }

    const { valid, rejected } = validateLeads(leads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1 + detailCalls,
      detail: `${valid.length} operating-company Form D filing(s) matching "${term}"`
        + ` (${detailCalls} filing document(s) parsed for amounts and dates`
        + `${rejectedFunds > 0 ? `; ${rejectedFunds} pooled-investment vehicle(s) rejected` : ''}`
        + `${rejected > 0 ? `; ${rejected} invalid item(s) rejected` : ''}).`,
    };
  },
};
