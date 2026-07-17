import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { buildDraftPayload, outlookService } from '../services/outlook';

beforeEach(() => store.resetForTests());

describe('Outlook draft payload', () => {
  it('builds a Graph draft payload with isDraft and the recipient', () => {
    const p = buildDraftPayload({
      to: 'mariana@solcarehealth.example.com',
      subject: 'Quick intro from VamosVentures',
      body: 'Hi Mariana — …',
    });
    expect(p.isDraft).toBe(true);
    expect(p.toRecipients[0].emailAddress.address).toBe('mariana@solcarehealth.example.com');
    expect(p.subject).toContain('VamosVentures');
    expect(p.body.contentType).toBe('Text');
  });

  it('rejects a missing recipient', () => {
    expect(() => buildDraftPayload({ to: '', subject: 'x', body: 'y' }))
      .toThrow(/recipient email/i);
  });

  it('rejects an invalid recipient address', () => {
    expect(() => buildDraftPayload({ to: 'not-an-email', subject: 'x', body: 'y' }))
      .toThrow(/recipient email/i);
  });

  it('rejects an empty subject', () => {
    expect(() => buildDraftPayload({ to: 'a@b.co', subject: '   ', body: 'y' }))
      .toThrow(/subject/i);
  });
});

describe('mock Outlook', () => {
  it('requires a connection before creating a draft (failed auth)', async () => {
    const svc = outlookService();
    await expect(
      svc.createDraft({ to: 'a@b.co', subject: 'Hello', body: 'Body text' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('simulates connect + draft and labels it Demo Mode', async () => {
    const svc = outlookService();
    const conn = await svc.beginConnect();
    expect(conn.demo).toBe(true);
    expect(conn.message).toContain('Demo Mode');
    expect(conn.message.toLowerCase()).toContain('no real');
    const draft = await svc.createDraft({ to: 'a@b.co', subject: 'Hello', body: 'Body text' });
    expect(draft.demo).toBe(true);
    expect(draft.webLink).toBeNull(); // no fake Outlook links
    const status = await svc.status();
    expect(status.connected).toBe(true);
    expect(status.account).toContain('demo');
  });

  it('disconnect removes the simulated connection', async () => {
    const svc = outlookService();
    await svc.beginConnect();
    await svc.disconnect();
    expect((await svc.status()).connected).toBe(false);
  });
});

describe('live Outlook token handling (no network — fails before any request)', () => {
  async function liveOutlook() {
    vi.resetModules();
    process.env.INTEGRATION_MODE = 'auto';
    process.env.MICROSOFT_CLIENT_ID = 'test-client';
    process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
    process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:8787/api/outlook/callback';
    process.env.SESSION_SECRET = 'a-test-session-secret-long-enough';
    const mod = await import('../services/outlook');
    const storeMod = await import('../lib/store');
    return { svc: mod.outlookService(), store: storeMod.store, crypto: await import('../lib/crypto') };
  }

  it('an expired token with no refresh token yields a reconnect error, not a crash', async () => {
    const { svc, store, crypto } = await liveOutlook();
    store.resetForTests();
    expect(svc.mode).toBe('live');
    store.raw.tokens.push({
      provider: 'outlook',
      account: 'user@vamosventures.com',
      scopes: [],
      cipher: crypto.encrypt('expired-token'),
      refreshCipher: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // already expired
      connectedAt: new Date().toISOString(),
    });
    await expect(
      svc.createDraft({ to: 'a@b.co', subject: 'Hello', body: 'Body' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      svc.createDraft({ to: 'a@b.co', subject: 'Hello', body: 'Body' }),
    ).rejects.toThrow(/reconnect/i);
    // restore mock env for other suites
    process.env.INTEGRATION_MODE = 'mock';
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_REDIRECT_URI;
    vi.resetModules();
  });

  it('rejects an OAuth callback with an unknown state', async () => {
    vi.resetModules();
    process.env.INTEGRATION_MODE = 'auto';
    process.env.MICROSOFT_CLIENT_ID = 'test-client';
    process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
    process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:8787/api/outlook/callback';
    process.env.SESSION_SECRET = 'a-test-session-secret-long-enough';
    const mod = await import('../services/outlook');
    const storeMod = await import('../lib/store');
    storeMod.store.resetForTests();
    await expect(mod.outlookService().handleCallback('code', 'forged-state'))
      .rejects.toThrow(/state is invalid or expired/i);
    process.env.INTEGRATION_MODE = 'mock';
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_REDIRECT_URI;
    vi.resetModules();
  });
});
