import type { Request } from 'express';
import type { Reviewer } from '../../shared/notes';
import { readCookie, readSession, SESSION_COOKIE } from './auth';

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
 * Two kinds of identity can answer, and `reviewer_source` keeps them
 * distinguishable in stored rows —
 *
 *   shared password   { id: 'local-admin', label: 'Local administrator',
 *                       source: 'local-admin' }
 *   Entra user        { id: <oid claim>,   label: <name> <email>,
 *                       source: 'microsoft-sso' }
 *
 * — because a note written while sign-in was one shared password must
 * never later be mistaken for the work of a named individual. That is
 * exactly what would happen if authorship were a single free-text
 * column, and it is why the local identity is labeled honestly as
 * shared instead of borrowing a person's name.
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
 * Under Microsoft SSO the label carries BOTH the display name and the
 * verified address. Display names are not unique in a directory and
 * they change (marriage, preferred name, a second "J. Rivera"); the
 * address is what makes an attribution six months from now
 * unambiguous. The Entra object id is the stable key, but nobody reads
 * a GUID off a note.
 */
export function resolveReviewer(req: Request): Reviewer | null {
  const session = readSession(readCookie(req, SESSION_COOKIE));
  if (!session) return null;
  if (session.source === 'microsoft-sso') {
    return {
      id: session.sub,
      label: session.email && session.label !== session.email
        ? `${session.label} <${session.email}>`
        : (session.email ?? session.label),
      source: 'microsoft-sso',
    };
  }
  return LOCAL_ADMIN_REVIEWER;
}
