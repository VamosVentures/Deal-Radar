# AI Costs and Guardrails

**Pricing source:** <https://platform.claude.com/docs/en/docs/about-claude/pricing>
**Pricing checked on:** 2026-07-27
**Status of AI in this application right now:** **not connected.** No `AI_PROVIDER` and no API key are configured in any environment, so zero model calls have been made and $0.00 has been spent. Everything below describes what *would* happen once a key is added, plus the controls that are already implemented and tested.

---

## 1. Current model prices

Per million tokens (MTok), USD, from the source above.

| Model | Input | Output | 5-min cache write | Cache read | Verified |
|---|---|---|---|---|---|
| Claude Sonnet 5 *(through 2026-08-31)* | $2 | $10 | $2.50 | $0.20 | Yes |
| Claude Sonnet 5 *(from 2026-09-01)* | $3 | $15 | $3.75 | $0.30 | Yes |
| Claude Sonnet 4.6 | $3 | $15 | $3.75 | $0.30 | Yes |
| Claude Haiku 4.5 | $1 | $5 | $1.25 | $0.10 | Yes |
| Claude Opus 5 / Opus 4.8 | $5 | $25 | $6.25 | $0.50 | Yes |

Sonnet 5 carries introductory pricing of $2/$10 through **2026-08-31**, after which standard $3/$15 applies. Both are encoded in `shared/ai.ts`, and `priceFor(model, date)` switches automatically on the changeover date — nobody has to remember to edit the file.

**OpenAI pricing was NOT verified against an official source for this build.** `gpt-4o-mini` is reachable as a provider option, but rather than guess a number, any model not in the verified table above is priced at a deliberately expensive fallback (`$10 in / $50 out per MTok`, flagged `verified: false`). That makes the budget refuse *earlier* than reality would require, which is the safe direction. If OpenAI is ever actually used, verify its current pricing and add it to `MODEL_PRICING`.

The application's default model is `claude-sonnet-5` (`server/services/aiBudget.ts#activeModel`), overridable with `AI_MODEL`.

## 2. Web-search and tool charges

| Item | Charge |
|---|---|
| Web search | **$10 per 1,000 searches** ($0.01 each) |
| Web fetch | No additional charge — you pay only for the fetched tokens |
| Search result content | Billed as ordinary input tokens |

A failed search is not billed. Each search counts once regardless of how many results come back.

## 3. Cost assumptions per researched company

The guardrails cap a single candidate at **3 web searches, 30,000 input tokens, and 2,000 output tokens**. Those caps define the worst case; the realistic case is well under them because most candidates need one or two searches.

Using Sonnet 5 at current introductory pricing:

| Scenario | Searches | Input | Output | Cost |
|---|---|---|---|---|
| **Typical** | 1 | 8,000 | 700 | $0.01 + $0.016 + $0.007 = **≈ $0.033** |
| **Heavier** | 2 | 18,000 | 1,200 | $0.02 + $0.036 + $0.012 = **≈ $0.068** |
| **Worst case (caps hit)** | 3 | 30,000 | 2,000 | $0.03 + $0.060 + $0.020 = **≈ $0.110** |

After the 2026-09-01 price change, the worst case rises to ≈ **$0.150** per company.

## 4–6. Cost per sector, all sectors, and a full 35-company dashboard

The pipeline researches at most **10 candidates per sector** and imports the top **5**. Cost is driven by candidates *researched*, not imported.

| Unit | Typical | Worst case |
|---|---|---|
| One sector (10 researched) | ≈ $0.33 | ≈ $1.10 |
| All 7 sectors (70 researched) | ≈ **$2.31** | ≈ **$7.70** |
| Full 35-company dashboard (7 sectors × 10 researched → 35 imported) | ≈ **$2.31** | ≈ **$7.70** |

The complete dashboard build and "all sectors" are the same operation — 35 imported companies come from 70 researched candidates.

Worst case ($7.70) sits deliberately under the **$10 per-run cap**, so a full rebuild cannot on its own breach a run budget.

## 7. Light, normal, and heavy monthly scenarios

