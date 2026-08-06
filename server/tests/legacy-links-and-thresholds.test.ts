import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import {
  verticalById, verticalsFromParam, LEGACY_VERTICAL_ALIASES, VERTICALS,
} from '../../src/data/taxonomy';
import { HOT_THRESHOLD } from '../../shared/scoringThresholds';
import type { ImportedCompany } from '../services/imports';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, '..', '..', rel), 'utf8');

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
});

/**
 * Backward-compatible links must resolve SAFELY.
 *
 * "Safely" is the operative word: the previous behaviour did not throw, it
 * rendered an empty All Deals table with no vertical chip lit and
 * "All verticals" not lit either — which reads as a broken page rather
 * than as a filter. `normalizeVerticalId` existed for exactly this and was
 * never called from the client.
 */
describe('legacy ?vertical= values resolve to canonical ids', () => {
  it('maps every documented legacy alias', () => {
    expect(verticalsFromParam('robotics')).toEqual(['frontier']);
    expect(verticalsFromParam('spacetech')).toEqual(['frontier']);
    expect(verticalsFromParam('space-tech')).toEqual(['frontier']);
    expect(verticalsFromParam('ai')).toEqual(['fow']);
  });

  it('accepts the canonical ids unchanged', () => {
    for (const v of VERTICALS) expect(verticalsFromParam(v.id)).toEqual([v.id]);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(verticalsFromParam(' Robotics ')).toEqual(['frontier']);
    expect(verticalsFromParam('FinTech')).toEqual(['fintech']);
  });

  it('supports a multi-vertical selection', () => {
    expect(verticalsFromParam('health,fintech')).toEqual(['health', 'fintech']);
    // Two aliases that fold to the same vertical produce one entry.
    expect(verticalsFromParam('robotics,spacetech')).toEqual(['frontier']);
  });

  it('DROPS an unrecognized value rather than filtering to nothing', () => {
    // 'aoi' is the retired catch-all; migration 15 deliberately leaves it
    // reachable. An unmatchable filter shows nothing and explains nothing,
    // so the unfiltered master view is the safe resolution.
    expect(verticalsFromParam('aoi')).toEqual([]);
    expect(verticalsFromParam('not-a-vertical')).toEqual([]);
    expect(verticalsFromParam('')).toEqual([]);
    expect(verticalsFromParam(null)).toEqual([]);
  });

  it('keeps the valid part of a partly-invalid list', () => {
    expect(verticalsFromParam('health,garbage,ai')).toEqual(['health', 'fow']);
  });
});

describe('every legacy alias has a route', () => {
  /**
   * '/spacetech' was missing while `spacetech` is the canonical historical
   * value — it is the first entry in migration 15's own `IN (...)` list —
   * so the spelling most likely to be bookmarked fell through to the
   * catch-all and rendered the Overview under a '/spacetech' URL.
   */
  it('registers a path for each alias in LEGACY_VERTICAL_ALIASES', () => {
    const app = read('src/App.tsx');
    for (const alias of Object.keys(LEGACY_VERTICAL_ALIASES)) {
      if (alias.includes(' ')) continue; // a space is not a URL path
      expect(app, `no route for legacy alias "${alias}"`).toContain(`path="/${alias}"`);
    }
  });
});

describe('verticalById never throws on a legacy or unknown value', () => {
  it('resolves a legacy value through the alias table', () => {
    expect(verticalById('robotics' as never).id).toBe('frontier');
  });

  it('returns an explicit placeholder rather than crashing', () => {
    // ImportedCompany.vertical is cast straight out of the row with no
    // validation, and migration 15 leaves 'aoi' in place — so this value
    // is reachable by design, and `.find(...)!.name` on it was a TypeError
    // in the middle of rendering a company row.
    expect(() => verticalById('aoi' as never)).not.toThrow();
    expect(verticalById('aoi' as never).name).toBe('Unassigned');
    expect(verticalById('' as never).name).toBe('Unassigned');
  });

  it('does not add the placeholder to the five approved verticals', () => {
    expect(VERTICALS).toHaveLength(5);
    expect(VERTICALS.map((v) => v.id)).not.toContain('unassigned');
  });
});

describe('one High-Fit threshold, and it respects provisionality', () => {
  it('the Overview ranking widget uses the shared threshold, not a literal', () => {
    const ranking = read('src/components/Ranking.tsx');
    expect(ranking).toContain('HOT_THRESHOLD');
    // The bare literal is what drifted from the KPI cards.
    expect(ranking).not.toMatch(/fit\.score >= 8\b/);
  });

  it('the ranking widget excludes provisional scores, as the KPI card does', () => {
    const ranking = read('src/components/Ranking.tsx');
    expect(ranking).toMatch(/!x\.fit\.provisional && x\.fit\.score >= HOT_THRESHOLD/);
  });

  it('the shared threshold is a single number both sides import', () => {
    expect(typeof HOT_THRESHOLD).toBe('number');
    expect(read('server/services/executiveKpis.ts')).toContain('HOT_THRESHOLD');
  });
});

describe('a company write is atomic', () => {
  const record = (over: Partial<ImportedCompany> = {}): ImportedCompany => ({
    id: 'tx-1', name: 'Atomic Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
    stage: 'Unknown', city: 'Austin', state: 'TX', foundedYear: 2025, teamSize: 3,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Ana Ruiz', role: 'CEO', background: 'Recorded.' }],
    evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
    ...over,
  } as ImportedCompany);

  it('writes the company, its founders and its evidence together', () => {
    saveCompany(record(), { origin: 'extracted', source: 'test' });
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS n FROM companies WHERE id = ?').get('tx-1') as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM founders WHERE company_id = ?').get('tx-1') as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE company_id = ?').get('tx-1') as { n: number }).n).toBe(1);
  });

  it('leaves NOTHING behind when the write fails partway', () => {
    /**
     * The company row and the provenance rows land before the founders
     * insert. Without a transaction a throw here left a half-written
     * company that `importCandidates` had already reported as `failed` —
     * a report that was not true.
     */
    expect(() => saveCompany(
      record({ id: 'tx-2', founders: [{ name: 'Ok', role: 'CEO', background: {} as unknown as string }] }),
      { origin: 'extracted', source: 'test' },
    )).toThrow();

    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS n FROM companies WHERE id = ?').get('tx-2') as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM founders WHERE company_id = ?').get('tx-2') as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM field_provenance WHERE company_id = ?').get('tx-2') as { n: number }).n).toBe(0);
  });

  it('does not destroy existing founders when an update fails partway', () => {
    // The update path DELETEs founders before inserting replacements, so a
    // failure there could leave a company with fewer founders than before.
    saveCompany(record({ id: 'tx-3' }), { origin: 'extracted', source: 'test' });
    expect(() => saveCompany(
      record({ id: 'tx-3', founders: [{ name: 'New', role: 'CTO', background: {} as unknown as string }] }),
      { origin: 'extracted', source: 'test' },
    )).toThrow();
    const names = (getDb().prepare('SELECT name FROM founders WHERE company_id = ?').all('tx-3') as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(['Ana Ruiz']);
  });
});
