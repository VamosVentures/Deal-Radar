import { aiKey, env } from '../env';
import { audit } from '../lib/guard';
import { aiUsageSchema, costOf, type AiUsage } from '../../shared/ai';
import {
  activeModel, assertAiAllowed, getAiSettings, recordUsage,
} from './aiBudget';
import { assertNoSecrets } from './aiGuard';

/**
 * THE single choke point for every model call in this application.
 *
 * Nothing else may call an AI provider directly. Routing all traffic
 * through one function is what makes the guarantees in
 * AI_COSTS_AND_GUARDRAILS.md actually true rather than aspirational:
 * a control implemented at three call sites is a control that will be
 * missing at the fourth.
 *
 * Enforced here, in order:
 *   1. Secret scan on the outgoing prompt   (throws — indicates a bug)
 *   2. Budget/kill-switch/credential gate   (throws AiRefusedError)
 *   3. Hard request timeout
 *   4. Bounded retry with exponential backoff + jitter
 *   5. Provider-reported usage captured and written to the ledger,
 *      on failure as well as success
 */

export interface BudgetedCallArgs {
  prompt: string;
  /** Recorded on the ledger row — e.g. 'outreach-email', 'fit-analysis'. */
  feature: string;
  maxOutputTokens: number;
  companyId?: string | null;
  runId?: string | null;
  /** Overrides the settings default; still clamped by it. */
  maxInputTokens?: number;
  system?: string;
}

export interface BudgetedCallResult {
  text: string;
  usage: AiUsage;
  estimatedCostUsd: number;
  model: string;
  provider: string;
}

/** Rough pre-call token estimate. ~4 characters per token is the documented approximation. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callBudgetedModel(args: BudgetedCallArgs): Promise<BudgetedCallResult> {
  const settings = getAiSettings();
  const { provider, model } = activeModel();

  // 1. Nothing credential-shaped may leave this process inside a prompt.
  assertNoSecrets(args.prompt, args.feature);
  if (args.system) assertNoSecrets(args.system, `${args.feature}:system`);

  // Clamp to the configured per-candidate ceilings.
  const maxOutput = Math.min(args.maxOutputTokens, settings.maxOutputTokensPerCandidate);
  const inputCap = Math.min(args.maxInputTokens ?? settings.maxInputTokensPerCandidate, settings.maxInputTokensPerCandidate);
  const estIn = estimateTokens(args.prompt) + estimateTokens(args.system ?? '');
  if (estIn > inputCap) {
    throw Object.assign(
      new Error(`Prompt is ~${estIn} tokens, over the ${inputCap}-token per-request input cap. It was not sent.`),
      { status: 413 },
    );
  }

  // 2. Budget gate, priced on the WORST case (full input + full output).
  const worstCase = costOf(
    aiUsageSchema.parse({ inputTokens: estIn, outputTokens: maxOutput }),
    model,
  );
  assertAiAllowed({ feature: args.feature, estimatedCostUsd: worstCase, runId: args.runId ?? null });

  const attempts = settings.maxRetriesPerRequest + 1;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 3. Hard timeout, independent of any provider-side behaviour.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    try {
      const { text, usage } = provider === 'anthropic'
        ? await callAnthropic(args, model, maxOutput, controller.signal)
        : await callOpenAi(args, model, maxOutput, controller.signal);

      const { estimatedCostUsd } = recordUsage({
        feature: args.feature, provider, model, usage,
        companyId: args.companyId ?? null, runId: args.runId ?? null,
        ok: true, detail: attempt > 1 ? `succeeded on attempt ${attempt}` : null,
      });
      return { text, usage, estimatedCostUsd, model, provider };
    } catch (e) {
      lastErr = e as Error;
      const isLast = attempt === attempts;
      if (isLast) {
        // A failed call can still have cost money (the provider may have
        // processed input before failing), and even when it did not, the
        // attempt itself is worth seeing in the ledger.
        recordUsage({
          feature: args.feature, provider, model,
          usage: aiUsageSchema.parse({}),
          companyId: args.companyId ?? null, runId: args.runId ?? null,
          ok: false, detail: truncateForLog(lastErr.message),
        });
        audit({
          provider: 'ai', mode: 'live', action: `${args.feature}-failed`,
          subject: args.companyId ?? args.feature, outcome: 'error',
          detail: truncateForLog(lastErr.message),
        });
        break;
      }
      // 4. Exponential backoff with jitter: 500ms, 1000ms, 2000ms…
      const backoff = 500 * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }

  throw Object.assign(
    new Error(`The AI provider request failed after ${attempts} attempt(s): ${lastErr?.message ?? 'unknown error'}`),
    { status: 502 },
  );
}

/** Keep provider error text out of logs beyond what is diagnostically useful. */
function truncateForLog(msg: string): string {
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

async function callAnthropic(
  args: BudgetedCallArgs, model: string, maxOutput: number, signal: AbortSignal,
): Promise<{ text: string; usage: AiUsage }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': aiKey()!,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutput,
      ...(args.system ? { system: args.system } : {}),
      messages: [{ role: 'user', content: args.prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic returned ${res.status}. Check AI_API_KEY and AI_MODEL.`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number; output_tokens?: number;
      cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
      server_tool_use?: { web_search_requests?: number };
    };
  };

  // A truncated answer is not a valid answer — surfacing it as an error
  // is better than handing downstream code half a JSON object.
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`The model hit the ${maxOutput}-token output cap before finishing.`);
  }

  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const u = data.usage ?? {};
  return {
    text,
    usage: aiUsageSchema.parse({
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cachedTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      webSearches: u.server_tool_use?.web_search_requests ?? 0,
    }),
  };
}

async function callOpenAi(
  args: BudgetedCallArgs, model: string, maxOutput: number, signal: AbortSignal,
): Promise<{ text: string; usage: AiUsage }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${aiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutput,
      messages: [
        ...(args.system ? [{ role: 'system', content: args.system }] : []),
        { role: 'user', content: args.prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI returned ${res.status}. Check AI_API_KEY and AI_MODEL.`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };
  if (data.choices[0]?.finish_reason === 'length') {
    throw new Error(`The model hit the ${maxOutput}-token output cap before finishing.`);
  }
  const u = data.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: data.choices[0]?.message?.content ?? '',
    usage: aiUsageSchema.parse({
      // OpenAI reports cached tokens INSIDE prompt_tokens; separate them
      // so the two are not billed twice in our valuation.
      inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      outputTokens: u.completion_tokens ?? 0,
      cachedTokens: cached,
      webSearches: 0,
    }),
  };
}

export { env };
