import { fetchWithTimeout } from '../../lib/http';
import { classifyFetchError, classifyHttpStatus } from '../errors';
import { validateLeads } from '../validate';
import type { AdapterOutcome, SourceAdapter } from '../types';

/**
 * arXiv's public search API (export.arxiv.org) — official, key-free,
 * published for automated querying. Verified reachable and returning
 * real Atom XML from this environment (2026-07-19).
 *
 * A weak, honestly-labeled signal: most arXiv papers are academic, not
 * startup activity, and this adapter does NOT guess a company from an
 * author's name or lab. A lead is created ONLY when a paper's
 * <arxiv:affiliation> tag is present, and that field's text is used
 * VERBATIM as the company name — never inferred, never cleaned up to
 * "look more like a company." Most submissions omit this field
 * entirely, so an honest zero is the common (and expected) outcome.
 */

function stripCdata(s: string): string {
  return s.trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"');
}

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published?: string;
  authorAffiliations: { name: string; affiliation: string }[];
}

/** Minimal Atom <entry> extraction — arXiv's feed, not a general-purpose parser. */
export function parseArxivEntries(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const pick = (tag: string): string | undefined => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? decodeEntities(stripCdata(m[1])) : undefined;
    };
    const id = pick('id');
    const title = pick('title')?.replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    const authorBlocks = block.match(/<author>[\s\S]*?<\/author>/gi) ?? [];
    const authorAffiliations: { name: string; affiliation: string }[] = [];
    for (const ab of authorBlocks) {
      const name = ab.match(/<name>([\s\S]*?)<\/name>/i)?.[1];
      const affiliation = ab.match(/<arxiv:affiliation[^>]*>([\s\S]*?)<\/arxiv:affiliation>/i)?.[1];
      if (name && affiliation) {
        authorAffiliations.push({ name: decodeEntities(name.trim()), affiliation: decodeEntities(affiliation.trim()) });
      }
    }
    entries.push({
      id,
      title,
      summary: pick('summary')?.replace(/\s+/g, ' ').trim() ?? '',
      published: pick('published'),
      authorAffiliations,
    });
  }
  return entries;
}

function toIsoDate(published?: string): string | undefined {
  if (!published) return undefined;
  const d = new Date(published);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const arxivAdapter: SourceAdapter = {
  id: 'research',
  name: 'Public research publications (arXiv)',
  sourceType: 'api',

  async run(q, budget): Promise<AdapterOutcome> {
    const term = q.terms[0] ?? q.subcategory ?? q.vertical ?? 'startup';
    const params = new URLSearchParams({
      search_query: `all:${term}`,
      start: '0',
      max_results: String(Math.min(budget.maxResults * 5, 50)), // over-fetch: most entries have no affiliation
      sortBy: 'submittedDate',
      sortOrder: 'descending',
    });
    const url = `https://export.arxiv.org/api/query?${params}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'vamos-deal-radar (research signal)' } }, 8000);
    } catch (e) {
      const { kind, message } = classifyFetchError(e);
      return { ok: false, failure: kind, apiCalls: 1, detail: `arXiv: ${message}` };
    }
    if (!res.ok) {
      const { kind, message } = classifyHttpStatus(res);
      return { ok: false, failure: kind, apiCalls: 1, detail: `arXiv: ${message}` };
    }
    const xml = await res.text().catch(() => '');
    if (!/<feed[\s>]/i.test(xml)) {
      return { ok: false, failure: 'invalid-response', apiCalls: 1, detail: 'arXiv did not return a valid Atom feed.' };
    }

    const now = new Date().toISOString();
    const entries = parseArxivEntries(xml);
    const rawLeads = entries
      .flatMap((e) => e.authorAffiliations.map((aa) => ({ entry: e, aa })))
      .slice(0, budget.maxResults)
      .map(({ entry, aa }) => ({
        sourceId: 'research',
        sourceName: 'arXiv (public research publications)',
        sourceType: 'api',
        sourceUrl: entry.id,
        externalId: entry.id,
        companyName: aa.affiliation,
        founderNames: [aa.name],
        founderProfiles: [],
        description: entry.title,
        evidenceText: `arXiv submission "${entry.title}" lists author "${aa.name}"'s affiliation as "${aa.affiliation}".`,
        publishedAt: toIsoDate(entry.published),
        discoveredAt: now,
        confidence: 0.3, // an affiliation string is a weak, unverified company signal
      }));
    const { valid, rejected } = validateLeads(rawLeads);
    return {
      ok: true,
      leads: valid,
      apiCalls: 1,
      detail: `${entries.length} paper(s) matched "${term}"; ${valid.length} listed a non-empty author affiliation (used verbatim, never guessed)${rejected > 0 ? ` (${rejected} invalid rejected)` : ''}. Most academic papers omit this field — a zero result here is expected, not a failure.`,
    };
  },
};
