import { z } from 'zod';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { portfolioCompanySchema } from '../../shared/integrations';
import { VERTICAL_ID_VALUES } from '../../shared/discovery';
import {
  addPossibleDuplicate, clearCompanies, listCompanies, matchRecords, saveCompany,
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
const STAGES = ['Pre-seed', 'Seed', 'Series A', 'Stealth'] as const;
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

export const CSV_COLUMNS = [
  'name', 'oneLiner', 'vertical', 'subcategory', 'stage', 'city', 'state',
  'foundedYear', 'teamSize', 'tractionLevel', 'tractionNote',
  'founderName', 'founderRole', 'founderBackground',
  'evidenceClaim', 'evidenceSource', 'evidenceUrl', 'evidenceDate', 'evidenceType',
] as const;

/** Minimal CSV parser: comma-separated with double-quote escaping. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
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
    saveCompany(record, { origin: 'user-entered', source: 'local-csv', reviewStatus: 'New' });
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

export function clearImportedCompanies(): void {
  clearCompanies();
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
