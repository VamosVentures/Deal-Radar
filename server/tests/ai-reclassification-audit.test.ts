import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations';

/**
 * The eighteen formerly-'ai' companies must each carry an INDIVIDUAL,
 * evidence-citing justification — not one blanket sentence repeated.
 *
 * Migration 15 reassigned all eighteen but wrote the same explanation
 * sixteen times. Migration 16 corrects the audit trail (it deliberately
 * changes no company's vertical; see its header for why each destination
 * survived re-audit). These tests read the migration SQL directly rather
 * than a database, because that is where the claim lives and it must be
 * true on every database the migration is ever applied to — including a
 * fresh one, where the INSERT...SELECTs match nothing at all.
 */

const MIGRATION_16 = MIGRATIONS.find((m) => m.version === 16)!;
const MIGRATION_15 = MIGRATIONS.find((m) => m.version === 15)!;

/** The sixteen that migration 15 gave the blanket reason to. */
const BLANKET_SIXTEEN = [
  'investor-ai fabrik', 'disc-cand-969', 'opp-agnost-ai', 'news-agon', 'investor-bespoke',
  'investor-fireworks', 'news-fish audio', 'news-general intuition', 'news-infinity',
  'news-multiverse', 'opp-onecli', 'disc-cand-972', 'disc-cand-1144', 'opp-tara-ai',
  'disc-cand-1150', 'disc-cand-1146',
];

/** The two migration 15 already justified individually. */
const ALREADY_INDIVIDUAL = ['news-greyparrot', 'opp-mireye'];

/**
 * Pull each `SELECT '<id>', '<reason>', '<confidence>', '<ambiguity>'`
 * tuple out of migration 16's UNION ALL block. Single quotes are escaped
 * SQL-style ('') inside the literals, so the pattern has to allow them.
 */
