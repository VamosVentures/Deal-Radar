import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import { listHubspotSyncHistory } from '../db/repos/operations';
import { saveCompany } from '../db/repos/companies';
import type { ImportedCompany } from '../services/imports';
import { installMockIntegrations, installTestPipelineMapping, uninstallMockIntegrations } from './mocks/install';
import { adminAgent } from './testAuth';

/**
 * The screening workflow, end to end over HTTP. HubSpot stays the
 * system of record: the radar checks duplicates, syncs an approved
 * company once (idempotently), records the score + explanation +
 * reviewer + approval date + source URLs on the deal, and drafts
 * outreach for manual sending. There is no internal tracker.
 * Integrations here are in-memory TEST FIXTURES injected via
 * test-only hooks; the running app has no mock mode.
 */

const company = {
  name: 'SolCare Health',
  domain: 'solcarehealth.example.com',
  website: 'https://solcarehealth.example.com',
  city: 'Austin', state: 'TX', country: 'United States',
  description: 'AI care-navigation for bilingual Medicaid populations.',
  industry: 'Health & Wellness',
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
};

/**
 * A radar record for 'c-solcare' saved LOCALLY before every sync test,
 * matching how the app actually works: a company always exists in
 * Deal Radar's own DB (imported/discovered) before a human ever opens
 * the HubSpot sync modal for it. This is also what makes sync
 * idempotency work at all now — HubSpot itself carries no Deal-Radar
 * identifying property (see shared/integrations.ts's HubSpot section),
 * so performSync's "resync updates, never twins" guarantee comes
 * entirely from this locally-persisted hubspot_company_id/
 * hubspot_deal_id link (companyMetaView), not from anything HubSpot-side.
 */
const localCompanyRecord: ImportedCompany = {
  id: 'c-solcare', name: 'SolCare Health', oneLiner: 'AI care-navigation for bilingual Medicaid populations.',
  vertical: 'health', subcategory: 'Personalized care', stage: 'Seed',
  city: 'Austin', state: 'TX', foundedYear: 2022, teamSize: 6,
  website: 'https://solcarehealth.example.com',
  traction: { level: 5, note: 'Fixture traction.' },
  founders: [{ name: 'Mariana Otero', role: 'CEO', background: 'Former VP Ops, Oscar Health.' }],
  evidence: [{
    claim: 'Closed pilot with Central Texas health plan', source: 'Company press release',
    url: 'https://example.com/solcare-pilot', date: '2026-04-10', type: 'News',
  }],
  flags: [], imported: true,
};

const contactMariana = {
  firstName: 'Mariana', lastName: 'Otero', email: 'mariana@solcarehealth.example.com',
  jobTitle: 'CEO', linkedinUrl: 'https://linkedin.com/in/example-mariana-otero',
  companyName: 'SolCare Health', infoSource: 'Company press-release media contact',
  verificationStatus: 'Verified', relationshipOwner: 'DR', lastOutreachDate: null,
  demographics: [{
    indicator: 'Latino-led', basis: 'Self-identified',
    sourceName: 'Founder bio on company site, Jan 2026',
    sourceRef: 'https://solcarehealth.example.com/about',
    verificationStatus: 'Self-reported',
  }],
};

const deal = {
  companyName: 'SolCare Health', fitScore: 8.7, recommendation: 'Prioritize — strong thesis fit',
  vertical: 'Health & Wellness', stage: 'Seed',
  scoreBreakdown: [{ label: 'Thesis / vertical fit', points: 20, max: 20 }],
  rationale: 'Direct thesis match.', risks: 'None flagged.',
  evidenceQualityScore: 4, policyException: null,
  sourcingStatus: 'Surfaced by Deal Radar', dateSurfaced: '2026-04-12',
  nextAction: 'Approve outreach', relationshipOwner: 'DR',
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
  scoreExplanation: 'VamosVentures Fit Score 8.7/10 (87/100 points, model v3.0 (2026-07)).',
  approvedBy: 'DR', approvalDate: '2026-07-18',
  sourceUrls: ['https://example.com/solcare-pilot', 'https://example.com/formd/solcare'],
};

