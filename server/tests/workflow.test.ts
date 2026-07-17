import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';

/**
 * The main workflow, exactly as the product requires it — every
 * external step is explicit, human-initiated, and Demo-Mode-labeled:
 *
 *  1. Open a surfaced company        7. Generate an outreach email
 *  2. Approve it for HubSpot         8. Edit the email
 *  3. Run duplicate detection        9. Save it as an Outlook draft
 *  4. Add the company               10. Outreach Pipeline updated
 *  5. Create founder contacts      11. Activity logged to HubSpot
 *  6. Create + associate the deal  12. Set a follow-up date
 */

const company = {
  name: 'SolCare Health',
  domain: 'solcarehealth.example.com',
  website: 'https://solcarehealth.example.com',
  city: 'Austin', state: 'TX', country: 'United States',
  description: 'AI care-navigation for bilingual Medicaid populations.',
  vertical: 'Health & Wellness', subcategory: 'Personalized care (AI / tech-enabled)',
  stage: 'Seed', accelerator: null, fundingRaised: '$3.5M seed',
  dateFirstSurfaced: '2026-04-12', lastRefreshed: '2026-07-14',
  primarySource: 'Company press release', policyException: null,
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
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
  scoreBreakdown: [{ label: 'Thesis / vertical fit', points: 25, max: 25 }],
  rationale: 'Direct thesis match.', risks: 'None flagged.',
  evidenceQualityScore: 8, policyException: null,
  sourcingStatus: 'Surfaced by Deal Radar', dateSurfaced: '2026-04-12',
  nextAction: 'Approve outreach', relationshipOwner: 'DR',
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
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

describe('main workflow (mock mode, end to end over HTTP)', () => {
  beforeEach(() => {
    store.resetForTests();
    resetIdempotencyForTests();
  });

  it('runs all 12 steps', async () => {
    const app = createApp();

    // 1–2. Surfaced company reviewed & approved → status endpoint shows Demo Mode honestly.
    const status = await request(app).get('/api/integrations/status');
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe('mock');
    expect(status.body.hubspot.detail).toContain('Local Mode');
    expect(status.body.statuses.hubspot.status).toBe('Local Mode');
    expect(status.body.statuses.refresh.status).toBe('Disconnected'); // no refresh run yet

    // 3. Duplicate detection — clean the first time.
    const dup1 = await request(app)
      .post('/api/hubspot/check-duplicate')
      .send({ name: 'SolCare Health', domain: 'solcarehealth.example.com' });
    expect(dup1.status).toBe(200);
    expect(dup1.body.matches).toHaveLength(0);

    // 4–6. Add company + founder contacts + deal, associated, in one reviewed submission.
    const sync = await request(app)
      .post('/api/hubspot/sync-company')
      .set('Idempotency-Key', 'wf-sync-1')
      .send({
        company, contacts: [contactMariana], deal,
        radarStage: 'Approved to Track', duplicateResolution: 'create-new', existingRecordId: null,
      });
    expect(sync.status).toBe(200);
    expect(sync.body.demo).toBe(true);
    expect(sync.body.message).toContain('Demo Mode');
    expect(sync.body.contactIds).toHaveLength(1);
    const dealObj = store.raw.mockHubSpot.find((o) => o.id === sync.body.dealId)!;
    expect(dealObj.associations).toContain(sync.body.companyId);

    // Duplicate detection now finds the record (would prompt the user in the UI).
    const dup2 = await request(app)
      .post('/api/hubspot/check-duplicate')
      .send({ name: 'SolCare Health, Inc.', domain: 'https://www.solcarehealth.example.com' });
    expect(dup2.body.matches).toHaveLength(1);
    expect(dup2.body.matches[0].matchedOn).toBe('domain');

    // 7. Generate an outreach email (Demo Mode template, fact-guarded).
    const gen = await request(app).post('/api/outreach/generate').send(genContext);
    expect(gen.status).toBe(200);
    expect(gen.body.demo).toBe(true);
    expect(gen.body.body).toContain('Mariana');
    expect(gen.body.weakEvidence).toBe(false);

    // 8. Human edits the email.
    const editedSubject = `${gen.body.subject} — edited by DR`;
    const editedBody = `${gen.body.body}\n\nP.S. Edited by a human before saving.`;

    // 9. Save as an Outlook draft (the ONLY email action; connect first).
    await request(app).post('/api/outlook/connect').send({});
    const draft = await request(app)
      .post('/api/outlook/drafts')
      .set('Idempotency-Key', 'wf-draft-1')
      .send({
        companyId: 'c-solcare',
        to: 'mariana@solcarehealth.example.com',
        subject: editedSubject,
        body: editedBody,
        senderName: 'Daniela Reyes',
        tone: 'Warm and conversational',
      });
    expect(draft.status).toBe(200);
    expect(draft.body.demo).toBe(true);
    expect(draft.body.message).toContain('Demo Mode');
    expect(draft.body.outlookDraftId).toBeTruthy();
    // Draft identifier stored on the backend:
    expect(store.raw.drafts).toHaveLength(1);
    expect(store.raw.drafts[0].subject).toBe(editedSubject);

    // 10. Outreach Pipeline updated — status, dates, sender, subject all logged.
    const records = await request(app).get('/api/outreach/records');
    const rec = records.body.records.find((r: { companyId: string }) => r.companyId === 'c-solcare');
    expect(rec.outreachStatus).toBe('Saved to Outlook');
    expect(rec.draftSubject).toBe(editedSubject);
    expect(rec.draftCreatedAt).toBeTruthy();
    expect(rec.hubspotStatus).toBe('Added');
    const draftActivity = rec.activities.find((a: { kind: string }) => a.kind === 'draft-created');
    expect(draftActivity.actor).toBe('Daniela Reyes');
    // No auto-send: the record explicitly waits for a human.
    expect(rec.emailSentAt).toBeNull();
    expect(rec.nextAction.toLowerCase()).toContain('send it yourself');

    // 11. Log activity to HubSpot (simulated note, associated with the company).
    const log = await request(app)
      .post('/api/hubspot/log-activity')
      .set('Idempotency-Key', 'wf-log-1')
      .send({ companyId: 'c-solcare', note: 'Partner review complete; outreach approved.', actor: 'MG' });
    expect(log.status).toBe(200);
    expect(store.raw.mockHubSpot.some((o) => o.type === 'note')).toBe(true);

    // Human marks the email as sent (after sending it from Outlook themselves).
    const sent = await request(app)
      .post('/api/outreach/mark-sent')
      .set('Idempotency-Key', 'wf-sent-1')
      .send({ companyId: 'c-solcare', actor: 'DR' });
    expect(sent.body.outreachStatus).toBe('Manually Marked Sent');
    expect(sent.body.emailSentAt).toBeTruthy();

    // 12. Set a follow-up date.
    const due = new Date().toISOString().slice(0, 10);
    const fu = await request(app)
      .post('/api/outreach/follow-up')
      .send({ companyId: 'c-solcare', dueDate: due, note: 'Nudge if quiet', actor: 'DR' });
    expect(fu.status).toBe(200);
    const summary = await request(app).get('/api/outreach/records');
    expect(summary.body.followUps.dueToday.map((r: { companyId: string }) => r.companyId)).toContain('c-solcare');

    // Audit log captured the run without any secrets or bodies.
    const auditRes = await request(app).get('/api/audit');
    expect(auditRes.body.length).toBeGreaterThan(3);
    expect(JSON.stringify(auditRes.body)).not.toContain(editedBody.slice(0, 40));
  });

  it('blocks duplicate button submissions via Idempotency-Key', async () => {
    const app = createApp();
    const payload = {
      company, contacts: [], deal,
      radarStage: 'Approved to Track', duplicateResolution: 'create-new', existingRecordId: null,
    };
    const first = await request(app).post('/api/hubspot/sync-company').set('Idempotency-Key', 'double-click').send(payload);
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/hubspot/sync-company').set('Idempotency-Key', 'double-click').send(payload);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_submission');
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'company')).toHaveLength(1);
  });

  it('rejects a sync payload whose demographics lack a source (guardrail over HTTP)', async () => {
    const app = createApp();
    const res = await request(app).post('/api/hubspot/sync-company').send({
      company, deal,
      contacts: [{ ...contactMariana, demographics: [{ indicator: 'Latino-led', basis: 'Self-identified', sourceName: 'n/a', sourceRef: 'x', verificationStatus: 'Self-reported' }] }],
      radarStage: 'Approved to Track', duplicateResolution: 'create-new', existingRecordId: null,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues.join(' ')).toMatch(/named source|source/i);
    expect(store.raw.mockHubSpot).toHaveLength(0); // nothing was written
  });

  it('draft saving without a recipient fails with a clear message', async () => {
    const app = createApp();
    await request(app).post('/api/outlook/connect').send({});
    const res = await request(app).post('/api/outlook/drafts').send({
      companyId: 'c-x', to: '', subject: 'Hello', body: 'Long enough body text here.', senderName: 'DR', tone: '—',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/recipient email/i);
  });
});
