import type { Company, Founder } from '../types';
import { scoreCompany } from './scoring';
import { verticalById } from '../data/taxonomy';
import { flagLabel } from './scoring';
import { HOT_THRESHOLD, TRACK_THRESHOLD } from '../../shared/scoringThresholds';
import {
  bucketRaiseAmount,
  cleanJobTitle,
  HUBSPOT_MAX_FOUNDER_SLOTS,
  isSyncableContactName,
  mapDiverseGroup,
  mapStageToRound,
  matchAcceleratorOption,
  normalizeDomain,
  type EmailGenContext,
  type HubSpotCompanyRecord,
  type HubSpotContactRecord,
  type HubSpotDealRecord,
  type HubSpotFounderSlot,
  type VerifiedDemographic,
} from '../../shared/integrations';

const TODAY = () => new Date().toISOString().slice(0, 10);

export function policyExceptionText(c: Company): string | null {
  return c.flags.length > 0 ? c.flags.map((f) => flagLabel(f)).join('; ') : null;
}

export function recommendationFor(score: number): string {
  if (score >= HOT_THRESHOLD) return 'Prioritize — strong thesis fit';
  if (score >= TRACK_THRESHOLD) return 'Track actively';
  if (score >= 5) return 'Monitor';
  return 'Review — weak fit';
}

/** Founder slots for HubSpot's founder_name__N/founder_email__N/founder_linkedin__N/founder__N_job_title (up to 5). Same placeholder guardrail as Contact creation: an unverified/placeholder name is withheld rather than written into a shared company record. */
export function founderSlotsForHubSpot(c: Company): HubSpotFounderSlot[] {
  return c.founders
    .filter((f) => isSyncableContactName(f.name))
    .slice(0, HUBSPOT_MAX_FOUNDER_SLOTS)
    .map((f) => ({
      name: f.name,
      email: f.email ?? null,
      linkedin: f.linkedin ?? null,
      jobTitle: cleanJobTitle(f.role),
    }));
}

export function companyToHubSpot(c: Company): HubSpotCompanyRecord {
  const demographics = c.founders.flatMap((f) => founderDemographics(f));
  const { diverseGroup, diverseGroupOther } = mapDiverseGroup(demographics);
  return {
    name: c.name,
    domain: normalizeDomain(c.website ?? null),
    website: c.website ?? null,
    city: c.city,
    state: c.state,
    country: 'United States',
    description: c.oneLiner,
    industry: verticalById(c.vertical).name,
    roundCurrentlyRaising: mapStageToRound(c.stage),
    totalRaisingForRound: bucketRaiseAmount(c.raising ?? null),
    acceleratorParticipation: matchAcceleratorOption(c.accelerator ?? null),
    diverseGroup,
    diverseGroupOther,
    founders: founderSlotsForHubSpot(c),
    dealRadarId: c.id,
    dealRadarUrl: `${window.location.origin}/?company=${c.id}`,
  };
}

/**
 * Demographics are copied ONLY from the founder's VerifiedIdentity,
 * which the data layer already requires to carry a basis + source.
 * Founders without a verified identity produce an empty list — the
 * CRM record simply has no demographic data. Nothing is inferred.
 */
export function founderDemographics(f: Founder): VerifiedDemographic[] {
  const id = f.identity;
  if (!id) return [];
  const out: VerifiedDemographic[] = [];
  const base = {
    basis: id.basis,
    sourceName: id.source,
    sourceRef: id.source,
    verificationStatus: (id.basis === 'Verified public statement' ? 'Verified' : 'Self-reported') as VerifiedDemographic['verificationStatus'],
  };
  if (id.latinoLed) out.push({ indicator: 'Latino-led', ...base });
  if (id.femaleLed) out.push({ indicator: 'Female-led', ...base });
  if (id.otherUnderrepresented) out.push({ indicator: id.otherUnderrepresented, ...base });
  return out;
}

