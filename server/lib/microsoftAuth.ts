import crypto from 'node:crypto';
import { env, microsoftSsoRedirectUri } from '../env';
import { fetchWithRetry } from './http';

/**
 * Microsoft Entra sign-in: the OpenID Connect authorization-code flow,
 * verified server-side.
 *
 * Scope of this file: turn an `id_token` that arrived on our callback
 * into a claim set we are willing to call an identity, or throw. It
 * does NOT mint sessions (server/lib/auth.ts), decide who may sign in
 * beyond the checks below (server/routes/auth.ts), or touch mailboxes
 * (server/services/outlook.ts).
 *
 * No hand-rolled token cryptography. Everything here is the published
 * OIDC flow plus Node's own `crypto` primitives:
 *
 *   - key material comes from Microsoft's JWKS, fetched from the
 *     `jwks_uri` in the tenant's discovery document — never pinned,
 *     never guessed, never a shared secret;
 *   - the signature check is `crypto.verify('RSA-SHA256', …)` against a
 *     public key imported from the JWK with `crypto.createPublicKey`;
 *   - `alg` is allowlisted to RS256 before any key is looked up, which
 *     is what stops both `alg: none` and the classic RS256→HS256
 *     confusion where a token is "verified" against the public key
 *     used as an HMAC secret.
 *
 * A caller that skipped these checks and simply decoded the payload
 * would be accepting attacker-authored JSON, because the base64 in a
 * JWT is encoding, not protection. Every claim read below is read only
 * after the signature over it has been verified.
 */

// ── Claim/JWKS shapes ────────────────────────────────────────────

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  tid?: string;
  oid?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  upn?: string;
  /** Present when the identity was federated in from ANOTHER provider (guest/B2B). */
  idp?: string;
  /**
   * Authentication Methods References — which factors Entra actually
   * checked for THIS sign-in, as opposed to which ones the account is
   * capable of. This is the only part of the token that says anything
   * about how strongly the person was authenticated.
   *
   * NOT emitted by default on v2.0 id_tokens (this app uses the v2.0
   * endpoint — see discoveryUrl()). The app registration has to add
   * `amr` as an optional ID-token claim, which is why its absence is
   * treated as "unproven" rather than "fine". See requireMfa() below.
   */
  amr?: unknown;
  /**
   * "Email domain owner verified" — Microsoft's own signal that the
   * email in this token belongs to a domain the tenant proved it owns.
   * Explicitly `false` means the address is self-asserted.
   */
  xms_edov?: boolean | string;
}

/** What the rest of the app is allowed to treat as a signed-in employee. */
export interface VerifiedMicrosoftIdentity {
  /** Entra object id — stable per user per tenant; the reviewer's id. */
  oid: string;
  tid: string;
  /** Verified work address, lowercased. */
  email: string;
  /** Display name when the token carries one, else the address. */
  name: string;
}

/** Every failure here is a deliberate, user-facing 401 — never a leaked internal error. */
function authError(message: string): Error {
  return Object.assign(new Error(message), { status: 401 });
}

// ── Multi-factor enforcement ─────────────────────────────────────

/**
 * The `amr` values that, on their own, prove Entra checked more than one
 * factor for this specific sign-in.
 *
 * Deliberately narrow. Entra emits `mfa` whenever a multi-factor
 * requirement was satisfied — including passwordless sign-ins, where the
 * array looks like ["face", "mfa"] or ["fido", "mfa"] — and `ngcmfa`
 * when a "next generation credential" (Windows Hello for Business,
 * passkey provisioning) satisfied it. Those two are the claims Microsoft
 * documents as meaning multi-factor, so those two are what is accepted.
 *
 * Single-method values are NOT here on purpose. `otp`, `sms`, `rsa` and
 * `phh` each describe ONE factor: a tenant can be configured to accept a
 * texted code as a first and only factor, so seeing `sms` alone does not
 * establish that two factors were used. `wiaormfa` is excluded for the
 * same reason its name suggests — it means the person did Windows
 * Integrated Auth *or* MFA, which is precisely the ambiguity this check
 * exists to remove.
 */
