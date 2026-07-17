import { aiKey, env, modes } from '../env';
import { fetchWithRetry } from '../lib/http';
import { audit } from '../lib/guard';
import {
  emailGenContextSchema,
  generatedEmailSchema,
  type EmailGenContext,
  type GeneratedEmail,
} from '../../shared/integrations';

/**
 * Email-generation abstraction. The provider is pluggable
 * (template | anthropic | openai) behind one interface, and EVERY
 * provider's output — including the live models — passes through
 * validateGeneratedEmail, which rejects facts that were not in the
 * supplied context (funding amounts, accelerators, traction claims,
 * customer names). Missing information produces honest, general
 * wording plus a weak-evidence warning; it is never invented.
 */
export interface EmailGenerator {
  provider: string;
  generateOutreachEmail(context: EmailGenContext): Promise<GeneratedEmail>;
  regenerateOutreachEmail(context: EmailGenContext, instructions: string): Promise<GeneratedEmail>;
  explainPersonalizationSources(context: EmailGenContext): string[];
}

// ── Fact guard ───────────────────────────────────────────────────

const ACCELERATORS = [
  'y combinator', 'yc ', 'techstars', '500 global', '500 startups', 'somos',
  'a16z', 'andreessen', 'sequoia arc', 'neo accelerator', 'plug and play',
];
const TRACTION_WORDS = /\b(customers?\s+include|arr|mrr|revenue\s+of|users|partnership\s+with|piloting\s+with)\b/i;

/** Returns a list of invented-fact issues; empty list = clean. */
export function factGuardIssues(context: EmailGenContext, subject: string, body: string): string[] {
  const output = `${subject}\n${body}`.toLowerCase();
  const allowed = [
    context.companyName, context.companyDescription, context.whyFits,
    context.verifiedFounderDetail ?? '', context.recentMilestone ?? '',
    context.acceleratorOrFunding ?? '', context.customInstructions,
    context.founderFullName, context.founderRole, context.vertical,
    context.subcategory, context.senderName, context.senderRole,
    context.meetingAsk,
  ].join('\n').toLowerCase();

  const issues: string[] = [];

  // Dollar amounts must appear in the supplied facts verbatim-ish.
  const amounts = output.match(/\$\s?\d[\d,.]*\s*(?:k|m|b|million|billion)?/g) ?? [];
  for (const a of amounts) {
    const canonical = a.replace(/\s+/g, '');
    if (!allowed.replace(/\s+/g, '').includes(canonical)) {
      issues.push(`Invented funding/amount "${a.trim()}" — not present in the provided facts.`);
    }
  }

  // Accelerator names must be grounded in the context.
  for (const acc of ACCELERATORS) {
    if (output.includes(acc) && !allowed.includes(acc)) {
      issues.push(`Invented accelerator reference "${acc.trim()}" — not present in the provided facts.`);
    }
  }

  // Traction/customer/revenue claims require a grounded milestone or detail.
  const tractionHit = output.match(TRACTION_WORDS);
  if (tractionHit && !TRACTION_WORDS.test(allowed)) {
    issues.push(`Traction claim ("${tractionHit[0]}") has no supporting fact in the context.`);
  }

  // Percentages need grounding too.
  const pcts = output.match(/\d{1,3}\s?%/g) ?? [];
  for (const p of pcts) {
    if (!allowed.includes(p.replace(/\s+/g, ''))) {
      issues.push(`Invented statistic "${p}" — not present in the provided facts.`);
    }
  }
  return issues;
}

export function validateGeneratedEmail(
  context: EmailGenContext,
  raw: unknown,
): GeneratedEmail {
  const parsed = generatedEmailSchema.parse(raw);
  const issues = factGuardIssues(context, parsed.subject, parsed.body);
  if (issues.length > 0) {
    throw Object.assign(
      new Error('Generated email failed fact validation and was rejected.'),
      { status: 422, issues },
    );
  }
  return parsed;
}

function weakEvidence(c: EmailGenContext): { weak: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!c.verifiedFounderDetail) warnings.push('No verified founder-background detail on record — the draft uses general wording instead of personal details.');
  if (!c.recentMilestone) warnings.push('No sourced recent milestone available — the draft avoids claiming one.');
  if (c.sourceLinks.length === 0) warnings.push('No supporting source links were provided — personalization evidence is weak; consider adding evidence before sending.');
  return { weak: warnings.length >= 2, warnings };
}

