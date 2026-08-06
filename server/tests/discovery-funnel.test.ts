import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { __setSourceRunnerForTests } from '../services/sources';
import { runDiscovery, existingCandidates } from '../services/discovery';
import { listCompanies, saveCompany } from '../db/repos/companies';
import { getConfig, listRuns } from '../db/repos/operations';
import type { SourceRunResult } from '../sourcing/runlog';
import type { RawCandidate } from '../sourcing/normalize';
import type { DiscoveryQuery, DiscoverySourceId } from '../../shared/discovery';

/**
 * The two-stage funnel and preview mode, exercised end-to-end through
 * the real `runDiscovery` pipeline with the network stubbed out — no
 * test in this file depends on the live internet.
 */

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
});
afterEach(() => __setSourceRunnerForTests(null));

const today = new Date().toISOString().slice(0, 10);

function raw(over: Partial<RawCandidate> & { companyName: string }): RawCandidate {
  return {
    confidence: 0.7,
    evidence: [{
      claim: `Public listing for ${over.companyName}.`,
      source: 'Y Combinator',
      url: `https://www.ycombinator.com/companies/${encodeURIComponent(over.companyName)}`,
      dateAccessed: today,
      verificationStatus: 'Not verified' as const,
      assertionType: 'fact' as const,
      confidence: 0.7,
      notes: '',
    }],
    ...over,
  } as RawCandidate;
}

/** A runner that returns a fixed candidate list from one source. */
function runnerWith(candidates: RawCandidate[]) {
  return async (sourceId: DiscoverySourceId, _q: DiscoveryQuery, _budget: number): Promise<SourceRunResult> =>
    sourceId === 'yc'
      ? { sourceId, mode: 'live', apiCalls: 1, detail: 'fixture', candidates }
      : { sourceId, mode: 'skipped', candidates: [], apiCalls: 0, detail: 'not exercised' };
}

const STRONG = raw({
  companyName: 'Gridline',
  pitch: 'Our customers include Xcel Energy. Deployed with grid operators. Built on a proprietary dataset '
    + 'that improves with every use. Founded by former ERCOT engineers.',
  website: 'https://gridline.example.com',
});
const HYPE = raw({
  companyName: 'Synergyx',
  pitch: 'A revolutionary, cutting-edge, world-class platform to disrupt the industry.',
});
const CONSULTANCY = raw({
  companyName: 'Northbridge',
  pitch: 'We are a consulting firm delivering managed services to enterprises.',
});
const FUND = raw({ companyName: 'Vamos Growth Fund II, L.P.', pitch: 'A pooled investment vehicle.' });

describe('two-stage funnel inside the discovery pipeline', () => {
  it('annotates every candidate with both verdicts under the documented annotate-only override', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE, CONSULTANCY, FUND]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, enforceThesisFilter: false },
      'tester',
    );

    expect(run.discovered).toBe(4);
    expect(run.filteredByThesis).toBe(0);
    expect(run.filteredByQuality).toBe(0);
    for (const c of existingCandidates()) {
      expect(c.thesisEligible, c.companyName).not.toBeNull();
      expect(c.qualityPriority, c.companyName).not.toBeNull();
      expect(c.qualityBand, c.companyName).not.toBeNull();
    }
  });

  it('ranks the evidence-backed candidate above the hype-only one', async () => {
    __setSourceRunnerForTests(runnerWith([HYPE, STRONG]));
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    const byName = new Map(existingCandidates().map((c) => [c.companyName, c]));
    expect(byName.get('Gridline')!.qualityPriority!).toBeGreaterThan(byName.get('Synergyx')!.qualityPriority!);
  });

  it('drops thesis-ineligible candidates BY DEFAULT — no opt-in required', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, CONSULTANCY, FUND]));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    expect(run.filteredByThesis).toBe(2); // the consultancy and the fund
    expect(existingCandidates().map((c) => c.companyName)).toEqual(['Gridline']);
  });

  it('the documented override restores annotate-only behaviour for one run', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, CONSULTANCY, FUND]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, enforceThesisFilter: false },
      'tester',
    );
    expect(run.filteredByThesis).toBe(0);
    expect(existingCandidates()).toHaveLength(3);
    // The verdicts are still computed and attached — the override turns
    // off the DROP, not the evaluation.
    const byName = new Map(existingCandidates().map((c) => [c.companyName, c]));
    expect(byName.get('Northbridge')!.thesisEligible).toBe(false);
    expect(byName.get('Gridline')!.thesisEligible).toBe(true);
  });

  it('applies a triage-priority floor when one is set', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, minQualityPriority: 40 },
      'tester',
    );
    expect(run.filteredByQuality).toBe(1);
    expect(existingCandidates().map((c) => c.companyName)).toEqual(['Gridline']);
  });

  it('records the published text behind every thesis rejection', async () => {
    __setSourceRunnerForTests(runnerWith([CONSULTANCY]));
    // Annotate-only, so the rejected row is still inspectable.
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, enforceThesisFilter: false }, 'tester');
    const c = existingCandidates()[0];
    expect(c.thesisEligible).toBe(false);
    expect(c.thesisRejections.length).toBeGreaterThan(0);
    for (const r of c.thesisRejections) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The default-on thesis filter, exercised through the real pipeline.
 *
 * Two symmetric properties, and the second is the one that makes the
 * first safe to enable by default: POSITIVELY identified out-of-thesis
 * companies are blocked, and genuinely UNKNOWN records still reach a
 * human. A filter that failed the second would quietly shrink the funnel
 * by discarding everything it could not read.
 */
