import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import {
  buildCompanyProperties,
  buildContactProperties,
  buildDealProperties,
  HUBSPOT_OAUTH_SCOPES,
  hubspotService,
} from '../services/hubspot';
import { MockHubSpot } from './mocks/hubspot';
import type { Founder } from '../../src/types';
import {
  cleanJobTitle,
  hubspotContactRecordSchema,
  RADAR_HUBSPOT_STAGES,
  isSyncableContactName,
  normalizeCompanyName,
  normalizeDomain,
  type HubSpotCompanyRecord,
  type HubSpotContactRecord,
  type HubSpotDealRecord,
} from '../../shared/integrations';

const company = (over: Partial<HubSpotCompanyRecord> = {}): HubSpotCompanyRecord => ({
  name: 'SolCare Health',
  domain: 'solcarehealth.example.com',
  website: 'https://solcarehealth.example.com',
  city: 'Austin', state: 'TX', country: 'United States',
  description: 'AI care-navigation for bilingual Medicaid populations.',
  vertical: 'Health & Wellness', subcategory: 'Personalized care', stage: 'Seed',
  accelerator: null, fundingRaised: '$3.5M seed',
  dateFirstSurfaced: '2026-04-12', lastRefreshed: '2026-07-14',
  primarySource: 'Company press release',
  policyException: null,
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
  ...over,
});

const contact = (over: Partial<HubSpotContactRecord> = {}): HubSpotContactRecord => ({
  firstName: 'Mariana', lastName: 'Otero',
  email: 'mariana@solcarehealth.example.com',
  jobTitle: 'CEO', linkedinUrl: null, companyName: 'SolCare Health',
  infoSource: 'Company press-release media contact',
  verificationStatus: 'Verified', relationshipOwner: 'DR', lastOutreachDate: null,
  demographics: [],
  ...over,
});

const deal = (over: Partial<HubSpotDealRecord> = {}): HubSpotDealRecord => ({
  companyName: 'SolCare Health', fitScore: 8.7,
  recommendation: 'Prioritize — strong thesis fit',
  vertical: 'Health & Wellness', stage: 'Seed',
  scoreBreakdown: [{ label: 'Thesis / vertical fit', points: 25, max: 25 }],
  rationale: 'Direct thesis match.', risks: 'None flagged.',
  evidenceQualityScore: 8, policyException: null,
  sourcingStatus: 'Surfaced by Deal Radar', dateSurfaced: '2026-04-12',
  nextAction: 'Approve outreach', relationshipOwner: 'DR',
  dealRadarId: 'c-solcare', dealRadarUrl: 'http://localhost:5173/?company=c-solcare',
  scoreExplanation: 'VamosVentures Fit Score 8.7/10 (test fixture explanation).',
  approvedBy: 'DR', approvalDate: '2026-07-18',
  sourceUrls: ['https://example.com/solcare-pilot'],
  ...over,
});

beforeEach(() => store.resetForTests());

describe('normalization', () => {
  it('normalizes domains from URLs and www forms', () => {
    expect(normalizeDomain('https://www.SolCareHealth.example.com/about?x=1')).toBe('solcarehealth.example.com');
    expect(normalizeDomain('solcarehealth.example.com')).toBe('solcarehealth.example.com');
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
  });
  it('normalizes company names (suffixes, punctuation, case)', () => {
    expect(normalizeCompanyName('SolCare Health, Inc.')).toBe('solcare health');
    expect(normalizeCompanyName('CUADRILLA LLC')).toBe('cuadrilla');
  });
});

