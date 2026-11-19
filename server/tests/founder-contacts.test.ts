import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { getCompany, saveCompany, saveFounderContacts } from '../db/repos/companies';
import { runEnrichment } from '../services/enrichment';
import { clearPolitenessCacheForTests } from '../sourcing/politeness';
import { importedCompanySchema, PLACEHOLDER_FOUNDED_YEAR, type ImportedCompany } from '../services/imports';
import {
  approveEmailIntakeCandidate, submitEmailIntakeBatch, updateEmailIntakeCandidate,
} from '../services/emailIntake';
import { publishedContactsFor } from '../enrichment/founderExtraction';
import {
  emailMatchesName, linkedInMatchesName, normalizeEmail, normalizeLinkedInUrl,
} from '../../shared/founderContact';
import { RADAR_HUBSPOT_STAGES } from '../../shared/integrations';
import { MockHubSpot } from './mocks/hubspot';
import { SCHEDULING_WIZARD } from './fixtures/ycProfiles';

/**
 * Founder emails and LinkedIn profiles used to be thrown away at every
 * step (Andrew, 2026-11-19): research parsed YC LinkedIn links and dropped
 * them, email/spreadsheet extraction had no field for them, the founders
 * table's contact columns were never written, and what a reviewer typed in
 * "Add to HubSpot" was never kept. These pin each path that now keeps
 * them — and that nothing is guessed, malformed, or overwritten.
 */

beforeEach(() => {
  clearPolitenessCacheForTests();
  store.resetForTests();
  resetDbForTests();
});
afterEach(() => vi.unstubAllGlobals());

