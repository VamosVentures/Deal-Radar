import { audit } from '../lib/guard';
import { aiConfigured } from '../env';
import { callBudgetedModel } from './aiClient';
import { fenceNonce, fenceUntrusted, parseModelJson, sanitizeUntrustedContent } from './aiGuard';
import {
  commitImportedCompany, importedCompanySchema, PLACEHOLDER_FOUNDED_YEAR, slug,
} from './imports';
import {
  createBatch, decideCandidate, getCandidate, insertCandidate, listCandidates, updateCandidateExtracted,
  type EmailIntakeCandidate,
} from '../db/repos/emailIntake';
import { classifyCompany } from '../enrichment/verticalClassifier';
import { isClassified } from '../../shared/enrichment';
import { EMAIL_INTAKE_PROMPT } from '../../src/lib/emailIntakePrompt';
import { VERTICAL_ID_VALUES } from '../../src/types';

/**
 * Second intake path for messy, unstructured inbound deal-flow email text.
 *
 * Extraction runs one of two ways, both producing the same JSON reply
 * (shape set by EMAIL_INTAKE_PROMPT, src/lib/emailIntakePrompt.ts):
 *  - "Extract with Claude": the server sends the pasted email through the
 *    budgeted, guarded model gateway (extractEmailWithAi below).
 *  - Copy-paste: a reviewer runs the same prompt in their own Claude.ai
 *    chat and pastes the reply back (submitEmailIntakeBatch).
 * Either way the reply is treated like any other untrusted input — parsed
 * defensively, never assumed well-formed — and NOTHING it contains becomes
 * a real, scored company until a human approves that specific candidate
 * (see `commitImportedCompany` in ./imports.ts, the one path onto the
 * companies table, shared with the CSV importer).
 *
 * Approval needs only what a forwarded email can realistically give plus
 * the two things that can't be backfilled later: the company's name, its
 * vertical (a human call that research never changes — see the
 * conflict-resolution rule in server/services/enrichment.ts), and who
 * forwarded it (the record's only evidence). Every other field the email
 * didn't state is written as an honest placeholder with `missing`
 * provenance, using the same conventions Deal Discovery uses, so the UI
 * shows "Missing", the score is marked provisional, and any later real
 * value overwrites it.
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

function isVerticalId(v: unknown): v is (typeof VERTICAL_ID_VALUES)[number] {
  return typeof v === 'string' && (VERTICAL_ID_VALUES as readonly string[]).includes(v);
}

/**
 * Claude proposes a vertical for every company it can (see the prompt);
 * that proposal pre-fills the dropdown and its `verticalReason` is shown
 * beside it, so the reviewer confirms or changes it before approving.
 *
 * When Claude gave none (or something that isn't one of the five ids),
 * fall back to suggesting one from whatever text IS on record, using the
 * SAME deterministic, no-model classifier the enrichment pipeline uses
 * (server/enrichment/verticalClassifier.ts). That fallback is attached as
 * `suggestedVertical`/`suggestedVerticalReason`, never written into
 * `vertical` itself. Extra keys on this object are dropped harmlessly by
 * `importedCompanySchema` at approve time.
 */
function resolveProposedVertical(raw: Record<string, unknown>): Record<string, unknown> {
  const proposed = typeof raw.vertical === 'string' ? raw.vertical.trim().toLowerCase() : '';
  if (isVerticalId(proposed)) {
    const reason = typeof raw.verticalReason === 'string' ? raw.verticalReason.trim() : '';
    return { vertical: proposed, ...(reason ? { verticalReason: reason } : {}) };
  }
  return { vertical: undefined, verticalReason: undefined, ...suggestVertical(raw) };
}

