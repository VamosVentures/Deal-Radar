import type { EmailIntakeCandidate } from './api';
import { draftFor, type Draft } from './emailIntakeDraft';

/**
 * Review-queue helpers kept free of React so they can be unit-tested
 * (src/lib/intakeQueueGroups.test.ts).
 */

export interface IntakeGroup {
  batchId: string;
  source: 'email' | 'file';
  fileName: string | null;
  candidates: EmailIntakeCandidate[];
}

/**
 * One group per batch (a forwarded email or an uploaded file): newest
 * batch first, and within a batch the order Claude reported them — for a
 * file, roughly the file's own row order.
 */
export function groupByBatch(candidates: readonly EmailIntakeCandidate[]): IntakeGroup[] {
  const groups = new Map<string, IntakeGroup>();
  for (const c of candidates) {
    const g = groups.get(c.batchId) ?? { batchId: c.batchId, source: c.source ?? 'email', fileName: c.fileName ?? null, candidates: [] };
    g.candidates.push(c);
    groups.set(c.batchId, g);
  }
  const maxId = (g: IntakeGroup) => Math.max(...g.candidates.map((c) => c.id));
  return [...groups.values()]
    .map((g) => ({ ...g, candidates: [...g.candidates].sort((a, b) => a.id - b.id) }))
    .sort((a, b) => maxId(b) - maxId(a));
}

/** Has the reviewer changed anything on this card since it was last saved? */
export function isDirty(draft: Draft, candidate: EmailIntakeCandidate): boolean {
  const saved = draftFor(candidate);
  return Object.keys({ ...saved, ...draft }).some((k) => (draft[k] ?? '') !== (saved[k] ?? ''));
}

/**
 * The founder-identity indicators a file stated for this candidate, as
 * short labels ("Latino-led", "Female-led", …), plus where they came from.
 * Null when the file stated none.
 */
export function identitySummary(extracted: Record<string, unknown>): { labels: string[]; source: string } | null {
  const id = extracted.identity as Record<string, unknown> | undefined;
  if (!id || typeof id !== 'object') return null;
  const labels: string[] = [];
  if (id.latinoLed === true) labels.push('Latino-led');
  if (id.femaleLed === true) labels.push('Female-led');
  if (typeof id.otherUnderrepresented === 'string' && id.otherUnderrepresented) labels.push(id.otherUnderrepresented);
  if (typeof id.immigrantBackground === 'string' && id.immigrantBackground) labels.push(id.immigrantBackground);
  if (labels.length === 0) return null;
  return { labels, source: typeof id.source === 'string' ? id.source : '' };
}

/** "Row 12" / "Rows 12, 13" for a company read from a spreadsheet; '' otherwise. */
export function sourceRowsLabel(extracted: Record<string, unknown>): string {
  const rows = Array.isArray(extracted.sourceRows)
    ? extracted.sourceRows.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (rows.length === 0) return '';
  return rows.length === 1 ? `Row ${rows[0]}` : `Rows ${rows.join(', ')}`;
}
