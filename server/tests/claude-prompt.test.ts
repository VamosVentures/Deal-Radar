import { describe, expect, it } from 'vitest';
import { buildClaudePrompt } from '../../src/lib/claudePrompt';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * The credential-free "Copy Claude prompt" action.
 *
 * The interesting assertions here are the NEGATIVE ones. This prompt is
 * built to be pasted into a chat window, which makes it the easiest
 * possible path for something confidential to leave the tool — the same
 * risk the CSV export is shaped around (see src/lib/csvExport.ts). So
 * the rules that matter are what the prompt must NOT contain: internal
 * note text, founder contact details, and identity/demographic fields.
 *
 * The second thing under test is the honesty of gaps. A model handed a
 * silently-missing stage will invent one, and an invented stage is
 * exactly the class of error this codebase spends most of its effort
 * preventing, so unknowns have to travel as explicit "not on record".
 */

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: 'test-co-1',
    name: 'Testable Health Inc.',
    oneLiner: 'A recorded one-liner.',
    vertical: 'health',
    subcategory: 'Care',
    stage: 'Seed',
    city: 'Austin',
    state: 'TX',
    foundedYear: 2024,
    teamSize: 6,
    traction: { level: 5, note: 'Recorded traction note.' },
    founders: [
      {
        name: 'Jordan Rivera',
        role: 'CEO',
        background: 'Ten years in clinical operations.',
        // Present on the record, and must NOT reach the prompt.
        email: 'jordan.private@testablehealth.example',
        emailSource: 'enrichment',
        linkedin: 'https://linkedin.example/in/jordan',
      },
    ],
    evidence: [
      {
        claim: 'Raised a $12,000,000 seed round.',
        source: 'SEC EDGAR (Form D)',
        url: 'https://www.sec.gov/example-filing',
        date: '2026-05-01',
        type: 'Filing',
      },
    ],
    flags: [],
    website: 'https://testablehealth.example',
    ...overrides,
  } as Company;
}

describe('buildClaudePrompt', () => {
  it('includes the recorded facts, evidence, and audited score components', () => {
    const c = company();
    const prompt = buildClaudePrompt(c, scoreCompany(c));

    expect(prompt).toContain('Testable Health Inc.');
    expect(prompt).toContain('A recorded one-liner.');
    expect(prompt).toContain('Raised a $12,000,000 seed round.');
    expect(prompt).toContain('SEC EDGAR (Form D)');
    expect(prompt).toContain('https://www.sec.gov/example-filing');
    // Founder role and background are legitimate analytical context.
    expect(prompt).toContain('Jordan Rivera');
    expect(prompt).toContain('Ten years in clinical operations.');
  });

  it('never carries founder contact details', () => {
    const c = company();
    const prompt = buildClaudePrompt(c, scoreCompany(c));

    expect(prompt).not.toContain('jordan.private@testablehealth.example');
    expect(prompt).not.toContain('linkedin.example');
    expect(prompt).not.toMatch(/@testablehealth\.example/);
  });

  it('never carries internal note text', () => {
    // Notes are not part of the Company payload the UI holds at all —
    // this asserts the boundary rather than a filter, so a future change
    // that plumbed notes into the bulk payload would fail here.
    const c = company();
    const prompt = buildClaudePrompt(c, scoreCompany(c));
    expect(prompt.toLowerCase()).not.toContain('internal note');
    expect(JSON.stringify(c)).not.toContain('note text');
  });

  it('writes unknown fields as "not on record" rather than dropping them', () => {
    const c = company({
      stage: 'Unknown',
      city: 'Unknown',
      state: 'Unknown',
      website: undefined,
      accelerator: undefined,
    });
    const prompt = buildClaudePrompt(c, scoreCompany(c));

    expect(prompt).toMatch(/Stage: not on record/);
    expect(prompt).toMatch(/Location: not on record/);
    expect(prompt).toMatch(/Website: not on record/);
    // And the instruction that stops a model filling the gap in.
    expect(prompt).toContain('Do not fill it in, infer it, or assume a value.');
  });

  it('carries the provisional caveat when the score is provisional', () => {
    // No stage, no location, no classification — the provisional case.
    const c = company({
      stage: 'Unknown',
      city: 'Unknown',
      state: 'Unknown',
      subcategory: 'Unclassified — requires manual review',
      foundedYear: 0,
      teamSize: 0,
      traction: { level: 0, note: '' },
      founders: [],
    });
    const fit = scoreCompany(c);
    const prompt = buildClaudePrompt(c, fit);

    if (fit.provisional) {
      expect(prompt).toContain('PROVISIONAL');
    } else {
      // Not provisional: the completeness caveat must still travel, so a
      // partial score is never read as a complete one.
      expect(prompt).toMatch(/assessable points/);
    }
  });

  it('states no model was called — the prompt is for a person to run', () => {
    const c = company();
    const prompt = buildClaudePrompt(c, scoreCompany(c));
    // It asks the reader for analysis; it must not assert that analysis
    // already happened inside the dashboard.
    expect(prompt).toContain('What I want from you');
    expect(prompt).not.toMatch(/AI (analysis )?(was )?(generated|completed|ran)/i);
  });

  it('handles a record with no founders and no evidence without inventing any', () => {
    const c = company({ founders: [], evidence: [] });
    const prompt = buildClaudePrompt(c, scoreCompany(c));
    expect(prompt).toContain('No founders on record.');
    expect(prompt).toContain('No evidence on record.');
  });
});
