import type { Company, FitScore } from '../types';
import { verticalById } from '../data/taxonomy';

/**
 * Build a structured analysis prompt from what is ON RECORD for a
 * company, for a person to paste into Claude themselves.
 *
 * Why this exists. No AI provider is configured (and none is planned
 * for the local pilot — see AI_COSTS_AND_GUARDRAILS.md), so the two
 * in-app "AI analysis" actions answer with a deterministic local
 * template. That template is honest and useful, but it is a summary of
 * the score, not analysis: it cannot weigh whether a $30M Form D with
 * no press coverage is a real round, or notice that a sector's whole
 * shortlist rests on one filing agent. That judgement is what the team
 * actually wants, and they have Claude in a browser tab already.
 *
 * So rather than a button that pretends, this assembles the evidence
 * into a prompt and hands it over. NOTHING here calls a model, and the
 * UI must never imply one ran — see the copy in AiAnalysis.tsx.
 *
 * What goes in is deliberately limited to recorded, sourced facts and
 * the audited score components. Specifically NOT included:
 *
 *   - internal notes — candid team opinion, written on the
 *     understanding it stays in the tool; the clipboard is one paste
 *     away from a chat window (same reasoning as the CSV export, see
 *     src/lib/csvExport.ts);
 *   - founder emails, or any contact detail — a prompt is not a reason
 *     to move personal contact data somewhere new;
 *   - demographic or identity fields — verified self-identification is
 *     recorded for reporting, and is nobody's input to a fit opinion.
 *
 * Unknowns are written as "not on record" rather than omitted, because
 * a model given a gap silently will fill it, and an invented stage is
 * exactly the failure this codebase spends most of its effort avoiding.
 */

function line(label: string, value: string | number | undefined | null): string {
  const v = value === undefined || value === null || value === '' ? 'not on record' : String(value);
  return `- ${label}: ${v}`;
}

export function buildClaudePrompt(c: Company, fit: FitScore): string {
  const vertical = verticalById(c.vertical)?.name ?? c.vertical;

  const facts = [
    line('Company', c.name),
    line('One-liner', c.oneLiner),
    line('Vertical', `${vertical} → ${c.subcategory}`),
    line('Stage', c.stage === 'Unknown' ? undefined : c.stage),
    line('Location', [c.city, c.state].filter((p) => p && p !== 'Unknown').join(', ') || undefined),
    line('Website', c.website),
    line('Founded', c.foundedYear || undefined),
    line('Team size', c.teamSize || undefined),
    line('Accelerator', c.accelerator),
    line('Last funding date', c.lastFundingDate),
    line('Raising', c.raising),
    line('Analyst traction rating', c.traction?.note ? `${c.traction.level}/10 — ${c.traction.note}` : undefined),
  ].join('\n');

  // Roles and backgrounds only. No emails, no LinkedIn, no identity.
  const founders = c.founders.length
    ? c.founders.map((f) => `- ${f.name} (${f.role || 'role not on record'}): ${f.background || 'background not on record'}`).join('\n')
    : '- No founders on record.';

  const evidence = c.evidence.length
    ? c.evidence
        .map((e, i) => `${i + 1}. [${e.type}] ${e.claim}\n   source: ${e.source} · ${e.date || 'date not on record'}\n   url: ${e.url}`)
        .join('\n')
    : 'No evidence on record.';

  const components = fit.components
    .map((x) => `- ${x.label}: ${x.points}/${x.max} — ${x.rationale}`)
    .join('\n');

  const exceptions = fit.exceptions.length
    ? fit.exceptions.map((e) => `- ${e.message}`).join('\n')
    : '- None.';

  const scoreCaveat = fit.provisional
    ? `${fit.score.toFixed(1)}/10 — PROVISIONAL. ${fit.provisionalReason ?? ''}`.trim()
    : `${fit.score.toFixed(1)}/10 (computed over ${fit.assessablePoints} of 100 assessable points — ${Math.round(fit.completeness * 100)}% of the model)`;

  return `You are helping an early-stage venture team (Vamos Ventures) screen a sourced company.

Everything below is what we actually have on record. Where a field says
"not on record", that is a gap in OUR sourcing — treat it as unknown.
Do not fill it in, infer it, or assume a value. If a conclusion depends
on something not on record, say which fact you would need.

## Recorded facts
${facts}

## Founders (roles and backgrounds as recorded)
${founders}

## Sourced evidence
${evidence}

## Our internal fit score (for context — you may disagree with it)
Score: ${scoreCaveat}

Component breakdown:
${components}

Policy exceptions flagged:
${exceptions}

## What I want from you
1. Is there a real, current financing event here, or only the appearance
   of one? Say explicitly which evidence supports your answer.
2. What are the two or three most important things this record is
   MISSING before a partner should spend time on it?
3. Where does the evidence look thin, circular, or self-referential
   (for example, a company's own website used to corroborate its own
   filing)?
4. Given the sector and stage, what would you ask the founders first?
5. Flag anything that looks like a data-quality problem in the record
   itself, rather than a fact about the company.

Be concise and concrete. Cite the numbered evidence items. If the
evidence does not support a confident answer, say so plainly instead of
hedging into a guess.`;
}