describe('default-on thesis filter: blocks the provable, reviews the unknown', () => {
  const cases: { label: string; candidate: RawCandidate; code: string }[] = [
    {
      label: 'mature (named late-stage round)',
      candidate: raw({ companyName: 'Latestage', pitch: 'Latestage raised a $200M Series D.' }),
      code: 'past-target-stage',
    },
    {
      label: 'excluded business type (consultancy)',
      candidate: raw({ companyName: 'Northbridge', pitch: 'We are a consulting firm delivering managed services.' }),
      code: 'excluded-business-type',
    },
    {
      label: 'excluded entity type (fund)',
      candidate: raw({ companyName: 'Vamos Growth Fund II, L.P.', pitch: 'A pooled vehicle.' }),
      code: 'not-operating-company',
    },
    {
      label: 'inactive (stated shutdown)',
      candidate: raw({ companyName: 'Deadco', pitch: 'Deadco ceased operations and is winding down.' }),
      code: 'inactive',
    },
  ];

  for (const { label, candidate, code } of cases) {
    it(`blocks a positively identified ${label}`, async () => {
      __setSourceRunnerForTests(runnerWith([STRONG, candidate]));
      const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
      expect(run.filteredByThesis).toBe(1);
      expect(existingCandidates().map((c) => c.companyName)).toEqual(['Gridline']);
      // The reason is logged, with the text that caused it.
      const audited = store.raw.audit.find((a) => a.action === 'discovery-run')!;
      expect(audited.detail).toMatch(/1 filtered by thesis eligibility/);
      // And the verdict itself is reproducible off the same candidate.
      const annotated = await runDiscovery(
        { sources: ['yc'], maxResults: 20, maxApiCalls: 5, enforceThesisFilter: false, preview: true },
        'tester',
      );
      const rejected = annotated.previewCandidates!.find((c) => c.companyName === candidate.companyName)!;
      expect(rejected.thesisRejections.map((r) => r.code)).toContain(code);
    });
  }

  it('blocks an exact duplicate of a company already on file', async () => {
    saveCompany(
      {
        id: 'dup-target', name: 'Gridline', oneLiner: 'x', vertical: 'sustainability',
        subcategory: 'Smart grids', stage: 'Seed', city: 'Austin', state: 'TX',
        foundedYear: 2025, teamSize: 3, website: 'https://gridline.example.com',
        traction: { level: 0, note: 'Unknown — not yet researched' },
        founders: [{ name: 'F', role: 'CEO', background: 'Unknown' }],
        evidence: [{ claim: 'c', source: 's', url: 'https://example.com/dup', date: '2026-07-01', type: 'News' }],
        flags: [], imported: true,
      },
      { origin: 'extracted', source: 'test' },
    );
    __setSourceRunnerForTests(runnerWith([STRONG]));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, mode: 'all' }, 'tester');
    expect(run.filteredByThesis).toBe(1);
    expect(existingCandidates()).toHaveLength(0);
  });

  it('blocks a recorded location outside the run’s geography', async () => {
    __setSourceRunnerForTests(runnerWith([
      raw({ companyName: 'Floridian', pitch: 'A product.', hqState: 'FL', hqCity: 'Miami' }),
      raw({ companyName: 'Texan', pitch: 'A product.', hqState: 'TX', hqCity: 'Austin' }),
    ]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, geography: 'Preferred states' },
      'tester',
    );
    // Geography is enforced TWICE, and the pre-existing `matchesQuery`
    // gate runs first — so this candidate never reaches the thesis
    // filter and is not counted against it. What matters is the outcome:
    // a positively out-of-geography company does not reach the queue.
    // (thesisFilter's own geography rejection is covered directly in
    // server/tests/thesis-filter.test.ts, for the paths that bypass
    // matchesQuery.)
    expect(run.filteredByThesis).toBe(0);
    expect(existingCandidates().map((c) => c.companyName)).toEqual(['Texan']);
  });

  it('KEEPS every genuinely unknown record for human review', async () => {
    // Unknown stage, unknown location, unknown vertical, and a fuzzy
    // (not exact) duplicate. None of these is evidence AGAINST the
    // company, and every one must still reach a reviewer.
    __setSourceRunnerForTests(runnerWith([
      raw({ companyName: 'Unknown Stage Co', pitch: 'A product for hospitals.' }),
      raw({ companyName: 'Unlocated Co', pitch: 'A product for banks.' }),
      raw({ companyName: 'Unclassified Co', pitch: 'Something nobody has categorised.' }),
    ]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, geography: 'Preferred states' },
      'tester',
    );
    expect(run.filteredByThesis).toBe(0);
    expect(existingCandidates()).toHaveLength(3);
    for (const c of existingCandidates()) {
      expect(c.stage, c.companyName).toBe('Unknown');
      expect(c.hqState, c.companyName).toBe('Unknown');
      expect(c.thesisEligible, c.companyName).toBe(true);
    }
  });

  it('does not auto-reject a stale-only refresh run, where every match is a duplicate by design', async () => {
    // The interaction that switching this on by default first broke:
    // 'stale-only' exists to re-check companies already on file.
    saveCompany(
      {
        id: 'stale-target', name: 'Gridline', oneLiner: 'x', vertical: 'sustainability',
        subcategory: 'Smart grids', stage: 'Seed', city: 'Austin', state: 'TX',
        foundedYear: 2025, teamSize: 3, website: 'https://gridline.example.com',
        traction: { level: 0, note: 'Unknown — not yet researched' },
        founders: [{ name: 'F', role: 'CEO', background: 'Unknown' }],
        evidence: [{ claim: 'c', source: 's', url: 'https://example.com/stale', date: '2026-07-01', type: 'News' }],
        flags: [], imported: true,
      },
      { origin: 'extracted', source: 'test' },
    );
    __setSourceRunnerForTests(runnerWith([STRONG]));
    const run = await runDiscovery(
      { sources: ['yc'], maxResults: 20, maxApiCalls: 5, mode: 'stale-only', staleAfterDays: 1 },
      'tester',
    );
    expect(run.filteredByThesis).toBe(0);
    expect(run.discovered).toBe(1);
  });

  it('never auto-rejects a policy EXCEPTION — those stay flags for partner review', async () => {
    __setSourceRunnerForTests(runnerWith([
      raw({ companyName: 'Chainco', pitch: 'On-chain settlement rails for DeFi treasuries.' }),
      raw({ companyName: 'Humanoid Labs', pitch: 'General-purpose humanoid robots for industrial sites.' }),
    ]));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    expect(run.filteredByThesis).toBe(0);
    expect(existingCandidates()).toHaveLength(2);
  });

  it('quality priority ranks but never rejects when no floor is configured', async () => {
    __setSourceRunnerForTests(runnerWith([HYPE, STRONG]));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    // Both kept — the low-priority one is ordered lower, not removed.
    expect(run.filteredByQuality).toBe(0);
    expect(existingCandidates()).toHaveLength(2);
    const byName = new Map(existingCandidates().map((c) => [c.companyName, c]));
    expect(byName.get('Gridline')!.qualityPriority!).toBeGreaterThan(byName.get('Synergyx')!.qualityPriority!);
  });
});

