import type { Request } from 'express';
import type { Reviewer } from '../../shared/notes';
import { readCookie, SESSION_COOKIE, verifySessionToken } from './auth';

/**
 * Who wrote a note.
 *
 * Resolved from the AUTHENTICATED SESSION and never from the request
 * body. Every other actor in this codebase arrives as a client-supplied
 * `actor` string (`{ actor: 'team' }`) because those routes record an
 * operational action, and a wrong label there is a cosmetic problem. A
 * note is different: it is an attributed opinion that outlives the
 * person who wrote it and may be read back to justify a decision. If
 * the client could name its own author, the attribution would be
 * decoration rather than a fact, and anyone who could reach the API
 * could write a note signed as somebody else.
 *
 * Today this is a single shared administrator password (see
 * server/lib/auth.ts), so there is exactly one identity to resolve and
 * it is honest about being shared: 'Local administrator', not a
 * fabricated person. The three-part shape is what makes the eventual
 * move to Microsoft SSO additive rather than a migration —
 *
 *   local admin today   { id: 'local-admin', label: 'Local administrator',
 *                         source: 'local-admin' }
 *   Entra user later    { id: <oid claim>,   label: <name or UPN>,
 *                         source: 'microsoft-sso' }
 *
 * — because `reviewer_source` keeps the two kinds of identity
 * distinguishable in stored rows. Notes written while this was a shared
 * password must not later be mistaken for the work of a named
 * individual, which is exactly what would happen if authorship were a
 * single free-text column.
 */

export const LOCAL_ADMIN_REVIEWER: Reviewer = {
  id: 'local-admin',
  label: 'Local administrator',
  source: 'local-admin',
};

/**
 * The reviewer for this request, or null when there is no valid
 * session. Callers behind `requireAdmin` will always get a reviewer;
 * the null case is a fail-closed guard, not an expected path — a note
 * is never attributed to an anonymous author.
 *
 * When Microsoft SSO lands, this is the ONE place that changes: read
 * the verified claims off the session and return them in this shape.
 * No caller, table, or test needs to know which provider answered.
 */
export function resolveReviewer(req: Request): Reviewer | null {
  if (!verifySessionToken(readCookie(req, SESSION_COOKIE))) return null;
  return LOCAL_ADMIN_REVIEWER;
}
