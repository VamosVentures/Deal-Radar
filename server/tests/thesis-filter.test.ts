import { describe, expect, it } from 'vitest';
import { discoveryCandidateSchema, discoveryQuerySchema, type DiscoveryCandidate, type DiscoveryQuery } from '../../shared/discovery';
import { evaluateThesisEligibility } from '../sourcing/thesisFilter';

/**
 * Stage 1: hard thesis eligibility. The two properties that matter are
 * symmetric and both easy to get wrong — it must reject what it can
 * PROVE is out of thesis, and it must never reject on a gap in what we
 * know. The second half is the one that quietly destroys a funnel.
 */

function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return discoveryCandidateSchema.parse({
    id: 'cand-1', runId: 'run-1', discoveredAt: '2026-08-01T00:00:00.000Z',
    sourceId: 'yc', simulated: false, companyName: 'Testco',
    pitch: 'Workflow software for hospital billing teams.',
    confidence: 0.7,
    evidence: [{
      claim: 'Listed in the public YC directory, batch S26.',
      source: 'Y Combinator', url: 'https://www.ycombinator.com/companies/testco',
      dateAccessed: '2026-08-01',
    }],
    ...over,
  });
}

function query(over: Partial<DiscoveryQuery> = {}): DiscoveryQuery {
  return discoveryQuerySchema.parse({ sources: ['yc'], ...over });
}

describe('stage 1 — thesis eligibility', () => {
  it('passes a plausible early-stage candidate', () => {
    const v = evaluateThesisEligibility(candidate(), query());
    expect(v.eligible).toBe(true);
    expect(v.rejections).toEqual([]);
  });

  describe('rejects on positive evidence of ineligibility', () => {
    it('rejects a non-operating entity (fund, university, government body)', () => {
      for (const name of ['Vamos Robotics Fund II, L.P.', 'Foshan University', 'Ministry of Energy']) {
        const v = evaluateThesisEligibility(candidate({ companyName: name }), query());
        expect(v.eligible, name).toBe(false);
        expect(v.rejections.map((r) => r.code)).toContain('not-operating-company');
      }
    });

    it('rejects a self-described agency or consultancy', () => {
      const v = evaluateThesisEligibility(
        candidate({ pitch: 'We are a consulting firm helping enterprises adopt AI.' }),
        query(),
      );
      expect(v.eligible).toBe(false);
      const hit = v.rejections.find((r) => r.code === 'excluded-business-type')!;
      expect(hit).toBeDefined();
      // The rejection must quote what it read, not just assert a verdict.
      expect(hit.evidence.toLowerCase()).toContain('consulting');
    });

    it('rejects a company a source says is past the target stage', () => {
      const cases = [
        'Acme raises $120M Series C to expand.',
        'Acme raised $250 million this year.',
        'Acme went public on the NASDAQ.',
        'Acme was acquired by Salesforce.',
      ];
      for (const pitch of cases) {
        const v = evaluateThesisEligibility(candidate({ pitch }), query());
        expect(v.eligible, pitch).toBe(false);
        expect(v.rejections.map((r) => r.code), pitch).toContain('past-target-stage');
      }
    });

    it('rejects a company a source says has stopped operating', () => {
      const v = evaluateThesisEligibility(
        candidate({ pitch: 'Acme ceased operations in June and is winding down.' }),
        query(),
      );
      expect(v.eligible).toBe(false);
      expect(v.rejections.map((r) => r.code)).toContain('inactive');
    });

    it('rejects a recorded location outside the run’s geography', () => {
      const v = evaluateThesisEligibility(
        candidate({ hqState: 'FL' }),
        query({ geography: 'Preferred states' }),
      );
      expect(v.eligible).toBe(false);
      expect(v.rejections.map((r) => r.code)).toContain('outside-geography');
    });

    it('rejects an exact duplicate of an existing record', () => {
      const v = evaluateThesisEligibility(
        candidate({ duplicateStatus: 'exact', duplicateOfId: 'co-1', duplicateOfName: 'Existing Co' }),
        query(),
      );
      expect(v.eligible).toBe(false);
      expect(v.rejections.map((r) => r.code)).toContain('duplicate');
    });

    it('rejects a record below its source’s credibility floor', () => {
      const v = evaluateThesisEligibility(candidate({ sourceId: 'sec', confidence: 0.2 }), query());
      expect(v.eligible).toBe(false);
      expect(v.rejections.map((r) => r.code)).toContain('source-credibility');
    });

    it('reports EVERY failed requirement, not only the first', () => {
      const v = evaluateThesisEligibility(
        candidate({ companyName: 'Growth Fund II, L.P.', pitch: 'Acquired by Oracle after its Series D.', confidence: 0.1 }),
        query(),
      );
      expect(v.rejections.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('never rejects on a gap in what we know', () => {
    it('keeps a candidate whose stage is unknown', () => {
      const v = evaluateThesisEligibility(candidate({ stage: 'Unknown' }), query());
      expect(v.eligible).toBe(true);
      expect(v.undetermined).toContain('past-target-stage');
    });

    it('keeps a candidate whose location is unknown, even under a state filter', () => {
      const v = evaluateThesisEligibility(candidate({ hqState: 'Unknown' }), query({ geography: 'Preferred states' }));
      expect(v.eligible).toBe(true);
      expect(v.undetermined).toContain('outside-geography');
    });

    it('keeps a candidate whose vertical the source did not state', () => {
      // The deterministic classifier resolves this later at import time
      // and already refuses to guess; pre-rejecting here would discard
      // candidates whose published text reads perfectly well.
      const v = evaluateThesisEligibility(candidate({ vertical: 'Unknown' }), query());
      expect(v.eligible).toBe(true);
      expect(v.undetermined).toContain('outside-approved-vertical');
    });

    it('keeps a "likely" duplicate for a human to decide', () => {
      const v = evaluateThesisEligibility(
        candidate({ duplicateStatus: 'likely', duplicateOfId: 'co-1', duplicateOfName: 'Maybe Co' }),
        query(),
      );
      expect(v.eligible).toBe(true);
    });

    it('does not mistake a company that merely MENTIONS consultants for a consultancy', () => {
      const v = evaluateThesisEligibility(
        candidate({ pitch: 'Our software replaces expensive consultants for mid-market finance teams.' }),
        query(),
      );
      expect(v.eligible).toBe(true);
    });

    it('imposes no state restriction when the geography is nationwide', () => {
      const v = evaluateThesisEligibility(candidate({ hqState: 'FL' }), query({ geography: 'United States' }));
      expect(v.eligible).toBe(true);
    });
  });
});
