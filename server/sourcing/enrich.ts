import { normalizeCompanyName, normalizeDomain } from '../../shared/integrations';
import type { DiscoveryCandidate } from '../../shared/discovery';

/**
 * Enrichment: when several sources surface the SAME company within one
 * run, merge them into a single candidate instead of listing it twice.
 * Merging is strictly additive —
 * - evidence is appended (every source URL is kept),
 * - Unknown fields are filled only from another source's recorded
 *   value (never computed or guessed),
 * - conflicting known values are left as-is and both claims stay
 *   visible in the evidence list,
 * - confidence becomes the max of the merged sources.
 */

function sameCompany(a: DiscoveryCandidate, b: DiscoveryCandidate): boolean {
  const domainA = a.website !== 'Unknown' ? normalizeDomain(a.website) : null;
  const domainB = b.website !== 'Unknown' ? normalizeDomain(b.website) : null;
  if (domainA && domainB) return domainA === domainB;
  return normalizeCompanyName(a.companyName) === normalizeCompanyName(b.companyName);
}

const UNKNOWNABLE_FIELDS = [
  'website', 'pitch', 'vertical', 'subcategory', 'stage', 'hqCity', 'hqState',
  'accelerator', 'publicFunding', 'mostRecentRound',
] as const;

/**
 * Merge `next` into an accepted candidate from the same run if they
 * match. Returns true when merged (caller should not add `next` as a
 * separate candidate).
 */
export function mergeIntoRun(accepted: DiscoveryCandidate[], next: DiscoveryCandidate): boolean {
  const target = accepted.find((c) => sameCompany(c, next));
  if (!target) return false;

  // Append evidence the target doesn't already cite.
  const known = new Set(target.evidence.map((e) => e.url));
  target.evidence = [...target.evidence, ...next.evidence.filter((e) => !known.has(e.url))];

  // Fill Unknown fields from the other source's recorded values only.
  for (const field of UNKNOWNABLE_FIELDS) {
    if (target[field] === 'Unknown' && next[field] !== 'Unknown') {
      (target as Record<typeof field, string>)[field] = next[field];
    }
  }
  if (target.foundingYear === null && next.foundingYear !== null) target.foundingYear = next.foundingYear;
  if (target.fundingDate === null && next.fundingDate !== null) target.fundingDate = next.fundingDate;
  if (target.founderNames.length === 0 && next.founderNames.length > 0) {
    target.founderNames = next.founderNames;
    target.founderCount = next.founderCount;
  }
  target.tractionSignals = Array.from(new Set([...target.tractionSignals, ...next.tractionSignals]));
  target.confidence = Math.max(target.confidence, next.confidence);
  return true;
}
