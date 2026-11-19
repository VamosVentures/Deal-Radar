import { describe, expect, it } from 'vitest';
import {
  cellToText, isIdentityColumn, MAX_CELL_CHARS, parseDelimitedRows, prepareTable, rowAsText,
} from '../../shared/tableFile';

/**
 * shared/tableFile.ts — cleaning a loosely formatted spreadsheet before
 * "Import with Claude" reads it. Forgiving on structure; identity columns
 * are kept (Claude records only what they explicitly state) and listed.
 */
describe('parseDelimitedRows', () => {
  it('parses plain comma-separated text', () => {
    expect(parseDelimitedRows('Company,Website\nAcme,acme.com\n')).toEqual([
      ['Company', 'Website'], ['Acme', 'acme.com'],
    ]);
  });

  it('sniffs semicolon and tab delimiters (European Excel exports, pasted tables)', () => {
    expect(parseDelimitedRows('Company;City\nAcme;Austin, TX')).toEqual([['Company', 'City'], ['Acme', 'Austin, TX']]);
    expect(parseDelimitedRows('Company\tCity\nAcme\tAustin, TX')).toEqual([['Company', 'City'], ['Acme', 'Austin, TX']]);
  });

  it('keeps a quoted cell with commas, escaped quotes and line breaks intact', () => {
    const rows = parseDelimitedRows('Company,Notes\r\nAcme,"Great team, ""strong"" pilot\nraising soon"\r\n');
    expect(rows).toEqual([['Company', 'Notes'], ['Acme', 'Great team, "strong" pilot\nraising soon']]);
  });

  it('strips a byte-order mark from the first header', () => {
    expect(parseDelimitedRows('﻿Company\nAcme')[0][0]).toBe('Company');
  });
});

describe('isIdentityColumn', () => {
  it.each(['Latino-led?', 'latinoLed', 'Gender', 'Founder ethnicity', 'Race', 'Female founder', 'Women-owned', 'Diverse team?', 'Demographics'])(
    'recognizes "%s" as an identity column', (h) => expect(isIdentityColumn(h)).toBe(true),
  );
  it.each(['Traction', 'Company', 'Grace period', 'Embrace score', 'Founders', 'Sector', 'Racetrack sensors'])(
    'does not flag "%s"', (h) => expect(isIdentityColumn(h)).toBe(false),
  );
});

describe('prepareTable', () => {
  it('finds the header below title rows, numbers rows as the spreadsheet shows them, and skips blank rows', () => {
    const t = prepareTable([
      ['Q3 deal flow — internal'],
      [],
      ['Company', 'HQ', 'Notes'],
      ['Acme', 'Austin, TX', 'Strong pilot'],
      ['', '', ''],
      ['Beta Bio', '', 'Intro from Maria'],
    ]);
    expect(t.header).toEqual(['Company', 'HQ', 'Notes']);
    expect(t.skippedLeadingRows).toBe(1);
    expect(t.rows.map((r) => r.rowNumber)).toEqual([4, 6]);
    expect(t.rows[1].cells).toEqual(['Beta Bio', '', 'Intro from Maria']);
  });

  it('keeps identity columns and lists them', () => {
    const t = prepareTable([
      ['Company', 'Latino-led?', 'Gender', 'Stage'],
      ['Acme', 'Yes', 'F', 'Seed'],
    ]);
    expect(t.header).toEqual(['Company', 'Latino-led?', 'Gender', 'Stage']);
    expect(t.identityColumns).toEqual(['Latino-led?', 'Gender']);
    expect(t.rows[0].cells).toEqual(['Acme', 'Yes', 'F', 'Seed']);
  });

  it('drops fully empty columns, names unnamed ones that have data, and disambiguates duplicates', () => {
    const t = prepareTable([
      ['Company', '', '', 'Notes', 'Notes'],
      ['Acme', '', 'acme.com', 'a', 'b'],
    ]);
    expect(t.header).toEqual(['Company', 'Column 3', 'Notes', 'Notes (2)']);
    expect(t.rows[0].cells).toEqual(['Acme', 'acme.com', 'a', 'b']);
  });

  it('accepts raw Excel values: numbers, booleans, dates and blanks', () => {
    const t = prepareTable([
      ['Company', 'Founded', 'Active', 'Last contact', 'Team'],
      ['Acme', 2021, true, new Date('2026-10-01T00:00:00Z'), null],
    ]);
    expect(t.rows[0].cells).toEqual(['Acme', '2021', 'true', '2026-10-01', '']);
    expect(cellToText(new Date('invalid'))).toBe('');
  });

  it('shortens absurdly long cells and counts them', () => {
    const t = prepareTable([['Company', 'Notes'], ['Acme', 'x'.repeat(MAX_CELL_CHARS + 50)]]);
    expect(t.shortenedCells).toBe(1);
    expect(t.rows[0].cells[1].length).toBe(MAX_CELL_CHARS + 1);
  });

  it('returns no rows for an empty file', () => {
    expect(prepareTable([[], ['', '']]).rows).toEqual([]);
  });
});

describe('rowAsText', () => {
  it('labels each non-empty cell with its column and the row with its spreadsheet number', () => {
    const t = prepareTable([['Company', 'City', 'Notes'], ['Acme', '', 'line one\nline two']]);
    expect(rowAsText(t.header, t.rows[0])).toBe('Row 2\n- Company: Acme\n- Notes: line one / line two');
  });
});