describe('duplicate detection (in-memory fixture)', () => {
  it('matches by normalized domain first', async () => {
    const svc = new MockHubSpot();
    await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    const matches = await svc.checkDuplicate({ name: 'Totally Different Name', domain: 'https://WWW.solcarehealth.example.com/' });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedOn).toBe('domain');
    expect(matches[0].demo).toBe(true);
    expect(matches[0].url).toBeNull(); // fixtures never fabricate a HubSpot link
  });

  it('falls back to normalized name when no domain matches', async () => {
    const svc = new MockHubSpot();
    await svc.syncCompany({
      company: company({ domain: null, website: null }), contacts: [], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    const matches = await svc.checkDuplicate({ name: 'solcare health, inc', domain: null });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedOn).toBe('name');
  });

  it('returns no matches for an unknown company', async () => {
    const matches = await new MockHubSpot().checkDuplicate({ name: 'Nunca Vista', domain: 'nuncavista.example.com' });
    expect(matches).toHaveLength(0);
  });

  it('update-existing updates the record instead of creating a duplicate', async () => {
    const svc = new MockHubSpot();
    const first = await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    const second = await svc.syncCompany({
      company: company({ description: 'Updated description' }), contacts: [], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'update-existing', existingRecordId: first.companyId, existingDealId: null,
    });
    expect(second.action).toBe('updated');
    expect(second.companyId).toBe(first.companyId);
    const companies = store.raw.mockHubSpot.filter((o) => o.type === 'company');
    expect(companies).toHaveLength(1);
    expect(companies[0].properties.description).toBe('Updated description');
    // The deal is idempotent too: found via vamos_deal_radar_id and
    // updated in place, never duplicated.
    expect(second.dealId).toBe(first.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);
  });
});

describe('payload builders', () => {
  it('builds the full company payload', () => {
    const p = buildCompanyProperties(company({ policyException: 'DeFi-adjacent' }));
    expect(p.name).toBe('SolCare Health');
    expect(p.domain).toBe('solcarehealth.example.com');
    expect(p.vamos_vertical).toBe('Health & Wellness');
    expect(p.vamos_funding_raised).toBe('$3.5M seed');
    expect(p.vamos_policy_exception).toBe('DeFi-adjacent');
    expect(p.vamos_deal_radar_id).toBe('c-solcare');
  });

  it('builds contact payload with verified demographics serialized with basis + source', () => {
    const p = buildContactProperties(contact({
      demographics: [{
        indicator: 'Latino-led', basis: 'Self-identified',
        sourceName: 'Founder bio on company site, Jan 2026',
        sourceRef: 'https://solcarehealth.example.com/about',
        verificationStatus: 'Self-reported',
      }],
    }));
    expect(p.firstname).toBe('Mariana');
    expect(p.vamos_verified_demographics).toContain('Latino-led');
    expect(p.vamos_verified_demographics).toContain('Self-identified');
    expect(p.vamos_verified_demographics).toContain('Founder bio on company site');
  });

  it('leaves demographics null when none are verified — never inferred', () => {
    const p = buildContactProperties(contact());
    expect(p.vamos_verified_demographics).toBeNull();
  });

  it('builds deal payload preserving score breakdown and policy exception', () => {
    const p = buildDealProperties(deal({ policyException: 'Hardware-heavy — partner sign-off required' }), 'stage-1', 'pipe-1');
    expect(p.dealstage).toBe('stage-1');
    expect(p.pipeline).toBe('pipe-1');
    expect(p.vamos_fit_score).toBe(8.7);
    expect(p.vamos_score_breakdown).toContain('Thesis / vertical fit: 25/25');
    expect(p.vamos_policy_exception).toContain('Hardware-heavy');
  });

  it('records reviewer, approval date, score explanation, and source URLs on the deal', () => {
    const p = buildDealProperties(deal(), 's', 'p');
    expect(p.vamos_reviewer).toBe('DR');
    expect(p.vamos_approval_date).toBe('2026-07-18');
    expect(p.vamos_score_explanation).toContain('VamosVentures Fit Score');
    expect(p.vamos_source_urls).toContain('https://example.com/solcare-pilot');
  });
});

