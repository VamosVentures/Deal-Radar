import { z } from 'zod';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { portfolioCompanySchema } from '../../shared/integrations';
import { VERTICAL_ID_VALUES } from '../../shared/discovery';
import { EMPTY_CATEGORY, subverticalLabelsForSector } from '../enrichment/verticalClassifier';
import {
  addPossibleDuplicate, clearCsvImportedCompanies, listCompanies, matchRecords, saveCompany,
} from '../db/repos/companies';
import { saveScore } from '../db/repos/operations';
import { matchCompany } from '../sourcing/identity';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * Local CSV import. Rows pass the SAME guardrails as bundled data:
 * every company needs at least one sourced evidence item, and
 * demographic/identity data is NOT importable via CSV at all —
 * identity indicators require a verified basis + source and must be
 * entered through the reviewed data layer, never a bulk file.
 */

const VERTICALS = VERTICAL_ID_VALUES;
const STAGES = ['Pre-seed', 'Seed', 'Series A', 'Stealth', 'Unknown'] as const;
const EVIDENCE_TYPES = ['Filing', 'News', 'Founder statement', 'Product', 'Accelerator', 'Hiring signal', 'Database record'] as const;

export const importedCompanySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  oneLiner: z.string().min(3),
  vertical: z.enum(VERTICALS),
  subcategory: z.string().min(2),
  stage: z.enum(STAGES),
  city: z.string().min(1),
  state: z.string().length(2),
  foundedYear: z.coerce.number().int().min(1990).max(2100),
  teamSize: z.coerce.number().int().positive(),
  website: z.string().url().optional(),
  traction: z.object({ level: z.coerce.number().min(0).max(10), note: z.string().min(3) }),
  founders: z.array(z.object({
    name: z.string().min(2),
    role: z.string().min(1),
    background: z.string().min(3),
  })).min(1),
  evidence: z.array(z.object({
    claim: z.string().min(3),
    source: z.string().min(3),
    url: z.string().url(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(EVIDENCE_TYPES),
  })).min(1, 'Every imported company needs at least one sourced evidence item'),
  flags: z.array(z.enum(['defi-adjacent', 'hardware-heavy', 'outside-thesis'])).default([]),
  /** Recorded facts only — absent means unknown, never guessed. */
  raising: z.string().min(1).optional(),
  accelerator: z.string().min(1).optional(),
  lastFundingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lastRefreshed: z.string().optional(),
  imported: z.literal(true).default(true),
});
export type ImportedCompany = z.infer<typeof importedCompanySchema>;

/**
 * The value written to a NOT NULL column the source never stated.
 *
 * `founded_year` is NOT NULL (and cannot become nullable without
 * rebuilding a table 19 others cascade off), so a source that doesn't
 * publish a founding date still has to write SOMETHING. The number
 * itself is meaningless and must never be displayed as a fact: callers
 * pair it with `SaveOptions.unknownFields`, which records the field as
 * `missing` provenance so the UI renders "Missing" and any later real
 * value overwrites it.
 *
 * Deliberately NOT the current year, and not a plausible-looking recent
 * year: those are exactly what made the old fabricated values pass for
 * facts. 1990 is the schema's floor, so it is obviously a sentinel if it
 * ever leaks into a view that forgot to check provenance.
 */
export const PLACEHOLDER_FOUNDED_YEAR = 1990;

