import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import {
  buildCompanyProperties,
  buildContactProperties,
  buildDealProperties,
  hubspotService,
} from '../services/hubspot';
import { MockHubSpot } from './mocks/hubspot';
import {
  hubspotContactRecordSchema,
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
  scoreExplanation: 'Vamos Fit Score 8.7/10 (test fixture explanation).',
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
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null,
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
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null,
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
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null,
    });
    const second = await svc.syncCompany({
      company: company({ description: 'Updated description' }), contacts: [], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'update-existing', existingRecordId: first.companyId,
    });
    expect(second.action).toBe('updated');
    expect(second.companyId).toBe(first.companyId);
    const companies = store.raw.mockHubSpot.filter((o) => o.type === 'company');
    expect(companies).toHaveLength(1);
    expect(companies[0].properties.description).toBe('Updated description');
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
    expect(p.vamos_score_explanation).toContain('Vamos Fit Score');
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
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null,
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
      stageId: 's', pipelineId: 'p', resolution: 'create-new' as const, existingRecordId: null,
    };
    await svc.syncCompany(args);
    await svc.syncCompany(args);
    expect(store.raw.mockHubSpot.filter((o) => o.type === 'contact')).toHaveLength(1);
  });

  it('associates the deal with company and contacts', async () => {
    const res = await new MockHubSpot().syncCompany({
      company: company(), contacts: [contact()], deal: deal(),
      stageId: 's', pipelineId: 'p', resolution: 'create-new', existingRecordId: null,
    });
    const dealObj = store.raw.mockHubSpot.find((o) => o.id === res.dealId)!;
    expect(dealObj.associations).toContain(res.companyId);
    expect(dealObj.associations).toContain(res.contactIds[0]);
  });
});
