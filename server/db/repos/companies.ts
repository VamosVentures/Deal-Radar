import { getDb } from '../client';
import { normalizeCompanyKey, normalizeDomainKey, type MatchedBy, type MatchRecord } from '../../sourcing/identity';
import { TERMINAL_COMPANY_STATUSES, type CompanyStatus } from '../../../shared/integrations';
import { getStaleSettings } from './operations';
import type { ImportedCompany } from '../../services/imports';

/**
 * Company repository: companies + founders + evidence + external ids
 * + field provenance + possible-duplicate review items. This is the
 * primary store for every lead the app displays — each company keeps
 * at least one real evidence row with a source URL.
 */

const now = () => new Date().toISOString();

// ── Field provenance ─────────────────────────────────────────────

export type FieldOrigin = 'verified' | 'user-entered' | 'extracted' | 'ai-inferred' | 'unverified' | 'missing';

const ORIGIN_PRECEDENCE: Record<FieldOrigin, number> = {
  verified: 5,
  'user-entered': 4,
  extracted: 3,
  'ai-inferred': 2,
  unverified: 1,
  missing: 0,
};

const FIELD_COLUMNS: Record<string, string> = {
  name: 'name', website: 'website', oneLiner: 'one_liner', vertical: 'vertical',
  subcategory: 'subcategory', stage: 'stage', city: 'city', state: 'state',
  foundedYear: 'founded_year', teamSize: 'team_size',
  tractionLevel: 'traction_level', tractionNote: 'traction_note',
  raising: 'raising', accelerator: 'accelerator', lastFundingDate: 'last_funding_date',
};

export function getProvenance(companyId: string, field: string): { origin: FieldOrigin; source: string } | null {
  const row = getDb()
    .prepare('SELECT origin, source FROM field_provenance WHERE company_id = ? AND field = ?')
    .get(companyId, field) as { origin: FieldOrigin; source: string } | undefined;
  return row ?? null;
}

function writeProvenance(companyId: string, field: string, origin: FieldOrigin, source: string): void {
  getDb().prepare(`
    INSERT INTO field_provenance (company_id, field, origin, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (company_id, field) DO UPDATE SET origin = excluded.origin, source = excluded.source, updated_at = excluded.updated_at
  `).run(companyId, field, origin, source, now());
}

/**
 * Provenance-guarded field update. An automatic write never replaces
 * a value whose recorded origin outranks the incoming one — in
 * particular, a VERIFIED value is never overwritten by an AI
 * inference. A human can override explicitly with manualOverride,
 * which records the new origin as user-entered.
 */