function company(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'co-1', name: 'Acme Health', oneLiner: 'Remote patient monitoring.',
    vertical: 'health', subcategory: 'Remote patient monitoring',
    stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2022, teamSize: 5,
    website: 'https://acmehealth.com',
    traction: { level: 3, note: 'Two pilots.' },
    founders: [{ name: 'Jane Doe', role: 'CEO', background: 'Former product lead.' }],
    evidence: [{ claim: 'Pilots announced.', source: 'Acme', url: 'https://acmehealth.com/news', date: '2026-11-01', type: 'News' }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany;
}

describe('contact value checks', () => {
  it('accepts real addresses and profile URLs, rejects everything else', () => {
    expect(normalizeEmail(' Jane@AcmeHealth.com ')).toBe('jane@acmehealth.com');
    expect(normalizeEmail('mailto:jane@acmehealth.com')).toBe('jane@acmehealth.com');
    expect(normalizeEmail('jane at acmehealth dot com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeLinkedInUrl('linkedin.com/in/jane-doe-4a1b/')).toBe('https://www.linkedin.com/in/jane-doe-4a1b');
    expect(normalizeLinkedInUrl('https://uk.linkedin.com/in/janedoe?trk=x')).toBe('https://www.linkedin.com/in/janedoe');
    expect(normalizeLinkedInUrl('https://www.linkedin.com/company/acme')).toBeNull();
    expect(normalizeLinkedInUrl('https://twitter.com/in/janedoe')).toBeNull();
  });

  it('ties a profile or email to a person only by their name, never a generic inbox', () => {
    expect(linkedInMatchesName('https://www.linkedin.com/in/jane-doe-4a1b', 'Jane Doe')).toBe(true);
    expect(linkedInMatchesName('https://www.linkedin.com/in/john-smith', 'Jane Doe')).toBe(false);
    expect(emailMatchesName('jane.doe@acmehealth.com', 'Jane Doe', 'acmehealth.com')).toBe(true);
    expect(emailMatchesName('jdoe@acmehealth.com', 'Jane Doe', 'www.acmehealth.com')).toBe(true);
    expect(emailMatchesName('hello@acmehealth.com', 'Jane Doe', 'acmehealth.com')).toBe(false);
    expect(emailMatchesName('jane@gmail.com', 'Jane Doe', 'acmehealth.com')).toBe(false);
  });
});

describe('contacts a page publishes', () => {
  const page = `
    <div><h3>Jane Doe</h3><p>Co-Founder &amp; CEO</p><a href="https://www.linkedin.com/in/jane-doe-4a1b/">in</a></div>
    <div><h3>John Smith</h3><p>CTO</p><a href="https://www.linkedin.com/in/jsmith/">in</a></div>
    <a href="mailto:jane@acmehealth.com">Email Jane</a> <a href="mailto:hello@acmehealth.com">Contact</a>`;

  it('attributes a profile whose slug names the person, and a name-shaped email on the company site', () => {
    expect(publishedContactsFor(page, 'Jane Doe', { pageIsCompanySite: true, companyDomain: 'acmehealth.com' }))
      .toEqual({ linkedin: 'https://www.linkedin.com/in/jane-doe-4a1b', email: 'jane@acmehealth.com' });
  });

  it('leaves out what the page does not tie to the person by name', () => {
    // "jsmith" does not contain "john": not attributed, even though it sits in John's card.
    expect(publishedContactsFor(page, 'John Smith', { pageIsCompanySite: true, companyDomain: 'acmehealth.com' }))
      .toEqual({ linkedin: null, email: null });
  });

  it('never takes an email from a page that is not the company\'s own site', () => {
    expect(publishedContactsFor(page, 'Jane Doe', { pageIsCompanySite: false, companyDomain: 'acmehealth.com' }).email).toBeNull();
  });
});

describe('the founders table keeps contact details', () => {
  it('stores and returns email, its source, and LinkedIn', () => {
    saveCompany(company({
      founders: [{ name: 'Jane Doe', role: 'CEO', background: 'Former product lead.', email: 'jane@acmehealth.com', emailSource: 'Stated in Forwarded email', linkedin: 'https://www.linkedin.com/in/janedoe' }],
    }), { origin: 'user-entered', source: 'local-csv' });
    expect(getCompany('co-1')!.founders[0]).toMatchObject({
      email: 'jane@acmehealth.com', emailSource: 'Stated in Forwarded email', linkedin: 'https://www.linkedin.com/in/janedoe',
    });
  });

  it('a re-import without contact details keeps the ones already stored for the same person', () => {
    saveCompany(company({
      founders: [{ name: 'Jane Doe', role: 'CEO', background: 'Former product lead.', email: 'jane@acmehealth.com', emailSource: 'x', linkedin: 'https://www.linkedin.com/in/janedoe' }],
    }), { origin: 'user-entered', source: 'local-csv' });
    saveCompany(company(), { origin: 'user-entered', source: 'local-csv' });
    expect(getCompany('co-1')!.founders[0]).toMatchObject({ email: 'jane@acmehealth.com', linkedin: 'https://www.linkedin.com/in/janedoe' });
  });

  it('research fills only empty fields; a reviewer correction overwrites; no founder is ever created', () => {
    saveCompany(company(), { origin: 'user-entered', source: 'local-csv' });
    expect(saveFounderContacts('co-1', [{ name: 'Jane Doe', email: 'jane@acmehealth.com', source: 'research', overwrite: false }])).toBe(1);
    expect(saveFounderContacts('co-1', [{ name: 'Jane Doe', email: 'other@acmehealth.com', source: 'research', overwrite: false }])).toBe(0);
    expect(getCompany('co-1')!.founders[0].email).toBe('jane@acmehealth.com');
    expect(saveFounderContacts('co-1', [{ name: 'jane doe', email: 'jane.doe@acmehealth.com', source: 'reviewer', overwrite: true }])).toBe(1);
    expect(getCompany('co-1')!.founders[0]).toMatchObject({ email: 'jane.doe@acmehealth.com', emailSource: 'reviewer' });
    expect(saveFounderContacts('co-1', [{ name: 'Someone Else', email: 'se@acmehealth.com', source: 'reviewer', overwrite: true }])).toBe(0);
    expect(getCompany('co-1')!.founders).toHaveLength(1);
  });
});

describe('email and spreadsheet imports keep stated contacts', () => {
  const reply = JSON.stringify({ candidates: [{
    name: 'Acme Health', vertical: 'health', quote: 'Piloting with two hospital systems.',
    founders: [
      { name: 'Jane Doe', role: 'CEO', email: 'Jane@AcmeHealth.com', linkedin: 'linkedin.com/in/janedoe' },
      { name: 'Raj Patel', role: 'CTO', email: 'raj at acme', linkedin: 'https://www.linkedin.com/company/acme' },
    ],
  }] });

  function approveWithForwarder(id: number, extracted: Record<string, unknown>) {
    const evidence = [{ ...(extracted.evidence as Record<string, unknown>[])[0], url: 'Forwarded by Valeria Martinez; 11/19/2026' }];
    expect(updateEmailIntakeCandidate(id, importedCompanySchema.partial().parse({ evidence })).ok).toBe(true);
    return approveEmailIntakeCandidate(id, 'test-reviewer');
  }

  it('records a well-formed email/LinkedIn with where it was stated, and drops malformed ones', () => {
    const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
    const founders = candidates[0].extracted.founders as Record<string, unknown>[];
    // Malformed values never even reach the review queue.
    expect(founders[1]).not.toHaveProperty('email');
    expect(founders[1]).not.toHaveProperty('linkedin');

    const result = approveWithForwarder(candidates[0].id, candidates[0].extracted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [jane, raj] = getCompany(result.companyId)!.founders;
    expect(jane).toMatchObject({ email: 'jane@acmehealth.com', linkedin: 'https://www.linkedin.com/in/janedoe' });
    expect(jane.emailSource).toBe('Stated in Forwarded email — Forwarded by Valeria Martinez; 11/19/2026');
    expect(raj.email).toBeUndefined();
    expect(raj.linkedin).toBeUndefined();
  });

  it('a review-card save carrying a reviewer-edited email/LinkedIn passes the PATCH schema and is kept on approve', () => {
    const { candidates } = submitEmailIntakeBatch({ reply, submittedBy: 'test-reviewer' });
    const c = candidates[0];
    // The shape src/lib/emailIntakeDraft.ts patchFrom sends (tested there).
    const patch = importedCompanySchema.partial().parse({
      founders: [
        { name: 'Jane Doe', role: 'CEO', background: 'Not on record.', email: 'jane@acmehealth.com', linkedin: 'https://www.linkedin.com/in/jane-doe-edited' },
        { name: 'Raj Patel', role: 'CTO', background: 'Not on record.' },
      ],
      evidence: [{ ...(c.extracted.evidence as Record<string, unknown>[])[0], url: 'Forwarded by Valeria Martinez; 11/19/2026' }],
    });
    expect(updateEmailIntakeCandidate(c.id, patch).ok).toBe(true);
    const result = approveEmailIntakeCandidate(c.id, 'test-reviewer');
    if (!result.ok) throw new Error(result.error);
    expect(getCompany(result.companyId)!.founders[0]).toMatchObject({
      email: 'jane@acmehealth.com', linkedin: 'https://www.linkedin.com/in/jane-doe-edited',
    });
  });
});

describe('research keeps the LinkedIn links on a YC profile', () => {
  const YC_URL = 'https://www.ycombinator.com/companies/scheduling-wizard';

  function stubYcProfile() {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('ycombinator.com/companies/scheduling-wizard')) {
        return { ok: true, status: 200, text: async () => SCHEDULING_WIZARD, headers: new Headers() } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found', headers: new Headers() } as unknown as Response;
    }));
  }

  function lead(founders: ImportedCompany['founders']): ImportedCompany {
    return company({
      id: 'sw-1', name: 'Scheduling Wizard', oneLiner: 'Healthcare logistics infrastructure.',
      subcategory: 'Healthcare infrastructure', stage: 'Unknown', city: 'Unknown', state: '??',
      foundedYear: PLACEHOLDER_FOUNDED_YEAR, teamSize: 1, website: 'https://www.schedulingwiz.com',
      traction: { level: 0, note: 'Unknown — not yet researched' },
      founders,
      evidence: [{ claim: 'Listed in the Y Combinator public directory', source: 'Y Combinator', url: YC_URL, date: '2026-11-18', type: 'Database record' }],
    });
  }

  it('saves each verified founder\'s profile when research names the team', async () => {
    saveCompany(lead([{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }]),
      { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'city', 'state'] });
    stubYcProfile();
    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    const byName = Object.fromEntries(getCompany('sw-1')!.founders.map((f) => [f.name, f.linkedin]));
    expect(byName['Samuel Oberly']).toBe('https://www.linkedin.com/in/samueloberly');
    expect(byName['Zachary Dermody']).toBe('https://www.linkedin.com/in/zacharydermody');
  });

  it('attaches the profile to a founder an import already named, without replacing them', async () => {
    saveCompany(lead([{ name: 'Samuel Oberly', role: 'Founder', background: 'Named in the forwarded email.' }]),
      { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'city', 'state'] });
    stubYcProfile();
    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    const founders = getCompany('sw-1')!.founders;
    expect(founders).toHaveLength(1);
    expect(founders[0]).toMatchObject({ name: 'Samuel Oberly', background: 'Named in the forwarded email.', linkedin: 'https://www.linkedin.com/in/samueloberly' });
  });

  it('never overwrites a LinkedIn already on record', async () => {
    saveCompany(lead([{ name: 'Samuel Oberly', role: 'Founder', background: 'Named in the forwarded email.', linkedin: 'https://www.linkedin.com/in/sam-reviewer-entered' }]),
      { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'city', 'state'] });
    stubYcProfile();
    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });
    expect(getCompany('sw-1')!.founders[0].linkedin).toBe('https://www.linkedin.com/in/sam-reviewer-entered');
  });
});

