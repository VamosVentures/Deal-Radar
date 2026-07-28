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

/** Evidence normalization: one LeadEvidence → one citable evidence row. */
export function leadToEvidence(lead: LeadEvidence): CandidateEvidence {
  return {
    claim: lead.evidenceText,
    source: lead.sourceName,
    url: lead.sourceUrl,
    dateAccessed: lead.discoveredAt.slice(0, 10),
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
  evidence: CandidateEvidence[];
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