export function applyFieldUpdate(
  companyId: string,
  field: keyof typeof FIELD_COLUMNS,
  value: string | number,
  origin: FieldOrigin,
  source: string,
  opts: { manualOverride?: boolean } = {},
): { applied: boolean; reason?: string } {
  const column = FIELD_COLUMNS[field];
  if (!column) return { applied: false, reason: `Unknown field "${field}".` };
  const existing = getProvenance(companyId, field);
  if (!opts.manualOverride && existing && ORIGIN_PRECEDENCE[origin] < ORIGIN_PRECEDENCE[existing.origin]) {
    return {
      applied: false,
      reason: `Kept existing ${existing.origin} value for "${field}" — a ${origin} value does not overwrite it automatically.`,
    };
  }
  getDb().prepare(`UPDATE companies SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, now(), companyId);
  writeProvenance(companyId, field, opts.manualOverride ? 'user-entered' : origin, source);
  return { applied: true };
}

// ── Rows ↔ domain shape ──────────────────────────────────────────

interface CompanyRow {
  id: string; name: string; normalized_name: string; domain: string | null; website: string | null;
  one_liner: string; vertical: string; subcategory: string; stage: string; city: string; state: string;
  founded_year: number; team_size: number; traction_level: number; traction_note: string;
  flags: string; status: string; merged_into: string | null; review_status: string | null;
  discovery_source: string | null; discovered_at: string | null; last_refreshed: string | null;
  hubspot_company_id: string | null; created_at: string; updated_at: string;
  raising: string | null; accelerator: string | null; last_funding_date: string | null;
}

function rowToCompany(row: CompanyRow): ImportedCompany {
  const db = getDb();
  const founders = db.prepare('SELECT name, role, background FROM founders WHERE company_id = ? ORDER BY position').all(row.id) as
    { name: string; role: string; background: string }[];
  const evidence = db.prepare('SELECT claim, source, url, date, type FROM evidence WHERE company_id = ? ORDER BY id').all(row.id) as
    { claim: string; source: string; url: string; date: string; type: string }[];
  return {
    id: row.id,
    name: row.name,
    oneLiner: row.one_liner,
    vertical: row.vertical as ImportedCompany['vertical'],
    subcategory: row.subcategory,
    stage: row.stage as ImportedCompany['stage'],
    city: row.city,
    state: row.state,
    foundedYear: row.founded_year,
    teamSize: row.team_size,
    website: row.website ?? undefined,
    raising: row.raising ?? undefined,
    accelerator: row.accelerator ?? undefined,
    lastFundingDate: row.last_funding_date ?? undefined,
    lastRefreshed: row.last_refreshed ?? undefined,
    traction: { level: row.traction_level, note: row.traction_note },
    founders,
    evidence: evidence as ImportedCompany['evidence'],
    flags: JSON.parse(row.flags),
    imported: true,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────

export interface CompanyMetaEntry {
  reviewStatus?: string;
  discoverySource?: string;
  discoveredAt?: string;
  lastRefreshed?: string;
  hubspotCompanyId?: string;
  /** Computed, never stored: true when a non-terminal company has gone unreviewed past the staleness threshold. */
  stale?: boolean;
  /** Per-field origin (verified / user-entered / extracted / ai-inferred / unverified). */
  provenance?: Record<string, FieldOrigin>;
  addedEvidence?: { claim: string; source: string; url: string; date: string; type: string }[];
}

export interface SaveOptions {
  origin: FieldOrigin;             // provenance for the fields this save provides
  source: string;                  // where the values came from (e.g. 'local-csv', 'discovery:sec')
  externalId?: { sourceId: string; externalId: string };
  reviewStatus?: string;
  discoverySource?: string;
  discoveredAt?: string;
  /** The sourcing run whose candidate became this company. Set only at creation, like discoveredAt. */
  discoveryRunId?: string;
  /**
   * Fields this save does NOT actually know, despite passing a value.
   *
   * Some columns are NOT NULL (`founded_year`, `team_size`) while the
   * source that produced the record never stated them — a funding
   * article names a round, not a founding date. The caller still has to
   * hand the schema a number, so without this the placeholder was
   * written with the same `origin` as genuinely sourced fields and
   * became indistinguishable from a fact.
   *
   * Listed fields get provenance `'missing'` instead, which is what the
   * UI reads to show "Missing" rather than the placeholder. Because
   * `missing` is the LOWEST precedence, any later real value overwrites
   * it automatically, and on the update path the placeholder is skipped
   * entirely so it can never overwrite a value already on record.
   */
  unknownFields?: readonly (keyof typeof FIELD_COLUMNS)[];
}

export function getCompany(id: string): ImportedCompany | null {
  const row = getDb().prepare("SELECT * FROM companies WHERE id = ? AND status = 'active'").get(id) as unknown as CompanyRow | undefined;
  return row ? rowToCompany(row) : null;
}

export function listCompanies(): ImportedCompany[] {
  const rows = getDb().prepare("SELECT * FROM companies WHERE status = 'active' ORDER BY created_at, id").all() as unknown as CompanyRow[];
  return rows.map(rowToCompany);
}

/**
 * Which adapter first produced this record.
 *
 * Needed because an absent field means different things depending on
 * where a record came from: an SEC filing always carries an address, so a
 * blank state means the address was non-US, whereas a funding article
 * often just does not mention where a company is based. Treating those
 * two as the same fact labelled real US companies as foreign entities.
 */
export function discoverySourceOf(companyId: string): string | null {
  const row = getDb().prepare('SELECT discovery_source FROM companies WHERE id = ?').get(companyId) as
    { discovery_source: string | null } | undefined;
  return row?.discovery_source ?? null;
}

/** The meta map served alongside companies (review chips, refresh dates, merged evidence). */
export function companyMetaView(): Record<string, CompanyMetaEntry> {
  const db = getDb();
  const rows = db.prepare("SELECT id, review_status, discovery_source, discovered_at, last_refreshed, hubspot_company_id, created_at FROM companies WHERE status = 'active'").all() as
    { id: string; review_status: string | null; discovery_source: string | null; discovered_at: string | null; last_refreshed: string | null; hubspot_company_id: string | null; created_at: string }[];
  const merged = db.prepare("SELECT company_id, claim, source, url, date, type FROM evidence WHERE added_by = 'merge' ORDER BY id").all() as
    { company_id: string; claim: string; source: string; url: string; date: string; type: string }[];
  const provenanceRows = db.prepare('SELECT company_id, field, origin FROM field_provenance').all() as
    { company_id: string; field: string; origin: FieldOrigin }[];
  const staleSettings = getStaleSettings();
  const out: Record<string, CompanyMetaEntry> = {};
  for (const r of rows) {
    const entry: CompanyMetaEntry = {};
    const status = (r.review_status ?? 'New') as CompanyStatus;
    if (r.review_status) entry.reviewStatus = r.review_status;
    if (r.discovery_source) entry.discoverySource = r.discovery_source;
    if (r.discovered_at) entry.discoveredAt = r.discovered_at;
    if (r.last_refreshed) entry.lastRefreshed = r.last_refreshed;
    if (r.hubspot_company_id) entry.hubspotCompanyId = r.hubspot_company_id;
    // Stale is computed, never stored: a non-terminal company that has
    // gone unreviewed/unrefreshed past the (admin-configurable)
    // threshold since the best "last looked at" signal we have
    // (refreshed → discovered → created). Monitor and Research Needed
    // can each be independently excluded via settings.
    const excluded =
      (TERMINAL_COMPANY_STATUSES as readonly string[]).includes(status)
      || (status === 'Monitor' && !staleSettings.monitorGoesStale)
      || (status === 'Research Needed' && !staleSettings.researchNeededGoesStale);
    if (!excluded) {
      const lastTouch = r.last_refreshed ?? r.discovered_at ?? r.created_at;
      const ageDays = (Date.now() - new Date(lastTouch).getTime()) / 86_400_000;
      if (ageDays > staleSettings.staleAfterDays) entry.stale = true;
    }
    if (Object.keys(entry).length > 0) out[r.id] = entry;
  }
  for (const pr of provenanceRows) {
    const entry = (out[pr.company_id] ??= {});
    (entry.provenance ??= {})[pr.field] = pr.origin;
  }
  for (const e of merged) {
    const entry = (out[e.company_id] ??= {});
    (entry.addedEvidence ??= []).push({ claim: e.claim, source: e.source, url: e.url, date: e.date, type: e.type });
  }
  return out;
}

/**
 * Insert or update a company by id. Provenance rules apply on update:
 * fields whose existing origin outranks the incoming one keep their
 * value; everything else is written and stamped. Founders are replaced
 * only when the incoming record provides them; evidence is append-only.
 */
/**
 * Persist a company and everything that belongs to it, ATOMICALLY.
 *
 * The write is not one statement — it is the company row, a provenance
 * row per field, a founders DELETE-then-INSERT, an evidence append and an
 * external-id insert. Without a transaction, a failure partway through
 * left a company with provenance for some fields and not others, or —
 * worse, on the update path — with its founders DELETED and the
 * replacements never inserted, because `replaceFounders` destroys before
 * it writes.
 *
 * `importCandidates` catches a per-candidate throw and reports it as
 * `failed` so one bad candidate cannot discard a whole batch, which is
 * correct; but it meant a "failed" candidate could still have left half a
 * company behind. Wrapping here makes that report true: a failed import
 * leaves nothing.
 *
 * Nested-safe: SQLite has no nested transactions, so if a caller already
 * opened one this participates in it rather than issuing a second BEGIN
 * (which would throw) — the outer boundary still governs rollback.
 */
function inTransaction<T>(fn: () => T): T {
  const db = getDb();
  /**
   * Take the boundary by TRYING to open it.
   *
   * node:sqlite exposes no autocommit flag, and a redundant BEGIN throws
   * when a transaction is already open — so the attempt is the test. If it
   * throws, an outer transaction owns the boundary and this call simply
   * participates in it; the outer COMMIT/ROLLBACK still governs. Probing
   * this way beats tracking nesting depth in module state, which drifts
   * the moment any other code path issues its own BEGIN.
   */
  let owns = true;
  try {
    db.exec('BEGIN');
  } catch {
    owns = false;
  }
  if (!owns) return fn();
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function saveCompany(record: ImportedCompany, opts: SaveOptions): { created: boolean } {
  return inTransaction(() => saveCompanyUnsafe(record, opts));
}

function saveCompanyUnsafe(record: ImportedCompany, opts: SaveOptions): { created: boolean } {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(record.id) as { id: string } | undefined;
  const domain = normalizeDomainKey(record.website ?? null);
  const ts = now();

  if (!existing) {
    db.prepare(`
      INSERT INTO companies (id, name, normalized_name, domain, website, one_liner, vertical, subcategory, stage,
        city, state, founded_year, team_size, traction_level, traction_note, flags, status,
        review_status, discovery_source, discovered_at, discovery_run_id, raising, accelerator, last_funding_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.name, normalizeCompanyKey(record.name), domain, record.website ?? null,
      record.oneLiner, record.vertical, record.subcategory, record.stage, record.city, record.state,
      record.foundedYear, record.teamSize, record.traction.level, record.traction.note,
      JSON.stringify(record.flags), opts.reviewStatus ?? null, opts.discoverySource ?? null,
      opts.discoveredAt ?? null, opts.discoveryRunId ?? null, record.raising ?? null, record.accelerator ?? null,
      record.lastFundingDate ?? null, ts, ts,
    );
    const unknown = new Set<string>(opts.unknownFields ?? []);
    for (const field of Object.keys(FIELD_COLUMNS)) {
      writeProvenance(
        record.id, field,
        unknown.has(field) ? 'missing' : opts.origin,
        unknown.has(field) ? `${opts.source} (did not state this field)` : opts.source,
      );
    }
    replaceFounders(record.id, record.founders);
    appendEvidence(record.id, record.evidence, opts.discoverySource ? 'discovery' : 'import');
    if (opts.externalId) addExternalId(record.id, opts.externalId.sourceId, opts.externalId.externalId);
    return { created: true };
  }

  // Update path — respect provenance per field.
  const updates: [keyof typeof FIELD_COLUMNS, string | number][] = [
    ['name', record.name], ['website', record.website ?? ''], ['oneLiner', record.oneLiner],
    ['vertical', record.vertical], ['subcategory', record.subcategory], ['stage', record.stage],
    ['city', record.city], ['state', record.state], ['foundedYear', record.foundedYear],
    ['teamSize', record.teamSize], ['tractionLevel', record.traction.level], ['tractionNote', record.traction.note],
    ...(record.raising !== undefined ? [['raising', record.raising] as [keyof typeof FIELD_COLUMNS, string]] : []),
    ...(record.accelerator !== undefined ? [['accelerator', record.accelerator] as [keyof typeof FIELD_COLUMNS, string]] : []),
    ...(record.lastFundingDate !== undefined ? [['lastFundingDate', record.lastFundingDate] as [keyof typeof FIELD_COLUMNS, string]] : []),
  ];
  // A field the caller flagged as not-actually-known carries a
  // schema-satisfying placeholder, never a fact. Skipping it here is the
  // point: on a re-import it must not overwrite a value another source
  // did establish, and `applyFieldUpdate` alone would not stop it —
  // 'extracted' outranks nothing when the incoming origin is the same.
  const unknownOnUpdate = new Set<string>(opts.unknownFields ?? []);
  for (const [field, value] of updates) {
    if (unknownOnUpdate.has(field)) continue;
    applyFieldUpdate(record.id, field, value, opts.origin, opts.source);
  }
  db.prepare('UPDATE companies SET normalized_name = ?, domain = ?, flags = ?, updated_at = ? WHERE id = ?')
    .run(normalizeCompanyKey(record.name), domain, JSON.stringify(record.flags), ts, record.id);
  if (record.founders.length > 0) replaceFounders(record.id, record.founders);
  appendEvidence(record.id, record.evidence, opts.discoverySource ? 'discovery' : 'import');
  if (opts.externalId) addExternalId(record.id, opts.externalId.sourceId, opts.externalId.externalId);
  // reviewStatus is an INITIAL status for brand-new records only — a
  // routine re-import (e.g. re-uploading the same CSV) must never reset
  // a company's review progress back to its starting status.
  return { created: false };
}

