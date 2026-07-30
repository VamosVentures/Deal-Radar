import { z } from 'zod';

/**
 * Internal company review notes — the contract both sides share.
 *
 * A note is an investment-team opinion written by a reviewer, not
 * sourced evidence about a company. Evidence has a URL, a date, and a
 * publisher; a note has an author and nothing else backing it. They are
 * deliberately separate systems: evidence is append-only and citable,
 * notes are editable, archivable, and confidential.
 *
 * Normalization and the length limit live HERE rather than in the route
 * so the character counter in the UI counts exactly what the server
 * will store. A counter that disagrees with the limit it is counting
 * toward is worse than no counter.
 */

/**
 * Maximum stored length, measured AFTER normalization.
 *
 * 4000 characters is several paragraphs — long enough for a real
 * investment-committee opinion, short enough that a runaway paste or a
 * scripted caller cannot turn the notes table into bulk storage. A
 * reviewer who needs more than this is writing a memo, not a note.
 */
export const NOTE_MAX_LENGTH = 4000;

/**
 * Normalize a note body to exactly what gets stored.
 *
 * - CRLF/CR line endings folded to LF, so the same note typed on
 *   Windows and macOS is byte-identical in the database.
 * - C0/C1 control characters removed (tab and newline survive). These
 *   arrive from pasted rich text and terminal output; they are
 *   invisible, they break `===` comparisons, and NUL in particular
 *   truncates strings in some consumers.
 * - Trailing whitespace stripped per line, and runs of blank lines
 *   collapsed to at most one — pasting from a document otherwise
 *   carries dozens of empty lines into the panel.
 * - Leading/trailing whitespace trimmed off the whole body.
 *
 * Deliberately NOT done: escaping, tag-stripping, or entity-encoding.
 * The body is stored as the reviewer typed it and every reader treats
 * it as plain text — see the rendering note below. Sanitizing on input
 * would corrupt legitimate text (a note about a `<Series A>` term
 * sheet) while doing nothing that output-side plain-text treatment
 * does not already do correctly.
 */
export function normalizeNoteBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // C0 controls except tab (09) and newline (0A), plus DEL and the C1
    // block. Matching control characters is the entire point here, so the
    // lint rule warning about it is suppressed deliberately rather than
    // worked around — a paste from a terminal or a rich-text editor really
    // does carry these, and they must not reach the database.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A note body as submitted. `.transform` normalizes first, so the
 * emptiness and length checks apply to what would actually be stored:
 * a body of only spaces and newlines is empty, not 12 characters long.
 */
export const noteBodySchema = z
  .string()
  .max(NOTE_MAX_LENGTH * 4, { message: 'This note is far longer than the limit — nothing was saved.' })
  .transform(normalizeNoteBody)
  .refine((s) => s.length > 0, { message: 'A note cannot be empty. Write something, or cancel.' })
  .refine((s) => s.length <= NOTE_MAX_LENGTH, {
    message: `A note cannot be longer than ${NOTE_MAX_LENGTH} characters.`,
  });

/** Which identity provider established a reviewer's identity. */
export const REVIEWER_SOURCES = ['local-admin', 'microsoft-sso'] as const;
export type ReviewerSource = (typeof REVIEWER_SOURCES)[number];

export const reviewerSchema = z.object({
  /** Stable subject id: 'local-admin' today, an Entra object id under SSO. */
  id: z.string().min(1),
  /** Human-readable label for display. */
  label: z.string().min(1),
  source: z.enum(REVIEWER_SOURCES),
});
export type Reviewer = z.infer<typeof reviewerSchema>;

export const companyNoteSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  /**
   * PLAIN TEXT. Never render this as HTML and never run it through a
   * Markdown renderer — a note is untrusted text written by a person
   * and may legitimately contain angle brackets, backticks, or a URL
   * that must not become a link. React's default text interpolation is
   * correct; `dangerouslySetInnerHTML` is not.
   */
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  reviewer: reviewerSchema,
});
export type CompanyNote = z.infer<typeof companyNoteSchema>;

/** True when an edit would not change anything — used to skip a pointless write. */
export function noteBodyUnchanged(existing: string, incoming: string): boolean {
  return existing === normalizeNoteBody(incoming);
}
