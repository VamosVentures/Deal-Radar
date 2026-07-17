import { z } from 'zod';
import crypto from 'node:crypto';

/**
 * Environment validation. The app must boot with ZERO credentials —
 * every integration falls back to Mock Mode independently. Setting
 * INTEGRATION_MODE=mock forces Demo Mode even when secrets exist.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  APP_BASE_URL: z.string().default('http://localhost:8787'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_PORTAL_ID: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_REDIRECT_URI: z.string().optional(),

  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_REDIRECT_URI: z.string().optional(),

  AI_PROVIDER: z.enum(['anthropic', 'openai']).optional(),
  AI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),

  RUN_SCHEDULER: z.enum(['true', 'false']).default('false'),
  INTEGRATION_MODE: z.enum(['mock', 'auto']).default('mock'),
  SESSION_SECRET: z.string().min(16).optional(),
  DATA_FILE: z.string().optional(), // ':memory:' in tests
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail loudly on malformed values; never print the values themselves.
  const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration for: ${fields}`);
}

export const env = parsed.data;

export type ProviderMode = 'mock' | 'live';

function forceMock(): boolean {
  return env.INTEGRATION_MODE === 'mock';
}

/** Resolve the AI key: AI_API_KEY wins, else the provider-specific var. */
export function aiKey(): string | undefined {
  if (env.AI_API_KEY) return env.AI_API_KEY;
  if (env.AI_PROVIDER === 'openai') return env.OPENAI_API_KEY;
  if (env.AI_PROVIDER === 'anthropic') return env.ANTHROPIC_API_KEY;
  return undefined;
}

/** True when HubSpot OAuth is configured (connection still needs the user flow). */
export function hubspotOAuthConfigured(): boolean {
  return !!(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET && env.HUBSPOT_REDIRECT_URI);
}

export function integrationModeForcedMock(): boolean {
  return forceMock();
}

export function schedulerEnabled(): boolean {
  return env.RUN_SCHEDULER === 'true';
}

export const modes = {
  /**
   * HubSpot is live with a private-app token; an OAuth connection can
   * also enable live mode — that check needs the token store, so the
   * HubSpot service exposes hubspotMode() which layers it on top.
   */
  hubspot: (): ProviderMode =>
    !forceMock() && env.HUBSPOT_ACCESS_TOKEN ? 'live' : 'mock',
  outlook: (): ProviderMode =>
    !forceMock() &&
    env.MICROSOFT_CLIENT_ID &&
    env.MICROSOFT_CLIENT_SECRET &&
    env.MICROSOFT_REDIRECT_URI &&
    env.SESSION_SECRET
      ? 'live'
      : 'mock',
  ai: (): ProviderMode =>
    !forceMock() && env.AI_PROVIDER && aiKey() ? 'live' : 'mock',
};

/**
 * Encryption key for tokens at rest. Live Outlook requires a real
 * SESSION_SECRET; in Demo Mode an ephemeral key is fine because no
 * real tokens ever exist.
 */
export const encryptionKey: Buffer = env.SESSION_SECRET
  ? crypto.scryptSync(env.SESSION_SECRET, 'vamos-deal-radar', 32)
  : crypto.randomBytes(32);
