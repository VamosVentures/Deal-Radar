import { describe, expect, it } from 'vitest';
import { emailGenerator, factGuardIssues, validateGeneratedEmail } from '../services/ai';
import type { EmailGenContext } from '../../shared/integrations';

const context = (over: Partial<EmailGenContext> = {}): EmailGenContext => ({
  companyId: 'c-solcare',
  companyName: 'SolCare Health',
  companyDescription: 'AI care-navigation for bilingual Medicaid populations.',
  vertical: 'Health & Wellness',
  subcategory: 'Personalized care (AI / tech-enabled)',
  whyFits: 'Direct match: Health & Wellness → Personalized care.',
  founderFirstName: 'Mariana',
  founderFullName: 'Mariana Otero',
  founderRole: 'CEO',
  founderEmail: 'mariana@solcarehealth.example.com',
  verifiedFounderDetail: 'Former VP Ops, Oscar Health; MPH UT Austin. (CEO)',
  recentMilestone: 'Closed pilot with Central Texas health plan (Company press release, 2026-04-10)',
  acceleratorOrFunding: '$3.5M seed',
  sourceLinks: [{ label: 'Company press release', url: 'https://example.com/solcare-pilot' }],
  senderName: 'Daniela Reyes',
  senderRole: 'Partner',
  tone: 'Warm and conversational',
  customInstructions: '',
  meetingAsk: 'a 25-minute intro call in the next two weeks',
  ...over,
});

describe('outreach email generation (Demo Mode template)', () => {
  it('generates subject, body, rationale, and sources from verified facts', async () => {
    const email = await emailGenerator().generateOutreachEmail(context());
    expect(email.demo).toBe(true);
    expect(email.subject).toContain('SolCare Health');
    expect(email.body).toContain('Mariana');
    expect(email.body).toContain('Oscar Health'); // verified detail used
    expect(email.body).toContain('Central Texas'); // sourced milestone used
    expect(email.rationale.length).toBeGreaterThan(10);
    expect(email.sources).toHaveLength(1);
    expect(email.weakEvidence).toBe(false);
  });

  it('is deterministic for the same context', async () => {
    const a = await emailGenerator().generateOutreachEmail(context());
    const b = await emailGenerator().generateOutreachEmail(context());
    expect(a.subject).toBe(b.subject);
    expect(a.body).toBe(b.body);
  });

  it('varies with tone', async () => {
    const warm = await emailGenerator().generateOutreachEmail(context({ tone: 'Warm and conversational' }));
    const formal = await emailGenerator().generateOutreachEmail(context({ tone: 'Formal' }));
    expect(warm.body).not.toBe(formal.body);
    expect(formal.subject).toContain('introduction');
  });

  it('warns on weak evidence and uses honest general wording when facts are missing', async () => {
    const email = await emailGenerator().generateOutreachEmail(context({
      verifiedFounderDetail: null,
      recentMilestone: null,
      acceleratorOrFunding: null,
      sourceLinks: [],
    }));
    expect(email.weakEvidence).toBe(true);
    expect(email.warnings.length).toBeGreaterThanOrEqual(2);
    // honest wording, not a fabricated milestone or background
    expect(email.body).toContain("won't pretend to know more about your journey");
    expect(email.body).not.toMatch(/\$\d/);
    expect(email.body.toLowerCase()).not.toContain('congrats');
  });

  it('handles missing sources with an explicit warning', async () => {
    const email = await emailGenerator().generateOutreachEmail(context({ sourceLinks: [] }));
    expect(email.warnings.join(' ')).toMatch(/no supporting source links/i);
    expect(email.sources).toHaveLength(0);
  });

  it('regenerate applies custom instructions through the same guarded path', async () => {
    const email = await emailGenerator().regenerateOutreachEmail(context(), 'Keep it under 100 words.');
    expect(email.body).toContain('Keep it under 100 words.'); // template carries it as a visible P.S.
    expect(email.demo).toBe(true);
  });

  it('explainPersonalizationSources lists the facts used', () => {
    const gen = emailGenerator();
    const lines = gen.explainPersonalizationSources(context());
    expect(lines.join(' ')).toContain('Oscar Health');
    const noFacts = gen.explainPersonalizationSources(context({ verifiedFounderDetail: null, recentMilestone: null }));
    expect(noFacts.join(' ')).toMatch(/general and honest/i);
  });
});

describe('fact guard — the AI may not invent facts', () => {
  it('flags invented funding amounts', () => {
    const issues = factGuardIssues(
      context({ acceleratorOrFunding: null }),
      'Congrats on the $12M round',
      'I saw you raised $12M — impressive.',
    );
    expect(issues.some((i) => i.includes('$12m') || i.includes('$12M'.toLowerCase()) || /\$\s?12m/i.test(i))).toBe(true);
  });

  it('allows amounts that ARE in the provided facts', () => {
    const issues = factGuardIssues(
      context(), // includes "$3.5M seed"
      'Your $3.5M seed',
      'Saw the $3.5M seed round in the filing.',
    );
    expect(issues).toHaveLength(0);
  });

  it('flags invented accelerator participation', () => {
    const issues = factGuardIssues(
      context(),
      'Fellow Techstars company',
      'Since you went through Techstars, …',
    );
    expect(issues.some((i) => i.toLowerCase().includes('techstars'))).toBe(true);
  });

  it('flags invented traction/customer claims', () => {
    const issues = factGuardIssues(
      context(),
      'Impressive growth',
      'Your customers include three Fortune 500 payers.',
    );
    expect(issues.some((i) => /traction claim/i.test(i))).toBe(true);
  });

  it('validateGeneratedEmail rejects a fabricated email with a 422', () => {
    expect(() =>
      validateGeneratedEmail(context({ acceleratorOrFunding: null }), {
        subject: 'Congrats on the $12M!',
        body: 'Hi Mariana — congrats on raising $12M from Techstars. Impressive revenue of $2M ARR. Would love to chat about it all sometime soon.',
        rationale: 'made up',
        sources: [],
        weakEvidence: false,
        warnings: [],
        demo: false,
      }),
    ).toThrowError(/fact validation/i);
  });
});
