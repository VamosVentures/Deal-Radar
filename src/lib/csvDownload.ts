import { buildCsv, exportFilename, type ExportRow } from './csvExport';

/**
 * Browser-only download trigger, kept apart from the CSV construction in
 * ./csvExport so that module stays DOM-free and testable under the server
 * tsconfig (which has no DOM lib).
 *
 * The file is built and saved entirely in the browser — no server round
 * trip, no upload. Company records never leave the machine to be exported.
 */
export function downloadCsv(rows: ExportRow[], now: Date = new Date()): void {
  const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename(now);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