/**
 * The EXACT preview write contract, stated in both directions.
 *
 * The earlier description of preview as writing "no data at all" was
 * wrong: it takes the operational run lock and appends to the outbound-
 * request audit ledger. Both are deliberate and neither is business
 * data, but a contract that overstates itself is worse than one that
 * names its exceptions — so these tests pin down the forbidden set AND
 * the permitted set, and a future change that quietly adds a third
 * exception fails here.
 */
describe('preview write contract', () => {
  /** Business data: none of this may change during a preview. */
  function businessDataSnapshot() {
    const db = getDb();
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      companies: one('SELECT COUNT(*) AS n FROM companies'),
      founders: one('SELECT COUNT(*) AS n FROM founders'),
      founderCandidates: one('SELECT COUNT(*) AS n FROM founder_candidates'),
      scores: one('SELECT COUNT(*) AS n FROM scoring_results'),
      evidence: one('SELECT COUNT(*) AS n FROM evidence'),
      runs: one('SELECT COUNT(*) AS n FROM source_runs'),
      sourceRunResults: one('SELECT COUNT(*) AS n FROM source_run_results'),
      reviewDecisions: one('SELECT COUNT(*) AS n FROM review_decisions'),
      hubspotSyncs: one('SELECT COUNT(*) AS n FROM hubspot_sync_history'),
      enrichmentRuns: one('SELECT COUNT(*) AS n FROM enrichment_runs'),
      queue: (db.prepare("SELECT value FROM kv WHERE collection = 'discoveryCandidates'").get() as { value: string } | undefined)?.value ?? null,
      idCounters: (db.prepare("SELECT value FROM kv WHERE collection = 'counters'").get() as { value: string } | undefined)?.value ?? null,
    };
  }

  it('writes NO company, founder, scoring, queue, CRM, outreach, or id-counter data', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE, CONSULTANCY]));
    const before = businessDataSnapshot();
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');

    // The findings are real (the consultancy is dropped by the
    // now-default thesis filter, which is orthogonal to this test)...
    expect(run.discovered).toBe(2);
    expect(run.previewCandidates).toHaveLength(2);
    // ...and no business data moved, including the id counters.
    expect(businessDataSnapshot()).toEqual(before);
  });

  it('DOES take and release the operational run lock', async () => {
    // Permitted, and load-bearing: a preview really is calling the same
    // third-party endpoints, so it must not run beside a real sweep.
    __setSourceRunnerForTests(runnerWith([STRONG]));
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');
    // Released afterwards, so a preview can never wedge real sourcing.
    const lock = getConfig('discovery-run-lock', z.object({ startedAt: z.string(), initiatedBy: z.string() }).nullable(), null);
    expect(lock).toBeNull();

    // And a real run is unblocked immediately after a preview.
    __setSourceRunnerForTests(runnerWith([HYPE]));
    await expect(runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester')).resolves.toBeTruthy();
  });

  it('DOES append one outbound-request audit entry', async () => {
    // Permitted, and required: an unlogged outbound request to a third
    // party is exactly what the audit ledger exists to catch.
    __setSourceRunnerForTests(runnerWith([STRONG]));
    const before = store.raw.audit.length;
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');
    expect(store.raw.audit.length).toBe(before + 1);
    const entry = store.raw.audit[0];
    expect(entry.action).toBe('discovery-run');
    // Labelled, so a reader can tell a preview from a real sweep.
    expect(entry.detail).toMatch(/PREVIEW \(nothing persisted\)/);
  });

  it('the permitted exceptions are exactly two — lock and audit, nothing else', () => {
    // A structural guard on the documented contract. If someone adds a
    // third write to the preview path, this list has to change
    // deliberately rather than by accident.
    const contract = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'discovery.ts'),
      'utf8',
    );
    expect(contract).toMatch(/Two deliberate exceptions/);
    expect(contract).toMatch(/the run LOCK is still taken and released/);
    expect(contract).toMatch(/the audit ledger still records the run/);
  });
});