/**
 * Fields a CSV row supplies a SCHEMA-SATISFYING value for, without
 * actually stating a fact: an absent optional field, a subcategory typed
 * as a placeholder ("Unclassified — requires manual review") OR a real
 * Vamos taxonomy label imported for the WRONG sector (no less unstated
 * for being real text — Podium's own subcategory, 'consumer wellness',
 * belongs only to `health`'s taxonomy while its vertical is `fintech`),
 * the stage enum's own "Unknown" option, a city/state the analyst had no
 * information for, or a founded year sitting at the schema's floor (see
 * PLACEHOLDER_FOUNDED_YEAR above).
 *
 * `importCompaniesCsv` passes this to `saveCompany`'s `unknownFields`,
 * which records these as `missing` provenance instead of `user-entered`.
 * Before this existed, EVERY field on a CSV-imported company — including
 * ones the analyst had no information for and only filled with a
 * placeholder to satisfy validation — was stamped `user-entered`, the
 * second-highest precedence tier in the system. A blank website was
 * exactly as protected from later automated research as a value someone
 * had actually verified, so nothing the enrichment pipeline discovered
 * afterward could ever be written back: a live production company
 * (Podium) kept a wrong, already-fixed-in-code subcategory, and a
 * placeholder website that a passing enrichment run had correctly
 * re-discovered was silently rejected on write.
 */
export function placeholderFieldsFor(data: ImportedCompany): (
  'website' | 'subcategory' | 'stage' | 'city' | 'state' | 'foundedYear' | 'accelerator' | 'raising' | 'lastFundingDate'
)[] {
  const fields: (
    'website' | 'subcategory' | 'stage' | 'city' | 'state' | 'foundedYear' | 'accelerator' | 'raising' | 'lastFundingDate'
  )[] = [];
  if (!data.website) fields.push('website');
  if (EMPTY_CATEGORY.test(data.subcategory) || !subverticalLabelsForSector(data.vertical).has(data.subcategory.trim().toLowerCase())) {
    fields.push('subcategory');
  }
  if (data.stage === 'Unknown') fields.push('stage');
  if (/^unknown$/i.test(data.city)) fields.push('city');
  if (data.state === '??' || /^unknown$/i.test(data.state)) fields.push('state');
  if (data.foundedYear === PLACEHOLDER_FOUNDED_YEAR) fields.push('foundedYear');
  if (data.accelerator === undefined) fields.push('accelerator');
  if (data.raising === undefined) fields.push('raising');
  if (data.lastFundingDate === undefined) fields.push('lastFundingDate');
  return fields;
}

export const CSV_COLUMNS = [
  'name', 'oneLiner', 'vertical', 'subcategory', 'stage', 'city', 'state',
  'foundedYear', 'teamSize', 'tractionLevel', 'tractionNote',
  'founderName', 'founderRole', 'founderBackground',
  'evidenceClaim', 'evidenceSource', 'evidenceUrl', 'evidenceDate', 'evidenceType',
] as const;

/**
 * Minimal CSV parser: comma-separated with double-quote escaping.
 *
 * Parses the WHOLE text as one character stream rather than splitting on
 * newlines first — a quoted cell is allowed to contain a literal line
 * break (common in multi-paragraph descriptions), and only an unquoted
 * `\n` ends a row. An earlier version split on `\n` before interpreting
 * quotes at all, which silently shredded any such cell into extra rows
 * and misaligned every column after it.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  const pushCell = () => { row.push(cur); cur = ''; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"' && normalized[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') pushCell();
    else if (ch === '\n') pushRow();
    else cur += ch;
  }
  if (cur.length > 0 || row.length > 0) pushRow();

  // Trim every cell, and drop fully-blank rows — matches the previous
  // behavior of filtering out blank lines (e.g. a trailing newline at EOF).
  const trimmedRows = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => !(r.length === 1 && r[0] === ''));
  if (trimmedRows.length < 2) return [];

  const [header, ...dataRows] = trimmedRows;
  return dataRows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

export interface ImportReport {
  imported: number;
  skipped: { row: number; issues: string[] }[];
  total: number;
  /** Rows imported but flagged as possible duplicates awaiting human review. */
  possibleDuplicates: number;
}