describe('identity guardrails', () => {
  it('rejects demographic claims without a named source', () => {
    const bad = contact({
      demographics: [{
        indicator: 'Latino-led', basis: 'Self-identified',
        sourceName: 'n/a', // too short — no real source
        sourceRef: 'https://example.com/x',
        verificationStatus: 'Self-reported',
      }],
    });
    expect(() => hubspotContactRecordSchema.parse(bad)).toThrow();
  });

  it('rejects demographic claims without a source URL/identifier', () => {
    const bad = contact({
      demographics: [{
        indicator: 'Female-led', basis: 'Verified public statement',
        sourceName: 'TechCrunch profile, Apr 2026',
        sourceRef: '', verificationStatus: 'Verified',
      }],
    });
    expect(() => hubspotContactRecordSchema.parse(bad)).toThrow();
  });

  it('rejects demographic claims with an invalid basis', () => {
    const bad = contact({
      demographics: [{
        // @ts-expect-error — deliberately invalid basis
        basis: 'Looked Latino to the analyst',
        indicator: 'Latino-led',
        sourceName: 'Analyst guess', sourceRef: 'none', verificationStatus: 'Verified',
      }],
    });
    expect(() => hubspotContactRecordSchema.parse(bad)).toThrow();
  });

  it('accepts a fully-sourced demographic claim', () => {
    const good = contact({
      demographics: [{
        indicator: 'Latino-led', basis: 'Verified public statement',
        sourceName: 'TechCrunch profile, Apr 2026',
        sourceRef: 'https://techcrunch.example.com/remisa',
        verificationStatus: 'Verified',
      }],
    });
    expect(() => hubspotContactRecordSchema.parse(good)).not.toThrow();
  });
});

describe('service resolution (production path)', () => {
  it('throws an honest not-connected error when no credentials exist', () => {
    expect(() => hubspotService()).toThrowError(/not connected/i);
    try {
      hubspotService();
    } catch (e) {
      expect((e as { status?: number }).status).toBe(503);
      expect((e as { hint?: string }).hint).toMatch(/HUBSPOT_ACCESS_TOKEN/);
    }
  });
});

describe('fixture behavior (tests only)', () => {
  it('labels results as demo and never claims a real action', async () => {
    const res = await new MockHubSpot().syncCompany({
      company: company(), contacts: [contact()], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    expect(res.demo).toBe(true);
    expect(res.message).toContain('Test fixture');
    expect(res.message.toLowerCase()).toContain('no real');
    expect(res.companyUrl).toBeNull();
  });

  it('deduplicates mock contacts by email across syncs', async () => {
    const svc = new MockHubSpot();
    const args = {
      company: company(), contacts: [contact()], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new' as const, existingRecordId: null, existingDealId: null,
    };
    await svc.syncCompany(args);
    await svc.syncCompany(args);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'contact')).toHaveLength(1);
  });

  it('a repeated sync-company call results in exactly one company, one deal, and one contact', async () => {
    const svc = new MockHubSpot();
    const args = {
      company: company(), contacts: [contact()], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new' as const, existingRecordId: null, existingDealId: null,
    };
    const first = await svc.syncCompany(args);
    const second = await svc.syncCompany(args);
    expect(second.companyId).toBe(first.companyId);
    expect(second.dealId).toBe(first.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'company')).toHaveLength(1);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'contact')).toHaveLength(1);
  });

  it('a later Radar-stage change updates the same HubSpot deal\'s stage rather than creating a new deal', async () => {
    const svc = new MockHubSpot();
    const first = await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 'stage-surfaced', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    // Company already synced before, and the caller now knows the
    // HubSpot deal id from that first sync (the real flow persists this
    // via hubspot_deal_id — see server/routes/hubspot.ts performSync).
    const second = await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 'stage-approved', pipelineId: 'p', resolution: 'update-existing', existingRecordId: first.companyId, existingDealId: first.dealId,
    });
    expect(second.dealId).toBe(first.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);
    const dealObj = store.raw.mockHubSpot.find((o) => o.id === first.dealId)!;
    expect(dealObj.properties.dealstage).toBe('stage-approved');
  });

  it('falls back to a live search by vamos_deal_radar_id when no deal id was persisted (pre-fix records)', async () => {
    const svc = new MockHubSpot();
    const first = await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 'stage-surfaced', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    // Simulate a record synced before hubspot_deal_id was tracked: the
    // caller has no saved deal id to pass, only the radar/company link.
    const second = await svc.syncCompany({
      company: company(), contacts: [], deal: deal(),
      stageId: 'stage-approved', pipelineId: 'p', resolution: 'update-existing', existingRecordId: first.companyId, existingDealId: null,
    });
    expect(second.dealId).toBe(first.dealId);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'deal')).toHaveLength(1);
    const dealObj = store.raw.mockHubSpot.find((o) => o.id === first.dealId)!;
    expect(dealObj.properties.dealstage).toBe('stage-approved');
  });

  it('associates the deal with company and contacts', async () => {
    const res = await new MockHubSpot().syncCompany({
      company: company(), contacts: [contact()], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null, existingDealId: null,
    });
    const dealObj = store.raw.mockHubSpot.find((o) => o.id === res.dealId)!;
    expect(dealObj.associations).toContain(res.companyId);
    expect(dealObj.associations).toContain(res.contactIds[0]);
  });
});

