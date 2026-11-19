import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { getProvenance, saveCompany } from '../db/repos/companies';
import { runEnrichment } from '../services/enrichment';
import { clearPolitenessCacheForTests } from '../sourcing/politeness';
import { PLACEHOLDER_FOUNDED_YEAR, type ImportedCompany } from '../services/imports';
import { SCHEDULING_WIZARD } from './fixtures/ycProfiles';

/**
 * The free research pass already parsed "Founded" and "Team Size" from a
 * company's YC profile (server/enrichment/ycProfile.ts) but never saved
 * them, so 0 of 53 email-intake companies in production had a founded
 * year. A paid Claude web-research test (2026-11-18) found exactly these
 * values — all from the YC page this pass already reads.
 *
 * These pin what now reaches the company ROW, with the YC page as source,
 * and that a person's value is never overwritten.
 */

const YC_URL = 'https://www.ycombinator.com/companies/scheduling-wizard';

beforeEach(() => {
  clearPolitenessCacheForTests();
  store.resetForTests();
  resetDbForTests();
});
afterEach(() => vi.unstubAllGlobals());

function stubYcProfile() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('ycombinator.com/companies/scheduling-wizard')) {
      return { ok: true, status: 200, text: async () => SCHEDULING_WIZARD, headers: new Headers() } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'not found', headers: new Headers() } as unknown as Response;
  }));
}

/** What an approved email lead looks like: placeholders recorded as Missing. */
function emailLead(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'sw-1', name: 'Scheduling Wizard', oneLiner: 'Healthcare logistics infrastructure.',
    vertical: 'health', subcategory: 'Healthcare infrastructure',
    stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: PLACEHOLDER_FOUNDED_YEAR, teamSize: 1,
    website: 'https://www.schedulingwiz.com',
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
    evidence: [{
      claim: 'Listed in the Y Combinator public directory', source: 'Y Combinator', url: YC_URL,
      date: '2026-11-18', type: 'Database record',
    }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany;
}

function row() {
  return getDb().prepare('SELECT founded_year, team_size, city, state FROM companies WHERE id = ?').get('sw-1') as
    { founded_year: number; team_size: number; city: string; state: string };
}

describe('research saves the YC profile\'s founded year and team size', () => {
  it('fills both when nothing is on record, citing the YC page', async () => {
    saveCompany(emailLead(), { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'city', 'state'] });
    stubYcProfile();

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(row().founded_year).toBe(2024);
    expect(row().team_size).toBe(3);
    expect(getProvenance('sw-1', 'foundedYear')).toEqual({ origin: 'extracted', source: YC_URL });
    expect(getProvenance('sw-1', 'teamSize')).toEqual({ origin: 'extracted', source: YC_URL });
  });

  it('cites a YC-derived location to the YC profile, not to SEC Form D', async () => {
    saveCompany(emailLead(), { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'city', 'state'] });
    stubYcProfile();

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(row().city).toBe('Washington');
    expect(getProvenance('sw-1', 'city')!.source).toContain('Y Combinator profile');
    expect(getProvenance('sw-1', 'city')!.source).not.toContain('SEC');
  });

  it('never overwrites a founded year or team size a person entered', async () => {
    saveCompany(emailLead({ foundedYear: 2023, teamSize: 7 }), { origin: 'user-entered', source: 'email-intake', unknownFields: ['city', 'state'] });
    stubYcProfile();

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(row().founded_year).toBe(2023);
    expect(row().team_size).toBe(7);
    expect(getProvenance('sw-1', 'foundedYear')!.origin).toBe('user-entered');
  });
});

/**
 * Email leads from a YC newsletter carry "Y Combinator F26" as their
 * accelerator but no YC link — their only evidence is the forwarded email.
 * The research plan only visits accelerator pages it has a URL for, so
 * their YC profile was never read. Research now asks the YC directory for
 * the profile URL first.
 */
describe('YC-marked email leads with no YC link on record', () => {
  const API = 'api.ycombinator.com/v0.1/companies';
  const DIRECTORY_HIT = JSON.stringify({ companies: [{
    name: 'Scheduling Wizard', website: 'https://www.schedulingwiz.com', slug: 'scheduling-wizard',
    url: YC_URL, batch: 'Winter 2026', status: 'Active', locations: ['Washington, DC'], teamSize: 3,
  }] });

  function stubYc(directory: string, calls: string[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes(API) ? directory
        : url.includes('ycombinator.com/companies/scheduling-wizard') ? SCHEDULING_WIZARD
          : undefined;
      if (body === undefined) return { ok: false, status: 404, text: async () => 'not found', headers: new Headers() } as unknown as Response;
      return { ok: true, status: 200, text: async () => body, headers: new Headers() } as unknown as Response;
    }));
  }

  const forwardedOnly = (over: Partial<ImportedCompany> = {}) => emailLead({
    accelerator: 'Y Combinator W26',
    city: 'Washington', state: 'DC',
    evidence: [{ claim: 'Healthcare logistics infrastructure.', source: 'Forwarded email', url: 'Andrew Gonzalez; 2026-10-28', date: '2026-10-28', type: 'Inbound referral' }],
    ...over,
  });

  it('finds the YC profile through the directory and saves founded year and team size from it', async () => {
    saveCompany(forwardedOnly(), { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize'] });
    const calls: string[] = [];
    stubYc(DIRECTORY_HIT, calls);

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(calls.some((u) => u.includes(API))).toBe(true);
    expect(calls.some((u) => u.includes('ycombinator.com/companies/scheduling-wizard'))).toBe(true);
    expect(row().founded_year).toBe(2024);
    expect(row().team_size).toBe(3);
    expect(getProvenance('sw-1', 'foundedYear')).toEqual({ origin: 'extracted', source: YC_URL });
  });

  it('ignores a same-named YC company whose website is not this company\'s', async () => {
    saveCompany(forwardedOnly({ website: 'https://scheduling-wizard-other.example' }), { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize'] });
    stubYc(DIRECTORY_HIT, []);

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(row().founded_year).toBe(PLACEHOLDER_FOUNDED_YEAR);
    expect(getProvenance('sw-1', 'foundedYear')!.origin).toBe('missing');
  });

  it('does not query the YC directory for a company not marked as YC', async () => {
    saveCompany(forwardedOnly({ accelerator: undefined }), { origin: 'user-entered', source: 'email-intake', unknownFields: ['foundedYear', 'teamSize', 'accelerator'] });
    const calls: string[] = [];
    stubYc(DIRECTORY_HIT, calls);

    await runEnrichment({ apply: true, companyIds: ['sw-1'], initiatedBy: 'test', maxRequests: 40 });

    expect(calls.some((u) => u.includes(API))).toBe(false);
    expect(row().founded_year).toBe(PLACEHOLDER_FOUNDED_YEAR);
  });
});
