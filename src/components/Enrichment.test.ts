import { describe, expect, it } from 'vitest';
import { resolveVerticalCellView } from './Enrichment';
import type { CompanyEnrichment } from '../../shared/enrichment';

/**
 * THE BUG
 *
 * `VerticalCell` showed Research's own `primaryLabel` the moment
 * Research produced ANY result, agreeing with the stored vertical or
 * not. Podium is filed under (and only ever surfaced by filtering for)
 * `fintech`, but Research read its site as Future of Work — so the
 * table visibly showed "Future of Work" for a company nobody could find
 * by filtering for Future of Work. The bold label must always be the
 * bucket that actually governs the filter, never Research's opinion.
 */

function enrichmentWithVertical(over: Partial<CompanyEnrichment['vertical']['value']> & {
  primaryLabel: string;
}): CompanyEnrichment {
  return {
    founder: { state: 'candidate', value: null, inferred: false, confidence: 0, summary: '', nextAction: '', evidence: [], sourcesAttempted: [], lastResearchedAt: null, conflicts: [], candidates: [] },
    vertical: {
      state: 'confirmed',
      value: {
        primarySector: 'fow', secondarySector: null, subvertical: null,
        countsTowardRanking: true, evidenceGap: null,
        ...over,
      },
      inferred: false, confidence: 0.6, summary: 'Test summary.', nextAction: '',
      evidence: [], sourcesAttempted: [], lastResearchedAt: null, conflicts: [],
    },
    stage: { state: 'candidate', value: null, inferred: false, confidence: 0, summary: '', nextAction: '', evidence: [], sourcesAttempted: [], lastResearchedAt: null, conflicts: [] },
    corrections: [],
  } as unknown as CompanyEnrichment;
}

describe('resolveVerticalCellView', () => {
  it('shows the stored bucket, flagged as a conflict, when Research disagrees — never Research\'s own sector', () => {
    const enrichment = enrichmentWithVertical({ primaryLabel: 'Future of Work', subvertical: 'learning and development' });
    const view = resolveVerticalCellView(enrichment, 'fintech', 'consumer wellness');
    expect(view.label).toBe('FinTech');
    expect(view.detail).toMatch(/Research suggests Future of Work/);
    expect(view.badge).toBe('conflict');
  });

  it('shows the subvertical as the detail line when Research agrees with the stored bucket', () => {
    const enrichment = enrichmentWithVertical({ primaryLabel: 'FinTech', subvertical: 'payments infrastructure' });
    const view = resolveVerticalCellView(enrichment, 'fintech', 'Unclassified — requires manual review');
    expect(view.label).toBe('FinTech');
    expect(view.detail).toBe('payments infrastructure');
    expect(view.badge).toBe(null);
  });

  it('falls back to the stored bucket, labelled unconfirmed, before Research has run at all', () => {
    const view = resolveVerticalCellView(undefined, 'fintech', 'consumer wellness');
    expect(view.label).toBe('FinTech');
    expect(view.detail).toBe('consumer wellness');
    expect(view.badge).toBe('candidate');
  });

  it('treats the placeholder subcategory as no detail, not literal text', () => {
    const view = resolveVerticalCellView(undefined, 'fintech', 'Unclassified — requires manual review');
    expect(view.detail).toBe(null);
  });
});
