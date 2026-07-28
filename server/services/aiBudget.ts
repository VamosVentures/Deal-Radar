import { getDb } from '../db/client';
import { getConfig, setConfig } from '../db/repos/operations';
import { audit } from '../lib/guard';
import { aiConfigured, env } from '../env';
import {
  AI_SETTINGS_KEY, aiSettingsSchema, costOf, DEFAULT_AI_SETTINGS, EMPTY_USAGE,
  type AiBudgetStatus, type AiRefusalReason, type AiSettings, type AiUsage,
} from '../../shared/ai';

/**
 * AI budget enforcement and the spend ledger.
 *
 * Design rules this module exists to guarantee:
 *
 *  - FAIL CLOSED. No approved credential, or the kill switch off, and
 *    no model call happens. Refusal is the default; permission is the
 *    exception that has to be earned.
 *  - The ledger is the single source of truth for spend. `assertAiAllowed`
 *    reads the same table `recordUsage` writes, so the number enforced
 *    against and the number displayed can never disagree.
 *  - Enforcement survives a stale pricing table. An unknown model is
 *    priced at the expensive UNVERIFIED tier, so drift makes the guard
 *    stricter, never laxer.
 *  - Everything is checked per call, not at boot, so an administrator
 *    flipping the kill switch takes effect on the very next request
 *    with no restart.
 */

export class AiRefusedError extends Error {
  readonly status = 403;
  constructor(readonly reason: AiRefusalReason, message: string, readonly hint?: string) {
    super(message);
    this.name = 'AiRefusedError';
  }
}

// ── Settings ──────────────────────────────────────────────────────

export function getAiSettings(): AiSettings {
  return getConfig(AI_SETTINGS_KEY, aiSettingsSchema, DEFAULT_AI_SETTINGS);
}

export function setAiSettings(patch: Partial<AiSettings>): AiSettings {
  // The refinements run on the MERGED object, so a patch that is
  // individually well-formed but incoherent against existing values
  // (e.g. warnAtUsd above warnAgainAtUsd) is rejected here. Surfaced as
  // a 400 because it is a bad request, not a server fault.
  const candidate = { ...getAiSettings(), ...patch };
  const checked = aiSettingsSchema.safeParse(candidate);
  if (!checked.success) {
    throw Object.assign(
      new Error(checked.error.issues.map((i) => i.message).join('; ')),
      { status: 400, issues: checked.error.issues.map((i) => i.path.join('.')) },
    );
  }
  const merged = checked.data;
  setConfig(AI_SETTINGS_KEY, merged);
  audit({
    provider: 'ai', mode: 'local', action: 'ai-settings-changed',
    subject: 'ai-settings', outcome: 'ok',
    // Values here are policy numbers, not secrets — safe to log.
    detail: `enabled=${merged.enabled} monthly=$${merged.monthlyBudgetUsd} perRun=$${merged.perRunBudgetUsd}`,
  });
  return merged;
}

// ── Ledger ────────────────────────────────────────────────────────

export function currentMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7); // YYYY-MM
}

export interface RecordUsageArgs {
  feature: string;
  provider: string;
  model: string;
  usage: AiUsage;
  companyId?: string | null;
  runId?: string | null;
  ok?: boolean;
  detail?: string | null;
  /** Real billed amount if a provider ever reports one; NULL means "not reported". */
  actualCostUsd?: number | null;
}

