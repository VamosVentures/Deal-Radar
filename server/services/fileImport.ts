import { audit } from '../lib/guard';
import { aiConfigured } from '../env';
import { callBudgetedModel, estimateTokens } from './aiClient';
import { activeModel } from './aiBudget';
import { fenceNonce, fenceUntrusted, sanitizeUntrustedContent } from './aiGuard';
import { isNamedCandidate, parseExtractionReply, toQueuedCandidate } from './emailIntake';
import { FILE_IMPORT_PROMPT } from './fileImportPrompt';
import {
  countCandidatesInBatch, createBatch, finishBatch, getBatch, insertCandidate, listRunningBatchIds,
  recordBatchChunkDone, type IntakeBatch,
} from '../db/repos/emailIntake';
import { prepareTable, rowAsText, type PreparedTable } from '../../shared/tableFile';
import { aiUsageSchema, costOf } from '../../shared/ai';

/**
 * "Import with Claude": a loosely formatted CSV or Excel file of deal flow
 * → companies in the intake review queue.
 *
 * The browser turns the picked file into plain string rows (Excel is read
 * client-side) and sends them here. This module:
 *  1. cleans them (shared/tableFile.ts — header detection, blank rows and
 *     columns; identity/demographic columns are kept and listed);
 *  2. previews: row count, columns, identity columns, and an estimated
 *     cost, so the reviewer confirms before any money is spent;
 *  3. on confirm, creates a 'file' batch and reads the rows in chunks in
 *     the background, each chunk one budgeted Claude call (same gateway,
 *     budget caps, untrusted-content fencing and audit trail as every
 *     other model call), queueing what Claude reports.
 *
 * Nothing becomes a real company here. Every candidate waits in the same
 * review queue as email intake and goes through the same approve path —
 * one at a time, or "Approve all ready" for the batch.
 */

/** Most data rows accepted from one file (~$4 at Sonnet 5.5 prices). Bigger files are refused, not cut. */
export const MAX_FILE_ROWS = 1_000;
/** Rows per Claude call. Small enough that one bad reply loses little; large enough to share the prompt. */
export const ROWS_PER_CHUNK = 25;
/** Character budget for one chunk's rows — keeps prompt + rows well inside the per-request input cap. */
const CHUNK_MAX_CHARS = 60_000;
/** Room for ~35 companies per chunk; priced at this worst case by the budget gate. */
const CHUNK_MAX_OUTPUT_TOKENS = 12_000;
/** Measured on a real extraction (~340 output tokens per company); rounded up for the estimate. */
const EST_OUTPUT_TOKENS_PER_ROW = 360;
/** Chunks read at once. Keeps a big file to a few minutes without bursting the provider. */
const CONCURRENCY = 2;

export interface FileImportInput {
  fileName: string;
  rows: unknown[][];
}

export interface FileImportPreview {
  fileName: string;
  columns: string[];
  rowCount: number;
  identityColumns: string[];
  skippedLeadingRows: number;
  shortenedCells: number;
  chunks: number;
  estimatedCostUsd: number;
  model: string;
  aiConfigured: boolean;
  /** The first few rows as Claude will read them, so the reviewer can sanity-check the columns. */
  sample: string[];
}

function cleanFileName(name: string): string {
  // Keep accents and the "file — sheet" dash; drop path separators, control characters and quotes.
  // oxlint-disable-next-line no-control-regex
  return name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001F\u007F"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'uploaded file';
}

function prepare(input: FileImportInput): { table: PreparedTable; fileName: string } {
  const table = prepareTable(input.rows);
  if (table.rows.length === 0) {
    throw Object.assign(new Error('No data rows found in that file. Check that it isn\'t empty and that the first sheet holds the companies.'), { status: 422 });
  }
  if (table.rows.length > MAX_FILE_ROWS) {
    throw Object.assign(
      new Error(`That file has ${table.rows.length.toLocaleString()} rows; the limit is ${MAX_FILE_ROWS.toLocaleString()} per import. Split it into smaller files and import each one.`),
      { status: 413 },
    );
  }
  return { table, fileName: cleanFileName(input.fileName) };
}