// ── What may become a CRM contact ─────────────────────────────────

describe('founder contacts written to HubSpot', () => {
  const founder = (over: Partial<Founder> = {}): Founder => ({
    name: 'Jane Okonkwo', role: 'Co-Founder & CEO', background: 'Built X.', ...over,
  });

  /**
   * The imported `founders` table still carries "Unknown founder" for
   * most companies. Syncing one creates a contact literally named that
   * in a CRM the whole team shares and outreach is built from — a
   * mistake that is trivial to make and tedious to undo.
   */
  it('refuses to sync a placeholder founder row', () => {
    expect(isSyncableContactName(founder({ name: 'Unknown founder' }).name)).toBe(false);
    expect(isSyncableContactName('unknown')).toBe(false);
    expect(isSyncableContactName('')).toBe(false);
  });

  /**
   * A single token cannot be matched against an existing CRM record, so
   * it creates a duplicate person rather than finding the real one.
   */
  it('refuses a name with no surname', () => {
    expect(isSyncableContactName('Jane')).toBe(false);
  });

  it('accepts a real, fully-named founder', () => {
    expect(isSyncableContactName(founder().name)).toBe(true);
    expect(isSyncableContactName('Oriana Papin-Zoghbi')).toBe(true);
  });

  /**
   * "Unknown" is what the importer wrote when a source stated no role.
   * An empty job title is honest; the literal word in a CRM field is not.
   */
  it('does not write the literal word "Unknown" as a job title', () => {
    expect(cleanJobTitle('Unknown')).toBe('');
    expect(cleanJobTitle('  unknown ')).toBe('');
    expect(cleanJobTitle('Co-Founder & CEO')).toBe('Co-Founder & CEO');
  });

  /**
   * Enforced on the SERVER, not only in the modal that usually builds
   * the payload. A rule the UI applies is a rule anyone with the API can
   * skip — including our own retry path, which replays a payload stored
   * before this check existed.
   */
  it('drops a placeholder contact at the sync route while still syncing the company', async () => {
    const { createApp } = await import('../app');
    const { adminAgent } = await import('./testAuth');
    const { __setHubSpotServiceForTests } = await import('../services/hubspot');
    const mock = new MockHubSpot();
    __setHubSpotServiceForTests(mock);

    const app = createApp();
    const agent = await adminAgent(app);
    // Submissions are blocked without a stage mapping. That guard is
    // covered by mapping.test.ts; here it is just a precondition, so the
    // mapping is seeded directly rather than driven through the portal.
    const { setConfig } = await import('../db/repos/operations');
    setConfig('hubspot-pipeline-mapping', {
      pipelineId: 'p-1',
      pipelineLabel: 'Test pipeline',
      stages: Object.fromEntries(RADAR_HUBSPOT_STAGES.map((st) => [st, 's-1'])),
    });

    const res = await agent.post('/api/hubspot/sync-company').send({
      company: {
        dealRadarId: 'c-guard-1', name: 'Guard Co', domain: 'guard.example.com',
        website: 'https://guard.example.com', vertical: 'Health & Wellness', subcategory: 'Care',
        stage: 'Seed', city: 'Austin', state: 'TX', description: 'A company.',
        accelerator: null, fundingRaised: null,
        dateFirstSurfaced: '2026-07-01', lastRefreshed: '2026-07-30',
        primarySource: 'company-site', policyException: '', dealRadarUrl: 'https://radar.local/c-guard-1',
      },
      contacts: [
        {
          firstName: 'Unknown', lastName: 'founder', email: null, jobTitle: '', linkedinUrl: null,
          companyName: 'Guard Co', infoSource: 'import', verificationStatus: 'Unverified',
          relationshipOwner: null, lastOutreachDate: null, demographics: [],
        },
        {
          firstName: 'Jane', lastName: 'Okonkwo', email: null, jobTitle: 'Co-Founder & CEO', linkedinUrl: null,
          companyName: 'Guard Co', infoSource: 'company-site', verificationStatus: 'Unverified',
          relationshipOwner: null, lastOutreachDate: null, demographics: [],
        },
      ],
      deal: {
        companyName: 'Guard Co', fitScore: 7, recommendation: 'Track', vertical: 'Health & Wellness',
        stage: 'Seed', scoreBreakdown: [], rationale: 'x', risks: '', nextAction: 'y',
        sourceEvidence: [], reviewer: null,
        evidenceQualityScore: 5, policyException: '', sourcingStatus: 'Approved to Track',
        dateSurfaced: '2026-07-01', relationshipOwner: '', dealRadarId: 'c-guard-1',
        dealRadarUrl: 'https://radar.local/c-guard-1',
      },
      radarStage: 'Approved to Track',
      duplicateResolution: 'create-new',
      existingRecordId: null,
    });

    expect(res.status).toBe(200);
    const contacts = store.raw.mockHubSpot.filter((o) => o.type === 'contact');
    const names = contacts.map((o) => `${o.properties.firstname} ${o.properties.lastname}`);
    // The real person is created; the placeholder never reaches the CRM.
    expect(names).toContain('Jane Okonkwo');
    expect(names.some((n) => /unknown/i.test(n))).toBe(false);
    // The company still synced — only the unusable contact was withheld.
    expect(store.raw.mockHubSpot.some((o) => o.type === 'company')).toBe(true);

    __setHubSpotServiceForTests(null);
  });
});

