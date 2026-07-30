import type { Company, FitScore } from '../types';
import {
  QUALIFICATION_LABELS, WEBSITE_EVIDENCE_LABELS,
  type QualificationResult, type WebsiteEvidenceLevel,
} from '../../shared/qualification';

/**
 * CSV export of the company review queue.
 *
 * Exports exactly what is on screen — the filtered, sorted rows — because
 * an export that silently differs from the view it was triggered from is
 * worse than no export.
 *
 * Every judgement travels with the caveat that qualifies it: the fit score
 * carries its completeness and provisional flag, the classification
 * carries the qualification verdict that gated it, and a quarantined
 * record carries its reason. A spreadsheet outlives the screen it came
 * from, so a number that needed context on screen needs it more here.
 *
 * INTERNAL NOTES ARE DELIBERATELY ABSENT.
 *
 * Note bodies carry candid investment-team opinion — a read on a founder,
 * a reason for passing — written on the understanding that they stay
 * inside the tool. This file is the export path, and a CSV is the single
 * easiest artifact to forward by accident. The omission is structural
 * rather than a filter applied here: ExportRow has no note field, and
 * /api/companies/imported (the only bulk payload the UI holds) never
 * returns note bodies at all, so there is nothing on this side of the
 * boundary to leak. Notes come from /api/companies/:id/notes alone.
 *
 * A per-company note COUNT was considered and left out. It would need
 * note data plumbed into the bulk company payload — reintroducing
 * exactly the coupling this separation exists to prevent — to tell a
 * reader something they learn by opening the company. See
 * server/tests/notes.test.ts for the test that holds this line.
 */

export interface ExportRow {
  company: Company;
  fit: FitScore;
  opportunity?: { classification: string; primarySourceId: string; primaryTier: number; evidenceUrl: string; evidencePublishedAt: string | null; amountText: string | null; roundType: string | null } | undefined;
  qualification?: {
    result: string;
    /** Independent FINANCING sources — never the company's own website. */
    corroboratingSources: unknown[];
    /** What the issuer's own site established. Separate question, separate column. */
    operatingEvidence?: { level: WebsiteEvidenceLevel } | undefined;
  } | undefined;
  quarantine?: { reason: string } | undefined;
  reviewStatus?: string | undefined;
}

/**
 * Quote a single CSV field.
 *
 * Leading `=`, `+`, `-`, `@` are prefixed with a single quote. Excel and
 * Sheets treat those as formulas, and this data contains third-party text
 * from filings and press articles — text we did not write and must not
 * hand to a spreadsheet as executable content.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Normalize newlines so a multi-line rationale stays inside one cell.
  s = s.replace(/\r\n|\r|\n/g, ' ').trim();
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",;\t]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const EXPORT_COLUMNS = [
  'Company',
  'Vamos fit score (1-10)',
  'Score is provisional',
  'Model assessable (%)',
  'Assessable points (of 100)',
  'Evidence confidence (%)',
  'Opportunity classification',
  'Qualification verdict',
  'Independent financing sources',
  'Operating-company evidence',
  'Disqualified',
  'Disqualification reason',
  'Review status',
  'Vertical',
  'Subcategory',
  'Stage',
  'City',
  'State',
  'Website',
  'Primary source',
  'Source tier',
  'Amount (as stated)',
  'Round (as stated)',
  'Evidence published',
  'Evidence URL',
  'Score caveats',
] as const;

function classificationLabel(c: string | undefined): string {
  if (!c) return 'Not classified';
  return c.replace(/-/g, ' ');
}

function qualificationLabel(r: string | undefined): string {
  if (!r) return 'No verdict recorded';
  return QUALIFICATION_LABELS[r as QualificationResult] ?? r;
}

/** The caveats a reader needs to interpret the score outside the app. */
function caveats(row: ExportRow): string {
  const parts: string[] = [];
  if (row.fit.provisional) {
    parts.push('PROVISIONAL: no company-descriptive component could be judged, so this score reflects only our own sourcing quality, not the company');
  }
  const unassessed = row.fit.components.filter((x) => !x.assessable).map((x) => x.label);
  if (unassessed.length > 0) {
    parts.push(`Not assessed (excluded from the score, not scored zero): ${unassessed.join(', ')}`);
  }
  if (row.fit.exceptions.length > 0) {
    parts.push(`Policy flags for partner review: ${row.fit.exceptions.map((e) => e.flag).join(', ')}`);
  }
  return parts.join(' | ');
}

export function toCsvRow(row: ExportRow): string {
  const { company: c, fit, opportunity: opp, qualification: qual, quarantine: quar } = row;
  return [
    c.name,
    fit.score.toFixed(1),
    fit.provisional ? 'yes' : 'no',
    Math.round(fit.completeness * 100),
    fit.assessablePoints,
    Math.round(fit.evidenceConfidence * 100),
    classificationLabel(opp?.classification),
    qualificationLabel(qual?.result),
    qual ? (qual.corroboratingSources?.length ?? 0) : 0,
    qual ? WEBSITE_EVIDENCE_LABELS[qual.operatingEvidence?.level ?? 'not-checked'] : 'Not checked',
    quar ? 'yes' : 'no',
    quar?.reason ?? '',
    row.reviewStatus ?? 'New',
    c.vertical,
    c.subcategory,
    c.stage,
    c.city,
    c.state,
    c.website ?? '',
    opp?.primarySourceId ?? '',
    opp?.primaryTier ?? '',
    opp?.amountText ?? '',
    opp?.roundType ?? '',
    opp?.evidencePublishedAt ?? '',
    opp?.evidenceUrl ?? '',
    caveats(row),
  ].map(csvCell).join(',');
}

export function buildCsv(rows: ExportRow[]): string {
  // A BOM so Excel opens UTF-8 correctly — company names carry accents.
  return '﻿'
    + [EXPORT_COLUMNS.join(','), ...rows.map(toCsvRow)].join('\r\n')
    + '\r\n';
}

/** `deal-radar-companies-2026-07-30.csv` */
export function exportFilename(now: Date): string {
  return `deal-radar-companies-${now.toISOString().slice(0, 10)}.csv`;
}

// The browser-only download trigger lives in ./csvDownload so THIS module
// stays free of DOM references. The server-side test suite imports these
// pure functions, and its tsconfig has no DOM lib — keeping the split means
// the CSV logic is testable without pulling a browser environment in.
