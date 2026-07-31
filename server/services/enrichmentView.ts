import {
  allFieldCorrections, allFounderCandidates, allFounderResolutions, allResearchAttempts,
  allStageResolutions, allVerticalClassifications, latestCorrections, listFounderCandidates,
  listFieldCorrections, listResearchAttempts, getFounderResolution, getStageResolution,
  getVerticalClassification,
} from '../db/repos/enrichment';
import {
  FOUNDER_STATUS_TO_RESOLUTION, NON_SECTOR_LABEL, NON_SECTOR_STATUS, RESOLUTION_STATE_LABELS,
  SECTOR_LABELS, SOURCE_FAMILY_SPECS, STAGE_LABELS, isClassified,
  type CompanyEnrichment, type FieldCorrection, type FounderCandidate, type FounderResolution,
  type ResearchAttempt, type SourceFamily, type StageResolution, type VerticalClassification,
} from '../../shared/enrichment';

/**
 * Assembling the enrichment payload the API returns and the UI renders.
 *
 * The whole point of this layer is that a field NEVER arrives at the
 * client as a bare null or the string "unknown". Every one carries its
 * resolution state, a human summary written from real research records,
 * the evidence behind it, which source families were attempted, when,
 * and what to do next. A client that has this cannot render "Unknown"
 * even by accident, because there is no null to fall back to.
 *
 * Reviewer corrections are layered ON TOP of the automated verdict here,
 * at read time, rather than by overwriting the stored research. Both are
 * present in the response: the correction becomes the displayed value and
 * the automated evidence stays visible underneath it. Six months from now
 * a reader can still see what the pipeline concluded and what a human
 * decided, and can tell which is which.
 */

/**
 * The served shape lives in shared/enrichment.ts so the API contract
 * has one definition rather than a server copy and a client copy that
 * drift apart.
 */
export type { CompanyEnrichment };

const NEVER_RESEARCHED_NEXT_ACTION =
  'Run enrichment for this company (npm run db:enrich -- --apply --company-id <id>) to search every public source family.';

function attemptEvidence(attempts: ResearchAttempt[]): SourceFamily[] {
  return attempts.map((a) => a.sourceFamily);
}

/**
 * The founder field.
 *
 * The canned "Identity not on record — requires human verification,
 * never inferred" string is gone. What replaces it depends on what
 * actually happened, and the four cases read very differently:
 *
 *   never researched   says so, and tells you how to start
 *   exhausted          names the date and the families searched
 *   candidate          names the candidate and refuses to assert it
 *   conflict           names both people and the disagreement
 */
function buildFounderField(
  resolution: FounderResolution | null,
  candidates: FounderCandidate[],
  attempts: ResearchAttempt[],
  correction: FieldCorrection | undefined,
): CompanyEnrichment['founder'] {
  const evidence = candidates.map((c) => ({
    url: c.sourceUrl,
    family: c.sourceFamily,
    label: `${c.fullName}${c.title ? ` — ${c.title}` : ''} (${SOURCE_FAMILY_SPECS[c.sourceFamily].label})`,
    publishedAt: c.publishedAt,
  }));

  if (!resolution) {
    return {
      state: 'manual-review',
      value: null,
      inferred: false,
      confidence: 0,
      summary: 'This company has not been through founder research yet. No source family has been attempted, '
        + 'so nothing is known either way — this is an absence of research, not an absence of a founder.',
      nextAction: NEVER_RESEARCHED_NEXT_ACTION,
      evidence,
      sourcesAttempted: attemptEvidence(attempts),
      lastResearchedAt: null,
      conflicts: [],
      candidates,
      status: 'not-researched',
    };
  }

  const conflicts = resolution.status === 'conflicting-founder-evidence'
    ? candidates.map((c) => ({
      detail: `${c.fullName}${c.title ? ` — ${c.title}` : ''} per ${SOURCE_FAMILY_SPECS[c.sourceFamily].label}`,
      sourceUrl: c.sourceUrl,
    }))
    : [];

  // A reviewer's correction becomes the displayed value. The automated
  // status stays on the object, and the candidate evidence stays in
  // `candidates`, so the correction is visibly a correction.
  if (correction) {
    return {
      state: 'confirmed',
      value: { name: correction.newValue, title: null },
      inferred: false,
      confidence: 1,
      summary: `${correction.newValue} — corrected by ${correction.reviewerLabel} on `
        + `${correction.at.slice(0, 10)}. Reason: ${correction.reason}. `
        + `The automated research concluded "${resolution.status}" and is preserved below.`,
      nextAction: 'No action required. The reviewer correction stands over the automated result.',
      evidence: [
        ...(correction.sourceUrl
          ? [{ url: correction.sourceUrl, family: 'company-site' as SourceFamily, label: `Reviewer source — ${correction.reviewerLabel}`, publishedAt: correction.at.slice(0, 10) }]
          : []),
        ...evidence,
      ],
      sourcesAttempted: resolution.sourcesAttempted,
      lastResearchedAt: resolution.researchedAt,
      conflicts,
      candidates,
      status: resolution.status,
    };
  }

  const verified = resolution.status === 'verified-founder';
  const bestCandidate = candidates[0];

  return {
    state: FOUNDER_STATUS_TO_RESOLUTION[resolution.status],
    value: verified && resolution.resolvedName
      ? { name: resolution.resolvedName, title: resolution.resolvedTitle }
      // A probable candidate is NEVER returned as the value. It travels
      // in `candidates` where the client must render it as unconfirmed.
      : null,
    inferred: false,
    confidence: verified ? 0.9 : (bestCandidate?.confidence ?? 0),
    summary: resolution.summary,
    nextAction: resolution.nextAction,
    evidence,
    sourcesAttempted: resolution.sourcesAttempted,
    lastResearchedAt: resolution.researchedAt,
    conflicts,
    candidates,
    status: resolution.status,
  };
}

