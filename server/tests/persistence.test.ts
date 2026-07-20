import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { createApp } from '../app';
import { importCompaniesCsv, importedCompanies } from '../services/imports';
import {
  applyFieldUpdate, getCompany, getProvenance, listCompanies, listPossibleDuplicates,
  matchRecords, saveCompany,
} from '../db/repos/companies';
import { latestScore, listReviewDecisions } from '../db/repos/operations';
import {
  isHighConfidenceFuzzy, matchCompany, normalizeCompanyKey, normalizeDomainKey,
} from '../sourcing/identity';
import type { ImportedCompany } from '../services/imports';

/**
 * Phase-4 persistence + normalization + deduplication tests. The
 * primary datastore is SQLite (in-memory here; a durable file in dev/
 * prod) — the restart test below runs two REAL separate processes
 * against the same database file.
 */

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
});

const CSV_HEADER =
  'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType,website';

const row = (name: string, website = '', evidenceUrl = `https://example.com/${name.toLowerCase().replace(/[^a-z]+/g, '-')}`) =>
  `${name},Grid software,sustainability,Energy transition software,Seed,Portland,OR,2025,8,5,Two pilots,Jo Rivera,CEO,Grid engineer,Pilot announced,Local news,${evidenceUrl},2026-06-01,News,${website}`;

const fixtureCompany = (over: Partial<ImportedCompany> = {}): ImportedCompany => ({
  id: 'test-restart-co',
  name: 'Restart Proof Inc',
  oneLiner: 'Persists across processes.',
  vertical: 'fintech',
  subcategory: 'Payments',
  stage: 'Seed',
  city: 'Austin',
  state: 'TX',
  foundedYear: 2025,
  teamSize: 5,
  website: 'https://restartproof.example.com',
  traction: { level: 4, note: 'Fixture traction.' },
  founders: [{ name: 'Ana Test', role: 'CEO', background: 'Fixture.' }],
  evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/restart', date: '2026-06-01', type: 'News' }],
  flags: [],
  imported: true,
  ...over,
});

// ── Persistence across restarts (two real processes, one DB file) ─

