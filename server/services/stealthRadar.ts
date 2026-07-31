import { getDb } from '../db/client';
import { audit } from '../lib/guard';
import { getQualification, recordClassificationChange } from './issuerQualification';
import { companyEnrichment } from './enrichmentView';
import {
  getFounderCandidate, listFounderCandidates, relationshipsFor, reviewFounderCandidate,
  recordFieldCorrection, type StoredEdge,
} from '../db/repos/enrichment';
import { normalizeCompanyKey, normalizeDomainKey } from '../sourcing/identity';
import {
  FOUNDER_STATUS_LABELS, SOURCE_FAMILY_SPECS, MATCH_SIGNAL_TEXT, outcomeAnswered, personKey,
  type FounderCandidate, type FounderResolutionStatus, type MatchSignal, type ResearchAttempt,
  type SourceFamily,
} from '../../shared/enrichment';

/**
 * Stealth Founder Radar.
 *
 * WHAT CHANGED, AND WHY
 *
 * This used to be a list of hand-entered signals in a key-value blob with
 * a deterministic template stapled on top. It could not answer the only
 * question it existed to answer — "who is behind this company?" — because
 * it was never connected to the companies. The word "stealth" was a
 * label, not a finding.
 *
 * It now runs over the REAL company records and the evidence-backed
 * relationship graph that founder enrichment builds. A stealth company
 * here is one the pipeline has actually examined and found to have a low
 * public profile: financing evidence exists, but the founders are not
 * publicly attributable, or the sources disagree about who they are.
 * That is a research result, and every row carries the evidence, the
 * sources attempted, the last-checked date, and the next action.
 *
 * WHAT IT STILL WILL NOT DO
 *
 * No demographic inference of any kind — not from a name, a photograph, a
 * language, a geography, or a surname. No login-walled sources. No
 * silently picking one person when two sources disagree: a conflict is
 * displayed as a conflict, because hiding it behind a confident-looking
 * name is how a wrong person ends up in an outreach email.
 */

export const RADAR_FILTERS = [
  'all', 'verified', 'probable', 'conflicting', 'research-exhausted', 'manual-review',
] as const;
export type RadarFilter = (typeof RADAR_FILTERS)[number];

const FILTER_TO_STATUS: Record<Exclude<RadarFilter, 'all'>, FounderResolutionStatus> = {
  verified: 'verified-founder',
  probable: 'probable-founder-candidate',
  conflicting: 'conflicting-founder-evidence',
  'research-exhausted': 'research-exhausted',
  'manual-review': 'manual-review-required',
};