describe('Add to HubSpot keeps what the reviewer typed', () => {
  it('saves a typed email and LinkedIn onto the matching founder, ignoring malformed values', async () => {
    const { createApp } = await import('../app');
    const { adminAgent } = await import('./testAuth');
    const { __setHubSpotServiceForTests } = await import('../services/hubspot');
    const { setConfig } = await import('../db/repos/operations');
    __setHubSpotServiceForTests(new MockHubSpot());
    const agent = await adminAgent(createApp());
    setConfig('hubspot-pipeline-mapping', {
      stages: Object.fromEntries(RADAR_HUBSPOT_STAGES.map((st) => [st, { pipelineId: 'p-1', stageId: 's-1' }])),
    });
    saveCompany(company({
      founders: [
        { name: 'Jane Doe', role: 'CEO', background: 'Former product lead.' },
        { name: 'Raj Patel', role: 'CTO', background: 'Engineer.' },
      ],
    }), { origin: 'user-entered', source: 'local-csv' });

    const contact = (firstName: string, lastName: string, email: string | null, linkedinUrl: string | null) => ({
      firstName, lastName, email, jobTitle: 'Founder', linkedinUrl, companyName: 'Acme Health',
      infoSource: 'Deal Radar', verificationStatus: email ? 'Verified' : 'Unverified', lastOutreachDate: null, demographics: [],
    });
    const res = await agent.post('/api/hubspot/sync-company').send({
      company: {
        dealRadarId: 'co-1', name: 'Acme Health', domain: 'acmehealth.com', website: 'https://acmehealth.com',
        industry: 'Health & Wellness', city: 'Austin', state: 'TX', description: 'A company.', dealRadarUrl: 'https://radar.local/co-1',
      },
      contacts: [
        contact('Jane', 'Doe', 'jane@acmehealth.com', 'linkedin.com/in/janedoe'),
        contact('Raj', 'Patel', null, 'https://example.com/raj'),
      ],
      deal: {
        companyName: 'Acme Health', fitScore: 7, recommendation: 'Track', vertical: 'Health & Wellness',
        stage: 'Seed', scoreBreakdown: [], rationale: 'x', risks: '', sourceEvidence: [], reviewer: null,
        evidenceQualityScore: 5, policyException: '', sourcingStatus: 'Approved to Track',
        dateSurfaced: '2026-11-19', relationshipOwner: '', dealRadarId: 'co-1', dealRadarUrl: 'https://radar.local/co-1',
      },
      radarStage: 'To Be Reviewed',
      duplicateResolution: 'create-new',
      existingRecordId: null,
    });
    __setHubSpotServiceForTests(null);

    expect(res.status).toBe(200);
    const [jane, raj] = getCompany('co-1')!.founders;
    expect(jane).toMatchObject({ email: 'jane@acmehealth.com', linkedin: 'https://www.linkedin.com/in/janedoe' });
    expect(jane.emailSource).toMatch(/^Entered by .+ in Add to HubSpot on \d{4}-\d{2}-\d{2}$/);
    expect(raj.email).toBeUndefined();
    expect(raj.linkedin).toBeUndefined();
    // The raw columns, not just the view.
    expect(getDb().prepare('SELECT COUNT(*) n FROM founders WHERE email IS NOT NULL').get()).toEqual({ n: 1 });
  });
});