| Scenario | Activity | Monthly cost |
|---|---|---|
| **Light** | One full dashboard rebuild, ~20 refreshes, ~10 outreach drafts | ≈ **$3–4** |
| **Normal** | Weekly rebuild (4×), ~100 refreshes, ~50 drafts | ≈ **$12–16** |
| **Heavy** | Twice-weekly rebuild (8×), ~300 refreshes, ~150 drafts, all caps regularly hit | ≈ **$35–45** |

Even the heavy scenario stays under the $50 cap — but it crosses both warning thresholds, which is the point of setting them at $25 and $40.

## 8. Best case and worst case

- **Best case: $0.00/month.** With no API key configured (the current state) or the kill switch off, no model call is ever made. Every AI feature falls back to a deterministic local template.
- **Worst case: $50.00/month.** This is a hard ceiling, not a target. The 51st dollar cannot be spent: `assertAiAllowed` compares *projected* spend (current spend + the worst-case cost of the call about to be made) against the cap, so a single expensive call cannot straddle the limit.

## 9–11. Budget limits and alert thresholds

| Control | Default | Behaviour |
|---|---|---|
| Monthly hard cap | **$50** | New AI requests refused with reason `monthly-budget` |
| Warning 1 | **$25** | Warning surfaced; **nothing is blocked** |
| Warning 2 | **$40** | Louder warning surfaced; **nothing is blocked** |
| Per-run cap | **$10** | Refused with reason `run-budget`; other runs unaffected |
| Per-sector research cap | **10 candidates** | Deterministic filtering picks which 10 |
| Per-candidate | 3 searches / 30k in / 2k out / 1 retry | Over-cap prompts are refused before sending |
| Concurrency | **2** companies at a time | Bounds burst spend and provider rate-limit pressure |
| Request timeout | **60s** | Hard `AbortController` timeout |

All are editable by an administrator at **Settings → AI budget & guardrails** (`PUT /api/admin/ai/settings`). Thresholds must stay ordered — a patch setting `warnAtUsd` above `warnAgainAtUsd` is rejected with a 400.

## 12. Prompt-caching and batch savings

- **Prompt caching.** A cache read costs **0.1×** the input rate; a 5-minute cache write costs 1.25×. Caching pays for itself after a single read. For Sonnet 5, cached input is $0.20/MTok instead of $2.00 — a **90% saving** on the repeated portion of a prompt. The ledger records `cached_tokens` separately and prices them at the cache-read rate, so the saving is visible rather than assumed.
- **Batch API.** 50% off both input and output for asynchronous work. Sector research is a good fit (nobody is waiting on it). **Not currently implemented** — recorded here as an available saving, not a claimed one.
- **Web fetch over web search.** Fetch has no per-call charge; search costs $0.01. Prefer fetch when the URL is already known.

## 13. How actual usage is recorded

Every model call writes one immutable row to the `ai_usage` table (migration v6), **whether it succeeds or fails**:

`at`, `month`, `feature`, `provider`, `model`, `company_id`, `run_id`, `input_tokens`, `output_tokens`, `cached_tokens`, `cache_write_tokens`, `web_searches`, `estimated_cost_usd`, `actual_cost_usd`, `ok`, `detail`