// ── Deterministic template generator (Demo Mode) ─────────────────

const OPENERS: Record<EmailGenContext['tone'], (c: EmailGenContext) => string> = {
  'Warm and conversational': (c) => `Hope your week is going well. I came across ${c.companyName} and wanted to reach out directly.`,
  'Concise and direct': (c) => `I'll keep this short: ${c.companyName} looks like a strong fit for what we invest in.`,
  'Thesis-focused': (c) => `${c.companyName} sits squarely in a thesis we're actively investing behind: ${c.vertical} — specifically ${c.subcategory}.`,
  'Founder-first': (c) => `Before anything about us: what you're building at ${c.companyName} caught our attention on its own merits.`,
  'Formal': (c) => `I am writing on behalf of VamosVentures regarding ${c.companyName}.`,
  'Custom': (c) => `I wanted to reach out about ${c.companyName}.`,
};

class TemplateGenerator implements EmailGenerator {
  provider = 'template (Demo Mode)';

  explainPersonalizationSources(c: EmailGenContext): string[] {
    const used: string[] = [`Company description and vertical fit (${c.vertical} → ${c.subcategory}).`];
    if (c.verifiedFounderDetail) used.push(`Verified founder detail: ${c.verifiedFounderDetail}`);
    if (c.recentMilestone) used.push(`Sourced milestone: ${c.recentMilestone}`);
    if (c.acceleratorOrFunding) used.push(`Accelerator/funding fact: ${c.acceleratorOrFunding}`);
    if (!c.verifiedFounderDetail && !c.recentMilestone) {
      used.push('No verified personal detail or milestone was available, so the draft stays general and honest.');
    }
    return used;
  }

  async generateOutreachEmail(context: EmailGenContext): Promise<GeneratedEmail> {
    const c = emailGenContextSchema.parse(context);
    const { weak, warnings } = weakEvidence(c);

    const paragraphs: string[] = [];
    paragraphs.push(`Hi ${c.founderFirstName},`);
    paragraphs.push(OPENERS[c.tone](c));

    const middle: string[] = [];
    middle.push(`${c.companyDescription}`.trim() ? `From what's public, ${lcFirst(c.companyDescription)}` : '');
    middle.push(c.whyFits ? `Why it resonates with us: ${lcFirst(c.whyFits)}` : '');
    if (c.verifiedFounderDetail) middle.push(`Your background stood out — ${lcFirst(c.verifiedFounderDetail)}`);
    if (c.recentMilestone) middle.push(`Congrats as well on a milestone we noticed: ${lcFirst(c.recentMilestone)}`);
    if (c.acceleratorOrFunding) middle.push(`We also saw: ${lcFirst(c.acceleratorOrFunding)}`);
    if (!c.verifiedFounderDetail && !c.recentMilestone) {
      middle.push(`I won't pretend to know more about your journey than what's public — I'd rather hear it from you.`);
    }
    paragraphs.push(middle.filter(Boolean).map(ensurePeriod).join(' '));

    paragraphs.push(
      `VamosVentures is an early-stage fund investing in ${c.vertical.toLowerCase()} among other sectors, with a focus on backing exceptional, often underestimated founders. If you're open to it, I'd love ${c.meetingAsk}.`,
    );
    if (c.tone === 'Custom' && c.customInstructions.trim()) {
      paragraphs.push(`P.S. ${c.customInstructions.trim()}`);
    }
    paragraphs.push(`Best,\n${c.senderName}\n${c.senderRole}, VamosVentures`);

    const subject =
      c.tone === 'Formal'
        ? `VamosVentures — introduction regarding ${c.companyName}`
        : c.tone === 'Thesis-focused'
          ? `${c.companyName} × VamosVentures ${c.vertical} thesis`
          : `${c.companyName} — quick intro from VamosVentures`;

    const result: GeneratedEmail = {
      subject,
      body: paragraphs.filter(Boolean).join('\n\n'),
      rationale: this.explainPersonalizationSources(c).join(' '),
      sources: c.sourceLinks,
      weakEvidence: weak,
      warnings,
      demo: true,
    };
    audit({
      provider: 'ai', mode: 'mock', action: 'generate-email',
      subject: c.companyId, outcome: 'ok',
      detail: `Demo Mode template, tone "${c.tone}"${weak ? ' (weak evidence)' : ''}`,
    });
    return validateGeneratedEmail(c, result);
  }