export function recordUsage(args: RecordUsageArgs): { estimatedCostUsd: number } {
  const at = new Date();
  const estimated = costOf(args.usage, args.model, at.toISOString().slice(0, 10));
  getDb().prepare(`
    INSERT INTO ai_usage (
      at, month, feature, provider, model, company_id, run_id,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens, web_searches,
      estimated_cost_usd, actual_cost_usd, ok, detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    at.toISOString(), currentMonth(at), args.feature, args.provider, args.model,
    args.companyId ?? null, args.runId ?? null,
    args.usage.inputTokens, args.usage.outputTokens, args.usage.cachedTokens,
    args.usage.cacheWriteTokens, args.usage.webSearches,
    estimated, args.actualCostUsd ?? null, args.ok === false ? 0 : 1,
    args.detail ?? null,
  );
  return { estimatedCostUsd: estimated };
}

/**
 * Spend for a month. Uses the provider-reported amount when one exists
 * and our valuation otherwise — never both for the same row.
 */
export function monthlySpendUsd(month: string = currentMonth()): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total FROM ai_usage WHERE month = ?')
    .get(month) as { total: number };
  return row.total;
}

export function runSpendUsd(runId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total FROM ai_usage WHERE run_id = ?')
    .get(runId) as { total: number };
  return row.total;
}

export function companySpendUsd(companyId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total FROM ai_usage WHERE company_id = ?')
    .get(companyId) as { total: number };
  return row.total;
}

export interface UsageBreakdownRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  webSearches: number;
  costUsd: number;
}

function breakdown(column: 'feature' | 'model' | 'company_id' | 'run_id', month: string): UsageBreakdownRow[] {
  return (getDb().prepare(`
    SELECT COALESCE(${column}, '(none)') AS key,
           COUNT(*) AS calls,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(cached_tokens) AS cached_tokens,
           SUM(web_searches) AS web_searches,
           SUM(COALESCE(actual_cost_usd, estimated_cost_usd)) AS cost_usd
    FROM ai_usage WHERE month = ? GROUP BY 1 ORDER BY cost_usd DESC
  `).all(month) as Record<string, string | number>[]).map((r) => ({
    key: String(r.key),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cachedTokens: Number(r.cached_tokens),
    webSearches: Number(r.web_searches),
    costUsd: Number(r.cost_usd),
  }));
}

export function usageReport(month: string = currentMonth()) {
  const settings = getAiSettings();
  const spend = monthlySpendUsd(month);
  return {
    month,
    status: budgetStatus(month),
    settings,
    byFeature: breakdown('feature', month),
    byModel: breakdown('model', month),
    byCompany: breakdown('company_id', month),
    byRun: breakdown('run_id', month),
    totals: {
      spendUsd: spend,
      remainingUsd: Math.max(0, settings.monthlyBudgetUsd - spend),
    },
  };
}

export function budgetStatus(month: string = currentMonth()): AiBudgetStatus {
  const s = getAiSettings();
  const spend = monthlySpendUsd(month);
  const level: AiBudgetStatus['level'] =
    spend >= s.monthlyBudgetUsd ? 'exhausted'
    : spend >= s.warnAgainAtUsd ? 'warn-again'
    : spend >= s.warnAtUsd ? 'warn'
    : 'ok';
  return {
    enabled: s.enabled,
    credentialPresent: aiConfigured(),
    monthlySpendUsd: spend,
    monthlyBudgetUsd: s.monthlyBudgetUsd,
    remainingUsd: Math.max(0, s.monthlyBudgetUsd - spend),
    level,
    month,
  };
}

// ── The gate ──────────────────────────────────────────────────────

export interface AiAllowanceRequest {
  /** What this call is for — recorded on the ledger row. */
  feature: string;
  /** Worst-case cost of the call about to be made, in USD. */
  estimatedCostUsd: number;
  /** Ties the call to a sourcing run so the per-run cap can apply. */
  runId?: string | null;
}

/**
 * The single choke point every model call must pass through. Throws
 * AiRefusedError — a deliberate policy refusal with a machine-readable
 * reason, not a failure — when a call must not proceed.
 *
 * Checked in escalating order of specificity so the reported reason is
 * the most actionable one.
 */
export function assertAiAllowed(req: AiAllowanceRequest): { settings: AiSettings; status: AiBudgetStatus } {
  const settings = getAiSettings();

  // 1. Fail closed on credentials. This is checked FIRST because
  //    without a key nothing else matters, and because a missing key
  //    must never be reported as a budget problem.
  if (!aiConfigured()) {
    throw new AiRefusedError(
      'no-credential',
      'AI is not configured, so no model call was made.',
      'Set AI_PROVIDER and an API key (AI_API_KEY, or ANTHROPIC_API_KEY / OPENAI_API_KEY) in the backend .env.',
    );
  }

  // 2. Kill switch beats everything else that follows.
  if (!settings.enabled) {
    throw new AiRefusedError(
      'kill-switch',
      'AI is switched off by an administrator.',
      'Re-enable it under Settings → AI budget & guardrails.',
    );
  }

  const status = budgetStatus();

  // 3. Monthly hard cap. Compares projected spend, not just spend so
  //    far — a single expensive call must not be able to cross the
  //    ceiling just because it started underneath it.
  if (status.monthlySpendUsd + req.estimatedCostUsd > settings.monthlyBudgetUsd) {
    throw new AiRefusedError(
      'monthly-budget',
      `Monthly AI budget of $${settings.monthlyBudgetUsd.toFixed(2)} would be exceeded `
      + `(spent $${status.monthlySpendUsd.toFixed(2)}, this request ≈ $${req.estimatedCostUsd.toFixed(4)}).`,
      'Raise the limit under Settings → AI budget & guardrails, or wait for the next calendar month.',
    );
  }

  // 4. Per-run cap, same projected-spend logic.
  if (req.runId) {
    const runSpend = runSpendUsd(req.runId);
    if (runSpend + req.estimatedCostUsd > settings.perRunBudgetUsd) {
      throw new AiRefusedError(
        'run-budget',
        `This run's AI budget of $${settings.perRunBudgetUsd.toFixed(2)} would be exceeded `
        + `(run has spent $${runSpend.toFixed(2)}).`,
        'Narrow the run, or raise the per-run limit under Settings → AI budget & guardrails.',
      );
    }
  }

  return { settings, status };
}

/**
 * Warnings that should be surfaced to a human but must NOT block a
 * call. Separated from assertAiAllowed so that crossing $25 informs
 * without ever changing behaviour.
 */
export function budgetWarning(status: AiBudgetStatus = budgetStatus()): string | null {
  const s = getAiSettings();
  if (status.level === 'exhausted') {
    return `AI monthly budget of $${s.monthlyBudgetUsd.toFixed(2)} is exhausted — new AI requests are being refused.`;
  }
  if (status.level === 'warn-again') {
    return `AI spend has passed $${s.warnAgainAtUsd.toFixed(2)} of the $${s.monthlyBudgetUsd.toFixed(2)} monthly budget.`;
  }
  if (status.level === 'warn') {
    return `AI spend has passed $${s.warnAtUsd.toFixed(2)} of the $${s.monthlyBudgetUsd.toFixed(2)} monthly budget.`;
  }
  return null;
}

/** Which provider/model a call would use — for estimating and for the ledger. */
export function activeModel(): { provider: string; model: string } {
  const provider = env.AI_PROVIDER ?? 'none';
  const model = env.AI_MODEL ?? (provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-5');
  return { provider, model };
}

export { EMPTY_USAGE };
