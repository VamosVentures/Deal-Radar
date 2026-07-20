import { z } from 'zod';
import { store } from '../lib/store';
import { discoveryCandidateSchema, type DiscoveryCandidate } from '../../shared/discovery';
import { matchCompany, type MatchRecord } from './identity';
import { matchRecords } from '../db/repos/companies';

/**
 * Deduplication for the discovery pipeline, built on the tiered
 * identity-matching service (see sourcing/identity.ts):
 *
 * - domain / external-id / hubspot-id matches  → duplicateStatus 'exact'
 * - name / fuzzy-name / founder-evidence       → duplicateStatus 'likely'
 *
 * 'likely' always waits for a human decision (skip / merge evidence /
 * import anyway) — low-confidence matches are never auto-merged.
 * The pool is every persisted company plus every non-dismissed prior
 * candidate.
 */

export function existingCandidates(): DiscoveryCandidate[] {
  return z.array(discoveryCandidateSchema).catch([]).parse(store.raw.discoveryCandidates);
}

function candidateRecords(): MatchRecord[] {
  return existingCandidates()
    .filter((c) => c.status !== 'dismissed')
    .map((c) => ({
      id: c.id,
      kind: 'candidate' as const,
      name: c.companyName,
      domain: c.website !== 'Unknown' ? c.website : null,
      externalIds: c.externalId ? [{ sourceId: c.sourceId, externalId: c.externalId }] : [],
      founderNames: c.founderNames,
    }));
}

const EXACT_TIERS = new Set(['domain', 'external-id', 'hubspot-id']);

export function detectDuplicate(c: DiscoveryCandidate): Pick<DiscoveryCandidate, 'duplicateStatus' | 'duplicateOfId' | 'duplicateOfName'> {
  const pool = [...matchRecords(), ...candidateRecords()].filter((r) => r.id !== c.id);
  const match = matchCompany(
    {
      name: c.companyName,
      domain: c.website !== 'Unknown' ? c.website : null,
      externalIds: c.externalId ? [{ sourceId: c.sourceId, externalId: c.externalId }] : [],
      founderNames: c.founderNames,
    },
    pool,
  );
  if (match.kind === 'none' || !match.record) {
    return { duplicateStatus: 'none', duplicateOfId: null, duplicateOfName: null };
  }
  return {
    duplicateStatus: EXACT_TIERS.has(match.matchedBy!) ? 'exact' : 'likely',
    duplicateOfId: match.record.id,
    duplicateOfName: match.record.name,
  };
}
