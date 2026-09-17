import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { getProvenance } from '../db/repos/companies';
import { importCompaniesCsv, placeholderFieldsFor, type ImportedCompany } from '../services/imports';

/**
 * `importCompaniesCsv` is the CSV import path, and it used to stamp
 * EVERY field `user-entered` unconditionally — the second-highest
 * provenance tier, which `applyFieldUpdate` never lets an automated
 * `extracted` write (real enrichment) replace. That is correct for a
 * value a human actually supplied, and wrong for a value that is only a
 * schema-satisfying placeholder ("Unclassified — requires manual
 * review", a blank website, the stage enum's own "Unknown" option) — or
 * a real Vamos taxonomy label imported for the WRONG sector. Either way,
 * nobody actually asserted the value was correct, and it must stay
 * correctable — otherwise nothing the enrichment pipeline discovers
 * afterward can ever reach the row. This is what kept a real production
 * company (Podium) showing a wrong subcategory even after the classifier
 * was fixed to compute the right one.
 */

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

const CSV_HEADER =
  'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType,website,accelerator,raising,lastFundingDate';

function row(over: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    name: 'Podium', oneLiner: 'Get more leads. Make more money.',
    vertical: 'fintech', subcategory: 'consumer wellness', stage: 'Unknown',
    city: 'Lehi', state: 'UT', foundedYear: '1990', teamSize: '1',
    tractionLevel: '0', tractionNote: 'Unknown — not yet researched',
    founderName: 'Unknown founder', founderRole: 'Unknown', founderBackground: 'Unknown — requires manual research',
    evidenceClaim: 'Listed in the public YC directory.', evidenceSource: 'Y Combinator public directory',
    evidenceUrl: 'https://www.ycombinator.com/companies/podium', evidenceDate: '2026-07-28', evidenceType: 'Database record',
    website: '', accelerator: '', raising: '', lastFundingDate: '',
    ...over,
  };
  const headers = CSV_HEADER.split(',');
  return headers.map((h) => fields[h] ?? '').join(',');
}

function base(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'test-1', name: 'Podium', oneLiner: 'Get more leads. Make more money.',
    vertical: 'fintech', subcategory: 'consumer wellness', stage: 'Unknown',
    city: 'Lehi', state: 'UT', foundedYear: 1990, teamSize: 1,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
    evidence: [{
      claim: 'Listed in the public YC directory.', source: 'Y Combinator public directory',
      url: 'https://www.ycombinator.com/companies/podium', date: '2026-07-28', type: 'Database record',
    }],
    flags: [], imported: true,
    ...over,
  };
}

describe('placeholderFieldsFor', () => {
  it('flags an absent website, the stage enum\'s own "Unknown", and a founded year at the schema floor', () => {
    const fields = placeholderFieldsFor(base());
    expect(fields).toContain('website');
    expect(fields).toContain('stage');
    expect(fields).toContain('foundedYear');
  });

  it('flags a subcategory belonging to the WRONG sector\'s taxonomy — the Podium bug', () => {
    // 'consumer wellness' is real text, not a placeholder shape — it only
    // ever exists under `health`'s own subvertical table, never `fintech`'s.
    const fields = placeholderFieldsFor(base({ vertical: 'fintech', subcategory: 'consumer wellness' }));
    expect(fields).toContain('subcategory');
  });

  it('flags an unstated city/state', () => {
    const fields = placeholderFieldsFor(base({ city: 'Unknown', state: '??' }));
    expect(fields).toContain('city');
    expect(fields).toContain('state');
  });

  it('flags absent optional fields (accelerator, raising, lastFundingDate)', () => {
    const fields = placeholderFieldsFor(base());
    expect(fields).toContain('accelerator');
    expect(fields).toContain('raising');
    expect(fields).toContain('lastFundingDate');
  });

  it('does NOT flag a real, specific value — including a subcategory that matches its own sector', () => {
    const fields = placeholderFieldsFor(base({
      website: 'https://podium.com', subcategory: 'payments infrastructure', stage: 'Series A',
      city: 'Lehi', state: 'UT', foundedYear: 2014,
      accelerator: 'Y Combinator (W16)', raising: '$1M', lastFundingDate: '2014-06-01',
    }));
    expect(fields).toEqual([]);
  });
});

describe('importCompaniesCsv provenance', () => {
  it('stamps a placeholder subcategory, website and stage as missing, not user-entered', () => {
    importCompaniesCsv([CSV_HEADER, row()].join('\n'));
    const id = 'imported-podium';
    expect(getProvenance(id, 'subcategory')?.origin).toBe('missing');
    expect(getProvenance(id, 'website')?.origin).toBe('missing');
    expect(getProvenance(id, 'stage')?.origin).toBe('missing');
  });

  it('still stamps a real, analyst-provided value as user-entered — protected from automated overwrite', () => {
    importCompaniesCsv([CSV_HEADER, row({
      website: 'https://podium.com', subcategory: 'payments infrastructure', stage: 'Series A',
    })].join('\n'));
    const id = 'imported-podium';
    expect(getProvenance(id, 'subcategory')?.origin).toBe('user-entered');
    expect(getProvenance(id, 'website')?.origin).toBe('user-entered');
    expect(getProvenance(id, 'stage')?.origin).toBe('user-entered');
  });
});
