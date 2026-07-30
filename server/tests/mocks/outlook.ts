import { store, type TokenRecord } from '../../lib/store';
import { audit } from '../../lib/guard';
import { encrypt } from '../../lib/crypto';
import {
  buildDraftPayload,
  OUTLOOK_SCOPES,
  type DraftResult,
  type OutlookService,
  type OutlookStatus,
} from '../../services/outlook';

/** The real scope list, not a copy — a fixture that drifted would hide a scope change. */
const SCOPES = [...OUTLOOK_SCOPES];

/**
 * TEST FIXTURE ONLY. An in-memory Outlook used by the automated tests
 * to exercise the drafts-only workflow without a real mailbox. Never
 * used by the running application.
 */
export class MockOutlook implements OutlookService {
  mode = 'mock' as const;

  private token(): TokenRecord | undefined {
    return store.raw.tokens.find((t) => t.provider === 'outlook');
  }

  async status(): Promise<OutlookStatus> {
    const t = this.token();
    return {
      mode: 'mock',
      connected: !!t,
      account: t?.account ?? null,
      permissions: t ? SCOPES : [],
      lastConnectedAt: t?.connectedAt ?? null,
      detail: t
        ? 'Test fixture: in-memory mailbox. No real Microsoft account is connected.'
        : 'Test fixture: not connected.',
    };
  }

  async beginConnect() {
    const now = new Date().toISOString();
    const existing = this.token();
    if (!existing) {
      store.raw.tokens.push({
        provider: 'outlook',
        account: 'test-fixture@vamosventures.example',
        scopes: SCOPES,
        cipher: encrypt('test-token-not-real'),
        refreshCipher: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        connectedAt: now,
      });
      store.save();
    }
    audit({
      provider: 'outlook', mode: 'local', action: 'connect',
      subject: 'test-fixture@vamosventures.example', outcome: 'ok',
      detail: 'Test fixture: simulated Outlook connection',
    });
    return {
      authUrl: null,
      message: 'Test fixture: simulated an Outlook connection. No real Microsoft sign-in occurred.',
    };
  }

  async handleCallback(): Promise<{ account: string }> {
    throw Object.assign(new Error('OAuth callbacks are not used by the test fixture.'), { status: 400 });
  }

  async verifyConnection() {
    const t = this.token();
    return {
      ok: !!t,
      detail: t
        ? 'Test fixture: in-memory mailbox responded. No real Microsoft connection was verified.'
        : 'Test fixture: not connected.',
    };
  }


  async createDraft(args: { to: string; subject: string; body: string }): Promise<DraftResult> {
    buildDraftPayload(args); // same validation as live
    if (!this.token()) {
      throw Object.assign(new Error('Connect Outlook first.'), { status: 401 });
    }
    const id = store.nextId('mock-draft');
    audit({
      provider: 'outlook', mode: 'local', action: 'create-draft',
      subject: args.to, outcome: 'ok',
      detail: `Test fixture: simulated Outlook draft "${args.subject.slice(0, 60)}"`,
    });
    return { draftId: id, webLink: null, demo: true };
  }

  async disconnect() {
    store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'outlook');
    store.save();
  }
}
