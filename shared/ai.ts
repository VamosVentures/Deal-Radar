import { z } from 'zod';

/**
 * AI cost, budget, and guardrail contracts shared by both tiers.
 *
 * Two separate concerns live here and must not be conflated:
 *
 *  1. PRICING is a published fact about a provider. It is used to
 *     ESTIMATE spend before a call and to VALUE the provider-reported
 *     token counts after one. It can go stale.
 *  2. BUDGET ENFORCEMENT is our own policy. It must keep working even
 *     if the pricing table is stale or a model is unknown — an unknown
 *     model is priced with a deliberately HIGH fallback so the budget
 *     errs toward refusing, never toward overspending.
 */

// ── Pricing ───────────────────────────────────────────────────────
// Source: https://platform.claude.com/docs/en/docs/about-claude/pricing
// Checked: 2026-07-27. USD per million tokens.
export const PRICING_SOURCE_URL =
  'https://platform.claude.com/docs/en/docs/about-claude/pricing';
export const PRICING_CHECKED_ON = '2026-07-27';

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million tokens read from the prompt cache (0.1x input). */
  cacheRead: number;
  /** USD per million tokens written to a 5-minute cache (1.25x input). */
  cacheWrite5m: number;
  verified: boolean;
}

/**
 * Claude Sonnet 5 carries introductory pricing of $2/$10 per MTok
 * through 2026-08-31, after which the standard $3/$15 takes effect.
 * Both are encoded so an estimate made after the changeover is right
 * without anyone remembering to edit this file.
 */
export const SONNET_5_INTRO_PRICING_ENDS = '2026-08-31';

const SONNET_5_INTRO: ModelPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, verified: true };
const SONNET_5_STANDARD: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, verified: true };

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'claude-sonnet-5': SONNET_5_INTRO, // date-adjusted by priceFor()
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, verified: true },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, verified: true },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, verified: true },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, verified: true },
};

/**
 * Deliberately expensive stand-in for any model we have not verified a
 * price for — including every OpenAI model, whose pricing was NOT
 * checked against an official source for this build. Costing an
 * unknown model at the most expensive verified tier means the budget
 * refuses early rather than discovering an overrun after the fact.
 * `verified: false` is surfaced in the UI and in AI_COSTS_AND_GUARDRAILS.md
 * so nobody mistakes it for a real quoted price.
 */
export const UNVERIFIED_MODEL_PRICING: ModelPrice = {
  input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, verified: false,
};

/** USD per web search. Official: $10 per 1,000 searches. */
export const WEB_SEARCH_COST_USD = 0.01;

export function priceFor(model: string, onDate: string = new Date().toISOString().slice(0, 10)): ModelPrice {
  if (model === 'claude-sonnet-5') {
    return onDate <= SONNET_5_INTRO_PRICING_ENDS ? SONNET_5_INTRO : SONNET_5_STANDARD;
  }
  return MODEL_PRICING[model] ?? UNVERIFIED_MODEL_PRICING;
}

// ── Token usage ───────────────────────────────────────────────────

export const aiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  /** Tokens served from the prompt cache — billed at 0.1x input. */
  cachedTokens: z.number().int().nonnegative().default(0),
  /** Tokens written INTO the prompt cache — billed at 1.25x input. */
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  webSearches: z.number().int().nonnegative().default(0),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export const EMPTY_USAGE: AiUsage = aiUsageSchema.parse({});

/** Value a usage record in USD using the pricing table above. */
export function costOf(usage: AiUsage, model: string, onDate?: string): number {
  const p = priceFor(model, onDate);
  const perM = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    perM(usage.inputTokens, p.input)
    + perM(usage.outputTokens, p.output)
    + perM(usage.cachedTokens, p.cacheRead)
    + perM(usage.cacheWriteTokens, p.cacheWrite5m)
    + usage.webSearches * WEB_SEARCH_COST_USD
  );
}

