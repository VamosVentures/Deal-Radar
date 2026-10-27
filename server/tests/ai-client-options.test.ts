import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';

/**
 * The two per-call options email extraction added to the model gateway:
 * `outputScalesWithInput` (lifts the per-candidate output clamp) and
 * `effort` (sent only to models that accept it). fetch is stubbed — no
 * request leaves the process; the test inspects the body that would be sent.
 */
const fakeEnv = { AI_PROVIDER: 'anthropic' as const, AI_MODEL: 'claude-sonnet-5-5' as string };
vi.mock('../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, { get: (t, k) => (k in fakeEnv ? fakeEnv[k as keyof typeof fakeEnv] : t[k as keyof typeof t]) }),
    aiConfigured: () => true,
    aiKey: () => 'test-key-not-real',
  };
});

const { callBudgetedModel } = await import('../services/aiClient');

let sentBody: Record<string, unknown> | null = null;

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
  sentBody = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fakeEnv.AI_MODEL = 'claude-sonnet-5-5';
});

describe('callBudgetedModel per-call options', () => {
  it('clamps output to the per-candidate cap by default', async () => {
    await callBudgetedModel({ prompt: 'hi', feature: 'test', maxOutputTokens: 12_000 });
    expect(sentBody?.max_tokens).toBe(2_000);
  });

  it('lets outputScalesWithInput use the requested output size', async () => {
    await callBudgetedModel({ prompt: 'hi', feature: 'test', maxOutputTokens: 12_000, outputScalesWithInput: true });
    expect(sentBody?.max_tokens).toBe(12_000);
  });

  it('sends effort to a model that supports it', async () => {
    await callBudgetedModel({ prompt: 'hi', feature: 'test', maxOutputTokens: 100, effort: 'low' });
    expect(sentBody?.output_config).toEqual({ effort: 'low' });
  });

  it('omits effort for an older model that would reject it', async () => {
    fakeEnv.AI_MODEL = 'claude-haiku-4-5';
    await callBudgetedModel({ prompt: 'hi', feature: 'test', maxOutputTokens: 100, effort: 'low' });
    expect(sentBody?.output_config).toBeUndefined();
  });

  it('sends no effort at all unless the caller asks for one', async () => {
    await callBudgetedModel({ prompt: 'hi', feature: 'test', maxOutputTokens: 100 });
    expect(sentBody?.output_config).toBeUndefined();
  });
});
