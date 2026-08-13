import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkEntityType, classifyPossessiveName } from '../sourcing/classify';

/**
 * A full requalification must not talk over a finding it cannot make.
 *
 * `scripts/qualify-all.ts` rewrites every disqualified record's
 * quarantine reason from the qualifier's verdict. That is right for
 * evidence-based verdicts, which change as evidence arrives. It was
 * wrong for one class of finding: "Travis Kalanick's robotics company"
 * is not a company name, no future filing can make it one, and the
 * qualifier could not derive that — so every pass replaced the specific
 * explanation with a generic "Insufficient evidence".
 *
 * The fix is re-derivation, not memory: extraction and qualification now
 * share one detector, so the qualifier reaches the specific verdict by
 * itself on every pass.
 *
 * These tests drive the REAL script against a throwaway database. A unit
 * test of qualifyIssuer would not have caught the original bug, because
 * the bug was in what the script did with the verdict afterwards.
 */

const projectRoot = path.resolve(__dirname, '..', '..');
// Windows requires a file:// URL for a dynamic import() with an absolute
// path — a raw 'C:\...' string isn't a valid ESM specifier.
const projectRootUrl = pathToFileURL(projectRoot).href;
let dir: string;
let dbPath: string;

// Invoke tsx's own CLI script directly via the Node binary, rather than
// 'npx tsx' — 'npx' is a .cmd shim on Windows, not a .exe, and spawning it
// needs either shell: true (which Node now warns is unsafe with an args
// array — DEP0190) or a platform-specific 'npx.cmd' resolution (which
// Node refuses to run directly as a hardened-by-default guard against
// batch-file argument injection). Going straight to Node with tsx's CLI
// script avoids the shell entirely, on every OS.
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function run(body: string): string {
  const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.mts`);
  fs.writeFileSync(file, body);
  return execFileSync(process.execPath, [tsxCli, file], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'requal-test' },
    encoding: 'utf8',
  });
}

/** The real script, offline so no live request is made. */
function qualifyAll(): string {
  return execFileSync(process.execPath, [tsxCli, 'scripts/qualify-all.ts', '--offline'], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'requal-test' },
    encoding: 'utf8',
  });
}

interface Row { id: string; quarantined: number; reason: string | null; result: string; classification: string }

function state(): Record<string, Row> {
  const out = run(`
    const { getDb } = await import('${projectRootUrl}/server/db/client.ts');
    const rows = getDb().prepare(\`
      SELECT c.id AS id, c.quarantined AS quarantined, c.quarantine_reason AS reason,
             q.result AS result, o.classification AS classification
        FROM companies c
        LEFT JOIN issuer_qualification q ON q.company_id = c.id
        LEFT JOIN company_opportunity o ON o.company_id = c.id
    \`).all();
    console.log('@@' + JSON.stringify(rows) + '@@');
  `);
  const json = out.split('@@')[1];
  return Object.fromEntries((JSON.parse(json) as Row[]).map((r) => [r.id, r]));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-requal-'));
  dbPath = path.join(dir, 'requal.db');

  run(`
    const { saveCompany } = await import('${projectRootUrl}/server/db/repos/companies.ts');
    const { addDealEvidence } = await import('${projectRootUrl}/server/db/repos/opportunities.ts');
    const { getDb } = await import('${projectRootUrl}/server/db/client.ts');

    const base = (id, name, over = {}) => ({
      id, name,
      oneLiner: over.oneLiner ?? 'Builds something specific and describable.',
      vertical: 'robotics', subcategory: 'Industrial & warehouse automation',
      stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2026, teamSize: 4,
      website: over.website,
      traction: { level: 0, note: 'Unknown' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
      evidence: [{ claim: 'Article', source: 'techcrunch.com', url: over.url, date: '2026-07-22', type: 'Press' }],
      flags: [], imported: true,
    });
    const press = (url, publisher) => ({
      opportunityType: 'funding-announcement', sourceId: 'funding-news',
      sourceName: publisher + ' (public RSS)', tier: 2, url,
      publishedAt: '2026-07-22', retrievedAt: '2026-07-29',
      summary: 'Reported a funding round.', whyCurrent: 'Recent.',
      amountUsd: 1700000000, amountText: '$1.7B', roundType: null, investors: [], confidence: 0.65,
    });

    // 1. The record this bug was about. Curly apostrophe, exactly as the
    //    publisher printed it.
    saveCompany(base('kalanick', 'Travis Kalanick’s robotics company', {
      oneLiner: 'Unknown — not stated by the source',
      url: 'https://techcrunch.com/2026/07/22/travis-kalanicks-robotics-company-raises-1-7b/',
    }), { origin: 'extracted', source: 'test', discoverySource: 'funding-news' });
    addDealEvidence('kalanick', press('https://techcrunch.com/2026/07/22/travis-kalanicks-robotics-company-raises-1-7b/', 'techcrunch.com'));

    // 2. An ordinary thin record — its generic reason SHOULD keep updating.
    saveCompany(base('thin-co', 'Quietly Ltd', {
      oneLiner: 'Unknown — not stated by the source',
      url: 'https://techcrunch.com/2026/07/22/quietly-raises/',
    }), { origin: 'extracted', source: 'test', discoverySource: 'funding-news' });
    addDealEvidence('thin-co', press('https://techcrunch.com/2026/07/22/quietly-raises/', 'techcrunch.com'));
    // A stale reason from an earlier pass, which must be replaced.
    getDb().prepare("UPDATE companies SET quarantined = 1, quarantine_reason = 'Stale reason from an earlier pass.', quarantined_at = '2026-01-01T00:00:00.000Z' WHERE id = 'thin-co'").run();

    // 3. A real company whose real name owns an apostrophe.
    saveCompany(base('apostrophe-co', "Lowe’s Companies, Inc.", {
      website: 'https://example.com',
      url: 'https://techcrunch.com/2026/07/22/lowes-raises/',
    }), { origin: 'extracted', source: 'test', discoverySource: 'funding-news' });
    addDealEvidence('apostrophe-co', press('https://techcrunch.com/2026/07/22/lowes-raises/', 'techcrunch.com'));
    addDealEvidence('apostrophe-co', press('https://siliconangle.com/2026/07/22/lowes-raises/', 'siliconangle.com'));
    console.log('seeded');
  `);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the shared entity-name detector', () => {
  it('recognises a possessive that describes rather than names', () => {
    for (const name of [
      'Travis Kalanick’s robotics company',
      "Travis Kalanick's robotics company",
      "Elon Musk's AI startup",
      "Sam Altman's new venture",
    ]) {
      expect(classifyPossessiveName(name).kind, name).toBe('possessive-descriptor');
      expect(checkEntityType(name).isOperatingCompany, name).toBe(false);
      expect(checkEntityType(name).kind, name).toBe('person-possessive');
    }
  });

  it('does not reject a real company merely for owning an apostrophe', () => {
    for (const name of [
      "Lowe’s Companies, Inc.",
      "McDonald's Corporation",
      "Ben's Original",
      "Trader Joe's",
      "Dunkin' Donuts",
      "O'Reilly Media",
      "Moe's Southwest Grill",
    ]) {
      expect(checkEntityType(name).isOperatingCompany, name).toBe(true);
      expect(classifyPossessiveName(name).kind, name).not.toBe('possessive-descriptor');
    }
  });

  it('reports the owner and the descriptor separately, so the reason can quote them', () => {
    const v = classifyPossessiveName('Travis Kalanick’s robotics company');
    expect(v).toMatchObject({ kind: 'possessive-descriptor', owner: 'Travis Kalanick', descriptor: 'robotics company' });
  });
});