// ── Budget + guardrail settings ───────────────────────────────────

export const AI_SETTINGS_KEY = 'ai-settings';

/**
 * The plain object shape, WITHOUT the cross-field refinements.
 *
 * Zod refuses `.partial()` on a refined schema at runtime (a refinement
 * can't be checked against a half-supplied object), so PATCH handlers
 * validate field shapes against this base and the merged result is then
 * validated against the refined `aiSettingsSchema` below. That ordering
 * is what makes a patch like `{ warnAtUsd: 45 }` fail cleanly instead of
 * throwing inside the service.
 */
export const aiSettingsBaseSchema = z.object({
  /**
   * Global kill switch. When false, NO model call is made by any
   * feature, regardless of credentials. Flipping this is instant and
   * needs no restart — it is checked on every call.
   */
  enabled: z.boolean().default(true),

  /** Hard monthly ceiling in USD. At or above this, new requests are refused. */
  monthlyBudgetUsd: z.number().positive().max(10_000).default(50),
  /** First warning threshold in USD. */
  warnAtUsd: z.number().positive().max(10_000).default(25),
  /** Second, louder warning threshold in USD. */
  warnAgainAtUsd: z.number().positive().max(10_000).default(40),
  /** Ceiling for a single complete sourcing run, in USD. */
  perRunBudgetUsd: z.number().positive().max(1_000).default(10),

  /** Most candidates that may be AI-researched in one sector. */
  maxResearchedCandidatesPerSector: z.number().int().min(1).max(100).default(10),
  /** Per-candidate caps. */
  maxWebSearchesPerCandidate: z.number().int().min(0).max(20).default(3),
  maxInputTokensPerCandidate: z.number().int().min(1_000).max(500_000).default(30_000),
  maxOutputTokensPerCandidate: z.number().int().min(256).max(32_000).default(2_000),
  /** Retries after a failed provider request (1 = one retry, two attempts total). */
  maxRetriesPerRequest: z.number().int().min(0).max(3).default(1),
  /** How many candidates may be researched at the same time. */
  maxConcurrentResearch: z.number().int().min(1).max(10).default(2),
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});

export const aiSettingsSchema = aiSettingsBaseSchema
  .refine((s) => s.warnAtUsd < s.warnAgainAtUsd, {
    message: 'warnAtUsd must be below warnAgainAtUsd',
    path: ['warnAtUsd'],
  })
  .refine((s) => s.warnAgainAtUsd < s.monthlyBudgetUsd, {
    message: 'warnAgainAtUsd must be below monthlyBudgetUsd',
    path: ['warnAgainAtUsd'],
  })
  .refine((s) => s.perRunBudgetUsd <= s.monthlyBudgetUsd, {
    message: 'perRunBudgetUsd cannot exceed monthlyBudgetUsd',
    path: ['perRunBudgetUsd'],
  });

export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const DEFAULT_AI_SETTINGS: AiSettings = aiSettingsSchema.parse({});

/** Why an AI request was refused. Every value is a policy decision, not an error. */
export const AI_REFUSAL_REASONS = [
  'no-credential',        // fail closed: no approved provider key configured
  'kill-switch',          // an administrator disabled AI
  'monthly-budget',       // monthly hard cap reached
  'run-budget',           // this sourcing run's cap reached
  'candidate-cap',        // per-candidate token/search cap reached
  'sector-cap',           // already researched the max candidates for this sector
] as const;
export type AiRefusalReason = (typeof AI_REFUSAL_REASONS)[number];

export interface AiBudgetStatus {
  enabled: boolean;
  credentialPresent: boolean;
  monthlySpendUsd: number;
  monthlyBudgetUsd: number;
  remainingUsd: number;
  /** null | 'warn' | 'warn-again' | 'exhausted' */
  level: 'ok' | 'warn' | 'warn-again' | 'exhausted';
  month: string;
}