export const MFA_AMR_VALUES: readonly string[] = ['mfa', 'ngcmfa'];

/**
 * Whether an `amr` claim proves multi-factor.
 *
 * Fails closed on every shape that is not an array of strings. A token
 * with no `amr` at all is the common case worth naming: it does not mean
 * "no MFA happened", it means the app registration is not emitting the
 * claim, so this server cannot tell either way. Treating unknown as
 * satisfied would turn the whole check into decoration.
 */
export function amrProvesMfa(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((m) => typeof m === 'string' && MFA_AMR_VALUES.includes(m.toLowerCase()));
}

/**
 * Why a sign-in was refused for want of MFA, written for the person who
 * hit it rather than for a log. Surfaced on the sign-in screen by
 * server/routes/auth.ts, so it names the fix without naming any claim
 * the reader has no way to inspect.
 */
export const MFA_REQUIRED_MESSAGE =
  'Deal Radar requires multi-factor authentication. Your Microsoft sign-in did not '
  + 'include a second factor — set up MFA on your Vamos account, or ask IT to confirm '
  + 'the Deal Radar app registration releases the "amr" claim, then sign in again.';

// ── Discovery + JWKS, cached ─────────────────────────────────────

const DISCOVERY_TTL_MS = 60 * 60_000; // 1 hour
const JWKS_TTL_MS = 60 * 60_000;

let discoveryCache: { at: number; doc: OidcDiscovery } | null = null;
let jwksCache: { at: number; keys: Jwk[] } | null = null;

/**
 * Test seam. Microsoft flows are covered with fixtures only — no test
 * reaches login.microsoftonline.com — so the discovery document and
 * signing keys can be supplied directly. Setting this to null restores
 * real network resolution.
 */
let oidcOverride: { discovery: OidcDiscovery; keys: Jwk[] } | null = null;
export function __setMicrosoftOidcForTests(
  override: { discovery: OidcDiscovery; keys: Jwk[] } | null,
): void {
  oidcOverride = override;
  discoveryCache = null;
  jwksCache = null;
}