function replaceFounders(companyId: string, founders: ImportedCompany['founders']): void {
  const db = getDb();
  db.prepare('DELETE FROM founders WHERE company_id = ?').run(companyId);
  const insert = db.prepare('INSERT INTO founders (company_id, position, name, role, background) VALUES (?, ?, ?, ?, ?)');
  founders.forEach((f, i) => insert.run(companyId, i, f.name, f.role, f.background));
}

/** Append-only; rows with an already-cited URL are skipped so re-imports don't duplicate evidence. */
export function appendEvidence(
  companyId: string,
  evidence: { claim: string; source: string; url: string; date: string; type: string }[],
  addedBy: 'import' | 'discovery' | 'merge' | 'user',
): number {
  const db = getDb();
  const existing = new Set(
    (db.prepare('SELECT url FROM evidence WHERE company_id = ?').all(companyId) as { url: string }[]).map((r) => r.url),
  );
  const insert = db.prepare('INSERT INTO evidence (company_id, claim, source, url, date, type, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const e of evidence) {
    if (existing.has(e.url)) continue;
    insert.run(companyId, e.claim, e.source, e.url, e.date, e.type, addedBy, now());
    existing.add(e.url);
    added += 1;
  }
  return added;
}

/**
 * Replace placeholder founder rows with a researched, verified person.
 *
 * The enrichment tables are the system of record for founder research,
 * but three things read the `founders` TABLE and cannot see them: the
 * fit score's founder component, the HubSpot contact builder, and the
 * outreach drafter. So a company with a confirmed founder still scored
 * as having no founder evidence and still offered "Unknown founder" as
 * an outreach target.
 *
 * Only PLACEHOLDER rows are replaced. A real name already on the record
 * — from an import, or a human — is left alone, because this is a
 * derived write and it must not overwrite a stronger source.
 */