/**
 * Which founders may become CRM contacts.
 *
 * ONLY a founder the research pipeline VERIFIED, or one a reviewer
 * corrected by hand. Two things are deliberately excluded:
 *
 *   - Placeholder rows. The imported `founders` table still carries
 *     "Unknown founder" for most companies; pushing one creates a
 *     contact literally named that in a CRM the whole team shares.
 *
 *   - Probable candidates. A candidate is a person we found and are not
 *     willing to assert. Writing one into HubSpot asserts it — to
 *     everyone, permanently, in the system of record that outreach is
 *     built from. The company still syncs; it just syncs without a
 *     contact until somebody confirms who the founder is.
 */
export function isSyncableFounder(f: Founder): boolean {
  return isSyncableContactName(f.name);
}

export function founderToHubSpot(c: Company, f: Founder, owner: string | null): HubSpotContactRecord {
  const [firstName, ...rest] = f.name.split(' ');
  return {
    firstName,
    lastName: rest.join(' '),
    email: f.email ?? null,
    jobTitle: cleanJobTitle(f.role),
    linkedinUrl: f.linkedin ?? null,
    companyName: c.name,
    infoSource: f.emailSource ?? c.evidence[0]?.source ?? 'Deal Radar',
    verificationStatus: f.email ? 'Verified' : 'Unverified',
    relationshipOwner: owner,
    lastOutreachDate: null,
    demographics: founderDemographics(f),
  };
}

export function dealToHubSpot(c: Company, owner: string | null, nextAction: string, reviewer?: string | null): HubSpotDealRecord {
  const fit = scoreCompany(c);
  const evidenceQuality = fit.components.find((x) => x.key === 'evidence')?.points ?? 0;
  const risks = [
    ...fit.exceptions.map((e) => e.message),
    ...fit.components.filter((x) => x.points / x.max < 0.5).map((x) => `Low ${x.label.toLowerCase()}: ${x.rationale}`),
  ].join(' ') || 'No major risks flagged by the scoring model.';
  return {
    companyName: c.name,
    fitScore: fit.score,
    recommendation: recommendationFor(fit.score),
    vertical: verticalById(c.vertical).name,
    stage: c.stage,
    scoreBreakdown: fit.components.map((x) => ({ label: x.label, points: x.points, max: x.max })),
    rationale: fit.components.map((x) => `${x.label}: ${x.rationale}`).join(' '),
    risks,
    evidenceQualityScore: evidenceQuality,
    policyException: policyExceptionText(c),
    sourcingStatus: 'Surfaced by Deal Radar',
    dateSurfaced: c.dateFirstSurfaced ?? TODAY(),
    nextAction,
    relationshipOwner: owner,
    dealRadarId: c.id,
    dealRadarUrl: `${window.location.origin}/?company=${c.id}`,
    scoreExplanation: fit.explanation,
    approvedBy: reviewer ?? owner,
    approvalDate: TODAY(),
    sourceUrls: c.evidence.map((e) => e.url),
  };
}

/** Build the generation context from VERIFIED radar data only. */
export function outreachContext(c: Company, f: Founder, sender: { name: string; role: string }): EmailGenContext {
  const fit = scoreCompany(c);
  const v = verticalById(c.vertical);
  const milestone = [...c.evidence]
    .filter((e) => e.type === 'News' || e.type === 'Product' || e.type === 'Accelerator')
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  // Founder detail: only the sourced background line when the founder has
  // any verified profile behind it — otherwise null, never guessed.
  const verifiedDetail = f.identity || f.emailSource ? `${f.background} (${f.role})` : null;
  return {
    companyId: c.id,
    companyName: c.name,
    companyDescription: c.oneLiner,
    vertical: v.name,
    subcategory: c.subcategory,
    whyFits: fit.components.find((x) => x.key === 'thesis')?.rationale ?? '',
    founderFirstName: f.name.split(' ')[0],
    founderFullName: f.name,
    founderRole: f.role,
    founderEmail: f.email ?? null,
    verifiedFounderDetail: verifiedDetail,
    recentMilestone: milestone ? `${milestone.claim} (${milestone.source}, ${milestone.date})` : null,
    acceleratorOrFunding: c.accelerator ?? c.raising ?? null,
    sourceLinks: c.evidence.map((e) => ({ label: `${e.source} — ${e.claim}`, url: e.url })),
    senderName: sender.name,
    senderRole: sender.role,
    tone: 'Warm and conversational',
    customInstructions: '',
    meetingAsk: 'a 25-minute intro call in the next two weeks',
  };
}
