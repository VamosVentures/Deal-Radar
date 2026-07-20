/**
 * Normalization & identity-matching service. One place decides
 * whether two company records refer to the same company.
 *
 * Matching priority (first hit wins):
 *   1. Exact normalized domain
 *   2. Exact external-source ID
 *   3. Exact HubSpot record ID (when available)
 *   4. Exact normalized company name
 *   5. High-confidence fuzzy company-name match        → possible
 *   6. Founder-overlap + name-token evidence           → possible
 *   7. Otherwise: no match — uncertain cases go to manual review
 *
 * Tiers 1–4 are 'exact'. Tiers 5–6 are 'possible' and MUST NOT be
 * auto-merged — they create a possible-duplicate review item.
 */

// ── Normalization ────────────────────────────────────────────────

const CORPORATE_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp',
  'corporation', 'co', 'company', 'plc', 'pbc', 'holdings', 'labs',
  'technologies', 'tech', 'gmbh', 'sa', 'sas', 'srl', 'pte', 'oy', 'ab',
]);

/** Common abbreviations/aliases folded to one spelling before comparison. */
const ALIASES: [RegExp, string][] = [
  [/&/g, ' and '],
  [/\bintl\b/g, 'international'],
  [/\bgrp\b/g, 'group'],
  [/\bmfg\b/g, 'manufacturing'],
  [/\bsvcs\b/g, 'services'],
  [/\bsvc\b/g, 'service'],
  [/\bbros\b/g, 'brothers'],
  [/\bassoc\b/g, 'associates'],
];

/**
 * Canonical company-name key: lowercase, aliases folded, punctuation
 * stripped, whitespace collapsed, trailing corporate suffixes removed.
 * "Pacific  Rim Energy, Inc." → "pacific rim energy".
 */
export function normalizeCompanyKey(name: string): string {
  let s = name.toLowerCase();
  for (const [pattern, replacement] of ALIASES) s = s.replace(pattern, ` ${replacement} `);
  s = s.replace(/[.,'’"()‘’“”!?:;/\\|]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ');
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Canonical URL: lowercase host, no protocol/www/query/fragment/trailing slash. */
export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return host.includes('.') ? `${host}${path}` : null;
  } catch {
    return null;
  }
}

/** Canonical domain from a URL or bare domain. */
export function normalizeDomainKey(input: string | null | undefined): string | null {
  const url = normalizeUrl(input);
  if (!url) return null;
  return url.split('/')[0] || null;
}

// ── Fuzzy matching (Damerau–Levenshtein) ─────────────────────────

/** Edit distance with transpositions — catches typos and dropped letters. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** 0..1 similarity of two normalized keys. */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - editDistance(a, b) / maxLen;
}

/**
 * High-confidence fuzzy: near-identical after normalization —
 * "pacific rim energ" vs "pacific rim energy" (distance 1). Short
 * names are excluded (too easy to collide).
 */
export function isHighConfidenceFuzzy(keyA: string, keyB: string): boolean {
  if (keyA === keyB) return false; // that's an exact match, not fuzzy
  if (Math.min(keyA.length, keyB.length) < 5) return false;
  const dist = editDistance(keyA, keyB);
  return dist <= 2 && nameSimilarity(keyA, keyB) >= 0.85;
}

// ── Tiered matching ──────────────────────────────────────────────

export interface MatchInput {
  name: string;
  domain?: string | null;
  externalIds?: { sourceId: string; externalId: string }[];
  hubspotId?: string | null;
  founderNames?: string[];
}

export interface MatchRecord {
  id: string;
  kind: 'company' | 'candidate';
  name: string;
  domain?: string | null;
  externalIds?: { sourceId: string; externalId: string }[];
  hubspotId?: string | null;
  founderNames?: string[];
}

export type MatchedBy = 'domain' | 'external-id' | 'hubspot-id' | 'name' | 'fuzzy-name' | 'founder-evidence';

export interface MatchResult {
  kind: 'exact' | 'possible' | 'none';
  matchedBy: MatchedBy | null;
  record: MatchRecord | null;
  similarity: number;
}

const NONE: MatchResult = { kind: 'none', matchedBy: null, record: null, similarity: 0 };

function founderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function matchCompany(input: MatchInput, pool: MatchRecord[]): MatchResult {
  const inputDomain = normalizeDomainKey(input.domain);
  const inputKey = normalizeCompanyKey(input.name);
  const inputExternal = new Set((input.externalIds ?? []).map((e) => `${e.sourceId}:${e.externalId}`));
  const inputFounders = new Set((input.founderNames ?? []).map(founderKey).filter((f) => f.length > 3));

  // 1. Exact normalized domain.
  if (inputDomain) {
    const hit = pool.find((r) => normalizeDomainKey(r.domain) === inputDomain);
    if (hit) return { kind: 'exact', matchedBy: 'domain', record: hit, similarity: 1 };
  }
  // 2. Exact external-source ID.
  if (inputExternal.size > 0) {
    const hit = pool.find((r) => (r.externalIds ?? []).some((e) => inputExternal.has(`${e.sourceId}:${e.externalId}`)));
    if (hit) return { kind: 'exact', matchedBy: 'external-id', record: hit, similarity: 1 };
  }
  // 3. Exact HubSpot record ID.
  if (input.hubspotId) {
    const hit = pool.find((r) => r.hubspotId && r.hubspotId === input.hubspotId);
    if (hit) return { kind: 'exact', matchedBy: 'hubspot-id', record: hit, similarity: 1 };
  }
  // 4. Exact normalized company name.
  if (inputKey.length > 0) {
    const hit = pool.find((r) => normalizeCompanyKey(r.name) === inputKey);
    if (hit) return { kind: 'exact', matchedBy: 'name', record: hit, similarity: 1 };
  }
  // 5. High-confidence fuzzy name — POSSIBLE match only, never auto-merged.
  let bestFuzzy: { record: MatchRecord; similarity: number } | null = null;
  for (const r of pool) {
    const key = normalizeCompanyKey(r.name);
    if (isHighConfidenceFuzzy(inputKey, key)) {
      const sim = nameSimilarity(inputKey, key);
      if (!bestFuzzy || sim > bestFuzzy.similarity) bestFuzzy = { record: r, similarity: sim };
    }
  }
  if (bestFuzzy) return { kind: 'possible', matchedBy: 'fuzzy-name', record: bestFuzzy.record, similarity: bestFuzzy.similarity };

  // 6. Founder + name-token evidence — POSSIBLE match only.
  if (inputFounders.size > 0) {
    const inputTokens = new Set(inputKey.split(' ').filter((t) => t.length > 2));
    for (const r of pool) {
      const founderOverlap = (r.founderNames ?? []).map(founderKey).some((f) => inputFounders.has(f));
      if (!founderOverlap) continue;
      const rTokens = normalizeCompanyKey(r.name).split(' ').filter((t) => t.length > 2);
      const shared = rTokens.filter((t) => inputTokens.has(t)).length;
      const union = new Set([...inputTokens, ...rTokens]).size;
      const jaccard = union === 0 ? 0 : shared / union;
      if (jaccard >= 0.4) {
        return { kind: 'possible', matchedBy: 'founder-evidence', record: r, similarity: jaccard };
      }
    }
  }
  // 7. No match — when a caller had any doubt, it routes to manual review.
  return NONE;
}