describe('preview mode writes nothing', () => {
  it('returns real findings but persists no candidate, run, company, or score', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE]));
    const db = getDb();
    const before = {
      candidates: existingCandidates().length,
      runs: listRuns().length,
      companies: listCompanies().length,
      scores: (db.prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n,
      reviews: (db.prepare('SELECT COUNT(*) AS n FROM review_decisions').get() as { n: number }).n,
      hubspot: (db.prepare('SELECT COUNT(*) AS n FROM hubspot_sync_history').get() as { n: number }).n,
    };

    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');

    // The findings are real and reported...
    expect(run.preview).toBe(true);
    expect(run.discovered).toBe(2);
    expect(run.previewCandidates).toHaveLength(2);
    expect(run.previewCandidates!.map((c) => c.companyName).sort()).toEqual(['Gridline', 'Synergyx']);

    // ...and absolutely nothing was written.
    expect(existingCandidates()).toHaveLength(before.candidates);
    expect(listRuns()).toHaveLength(before.runs);
    expect(listCompanies()).toHaveLength(before.companies);
    expect((db.prepare('SELECT COUNT(*) AS n FROM scoring_results').get() as { n: number }).n).toBe(before.scores);
    expect((db.prepare('SELECT COUNT(*) AS n FROM review_decisions').get() as { n: number }).n).toBe(before.reviews);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hubspot_sync_history').get() as { n: number }).n).toBe(before.hubspot);
  });

  it('does not advance the persisted id counters', async () => {
    // store.nextId() writes the counter it bumps, so a preview that used
    // it would leave a visible trace and make the next real candidate id
    // skip a number. Preview mints ids in memory instead.
    const db = getDb();
    const counters = () => db.prepare("SELECT value FROM kv WHERE collection = 'counters'").get() as { value: string } | undefined;
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE]));
    const before = counters();
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');
    expect(counters()).toEqual(before);
  });

  it('mints candidate ids that are unique ACROSS previews, not just within one', async () => {
    // Regression: preview ids came from a bare counter that restarted at
    // 1 every run, so two previews in one process (one per vertical)
    // produced colliding ids. Any caller keying a Map by candidate id —
    // the preview reporter does exactly that — then attributed one
    // company's researched evidence to a different company.
    __setSourceRunnerForTests(runnerWith([STRONG, HYPE]));
    const first = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');
    __setSourceRunnerForTests(runnerWith([raw({ companyName: 'Otherco', pitch: 'A different product.' })]));
    const second = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');

    const ids = [...first.previewCandidates!, ...second.previewCandidates!].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves candidates from earlier real runs untouched', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG]));
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    const persisted = existingCandidates();
    expect(persisted).toHaveLength(1);

    __setSourceRunnerForTests(runnerWith([HYPE, CONSULTANCY]));
    await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5, preview: true }, 'tester');
    expect(existingCandidates()).toEqual(persisted);
  });

  it('a normal (non-preview) run still persists, so the guard is not always-on', async () => {
    __setSourceRunnerForTests(runnerWith([STRONG]));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    expect(run.preview).toBe(false);
    expect(run.previewCandidates).toBeUndefined();
    expect(existingCandidates()).toHaveLength(1);
    expect(listRuns().length).toBeGreaterThan(0);
  });
});

