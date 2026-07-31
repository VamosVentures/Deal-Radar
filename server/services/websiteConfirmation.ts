import { z } from 'zod';
import { getCompany, getProvenance, applyFieldUpdate, appendEvidence } from '../db/repos/companies';
import { addDealEvidence, getOpportunity, reclassifyCompany } from '../db/repos/opportunities';
import {
  getQualification, qualifyIssuer, quarantine, quarantineReasonFor,
  recordClassificationChange, unquarantine,
} from './issuerQualification';
import { isDisqualified } from '../../shared/qualification';
import { isSafeExternalUrlResolved } from '../lib/http';
import { isAmbiguousCompanyName } from '../sourcing/classify';
import { tierOf } from '../../shared/opportunity';
import { audit } from '../lib/guard';
import type { OpportunityClass } from '../../shared/opportunity';
import type { QualificationResult } from '../../shared/qualification';

/**
 * Letting a HUMAN confirm an official website, with evidence.
 *
 * The automated discoverer refuses to derive a domain from a common
 * single-word name, and it is right to: a page containing the word
 * "natural" says nothing about a company called Natural, and an earlier
 * run "confirmed" both natural.com and enigma.com on exactly that
 * reasoning. Checking those two afterwards is instructive — natural.com
 * really is Natural AI, Inc., and enigma.com really is a different
 * company entirely (Enigma's site is enigma.inc). The method was invalid
 * in both cases; it simply happened to be right once. That is the whole
 * argument for keeping the guard and adding this instead.
 *
 * So this path is not a bypass of the guard, it is a different kind of
 * evidence. Nothing here derives, fetches-and-hopes, or infers. A person
 * supplies two URLs — the official site, and the source that establishes
 * it is the official site — sees exactly what will change before it
 * changes, and confirms. The reason and both URLs go into the audit
 * trail, so a later reader can re-check the human's work the same way
 * they could re-check a filing.
 *
 * `AMBIGUOUS_NAME_WORDS` and every automatic code path are untouched.
 */

// ── Input ─────────────────────────────────────────────────────────

/**
 * A URL a reviewer can open. Rejects everything the sourcing layer
 * rejects for stored links, because a manually entered URL gets stored
 * and fetched exactly like a sourced one.
 */
const externalUrl = z.string().trim().min(1).refine((raw) => {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return false;
  return raw.length <= 2000;
}, 'Must be a full http(s) URL with a real hostname — no bare IPs, no embedded credentials.');

export const websiteConfirmationSchema = z.object({
  /** The company's own site. Becomes companies.website. */
  website: externalUrl,
  /**
   * What establishes that the site belongs to THIS company: an official
   * announcement, a filing, an accelerator page, an investor
   * announcement, or reporting that links the company to the domain.
   */
  evidenceUrl: externalUrl,
  /** Why the reviewer is satisfied. Recorded verbatim in the history. */
  reason: z.string().trim().min(10, 'Say what the evidence establishes — this is the audit trail.').max(1000),
  actor: z.string().trim().min(1).default('team'),
});
export type WebsiteConfirmationInput = z.infer<typeof websiteConfirmationSchema>;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// ── Preview ───────────────────────────────────────────────────────

export interface WebsiteConfirmationPreview {
  companyId: string;
  companyName: string;
  /** Everything the change would replace, so nothing moves unseen. */
  previous: {
    website: string | null;
    websiteOrigin: string | null;
    classification: OpportunityClass | null;
    qualification: QualificationResult | null;
    independentSources: number;
  };
  proposed: {
    website: string;
    evidenceUrl: string;
    websiteOrigin: 'verified';
    /**
     * Deliberately NOT a predicted classification. The classifier runs
     * on the stored evidence after the change; promising an outcome here
     * would be a guess dressed as a preview.
     */
    effect: string;
  };
  /** Things a reviewer should look at before confirming. Never auto-blocking. */
  warnings: string[];
  /** Hard problems. Present means confirm() will refuse. */
  blockers: string[];
}

export async function previewWebsiteConfirmation(
  companyId: string,
  input: WebsiteConfirmationInput,
): Promise<WebsiteConfirmationPreview | null> {
  const company = getCompany(companyId);
  if (!company) return null;

  const qual = getQualification(companyId);
  const opp = getOpportunity(companyId);
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (hostOf(input.website) === hostOf(input.evidenceUrl)) {
    // A site is not evidence of itself. The whole point of the second
    // URL is that something OTHER than the domain says the domain is
    // theirs — unless it is the company's own announcement, which is a
    // primary record and is allowed, but the reviewer should see it.
    warnings.push(
      'The supporting evidence is on the same host as the website. That is fine when it is the company\'s own '
      + 'announcement (a primary record), and worth a second look otherwise — a site asserting its own identity '
      + 'is not independent corroboration.',
    );
  }
  if (input.website === input.evidenceUrl) {
    blockers.push('The website and the supporting evidence are the same URL. A page cannot be the evidence for itself.');
  }
  if (!(await isSafeExternalUrlResolved(input.website))) {
    blockers.push('The website failed the SSRF safety check (it resolves to a private or reserved address) and will not be stored.');
  }
  if (company.website && company.website !== input.website) {
    warnings.push(`This replaces the website already on record (${company.website}).`);
  }
  if (isAmbiguousCompanyName(company.name)) {
    warnings.push(
      `"${company.name}" is a common single word, so the automatic discoverer refuses to derive a domain for it. `
      + 'That guard is unchanged; your evidence URL is what makes this confirmation valid. Check that the '
      + 'evidence names THIS company and not another one with the same name.',
    );
  }

  return {
    companyId,
    companyName: company.name,
    previous: {
      website: company.website ?? null,
      websiteOrigin: getProvenance(companyId, 'website')?.origin ?? null,
      classification: opp?.classification ?? null,
      qualification: qual?.result ?? null,
      independentSources: qual?.corroboratingSources.length ?? 0,
    },
    proposed: {
      website: input.website,
      evidenceUrl: input.evidenceUrl,
      websiteOrigin: 'verified',
      effect:
        'The website is stored as a verified value, a supporting evidence row is added (web family, tier 3 — it '
        + 'corroborates that the business operates, and can never establish a financing amount or date), and the '
        + 'company is re-qualified and re-classified from its evidence. The resulting classification is whatever '
        + 'the evidence supports; it is not chosen here.',
    },
    warnings,
    blockers,
  };
}