function buildVerticalField(
  v: VerticalClassification | null,
  attempts: ResearchAttempt[],
  correction: FieldCorrection | undefined,
): CompanyEnrichment['vertical'] {
  if (!v) {
    return {
      state: 'manual-review',
      value: null,
      inferred: false,
      confidence: 0,
      summary: 'This company has not been classified yet. No sector is assigned, and none is guessed.',
      nextAction: NEVER_RESEARCHED_NEXT_ACTION,
      evidence: [],
      sourcesAttempted: attemptEvidence(attempts),
      lastResearchedAt: null,
      conflicts: [],
    };
  }

  const sector = v.primarySector;
  const classified = isClassified(sector);
  const evidence = v.sourceUrl
    ? [{ url: v.sourceUrl, family: 'company-site' as SourceFamily, label: 'Classification source', publishedAt: null }]
    : [];

  if (correction) {
    const label = SECTOR_LABELS[correction.newValue as keyof typeof SECTOR_LABELS] ?? correction.newValue;
    return {
      state: 'confirmed',
      value: {
        primarySector: correction.newValue,
        primaryLabel: label,
        secondarySector: v.secondarySector,
        subvertical: v.subvertical,
        countsTowardRanking: correction.newValue !== NON_SECTOR_STATUS,
        evidenceGap: null,
      },
      inferred: false,
      confidence: 1,
      summary: `${label} — corrected by ${correction.reviewerLabel} on ${correction.at.slice(0, 10)}. `
        + `Reason: ${correction.reason}. Automated classification was "${v.primarySector}" and is preserved.`,
      nextAction: 'No action required.',
      evidence,
      sourcesAttempted: attemptEvidence(attempts),
      lastResearchedAt: v.classifiedAt,
      conflicts: [],
    };
  }

  return {
    state: classified ? (v.basis === 'explicit' ? 'confirmed' : 'bounded-inference') : 'research-exhausted',
    value: {
      primarySector: sector,
      primaryLabel: isClassified(sector) ? SECTOR_LABELS[sector] : NON_SECTOR_LABEL,
      secondarySector: v.secondarySector,
      subvertical: v.subvertical,
      countsTowardRanking: classified,
      evidenceGap: v.evidenceGap,
    },
    inferred: classified && v.basis === 'inferred',
    confidence: v.confidence,
    summary: v.reason,
    nextAction: classified
      ? (v.basis === 'inferred'
        ? 'Confirm the sector against the company’s own description before relying on it for a shortlist.'
        : 'No action required.')
      : `Resolve the identity gap first: ${v.evidenceGap ?? 'company identity is unresolved'}. `
        + 'This record is excluded from sector rankings until then.',
    evidence,
    sourcesAttempted: attemptEvidence(attempts),
    lastResearchedAt: v.classifiedAt,
    conflicts: [],
  };
}

