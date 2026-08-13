import { env, notConnected, outlookConfigured, outlookRedirectUri } from '../env';
import { store, type TokenRecord } from '../lib/store';
import { audit } from '../lib/guard';
import { decrypt, encrypt } from '../lib/crypto';
import { consumeOAuthState, issueOAuthState } from '../lib/oauthState';
import { fetchWithRetry } from '../lib/http';

/**
 * Microsoft Outlook via Graph. OAuth authorization-code flow with
 * server-side state validation; tokens are encrypted at rest and
 * NEVER sent to the browser or stored in localStorage. The only
 * mail action supported anywhere in this codebase is creating a
 * DRAFT — there is intentionally no send path.
 *
 * There is no mock mailbox: when Outlook is not configured, every
 * mail action fails with an honest "not connected" error.
 */

/**
 * Mailbox scopes — requested ONLY when a person explicitly connects
 * Outlook, never at sign-in.
 *
 * This is the whole point of the split: signing in to look at company
 * records asks for `openid profile email User.Read` and nothing more
 * (see SIGN_IN_SCOPES in server/lib/microsoftAuth.ts), so nobody has
 * to hand over mailbox access to read a table. Consent for the two
 * escalates independently and lands on two different callbacks.
 *
 * What is deliberately absent, and must stay absent:
 *
 *   Mail.Send                  — there is no send path in this
 *                                codebase. A person sends from their
 *                                own Outlook, having read the draft.
 *   Mail.ReadWrite.Shared      — other people's mailboxes.
 *   Mail.* application scopes  — tenant-wide mailbox access.
 *
 * `User.Read` is re-listed here rather than assumed: mailbox consent
 * must work in `local` auth mode too, where no Microsoft sign-in
 * happened and `/me` is how the connected account is identified. When
 * SSO did run, re-requesting an already-granted scope is a no-op, not
 * an escalation.
 */
export const OUTLOOK_SCOPES = ['offline_access', 'Mail.ReadWrite', 'User.Read'] as const;

/**
 * The only mail folder this integration is permitted to read.
 *
 * `Mail.ReadWrite` is broader than the workflow — Microsoft offers no
 * narrower delegated drafts-only permission — so the narrowing is
 * enforced here instead: leads are read from a folder a person created
 * and deliberately moved mail into, never from the inbox at large.
 * Reading is not wired to any UI or sourcing run today; see
 * KNOWN_LIMITATIONS.md.
 */
export const LEAD_FOLDER_NAME = 'Deal Radar Leads';

const SCOPES = OUTLOOK_SCOPES;

const OUTLOOK_NOT_CONNECTED_HINT =
  'Add MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI and SESSION_SECRET to .env, then use Connect Outlook under Data Sources & Refresh.';

export interface OutlookStatus {
  mode: 'mock' | 'live' | 'disconnected';
  connected: boolean;
  account: string | null;
  permissions: string[];
  lastConnectedAt: string | null;
  detail: string;
}

export interface DraftResult {
  draftId: string;
  webLink: string | null;
  demo: boolean;
}

export function buildDraftPayload(args: {
  to: string;
  subject: string;
  body: string;
}) {
  if (!args.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.to)) {
    throw Object.assign(new Error('A valid recipient email address is required before a draft can be created.'), { status: 400 });
  }
  if (!args.subject.trim()) {
    throw Object.assign(new Error('A subject line is required.'), { status: 400 });
  }
  return {
    subject: args.subject,
    body: { contentType: 'Text', content: args.body },
    toRecipients: [{ emailAddress: { address: args.to } }],
    isDraft: true,
  };
}

export interface OutlookService {
  mode: 'mock' | 'live' | 'disconnected';
  status(): Promise<OutlookStatus>;
  /** Cheap real call that proves the connection works. */
  verifyConnection(): Promise<{ ok: boolean; detail: string }>;
  beginConnect(): Promise<{ authUrl: string | null; message: string }>;
  handleCallback(code: string, state: string): Promise<{ account: string }>;
  createDraft(args: { to: string; subject: string; body: string }): Promise<DraftResult>;
  disconnect(): Promise<void>;
}

// ── Not configured: honest errors, no simulation ─────────────────

class DisconnectedOutlook implements OutlookService {
  mode = 'disconnected' as const;

  async status(): Promise<OutlookStatus> {
    return {
      mode: 'disconnected',
      connected: false,
      account: null,
      permissions: [],
      lastConnectedAt: null,
      detail: 'This integration is not connected. Add Microsoft credentials to .env to connect a mailbox.',
    };
  }

  async verifyConnection() {
    return { ok: false, detail: 'Outlook is not connected — no Microsoft credentials are configured.' };
  }

  async beginConnect() {
    return {
      authUrl: null,
      message: 'Outlook is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI, and SESSION_SECRET in .env first.',
    };
  }

  async handleCallback(): Promise<{ account: string }> {
    throw notConnected('Outlook', OUTLOOK_NOT_CONNECTED_HINT);
  }

  async createDraft(): Promise<DraftResult> {
    throw notConnected('Outlook', OUTLOOK_NOT_CONNECTED_HINT);
  }

  async disconnect() {
    store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'outlook');
    store.save();
  }
}

// ── Live (Microsoft Graph) ───────────────────────────────────────

const GRAPH = 'https://graph.microsoft.com/v1.0';

