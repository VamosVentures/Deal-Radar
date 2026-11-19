import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';

/**
 * "Import with Claude" for CSV/Excel files (server/services/fileImport.ts).
 *
 * No real model call happens: aiConfigured() is stubbed and the budgeted
 * gateway is replaced, so these prove what Deal Radar SENDS, what it does
 * with replies (including bad ones), and how file candidates flow through
 * the shared review queue and approve path.
 */
vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env')>();
  return { ...actual, aiConfigured: vi.fn(() => false) };
});
vi.mock('../services/aiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiClient')>();
  return { ...actual, callBudgetedModel: vi.fn() };
});

const { aiConfigured } = await import('../env');
const { callBudgetedModel } = await import('../services/aiClient');
const { AiRefusedError } = await import('../services/aiBudget');
const {
  fileImportIdleForTests, fileImportStatus, markInterruptedFileImports, MAX_FILE_ROWS, previewFileImport, ROWS_PER_CHUNK,
  startFileImport,
} = await import('../services/fileImport');
const { approveEmailIntakeCandidate, approveReadyInBatch, listEmailIntakeCandidates } = await import('../services/emailIntake');
const { createBatch } = await import('../db/repos/emailIntake');
const { clearImportedCompanies } = await import('../services/imports');
const { getCompany, listCompanies, saveCompany, setResolvedFounders } = await import('../db/repos/companies');
const { submitEmailIntakeBatch, updateEmailIntakeCandidate } = await import('../services/emailIntake');
const { scoreCompany } = await import('../../src/lib/scoring');
type Company = import('../../src/types').Company;
const mockConfigured = vi.mocked(aiConfigured);
const mockCall = vi.mocked(callBudgetedModel);

function reply(candidates: unknown[]) {
  return { text: JSON.stringify({ candidates }), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, webSearches: 0 }, estimatedCostUsd: 0, model: 'claude-sonnet-5-5', provider: 'anthropic' };
}

/** A messy sheet: a title row, odd headers, an identity column, a blank row. */
const MESSY = [
  ['Deal flow export (do not share)'],
  ['Co.', 'HQ', 'Latino-led?', 'What they do', 'Contact'],
  ['Ledgerly', 'Austin, TX', 'Yes', 'Cash-flow tools for small merchants', 'Maria Lopez (CEO)'],
  [],
  ['CareLoop', 'Fresno CA', 'No', 'Remote monitoring for rural clinics', ''],
];