export function importCompaniesCsv(csvText: string): ImportReport {
  const rows = parseCsv(csvText);
  const report: ImportReport = { imported: 0, skipped: [], total: rows.length, possibleDuplicates: 0 };
  // Identity/demographic columns are refused outright — see module docs.
  const forbidden = ['identity', 'latinoLed', 'femaleLed', 'demographics', 'ethnicity', 'gender', 'race'];
  const header = rows[0] ? Object.keys(rows[0]) : [];
  const badCols = header.filter((h) => forbidden.some((f) => h.toLowerCase().includes(f.toLowerCase())));
  if (badCols.length > 0) {
    throw Object.assign(
      new Error(`CSV import refused: demographic/identity columns are not importable (${badCols.join(', ')}). Identity indicators require verified sources and are entered through the reviewed data layer only.`),
      { status: 422 },
    );
  }

  rows.forEach((row, i) => {
    const candidate = {
      id: `imported-${slug(row.name ?? `row-${i}`)}`,
      name: row.name,
      oneLiner: row.oneLiner,
      vertical: row.vertical,
      subcategory: row.subcategory,
      stage: row.stage,
      city: row.city,
      state: row.state,
      foundedYear: row.foundedYear,
      teamSize: row.teamSize,
      website: row.website || undefined,
      raising: row.raising || undefined,
      accelerator: row.accelerator || undefined,
      lastFundingDate: row.lastFundingDate || undefined,
      traction: { level: row.tractionLevel, note: row.tractionNote },
      founders: [{ name: row.founderName, role: row.founderRole, background: row.founderBackground }],
      evidence: [{
        claim: row.evidenceClaim, source: row.evidenceSource, url: row.evidenceUrl,
        date: row.evidenceDate, type: row.evidenceType,
      }],
      flags: [],
      imported: true as const,
    };
    const parsed = importedCompanySchema.safeParse(candidate);
    if (!parsed.success) {
      report.skipped.push({
        row: i + 2, // 1-based + header
        issues: parsed.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`),
      });
      return;
    }
    // Deduplicate against everything already persisted. Exact matches
    // (domain / external id / hubspot id / normalized name) update the
    // existing record; possible matches import as NEW records and open
    // a possible-duplicate review item — never auto-merged.
    const match = matchCompany(
      { name: parsed.data.name, domain: parsed.data.website ?? null },
      matchRecords(),
    );
    const record = match.kind === 'exact' && match.record
      ? { ...parsed.data, id: match.record.id }
      : parsed.data;
    saveCompany(record, {
      origin: 'user-entered', source: 'local-csv', reviewStatus: 'New',
      unknownFields: placeholderFieldsFor(record),
    });
    saveScore(record.id, scoreCompany(record as unknown as Company), record.evidence.map((e) => e.url));
    if (match.kind === 'possible' && match.record) {
      addPossibleDuplicate({
        companyId: record.id,
        otherCompanyId: match.record.id,
        matchedBy: match.matchedBy!,
        similarity: match.similarity,
        detail: `CSV row "${record.name}" resembles existing "${match.record.name}" (${match.matchedBy}, similarity ${match.similarity.toFixed(2)}). Review before treating them as one company.`,
      });
      report.possibleDuplicates += 1;
    }
    report.imported += 1;
  });
  audit({
    provider: 'system', mode: 'local', action: 'csv-import', subject: 'local-csv',
    outcome: report.skipped.length === 0 ? 'ok' : 'blocked',
    detail: `${report.imported}/${report.total} rows imported; ${report.skipped.length} rejected by validation`,
  });
  return report;
}

export function importedCompanies(): ImportedCompany[] {
  return listCompanies();
}

/** Undoes a CSV import — and ONLY a CSV import. A company Deal Discovery surfaced is never touched here, regardless of its current review/HubSpot status. */
export function clearImportedCompanies(): void {
  clearCsvImportedCompanies();
}

export function savePortfolio(raw: unknown): { count: number } {
  const portfolio = z.array(portfolioCompanySchema).min(1).parse(raw);
  store.raw.portfolio = portfolio;
  store.save();
  audit({ provider: 'system', mode: 'local', action: 'portfolio-upload', subject: 'local-portfolio', outcome: 'ok', detail: `${portfolio.length} portfolio companies loaded` });
  return { count: portfolio.length };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}
