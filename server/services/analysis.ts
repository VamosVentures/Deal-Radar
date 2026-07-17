import crypto from 'node:crypto';
import { aiKey, env, modes } from '../env';
import { store } from '../lib/store';
import { audit } from '../lib/guard';
import { fetchWithRetry } from '../lib/http';
import {
  fitExplainContextSchema,
  fitExplanationSchema,
  portfolioComparisonSchema,
  portfolioCompanySchema,
  type FitExplainContext,
  type FitExplanation,
  type PortfolioCompany,
  type PortfolioComparison,
} from '../../shared/integrations';
import { z } from 'zod';

/**
 * AI analysis endpoints (fit explanations, portfolio comparisons).
 * Structured JSON only, Zod-validated; live results are cached for
 * 24h to respect token limits; without an AI key a deterministic
 * local template answers from the scoring data alone.
 */

const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKENS = 900;

function cacheKey(kind: string, payload: unknown): string {
  return crypto.createHash('sha256').update(kind + JSON.stringify(payload)).digest('hex');
}

function fromCache<T>(key: string): T | null {
  const hit = store.raw.aiCache[key];
  if (!hit) return null;
  if (Date.now() - new Date(hit.at).getTime() > CACHE_TTL_MS) {
    delete store.raw.aiCache[key];
    return null;
  }
  return hit.value as T;
}

function toCache(key: string, value: unknown) {
  store.raw.aiCache[key] = { at: new Date().toISOString(), value };
  // Bound the cache so the dev store can't grow without limit.
  const keys = Object.keys(store.raw.aiCache);
  if (keys.length > 200) delete store.raw.aiCache[keys[0]];
  store.save();
}

async function callModelJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  let text: string;
  if (env.AI_PROVIDER === 'anthropic') {
    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': aiKey()!,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.AI_MODEL ?? 'claude-sonnet-4-6',
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw Object.assign(new Error('The AI provider rejected the request. Check the API key and model.'), { status: 502 });
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    text = data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  } else {
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.AI_MODEL ?? 'gpt-4o-mini',
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw Object.assign(new Error('The AI provider rejected the request. Check the API key and model.'), { status: 502 });
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    text = data.choices[0]?.message?.content ?? '';
  }
  const clean = text.replace(/```json|```/g, '').trim();
  return schema.parse(JSON.parse(clean));
}

// ── Fit explanation ──────────────────────────────────────────────

function localFitExplanation(c: FitExplainContext): FitExplanation {
  const sorted = [...c.components].sort((a, b) => b.points / b.max - a.points / a.max);
  const strengths = sorted
    .filter((x) => x.points / x.max >= 0.7)
    .map((x) => `${x.label} (${x.points}/${x.max}): ${x.rationale}`);
  const concerns = [
    ...sorted.filter((x) => x.points / x.max < 0.5).map((x) => `${x.label} (${x.points}/${x.max}): ${x.rationale}`),
    ...c.exceptions.map((e) => `Policy exception: ${e}`),
  ];
  return fitExplanationSchema.parse({
    summary: `${c.companyName} scores ${c.score.toFixed(1)}/10 on the Vamos Fit model as a ${c.stage} company in ${c.vertical} → ${c.subcategory}. The score is a weighted sum of the audited components below — nothing here is inferred beyond the recorded evidence.`,
    strengths: strengths.length > 0 ? strengths : [`Highest-weighted component: ${sorted[0].label} (${sorted[0].points}/${sorted[0].max}).`],
    concerns,
    suggestedNextStep:
      c.exceptions.length > 0 ? 'Route to partner review — a policy exception needs sign-off before anything else.' :
      c.score >= 8 ? 'Prioritize: assign an owner and approve outreach.' :
      c.score >= 6.5 ? 'Track actively and fill the weakest evidence gaps before outreach.' :
      'Monitor; revisit when traction or evidence improves.',
    demo: true,
    cached: false,
  });
}

