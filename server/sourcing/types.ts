import { z } from 'zod';
import type { DiscoveryQuery, DiscoverySourceId } from '../../shared/discovery';
import type { SourceFailureKind } from './errors';

/**
 * The shared lead structure every source adapter returns. One
 * LeadEvidence = one real, citable observation from one public
 * source. Rules:
 *
 * - `sourceUrl` must be a real URL a human can open to verify the
 *   claim — leads without one are rejected by validation.
 * - Unknown facts are simply absent. Adapters never guess or fill.
 * - `evidenceText` is what the source actually says, not a summary
 *   the adapter invented.
 */
export const leadEvidenceSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string().min(2),
  sourceType: z.enum(['api', 'rss', 'filing', 'award', 'directory', 'website']),
  sourceUrl: z.string().url(),
  externalId: z.string().optional(),

  companyName: z.string().min(1).optional(),
  companyWebsite: z.string().url().optional(),
  companyDomain: z.string().optional(),

  founderNames: z.array(z.string().min(1)).default([]),
  /** Public profile URLs the founder chose to publish (never scraped from restricted services). */
  founderProfiles: z.array(z.string().url()).default([]),

  description: z.string().optional(),
  hqCity: z.string().optional(),
  hqState: z.string().length(2).optional(),
  geography: z.string().optional(),
  stage: z.enum(['Pre-seed', 'Seed', 'Series A', 'Stealth']).optional(),
  vertical: z.enum(['health', 'fintech', 'fow', 'sustainability', 'aoi']).optional(),
  subcategory: z.string().optional(),

  fundingAmount: z.number().nonnegative().optional(),
  /** The amount exactly as the source printed it (e.g. "$5M"). */
  fundingAmountText: z.string().optional(),
  lastFundingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accelerator: z.string().optional(),
  tractionSignals: z.array(z.string()).default([]),

  evidenceText: z.string().min(3),
  publishedAt: z.string().optional(),
  discoveredAt: z.string(),

  confidence: z.number().min(0).max(1),
});
export type LeadEvidence = z.infer<typeof leadEvidenceSchema>;

// ── Adapter contract ─────────────────────────────────────────────

export interface AdapterSuccess {
  ok: true;
  leads: LeadEvidence[];
  apiCalls: number;
  /** Honest, human-readable account of what happened. */
  detail: string;
}

export interface AdapterFailure {
  ok: false;
  failure: SourceFailureKind;
  apiCalls: number;
  detail: string;
}

export type AdapterOutcome = AdapterSuccess | AdapterFailure;

/**
 * A source adapter fetches ONE public, authorized source and returns
 * validated LeadEvidence. Adapters must:
 * - use only official APIs / feeds published for consumption,
 * - respect rate limits (client-side budgets + honest handling of
 *   429/403 responses — never retried aggressively),
 * - return an AdapterFailure on any problem. Returning fabricated
 *   or sample leads is prohibited in all cases.
 */
export interface SourceAdapter {
  id: DiscoverySourceId;
  name: string;
  sourceType: LeadEvidence['sourceType'];
  run(query: DiscoveryQuery, budget: { maxApiCalls: number; maxResults: number }): Promise<AdapterOutcome>;
}