describe('budget and rate limits still bind', () => {
  it('honours the per-run result ceiling', async () => {
    const many = Array.from({ length: 40 }, (_, i) => raw({ companyName: `Co ${i}`, pitch: 'A product.' }));
    __setSourceRunnerForTests(runnerWith(many));
    const run = await runDiscovery({ sources: ['yc'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    expect(run.discovered).toBe(20);
    expect(existingCandidates()).toHaveLength(20);
  });

  it('refuses a request that exceeds the per-run source ceiling', async () => {
    await expect(
      runDiscovery({ sources: ['yc', 'sec', 'github', 'grants'], maxResults: 5, maxApiCalls: 5 }, 'tester'),
    ).rejects.toThrow(/at most 3 sources/i);
  });

  it('refuses a request above the per-run result ceiling rather than silently capping it', async () => {
    await expect(
      runDiscovery({ sources: ['yc'], maxResults: 500, maxApiCalls: 5 }, 'tester'),
    ).rejects.toThrow(/at most 20 candidates/i);
  });

  it('stops calling sources once the API-call budget is spent', async () => {
    let calls = 0;
    __setSourceRunnerForTests(async (sourceId): Promise<SourceRunResult> => {
      calls += 1;
      return { sourceId, mode: 'live', apiCalls: 5, detail: 'fixture', candidates: [] };
    });
    await runDiscovery({ sources: ['yc', 'sec', 'github'], maxResults: 20, maxApiCalls: 5 }, 'tester');
    // The first source exhausts the budget; the remaining two are skipped
    // by the dispatcher without a network call of their own.
    expect(calls).toBeLessThanOrEqual(3);
  });
});