export async function explainFit(raw: unknown): Promise<FitExplanation> {
  const c = fitExplainContextSchema.parse(raw);
  const key = cacheKey('fit', c);
  const cached = fromCache<FitExplanation>(key);
  if (cached) return { ...cached, cached: true };

  if (modes.ai() !== 'live') {
    const local = localFitExplanation(c);
    toCache(key, local);
    return local;
  }
  const prompt = [
    'Explain a venture fit score for an investment team. Respond ONLY with JSON: {"summary": string, "strengths": string[], "concerns": string[], "suggestedNextStep": string}.',
    'HARD RULES: use ONLY the score components and exceptions below. Do not invent traction, revenue, customers, or founder details.',
    `Company: ${c.companyName} — ${c.stage}, ${c.vertical} → ${c.subcategory}. Score ${c.score.toFixed(1)}/10.`,
    `Components: ${c.components.map((x) => `${x.label} ${x.points}/${x.max} (${x.rationale})`).join('; ')}`,
    `Policy exceptions: ${c.exceptions.join('; ') || 'none'}`,
  ].join('\n');
  const out = await callModelJson(
    prompt,
    z.object({ summary: z.string(), strengths: z.array(z.string()), concerns: z.array(z.string()), suggestedNextStep: z.string() }),
  );
  const result = fitExplanationSchema.parse({ ...out, demo: false, cached: false });
  toCache(key, result);
  audit({ provider: 'ai', mode: 'live', action: 'explain-fit', subject: c.companyId, outcome: 'ok', detail: `Model ${env.AI_MODEL ?? 'default'}` });
  return result;
}

// ── Portfolio comparison ─────────────────────────────────────────

function localPortfolioComparison(company: FitExplainContext, portfolio: PortfolioCompany[]): PortfolioComparison {
  if (portfolio.length === 0) {
    return portfolioComparisonSchema.parse({
      summary: `No portfolio file is loaded, so no comparison can be made for ${company.companyName}. Upload a portfolio file under Data Sources → Local portfolio file to enable this analysis.`,
      overlaps: [],
      whitespace: 'Unknown until a portfolio is loaded.',
      demo: true,
      cached: false,
    });
  }
  const sameVertical = portfolio.filter((p) => p.vertical.toLowerCase() === company.vertical.toLowerCase());
  const sub = company.subcategory.toLowerCase();
  const themed = portfolio.filter((p) => p.themes.some((t) => sub.includes(t.toLowerCase()) || t.toLowerCase().includes(sub)));
  const competitive = portfolio.filter((p) => p.competitiveOverlapThemes.some((t) => sub.includes(t.toLowerCase()) || t.toLowerCase().includes(sub)));
  const partnership = portfolio.filter((p) => p.partnershipThemes.some((t) => sub.includes(t.toLowerCase()) || t.toLowerCase().includes(sub)));
  const concentration = portfolio.length > 0 ? sameVertical.length / portfolio.length : 0;
  const hasThemeData = portfolio.some((p) => p.themes.length + p.partnershipThemes.length + p.competitiveOverlapThemes.length > 0);
  return portfolioComparisonSchema.parse({
    summary: `${company.companyName} (${company.vertical} → ${company.subcategory}, ${company.stage}) compared against ${portfolio.length} portfolio compan${portfolio.length === 1 ? 'y' : 'ies'}: ${sameVertical.length} share the vertical${hasThemeData ? `, ${themed.length} share recorded themes` : ''}. This local comparison uses only recorded verticals, stages, and themes — it makes no claims beyond that data.`,
    overlaps: [
      ...sameVertical.map((p) => ({
        portfolioCompany: p.name,
        note: `Shared vertical (${p.vertical}); portfolio company is ${p.stage}, ${p.status}.`,
      })),
      ...themed.filter((p) => !sameVertical.includes(p)).map((p) => ({
        portfolioCompany: p.name,
        note: `Shared recorded theme(s): ${p.themes.filter((t) => sub.includes(t.toLowerCase()) || t.toLowerCase().includes(sub)).join(', ')}.`,
      })),
    ],
    whitespace: sameVertical.length === 0
      ? `No existing ${company.vertical} position in the loaded portfolio — this would be a new vertical entry.`
      : `The portfolio already holds ${sameVertical.length} ${company.vertical} position(s); assess sub-segment differentiation (${company.subcategory}) before advancing.`,
    sharedThemes: Array.from(new Set(themed.flatMap((p) => p.themes.filter((t) => sub.includes(t.toLowerCase()) || t.toLowerCase().includes(sub))))),
    partnershipOpportunities: partnership.map((p) => `${p.name} — recorded partnership theme(s): ${p.partnershipThemes.join(', ')}`),
    concentrationRisk: portfolio.length === 0 ? ''
      : concentration >= 0.4 ? `High: ${sameVertical.length}/${portfolio.length} portfolio companies already sit in ${company.vertical}.`
      : concentration > 0 ? `Moderate: ${sameVertical.length}/${portfolio.length} portfolio companies in ${company.vertical}.`
      : `None recorded: no ${company.vertical} positions in the loaded portfolio.`,
    themeExpansion: hasThemeData
      ? (themed.length === 0 ? `No recorded portfolio theme matches "${company.subcategory}" — a position here would extend the theme map.` : `Extends existing theme coverage: ${Array.from(new Set(themed.flatMap((p) => p.themes))).slice(0, 5).join(', ')}.`)
      : 'Theme fields are empty in the loaded portfolio — add themes to enable this analysis (not guessed).',
    confidence: competitive.length > 0 || themed.length > 0 ? 'Medium' : sameVertical.length > 0 ? 'Medium' : 'Low',
    evidenceNotes: portfolio.slice(0, 10).flatMap((p) => p.evidenceUrls.map((u) => `${p.name}: ${u}`)),
    demo: true,
    cached: false,
  });
}