- Token counts come from the **provider's own `usage` object** on the response, not from an estimate. Anthropic's `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `server_tool_use.web_search_requests` are all captured.
- `estimated_cost_usd` is our valuation of those reported tokens. `actual_cost_usd` stays `NULL` unless a provider reports a real billed amount — **`NULL` means "not reported", never "free"**.
- Spend queries prefer `actual_cost_usd` and fall back to `estimated_cost_usd`, never double-counting.
- The same table backs both enforcement and display, so the number the guard blocks on and the number the UI shows cannot disagree.

Read it at **Settings → AI budget & guardrails**, or `GET /api/admin/ai/usage?month=YYYY-MM`, broken down by feature, model, company, and run.

## 14. How an administrator disables AI

Three options, fastest first:

1. **Kill switch (instant, no restart).** Settings → AI budget & guardrails → toggle off. Or `POST /api/admin/ai/kill-switch {"enabled": false}`. Checked on every call, so it takes effect on the very next request.
2. **Set the monthly budget to a spent amount.** Refuses new calls while leaving the switch on.
3. **Remove the credential.** Delete `AI_PROVIDER` / `AI_API_KEY` from `.env` and restart. This is the fail-closed state the app ships in.

All three are administrator-only and pass through the whole-application auth gate.

## 15. What still works when AI is disabled

Nearly everything. AI is an enrichment layer, not the product.

**Fully working without AI:**

- All live sourcing — SEC Form D, Y Combinator, SBIR/STTR, GitHub, arXiv, funding-news RSS. These are plain HTTP calls to public APIs and cost nothing.
- The **Vamos Fit Score** in its entirety. It is a deterministic 100-point weighted model in `src/lib/scoring.ts` — not an AI call. Every point carries a written rationale.
- Deduplication, identity matching, and possible-duplicate review.
- The whole review queue: filters, sorting, bulk status changes, company detail, provenance chips.
- Per-company live research refresh (re-queries public sources; no model involved).
- HubSpot sync, Outlook draft creation, CSV import/export, backups, source analytics, scheduling.

**Degraded but honest without AI:**

- **Outreach drafts** fall back to a deterministic local template built only from verified facts, labeled "Local template — no AI model" in the UI.
- **Fit explanation** and **portfolio comparison** return deterministic local summaries, labeled as such.

Nothing is silently simulated. If AI is off, the UI says so.

## 16. Claude Code subscription vs. application API usage

These are **two entirely separate billing relationships** and are easy to confuse:

| | Claude Code (development) | This application (runtime) |
|---|---|---|
| What it is | The assistant used to *write* this codebase | Model calls the deployed app makes on its own |
| Billed to | A Claude subscription (Pro/Max/Team seat) | Anthropic API credits on an API key |
| Credential | Your Claude login | `ANTHROPIC_API_KEY` / `AI_API_KEY` in the backend `.env` |
| Counts toward the $50 cap? | **No** | **Yes** — every call, tracked in `ai_usage` |
| Spend today | Whatever the subscription costs | **$0.00 — no key configured** |

Writing this application with Claude Code costs nothing against the application's budget, and the application's budget has no effect on Claude Code. Every figure in this document refers **only** to the second column.

---

## Guardrail implementation map

| Requirement | Where |
|---|---|
| Fail closed with no credential | `aiBudget.ts#assertAiAllowed` (checked first, so a missing key is never misreported as a budget problem) |
| Kill switch | `aiBudget.ts#getAiSettings().enabled`, `POST /api/admin/ai/kill-switch` |
| $50 cap / $25 / $40 / $10 per run | `aiBudget.ts#assertAiAllowed`, projected-spend comparison |
| Token + search + cost tracking | migration v6 `ai_usage`, `aiBudget.ts#recordUsage` |
| Per-candidate + concurrency + sector caps | `shared/ai.ts#aiSettingsSchema`, enforced in `aiClient.ts` |
| Timeout + exponential backoff | `aiClient.ts#callBudgetedModel` |
| Untrusted-content sanitization | `aiGuard.ts#sanitizeUntrustedContent` |
| Prompt-injection flagging + fencing | `aiGuard.ts#fenceUntrusted` with a per-call nonce |
| Never send secrets | `aiGuard.ts#assertNoSecrets` (throws rather than redacting) |
| Structured output validation | `aiGuard.ts#parseModelJson` + existing Zod schemas |
| Never overwrite verified data | existing `applyFieldUpdate` provenance precedence |
| No automatic AI actions | No AI code path can send mail, write to HubSpot, approve, pass, or delete |
| Admin-only AI endpoints | `server/routes/admin.ts` behind `requireAdmin` + the app-wide gate |
| Automated tests | `server/tests/ai-guardrails.test.ts` — 44 tests |

## Honest limitations

- **No real model call has ever been made from this codebase.** The guardrails are tested against simulated ledger state and stubbed conditions. The fail-closed path is tested for real (it is the current state); the *spending* paths are not, because spending requires a key.
- OpenAI pricing is unverified (see §1).
- Batch processing is documented as an available saving but is not implemented.
- Actual provider-reported *cost* (as opposed to tokens) is not returned by the Messages API, so `actual_cost_usd` will be `NULL` in practice and spend will be our valuation of real reported token counts.