/**
 * The permission audit, kept honest by a test.
 *
 * A scope list is the one part of an integration that grows quietly:
 * somebody adds a call, adds the scope it needs, and the portal that
 * re-authorizes months later grants more than anyone reviewed. So the
 * set is pinned exactly, and both directions are asserted — nothing
 * unused stays, nothing new arrives unnoticed.
 *
 * Each scope's justification lives next to the list itself in
 * server/services/hubspot.ts.
 */
describe('HubSpot OAuth scopes', () => {
  it('requests exactly the seven scopes the sync workflow uses', () => {
    expect([...HUBSPOT_OAUTH_SCOPES].sort()).toEqual([
      'crm.objects.companies.read',
      'crm.objects.companies.write',
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
      'crm.objects.notes.write',
    ]);
  });

  it('asks for no permission beyond the reviewed company/contact/deal/note workflow', () => {
    for (const scope of HUBSPOT_OAUTH_SCOPES) {
      // Portal-wide and administrative grants: never.
      expect(scope).not.toMatch(/\.All$/);
      expect(scope).not.toMatch(/owners|settings|users|automation|timeline|forms|marketing/);
      // Only these four object types are touched at all.
      expect(scope).toMatch(/^crm\.objects\.(companies|contacts|deals|notes)\.(read|write)$/);
    }
    // Notes are written, never read back — so no read scope for them.
    expect(HUBSPOT_OAUTH_SCOPES).not.toContain('crm.objects.notes.read');
  });

  it('sends that same list on the authorize request — no divergence', async () => {
    // A fresh module registry: server/env.ts resolves credentials once
    // at load, so the top-level import in this file was made before
    // these variables existed.
    process.env.HUBSPOT_CLIENT_ID = 'test-client-id-not-real';
    process.env.HUBSPOT_CLIENT_SECRET = 'test-client-secret-not-real';
    process.env.APP_BASE_URL = 'https://deal-radar-sbo8.onrender.com';
    vi.resetModules();
    try {
      const hubspot = await import('../services/hubspot');
      const storeMod = await import('../lib/store');
      storeMod.store.resetForTests();
      const { authUrl } = hubspot.beginHubSpotConnect();
      const requested = new URL(authUrl!).searchParams.get('scope')!.split(' ');
      expect(requested.sort()).toEqual([...hubspot.HUBSPOT_OAUTH_SCOPES].sort());
    } finally {
      delete process.env.HUBSPOT_CLIENT_ID;
      delete process.env.HUBSPOT_CLIENT_SECRET;
      delete process.env.APP_BASE_URL;
      vi.resetModules();
    }
  });
});