function suggestVertical(raw: Record<string, unknown>): Record<string, unknown> {
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
    ...resolveProposedVertical(raw),
    evidence: [{
      type: 'Inbound referral',
      // Empty when Claude quoted nothing; completeForApproval fills a
      // plain description at approve time instead.
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

// ── "Extract with Claude" ─────────────────────────────────────────

/**
 * Longest email accepted for one extraction (~15K tokens) — comfortably
 * inside the default 30K-token per-request input cap together with the
 * prompt. Longer emails are refused rather than silently cut, because a
 * truncated email would silently lose whichever companies were at the end.
 */
export const MAX_EMAIL_CHARS = 60_000;

/** Room for ~50 companies per email; priced at this worst case by the budget gate. */
const EXTRACTION_MAX_OUTPUT_TOKENS = 12_000;

/**
 * Send a pasted email to Claude through the budgeted gateway and queue
 * what it reports, exactly as if the reviewer had pasted Claude's reply
 * themselves. The email is untrusted: sanitized, fenced with an
 * unguessable delimiter, and any instruction-shaped text in it is flagged
 * to the model and recorded in the audit log — and the model's output can
 * only ever become pending queue rows a human must approve.
 */
export async function extractEmailWithAi(args: { email: string; submittedBy: string }): Promise<EmailIntakeSubmitResult> {
  if (!aiConfigured()) {
    throw Object.assign(
      new Error('No AI provider is configured, so Extract with Claude is unavailable. Use the Claude.ai copy-paste option instead.'),
      { status: 503 },
    );
  }
  const content = sanitizeUntrustedContent(args.email, { maxChars: MAX_EMAIL_CHARS });
  if (!content.text.trim()) {
    throw Object.assign(new Error('The pasted email is empty.'), { status: 422 });
  }
  if (content.truncated) {
    throw Object.assign(
      new Error(`This email is too long to extract in one go (over ${MAX_EMAIL_CHARS.toLocaleString()} characters). Split it into parts and extract each one.`),
      { status: 413 },
    );
  }

  const prompt = [
    EMAIL_INTAKE_PROMPT.trimEnd(),
    fenceUntrusted('email', content, fenceNonce()),
    'Respond with ONLY the JSON object described above.',
  ].join('\n');

  const { text } = await callBudgetedModel({
    prompt,
    feature: 'email-intake-extract',
    maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    outputScalesWithInput: true,
    effort: 'low',
  });

  if (content.injectionFlags.length > 0) {
    audit({
      provider: 'ai', mode: 'live', action: 'email-intake-injection-flagged', subject: args.submittedBy,
      outcome: 'ok', detail: `Pasted email contained instruction-shaped text (${content.injectionFlags.join(', ')}); treated as data.`,
    });
  }

  try {
    return submitEmailIntakeBatch({ reply: text, submittedBy: args.submittedBy });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 422) {
      throw Object.assign(
        new Error(`Claude's reply couldn't be read as a list of companies (${err.message}). Try Extract again.`),
        { status: 502 },
      );
    }
    throw e;
  }
}

export function listEmailIntakeCandidates(): EmailIntakeCandidate[] {
  return listCandidates();
}

// ── Approval: name + vertical + forwarder; honest placeholders for the rest ──

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function firstEvidence(extracted: Record<string, unknown>): Record<string, unknown> | undefined {
  return Array.isArray(extracted.evidence) ? (extracted.evidence as Record<string, unknown>[])[0] : undefined;
}

/**
 * The fields that block approval — the only ones a reviewer MUST supply.
 * `evidence` here means "who forwarded this, and when", the Inbound
 * referral evidence's description.
 */
export function approvalBlockers(extracted: Record<string, unknown>): string[] {
  const blockers: string[] = [];
  if (!present(extracted.name)) blockers.push('name');
  if (!isVerticalId(extracted.vertical)) blockers.push('vertical');
  if (!present(firstEvidence(extracted)?.url)) blockers.push('evidence');
  return blockers;
}

/** A pending candidate's blocking-field list, for the review queue to show. */
export function candidateMissingFields(candidate: EmailIntakeCandidate): string[] {
  return approvalBlockers(candidate.extracted);
}

/**
 * Placeholders for everything an email may not state. Same wording and
 * values Deal Discovery uses (server/services/discovery.ts's
 * candidateToImportedCompany), so every intake path reads the same in the
 * UI and the scorer treats them identically: an "Unknown — not yet
 * researched" traction note is scored NOT ASSESSED, an "Unknown founder"
 * row is what founder resolution (setResolvedFounders) replaces, and the
 * founded-year sentinel is never displayed as a fact.
 */
const PLACEHOLDERS = {
  oneLiner: 'Unknown — pitch not yet verified',
  subcategory: 'Unclassified — requires manual review',
  stage: 'Unknown',
  city: 'Unknown',
  state: '??',
  foundedYear: PLACEHOLDER_FOUNDED_YEAR,
  teamSize: 1,
  traction: { level: 0, note: 'Unknown — not yet researched' },
  founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown — requires manual research' }],
} as const;

/**
 * Placeholders placeholderFieldsFor (./imports.ts) can't recognize by
 * shape, so they're marked `missing` explicitly. The rest (subcategory,
 * stage, city, state, founded year) it already detects.
 */
const EXPLICIT_UNKNOWN: Partial<Record<keyof typeof PLACEHOLDERS, string[]>> = {
  oneLiner: ['oneLiner'],
  teamSize: ['teamSize'],
  traction: ['tractionLevel', 'tractionNote'],
};

const NO_QUOTE_CLAIM = 'Referred as a lead in a forwarded deal-flow email.';
const STAGE_VALUES = ['Pre-seed', 'Seed', 'Series A', 'Stealth', 'Unknown'];

/**
 * Turn a reviewed candidate into a full company record: keep everything
 * stated, normalize harmless formatting (state casing, a website with no
 * scheme, stage casing, a founder with no stated role/background), and
 * fill every unstated field with a placeholder. A value that IS present
 * but still invalid (e.g. state "Texas") is left as-is so the schema
 * rejects it and the reviewer fixes it — never silently replaced.
 */
function completeForApproval(id: string, extracted: Record<string, unknown>): {
  record: Record<string, unknown>;
  unknownFields: string[];
} {
  const record: Record<string, unknown> = { ...extracted, id };
  const unknownFields: string[] = [];

  for (const key of Object.keys(PLACEHOLDERS) as (keyof typeof PLACEHOLDERS)[]) {
    if (!present(record[key])) {
      record[key] = structuredClone(PLACEHOLDERS[key]);
      unknownFields.push(...(EXPLICIT_UNKNOWN[key] ?? []));
    }
  }

  if (typeof record.state === 'string' && record.state !== '??') record.state = record.state.trim().toUpperCase();
  if (typeof record.stage === 'string') {
    const match = STAGE_VALUES.find((s) => s.toLowerCase() === (record.stage as string).trim().toLowerCase());
    if (match) record.stage = match;
  }
  if (typeof record.website === 'string') {
    const w = record.website.trim();
    if (!w) delete record.website;
    else if (!/^https?:\/\//i.test(w)) record.website = `https://${w}`;
  }
  if (Array.isArray(record.founders)) {
    const named = (record.founders as Record<string, unknown>[])
      .filter((f) => typeof f?.name === 'string' && f.name.trim().length >= 2)
      .map((f) => ({
        name: (f.name as string).trim(),
        role: typeof f.role === 'string' && f.role.trim() ? f.role.trim() : 'Unknown',
        background: typeof f.background === 'string' && f.background.trim().length >= 3
          ? f.background.trim() : 'Unknown — requires manual research',
      }));
    record.founders = named.length > 0 ? named : structuredClone(PLACEHOLDERS.founders);
  }
  const evidence = firstEvidence(record);
  if (evidence) {
    record.evidence = [{
      ...evidence,
      claim: typeof evidence.claim === 'string' && evidence.claim.trim().length >= 3 ? evidence.claim.trim() : NO_QUOTE_CLAIM,
    }];
  }

  return { record, unknownFields };
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

  const blockers = approvalBlockers(existing.extracted);
  if (blockers.length > 0) {
    return {
      ok: false, status: 422,
      error: 'Fill in the company name, its vertical, and who forwarded it before approving.',
      missingFields: blockers,
    };
  }

  const { record, unknownFields } = completeForApproval(
    `imported-${slug(String(existing.extracted.name))}`,
    existing.extracted,
  );
  const parsed = importedCompanySchema.safeParse(record);
  if (!parsed.success) {
    // Only values that are PRESENT but invalid can land here — every
    // absent field was given a valid placeholder above.
    return {
      ok: false, status: 422,
      error: 'Some values need fixing before this can be approved.',
      missingFields: [...new Set(parsed.error.issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`))],
    };
  }

  const { possibleDuplicate, companyId } = commitImportedCompany(parsed.data, {
    source: 'email-intake',
    extraUnknownFields: unknownFields,
  });
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