export async function comparePortfolio(rawCompany: unknown, rawPortfolio: unknown): Promise<PortfolioComparison> {
  const company = fitExplainContextSchema.parse(rawCompany);
  const portfolio = z.array(portfolioCompanySchema).parse(rawPortfolio ?? store.raw.portfolio);
  const key = cacheKey('portfolio', { company, portfolio });
  const cached = fromCache<PortfolioComparison>(key);
  if (cached) return { ...cached, cached: true };

  if (modes.ai() !== 'live') {
    const local = localPortfolioComparison(company, portfolio);
    toCache(key, local);
    return local;
  }
  const prompt = [
    'Compare a prospective investment against an existing portfolio. Respond ONLY with JSON: {"summary": string, "overlaps": [{"portfolioCompany": string, "note": string}], "whitespace": string}.',
    'HARD RULES: use only the data below; do not invent product details, revenue, or relationships.',
    `Prospect: ${company.companyName} — ${company.stage}, ${company.vertical} → ${company.subcategory}, score ${company.score.toFixed(1)}/10.`,
    `Portfolio: ${portfolio.map((p) => `${p.name} (${p.vertical}, ${p.stage}, ${p.status})`).join('; ') || 'empty'}`,
  ].join('\n');
  const out = await callModelJson(
    prompt,
    z.object({ summary: z.string(), overlaps: z.array(z.object({ portfolioCompany: z.string(), note: z.string() })), whitespace: z.string() }),
  );
  const result = portfolioComparisonSchema.parse({ ...out, demo: false, cached: false });
  toCache(key, result);
  audit({ provider: 'ai', mode: 'live', action: 'compare-portfolio', subject: company.companyId, outcome: 'ok', detail: `${portfolio.length} portfolio companies` });
  return result;
}

/** Cheap verification that the configured AI key actually works. */
export async function verifyAiConnection(): Promise<{ ok: boolean; detail: string }> {
  if (modes.ai() !== 'live') {
    return { ok: true, detail: 'Local Mode: deterministic templates active. No AI key configured (or INTEGRATION_MODE=mock).' };
  }
  try {
    if (env.AI_PROVIDER === 'anthropic') {
      const res = await fetchWithRetry('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': aiKey()!, 'anthropic-version': '2023-06-01' },
      });
      return res.ok
        ? { ok: true, detail: 'Anthropic API responded — key verified.' }
        : { ok: false, detail: `Anthropic API rejected the key (${res.status}).` };
    }
    const res = await fetchWithRetry('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${aiKey()}` },
    });
    return res.ok
      ? { ok: true, detail: 'OpenAI API responded — key verified.' }
      : { ok: false, detail: `OpenAI API rejected the key (${res.status}).` };
  } catch (e) {
    return { ok: false, detail: `Could not reach the AI provider: ${(e as Error).message}` };
  }
}
