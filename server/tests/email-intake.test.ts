import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { getCompany, listCompanies } from '../db/repos/companies';
import { missingRequiredFields } from '../services/imports';
import {
  approveEmailIntakeCandidate, discardEmailIntakeCandidate, listEmailIntakeCandidates,
  parseExtractionReply, submitEmailIntakeBatch, updateEmailIntakeCandidate,
} from '../services/emailIntake';

// Everything a real extraction reply can plausibly contain — deliberately
// WITHOUT a traction rating, since the prompt never asks Claude for one
// (rating traction is a human analyst judgment, never an AI inference —
// see EMAIL_INTAKE_PROMPT's hard rule). "Complete" here means complete for
// what an email can state; traction still has to come from a reviewer.
const COMPLETE_CANDIDATE = {
  name: 'Acme Health', oneLiner: 'Remote patient monitoring for cardiac care.',
  vertical: 'health', subcategory: 'Remote patient monitoring', stage: 'Seed',
  city: 'Austin', state: 'TX', foundedYear: 2022, teamSize: 8,
  founders: [{ name: 'Jane Doe', role: 'CEO', background: 'Former product lead at a digital health startup.' }],
  quote: 'Piloting with 2 regional hospital systems.',
};

describe('email intake', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  describe('parseExtractionReply', () => {
    it('parses a clean JSON reply', () => {
      const result = parseExtractionReply(JSON.stringify({ candidates: [{ name: 'Acme' }] }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.candidates).toHaveLength(1);
    });

    it('tolerates a markdown-fenced reply with prose around it', () => {
      const reply = 'Here you go:\n```json\n{"candidates": [{"name": "Acme"}]}\n```\nLet me know if you need more.';
      const result = parseExtractionReply(reply);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.candidates).toEqual([{ name: 'Acme' }]);
    });

    it('rejects a reply with no candidates array', () => {
      const result = parseExtractionReply(JSON.stringify({ companies: [] }));
      expect(result.ok).toBe(false);
    });

    it('rejects unparseable text', () => {
      const result = parseExtractionReply('not json at all');
      expect(result.ok).toBe(false);
    });
  });

  describe('submitEmailIntakeBatch', () => {
    it('queues one pending candidate per named company, wrapped with Inbound referral evidence', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE, { oneLiner: 'No name, should be dropped.' }] });
      const result = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });

      expect(result.skipped).toBe(1);
      expect(result.candidates).toHaveLength(1);
      const c = result.candidates[0];
      expect(c.status).toBe('pending');
      expect(c.extracted.name).toBe('Acme Health');
      expect(c.extracted.evidence).toEqual([
        { type: 'Inbound referral', claim: 'Piloting with 2 regional hospital systems.', source: 'Forwarded email', url: '', date: expect.any(String) },
      ]);

      expect(listEmailIntakeCandidates()).toHaveLength(1);
    });

    it('rejects a reply that fails to parse, without creating a batch', () => {
      expect(() => submitEmailIntakeBatch({ reply: 'garbage', submittedBy: 'test-reviewer' }))
        .toThrow();
      expect(listEmailIntakeCandidates()).toHaveLength(0);
    });

    it('suggests a vertical from the description when Claude did not report one, without writing it into `vertical` itself', () => {
      const reply = JSON.stringify({
        candidates: [{
          name: 'No Vertical Stated Co',
          oneLiner: 'Remote patient monitoring platform for cardiac patients, sold to hospitals and health systems.',
        }],
      });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      expect(candidates[0].extracted.vertical).toBeUndefined();
      expect(candidates[0].extracted.suggestedVertical).toBe('health');
      expect(typeof candidates[0].extracted.suggestedVerticalReason).toBe('string');
      // A suggestion alone does not satisfy the schema — still missing until a reviewer confirms it.
      expect(missingRequiredFields(candidates[0].extracted)).toContain('vertical');
    });

    it('does not suggest a vertical, or override one, when Claude already reported it', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      expect(candidates[0].extracted.vertical).toBe('health');
      expect(candidates[0].extracted.suggestedVertical).toBeUndefined();
    });
  });

  describe('missingRequiredFields on a queued candidate', () => {
    it('flags evidence and traction as missing — the two fields extraction never fills in', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      // Every stateable fact was in the email; traction (an analyst
      // rating) and the evidence description (who forwarded it) are the
      // two things only a human reviewer supplies, by design.
      expect(missingRequiredFields(candidates[0].extracted).sort()).toEqual(['evidence', 'traction']);
    });

    it('flags every field the email never stated', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'Bare Co' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      const missing = missingRequiredFields(candidates[0].extracted);
      expect(missing).toEqual(expect.arrayContaining(['oneLiner', 'vertical', 'stage', 'city', 'state', 'founders', 'evidence']));
      expect(missing).not.toContain('id');
    });
  });

  describe('approveEmailIntakeCandidate', () => {
    it('refuses to promote a candidate still missing required fields (422, with the list)', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'Bare Co' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });

      const result = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.missingFields).toEqual(expect.arrayContaining(['oneLiner', 'vertical']));
      }
      expect(listCompanies()).toHaveLength(0);
    });

    it('promotes a complete candidate into a real, scored company via the shared commit path', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      const id = candidates[0].id;

      // The reviewer fills in the two things only a human supplies: a
      // traction rating (never AI-inferred) and who forwarded the email.
      const existingEvidence = candidates[0].extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(id, {
        traction: { level: 4, note: 'Piloting with 2 regional hospital systems, ~500 patients monitored to date.' },
        evidence: [{ ...existingEvidence[0], url: 'Forwarded by Jane, 2026-09-14' }],
      });

      const result = approveEmailIntakeCandidate(id, 'test-reviewer');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const company = getCompany(result.companyId);
        expect(company?.name).toBe('Acme Health');
        expect(company?.evidence[0]?.type).toBe('Inbound referral');
        expect(company?.evidence[0]?.url).toBe('Forwarded by Jane, 2026-09-14');
      }

      // A second decision on the same candidate is refused, not silently reapplied.
      const second = approveEmailIntakeCandidate(id, 'someone-else');
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.status).toBe(409);
    });
  });

  describe('discardEmailIntakeCandidate', () => {
    it('marks a candidate discarded without creating a company', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'Not worth it' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });

      const result = discardEmailIntakeCandidate(candidates[0].id, 'test-reviewer', 'outside thesis');
      expect(result.ok).toBe(true);
      expect(listCompanies()).toHaveLength(0);
      expect(listEmailIntakeCandidates().find((c) => c.id === candidates[0].id)?.status).toBe('discarded');
    });
  });
});
