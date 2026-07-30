import { store, type OAuthStateRecord } from './store';
import { randomToken } from './crypto';

/**
 * Single-use, expiring `state` records for the redirect-based flows.
 *
 * Both Microsoft flows (sign-in, mailbox consent) and HubSpot land on
 * callbacks that are reachable without a session — the provider
 * redirects the BROWSER there, so no cookie is guaranteed. `state` is
 * therefore the only thing distinguishing "a response to a sign-in this
 * app started" from "a URL somebody constructed", which is why it is
 * issued server-side, matched server-side, and consumed exactly once.
 *
 * Shared here rather than reimplemented per flow so the expiry check,
 * the single-use deletion, and the purpose match cannot drift apart
 * between them.
 */

const STATE_TTL_MS = 10 * 60_000;

/**
 * Ceiling on simultaneously-pending redirects. The callbacks are
 * public, so anyone who can reach the origin can ask for a state; the
 * oldest are dropped past this bound rather than letting a script grow
 * the row without limit. Fifty is far more than the handful a real
 * person accumulates by retrying a sign-in.
 */
const MAX_PENDING = 50;

function prune(now: number): void {
  store.raw.oauthStates = store.raw.oauthStates
    .filter((s) => new Date(s.expiresAt).getTime() > now)
    .slice(-MAX_PENDING);
}

export function issueOAuthState(
  purpose: 'outlook' | 'sso',
  extra: { nonce?: string; codeVerifier?: string } = {},
): OAuthStateRecord {
  const now = Date.now();
  prune(now);
  const record: OAuthStateRecord = {
    state: randomToken(),
    expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
    purpose,
    ...extra,
  };
  store.raw.oauthStates.push(record);
  store.save();
  return record;
}

/**
 * Match and delete a state, or throw. Deleting BEFORE the caller does
 * anything with the result is what makes a replayed callback fail:
 * the second delivery of the same authorization code finds nothing.
 */
export function consumeOAuthState(
  state: string,
  purpose: 'outlook' | 'sso',
): OAuthStateRecord {
  const now = Date.now();
  prune(now);
  const idx = store.raw.oauthStates.findIndex(
    // Records predating `purpose` can only be Outlook's — that was the
    // only redirect flow at the time they could have been written.
    (s) => s.state === state && (s.purpose ?? 'outlook') === purpose,
  );
  if (idx === -1) {
    throw Object.assign(
      new Error(
        purpose === 'sso'
          ? 'This sign-in could not be matched to a request from this app. Start again.'
          : 'OAuth state is invalid or expired. Start the connection again.',
      ),
      { status: 400 },
    );
  }
  const [record] = store.raw.oauthStates.splice(idx, 1);
  store.save();
  return record;
}
