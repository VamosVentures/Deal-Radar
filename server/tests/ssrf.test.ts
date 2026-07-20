import { afterEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns', () => ({
  default: { promises: { lookup: (...args: unknown[]) => lookupMock(...args) } },
}));

afterEach(() => {
  lookupMock.mockReset();
});

describe('security: DNS-resolution-aware SSRF guard (isSafeExternalUrlResolved)', () => {
  it('rejects a literal-unsafe URL without ever resolving DNS', async () => {
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    const ok = await isSafeExternalUrlResolved('http://127.0.0.1/secret');
    expect(ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    expect(await isSafeExternalUrlResolved('https://a-real-company.example.com')).toBe(true);
  });

  it('rejects a public-looking hostname that resolves to a private/internal address (rebinding)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    expect(await isSafeExternalUrlResolved('https://looks-public.example.com')).toBe(false);
  });

  it('rejects when only ONE of several resolved addresses is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    expect(await isSafeExternalUrlResolved('https://multi-homed.example.com')).toBe(false);
  });

  it('treats a DNS lookup failure as unsafe, not as an open default', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    expect(await isSafeExternalUrlResolved('https://nonexistent.example.com')).toBe(false);
  });

  it('treats a hung DNS lookup as unsafe once the timeout elapses', async () => {
    lookupMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { isSafeExternalUrlResolved } = await import('../lib/http');
    expect(await isSafeExternalUrlResolved('https://slow.example.com', 20)).toBe(false);
  });
});
