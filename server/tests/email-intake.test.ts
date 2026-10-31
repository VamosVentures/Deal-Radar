import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { companyMetaView, getCompany, getProvenance, listCompanies, saveCompany } from '../db/repos/companies';
import { officialSubcategories } from '../../src/data/taxonomy';
import { latestScore } from '../db/repos/operations';
import { clearImportedCompanies, importCompaniesCsv, importedCompanySchema } from '../services/imports';import {
  approvalBlockers, approveEmailIntakeCandidate, discardEmailIntakeCandidate, listEmailIntakeCandidates,
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
      // A suggestion alone is not a decision — vertical still blocks approval until a reviewer confirms it.
      expect(approvalBlockers(candidates[0].extracted)).toContain('vertical');
    });

    it('does not suggest a vertical, or override one, when Claude already reported it', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      expect(candidates[0].extracted.vertical).toBe('health');
      expect(candidates[0].extracted.suggestedVertical).toBeUndefined();
    });

    it("keeps Claude's proposed vertical and its reason, normalizing case", () => {
      const reply = JSON.stringify({ candidates: [{ name: 'PayCo', vertical: 'FinTech', verticalReason: 'The email says it builds payments for small merchants.' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      expect(candidates[0].extracted.vertical).toBe('fintech');
      expect(candidates[0].extracted.verticalReason).toBe('The email says it builds payments for small merchants.');
    });

    it('drops a vertical that is not one of the five ids, and falls back to the classifier suggestion', () => {
      const reply = JSON.stringify({
        candidates: [{
          name: 'Cardio Co', vertical: 'healthcare', verticalReason: 'Hospitals.',
          oneLiner: 'Remote patient monitoring platform for cardiac patients, sold to hospitals and health systems.',
        }],
      });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      expect(candidates[0].extracted.vertical).toBeUndefined();
      expect(candidates[0].extracted.verticalReason).toBeUndefined();
      expect(candidates[0].extracted.suggestedVertical).toBe('health');
    });
  });

  describe('approvalBlockers', () => {
    it('only name, vertical, and who forwarded it can block approval', () => {
      const reply = JSON.stringify({ candidates: [COMPLETE_CANDIDATE, { name: 'Bare Co' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      // Traction, founders, location etc. are absent from Bare Co but never block.
      expect(approvalBlockers(candidates[0].extracted)).toEqual(['evidence']);
      expect(approvalBlockers(candidates[1].extracted)).toEqual(['vertical', 'evidence']);
    });
  });

  describe('approveEmailIntakeCandidate', () => {
    it('approves a card whose co-founder has a name and role but no background (2026-10-30 Nuum Robotics)', () => {
      // Claude found a second co-founder with no background. The review
      // card's save used to send it unchanged, the PATCH schema rejected it,
      // the forwarder never saved, and approve failed with a misleading
      // "evidence" blocker.
      const reply = JSON.stringify({ candidates: [{
        name: 'Nuum Robotics', vertical: 'frontier', quote: 'Snake-like robots for maintenance inside machinery.',
        founders: [{ name: 'Isaac MacLean', role: 'Co-Founder' }, { name: 'Mark Seemann', role: 'Co-Founder' }],
      }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      const { id, extracted } = candidates[0];
      const evidence = [{ ...(extracted.evidence as Record<string, unknown>[])[0], url: 'Forwarded by Valeria Martinez; 10/30/2026' }];
      const patchSchema = importedCompanySchema.partial(); // what the PATCH route parses

      // The founders exactly as Claude returned them fail the PATCH schema…
      expect(patchSchema.safeParse({ founders: extracted.founders, evidence }).success).toBe(false);
      // …so the card's save (src/lib/emailIntakeDraft.ts patchFrom) defaults
      // every founder's role/background; that shape must pass and approve.
      const founders = [
        { name: 'Isaac MacLean', role: 'Co-Founder', background: 'Not on record.' },
        { name: 'Mark Seemann', role: 'Co-Founder', background: 'Not on record.' },
      ];
      expect(updateEmailIntakeCandidate(id, patchSchema.parse({ founders, evidence })).ok).toBe(true);

      const result = approveEmailIntakeCandidate(id, 'test-reviewer');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(getCompany(result.companyId)!.founders.map((f) => f.name)).toEqual(['Isaac MacLean', 'Mark Seemann']);
    });

    it('refuses to promote a candidate without a vertical or forwarder (422, with exactly those fields)', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'Bare Co' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });

      const result = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.missingFields).toEqual(['vertical', 'evidence']);
      }
      expect(listCompanies()).toHaveLength(0);
    });

    it('approves a thin lead (name + vertical + forwarder) with honest, Missing-marked placeholders for the rest', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'Thin Lead Co', vertical: 'fintech', quote: 'Small team doing something in payments.' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      const evidence = candidates[0].extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(candidates[0].id, { evidence: [{ ...evidence[0], url: 'Forwarded by Maria, 2026-10-26' }] });

      const result = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const company = getCompany(result.companyId)!;
      expect(company.vertical).toBe('fintech');
      expect(company.oneLiner).toBe('Unknown — pitch not yet verified');
      expect(company.stage).toBe('Unknown');
      expect(company.traction).toEqual({ level: 0, note: 'Unknown — not yet researched' });
      expect(company.founders[0].name).toBe('Unknown founder');
      expect(company.evidence[0]).toMatchObject({ type: 'Inbound referral', url: 'Forwarded by Maria, 2026-10-26', claim: 'Small team doing something in payments.' });

      // Every unstated field is recorded as `missing` — shown as "Missing", never as a fact, and overwritable by research.
      for (const field of ['oneLiner', 'subcategory', 'stage', 'city', 'state', 'foundedYear', 'teamSize', 'tractionLevel', 'tractionNote']) {
        expect(getProvenance(result.companyId, field)?.origin, field).toBe('missing');
      }
      // What the reviewer did supply is not.
      expect(getProvenance(result.companyId, 'name')?.origin).toBe('user-entered');
      expect(getProvenance(result.companyId, 'vertical')?.origin).toBe('user-entered');
      // Thin data means a provisional score, kept out of High-Fit.
      expect(latestScore(result.companyId)?.provisional).toBe(true);
    });

    it('uses a plain description as the evidence claim when Claude quoted nothing', () => {
      const reply = JSON.stringify({ candidates: [{ name: 'No Quote Co', vertical: 'fow' }] });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      const evidence = candidates[0].extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(candidates[0].id, { evidence: [{ ...evidence[0], url: 'Forwarded by Sam, 2026-10-26' }] });
      const result = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(result.ok).toBe(true);
      if (result.ok) expect(getCompany(result.companyId)?.evidence[0]?.claim).toBe('Referred as a lead in a forwarded deal-flow email.');
    });

    it('normalizes harmless formatting (state case, bare domain, stage case) but rejects a stated value that is invalid', () => {
      const reply = JSON.stringify({
        candidates: [
          { name: 'Format Co', vertical: 'health', state: 'tx', website: 'formatco.com', stage: 'seed' },
          { name: 'Bad State Co', vertical: 'health', state: 'Texas' },
        ],
      });
      const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
      for (const c of candidates) {
        const evidence = c.extracted.evidence as Record<string, unknown>[];
        updateEmailIntakeCandidate(c.id, { evidence: [{ ...evidence[0], url: 'Forwarded by Sam, 2026-10-26' }] });
      }

      const ok = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const company = getCompany(ok.companyId)!;
        expect(company.state).toBe('TX');
        expect(company.website).toBe('https://formatco.com');
        expect(company.stage).toBe('Seed');
      }

      // A real stated value is never silently replaced with a placeholder — the reviewer fixes it.
      const bad = approveEmailIntakeCandidate(candidates[1].id, 'test-reviewer');
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.status).toBe(422);
        expect(bad.missingFields?.some((f) => f.startsWith('state'))).toBe(true);
      }
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

  describe('"Clear imported" (Settings) never touches approved email leads', () => {
    it('removes CSV-imported companies only — an approved email lead and a Deal Discovery company both survive', () => {
      saveCompany({
        id: 'discovery-co', name: 'Discovery Co', oneLiner: 'Fixture pitch', vertical: 'health',
        subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
        traction: { level: 5, note: 'Fixture' },
        founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture' }],
        evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/x', date: '2026-07-01', type: 'News' }],
        flags: [], imported: true,
      }, { origin: 'extracted', source: 'discovery:yc', discoverySource: 'yc' });

      const csv = [
        'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType',
        'Nueva Salud,Bilingual telehealth for rural clinics,health,Personalized care,Seed,El Paso,TX,2025,9,6,Two clinic pilots live,Ana Ruiz,CEO,Former clinic director,Pilot announced,Local news,https://example.com/nueva,2026-05-01,News',
      ].join('\n');
      expect(importCompaniesCsv(csv).imported).toBe(1);

      const { candidates } = submitEmailIntakeBatch({ reply: JSON.stringify({ candidates: [COMPLETE_CANDIDATE] }), submittedBy: 'test-reviewer' });
      const evidence = candidates[0].extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(candidates[0].id, {
        traction: { level: 4, note: 'Piloting with 2 regional hospital systems.' },
        evidence: [{ ...evidence[0], url: 'Forwarded by Jane, 2026-09-14' }],
      });
      const approved = approveEmailIntakeCandidate(candidates[0].id, 'test-reviewer');
      expect(approved.ok).toBe(true);
      expect(listCompanies()).toHaveLength(3);

      clearImportedCompanies();

      const remaining = listCompanies().map((c) => c.name).sort();
      expect(remaining).toEqual(['Acme Health', 'Discovery Co']);
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

  describe('subcategory is always an official name of the vertical, never free text', () => {
    const queue = (candidate: Record<string, unknown>) =>
      submitEmailIntakeBatch({ reply: JSON.stringify({ candidates: [candidate] }), submittedBy: 'test-reviewer' }).candidates[0];
    const forwarded = (id: number, extracted: Record<string, unknown>) => {
      const evidence = extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(id, { evidence: [{ ...evidence[0], url: 'Forwarded by Andrew, 2026-10-28' }] });
    };

    it('keeps an official subcategory, normalized to its canonical spelling', () => {
      const c = queue({ name: 'Liquid Co', vertical: 'sustainability', subcategory: 'renewable-energy DIGITAL infrastructure ' });
      expect(c.extracted.subcategory).toBe('Renewable-energy digital infrastructure');
    });

    it("force-fits an invented subcategory from the vertical's own taxonomy (the STASIS case)", () => {
      const c = queue({ name: 'Eye Co', vertical: 'health', subcategory: 'Eye health monitoring', oneLiner: 'Wearable monitoring for eye health.' });
      expect(c.extracted.vertical).toBe('health');
      const sub = c.extracted.subcategory;
      // Either a real Health subcategory, or left for the reviewer — never the invented text.
      if (sub !== undefined) expect(officialSubcategories('health')).toContain(sub);
      expect(sub).not.toBe('Eye health monitoring');
    });

    it('leaves the subcategory unset when nothing official fits, rather than storing free text', () => {
      const c = queue({ name: 'Odd Co', vertical: 'fintech', subcategory: 'Quantum origami', oneLiner: 'Folding things.' });
      expect(c.extracted.subcategory).toBeUndefined();
    });

    it("never takes a subcategory from another vertical's taxonomy", () => {
      const c = queue({ name: 'Mixed Co', vertical: 'fintech', subcategory: 'Autonomous agents' });
      expect(c.extracted.subcategory).toBeUndefined();
    });

    it('does not invent one when Claude gave none', () => {
      const c = queue({ name: 'Quiet Co', vertical: 'fintech', quote: 'Small team doing something in payments.' });
      expect(c.extracted.subcategory).toBeUndefined();
    });

    it('rejects an explicit edit to a non-official subcategory', () => {
      const c = queue({ name: 'Edit Co', vertical: 'fow' });
      expect(updateEmailIntakeCandidate(c.id, { subcategory: 'Something I made up' })).toMatchObject({ ok: false, status: 422 });
    });

    it('drops the old subcategory when the reviewer changes the vertical', () => {
      const c = queue({ name: 'Switch Co', vertical: 'fow', subcategory: 'Autonomous agents' });
      expect(updateEmailIntakeCandidate(c.id, { vertical: 'fintech' }).ok).toBe(true);
      const updated = listEmailIntakeCandidates().find((x) => x.id === c.id)!;
      expect(updated.extracted.vertical).toBe('fintech');
      expect(updated.extracted.subcategory).toBeUndefined();
    });

    it('blocks approval of a non-official subcategory that got in some other way', () => {
      const evidence = [{ url: 'Forwarded by A' }];
      expect(approvalBlockers({ name: 'X', vertical: 'health', subcategory: 'Eye health monitoring', evidence })).toEqual(['subcategory']);
      expect(approvalBlockers({ name: 'X', vertical: 'health', subcategory: 'Longevity', evidence })).toEqual([]);
    });

    it('approves with the official subcategory stored', () => {
      const c = queue({ name: 'Approve Co', vertical: 'fow', subcategory: 'Autonomous agents' });
      forwarded(c.id, c.extracted);
      const result = approveEmailIntakeCandidate(c.id, 'test-reviewer');
      expect(result.ok).toBe(true);
      if (result.ok) expect(getCompany(result.companyId)?.subcategory).toBe('Autonomous agents');
    });
  });

  describe('company meta carries createdAt so CSV/email companies sort and filter by date', () => {
    it('includes createdAt for an approved email lead, which has no discoveredAt', () => {
      const c = submitEmailIntakeBatch({ reply: JSON.stringify({ candidates: [{ name: 'Dated Co', vertical: 'fow' }] }), submittedBy: 't' }).candidates[0];
      const evidence = c.extracted.evidence as Record<string, unknown>[];
      updateEmailIntakeCandidate(c.id, { evidence: [{ ...evidence[0], url: 'Forwarded by A, 2026-10-28' }] });
      const result = approveEmailIntakeCandidate(c.id, 't');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const meta = companyMetaView()[result.companyId];
      expect(meta.discoveredAt).toBeUndefined();
      expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