/** Split rows into chunks of up to ROWS_PER_CHUNK rows and CHUNK_MAX_CHARS characters. */
export function chunkRows(table: PreparedTable): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const row of table.rows) {
    const text = rowAsText(table.header, row);
    if (current.length > 0 && (current.length >= ROWS_PER_CHUNK || chars + text.length > CHUNK_MAX_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function promptFor(fileName: string, chunk: readonly string[], part: number, of: number): {
  prompt: string;
  injectionFlags: string[];
} {
  const content = sanitizeUntrustedContent(chunk.join('\n\n'), { maxChars: CHUNK_MAX_CHARS * 2 });
  return {
    prompt: [
      FILE_IMPORT_PROMPT.trimEnd(),
      `These are rows from the file "${fileName}" (part ${part} of ${of}):`,
      fenceUntrusted('spreadsheet', content, fenceNonce()),
      'Respond with ONLY the JSON object described above.',
    ].join('\n'),
    injectionFlags: content.injectionFlags,
  };
}

export function previewFileImport(input: FileImportInput): FileImportPreview {
  const { table, fileName } = prepare(input);
  const chunks = chunkRows(table);
  const { model } = activeModel();
  const inputTokens = chunks.reduce((sum, c, i) => sum + estimateTokens(promptFor(fileName, c, i + 1, chunks.length).prompt), 0);
  const estimatedCostUsd = costOf(
    aiUsageSchema.parse({ inputTokens, outputTokens: table.rows.length * EST_OUTPUT_TOKENS_PER_ROW }),
    model,
  );
  return {
    fileName,
    columns: table.header,
    rowCount: table.rows.length,
    identityColumns: table.identityColumns,
    skippedLeadingRows: table.skippedLeadingRows,
    shortenedCells: table.shortenedCells,
    chunks: chunks.length,
    estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
    model,
    aiConfigured: aiConfigured(),
    sample: table.rows.slice(0, 3).map((r) => rowAsText(table.header, r)),
  };
}

/** Batches being read by this process right now. Anything else marked 'running' was cut off by a restart. */
const activeJobs = new Map<string, Promise<void>>();

export interface FileImportStatus {
  batchId: string;
  fileName: string | null;
  status: IntakeBatch['status'];
  chunksTotal: number;
  chunksDone: number;
  candidates: number;
  error: string | null;
  summary: Record<string, unknown> | null;
}

export function fileImportStatus(batchId: string): FileImportStatus | null {
  const batch = getBatch(batchId);
  if (!batch || batch.source !== 'file') return null;
  return {
    batchId: batch.id,
    fileName: batch.fileName,
    status: batch.status,
    chunksTotal: batch.chunksTotal,
    chunksDone: batch.chunksDone,
    candidates: countCandidatesInBatch(batch.id),
    error: batch.error,
    summary: batch.summary,
  };
}

/**
 * A deploy or restart kills any read in progress. Called once at boot:
 * mark such batches 'interrupted' so the UI says so instead of showing a
 * progress bar that never moves. Whatever was already queued stays.
 */
export function markInterruptedFileImports(): number {
  const stale = listRunningBatchIds().filter((id) => !activeJobs.has(id));
  for (const id of stale) {
    finishBatch(id, 'interrupted', 'The server restarted before the whole file was read. Companies already found are in the queue; import the file again to read the rest (duplicates are caught on approve).');
  }
  return stale.length;
}

/**
 * Validate, create the batch, and start reading in the background.
 * Returns as soon as the batch exists; poll fileImportStatus for progress.
 */
export function startFileImport(input: FileImportInput & { submittedBy: string }): FileImportStatus {
  if (!aiConfigured()) {
    throw Object.assign(
      new Error('No AI provider is configured, so Import with Claude is unavailable. Use the strict CSV template upload instead.'),
      { status: 503 },
    );
  }
  const { table, fileName } = prepare(input);
  const chunks = chunkRows(table);
  const batchId = crypto.randomUUID();
  createBatch(batchId, input.submittedBy, {
    source: 'file',
    fileName,
    status: 'running',
    chunksTotal: chunks.length,
    summary: {
      rowCount: table.rows.length,
      columns: table.header,
      identityColumns: table.identityColumns,
      skippedLeadingRows: table.skippedLeadingRows,
      shortenedCells: table.shortenedCells,
    },
  });
  audit({
    provider: 'system', mode: 'local', action: 'file-import-start', subject: batchId, outcome: 'ok',
    detail: `"${fileName}": ${table.rows.length} row(s) in ${chunks.length} chunk(s) by ${input.submittedBy}`
      + (table.identityColumns.length > 0 ? `; identity column(s) read: ${table.identityColumns.join(', ')}` : ''),
  });

  const job = runFileImport(batchId, fileName, chunks, input.submittedBy)
    .finally(() => { activeJobs.delete(batchId); });
  activeJobs.set(batchId, job);
  return fileImportStatus(batchId)!;
}

/** Tests only: resolves when a batch's background read has finished. */
export function fileImportIdleForTests(batchId: string): Promise<void> {
  return activeJobs.get(batchId) ?? Promise.resolve();
}

async function runFileImport(batchId: string, fileName: string, chunks: string[][], submittedBy: string): Promise<void> {
  let next = 0;
  let stopReason: string | null = null;
  let failedChunks = 0;
  let queued = 0;
  let dropped = 0;

  const readChunk = async (index: number): Promise<void> => {
    const part = index + 1;
    const { prompt, injectionFlags } = promptFor(fileName, chunks[index], part, chunks.length);
    try {
      let candidates: unknown[] | null = null;
      // One retry when the reply isn't readable JSON — the call itself already retries transport errors.
      for (let attempt = 1; attempt <= 2 && candidates === null; attempt++) {
        const { text } = await callBudgetedModel({
          prompt,
          feature: 'file-import-extract',
          maxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS,
          outputScalesWithInput: true,
          effort: 'low',
        });
        const parsed = parseExtractionReply(text);
        if (parsed.ok) candidates = parsed.candidates;
        else if (attempt === 2) throw new Error(`Claude's reply couldn't be read as a list of companies (${parsed.error})`);
      }
      for (const raw of candidates ?? []) {
        if (!isNamedCandidate(raw)) { dropped += 1; continue; }
        insertCandidate(batchId, toQueuedCandidate(raw, { fileName, submittedBy }));
        queued += 1;
      }
      if (injectionFlags.length > 0) {
        audit({
          provider: 'ai', mode: 'live', action: 'file-import-injection-flagged', subject: batchId, outcome: 'ok',
          detail: `Part ${part} of "${fileName}" contained instruction-shaped text (${injectionFlags.join(', ')}); treated as data.`,
        });
      }
      recordBatchChunkDone(batchId);
    } catch (e) {
      const err = e as Error & { status?: number };
      failedChunks += 1;
      const rows = chunks[index].map((t) => t.split('\n')[0]).join(', ');
      recordBatchChunkDone(batchId, `Part ${part} (${firstAndLast(rows)}) was not read: ${err.message}`);
      // Over budget / AI switched off: every later chunk would be refused the same way.
      if (err.status === 402 || err.status === 403 || err.status === 503 || err.status === 429) stopReason = err.message;
    }
  };

  const worker = async () => {
    while (stopReason === null && next < chunks.length) {
      const index = next++;
      await readChunk(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

  const unread = chunks.length - (getBatch(batchId)?.chunksDone ?? chunks.length);
  const status = failedChunks === chunks.length || (stopReason !== null && queued === 0) ? 'failed' : 'done';
  finishBatch(
    batchId,
    status,
    stopReason !== null && unread > 0 ? `Stopped with ${unread} part(s) unread: ${stopReason}` : null,
  );
  audit({
    provider: 'system', mode: 'local', action: 'file-import-finish', subject: batchId,
    outcome: failedChunks > 0 || unread > 0 ? 'error' : 'ok',
    detail: `"${fileName}": ${queued} candidate(s) queued for review; ${failedChunks} of ${chunks.length} part(s) failed`
      + (unread > 0 ? `; ${unread} not attempted` : '') + (dropped > 0 ? `; ${dropped} nameless entr${dropped === 1 ? 'y' : 'ies'} dropped` : ''),
  });
}

function firstAndLast(rowsCsv: string): string {
  const parts = rowsCsv.split(', ');
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]}–${parts[parts.length - 1].replace(/^Row /, '')}`;
}
