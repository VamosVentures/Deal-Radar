import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { store } from '../lib/store';
import { getStaleSettings, setStaleSettings } from '../db/repos/operations';
import { saveCompany, companyMetaView } from '../db/repos/companies';
import { staleSettingsSchema, DEFAULT_STALE_SETTINGS } from '../../shared/integrations';
import { adminAgent } from './testAuth';
import request from 'supertest';
import { createApp } from '../app';
import type { ImportedCompany } from '../services/imports';

beforeEach(() => store.resetForTests());
afterEach(() => vi.useRealTimers());

function fixtureCompany(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'stale-fixture-co', name: 'Stale Fixture Co', oneLiner: 'Fixture pitch text', vertical: 'health',
    subcategory: 'Care', stage: 'Seed', city: 'Austin', state: 'TX', foundedYear: 2024, teamSize: 3,
    traction: { level: 5, note: 'Fixture traction note' },
    founders: [{ name: 'Founder One', role: 'CEO', background: 'Fixture background' }],
    evidence: [{ claim: 'Fixture claim', source: 'Fixture', url: 'https://example.com/stale-fixture', date: '2026-01-01', type: 'News' }],
    flags: [], imported: true,
    ...over,
  };
}

describe('stale-record settings', () => {
  it('defaults to 30 days, all statuses eligible, visible on Overview', () => {
    expect(getStaleSettings()).toEqual(DEFAULT_STALE_SETTINGS);
    expect(getStaleSettings().staleAfterDays).toBe(30);
    expect(getStaleSettings().monitorGoesStale).toBe(true);
    expect(getStaleSettings().researchNeededGoesStale).toBe(true);
    expect(getStaleSettings().showStaleOnOverview).toBe(true);
  });

  it('an updated value takes effect immediately, no restart needed', () => {
    const createdAt = Date.now();
    saveCompany(fixtureCompany(), { origin: 'user-entered', source: 'test' });
    vi.useFakeTimers();
    vi.setSystemTime(createdAt + 5 * 86_400_000); // 5 days after creation
    setStaleSettings({ staleAfterDays: 3 });
    expect(companyMetaView()['stale-fixture-co'].stale).toBe(true);

    setStaleSettings({ staleAfterDays: 30 });
    expect(companyMetaView()['stale-fixture-co'].stale).toBeUndefined();
  });

  it('never flags a terminal status (Passed / Synced to HubSpot) regardless of age', () => {
    saveCompany(fixtureCompany({ id: 'stale-terminal-co' }), { origin: 'user-entered', source: 'test', reviewStatus: 'Passed' });
    setStaleSettings({ staleAfterDays: 1 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    expect(companyMetaView()['stale-terminal-co']?.stale).toBeUndefined();
  });

  it('excludes Monitor when monitorGoesStale is false', () => {
    saveCompany(fixtureCompany({ id: 'stale-monitor-co' }), { origin: 'user-entered', source: 'test', reviewStatus: 'Monitor' });
    setStaleSettings({ staleAfterDays: 1, monitorGoesStale: false });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    expect(companyMetaView()['stale-monitor-co']?.stale).toBeUndefined();

    setStaleSettings({ monitorGoesStale: true });
    expect(companyMetaView()['stale-monitor-co']?.stale).toBe(true);
  });

  it('excludes Research Needed when researchNeededGoesStale is false', () => {
    saveCompany(fixtureCompany({ id: 'stale-research-co' }), { origin: 'user-entered', source: 'test', reviewStatus: 'Research Needed' });
    setStaleSettings({ staleAfterDays: 1, researchNeededGoesStale: false });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    expect(companyMetaView()['stale-research-co']?.stale).toBeUndefined();
  });

  it('rejects out-of-range values', () => {
    expect(staleSettingsSchema.partial().safeParse({ staleAfterDays: 0 }).success).toBe(false);
    expect(staleSettingsSchema.partial().safeParse({ staleAfterDays: 366 }).success).toBe(false);
    expect(staleSettingsSchema.partial().safeParse({ maxStaleOnOverview: 0 }).success).toBe(false);
    expect(staleSettingsSchema.partial().safeParse({ defaultStaleFilter: 'bogus' }).success).toBe(false);
  });

  it('GET and PUT both require an authenticated admin session; PUT rejects invalid values over HTTP', async () => {
    const app = createApp();
    // Both the read and the write sit behind the whole-application gate now.
    const anonGet = await request(app).get('/api/stale-settings');
    expect(anonGet.status).toBe(401);

    const denied = await request(app).put('/api/admin/stale-settings').send({ staleAfterDays: 10 });
    expect(denied.status).toBe(401);

    const agent = await adminAgent(app);
    const read = await agent.get('/api/stale-settings');
    expect(read.status).toBe(200);
    expect(read.body.staleAfterDays).toBe(30);

    const bad = await agent.put('/api/admin/stale-settings').send({ staleAfterDays: 999 });
    expect(bad.status).toBe(400);

    const good = await agent.put('/api/admin/stale-settings').send({ staleAfterDays: 45 });
    expect(good.status).toBe(200);
    expect(good.body.staleAfterDays).toBe(45);
    // Unspecified fields are preserved, not reset to schema defaults.
    expect(good.body.monitorGoesStale).toBe(true);
  });

  it('persists across a real process restart (two separate processes, one DB file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-stale-'));
    const dbPath = path.join(dir, 'stale-restart-test.db');
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

    runScript(`
      const { setStaleSettings } = await import('${projectRoot}/server/db/repos/operations');
      setStaleSettings({ staleAfterDays: 77, monitorGoesStale: false });
      console.log('SAVED');
    `);

    const out = runScript(`
      const { getStaleSettings } = await import('${projectRoot}/server/db/repos/operations');
      console.log(JSON.stringify(getStaleSettings()));
    `);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.staleAfterDays).toBe(77);
    expect(result.monitorGoesStale).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
