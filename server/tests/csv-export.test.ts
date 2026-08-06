import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, EXPORT_COLUMNS, exportFilename, toCsvRow, type ExportRow } from '../../src/lib/csvExport';
import { scoreCompany } from '../../src/lib/scoring';
import type { Company } from '../../src/types';

/**
 * CSV export invariants.
 *
 * The two that matter: a cell can never become a spreadsheet formula (the
 * text comes from filings and press articles we did not write), and a
 * judgement can never travel without the caveat that qualifies it — a
 * spreadsheet outlives the screen that explained it.
 */

const company: Company = {
  id: 'csv-co',
  name: 'Fixture Health, Inc.',
  oneLiner: 'A fixture company.',
  vertical: 'health',
  subcategory: 'Unclassified — requires manual review',
  stage: 'Unknown',
  city: 'Unknown',
  state: '??',
  foundedYear: 0,
  teamSize: 0,
  traction: { level: 0, note: 'Unknown — not yet researched' },
  founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
  evidence: [{ claim: 'Form D', source: 'SEC', url: 'https://www.sec.gov/x', date: '2026-07-01', type: 'Filing' }],
  flags: [],
};

function row(over: Partial<ExportRow> = {}): ExportRow {
  return { company, fit: scoreCompany(company), ...over };
}

/**
 * Split a CSV line respecting quotes. A naive `split(',')` shifts every
 * column after the first quoted cell containing a comma — and "Fixture
 * Health, Inc." is exactly that, so the assertions need real parsing.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Read one named column out of a rendered row. */
function cell(r: ExportRow, column: string): string {
  const i = (EXPORT_COLUMNS as readonly string[]).indexOf(column);
  if (i === -1) throw new Error(`unknown column: ${column}`);
  return parseCsvLine(toCsvRow(r))[i];
}

describe('csvCell', () => {
  it('neutralizes formula-injection prefixes', () => {
    // Excel and Sheets execute these. The text is third-party — it comes
    // from filings and press articles. Assert on the DECODED cell value,
    // since a payload containing a quote is also wrapped in quotes and the
    // apostrophe then sits inside them.
    for (const dangerous of ['=1+1', '+SUM(A1)', '-2+3', '@import', '=cmd|"/c calc"!A1', '=HYPERLINK("http://x","c")']) {
      const [decoded] = parseCsvLine(csvCell(dangerous));
      expect(decoded.startsWith("'")).toBe(true);
      // The apostrophe must lead — a formula character may never be first.
      expect(/^[=+\-@]/.test(decoded)).toBe(false);
    }
  });

  it('quotes and escapes separators and quotes', () => {
    expect(csvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('a;b')).toBe('"a;b"');
  });

  it('flattens newlines so a rationale stays in one cell', () => {
    expect(csvCell('line one\nline two\r\nthree')).toBe('line one line two three');
  });

  it('renders empty for null and undefined rather than the word "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('leaves ordinary text untouched', () => {
    expect(csvCell('Fixture Health Inc')).toBe('Fixture Health Inc');
    expect(csvCell(7.4)).toBe('7.4');
  });
});

describe('row content', () => {
  it('carries the provisional flag next to the score', () => {
    const r = row();
    expect(r.fit.provisional).toBe(true); // bare record — nothing about the company is judgeable

    expect(cell(r, 'Company')).toBe('Fixture Health, Inc.');
    expect(cell(r, 'VamosVentures fit score (1-10)')).toBe(r.fit.score.toFixed(1));
    expect(cell(r, 'Score is provisional')).toBe('yes');
  });

  /**
   * Model-assessable %, assessable points, and evidence confidence were
   * removed from the export along with their on-screen counterparts.
   * They describe how the number was computed rather than the company,
   * and a reader outside the app has no action to take on any of them.
   *
   * The provisional flag and the caveat text stay: those DO change how
   * the score should be read.
   */
  it('no longer exports the scoring-model internals', () => {
    for (const gone of ['Model assessable (%)', 'Assessable points (of 100)', 'Evidence confidence (%)']) {
      expect(EXPORT_COLUMNS as readonly string[]).not.toContain(gone);
    }
  });

  it('states the caveat that the score reflects only our sourcing', () => {
    expect(toCsvRow(row())).toMatch(/PROVISIONAL/);
    expect(toCsvRow(row())).toMatch(/only our own sourcing quality/i);
  });

  it('lists unassessed components as excluded rather than zero', () => {
    expect(toCsvRow(row())).toMatch(/excluded from the score, not scored zero/i);
  });

  it('reports a missing verdict as "No verdict recorded", never as a pass', () => {
    expect(cell(row({ qualification: undefined }), 'Qualification verdict')).toBe('No verdict recorded');
  });

  it('carries the disqualification reason for a quarantined record', () => {
    const r = row({ quarantine: { reason: 'Publicly traded — ticker ADGM' } });
    expect(cell(r, 'Disqualified')).toBe('yes');
    expect(cell(r, 'Disqualification reason')).toBe('Publicly traded — ticker ADGM');
  });

  it('labels a recorded verdict with its human-readable name', () => {
    const r = row({
      qualification: {
        result: 'qualified-operating-company',
        corroboratingSources: [1, 2],
        operatingEvidence: { level: 'substantive' },
      },
    });
    expect(cell(r, 'Qualification verdict')).toBe('Qualified operating company');
    expect(cell(r, 'Independent financing sources')).toBe('2');
    expect(cell(r, 'Operating-company evidence')).toBe('Substantive operating evidence');
  });

  /**
   * A reader of the file has to be able to tell "qualified on a real
   * product site" from "qualified on a domain that resolves". Before these
   * were separate columns the export said "2 independent sources" for a
   * record whose second source was its own website, and nothing in the file
   * disclosed that.
   */
  it('separates independent financing sources from operating evidence', () => {
    const bare = row({
      qualification: {
        result: 'company-lead-requires-corroboration',
        corroboratingSources: [1],
        operatingEvidence: { level: 'identity-only' },
      },
    });
    expect(cell(bare, 'Independent financing sources')).toBe('1');
    expect(cell(bare, 'Operating-company evidence')).toBe('Identity only');

    // An older verdict, written before the question was asked, says so
    // rather than reporting an absence of evidence.
    const legacy = row({ qualification: { result: 'qualified-operating-company', corroboratingSources: [1] } });
    expect(cell(legacy, 'Operating-company evidence')).toBe('Not checked');
  });
});

describe('buildCsv', () => {
  it('writes a header row and one line per company, CRLF-terminated', () => {
    const csv = buildCsv([row(), row()]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3); // header + 2
    expect(lines[0].replace('﻿', '')).toBe(EXPORT_COLUMNS.join(','));
  });

  it('starts with a BOM so Excel reads UTF-8 accents correctly', () => {
    expect(buildCsv([]).startsWith('﻿')).toBe(true);
  });

  it('keeps every row at the header column count', () => {
    // A row that silently loses a column shifts every value after it.
    const csv = buildCsv([row({ quarantine: { reason: 'a, b "c"' } })]);
    const [header, first] = csv.replace('﻿', '').split('\r\n');
    const count = (line: string) => {
      let n = 1, inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) n++;
      }
      return n;
    };
    expect(count(first)).toBe(count(header));
  });

  it('names the file by date', () => {
    expect(exportFilename(new Date('2026-07-30T12:00:00Z'))).toBe('deal-radar-companies-2026-07-30.csv');
  });
});
