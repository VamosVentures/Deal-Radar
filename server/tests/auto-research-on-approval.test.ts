import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { getCompany } from '../db/repos/companies';
import { importCompaniesCsv } from '../services/imports';
import {
  approveEmailIntakeCandidate, submitEmailIntakeBatch, updateEmailIntakeCandidate,
} from '../services/emailIntake';
import { autoResearchIdleForTests, queueAutoResearch, setAutoResearchRunnerForTests } from '../services/autoResearch';
import type { runEnrichment } from '../services/enrichment';

/**
 * Email-intake approvals and CSV imports start the same no-AI research
 * pass as "Research now", in the background, so a newly added company's
 * founder/stage/sector cells don't sit at "Not yet researched". The real
 * runner hits the network, so every test installs a spy.
 */

type Runner = typeof runEnrichment;
const okResult = { } as Awaited<ReturnType<Runner>>;

function approveOne(name: string): string {
  const reply = JSON.stringify({ candidates: [{ name, vertical: 'fow' }] });
  const c = submitEmailIntakeBatch({ reply, submittedBy: 'tester' }).candidates[0];
  const evidence = c.extracted.evidence as Record<string, unknown>[];
  updateEmailIntakeCandidate(c.id, { evidence: [{ ...evidence[0], url: 'Forwarded by A, 2026-10-28' }] });
  const result = approveEmailIntakeCandidate(c.id, 'Andrew');
  if (!result.ok) throw new Error(result.error);
  return result.companyId;
}

const CSV_HEADER = 'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType';
const csvRow = (name: string) =>
  `${name},Fixture pitch for ${name},fow,Autonomous agents,Seed,Austin,TX,2024,3,5,Fixture note,Founder One,CEO,Fixture background,Fixture claim,Fixture,https://example.com/${name},2026-07-01,News`;

describe('auto-research after a reviewer adds companies', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });
  afterEach(() => setAutoResearchRunnerForTests(null));

  it('researches an approved email lead in the background, with the "Research now" request cap', async () => {
    const runner = vi.fn<Runner>().mockResolvedValue(okResult);
    setAutoResearchRunnerForTests(runner);

    const id = approveOne('Topos Test');
    await autoResearchIdleForTests();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toMatchObject({ apply: true, companyIds: [id], maxRequests: 30 });
    expect(runner.mock.calls[0][0].initiatedBy).toContain('auto-research');
  });

  it('researches every row a CSV import created, in one run', async () => {
    const runner = vi.fn<Runner>().mockResolvedValue(okResult);
    setAutoResearchRunnerForTests(runner);

    const report = importCompaniesCsv([CSV_HEADER, csvRow('Alpha Co'), csvRow('Beta Co')].join('\n'));
    expect(report.imported).toBe(2);
    expect(report.researchQueued).toBe(2);
    await autoResearchIdleForTests();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0].companyIds).toEqual(['imported-alpha-co', 'imported-beta-co']);
    expect(runner.mock.calls[0][0].maxRequests).toBe(60);
  });

  it('coalesces approvals that arrive while a run is in flight, never running two at once', async () => {
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = vi.fn<Runner>().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (runner.mock.calls.length === 1) await new Promise<void>((r) => { release = r; });
      inFlight -= 1;
      return okResult;
    });
    setAutoResearchRunnerForTests(runner);

    const first = approveOne('First Co');
    const second = approveOne('Second Co');
    const third = approveOne('Third Co');
    release();
    await autoResearchIdleForTests();

    expect(maxInFlight).toBe(1);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][0].companyIds).toEqual([first]);
    expect(runner.mock.calls[1][0].companyIds).toEqual([second, third]);
  });

  it('a research failure never undoes or blocks the approval', async () => {
    setAutoResearchRunnerForTests(vi.fn<Runner>().mockRejectedValue(new Error('network down')));

    const id = approveOne('Sturdy Co');
    await autoResearchIdleForTests();

    expect(getCompany(id)?.name).toBe('Sturdy Co');
    // The queue recovers: the next approval is researched normally.
    const runner = vi.fn<Runner>().mockResolvedValue(okResult);
    setAutoResearchRunnerForTests(runner);
    const next = approveOne('Next Co');
    await autoResearchIdleForTests();
    expect(runner.mock.calls[0][0].companyIds).toEqual([next]);
  });

  it('caps one run at 600 requests however many companies are queued', async () => {
    const runner = vi.fn<Runner>().mockResolvedValue(okResult);
    setAutoResearchRunnerForTests(runner);
    queueAutoResearch(Array.from({ length: 50 }, (_, i) => `c-${i}`), 'tester');
    await autoResearchIdleForTests();
    expect(runner.mock.calls[0][0].maxRequests).toBe(600);
  });

  it('does nothing in the test environment without an installed runner (no accidental network)', async () => {
    setAutoResearchRunnerForTests(null);
    approveOne('Quiet Co');
    await expect(autoResearchIdleForTests()).resolves.toBeUndefined();
  });
});