// ── Confirm ───────────────────────────────────────────────────────

export interface WebsiteConfirmationResult {
  ok: boolean;
  message: string;
  preview: WebsiteConfirmationPreview;
  applied?: {
    website: string;
    classificationBefore: OpportunityClass | null;
    classificationAfter: OpportunityClass;
    qualificationBefore: QualificationResult | null;
    qualificationAfter: QualificationResult;
    quarantined: boolean;
    evidenceRowAdded: boolean;
  };
}

/**
 * Apply a confirmation. Requires `confirmed === true` from the caller —
 * a preview can never turn into a write by accident, and the UI's second
 * step is what sets it.
 */
export async function confirmWebsite(
  companyId: string,
  input: WebsiteConfirmationInput,
  confirmed: boolean,
): Promise<WebsiteConfirmationResult | null> {
  const preview = await previewWebsiteConfirmation(companyId, input);
  if (!preview) return null;

  if (!confirmed) {
    return { ok: false, message: 'Not confirmed. Nothing was changed.', preview };
  }
  if (preview.blockers.length > 0) {
    return { ok: false, message: preview.blockers.join(' '), preview };
  }

  const company = getCompany(companyId)!;
  const today = new Date().toISOString().slice(0, 10);
  const classificationBefore = preview.previous.classification;
  const qualificationBefore = preview.previous.qualification;

  // 1. The website itself, as a VERIFIED value. Verified outranks every
  //    automatic origin, so a later extraction cannot quietly replace
  //    what a human confirmed against evidence.
  applyFieldUpdate(
    companyId, 'website', input.website, 'verified',
    `manual-website-confirmation by ${input.actor}: ${input.evidenceUrl}`,
  );

  // 2. The supporting evidence, kept as a first-class company evidence
  //    row so the URL the human relied on survives independently of any
  //    later re-classification.
  appendEvidence(companyId, [{
    claim: `Official website confirmed as ${input.website} by ${input.actor}. ${input.reason}`,
    source: `Manual confirmation (${hostOf(input.evidenceUrl)})`,
    url: input.evidenceUrl,
    date: today,
    type: 'Manual verification',
  }], 'user');

  // 3. Deal evidence: the website is a web-family record that the
  //    company is a going concern. Undated on purpose — a website has no
  //    publication date, and inventing one would let it manufacture
  //    currency it cannot establish.
  const { added: evidenceRowAdded } = addDealEvidence(companyId, {
    opportunityType: 'none',
    sourceId: 'websites',
    sourceName: 'Official company website (human-confirmed)',
    tier: tierOf('websites'),
    url: input.website,
    publishedAt: null,
    retrievedAt: today,
    summary: `${input.actor} confirmed ${input.website} is the official website of ${company.name}, citing ${input.evidenceUrl}. ${input.reason}`,
    whyCurrent: 'Confirms the company is an operating business. Carries no date, so it cannot by itself make an opportunity current.',
    amountUsd: null, amountText: null, roundType: null, investors: [],
  });

  // 4. Re-qualify with live checks (the website is new, so it has never
  //    been fetched), then re-classify from the stored evidence.
  const qualification = await qualifyIssuer(companyId);
  if (isDisqualified(qualification.result) || qualification.result === 'insufficient-evidence') {
    quarantine(companyId, quarantineReasonFor(companyId, qualification));
  } else {
    unquarantine(companyId);
  }
  const opportunity = reclassifyCompany(companyId);

  // 5. The audit trail. Recorded whether or not the classification moved
  //    — "a human confirmed this and nothing changed" is itself a fact
  //    worth being able to look up.
  recordClassificationChange({
    companyId,
    previousClassification: classificationBefore,
    newClassification: opportunity.classification,
    previousQualification: qualificationBefore,
    newQualification: qualification.result,
    reason:
      `Manual website confirmation by ${input.actor}. `
      + `Website ${preview.previous.website ?? '(none on record)'} → ${input.website}. `
      + `Evidence: ${input.evidenceUrl}. Reason given: ${input.reason}`,
  });

  audit({
    provider: 'system', mode: 'local', action: 'company-website-confirmed',
    subject: companyId, outcome: 'ok',
    detail: `${input.actor} confirmed ${input.website} for ${company.name} citing ${input.evidenceUrl}; `
      + `${classificationBefore ?? 'unclassified'} → ${opportunity.classification}.`,
  });

  return {
    ok: true,
    message: classificationBefore === opportunity.classification
      ? `Website recorded. The classification stayed "${opportunity.classification}" — the evidence does not yet support more.`
      : `Website recorded. Classification ${classificationBefore ?? 'unclassified'} → ${opportunity.classification}.`,
    preview,
    applied: {
      website: input.website,
      classificationBefore,
      classificationAfter: opportunity.classification,
      qualificationBefore,
      qualificationAfter: qualification.result,
      quarantined: isDisqualified(qualification.result) || qualification.result === 'insufficient-evidence',
      evidenceRowAdded,
    },
  };
}
