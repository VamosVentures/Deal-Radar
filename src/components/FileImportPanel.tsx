import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type FileImportPreview, type FileImportStatus, type SpreadsheetRows } from '../lib/api';
import { cellToText, parseDelimitedRows } from '../../shared/tableFile';
import { useIntegrations } from '../store/integrations';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';

/**
 * "Import with Claude" — a messy CSV or Excel file of deal flow into the
 * intake review queue below.
 *
 * The file is read here in the browser (Excel via read-excel-file, loaded
 * only when an .xlsx is picked) into plain rows. The server previews it
 * first — rows found, columns it will read, which of them hold founder identity,
 * and an estimated cost — and nothing is sent to Claude until the
 * reviewer confirms. Claude then reads the rows in the background
 * (server/services/fileImport.ts); companies appear in the queue as each
 * part finishes, and nothing becomes a real company until approved.
 *
 * The strict-template "Upload CSV" in the connector list above still
 * exists and costs nothing — this is for files that don't match it.
 */

const ACTIVE_KEY = 'deal-radar.file-import.active';
const POLL_MS = 2_500;

function remember(batchId: string | null) {
  try {
    if (batchId) sessionStorage.setItem(ACTIVE_KEY, batchId);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch { /* storage can be unavailable; progress just won't survive a reload */ }
}
function recall(): string | null {
  try { return sessionStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

function isExcel(name: string): boolean {
  return /\.xlsx$/i.test(name);
}

interface PickedFile {
  name: string;
  sheets: { name: string; rows: SpreadsheetRows }[];
}

async function readPicked(file: File): Promise<PickedFile> {
  if (isExcel(file.name)) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(file);
    return {
      name: file.name,
      sheets: sheets
        .map((s) => ({
          name: s.sheet,
          rows: s.data.map((row) => row.map((c) => (c === null || typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean' ? c : cellToText(c)))),
        }))
        .filter((s) => s.rows.some((r) => r.some((c) => c !== null && String(c).trim() !== ''))),
    };
  }
  if (/\.xls$/i.test(file.name)) {
    throw new Error('Old .xls files can\'t be read. Open it in Excel and save as .xlsx or .csv, then pick it again.');
  }
  return { name: file.name, sheets: [{ name: file.name, rows: parseDelimitedRows(await file.text()) }] };
}

function money(usd: number): string {
  return usd < 0.01 ? 'under 1¢' : usd < 1 ? `about ${Math.max(1, Math.round(usd * 100))}¢` : `about $${usd.toFixed(2)}`;
}

export function FileImportPanel({ onProgress }: { onProgress: () => void }) {
  const { status: integrations } = useIntegrations();
  const aiAvailable = integrations?.ai.connected === true;

  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [preview, setPreview] = useState<FileImportPreview | null>(null);
  const [job, setJob] = useState<FileImportStatus | null>(null);
  const [busy, setBusy] = useState<'reading' | 'preview' | 'start' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const lastCount = useRef(0);

  const rows = picked?.sheets[sheetIndex]?.rows ?? null;
  const fileLabel = picked
    ? picked.sheets.length > 1 ? `${picked.name} — ${picked.sheets[sheetIndex]?.name}` : picked.name
    : '';

  const runPreview = useCallback(async (label: string, r: SpreadsheetRows) => {
    setBusy('preview');
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.fileImport.preview(label, r));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }, []);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPreview(null);
    setJob(null);
    setBusy('reading');
    try {
      const p = await readPicked(file);
      if (p.sheets.length === 0) throw new Error('That file has no data in it.');
      setPicked(p);
      setSheetIndex(0);
      setBusy(null);
      await runPreview(p.sheets.length > 1 ? `${p.name} — ${p.sheets[0].name}` : p.name, p.sheets[0].rows);
    } catch (e) {
      setBusy(null);
      setError(e instanceof ApiError ? e : new ApiError(0, { message: (e as Error).message }));
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function onSheet(i: number) {
    if (!picked) return;
    setSheetIndex(i);
    await runPreview(`${picked.name} — ${picked.sheets[i].name}`, picked.sheets[i].rows);
  }

  async function start() {
    if (!rows || !preview) return;
    setBusy('start');
    setError(null);
    try {
      const s = await api.fileImport.start(fileLabel, rows);
      lastCount.current = 0;
      setJob(s);
      remember(s.batchId);
      setPicked(null);
      setPreview(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  // Resume watching an import that was running when the page was reloaded.
  useEffect(() => {
    const id = recall();
    if (!id) return;
    api.fileImport.status(id).then(setJob).catch(() => remember(null));
  }, []);

  // Poll while running; refresh the queue whenever new companies arrive.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = setInterval(() => {
      api.fileImport.status(job.batchId).then((s) => {
        setJob(s);
        if (s.candidates !== lastCount.current || s.status !== 'running') {
          lastCount.current = s.candidates;
          onProgress();
        }
        if (s.status !== 'running') remember(null);
      }).catch(() => { /* transient; try again next tick */ });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job, onProgress]);

  if (!aiAvailable) return null;


  return (
    <section className="mt-8 border border-line bg-panel p-4" data-testid="file-import-panel">
      <h2 className="mb-1 font-display text-base font-semibold text-ink">Spreadsheet deal flow (CSV or Excel)</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        Pick any CSV or Excel (.xlsx) file of companies — any columns, any layout. Claude reads each row, works out
        what the columns mean, and proposes a vertical for every company. They land in the review queue below;
        nothing is created until you approve it. You&rsquo;ll see the cost before anything is sent.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        data-testid="file-import-input"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button" className={btnPrimary}
          disabled={busy !== null || job?.status === 'running'}
          onClick={() => inputRef.current?.click()}
        >
          {busy === 'reading' ? 'Reading file…' : busy === 'preview' ? 'Checking…' : 'Choose a file…'}
        </button>
        {picked && picked.sheets.length > 1 && (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-mid">
            Sheet
            <select
              className="border border-line bg-paper px-1.5 py-1 text-[11px]" value={sheetIndex} disabled={busy !== null}
              onChange={(e) => void onSheet(Number(e.target.value))}
            >
              {picked.sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <div className="mt-2"><ErrorNote message={error.message} issues={error.issues} /></div>}

      {preview && (
        <div className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink" data-testid="file-import-preview">
          <p>
            <span className="font-semibold">{preview.fileName}</span>: {preview.rowCount.toLocaleString()} row
            {preview.rowCount === 1 ? '' : 's'}, {preview.columns.length} column{preview.columns.length === 1 ? '' : 's'}.
          </p>
          <p className="text-slate-mid">Columns Claude will read: {preview.columns.join(' · ')}</p>
          {preview.identityColumns.length > 0 && (
            <p className="mt-1 text-marigold">
              Founder identity columns: {preview.identityColumns.join(', ')}. Claude records only what a cell explicitly
              states (never inferred from names), labeled &ldquo;Recorded in uploaded file&rdquo; with the row. You
              confirm it on each review card; once approved it counts toward the Fit Score and HubSpot.
            </p>
          )}
          {preview.skippedLeadingRows > 0 && (
            <p className="text-slate-mid">
              {preview.skippedLeadingRows} line{preview.skippedLeadingRows === 1 ? '' : 's'} above the header row (titles or notes) will be ignored.
            </p>
          )}
          {preview.shortenedCells > 0 && (
            <p className="text-slate-mid">{preview.shortenedCells} very long cell{preview.shortenedCells === 1 ? '' : 's'} will be shortened to 2,000 characters.</p>
          )}
          {preview.sample[0] && (
            <details className="mt-1">
              <summary className="cursor-pointer text-slate-mid">How Claude will see the first row</summary>
              <pre className="mt-1 whitespace-pre-wrap border border-line bg-paper p-2 font-mono text-[10px]">{preview.sample[0]}</pre>
            </details>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={btnPrimary} disabled={busy !== null} onClick={() => void start()}>
              {busy === 'start' ? 'Starting…' : `Import ${preview.rowCount.toLocaleString()} rows with Claude`}
            </button>
            <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => { setPreview(null); setPicked(null); }}>
              Cancel
            </button>
            <span className="text-[10px] text-slate-mid">
              Estimated cost {money(preview.estimatedCostUsd)} ({preview.chunks} AI call{preview.chunks === 1 ? '' : 's'}, counted against the monthly AI budget).
            </span>
          </div>
        </div>
      )}

      {job && (
        <div className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed" data-testid="file-import-status">
          {job.status === 'running' ? (
            <>
              <p className="text-ink">
                Reading <span className="font-semibold">{job.fileName}</span> — part {Math.min(job.chunksDone + 1, job.chunksTotal)} of {job.chunksTotal}
                {' · '}{job.candidates} compan{job.candidates === 1 ? 'y' : 'ies'} found so far.
              </p>
              <div className="mt-1 h-1.5 w-full max-w-sm bg-line">
                <div className="h-1.5 bg-ink transition-all" style={{ width: `${Math.round((job.chunksDone / Math.max(1, job.chunksTotal)) * 100)}%` }} />
              </div>
              <p className="mt-1 text-slate-mid">You can review companies below as they arrive. It&rsquo;s fine to leave this page.</p>
            </>
          ) : (
            <p className={job.status === 'done' && !job.error ? 'text-verde' : 'text-alerta'}>
              {job.status === 'done' ? 'Finished reading' : job.status === 'interrupted' ? 'Stopped early while reading' : 'Could not read'}{' '}
              <span className="font-semibold">{job.fileName}</span>: {job.candidates} compan{job.candidates === 1 ? 'y' : 'ies'} added to the review queue below.
            </p>
          )}
          {job.error && (
            <pre className="mt-1 whitespace-pre-wrap border border-alerta/40 bg-alerta-soft p-2 font-mono text-[10px] text-alerta">{job.error}</pre>
          )}
          {job.status !== 'running' && (
            <button type="button" className={`${btnGhost} mt-1.5`} onClick={() => { setJob(null); remember(null); }}>Dismiss</button>
          )}
        </div>
      )}
    </section>
  );
}