/** The v2.0 discovery URL for the configured single tenant. */
export function discoveryUrl(): string {
  return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/v2.0/.well-known/openid-configuration`;
}

export async function getDiscovery(): Promise<OidcDiscovery> {
  if (oidcOverride) return oidcOverride.discovery;
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.doc;
  const res = await fetchWithRetry(discoveryUrl());
  if (!res.ok) {
    throw authError('Could not reach Microsoft sign-in configuration. Try again in a moment.');
  }
  const doc = (await res.json()) as OidcDiscovery;
  if (!doc.issuer || !doc.jwks_uri || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw authError('Microsoft returned an incomplete sign-in configuration.');
  }
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

async function getSigningKeys(force = false): Promise<Jwk[]> {
  if (oidcOverride) return oidcOverride.keys;
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const { jwks_uri } = await getDiscovery();
  const res = await fetchWithRetry(jwks_uri);
  if (!res.ok) throw authError('Could not reach Microsoft signing keys. Try again in a moment.');
  const { keys } = (await res.json()) as { keys?: Jwk[] };
  if (!keys?.length) throw authError('Microsoft returned no signing keys.');
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/**
 * The key that signed this token, by `kid`.
 *
 * An unknown `kid` triggers exactly one forced JWKS refetch: Microsoft
 * rotates signing keys routinely, and a cached key set is the normal
 * reason a legitimate token looks unsigned. One retry absorbs a
 * rotation; more would let a token with a garbage `kid` drive
 * unbounded outbound requests.
 */
async function findKey(kid: string): Promise<Jwk> {
  const usable = (k: Jwk) => k.kid === kid && k.kty === 'RSA' && !!k.n && !!k.e;
  const cached = (await getSigningKeys()).find(usable);
  if (cached) return cached;
  const refreshed = (await getSigningKeys(true)).find(usable);
  if (refreshed) return refreshed;
  throw authError('The Microsoft token was signed with an unrecognized key.');
}

// ── ID-token verification ────────────────────────────────────────

const CLOCK_SKEW_S = 120;

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** The account's work address, preferring claims Entra controls over self-asserted ones. */
function addressFrom(claims: IdTokenClaims): string | null {
  const candidate = claims.preferred_username ?? claims.upn ?? claims.email;
  return candidate?.includes('@') ? candidate.trim().toLowerCase() : null;
}

/**
 * Verify an `id_token` and return the identity it proves.
 *
 * Order matters: signature first, then every claim. Checks that read a
 * claim before the signature is confirmed are checks on unauthenticated
 * input.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { nonce: string },
): Promise<VerifiedMicrosoftIdentity> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw authError('The Microsoft sign-in response was malformed.');
  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Header — allowlist the algorithm BEFORE fetching any key.
  let header: { alg?: string; kid?: string; typ?: string };
  try {
    header = decodeSegment(headerB64) as typeof header;
  } catch {
    throw authError('The Microsoft sign-in response was malformed.');
  }
  if (header.alg !== 'RS256') {
    throw authError('The Microsoft token used an unsupported signing algorithm.');
  }
  if (!header.kid) throw authError('The Microsoft token did not identify its signing key.');

  // 2. Signature over the exact bytes that were signed.
  const jwk = await findKey(header.kid);
  const publicKey = crypto.createPublicKey({
    key: { kty: 'RSA', n: jwk.n!, e: jwk.e! },
    format: 'jwk',
  });
  const signatureValid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!signatureValid) throw authError('The Microsoft token signature did not verify.');

  // 3. Only now is the payload trustworthy enough to read.
  let claims: IdTokenClaims;
  try {
    claims = decodeSegment(payloadB64) as IdTokenClaims;
  } catch {
    throw authError('The Microsoft sign-in response was malformed.');
  }

  // 4. Issuer — must be the discovery document's own issuer value.
  const { issuer } = await getDiscovery();
  if (!claims.iss || claims.iss !== issuer) {
    throw authError('The Microsoft token came from an unexpected issuer.');
  }

  // 5. Tenant — THE primary restriction. A correctly-signed token from
  //    another directory is a valid Microsoft token and still not an
  //    employee of this company.
  if (!claims.tid || claims.tid.toLowerCase() !== env.MICROSOFT_TENANT_ID.toLowerCase()) {
    throw authError('That account is not in the Vamos Ventures Microsoft directory.');
  }

  // 6. Audience — the token must have been minted FOR this application.
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!env.MICROSOFT_CLIENT_ID || !audiences.includes(env.MICROSOFT_CLIENT_ID)) {
    throw authError('The Microsoft token was issued for a different application.');
  }

  // 7. Lifetime.
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) {
    throw authError('The Microsoft sign-in expired. Please sign in again.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) {
    throw authError('The Microsoft token is not valid yet.');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) {
    throw authError('The Microsoft token is not valid yet.');
  }

  // 8. Nonce — binds this token to the sign-in WE started. Compared in
  //    constant time and length-checked first, since a mismatch of
  //    length would otherwise make timingSafeEqual throw.
  const presented = claims.nonce ?? '';
  if (
    presented.length !== expected.nonce.length ||
    !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected.nonce))
  ) {
    throw authError('This sign-in could not be matched to a request from this app. Start again.');
  }

  // 9. A stable subject to attribute work to.
  if (!claims.oid) throw authError('The Microsoft token did not include a user object id.');

  // 10. Verified identity, not merely a well-formed one.
  //     `idp` present and different from the issuer means the account
  //     was federated in from somewhere else (a guest/B2B invitee):
  //     it lives in the tenant but its credentials are checked by an
  //     outside directory, so tenant membership alone no longer implies
  //     "an employee whose password Vamos controls".
  if (claims.idp && claims.idp !== issuer) {
    throw authError('Guest and externally-federated accounts cannot sign in to Deal Radar.');
  }
  //     `xms_edov: false` means Microsoft is telling us the address is
  //     self-asserted, which would make the domain check below
  //     worthless. Absent is fine (not all tenants emit it); false is not.
  if (claims.xms_edov === false || claims.xms_edov === 'false') {
    throw authError('That account’s email address is not verified by the directory.');
  }

  // 11. Domain — a SECONDARY confirmation on top of the tenant check.
  //     On its own this proves nothing (it is text in a token); after
  //     step 5 it usefully excludes non-employee identities that a
  //     tenant may legitimately contain.
  const email = addressFrom(claims);
  const domain = env.MICROSOFT_ALLOWED_EMAIL_DOMAIN.toLowerCase();
  if (!email || !email.endsWith(`@${domain}`)) {
    throw authError(`Deal Radar is limited to @${domain} accounts.`);
  }

  // 12. Multi-factor — required for every account, with no exemption
  //     list and no environment switch to turn it off.
  //
  //     Ordered LAST among the identity checks on purpose: someone whose
  //     account may not use this app at all (wrong tenant, guest, wrong
  //     domain) should be told that, not sent away to go configure MFA
  //     for an account that still would not be let in afterwards.
  //
  //     Entra's Conditional Access policy is what MAKES a second factor
  //     happen; this check is what makes the application refuse to
  //     believe a sign-in that did not have one. Both are needed — a
  //     policy can be scoped to exclude a group, put in report-only
  //     mode, or switched off in the portal without anyone touching this
  //     repository, and none of those should silently become a way into
  //     Deal Radar. See docs/microsoft-mfa-setup.md.
  if (!amrProvesMfa(claims.amr)) {
    throw authError(MFA_REQUIRED_MESSAGE);
  }

  return {
    oid: claims.oid,
    tid: claims.tid,
    email,
    name: claims.name?.trim() || email,
  };
}

// ── Authorization request + code exchange ────────────────────────

/**
 * Sign-in scopes ONLY — the least this app can ask for and still know
 * who is at the keyboard. Mailbox scopes are a separate, later, opt-in
 * consent (see server/services/outlook.ts); bundling them here would
 * mean nobody could sign in without also granting mailbox access.
 */
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email', 'User.Read'] as const;

export async function buildAuthorizeUrl(args: {
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<string> {
  const { authorization_endpoint } = await getDiscovery();
  const params = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID!,
    response_type: 'code',
    // Derived from APP_BASE_URL unless explicitly overridden — the same
    // value the code exchange below sends, which Entra requires.
    redirect_uri: microsoftSsoRedirectUri(),
    response_mode: 'query',
    scope: SIGN_IN_SCOPES.join(' '),
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    // Force account selection so a shared workstation cannot silently
    // reuse whoever signed in last — attribution on notes depends on it.
    prompt: 'select_account',
  });
  return `${authorization_endpoint}?${params}`;
}

/** PKCE verifier/challenge pair (S256), per RFC 7636. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Exchange the authorization code for tokens.
 *
 * Returns the `id_token` and nothing else on purpose. Sign-in has no
 * use for the access token and no reason to keep it: this app reads the
 * identity, mints its own session, and lets Microsoft's tokens fall out
 * of scope unstored. Mailbox tokens — the ones that ARE persisted, and
 * are encrypted at rest — come from the separate Outlook consent.
 */
export async function exchangeCodeForIdToken(args: {
  code: string;
  codeVerifier: string;
}): Promise<string> {
  const { token_endpoint } = await getDiscovery();
  const res = await fetchWithRetry(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      grant_type: 'authorization_code',
      code: args.code,
      // Must byte-match the redirect_uri sent on the authorize request.
      redirect_uri: microsoftSsoRedirectUri(),
      scope: SIGN_IN_SCOPES.join(' '),
      code_verifier: args.codeVerifier,
    }),
  });
  if (!res.ok) {
    // The response body can echo the code and client secret — never
    // surface or log it. The Entra-side cause is what matters here.
    throw authError('Microsoft rejected this sign-in. Check the Entra app registration and redirect URI.');
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw authError('Microsoft did not return an identity token.');
  return body.id_token;
}
