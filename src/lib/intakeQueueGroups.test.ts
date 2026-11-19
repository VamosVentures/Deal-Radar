import { describe, expect, it } from 'vitest';
import type { EmailIntakeCandidate } from './api';
import { draftFor } from './emailIntakeDraft';
import { groupByBatch, isDirty, sourceRowsLabel } from './intakeQueueGroups';

function candidate(id: number, batchId: string, extra: Partial<EmailIntakeCandidate> = {}): EmailIntakeCandidate {
  return {
    id, batchId, extracted: { name: `Co ${id}` }, status: 'pending', promotedCompanyId: null, decidedBy: null,
    decidedAt: null, decisionNote: null, createdAt: '2026-11-18T00:00:00Z', missingFields: [], source: 'email', fileName: null,
    ...extra,
  };
}

describe('groupByBatch', () => {
  it('groups by batch, newest batch first, each batch in reported order', () => {
    // The API lists candidates newest-first.
    const groups = groupByBatch([
      candidate(5, 'file-b', { source: 'file', fileName: 'deals.xlsx' }),
      candidate(4, 'file-b', { source: 'file', fileName: 'deals.xlsx' }),
      candidate(2, 'email-a'),
      candidate(1, 'email-a'),
    ]);
    expect(groups.map((g) => g.batchId)).toEqual(['file-b', 'email-a']);
    expect(groups[0]).toMatchObject({ source: 'file', fileName: 'deals.xlsx' });
    expect(groups[0].candidates.map((c) => c.id)).toEqual([4, 5]);
    expect(groups[1].candidates.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe('isDirty', () => {
  it('is false for an untouched draft and true once a field changes', () => {
    const c = candidate(1, 'b');
    const draft = draftFor(c);
    expect(isDirty(draft, c)).toBe(false);
    expect(isDirty({ ...draft, city: 'Austin' }, c)).toBe(true);
  });
});

describe('sourceRowsLabel', () => {
  it('labels spreadsheet rows and ignores junk', () => {
    expect(sourceRowsLabel({ sourceRows: [12] })).toBe('Row 12');
    expect(sourceRowsLabel({ sourceRows: [12, 13] })).toBe('Rows 12, 13');
    expect(sourceRowsLabel({ sourceRows: ['x', -1] })).toBe('');
    expect(sourceRowsLabel({})).toBe('');
  });
});