const genContext = {
  companyId: 'c-solcare', companyName: 'SolCare Health',
  companyDescription: 'AI care-navigation for bilingual Medicaid populations.',
  vertical: 'Health & Wellness', subcategory: 'Personalized care (AI / tech-enabled)',
  whyFits: 'Direct match: Health & Wellness → Personalized care.',
  founderFirstName: 'Mariana', founderFullName: 'Mariana Otero', founderRole: 'CEO',
  founderEmail: 'mariana@solcarehealth.example.com',
  verifiedFounderDetail: 'Former VP Ops, Oscar Health; MPH UT Austin. (CEO)',
  recentMilestone: 'Closed pilot with Central Texas health plan (Company press release, 2026-04-10)',
  acceleratorOrFunding: '$3.5M seed',
  sourceLinks: [{ label: 'Company press release', url: 'https://example.com/solcare-pilot' }],
  senderName: 'Daniela Reyes', senderRole: 'Partner',
  tone: 'Warm and conversational', customInstructions: '',
  meetingAsk: 'a 25-minute intro call in the next two weeks',
};

const syncPayload = () => ({
  company, contacts: [contactMariana], deal,
  radarStage: 'Approved to Track', duplicateResolution: 'create-new', existingRecordId: null,
});

describe('screening workflow (fixture integrations, end to end over HTTP)', () => {
  // Every /api route now requires an authenticated session (see the
  // gate in server/app.ts), so the whole workflow runs through one
  // signed-in agent rather than bare `request(app)` calls.
  let app: Express;
  let agent: Awaited<ReturnType<typeof adminAgent>>;

  beforeEach(async () => {
    store.resetForTests();
    resetIdempotencyForTests();
    installMockIntegrations();
    installTestPipelineMapping();
    saveCompany(localCompanyRecord, { origin: 'user-entered', source: 'test' });
    app = createApp();
    agent = await adminAgent(app);
  });
  afterAll(() => uninstallMockIntegrations());

  it('checks duplicates, syncs once, records everything, and drafts for manual sending', async () => {
    // Status reflects the fixtures (Connected appears only after a verified check).
    const status = await agent.get('/api/integrations/status');
    expect(status.body.statuses.hubspot.status).toBe('Connected');
    expect(status.body.statuses.hubspot.detail).toContain('Test fixture');

    // Duplicate check — clean the first time.
    const dup1 = await agent
      .post('/api/hubspot/check-duplicate')
      .send({ name: 'SolCare Health', domain: 'solcarehealth.example.com' });
    expect(dup1.body.matches).toHaveLength(0);

    // Approved sync: company + contact + deal with score, explanation, reviewer, approval date, source URLs.
    const sync = await agent
      .post('/api/hubspot/sync-company').set('Idempotency-Key', 'wf-sync-1').send(syncPayload());
    expect(sync.status).toBe(200);
    expect(sync.body.contactIds).toHaveLength(1);

    const dealObj = store.raw.mockHubSpot.find((o) => o.id === sync.body.dealId)!;
    expect(dealObj.associations).toContain(sync.body.companyId);

    // Everything with no property home (fit score, score explanation,
    // reviewer, approval date, source URLs) lands in the sync Note
    // instead — never a vamos_* property on the deal itself.
    const noteObj = store.raw.mockHubSpot.find((o) => o.type === 'note' && o.associations.includes(dealObj.id))!;
    expect(String(noteObj.properties.hs_note_body)).toContain('8.7/10');
    expect(String(noteObj.properties.hs_note_body)).toContain('model v3.0');
    expect(String(noteObj.properties.hs_note_body)).toContain('Approved by DR on 2026-07-18');
    expect(String(noteObj.properties.hs_note_body)).toContain('https://example.com/solcare-pilot');

    // Synchronization success recorded durably.
    const history = listHubspotSyncHistory('c-solcare');
    expect(history[0].outcome).toBe('ok');
    expect(history[0].hubspotCompanyId).toBe(sync.body.companyId);

    // Founder email matches surface too.
    const dup3 = await agent
      .post('/api/hubspot/check-duplicate')
      .send({ name: 'Zzz Unrelated', domain: null, founderEmails: ['mariana@solcarehealth.example.com'] });
    expect(dup3.body.matches[0].matchedOn).toBe('founder-email');

    // Generate a draft (labeled local template) and save it to Outlook.
    const gen = await agent.post('/api/outreach/generate').send(genContext);
    expect(gen.status).toBe(200);
    expect(gen.body.body).toContain('Mariana');

    await agent.post('/api/outlook/connect').send({});
    const draft = await agent
      .post('/api/outlook/drafts').set('Idempotency-Key', 'wf-draft-1')
      .send({
        companyId: 'c-solcare',
        to: 'mariana@solcarehealth.example.com',
        subject: `${gen.body.subject} — edited by DR`,
        body: `${gen.body.body}\n\nP.S. Edited by a human before saving.`,
        senderName: 'Daniela Reyes',
        tone: 'Warm and conversational',
      });
    expect(draft.status).toBe(200);
    expect(draft.body.message).toContain('send it yourself'); // never sent automatically
    // Draft creation is recorded (id + link, no delivery simulation).
    const drafts = await agent.get('/api/outlook/drafts?companyId=c-solcare');
    expect(drafts.body.drafts).toHaveLength(1);
    expect(drafts.body.drafts[0].outlookDraftId).toBe(draft.body.outlookDraftId);
    expect(drafts.body.drafts[0].body).toBeUndefined(); // bodies never echoed in lists

    // Audit captured the run without any secrets or bodies.
    const auditRes = await agent.get('/api/audit');
    expect(auditRes.body.length).toBeGreaterThan(2);
    expect(JSON.stringify(auditRes.body)).not.toContain('P.S. Edited by a human');
  });

  it('sync is idempotent: repeated clicks and re-submissions never create duplicate companies or deals', async () => {
    // Same Idempotency-Key (double-click) → blocked outright.
    const first = await agent.post('/api/hubspot/sync-company').set('Idempotency-Key', 'double-click').send(syncPayload());
    expect(first.status).toBe(200);
    const second = await agent.post('/api/hubspot/sync-company').set('Idempotency-Key', 'double-click').send(syncPayload());
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_submission');

    // NEW key, same company (e.g. hours later, still create-new) → updates, never a twin.
    const third = await agent.post('/api/hubspot/sync-company').set('Idempotency-Key', 'later-resync').send(syncPayload());
    expect(third.status).toBe(200);
    expect(third.body.action).toBe('updated');
    expect(third.body.companyId).toBe(first.body.companyId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'company')).toHaveLength(1);
    // The deal is idempotent too — the HubSpot deal id from the first
    // sync is persisted against the radar record and reused, never
    // re-created on later syncs.
    expect(third.body.dealId).toBe(first.body.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);
  });

  it('a later Radar-stage change updates the same HubSpot deal\'s stage rather than creating a new deal', async () => {
    const first = await agent.post('/api/hubspot/sync-company')
      .set('Idempotency-Key', 'stage-1')
      .send({ ...syncPayload(), radarStage: 'Approved to Track' });
    expect(first.status).toBe(200);

    const second = await agent.post('/api/hubspot/sync-company')
      .set('Idempotency-Key', 'stage-2')
      .send({ ...syncPayload(), radarStage: 'Active Diligence' });
    expect(second.status).toBe(200);

    // Same company, same deal — only its stage moved.
    expect(second.body.companyId).toBe(first.body.companyId);
    expect(second.body.dealId).toBe(first.body.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'company')).toHaveLength(1);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);

    const dealObj = store.raw.mockHubSpot.find((o) => o.id === first.body.dealId)!;
    expect(dealObj.properties.dealstage).toBe('test-active-diligence');
  });

  it('rejects a sync payload whose demographics lack a source (guardrail over HTTP)', async () => {
    const res = await agent.post('/api/hubspot/sync-company').send({
      ...syncPayload(),
      contacts: [{ ...contactMariana, demographics: [{ indicator: 'Latino-led', basis: 'Self-identified', sourceName: 'n/a', sourceRef: 'x', verificationStatus: 'Self-reported' }] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues.join(' ')).toMatch(/named source|source/i);
    expect(store.raw.mockHubSpot).toHaveLength(0); // nothing was written
  });

  it('draft saving without a recipient fails with a clear message', async () => {
    await agent.post('/api/outlook/connect').send({});
    const res = await agent.post('/api/outlook/drafts').send({
      companyId: 'c-x', to: '', subject: 'Hello', body: 'Long enough body text here.', senderName: 'DR', tone: '—',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/recipient email/i);
  });
});
