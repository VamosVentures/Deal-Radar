import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb } from '../db/client';
import { saveCompany, applyFieldUpdate, markRefreshed } from '../db/repos/companies';
import { saveRun, saveScore, recordReviewDecision } from '../db/repos/operations';
import { upsertFounderCandidate } from '../db/repos/enrichment';
import { computeCompanyKpis, computeExecutiveKpis, computeFounderKpis } from '../services/executiveKpis';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import { discoveryQuerySchema, type DiscoveryRun } from '../../shared/discovery';
import type { ImportedCompany } from '../services/imports';

beforeEach(() => store.resetForTests());

const DAY = 86_400_000;
const NOW = new Date('2026-08-05T12:00:00.000Z').getTime();
const baseQuery = discoveryQuerySchema.parse({ sources: ['github'] });

function fixtureCompany(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: over.id ?? 'co-1', name: 'Fixture Co', oneLiner: 'Fixture pitch', vertical: 'health',
    subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
    traction: { level: 5, note: 'Fixture' },
    founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture' }],
    evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/x', date: '2026-07-01', type: 'News' }],
    flags: [], imported: true,
    ...over,
  };
}

function fixtureRun(id: string, completedAt: string, over: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    id, at: completedAt, completedAt, runType: 'manual', mode: 'live',
    query: baseQuery, sourceResults: [], discovered: 0, updatedExisting: 0, duplicatesSkipped: 0,
    duplicatesIdentified: 0, filteredByPolicy: 0, filteredByThesis: 0, filteredByQuality: 0, preview: false, rejectedByValidation: 0, imported: 0, errors: [],
    apiCalls: 0, modelCalls: 0, estimatedTokens: 0, estimatedCostUsd: 0, durationMs: 0,
    status: 'Completed', initiatedBy: 'test',
    ...over,
  };
}

function insertEnrichmentRun(id: string, at: string, completedAt: string | null, mode: 'apply' | 'dry-run' = 'apply') {
  getDb().prepare(`
    INSERT INTO enrichment_runs (
      id, at, completed_at, mode, scope, companies_attempted, founders_verified, founders_candidate,
      founders_conflicting, founders_exhausted, founders_manual_review, verticals_classified,
      verticals_unclassifiable, stages_named, stages_bounded, stages_conflicting, source_errors, status, initiated_by
    ) VALUES (?, ?, ?, ?, 'all', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '[]', 'Completed', 'test')
  `).run(id, at, completedAt, mode);
}

function insertFounder(companyId: string, personKey: string, runId: string | undefined, opts: {
  firstSeenAt?: string; reviewedAt?: string | null; reviewDecision?: string | null;
} = {}): void {
  const rowId = upsertFounderCandidate({
    companyId, personKey, fullName: personKey, title: null, sourceUrl: `https://example.com/${personKey}`,
    sourceFamily: 'company-site', sourceType: 'about-page', publishedAt: null,
    supportingText: 'Fixture', matchSignals: [], matchScore: 0.9, confidence: 0.9,
    status: 'verified-founder', runId,
  });
  if (opts.firstSeenAt || opts.reviewedAt !== undefined || opts.reviewDecision !== undefined) {
    getDb().prepare(`
      UPDATE founder_candidates SET
        first_seen_at = COALESCE(?, first_seen_at),
        reviewed_at = ?,
        review_decision = ?
      WHERE id = ?
    `).run(opts.firstSeenAt ?? null, opts.reviewedAt ?? null, opts.reviewDecision ?? null, rowId);
  }
}