export function setResolvedFounder(
  companyId: string,
  founder: { name: string; role: string; background: string },
): boolean {
  return setResolvedFounders(companyId, [founder]);
}

/**
 * Replace the "Unknown founder" placeholder with EVERY founder research
 * verified — not just the first one.
 *
 * The bug this fixes was visible the moment the four pilot companies were
 * materialized: `founder_candidates` held all of them with status
 * `verified-founder` (Manifold 2, Grade 2, Unifold 3, Scheduling Wizard
 * 3), and the `founders` table — the one the UI, the scorer, the HubSpot
 * contact builder and the outreach drafter all read — held exactly one
 * each. A three-founder company was displayed as a one-founder company,
 * and the co-founders were sitting in the database the whole time.
 *
 * The single-founder shape came from `deriveFounderStatus` resolving one
 * PRIMARY founder, which is a different question ("who is the contact?")
 * from "who founded this company?". Both answers are wanted; only one was
 * being stored.
 *
 * The placeholder guard is unchanged and still load-bearing: if a real
 * person is already recorded — by a human, an import, or an earlier run —
 * nothing is deleted and this returns false. So an analyst's correction
 * can never be overwritten by a later automated pass, and the DELETE only
 * ever removes placeholder rows.
 */
export function setResolvedFounders(
  companyId: string,
  founders: { name: string; role: string; background: string }[],
): boolean {
  if (founders.length === 0) return false;
  const db = getDb();
  const rows = db.prepare('SELECT id, name FROM founders WHERE company_id = ? ORDER BY position')
    .all(companyId) as { id: number; name: string }[];
  const isPlaceholder = (n: string) => !n?.trim() || /\bunknown\b/i.test(n);
  const realOnes = rows.filter((r) => !isPlaceholder(r.name));
  // Somebody real is already recorded, including possibly these people.
  if (realOnes.length > 0) return false;

  // De-duplicate on the normalized name so a person named by two sources
  // is stored once. YC renders each founder twice (desktop + mobile) and
  // the parser already collapses that, but this path also receives
  // candidates merged from several source families.
  const seen = new Set<string>();
  const unique = founders.filter((f) => {
    const k = f.name.toLowerCase().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return false;

  /**
   * One transaction. A DELETE followed by N INSERTs that fails partway
   * through would leave a company with FEWER founders than it started
   * with — destroying rows to add rows is only safe if the pair is
   * atomic.
   */
  db.exec('BEGIN');
  try {
    for (const r of rows) db.prepare('DELETE FROM founders WHERE id = ?').run(r.id);
    const insert = db.prepare('INSERT INTO founders (company_id, position, name, role, background) VALUES (?, ?, ?, ?, ?)');
    unique.forEach((f, i) => insert.run(companyId, i, f.name, f.role, f.background));
    db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(now(), companyId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

export function addExternalId(companyId: string, sourceId: string, externalId: string): void {
  getDb().prepare('INSERT OR IGNORE INTO company_external_ids (company_id, source_id, external_id) VALUES (?, ?, ?)')
    .run(companyId, sourceId, externalId);
}

export function setCompanyMeta(
  id: string,
  meta: { reviewStatus?: string | null; lastRefreshed?: string; hubspotCompanyId?: string },
): void {
  const db = getDb();
  if (meta.reviewStatus !== undefined) db.prepare('UPDATE companies SET review_status = ?, updated_at = ? WHERE id = ?').run(meta.reviewStatus, now(), id);
  if (meta.lastRefreshed !== undefined) db.prepare('UPDATE companies SET last_refreshed = ?, updated_at = ? WHERE id = ?').run(meta.lastRefreshed, now(), id);
  if (meta.hubspotCompanyId !== undefined) db.prepare('UPDATE companies SET hubspot_company_id = ?, updated_at = ? WHERE id = ?').run(meta.hubspotCompanyId, now(), id);
}

/** Stamp last_refreshed on the given ids (only rows that exist change). */
export function markRefreshed(ids: string[], date: string): number {
  const db = getDb();
  const stmt = db.prepare("UPDATE companies SET last_refreshed = ? WHERE id = ? AND status = 'active'");
  let updated = 0;
  for (const id of ids) updated += Number(stmt.run(date, id).changes);
  return updated;
}

export function clearCompanies(): void {
  getDb().exec('DELETE FROM companies'); // founders/evidence/etc. cascade
}

/** Pool for the identity-matching service. */
export function matchRecords(): MatchRecord[] {
  const db = getDb();
  const rows = db.prepare("SELECT id, name, domain, hubspot_company_id FROM companies WHERE status = 'active'").all() as
    { id: string; name: string; domain: string | null; hubspot_company_id: string | null }[];
  const externals = db.prepare('SELECT company_id, source_id, external_id FROM company_external_ids').all() as
    { company_id: string; source_id: string; external_id: string }[];
  const founders = db.prepare('SELECT company_id, name FROM founders').all() as { company_id: string; name: string }[];
  const extByCompany = new Map<string, { sourceId: string; externalId: string }[]>();
  for (const e of externals) {
    (extByCompany.get(e.company_id) ?? extByCompany.set(e.company_id, []).get(e.company_id)!)
      .push({ sourceId: e.source_id, externalId: e.external_id });
  }
  const foundersByCompany = new Map<string, string[]>();
  for (const f of founders) {
    (foundersByCompany.get(f.company_id) ?? foundersByCompany.set(f.company_id, []).get(f.company_id)!).push(f.name);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: 'company' as const,
    name: r.name,
    domain: r.domain,
    hubspotId: r.hubspot_company_id,
    externalIds: extByCompany.get(r.id) ?? [],
    founderNames: foundersByCompany.get(r.id) ?? [],
  }));
}

// ── Possible-duplicate review state ──────────────────────────────

export interface PossibleDuplicate {
  id: number;
  companyId: string;
  otherCompanyId: string | null;
  matchedBy: MatchedBy;
  similarity: number;
  detail: string;
  status: 'pending' | 'confirmed-duplicate' | 'not-duplicate';
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export function addPossibleDuplicate(args: {
  companyId: string;
  otherCompanyId: string;
  matchedBy: MatchedBy;
  similarity: number;
  detail: string;
}): number {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM possible_duplicates
    WHERE status = 'pending' AND company_id = ? AND other_company_id = ?
  `).get(args.companyId, args.otherCompanyId) as { id: number } | undefined;
  if (existing) return existing.id;
  const res = db.prepare(`
    INSERT INTO possible_duplicates (company_id, other_company_id, matched_by, similarity, detail, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(args.companyId, args.otherCompanyId, args.matchedBy, args.similarity, args.detail, now());
  return Number(res.lastInsertRowid);
}

export function listPossibleDuplicates(status?: PossibleDuplicate['status']): PossibleDuplicate[] {
  const db = getDb();
  const rows = (status
    ? db.prepare('SELECT * FROM possible_duplicates WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM possible_duplicates ORDER BY id DESC').all()) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    companyId: r.company_id as string,
    otherCompanyId: (r.other_company_id as string | null) ?? null,
    matchedBy: r.matched_by as MatchedBy,
    similarity: r.similarity as number,
    detail: r.detail as string,
    status: r.status as PossibleDuplicate['status'],
    createdAt: r.created_at as string,
    resolvedBy: (r.resolved_by as string | null) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  }));
}

/**
 * Resolve a possible duplicate. 'confirmed-duplicate' merges the newer
 * record (companyId) into the existing one (otherCompanyId): evidence
 * is appended, the newer record is marked merged (kept, not deleted).
 * 'not-duplicate' keeps both records active. Low-confidence matches
 * are NEVER merged without this explicit human decision.
 */
export function resolvePossibleDuplicate(
  id: number,
  resolution: 'confirmed-duplicate' | 'not-duplicate',
  actor: string,
): PossibleDuplicate {
  const db = getDb();
  const dup = listPossibleDuplicates().find((d) => d.id === id);
  if (!dup) throw Object.assign(new Error('Possible-duplicate item not found.'), { status: 404 });
  if (dup.status !== 'pending') throw Object.assign(new Error(`Already resolved as ${dup.status}.`), { status: 409 });

  if (resolution === 'confirmed-duplicate' && dup.otherCompanyId) {
    const newer = getCompany(dup.companyId);
    if (newer) {
      appendEvidence(dup.otherCompanyId, newer.evidence, 'merge');
      db.prepare("UPDATE companies SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?")
        .run(dup.otherCompanyId, now(), dup.companyId);
    }
  }
  db.prepare('UPDATE possible_duplicates SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(resolution, actor, now(), id);
  return listPossibleDuplicates().find((d) => d.id === id)!;
}