describe('persistence across restarts', () => {
  it('a company written by one process is read back by a fresh process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-db-'));
    const dbPath = path.join(dir, 'restart-test.db');
    const projectRoot = path.resolve(__dirname, '..', '..');
    const runScript = (body: string): string => {
      const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.mts`);
      fs.writeFileSync(file, body);
      return execFileSync('npx', ['tsx', file], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'restart-test' },
        encoding: 'utf8',
      });
    };

    // Process 1: write a company, then exit.
    runScript(`
      const { saveCompany } = await import('${projectRoot}/server/db/repos/companies');
      saveCompany(${JSON.stringify(fixtureCompany())}, { origin: 'user-entered', source: 'restart-test' });
      console.log('SAVED');
    `);

    // Process 2: a completely new process reads it back from disk.
    const out = runScript(`
      const { listCompanies } = await import('${projectRoot}/server/db/repos/companies');
      const companies = listCompanies();
      console.log(JSON.stringify({ count: companies.length, name: companies[0]?.name, evidence: companies[0]?.evidence.length }));
    `);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.count).toBe(1);
    expect(result.name).toBe('Restart Proof Inc');
    expect(result.evidence).toBeGreaterThanOrEqual(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

// ── Normalization ────────────────────────────────────────────────

describe('normalization', () => {
  it('folds capitalization, punctuation, whitespace, suffixes, and aliases', () => {
    expect(normalizeCompanyKey('Pacific  Rim Energy, Inc.')).toBe('pacific rim energy');
    expect(normalizeCompanyKey('PACIFIC RIM ENERGY LLC')).toBe('pacific rim energy');
    expect(normalizeCompanyKey('Acme & Co')).toBe(normalizeCompanyKey('Acme and Company'));
    expect(normalizeCompanyKey('Vamos Intl Grp Ltd.')).toBe('vamos international group');
  });

  it('normalizes domains and URLs', () => {
    expect(normalizeDomainKey('HTTPS://WWW.PacificRim.Example.com/about/?q=1')).toBe('pacificrim.example.com');
    expect(normalizeDomainKey('pacificrim.example.com')).toBe('pacificrim.example.com');
    expect(normalizeDomainKey('not a url')).toBeNull();
  });
});

// ── Matching tiers ───────────────────────────────────────────────

describe('identity matching', () => {
  it('matches by exact normalized domain first', () => {
    saveCompany(fixtureCompany({ id: 'c-dom', name: 'Different Display Name', website: 'https://www.pacificrim.example.com' }), { origin: 'user-entered', source: 'test' });
    const m = matchCompany({ name: 'Totally Unrelated', domain: 'http://pacificrim.example.com/' }, matchRecords());
    expect(m.kind).toBe('exact');
    expect(m.matchedBy).toBe('domain');
    expect(m.record!.id).toBe('c-dom');
  });

  it('matches by exact external-source id', () => {
    saveCompany(fixtureCompany({ id: 'c-ext', name: 'Ext Co', website: undefined }), {
      origin: 'extracted', source: 'discovery:sec', externalId: { sourceId: 'sec', externalId: '0001-23-000456' },
    });
    const m = matchCompany({ name: 'Renamed Since Filing', externalIds: [{ sourceId: 'sec', externalId: '0001-23-000456' }] }, matchRecords());
    expect(m.kind).toBe('exact');
    expect(m.matchedBy).toBe('external-id');
  });

  it('matches by exact normalized company name', () => {
    saveCompany(fixtureCompany({ id: 'c-name', name: 'Pacific Rim Energy Inc.', website: undefined }), { origin: 'user-entered', source: 'test' });
    const m = matchCompany({ name: 'PACIFIC RIM ENERGY' }, matchRecords());
    expect(m.kind).toBe('exact');
    expect(m.matchedBy).toBe('name');
  });

  it('flags high-confidence fuzzy typos as POSSIBLE — never exact', () => {
    expect(isHighConfidenceFuzzy('pacific rim energ', 'pacific rim energy')).toBe(true);
    expect(isHighConfidenceFuzzy('acme', 'acne')).toBe(false); // too short to trust
    saveCompany(fixtureCompany({ id: 'c-fuzzy', name: 'Pacific Rim Energy', website: undefined }), { origin: 'user-entered', source: 'test' });
    const m = matchCompany({ name: 'Pacific Rim Energ' }, matchRecords());
    expect(m.kind).toBe('possible');
    expect(m.matchedBy).toBe('fuzzy-name');
    expect(m.similarity).toBeGreaterThan(0.9);
  });

  it('uses founder + name-token evidence as a POSSIBLE tier', () => {
    saveCompany(fixtureCompany({
      id: 'c-founder', name: 'Rim Energy Systems', website: undefined,
      founders: [{ name: 'Dana Volt', role: 'CEO', background: 'x' }],
    }), { origin: 'user-entered', source: 'test' });
    const m = matchCompany(
      { name: 'Rim Energy Labs', founderNames: ['Dana Volt'] },
      matchRecords(),
    );
    expect(m.kind).toBe('possible');
    expect(['founder-evidence', 'fuzzy-name']).toContain(m.matchedBy);
  });
});

// ── Duplicate prevention & uncertain handling (end to end) ───────

describe('duplicate prevention', () => {
  it('Pacific Rim Energ vs Pacific Rim Energy: exact upserts, typos open a review item', async () => {
    // 1st import creates the record.
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energy Inc.')].join('\n'));
    expect(listCompanies()).toHaveLength(1);

    // Same company, different suffix/case → exact normalized-name match → UPDATE, not a new row.
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energy')].join('\n'));
    expect(listCompanies()).toHaveLength(1);
    expect(listPossibleDuplicates('pending')).toHaveLength(0);

    // Typo ("Energ") → high-confidence FUZZY → imported as its own record + pending review item.
    const report = importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energ')].join('\n'));
    expect(report.possibleDuplicates).toBe(1);
    expect(listCompanies()).toHaveLength(2); // NOT auto-merged
    const pending = listPossibleDuplicates('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].matchedBy).toBe('fuzzy-name');
  });

  it('same domain with a different name is treated as the same company', () => {
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energy', 'https://pacificrim.example.com')].join('\n'));
    importCompaniesCsv([CSV_HEADER, row('PRE Holdings', 'https://www.pacificrim.example.com/', 'https://example.com/pre-2')].join('\n'));
    expect(listCompanies()).toHaveLength(1);
    // Both sources' evidence is preserved on the single record.
    expect(listCompanies()[0].evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('uncertain duplicates wait for a human: not-duplicate keeps both, confirmed merges', async () => {
    const app = createApp();
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energy')].join('\n'));
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Energ', '', 'https://example.com/typo-src')].join('\n'));
    const pending = listPossibleDuplicates('pending');
    expect(pending).toHaveLength(1);

    // Human says: not a duplicate → both records stay active.
    const keep = await request(app).post(`/api/duplicates/${pending[0].id}/resolve`).send({ resolution: 'not-duplicate', actor: 'MG' });
    expect(keep.status).toBe(200);
    expect(listCompanies()).toHaveLength(2);
    expect(listPossibleDuplicates('pending')).toHaveLength(0);

    // Re-flag and confirm → newer record merges into the older; evidence is preserved.
    importCompaniesCsv([CSV_HEADER, row('Pacific Rim Enrgy', '', 'https://example.com/typo-2')].join('\n'));
    const pending2 = listPossibleDuplicates('pending');
    expect(pending2).toHaveLength(1);
    const confirm = await request(app).post(`/api/duplicates/${pending2[0].id}/resolve`).send({ resolution: 'confirmed-duplicate', actor: 'MG' });
    expect(confirm.status).toBe(200);
    const kept = getCompany(pending2[0].otherCompanyId!)!;
    expect(kept.evidence.some((e) => e.url === 'https://example.com/typo-2')).toBe(true); // merged evidence
    expect(getCompany(pending2[0].companyId)).toBeNull(); // merged record no longer listed as active
    const decisions = listReviewDecisions(String(pending2[0].id));
    expect(decisions[0].decision).toBe('confirmed-duplicate');
  });
});

// ── Conflicting source data & field provenance ───────────────────

describe('conflicting source data and provenance', () => {
  it('an extracted value never overwrites a user-entered value; both sources stay visible as evidence', () => {
    importCompaniesCsv([CSV_HEADER, row('Verde Grid', 'https://verdegrid.example.com')].join('\n'));
    const id = importedCompanies()[0].id;
    expect(getProvenance(id, 'city')!.origin).toBe('user-entered');

    // A discovery source claims a different city — conflict.
    saveCompany(fixtureCompany({
      id, name: 'Verde Grid', city: 'Denver', state: 'CO',
      evidence: [{ claim: 'Filing lists Denver, CO', source: 'SEC EDGAR', url: 'https://example.com/verde-filing', date: '2026-06-20', type: 'Filing' }],
    }), { origin: 'extracted', source: 'discovery:sec' });

    const company = getCompany(id)!;
    expect(company.city).toBe('Portland'); // user-entered value kept
    expect(getProvenance(id, 'city')!.origin).toBe('user-entered');
    // The conflicting claim is not lost — it sits in evidence for review.
    expect(company.evidence.some((e) => e.claim.includes('Denver'))).toBe(true);
  });

  it('never overwrites a verified value with an AI inference automatically', () => {
    saveCompany(fixtureCompany({ id: 'c-prov' }), { origin: 'user-entered', source: 'test' });
    // A human verifies the vertical.
    expect(applyFieldUpdate('c-prov', 'vertical', 'health', 'verified', 'partner confirmation').applied).toBe(true);
    // An AI inference tries to change it → refused.
    const attempt = applyFieldUpdate('c-prov', 'vertical', 'fintech', 'ai-inferred', 'model guess');
    expect(attempt.applied).toBe(false);
    expect(attempt.reason).toMatch(/verified/);
    expect(getCompany('c-prov')!.vertical).toBe('health');
    // An explicit manual override CAN change it (recorded as user-entered).
    expect(applyFieldUpdate('c-prov', 'vertical', 'fintech', 'ai-inferred', 'human accepted suggestion', { manualOverride: true }).applied).toBe(true);
    expect(getProvenance('c-prov', 'vertical')!.origin).toBe('user-entered');
  });

  it('records a versioned, explained scoring snapshot with supporting evidence', () => {
    importCompaniesCsv([CSV_HEADER, row('Scored Co')].join('\n'));
    const id = importedCompanies()[0].id;
    const snap = latestScore(id);
    expect(snap).not.toBeNull();
    expect(snap!.score).toBeGreaterThanOrEqual(1);
    expect(snap!.score).toBeLessThanOrEqual(10);
    expect(snap!.components.length).toBeGreaterThan(3);
    expect(snap!.components.reduce((s, c) => s + c.max, 0)).toBe(100); // weights stored
    expect(snap!.version).toMatch(/^v3/); // scoring version stored
    expect(snap!.evidenceConfidence).toBeGreaterThanOrEqual(0);
    expect(snap!.explanation).toContain('Vamos Fit Score'); // explanation stored
    expect(snap!.supportingEvidence.length).toBeGreaterThanOrEqual(1); // evidence URLs stored
    expect(snap!.computedAt).toMatch(/^\d{4}-/); // calculation date stored
  });
});