function buildStageField(
  s: StageResolution | null,
  attempts: ResearchAttempt[],
  correction: FieldCorrection | undefined,
): CompanyEnrichment['stage'] {
  if (!s) {
    return {
      state: 'manual-review',
      value: null,
      inferred: false,
      confidence: 0,
      summary: 'This company’s stage has not been researched yet.',
      nextAction: NEVER_RESEARCHED_NEXT_ACTION,
      evidence: [],
      sourcesAttempted: attemptEvidence(attempts),
      lastResearchedAt: null,
      conflicts: [],
    };
  }

  const evidence = s.evidenceUrl
    ? [{ url: s.evidenceUrl, family: 'funding-press' as SourceFamily, label: 'Stage evidence', publishedAt: s.evidenceDate }]
    : [];

  if (correction) {
    const label = STAGE_LABELS[correction.newValue as keyof typeof STAGE_LABELS] ?? correction.newValue;
    return {
      state: 'confirmed',
      value: { stage: correction.newValue, label },
      inferred: false,
      confidence: 1,
      summary: `${label} — corrected by ${correction.reviewerLabel} on ${correction.at.slice(0, 10)}. `
        + `Reason: ${correction.reason}. Automated resolution was "${s.stage}" and is preserved.`,
      nextAction: 'No action required.',
      evidence,
      sourcesAttempted: attemptEvidence(attempts),
      lastResearchedAt: s.lastCheckedAt,
      conflicts: [],
    };
  }

  const conflict = s.stage === 'stage-conflict-manual-review';
  return {
    state: conflict ? 'conflict' : (s.basis === 'explicit' ? 'confirmed' : 'bounded-inference'),
    value: { stage: s.stage, label: STAGE_LABELS[s.stage] },
    inferred: s.basis === 'inferred',
    confidence: s.confidence,
    summary: s.explanation,
    nextAction: conflict
      ? 'Compare the conflicting sources by date and confirm the current round.'
      : s.basis === 'inferred'
        ? 'The round is not publicly disclosed. Confirm directly with the company before relying on it.'
        : 'No action required.',
    evidence,
    sourcesAttempted: attemptEvidence(attempts),
    lastResearchedAt: s.lastCheckedAt,
    conflicts: s.conflicts.map((c) => ({ detail: `${c.stage}: ${c.detail}`, sourceUrl: c.sourceUrl })),
  };
}

/** One company's enrichment, assembled. */
export function companyEnrichment(companyId: string): CompanyEnrichment {
  const resolution = getFounderResolution(companyId);
  const candidates = listFounderCandidates(companyId);
  const attempts = listResearchAttempts(companyId);
  const corrections = listFieldCorrections(companyId);
  const latest = latestCorrections(companyId);

  return {
    founder: buildFounderField(resolution, candidates, attempts, latest.founder),
    vertical: buildVerticalField(getVerticalClassification(companyId), attempts, latest.vertical),
    stage: buildStageField(getStageResolution(companyId), attempts, latest.stage),
    corrections,
    attempts,
  };
}

/**
 * Every company's enrichment in one pass.
 *
 * Built from six bulk queries rather than N per-company round trips —
 * the companies payload is requested on every page load and the review
 * queue holds 209 records today.
 */
export function allCompanyEnrichment(): Record<string, CompanyEnrichment> {
  const resolutions = allFounderResolutions();
  const candidates = allFounderCandidates();
  const attempts = allResearchAttempts();
  const verticals = allVerticalClassifications();
  const stages = allStageResolutions();
  const corrections = allFieldCorrections();

  const ids = new Set([
    ...Object.keys(resolutions), ...Object.keys(candidates), ...Object.keys(attempts),
    ...Object.keys(verticals), ...Object.keys(stages), ...Object.keys(corrections),
  ]);

  const out: Record<string, CompanyEnrichment> = {};
  for (const id of ids) {
    const cs = corrections[id] ?? [];
    const latest: Partial<Record<'founder' | 'vertical' | 'stage', FieldCorrection>> = {};
    for (const c of cs) if (!latest[c.field]) latest[c.field] = c;
    const at = attempts[id] ?? [];
    out[id] = {
      founder: buildFounderField(resolutions[id] ?? null, candidates[id] ?? [], at, latest.founder),
      vertical: buildVerticalField(verticals[id] ?? null, at, latest.vertical),
      stage: buildStageField(stages[id] ?? null, at, latest.stage),
      corrections: cs,
      attempts: at,
    };
  }
  return out;
}

export { RESOLUTION_STATE_LABELS, NON_SECTOR_STATUS };
