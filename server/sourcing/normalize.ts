import { normalizeDomain } from '../../shared/integrations';
import type { CandidateEvidence, VERTICAL_ID_VALUES } from '../../shared/discovery';
import type { LeadEvidence } from './types';

/**
 * Normalization: turn validated LeadEvidence into the pipeline's
 * candidate shape. Nothing is invented here — absent facts stay
 * absent (the pipeline renders them as 'Unknown' for humans).
 */

/** Company-level cleanup: trim names, derive the domain from the website when missing. */
export function normalizeLead(lead: LeadEvidence): LeadEvidence {
  const companyName = lead.companyName?.trim().replace(/\s+/g, ' ');
  const companyDomain = lead.companyDomain ?? normalizeDomain(lead.companyWebsite ?? null) ?? undefined;
  return {
    ...lead,
    companyName: companyName && companyName.length > 0 ? companyName : undefined,
    companyDomain,
    confidence: Math.min(1, Math.max(0, lead.confidence)),
  };
}

/** `2026-07-23T15:00:00.000Z` or `2026-07-23` → `2026-07-23`; anything else → null. */
export function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Evidence normalization: one LeadEvidence → one citable evidence row. */
export function leadToEvidence(lead: LeadEvidence): CandidateEvidence {
  return {
    claim: lead.evidenceText,
    source: lead.sourceName,
    url: lead.sourceUrl,
    dateAccessed: lead.discoveredAt.slice(0, 10),
    // Structured, not prose. An ISO timestamp is trimmed to a date; a
    // value we cannot parse stays null rather than being guessed.
    publishedAt: toIsoDate(lead.publishedAt),
    verificationStatus: 'Not verified',
    confidence: lead.confidence,
    notes: [
      lead.publishedAt ? `Published ${lead.publishedAt.slice(0, 10)}` : null,
      lead.externalId ? `Source record ${lead.externalId}` : null,
    ].filter(Boolean).join('; '),
  };
}

/**
 * The raw candidate shape the discovery pipeline consumes (kept from
 * the existing pipeline so downstream validation/dedup/import are
 * unchanged).
 */
/**
 * Evidence as an adapter may hand it over: `publishedAt` is optional
 * here because most sources genuinely do not date their records, and
 * Zod fills the null. Every other field stays required — an adapter
 * that omits a URL or a claim is a bug, not a missing fact.
 */
export type RawEvidence = Omit<CandidateEvidence, 'publishedAt'> & { publishedAt?: string | null };

export interface RawCandidate {
  companyName: string;
  externalId?: string;
  website?: string;
  pitch?: string;
  vertical?: (typeof VERTICAL_ID_VALUES)[number];
  subcategory?: string;
  stage?: 'Pre-seed' | 'Seed' | 'Series A' | 'Stealth';
  hqCity?: string;
  hqState?: string;
  foundingYear?: number;
  founderNames?: string[];
  accelerator?: string;
  publicFunding?: string;
  mostRecentRound?: string;
  fundingDate?: string;
  tractionSignals?: string[];
  evidence: RawEvidence[];
  confidence: number;
}

/**
 * Leads without a company name cannot become candidates (there is
 * nothing to review) — they are dropped and counted, never guessed.
 */
export function leadsToRawCandidates(leads: LeadEvidence[]): { candidates: RawCandidate[]; droppedNoCompany: number } {
  const candidates: RawCandidate[] = [];
  let droppedNoCompany = 0;
  for (const raw of leads) {
    const lead = normalizeLead(raw);
    if (!lead.companyName) {
      droppedNoCompany += 1;
      continue;
    }
    candidates.push({
      companyName: lead.companyName,
      externalId: lead.externalId,
      website: lead.companyWebsite,
      pitch: lead.description,
      vertical: lead.vertical,
      subcategory: lead.subcategory,
      stage: lead.stage,
      hqCity: lead.hqCity,
      hqState: lead.hqState,
      founderNames: lead.founderNames.length > 0 ? lead.founderNames : undefined,
      accelerator: lead.accelerator,
      publicFunding: lead.fundingAmountText ?? (lead.fundingAmount !== undefined ? `$${lead.fundingAmount.toLocaleString('en-US')}` : undefined),
      fundingDate: lead.lastFundingDate,
      tractionSignals: lead.tractionSignals.length > 0 ? lead.tractionSignals : undefined,
      evidence: [leadToEvidence(lead)],
      confidence: lead.confidence,
    });
  }
  return { candidates, droppedNoCompany };
}