  async regenerateOutreachEmail(context: EmailGenContext, instructions: string): Promise<GeneratedEmail> {
    const merged = {
      ...context,
      tone: 'Custom' as const,
      customInstructions: instructions || context.customInstructions,
    };
    return this.generateOutreachEmail(merged);
  }
}

// ── Live generator (Anthropic / OpenAI) ──────────────────────────

class LiveGenerator implements EmailGenerator {
  provider = `${env.AI_PROVIDER} (${env.AI_MODEL ?? 'default model'})`;

  explainPersonalizationSources(c: EmailGenContext): string[] {
    return new TemplateGenerator().explainPersonalizationSources(c);
  }

  private prompt(c: EmailGenContext, extra: string): string {
    return [
      'Write a founder-outreach email for a venture fund. Respond ONLY with JSON: {"subject": string, "body": string, "rationale": string}.',
      'HARD RULES: Use ONLY the facts below. Do not invent funding amounts, founder identity or demographics, customer names, revenue, traction, partnerships, accelerator participation, or milestones. If a fact is missing, use general honest wording.',
      `Tone: ${c.tone}. ${c.customInstructions}`.trim(),
      extra,
      `FACTS:\nFounder: ${c.founderFullName} (${c.founderRole})\nCompany: ${c.companyName} — ${c.companyDescription}\nVertical: ${c.vertical} / ${c.subcategory}\nWhy it fits: ${c.whyFits}\nVerified founder detail: ${c.verifiedFounderDetail ?? 'NONE — do not personalize beyond company facts'}\nRecent milestone: ${c.recentMilestone ?? 'NONE — do not claim one'}\nAccelerator/funding: ${c.acceleratorOrFunding ?? 'NONE — do not mention any'}\nSender: ${c.senderName}, ${c.senderRole}, VamosVentures\nMeeting ask: ${c.meetingAsk}`,
    ].filter(Boolean).join('\n\n');
  }

  private async callModel(prompt: string): Promise<{ subject: string; body: string; rationale: string }> {
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
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw Object.assign(new Error('The AI provider rejected the request. Check AI_API_KEY and AI_MODEL.'), { status: 502 });
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      text = data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    } else {
      const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env.AI_MODEL ?? 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw Object.assign(new Error('The AI provider rejected the request. Check AI_API_KEY and AI_MODEL.'), { status: 502 });
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      text = data.choices[0]?.message?.content ?? '';
    }
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as { subject: string; body: string; rationale: string };
  }

  async generateOutreachEmail(context: EmailGenContext): Promise<GeneratedEmail> {
    const c = emailGenContextSchema.parse(context);
    const { weak, warnings } = weakEvidence(c);
    const out = await this.callModel(this.prompt(c, ''));
    const result: GeneratedEmail = {
      subject: out.subject,
      body: out.body,
      rationale: out.rationale,
      sources: c.sourceLinks,
      weakEvidence: weak,
      warnings,
      demo: false,
    };
    // Live output is validated exactly like demo output — invented
    // facts are rejected, not shipped.
    const validated = validateGeneratedEmail(c, result);
    audit({
      provider: 'ai', mode: 'live', action: 'generate-email',
      subject: c.companyId, outcome: 'ok', detail: `Provider ${this.provider}`,
    });
    return validated;
  }

  async regenerateOutreachEmail(context: EmailGenContext, instructions: string): Promise<GeneratedEmail> {
    const c = emailGenContextSchema.parse(context);
    const { weak, warnings } = weakEvidence(c);
    const out = await this.callModel(this.prompt(c, `REVISION INSTRUCTIONS: ${instructions}`));
    return validateGeneratedEmail(c, {
      subject: out.subject,
      body: out.body,
      rationale: out.rationale,
      sources: c.sourceLinks,
      weakEvidence: weak,
      warnings,
      demo: false,
    });
  }
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function ensurePeriod(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function emailGenerator(): EmailGenerator {
  return modes.ai() === 'live' ? new LiveGenerator() : new TemplateGenerator();
}