describe('Executive Overview KPIs — Companies', () => {
  it('Cumulative: counts only sourced companies, broken down by vertical, reconciling to the total', () => {
    saveCompany(fixtureCompany({ id: 'co-health-1', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveCompany(fixtureCompany({ id: 'co-health-2', vertical: 'health' }), { origin: 'extracted', source: 'discovery:sec', discoverySource: 'sec' });
    saveCompany(fixtureCompany({ id: 'co-fintech-1', vertical: 'fintech' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    // Manually imported (CSV) — no discoverySource — must be excluded from Cumulative.
    saveCompany(fixtureCompany({ id: 'co-manual-1', vertical: 'health' }), { origin: 'user-entered', source: 'local-csv' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.cumulative.total).toBe(3);
    expect(kpis.cumulative.byVertical.health).toBe(2);
    expect(kpis.cumulative.byVertical.fintech).toBe(1);
    expect(kpis.cumulative.byVertical.frontier).toBe(0); // zero-count verticals still present
    expect(kpis.cumulative.unassigned).toBe(0);
    const sum = Object.values(kpis.cumulative.byVertical).reduce((a, b) => a + b, 0) + kpis.cumulative.unassigned;
    expect(sum).toBe(kpis.cumulative.total);
  });

  it('Last Run: only companies attributed to the most recent COMPLETED run count, not older runs', () => {
    saveRun(fixtureRun('run-old', '2026-08-01T00:00:00.000Z'));
    saveRun(fixtureRun('run-new', '2026-08-04T00:00:00.000Z'));
    saveCompany(fixtureCompany({ id: 'co-old-run', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', discoveryRunId: 'run-old' });
    saveCompany(fixtureCompany({ id: 'co-new-run-1', vertical: 'fintech' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', discoveryRunId: 'run-new' });
    saveCompany(fixtureCompany({ id: 'co-new-run-2', vertical: 'fintech' }), { origin: 'extracted', source: 'discovery:sec', discoverySource: 'sec', discoveryRunId: 'run-new' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.lastRun.runId).toBe('run-new');
    expect(kpis.lastRun.total).toBe(2);
    expect(kpis.lastRun.byVertical.fintech).toBe(2);
    expect(kpis.lastRun.byVertical.health).toBe(0);
  });

  it('Last Run: a Cancelled or Failed run is never "the most recent completed run"', () => {
    saveRun(fixtureRun('run-completed', '2026-08-01T00:00:00.000Z'));
    saveRun(fixtureRun('run-failed', '2026-08-04T00:00:00.000Z', { status: 'Failed' }));
    saveCompany(fixtureCompany({ id: 'co-a' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', discoveryRunId: 'run-completed' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.lastRun.runId).toBe('run-completed');
    expect(kpis.lastRun.total).toBe(1);
  });

  it('Stale boundary: >=7 days old is stale, <7 days is not, for a never-reviewed record', () => {
    saveCompany(fixtureCompany({ id: 'co-stale' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, last_refreshed = NULL, created_at = ? WHERE id = 'co-stale'")
      .run(new Date(NOW - 7 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);

    saveCompany(fixtureCompany({ id: 'co-fresh' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, last_refreshed = NULL, created_at = ? WHERE id = 'co-fresh'")
      .run(new Date(NOW - 7 * DAY + 3600_000).toISOString());
    const kpis = computeCompanyKpis(NOW);
    expect(kpis.stale.total).toBe(1); // co-stale only; co-fresh is one hour under 7 days
  });

  it('Stale: a terminal status (Synced to HubSpot) is never stale regardless of age', () => {
    saveCompany(fixtureCompany({ id: 'co-terminal' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Synced to HubSpot' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-terminal'")
      .run(new Date(NOW - 100 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(0);
  });

  it('Hot: score >= 8.0 and non-provisional counts; provisional or below-threshold does not', () => {
    saveCompany(fixtureCompany({ id: 'co-hot', vertical: 'frontier' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-hot', { score: 8.0, totalPoints: 80, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.8, explanation: 'x', provisional: false });

    saveCompany(fixtureCompany({ id: 'co-not-hot' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-not-hot', { score: 7.9, totalPoints: 79, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.8, explanation: 'x', provisional: false });

    saveCompany(fixtureCompany({ id: 'co-provisional-high' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-provisional-high', { score: 9.0, totalPoints: 20, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.3, explanation: 'x', provisional: true });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.hot.total).toBe(1);
    expect(kpis.hot.byVertical.frontier).toBe(1);
  });

  it('vertical breakdown always reconciles, including an out-of-taxonomy value routed to Unassigned', () => {
    saveCompany(fixtureCompany({ id: 'co-weird-vertical', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET vertical = 'not-a-real-vertical' WHERE id = 'co-weird-vertical'").run();

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.cumulative.unassigned).toBe(1);
    const sum = Object.values(kpis.cumulative.byVertical).reduce((a, b) => a + b, 0) + kpis.cumulative.unassigned;
    expect(sum).toBe(kpis.cumulative.total);
  });
});

describe('Executive Overview KPIs — Stealth Founders', () => {
  it('Cumulative: INCLUDES rejected candidates (all retained sourced founders) — rejection is a verdict, not proof it was never sourced; vertical inherited from the associated company', () => {
    saveCompany(fixtureCompany({ id: 'co-f1', vertical: 'sustainability' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertFounder('co-f1', 'person-a', undefined);
    insertFounder('co-f1', 'person-b', undefined, { reviewDecision: 'rejected' });

    const kpis = computeFounderKpis(NOW);
    expect(kpis.cumulative.total).toBe(2); // both counted — rejection happens AFTER sourcing
    expect(kpis.cumulative.byVertical.sustainability).toBe(2);
  });

  it('Hot: a rejected candidate is excluded even if its company scores >= 8 — it is not a live prospect', () => {
    saveCompany(fixtureCompany({ id: 'co-f1b', vertical: 'fow' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-f1b', { score: 9.0, totalPoints: 90, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.9, explanation: 'x', provisional: false });
    insertFounder('co-f1b', 'person-hot', undefined);
    insertFounder('co-f1b', 'person-rejected', undefined, { reviewDecision: 'rejected' });

    const kpis = computeFounderKpis(NOW);
    expect(kpis.hot.total).toBe(1); // person-rejected excluded despite the company's hot score
  });

  it('Last Run: attributed to the most recent completed (apply-mode) enrichment run', () => {
    saveCompany(fixtureCompany({ id: 'co-f2', vertical: 'fow' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertEnrichmentRun('enr-old', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z');
    insertEnrichmentRun('enr-new', '2026-08-04T00:00:00.000Z', '2026-08-04T01:00:00.000Z');
    insertFounder('co-f2', 'person-old', 'enr-old');
    insertFounder('co-f2', 'person-new', 'enr-new');

    const kpis = computeFounderKpis(NOW);
    expect(kpis.lastRun.runId).toBe('enr-new');
    expect(kpis.lastRun.total).toBe(1);
  });

  it('Stale: 7-day fixed rule uses reviewed_at when present, else first_seen_at', () => {
    saveCompany(fixtureCompany({ id: 'co-f3' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertFounder('co-f3', 'person-never-reviewed', undefined, { firstSeenAt: new Date(NOW - 8 * DAY).toISOString() });
    insertFounder('co-f3', 'person-recently-reviewed', undefined, {
      firstSeenAt: new Date(NOW - 30 * DAY).toISOString(),
      reviewedAt: new Date(NOW - 1 * DAY).toISOString(),
    });

    const kpis = computeFounderKpis(NOW);
    expect(kpis.stale.total).toBe(1); // only the never-reviewed, 8-day-old one
  });

  it('Hot: inherited from the associated company score, not an independent founder score', () => {
    saveCompany(fixtureCompany({ id: 'co-f4', vertical: 'frontier' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-f4', { score: 8.5, totalPoints: 85, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.9, explanation: 'x', provisional: false });
    insertFounder('co-f4', 'person-hot', undefined);

    saveCompany(fixtureCompany({ id: 'co-f5' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    saveScore('co-f5', { score: 5.0, totalPoints: 50, components: [], exceptions: [], version: 'test', evidenceConfidence: 0.5, explanation: 'x', provisional: false });
    insertFounder('co-f5', 'person-not-hot', undefined);

    const kpis = computeFounderKpis(NOW);
    expect(kpis.hot.total).toBe(1);
    expect(kpis.hot.byVertical.frontier).toBe(1);
  });
});

describe('Executive Overview KPIs — combined payload', () => {
  it('computeExecutiveKpis returns both halves, not partial, under normal conditions', () => {
    saveCompany(fixtureCompany({ id: 'co-combined' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    const kpis = computeExecutiveKpis(NOW);
    expect(kpis.partial).toBe(false);
    expect(kpis.errors).toEqual([]);
    expect(kpis.companies).not.toBeNull();
    expect(kpis.founders).not.toBeNull();
    expect(kpis.lastUpdated).toBe(new Date(NOW).toISOString());
  });

  it('HOT_THRESHOLD constant matches the documented Hot boundary of 8', () => {
    expect(HOT_THRESHOLD).toBe(8);
  });
});

describe('Human review vs. automated refresh (regression coverage for the Stale correction)', () => {
  it('an explicit human review action (recordReviewDecision) makes a company NOT stale', () => {
    saveCompany(fixtureCompany({ id: 'co-reviewed' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-reviewed'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    // Old enough to be stale by discovery date alone...
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);
    // ...until an interactive analyst-route action reviews it (a status
    // change, "Mark reviewed", a note, or a founder-candidate decision
    // recorded against this company — all route through this same
    // function; "Refresh live research" is the one exception, covered
    // below, since it does not by itself represent analyst judgment).
    recordReviewDecision({ subjectType: 'company', subjectId: 'co-reviewed', decision: 'Awaiting Review', actor: 'analyst@vamos.test' });
    expect(computeCompanyKpis(NOW).stale.total).toBe(0);
  });

  it('"Mark reviewed" (decision=\'refreshed\') counts as review', () => {
    saveCompany(fixtureCompany({ id: 'co-mark-reviewed' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-mark-reviewed'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);
    recordReviewDecision({ subjectType: 'company', subjectId: 'co-mark-reviewed', decision: 'refreshed', actor: 'team' });
    expect(computeCompanyKpis(NOW).stale.total).toBe(0);
  });

  it('a manual note action (decision=\'note-added\') counts as review', () => {
    saveCompany(fixtureCompany({ id: 'co-noted' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-noted'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);
    recordReviewDecision({ subjectType: 'company', subjectId: 'co-noted', decision: 'note-added', actor: 'analyst@vamos.test', reason: 'Internal note 1' });
    expect(computeCompanyKpis(NOW).stale.total).toBe(0);
  });

  it('a founder-candidate decision recorded against its company counts as review (it explicitly records a company-level decision)', () => {
    saveCompany(fixtureCompany({ id: 'co-founder-reviewed' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-founder-reviewed'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);
    // Mirrors server/routes/enrichment.ts's founder-review route exactly:
    // reviewing a founder ALSO explicitly logs a company-level decision.
    recordReviewDecision({ subjectType: 'company', subjectId: 'co-founder-reviewed', decision: 'founder-confirmed', actor: 'analyst@vamos.test', reason: 'Founder candidate 42' });
    expect(computeCompanyKpis(NOW).stale.total).toBe(0);
  });

  it('"Refresh live research" by ITSELF does NOT count as review — no analyst judgment was exercised', () => {
    saveCompany(fixtureCompany({ id: 'co-refresh-research-only' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-refresh-research-only'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);
    // Mirrors server/services/companyRefresh.ts's exact call shape,
    // including countsAsCompanyReview: false.
    recordReviewDecision({
      subjectType: 'company', subjectId: 'co-refresh-research-only', decision: 'refresh-research', actor: 'team',
      reason: '2 new evidence item(s), 1 field(s) updated, 0 conflict(s), score 5.0 → 6.0', countsAsCompanyReview: false,
    });
    expect(computeCompanyKpis(NOW).stale.total).toBe(1); // still stale — refresh-research alone is not judgment
  });

  it('the AUTOMATED bulk refresh (markRefreshed — server/services/refresh.ts) does NOT count as review and does NOT clear Stale', () => {
    saveCompany(fixtureCompany({ id: 'co-auto-refreshed' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-auto-refreshed'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);

    // This is exactly what the automated connector-refresh sweep does to
    // many companies at once — no human looked at any specific one.
    markRefreshed(['co-auto-refreshed'], new Date(NOW).toISOString().slice(0, 10));
    expect(computeCompanyKpis(NOW).stale.total).toBe(1); // still stale — last_refreshed must never substitute for review
  });

  it('automated enrichment field updates (applyFieldUpdate) cannot reset Stale — no code path from enrichment writes last_reviewed_at', () => {
    saveCompany(fixtureCompany({ id: 'co-enriched' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET discovered_at = NULL, created_at = ? WHERE id = 'co-enriched'")
      .run(new Date(NOW - 30 * DAY).toISOString());
    expect(computeCompanyKpis(NOW).stale.total).toBe(1);

    // Simulates exactly what server/services/enrichment.ts does on every
    // researched company: write researched facts onto the row via
    // applyFieldUpdate. This must never touch last_reviewed_at.
    applyFieldUpdate('co-enriched', 'stage', 'Seed', 'extracted', 'enrichment:test');
    expect(computeCompanyKpis(NOW).stale.total).toBe(1); // still stale — enrichment is not review
  });
});

describe('Cumulative (all retained records) across non-active workflow states', () => {
  it('Cumulative includes Passed, Monitor, and Approved-for-HubSpot companies, not only New/Awaiting Review', () => {
    saveCompany(fixtureCompany({ id: 'co-passed', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Passed' });
    saveCompany(fixtureCompany({ id: 'co-monitor', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Monitor' });
    saveCompany(fixtureCompany({ id: 'co-synced', vertical: 'health' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Synced to HubSpot' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.cumulative.total).toBe(3);
    expect(kpis.cumulative.byVertical.health).toBe(3);
  });

  it('Cumulative excludes a confirmed duplicate (status=merged) but a Passed record of the same age still counts', () => {
    saveCompany(fixtureCompany({ id: 'co-merged-away' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare("UPDATE companies SET status = 'merged', merged_into = 'co-passed-2' WHERE id = 'co-merged-away'").run();
    saveCompany(fixtureCompany({ id: 'co-passed-2' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Passed' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.cumulative.total).toBe(1); // only co-passed-2; the merged row is excluded
  });

  it('cross-source: a company enriched with evidence from multiple sources is still ONE row, counted once', () => {
    // One company row regardless of how many sources' evidence was
    // merged into it (server/sourcing/enrich.ts mergeIntoRun appends
    // evidence to the SAME row rather than creating a second one) —
    // Cumulative counts rows, so this can never double-count.
    saveCompany(fixtureCompany({
      id: 'co-multi-source',
      evidence: [
        { claim: 'From YC', source: 'YC', url: 'https://example.com/yc', date: '2026-07-01', type: 'Database record' },
        { claim: 'From SEC', source: 'SEC', url: 'https://example.com/sec', date: '2026-07-02', type: 'Filing' },
      ],
    }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.cumulative.total).toBe(1);
  });
});

describe('Run labeling and partial-run disclosure', () => {
  it('Companies Last Run is labeled and typed as a real discovery/sourcing run', () => {
    saveRun(fixtureRun('run-x', '2026-08-01T00:00:00.000Z'));
    saveCompany(fixtureCompany({ id: 'co-x' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', discoveryRunId: 'run-x' });
    const kpis = computeCompanyKpis(NOW);
    expect(kpis.lastRun.runType).toBe('discovery');
    expect(kpis.lastRun.runLabel).toBe('Company-sourcing run');
    expect(kpis.lastRun.runStatus).toBe('Completed');
    expect(kpis.lastRun.isPartial).toBe(false);
  });

  it('Founders Last Run is labeled and typed as an enrichment run — never described as a founder-sourcing run', () => {
    saveCompany(fixtureCompany({ id: 'co-y' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertEnrichmentRun('enr-x', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z');
    insertFounder('co-y', 'person-y', 'enr-x');
    const kpis = computeFounderKpis(NOW);
    expect(kpis.lastRun.runType).toBe('enrichment');
    expect(kpis.lastRun.runLabel).toBe('Latest enrichment run');
    expect(kpis.lastRun.runLabel.toLowerCase()).not.toMatch(/sourcing/);
    expect(kpis.lastRun.runStatus).toBe('Completed');
  });

  it('a Failed enrichment run is never selected as the founders "last run"', () => {
    saveCompany(fixtureCompany({ id: 'co-z' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertEnrichmentRun('enr-ok', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z');
    // A failed run, more recent, must be skipped.
    getDb().prepare(`
      INSERT INTO enrichment_runs (id, at, completed_at, mode, scope, companies_attempted, founders_verified,
        founders_candidate, founders_conflicting, founders_exhausted, founders_manual_review, verticals_classified,
        verticals_unclassifiable, stages_named, stages_bounded, stages_conflicting, source_errors, status, initiated_by)
      VALUES ('enr-failed', '2026-08-02T00:00:00.000Z', '2026-08-02T01:00:00.000Z', 'apply', 'all', 0,0,0,0,0,0,0,0,0,0,0, '[]', 'Failed', 'test')
    `).run();
    insertFounder('co-z', 'person-z', 'enr-ok');

    const kpis = computeFounderKpis(NOW);
    expect(kpis.lastRun.runId).toBe('enr-ok');
  });

  it('Companies: a Completed-with-warnings run discloses warning count and affected sources, never presented as fully successful', () => {
    saveRun(fixtureRun('run-partial', '2026-08-01T00:00:00.000Z', {
      status: 'Completed with warnings',
      sourceResults: [
        { sourceId: 'github', mode: 'live', found: 5, detail: 'ok' },
        { sourceId: 'sec', mode: 'failed', found: 0, detail: 'timed out', failureKind: 'timeout' },
        { sourceId: 'grants', mode: 'skipped', found: 0, detail: 'budget exhausted' },
      ],
    }));
    saveCompany(fixtureCompany({ id: 'co-partial' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', discoveryRunId: 'run-partial' });

    const kpis = computeCompanyKpis(NOW);
    expect(kpis.lastRun.runStatus).toBe('Completed with warnings');
    expect(kpis.lastRun.isPartial).toBe(true);
    expect(kpis.lastRun.warningCount).toBe(2);
    expect(kpis.lastRun.affectedSources.sort()).toEqual(['grants', 'sec']);
    expect(kpis.lastRun.total).toBe(1); // the valid count is still reported, not hidden
  });

  it('Founders: a Completed-with-warnings enrichment run discloses its source errors', () => {
    saveCompany(fixtureCompany({ id: 'co-fpartial' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    getDb().prepare(`
      INSERT INTO enrichment_runs (id, at, completed_at, mode, scope, companies_attempted, founders_verified,
        founders_candidate, founders_conflicting, founders_exhausted, founders_manual_review, verticals_classified,
        verticals_unclassifiable, stages_named, stages_bounded, stages_conflicting, source_errors, status, initiated_by)
      VALUES ('enr-partial', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', 'apply', 'all', 0,0,0,0,0,0,0,0,0,0,0, ?, 'Completed with warnings', 'test')
    `).run(JSON.stringify([{ sourceFamily: 'company-site', detail: 'timeout', count: 3 }]));
    insertFounder('co-fpartial', 'person-fp', 'enr-partial');

    const kpis = computeFounderKpis(NOW);
    expect(kpis.lastRun.isPartial).toBe(true);
    expect(kpis.lastRun.warningCount).toBe(3);
    expect(kpis.lastRun.affectedSources).toEqual(['company-site']);
  });

  it('vertical breakdown still reconciles exactly after the Cumulative/Hot semantics changes', () => {
    saveCompany(fixtureCompany({ id: 'co-recon-1', vertical: 'fow' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc', reviewStatus: 'Passed' });
    saveCompany(fixtureCompany({ id: 'co-recon-2' }), { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });
    insertFounder('co-recon-2', 'person-recon-a', undefined);
    insertFounder('co-recon-2', 'person-recon-b', undefined, { reviewDecision: 'rejected' });

    const companyKpis = computeCompanyKpis(NOW);
    const founderKpis = computeFounderKpis(NOW);
    for (const breakdown of [companyKpis.cumulative, companyKpis.stale, companyKpis.hot, founderKpis.cumulative, founderKpis.stale, founderKpis.hot]) {
      const sum = Object.values(breakdown.byVertical).reduce((a, b) => a + b, 0) + breakdown.unassigned;
      expect(sum).toBe(breakdown.total);
    }
  });
});