describe('a full requalification pass', () => {
  it('reaches the specific entity verdict instead of a generic one, and stays there', () => {
    const first = qualifyAll();
    expect(first).toContain('Not a company name');
    const afterFirst = state();

    const k = afterFirst.kalanick;
    expect(k.result).toBe('not-a-company-name');
    expect(k.quarantined).toBe(1);
    expect(k.classification).toBe('company-lead');
    // The specific finding, regenerated rather than remembered.
    expect(k.reason).toContain('Not a company name');
    expect(k.reason).toContain('Travis Kalanick');
    expect(k.reason).toContain('robotics company');
    expect(k.reason).not.toMatch(/^Insufficient evidence/);

    // An ordinary evidence-based verdict still refreshes its reason.
    expect(afterFirst['thin-co'].reason).not.toContain('Stale reason from an earlier pass.');
    expect(afterFirst['thin-co'].reason).toContain('Insufficient evidence');

    // A real name with an apostrophe is untouched by any of this.
    expect(afterFirst['apostrophe-co'].result).not.toBe('not-a-company-name');
    expect(afterFirst['apostrophe-co'].quarantined).toBe(0);

    // Idempotent: a second pass changes nothing at all.
    const second = qualifyAll();
    expect(second).toContain('classification changed: 0');
    const afterSecond = state();
    for (const id of ['kalanick', 'thin-co', 'apostrophe-co']) {
      expect(afterSecond[id].result, id).toBe(afterFirst[id].result);
      expect(afterSecond[id].quarantined, id).toBe(afterFirst[id].quarantined);
      expect(afterSecond[id].reason, id).toBe(afterFirst[id].reason);
      expect(afterSecond[id].classification, id).toBe(afterFirst[id].classification);
    }
  }, 180_000);
});