export interface RadarPerson {
  candidateId: number;
  personKey: string;
  fullName: string;
  title: string | null;
  sourceUrl: string;
  sourceFamily: SourceFamily;
  sourceFamilyLabel: string;
  publishedAt: string | null;
  supportingText: string;
  /** Plain-language reasons this person is tied to this company. */
  matchEvidence: string[];
  matchScore: number;
  confidence: number;
  /** True only when the resolution verified this specific person. */
  verified: boolean;
  reviewDecision: 'confirmed' | 'rejected' | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface RadarEntry {
  companyId: string;
  companyName: string;
  website: string | null;
  city: string | null;
  state: string | null;
  /** Why this record is on the radar. */
  stealthReason: string;
  status: FounderResolutionStatus | 'not-researched';
  statusLabel: string;
  /** Verified people, kept separate from candidates by construction. */
  verifiedFounders: RadarPerson[];
  candidates: RadarPerson[];
  conflicts: { detail: string; sourceUrl: string }[];
  /** Research progress: which families answered, out of how many. */
  progress: { answered: number; total: number; families: { family: SourceFamily; label: string; outcome: string; detail: string }[] };
  lastCheckedAt: string | null;
  nextAction: string;
  /** Evidence-backed edges touching this company. */
  relationships: { relation: string; to: string; toType: string; evidenceUrl: string; sourceFamily: SourceFamily; confidence: number }[];
  financing: { amountText: string | null; roundType: string | null; investors: string[]; url: string; publishedAt: string | null }[];
  /** SEC-derived facts: officers, locations, former names. */
  filingFacts: { label: string; value: string; url: string }[];
}

/** Rendered match evidence — never a bare signal id in the UI. */
function describeMatch(signals: MatchSignal[]): string[] {
  return signals
    .filter((s) => s !== 'name-only')
    .map((s) => MATCH_SIGNAL_TEXT[s]);
}

function toRadarPerson(c: FounderCandidate, verifiedKey: string | null): RadarPerson {
  return {
    candidateId: c.id,
    personKey: c.personKey,
    fullName: c.fullName,
    title: c.title,
    sourceUrl: c.sourceUrl,
    sourceFamily: c.sourceFamily,
    sourceFamilyLabel: SOURCE_FAMILY_SPECS[c.sourceFamily].label,
    publishedAt: c.publishedAt,
    supportingText: c.supportingText,
    matchEvidence: describeMatch(c.matchSignals),
    matchScore: c.matchScore,
    confidence: c.confidence,
    verified: verifiedKey !== null && c.personKey === verifiedKey,
    reviewDecision: c.reviewDecision,
    reviewedBy: c.reviewedBy,
    reviewedAt: c.reviewedAt,
  };
}

/**
 * Deduplicate people within one company.
 *
 * Safe direction only: two rows merge when their person keys are already
 * identical (the same human found in two sources). Near-matches are NOT
 * merged — "Rob Smith" and "Robert Smith" may be one person or two, and
 * fusing two people's identities is not something a later reviewer can
 * undo, whereas a visible duplicate takes one click to resolve.
 */
function dedupePeople(people: RadarPerson[]): RadarPerson[] {
  const byKey = new Map<string, RadarPerson>();
  for (const p of people) {
    const existing = byKey.get(p.personKey);
    if (!existing) { byKey.set(p.personKey, p); continue; }
    // Keep the strongest evidence, but union the match reasons so the
    // display shows everything that ties the person to the company.
    const winner = p.matchScore > existing.matchScore ? p : existing;
    const other = winner === p ? existing : p;
    byKey.set(p.personKey, {
      ...winner,
      matchEvidence: [...new Set([...winner.matchEvidence, ...other.matchEvidence])],
      confidence: Math.max(winner.confidence, other.confidence),
    });
  }
  return [...byKey.values()].sort((a, b) => b.matchScore - a.matchScore || b.confidence - a.confidence);
}

interface CompanyRow {
  id: string; name: string; website: string | null; city: string | null; state: string | null;
  quarantined: number; discovery_source: string | null;
}

/**
 * Is this company genuinely low-profile, as opposed to simply
 * unresearched?
 *
 * The distinction matters: a record nobody has looked at is not a stealth
 * company, and listing it as one would fill the radar with our own
 * backlog rather than with findings. A company qualifies when research
 * has run and came back without a publicly attributable founder, or with
 * sources that disagree.
 */
function stealthReasonFor(
  status: FounderResolutionStatus | 'not-researched',
  hasFinancing: boolean,
  qualified: boolean,
): string | null {
  if (status === 'not-researched') return null;
  if (status === 'verified-founder') return null;

  const financing = hasFinancing
    ? 'Financing evidence is on record'
    : 'No financing evidence is on record';

  switch (status) {
    case 'conflicting-founder-evidence':
      return `${financing}, and the sources naming leadership disagree with one another. `
        + 'Displayed as a conflict rather than resolved automatically.';
    case 'probable-founder-candidate':
      return `${financing}, and a probable founder candidate was found but could not be confirmed `
        + 'from a source authoritative enough to assert it.';
    case 'research-exhausted':
      return `${financing}, and every applicable public source family has been searched without `
        + `finding an attributable founder${qualified ? ' — an operating company with no public founder attribution' : ''}.`;
    case 'manual-review-required':
      return `${financing}, and founder research is incomplete because one or more sources did not respond.`;
    default:
      return null;
  }
}

export interface RadarOptions {
  filter?: RadarFilter;
  limit?: number;
}

/**
 * Build the radar from live records.
 *
 * Idempotent and side-effect free — this is a read. Re-running it never
 * duplicates a person, an edge, or a history entry, because it writes
 * nothing; the graph it reads is built by the enrichment pipeline, whose
 * writes are upserts.
 */
export function buildRadar(opts: RadarOptions = {}): RadarEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, website, city, state, quarantined, discovery_source
    FROM companies WHERE status = 'active' ORDER BY created_at DESC, id
  `).all() as unknown as CompanyRow[];

  const entries: RadarEntry[] = [];

  for (const row of rows) {
    const enrichment = companyEnrichment(row.id);
    const status = enrichment.founder.status;

    const dealRows = db.prepare(`
      SELECT url, published_at, amount_text, round_type, investors
      FROM deal_evidence WHERE company_id = ? ORDER BY id
    `).all(row.id) as { url: string; published_at: string | null; amount_text: string | null; round_type: string | null; investors: string }[];

    const qual = getQualification(row.id);
    const hasFinancing = dealRows.length > 0;
    const reason = stealthReasonFor(status, hasFinancing, qual?.result === 'qualified-operating-company');
    if (!reason) continue;

    if (opts.filter && opts.filter !== 'all') {
      if (status !== FILTER_TO_STATUS[opts.filter]) continue;
    }

    const candidates = listFounderCandidates(row.id);
    const verifiedKey = enrichment.founder.value
      ? personKey(enrichment.founder.value.name)
      : null;
    const people = dedupePeople(candidates.map((c) => toRadarPerson(c, verifiedKey)));

    // Verified and candidate people are separated STRUCTURALLY, into two
    // arrays, rather than by a flag the UI might forget to read. A
    // probable candidate cannot be rendered as a verified founder by a
    // template that iterates the wrong list, because it is not in it.
    // A REJECTED person stays in the list, marked as rejected, rather
    // than disappearing. The whole point of keeping the automated
    // evidence is that a reviewer can see what was found and what was
    // decided about it; a candidate that vanishes on rejection takes the
    // reasoning with it, and the next person to look has no way to tell
    // "rejected after review" from "never found".
    //
    // A rejected person is never counted as verified, whatever the
    // automated resolution concluded.
    const verifiedFounders = people.filter((p) => p.verified && p.reviewDecision !== 'rejected');
    const candidatePeople = people.filter((p) => !p.verified || p.reviewDecision === 'rejected');

    const attempts: ResearchAttempt[] = enrichment.attempts;
    const answered = attempts.filter((a) => outcomeAnswered(a.outcome)).length;

    const edges: StoredEdge[] = relationshipsFor('company', row.id);
    const personEdges = candidates.flatMap((c) => relationshipsFor('person', c.personKey))
      .filter((e) => e.toId === row.id || e.fromId === row.id);

    const filingFacts: RadarEntry['filingFacts'] = [];
    for (const c of candidates.filter((x) => x.sourceFamily === 'sec-form-d')) {
      filingFacts.push({ label: `Related person — ${c.title ?? 'relationship not stated'}`, value: c.fullName, url: c.sourceUrl });
    }
    if (row.city && row.city !== 'Unknown') {
      filingFacts.push({
        label: 'Recorded location',
        value: [row.city, row.state].filter((x) => x && x !== 'Unknown' && x !== '??').join(', '),
        url: enrichment.founder.evidence[0]?.url ?? row.website ?? '',
      });
    }

    entries.push({
      companyId: row.id,
      companyName: row.name,
      website: row.website,
      city: row.city && row.city !== 'Unknown' ? row.city : null,
      state: row.state && row.state !== '??' && row.state !== 'Unknown' ? row.state : null,
      stealthReason: reason,
      status,
      statusLabel: status === 'not-researched' ? 'Not researched' : FOUNDER_STATUS_LABELS[status],
      verifiedFounders,
      candidates: candidatePeople,
      conflicts: enrichment.founder.conflicts,
      progress: {
        answered,
        total: attempts.length,
        families: attempts.map((a) => ({
          family: a.sourceFamily,
          label: SOURCE_FAMILY_SPECS[a.sourceFamily].label,
          outcome: a.outcome,
          detail: a.detail,
        })),
      },
      lastCheckedAt: enrichment.founder.lastResearchedAt,
      nextAction: enrichment.founder.nextAction,
      relationships: [...edges, ...personEdges]
        .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
        .map((e) => ({
          relation: e.relation,
          to: e.fromType === 'company' && e.fromId === row.id ? e.toId : e.fromId,
          toType: e.fromType === 'company' && e.fromId === row.id ? e.toType : e.fromType,
          evidenceUrl: e.evidenceUrl,
          sourceFamily: e.sourceFamily,
          confidence: e.confidence,
        })),
      financing: dealRows.map((d) => ({
        amountText: d.amount_text,
        roundType: d.round_type,
        investors: JSON.parse(d.investors || '[]') as string[],
        url: d.url,
        publishedAt: d.published_at,
      })),
      filingFacts,
    });

    if (opts.limit && entries.length >= opts.limit) break;
  }

  return entries;
}

/** Counts per filter, so the UI can label its tabs from real data. */
export function radarCounts(): Record<RadarFilter, number> {
  const all = buildRadar();
  const counts = { all: all.length } as Record<RadarFilter, number>;
  for (const [filter, status] of Object.entries(FILTER_TO_STATUS)) {
    counts[filter as RadarFilter] = all.filter((e) => e.status === status).length;
  }
  return counts;
}

/**
 * A reviewer confirms or rejects a founder candidate.
 *
 * The automated evidence is preserved in full — this writes a decision
 * ALONGSIDE it (see reviewFounderCandidate), records an attributed
 * correction, and appends a classification-history entry. Nothing is
 * overwritten and nothing is deleted, so the record still shows what the
 * research concluded and what the human decided.
 *
 * Idempotent: confirming an already-confirmed candidate rewrites the same
 * decision rather than stacking duplicates in the candidate table. The
 * correction and history rows are append-only by design — those are the
 * audit trail, and a repeated decision is itself a fact worth keeping.
 */
export function reviewCandidate(args: {
  candidateId: number;
  decision: 'confirmed' | 'rejected';
  reason: string;
  reviewer: { id: string; label: string; source: string };
}): { candidate: FounderCandidate; companyId: string } {
  const existing = getFounderCandidate(args.candidateId);
  if (!existing) throw Object.assign(new Error('Founder candidate not found.'), { status: 404 });

  const updated = reviewFounderCandidate(
    args.candidateId, args.decision, { id: args.reviewer.id, label: args.reviewer.label }, args.reason,
  )!;

  recordFieldCorrection({
    companyId: existing.companyId,
    field: 'founder',
    // The previous value is the AUTOMATED conclusion, so the correction
    // record shows what was changed away from, not just what it became.
    previousValue: `${existing.status}: ${existing.fullName}${existing.title ? ` (${existing.title})` : ''}`,
    newValue: args.decision === 'confirmed'
      ? `${existing.fullName}${existing.title ? ` (${existing.title})` : ''}`
      : `Rejected: ${existing.fullName}`,
    reason: args.reason,
    sourceUrl: existing.sourceUrl,
    reviewer: args.reviewer,
  });

  recordClassificationChange({
    companyId: existing.companyId,
    previousClassification: `founder:${existing.status}`,
    newClassification: `founder:reviewer-${args.decision}`,
    // A founder decision does NOT touch the qualification verdict, and
    // saying so explicitly is the point: enrichment may never promote a
    // company because a field became populated. Both qualification
    // columns stay null so the history row cannot be misread as a
    // qualification change.
    previousQualification: null,
    newQualification: null,
    reason: `${args.reviewer.label} ${args.decision} ${existing.fullName} as founder. ${args.reason}`,
  });

  // The audit log records THAT a decision was made and by whom, with the
  // candidate's name — which is already public, sourced information — but
  // no session material, no credentials, and no free-text beyond the
  // reviewer's stated reason.
  audit({
    provider: 'system', mode: 'local', action: 'stealth-founder-review',
    subject: existing.companyId, outcome: 'ok',
    detail: `${args.reviewer.label} ${args.decision} founder candidate ${existing.fullName} `
      + `(candidate ${args.candidateId}, source ${SOURCE_FAMILY_SPECS[existing.sourceFamily].label}). `
      + 'Automated evidence preserved.',
  });

  return { candidate: updated, companyId: existing.companyId };
}

/**
 * Companies that look like duplicates of one another, by normalized name
 * or shared domain.
 *
 * Reported, never merged. Merging is an existing, reviewed workflow
 * (possible_duplicates + resolvePossibleDuplicate); this surfaces the
 * candidates on the radar so a reviewer can see that two stealth records
 * may be one company, and sends them to that workflow to decide.
 */
export function duplicateHints(): { aId: string; aName: string; bId: string; bName: string; basis: string }[] {
  const rows = getDb().prepare(`
    SELECT id, name, normalized_name, domain FROM companies WHERE status = 'active'
  `).all() as { id: string; name: string; normalized_name: string; domain: string | null }[];

  const hints: { aId: string; aName: string; bId: string; bName: string; basis: string }[] = [];
  const byName = new Map<string, typeof rows[number][]>();
  const byDomain = new Map<string, typeof rows[number][]>();

  for (const r of rows) {
    const nameKey = normalizeCompanyKey(r.name);
    (byName.get(nameKey) ?? byName.set(nameKey, []).get(nameKey)!).push(r);
    const domain = normalizeDomainKey(r.domain);
    if (domain) (byDomain.get(domain) ?? byDomain.set(domain, []).get(domain)!).push(r);
  }

  const seen = new Set<string>();
  const emit = (group: typeof rows, basis: string) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = [group[i].id, group[j].id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({ aId: group[i].id, aName: group[i].name, bId: group[j].id, bName: group[j].name, basis });
      }
    }
  };
  for (const group of byName.values()) if (group.length > 1) emit(group, 'identical normalized company name');
  for (const group of byDomain.values()) if (group.length > 1) emit(group, 'identical domain');
  return hints;
}