class LiveOutlook implements OutlookService {
  mode = 'live' as const;

  private authority() {
    return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}`;
  }

  private token(): TokenRecord | undefined {
    return store.raw.tokens.find((t) => t.provider === 'outlook');
  }

  async status(): Promise<OutlookStatus> {
    const t = this.token();
    return {
      mode: 'live',
      connected: !!t,
      account: t?.account ?? null,
      permissions: t?.scopes ?? [],
      lastConnectedAt: t?.connectedAt ?? null,
      detail: t ? 'Connected via Microsoft Graph.' : 'Not connected. Use Connect Outlook to sign in.',
    };
  }

  async beginConnect() {
    const { state } = issueOAuthState('outlook');
    const params = new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      response_type: 'code',
      // Derived from APP_BASE_URL unless explicitly overridden.
      redirect_uri: outlookRedirectUri(),
      response_mode: 'query',
      scope: SCOPES.join(' '),
      state,
    });
    return {
      authUrl: `${this.authority()}/oauth2/v2.0/authorize?${params}`,
      message: 'Redirecting to Microsoft sign-in.',
    };
  }

  async handleCallback(code: string, state: string): Promise<{ account: string }> {
    // Single-use state, scoped to the mailbox flow so a sign-in state
    // can never be redeemed here (see server/lib/oauthState.ts).
    consumeOAuthState(state, 'outlook');

    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      code,
      // Must byte-match the redirect_uri sent on the authorize request.
      redirect_uri: outlookRedirectUri(),
    });
    const me = await this.graph<{ mail?: string; userPrincipalName: string }>(
      '/me', tokens.access_token,
    );
    const account = me.mail ?? me.userPrincipalName;
    store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'outlook');
    store.raw.tokens.push({
      provider: 'outlook',
      account,
      scopes: [...SCOPES],
      cipher: encrypt(tokens.access_token),
      refreshCipher: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      connectedAt: new Date().toISOString(),
    });
    store.save();
    audit({
      provider: 'outlook', mode: 'live', action: 'connect',
      subject: account, outcome: 'ok', detail: 'OAuth connection established',
    });
    return { account };
  }

  private async exchange(body: Record<string, string>) {
    const res = await fetchWithRetry(`${this.authority()}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MICROSOFT_CLIENT_ID!,
        client_secret: env.MICROSOFT_CLIENT_SECRET!,
        scope: SCOPES.join(' '),
        ...body,
      }),
    });
    if (!res.ok) {
      throw Object.assign(new Error('Microsoft rejected the credentials. Check the Entra app registration, client secret, and redirect URI.'), { status: 401 });
    }
    return (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
  }

  /** Returns a fresh access token, refreshing transparently when expired. */
  private async accessToken(): Promise<string> {
    const t = this.token();
    if (!t) {
      throw notConnected('Outlook', 'Use Connect Outlook under Data Sources & Refresh to sign in.');
    }
    if (new Date(t.expiresAt).getTime() - Date.now() > 60_000) {
      return decrypt(t.cipher);
    }
    if (!t.refreshCipher) {
      throw Object.assign(new Error('The Outlook session expired and no refresh token is available. Reconnect Outlook.'), { status: 401 });
    }
    const refreshed = await this.exchange({
      grant_type: 'refresh_token',
      refresh_token: decrypt(t.refreshCipher),
    });
    t.cipher = encrypt(refreshed.access_token);
    if (refreshed.refresh_token) t.refreshCipher = encrypt(refreshed.refresh_token);
    t.expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    store.save();
    return refreshed.access_token;
  }

  async verifyConnection() {
    try {
      const token = await this.accessToken();
      await this.graph('/me?$select=id', token);
      return { ok: true, detail: 'Microsoft Graph responded — connection verified.' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }


  private async graph<T>(path: string, token: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithRetry(`${GRAPH}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401) {
      throw Object.assign(new Error('Microsoft Graph rejected the token. Reconnect Outlook.'), { status: 401 });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`Microsoft Graph returned ${res.status}.`), { status: res.status });
    }
    return (await res.json()) as T;
  }


  async createDraft(args: { to: string; subject: string; body: string }): Promise<DraftResult> {
    const payload = buildDraftPayload(args);
    const token = await this.accessToken();
    const res = await this.graph<{ id: string; webLink?: string }>(
      '/me/messages', token,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    audit({
      provider: 'outlook', mode: 'live', action: 'create-draft',
      subject: args.to, outcome: 'ok',
      detail: `Draft saved to Outlook (subject length ${args.subject.length})`,
    });
    return { draftId: res.id, webLink: res.webLink ?? null, demo: false };
  }

  async disconnect() {
    store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'outlook');
    store.save();
    audit({
      provider: 'outlook', mode: 'live', action: 'disconnect',
      subject: 'outlook', outcome: 'ok', detail: 'Tokens removed',
    });
  }
}

// ── Service resolution ───────────────────────────────────────────

/** Test-only override so automated tests can inject an in-memory fixture. */
let serviceOverride: OutlookService | null = null;
export function __setOutlookServiceForTests(svc: OutlookService | null): void {
  serviceOverride = svc;
}

export function outlookService(): OutlookService {
  if (serviceOverride) return serviceOverride;
  return outlookConfigured() ? new LiveOutlook() : new DisconnectedOutlook();
}