describe('file import', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
    mockConfigured.mockReturnValue(true);
    mockCall.mockReset();
  });
  afterEach(() => { mockConfigured.mockReturnValue(false); });

  describe('previewFileImport', () => {
    it('reports rows, columns, identity columns and a cost estimate — without calling Claude', () => {
      const p = previewFileImport({ fileName: 'deals.csv', rows: MESSY });
      expect(mockCall).not.toHaveBeenCalled();
      expect(p.rowCount).toBe(2);
      expect(p.columns).toEqual(['Co.', 'HQ', 'Latino-led?', 'What they do', 'Contact']);
      expect(p.identityColumns).toEqual(['Latino-led?']);
      expect(p.skippedLeadingRows).toBe(1);
      expect(p.chunks).toBe(1);
      expect(p.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(p.sample[0]).toContain('- Co.: Ledgerly');
    });

    it('estimates roughly 35–45¢ per 100 rows on Sonnet 5.5 pricing', () => {
      const rows = [['Company', 'Description', 'City']];
      for (let i = 0; i < 100; i++) rows.push([`Startup ${i}`, 'B2B software for clinics and hospitals with a long-ish description', 'Austin']);
      const p = previewFileImport({ fileName: 'big.csv', rows });
      expect(p.chunks).toBe(Math.ceil(100 / ROWS_PER_CHUNK));
      // Exact value depends on the configured model; in tests it is the default.
      expect(p.estimatedCostUsd).toBeGreaterThan(0.1);
      expect(p.estimatedCostUsd).toBeLessThan(2);
    });

    it('refuses a file over the row limit rather than silently cutting it', () => {
      const rows = [['Company'], ...Array.from({ length: MAX_FILE_ROWS + 1 }, (_, i) => [`Co ${i}`])];
      expect(() => previewFileImport({ fileName: 'huge.csv', rows })).toThrow(/limit is 1,000/);
    });

    it('refuses a file with no data rows', () => {
      expect(() => previewFileImport({ fileName: 'empty.csv', rows: [['Company', 'City']] })).toThrow(/No data rows/);
    });
  });

  describe('startFileImport', () => {
    it('refuses with 503 and makes no call when no AI key is configured', () => {
      mockConfigured.mockReturnValue(false);
      expect(() => startFileImport({ fileName: 'deals.csv', rows: MESSY, submittedBy: 'tester' })).toThrow(expect.objectContaining({ status: 503 }));
      expect(mockCall).not.toHaveBeenCalled();
    });

    it('sends fenced rows (identity column included) and queues companies with the file as their source', async () => {
      mockCall.mockResolvedValue(reply([
        { name: 'Ledgerly', sourceRows: [3], vertical: 'fintech', verticalReason: 'Cash-flow tools for merchants.', city: 'Austin', state: 'TX', founders: [{ name: 'Maria Lopez', role: 'CEO' }], identity: { latinoLed: true, statedIn: 'Latino-led? = Yes' } },
        { name: 'CareLoop', sourceRows: [5], vertical: 'health', verticalReason: 'Remote monitoring.', quote: 'Remote monitoring for rural clinics' },
        { vertical: 'health' }, // nameless — dropped
      ]));

      const started = startFileImport({ fileName: 'deals.csv', rows: MESSY, submittedBy: 'Andrew' });
      expect(started.status).toBe('running');
      await fileImportIdleForTests(started.batchId);

      expect(mockCall).toHaveBeenCalledTimes(1);
      const args = mockCall.mock.calls[0][0];
      expect(args.feature).toBe('file-import-extract');
      expect(args.effort).toBe('low');
      expect(args.prompt).toContain('spreadsheet of deal flow');
      expect(args.prompt).toMatch(/<<<UNTRUSTED_SPREADSHEET_[0-9a-f]+/);
      expect(args.prompt).toContain('- Co.: Ledgerly');
      expect(args.prompt).toContain('- Latino-led?: Yes');
      expect(args.prompt).toContain('NEVER infer it from a person');

      const status = fileImportStatus(started.batchId)!;
      expect(status).toMatchObject({ status: 'done', chunksDone: 1, chunksTotal: 1, candidates: 2, error: null });
      expect(status.summary?.identityColumns).toEqual(['Latino-led?']);

      const queued = listEmailIntakeCandidates();
      expect(queued.map((c) => c.extracted.name).sort()).toEqual(['CareLoop', 'Ledgerly']);
      const ledgerly = queued.find((c) => c.extracted.name === 'Ledgerly')!;
      expect(ledgerly.source).toBe('file');
      expect(ledgerly.fileName).toBe('deals.csv');
      const evidence = (ledgerly.extracted.evidence as Record<string, unknown>[])[0];
      expect(evidence.type).toBe('Inbound referral');
      expect(evidence.source).toBe('Uploaded file "deals.csv"');
      expect(evidence.url).toMatch(/^Row 3 of "deals\.csv", uploaded by Andrew on \d{4}-\d{2}-\d{2}$/);
      expect(evidence.claim).toBe('Listed in the uploaded file "deals.csv" (row 3).');
      expect(ledgerly.extracted.identity).toEqual({
        latinoLed: true,
        basis: 'Recorded in uploaded file',
        source: expect.stringMatching(/^Row 3 of "deals\.csv", uploaded by Andrew on \d{4}-\d{2}-\d{2} \(Latino-led\? = Yes\)$/),
      });
      const careloop = queued.find((c) => c.extracted.name === 'CareLoop')!;
      expect((careloop.extracted.evidence as Record<string, unknown>[])[0].claim).toBe('Remote monitoring for rural clinics');
    });

    it('reads a big file in chunks and keeps going when one chunk fails', async () => {
      const rows = [['Company'], ...Array.from({ length: ROWS_PER_CHUNK * 3 }, (_, i) => [`Co ${i}`])];
      let call = 0;
      mockCall.mockImplementation(async () => {
        call += 1;
        if (call === 2) throw Object.assign(new Error('The AI provider request failed after 2 attempt(s): timeout'), { status: 502 });
        return reply([{ name: `Found ${call}`, vertical: 'fow', sourceRows: [2] }]);
      });

      const started = startFileImport({ fileName: 'big.csv', rows, submittedBy: 'tester' });
      await fileImportIdleForTests(started.batchId);

      expect(mockCall).toHaveBeenCalledTimes(3);
      const status = fileImportStatus(started.batchId)!;
      expect(status.status).toBe('done');
      expect(status.chunksDone).toBe(3);
      expect(status.candidates).toBe(2);
      expect(status.error).toMatch(/^Part \d \(Row \d+–\d+\) was not read: .*timeout/);
    });

    it('retries once when a reply is not readable JSON', async () => {
      mockCall
        .mockResolvedValueOnce({ ...reply([]), text: 'Sorry, here is a summary instead.' })
        .mockResolvedValueOnce(reply([{ name: 'Ledgerly', vertical: 'fintech' }]));
      const started = startFileImport({ fileName: 'deals.csv', rows: MESSY, submittedBy: 'tester' });
      await fileImportIdleForTests(started.batchId);
      expect(mockCall).toHaveBeenCalledTimes(2);
      expect(fileImportStatus(started.batchId)).toMatchObject({ status: 'done', candidates: 1, error: null });
    });

    it('stops reading further chunks once the AI budget refuses, and says how much was left unread', async () => {
      const rows = [['Company'], ...Array.from({ length: ROWS_PER_CHUNK * 6 }, (_, i) => [`Co ${i}`])];
      mockCall.mockRejectedValue(new AiRefusedError('monthly-budget', 'Monthly AI budget reached.'));
      const started = startFileImport({ fileName: 'big.csv', rows, submittedBy: 'tester' });
      await fileImportIdleForTests(started.batchId);

      expect(mockCall.mock.calls.length).toBeLessThan(6);
      const status = fileImportStatus(started.batchId)!;
      expect(status.status).toBe('failed');
      expect(status.error).toMatch(/Stopped with \d part\(s\) unread: Monthly AI budget reached\./);
    });
  });

  it('marks a file batch left "running" by a restart as interrupted', () => {
    createBatch('stale-batch', 'tester', { source: 'file', fileName: 'x.csv', status: 'running', chunksTotal: 4 });
    expect(markInterruptedFileImports()).toBe(1);
    expect(fileImportStatus('stale-batch')).toMatchObject({ status: 'interrupted' });
    expect(fileImportStatus('stale-batch')!.error).toMatch(/server restarted/);
  });

  describe('approving file candidates', () => {
    async function importTwo() {
      mockCall.mockResolvedValue(reply([
        { name: 'Ledgerly', sourceRows: [3], vertical: 'fintech', verticalReason: 'Cash-flow tools.', website: 'ledgerly.io' },
        { name: 'Mystery Co', sourceRows: [5] }, // no vertical → not ready
      ]));
      const started = startFileImport({ fileName: 'deals.xlsx — Sheet1', rows: MESSY, submittedBy: 'Andrew' });
      await fileImportIdleForTests(started.batchId);
      return started.batchId;
    }

    it('needs no typed provenance: a file candidate with a name and vertical approves as-is, as a CSV import', async () => {
      await importTwo();
      const ledgerly = listEmailIntakeCandidates().find((c) => c.extracted.name === 'Ledgerly')!;
      const result = approveEmailIntakeCandidate(ledgerly.id, 'Andrew');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const company = getCompany(result.companyId)!;
      expect(company.evidence[0].source).toBe('Uploaded file "deals.xlsx — Sheet1"');
      // Tagged like any CSV import, so "Clear imported" can undo it.
      clearImportedCompanies();
      expect(listCompanies()).toHaveLength(0);
    });

    it('"Approve all ready" approves only the ready candidates of that batch and reports the rest', async () => {
      const batchId = await importTwo();
      const r = approveReadyInBatch(batchId, 'Andrew');
      expect(r.approved).toBe(1);
      expect(r.notApproved).toEqual([expect.objectContaining({ name: 'Mystery Co', reason: 'missing vertical' })]);
      expect(listCompanies().map((c) => c.name)).toEqual(['Ledgerly']);
      const pending = listEmailIntakeCandidates().filter((c) => c.status === 'pending');
      expect(pending.map((c) => c.extracted.name)).toEqual(['Mystery Co']);
    });

    it('"Approve all ready" leaves other batches alone', async () => {
      const first = await importTwo();
      await importTwo();
      approveReadyInBatch(first, 'Andrew');
      const pendingReady = listEmailIntakeCandidates().filter((c) => c.status === 'pending' && c.extracted.name === 'Ledgerly');
      expect(pendingReady).toHaveLength(1);
    });
  });
describe('founder identity stated in a file', () => {
    async function importWith(identity: unknown, founders?: unknown[]) {
      mockCall.mockResolvedValue(reply([
        { name: 'Ledgerly', sourceRows: [3], vertical: 'fintech', verticalReason: 'Cash-flow tools.', identity, ...(founders ? { founders } : {}) },
      ]));
      const started = startFileImport({ fileName: 'deals.csv', rows: MESSY, submittedBy: 'Andrew' });
      await fileImportIdleForTests(started.batchId);
      return listEmailIntakeCandidates().find((c) => c.extracted.name === 'Ledgerly')!;
    }

    it('is recorded on the founder when approved, labeled with the file, and counts toward Mission alignment', async () => {
      const c = await importWith({ latinoLed: true, femaleLed: true, statedIn: 'Latino-led? = Yes; Female founder? = Y' }, [{ name: 'Ana Ruiz', role: 'CEO' }]);
      const r = approveEmailIntakeCandidate(c.id, 'Andrew');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const company = getCompany(r.companyId)!;
      expect(company.founders[0].identity).toMatchObject({ latinoLed: true, femaleLed: true, basis: 'Recorded in uploaded file' });
      expect(company.founders[0].identity!.source).toContain('Row 3 of "deals.csv"');
      const mission = scoreCompany(company as unknown as Company).components.find((x) => x.key === 'mission')!;
      expect(mission.assessable).toBe(true);
      expect(mission.points).toBe(12);
      expect(mission.rationale).toContain('recorded in uploaded file');
    });

    it('keeps only explicit positive indicators — a "No", a non-boolean, or an unknown value is not a claim', async () => {
      const c = await importWith({ latinoLed: false, femaleLed: 'yes', immigrantBackground: 'maybe', statedIn: 'Latino-led? = No' });
      expect(c.extracted.identity).toBeUndefined();
    });

    it('"Don’t record identity" removes it before approval', async () => {
      const c = await importWith({ latinoLed: true, statedIn: 'Latino-led? = Yes' });
      expect(updateEmailIntakeCandidate(c.id, { identity: null }).ok).toBe(true);
      const r = approveEmailIntakeCandidate(c.id, 'Andrew');
      if (!r.ok) throw new Error(r.error);
      expect(getCompany(r.companyId)!.founders.every((f) => !f.identity)).toBe(true);
    });

    it('is never taken from an email extraction or pasted reply', () => {
      const { candidates } = submitEmailIntakeBatch({
        reply: JSON.stringify({ candidates: [{ name: 'Acme', vertical: 'health', identity: { latinoLed: true, statedIn: 'x' } }] }),
        submittedBy: 'tester',
      });
      expect(candidates[0].extracted.identity).toBeUndefined();
    });

    it('survives research replacing the "Unknown founder" placeholder, and a later re-save without identity', async () => {
      const c = await importWith({ latinoLed: true, statedIn: 'Latino-led? = Yes' }); // no founders named
      const r = approveEmailIntakeCandidate(c.id, 'Andrew');
      if (!r.ok) throw new Error(r.error);
      expect(getCompany(r.companyId)!.founders[0]).toMatchObject({ name: 'Unknown founder', identity: { latinoLed: true } });

      expect(setResolvedFounders(r.companyId, [{ name: 'Ana Ruiz', role: 'CEO', background: 'Ex-Stripe.' }, { name: 'Tom Lee', role: 'CTO', background: 'Engineer.' }])).toBe(true);
      const resolved = getCompany(r.companyId)!;
      expect(resolved.founders.map((f) => f.name)).toEqual(['Ana Ruiz', 'Tom Lee']);
      expect(resolved.founders[0].identity).toMatchObject({ latinoLed: true, basis: 'Recorded in uploaded file' });

      // A later save (e.g. a re-import matching the same company) with founders carrying no identity keeps it.
      saveCompany({ ...resolved, founders: resolved.founders.map(({ identity: _i, ...f }) => f) }, { origin: 'user-entered', source: 'local-csv' });
      expect(getCompany(r.companyId)!.founders[0].identity).toMatchObject({ latinoLed: true });
    });

  });
});
