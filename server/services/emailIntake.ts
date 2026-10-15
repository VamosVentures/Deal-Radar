import { audit } from '../lib/guard';
import { parseModelJson } from './aiGuard';
import {
  commitImportedCompany, importedCompanySchema, missingRequiredFields, slug,
} from './imports';
import {
  createBatch, decideCandidate, getCandidate, insertCandidate, listCandidates, updateCandidateExtracted,
  type EmailIntakeCandidate,
} from '../db/repos/emailIntake';
import { classifyCompany } from '../enrichment/verticalClassifier';
import { isClassified } from '../../shared/enrichment';

/**
 * Second intake path for messy, unstructured inbound deal-flow email text.
 *
 * There is no server-side model call here at all — see `EMAIL_INTAKE_PROMPT`
 * (src/lib/emailIntakePrompt.ts) for why: no AI provider is configured for
 * this app and none is planned, so a reviewer runs the extraction
 * themselves in their own Claude.ai chat and pastes the JSON reply back in.
 * That reply is treated exactly like any other untrusted input — parsed
 * defensively, never assumed well-formed — and NOTHING it contains becomes
 * a real, scored company until a human approves that specific candidate
 * (see `commitImportedCompany` in ./imports.ts, the one path onto the
 * companies table, shared with the CSV importer).
 */

const CANDIDATES_KEY = 'candidates';

export function parseExtractionReply(reply: string): { ok: true; candidates: unknown[] } | { ok: false; error: string } {
  const parsed = parseModelJson<{ candidates?: unknown }>(reply);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const candidates = parsed.value?.[CANDIDATES_KEY];
  if (!Array.isArray(candidates)) {
    return { ok: false, error: `Expected a JSON object with a "${CANDIDATES_KEY}" array — see the standard extraction prompt.` };
  }
  return { ok: true, candidates };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * When Claude didn't report a vertical, suggest one from whatever text IS
 * on record, using the SAME deterministic, no-model classifier the
 * enrichment pipeline already uses for existing companies
 * (server/enrichment/verticalClassifier.ts — phrase-based "what it does" +
 * "who pays" scoring, not a keyword match). This is a SUGGESTION only:
 * it's attached as `suggestedVertical`/`suggestedVerticalReason`, never
 * written into `vertical` itself, so it never gets confused with something
 * the email actually stated — the reviewer still has to accept it (the
 * queue UI pre-fills the dropdown with it, but nothing is saved until they
 * do). Silent extra keys on this object are dropped harmlessly by
 * `importedCompanySchema` at approve time if the reviewer doesn't touch it.
 */
function suggestVertical(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.vertical) return {};
  const text = [raw.oneLiner, raw.subcategory, raw.quote]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join('. ');
  if (!text.trim()) return {};
  const result = classifyCompany({ text, identityResolved: true, selfDescribed: false });
  if (!isClassified(result.primarySector)) return {};
  return { suggestedVertical: result.primarySector, suggestedVerticalReason: result.reason };
}

/** Wrap one raw candidate object (as Claude reported it) into the shape the review queue and approve path expect. */
function toQueuedCandidate(raw: Record<string, unknown>): Record<string, unknown> {
  const { quote, ...rest } = raw;
  return {
    ...rest,
    ...suggestVertical(raw),
    evidence: [{
      type: 'Inbound referral',
      claim: typeof quote === 'string' && quote.trim() ? quote.trim() : '',
      source: 'Forwarded email',
      // Left for the reviewer to fill in — only a human knows who
      // forwarded this and when. See the 'Inbound referral' evidence
      // type in src/types.ts: this field holds a description, not a link.
      url: '',
      date: today(),
    }],
  };
}

export interface EmailIntakeSubmitResult {
  batchId: string;
  candidates: EmailIntakeCandidate[];
  /** Raw entries with no usable name — nothing for a reviewer to act on, so these are dropped rather than queued. */
  skipped: number;
}