function auditEntries(): { id: string; body: string }[] {
  const out: { id: string; body: string }[] = [];
  const re = /SELECT\s+'((?:[^']|'')+)'(?:\s+AS\s+id)?,\s*\n\s*'((?:[^']|'')+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(MIGRATION_16.sql)) !== null) {
    out.push({ id: m[1].replace(/''/g, "'"), body: m[2].replace(/''/g, "'") });
  }
  return out;
}

describe('individual AI reclassification audit (migration 16)', () => {
  it('covers exactly the sixteen companies that received migration 15’s blanket reason', () => {
    const ids = auditEntries().map((e) => e.id);
    expect(ids.length).toBe(16);
    expect(new Set(ids)).toEqual(new Set(BLANKET_SIXTEEN));
  });

  it('gives every company a DISTINCT reason — no blanket explanation reused', () => {
    const reasons = auditEntries().map((e) => e.body);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('quotes the company’s own recorded text in every justification', () => {
    // Each reason must point at what the record actually says, not at a
    // category. A justification with no quoted evidence is the failure
    // mode this whole migration exists to fix.
    for (const { id, body } of auditEntries()) {
      const citesOwnText = /"[^"]{15,}"/.test(body) || /Own (?:YC )?description|Recorded evidence/.test(body);
      expect(citesOwnText, `${id}: reason cites no recorded text`).toBe(true);
      expect(body.length, `${id}: reason is too short to be a real judgment`).toBeGreaterThan(120);
    }
  });

  it('names the classification rule it applied', () => {
    for (const { id, body } of auditEntries()) {
      const namesRule = /Future of Work|Health & Wellness|FinTech|Sustainability|Frontier/.test(body);
      expect(namesRule, `${id}: reason names no destination vertical`).toBe(true);
    }
  });

  it('records a confidence level for every company, and admits the low-confidence ones', () => {
    // The first tuple in the UNION ALL carries `AS confidence` aliases; the rest are positional.
    const confidences = [...MIGRATION_16.sql.matchAll(/\n\s*'(high|medium|low)'(?:\s+AS\s+confidence)?,\n/g)]
      .map((m) => m[1]);
    expect(confidences.length).toBe(16);
    // The re-audit found genuinely thin evidence on several records. A
    // pass where everything is "high" would mean the confidence field is
    // decorative rather than a real assessment.
    expect(confidences.filter((c) => c === 'low').length).toBeGreaterThan(0);
  });

  it('changes no company’s vertical — it corrects the explanation only', () => {
    // Every audit row is written with previous_vertical = new_vertical
    // (both read from c.vertical), and the migration contains no UPDATE
    // against companies or company_vertical_classification.
    expect(MIGRATION_16.sql).toContain('SELECT c.id, c.name, c.vertical, c.vertical,');
    expect(/UPDATE\s+companies\b/i.test(MIGRATION_16.sql)).toBe(false);
    expect(/UPDATE\s+company_vertical_classification\b/i.test(MIGRATION_16.sql)).toBe(false);
  });

  it('preserves migration 15’s history rather than editing it', () => {
    // "Do not silently edit an already-applied migration": nothing in 16
    // may delete or rewrite the rows 15 wrote.
    expect(/DELETE\s+FROM\s+vertical_reclassification_log/i.test(MIGRATION_16.sql)).toBe(false);
    expect(/UPDATE\s+vertical_reclassification_log/i.test(MIGRATION_16.sql)).toBe(false);
    // And 15's own per-company rows for the two it did justify are untouched.
    for (const id of ALREADY_INDIVIDUAL) {
      expect(MIGRATION_15.sql).toContain(id);
    }
  });

  it('marks its rows as audit corrections, distinguishable from real reclassifications', () => {
    expect(MIGRATION_16.sql).toContain("'audit-correction'");
    expect(MIGRATION_16.sql).toContain("ADD COLUMN kind TEXT NOT NULL DEFAULT 'reclassification'");
  });

  it('flags, rather than hides, the records whose evidence conflicts or is out of thesis', () => {
    const byId = new Map(auditEntries().map((e) => [e.id, e]));
    const sql = MIGRATION_16.sql;
    // Agon: the one company for which migration 15's stated reason was
    // factually wrong — defence IS a market. The correction must say so.
    expect(byId.get('news-agon')!.body).toMatch(/defence/i);
    expect(sql).toMatch(/Agon[\s\S]{0,3000}?partner review/i);
    // Bespoke Labs: description says agent infrastructure, stored website
    // is a health domain. The conflict must be recorded, and health must
    // NOT have been inferred from the domain.
    expect(sql).toMatch(/bespoke\.health/);
    expect(sql).toMatch(/CONTRADICTS ITSELF/);
  });
});

/**
 * Migration 17 — the verified record corrections that came out of the
 * re-audit. Every one required fetching a primary source and reading
 * it; none is a judgement call, and each writes its own
 * field_corrections row naming the previous value and the evidence.
 */
const MIGRATION_17 = MIGRATIONS.find((m) => m.version === 17)!;

describe('verified record corrections (migration 17)', () => {
  it('does not edit an already-applied migration', () => {
    expect(MIGRATION_15.version).toBe(15);
    expect(MIGRATION_16.version).toBe(16);
    expect(MIGRATION_17.version).toBe(17);
    // 17 only ADDS; it never rewrites the audit trail 15 and 16 wrote.
    expect(/DELETE\s+FROM\s+vertical_reclassification_log/i.test(MIGRATION_17.sql)).toBe(false);
    expect(/UPDATE\s+vertical_reclassification_log/i.test(MIGRATION_17.sql)).toBe(false);
  });

  it('writes a field_corrections audit row for every change it makes', () => {
    const updates = [...MIGRATION_17.sql.matchAll(/UPDATE companies SET/g)].length;
    const audits = [...MIGRATION_17.sql.matchAll(/INSERT INTO field_corrections/g)].length;
    expect(audits).toBe(updates);
    expect(audits).toBe(5); // 2 websites, 2 subcategories, 1 flag
  });

  it('guards every change on the exact wrong value, so it is a no-op elsewhere', () => {
    // Each UPDATE must match BOTH the company id and the defective
    // value — otherwise re-running it could clobber a later human fix,
    // and applying it to a fresh database would invent changes.
    const updateStatements = MIGRATION_17.sql.split('UPDATE companies SET').slice(1);
    expect(updateStatements).toHaveLength(5);
    for (const stmt of updateStatements) {
      const where = stmt.split(';')[0];
      expect(where).toMatch(/WHERE id = '[^']+'/);
      expect(where, `guarded on the old value: ${where.slice(0, 120)}`).toMatch(/AND (?:website|subcategory|flags) = '/);
    }
  });

  it('cites a fetched primary source for each correction', () => {
    expect(MIGRATION_17.sql).toMatch(/bespokelabs\.ai/);
    expect(MIGRATION_17.sql).toMatch(/Ship Reliable AI Agents with SOTA Data Curation/);
    expect(MIGRATION_17.sql).toMatch(/greyparrot\.ai/);
    expect(MIGRATION_17.sql).toMatch(/Discover the Vibrant World of Grey Parrots/);
    expect(MIGRATION_17.sql).toMatch(/AI-Powered GTM Data/);
  });

  it('routes Agon to partner review via the exception flag rather than rejecting it', () => {
    expect(MIGRATION_17.sql).toMatch(/'\["outside-thesis"\]'/);
    expect(MIGRATION_17.sql).toMatch(/European/);
    // The vertical stays where migration 16 left it — still pending.
    expect(MIGRATION_17.sql).not.toMatch(/UPDATE companies SET vertical/);
  });

  it('refuses to correct a field it could not verify', () => {
    // Agon's subcategory is also wrong, but no primary source was
    // fetched for it. Guessing would be the exact failure this pass
    // exists to eliminate.
    expect(MIGRATION_17.sql).toMatch(/no primary source was successfully\s*--\s*fetched/);
    expect(MIGRATION_17.sql).not.toMatch(/news-agon'\s+AND subcategory/);
  });
});