export function submitEmailIntakeBatch(args: { reply: string; submittedBy: string }): EmailIntakeSubmitResult {
  const parsed = parseExtractionReply(args.reply);
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error), { status: 422 });
  }

  const batchId = crypto.randomUUID();
  createBatch(batchId, args.submittedBy);

  const candidates: EmailIntakeCandidate[] = [];
  let skipped = 0;
  for (const raw of parsed.candidates) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).name !== 'string'
      || !(raw as Record<string, unknown>).name || !String((raw as Record<string, unknown>).name).trim()) {
      skipped += 1;
      continue;
    }
    candidates.push(insertCandidate(batchId, toQueuedCandidate(raw as Record<string, unknown>)));
  }

  audit({
    provider: 'system', mode: 'local', action: 'email-intake-submit', subject: batchId,
    outcome: 'ok',
    detail: `${candidates.length} candidate(s) queued for review by ${args.submittedBy}${skipped > 0 ? `; ${skipped} entr${skipped === 1 ? 'y' : 'ies'} dropped (no name)` : ''}.`,
  });

  return { batchId, candidates, skipped };
}

export function listEmailIntakeCandidates(): EmailIntakeCandidate[] {
  return listCandidates();
}

/** A pending candidate's current missing-field list, for the review queue to show. */
export function candidateMissingFields(candidate: EmailIntakeCandidate): string[] {
  return missingRequiredFields(candidate.extracted);
}

export function updateEmailIntakeCandidate(id: number, patch: Record<string, unknown>): { ok: boolean; error?: string } {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, error: `No email-intake candidate with id ${id}.` };
  return updateCandidateExtracted(id, { ...existing.extracted, ...patch });
}

export function approveEmailIntakeCandidate(
  id: number,
  actor: string,
): { ok: true; companyId: string; possibleDuplicate: boolean } | { ok: false; status: number; error: string; missingFields?: string[] } {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, status: 404, error: `No email-intake candidate with id ${id}.` };
  if (existing.status !== 'pending') return { ok: false, status: 409, error: `Candidate ${id} was already ${existing.status}.` };

  const candidateWithId = { id: `imported-${slug(String(existing.extracted.name ?? `candidate-${id}`))}`, ...existing.extracted };
  const parsed = importedCompanySchema.safeParse(candidateWithId);
  if (!parsed.success) {
    return {
      ok: false, status: 422,
      error: 'This candidate is still missing required fields.',
      missingFields: missingRequiredFields(existing.extracted),
    };
  }

  const { possibleDuplicate, companyId } = commitImportedCompany(parsed.data, { source: 'email-intake' });
  const decided = decideCandidate(id, 'promoted', actor, { promotedCompanyId: companyId });
  if (!decided.ok) {
    // Lost a race with another reviewer between the checks above and here.
    return { ok: false, status: 409, error: decided.error ?? 'Could not record the decision.' };
  }
  audit({
    provider: 'system', mode: 'local', action: 'email-intake-approve', subject: companyId,
    outcome: 'ok', detail: `Candidate ${id} approved by ${actor}${possibleDuplicate ? ' (flagged as a possible duplicate)' : ''}.`,
  });
  return { ok: true, companyId, possibleDuplicate };
}

export function discardEmailIntakeCandidate(
  id: number,
  actor: string,
  note?: string | null,
): { ok: boolean; status?: number; error?: string } {
  const result = decideCandidate(id, 'discarded', actor, { note: note ?? null });
  if (!result.ok) {
    const notFound = /No email-intake candidate/.test(result.error ?? '');
    return { ok: false, status: notFound ? 404 : 409, error: result.error };
  }
  audit({
    provider: 'system', mode: 'local', action: 'email-intake-discard', subject: String(id),
    outcome: 'ok', detail: `Candidate ${id} discarded by ${actor}${note ? ` — ${note}` : ''}.`,
  });
  return { ok: true };
}
