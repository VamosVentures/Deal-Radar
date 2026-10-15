/**
 * Standing extraction prompt for the email-intake review queue.
 *
 * No AI provider is configured for this app, and none is planned (same
 * situation `src/lib/claudePrompt.ts` documents for company analysis) —
 * so instead of a server-side model call, a reviewer runs this themselves
 * in their own Claude.ai chat and pastes the JSON reply back into Deal
 * Radar. This is a FIXED constant rather than a per-email builder: there
 * is no per-email customization to inject (the email text itself is never
 * routed through Deal Radar — see server/services/emailIntake.ts) — a
 * reviewer saves this once as a Claude.ai Project's custom instructions
 * and reuses it for every forwarded email.
 *
 * Deliberately conservative, matching every other extraction/generation
 * path in this codebase: extract only what the text actually states, and
 * write nothing for anything it doesn't. An invented vertical, founder, or
 * funding fact is exactly the failure this app spends most of its effort
 * avoiding elsewhere (see server/services/ai.ts's factGuardIssues).
 */
export const EMAIL_INTAKE_PROMPT = `You are helping an early-stage venture team (Vamos Ventures) turn a forwarded
deal-flow email into structured records for their pipeline tool.

I'm going to paste the text of an email below. It may describe one company
or several. For EACH distinct company mentioned, extract only what the
email text actually states. Do not infer, guess, or fill in anything it
doesn't say — if a field isn't stated, leave it out of that company's
object entirely rather than writing "unknown" or a plausible-sounding
guess. This applies especially to funding amounts, founder identity, and
traction/customer claims: an invented fact here is worse than a missing
one, because someone will act on it as if it were real.

Respond with ONLY a JSON object, no other text, shaped exactly like this:

{
  "candidates": [
    {
      "name": "string, required",
      "oneLiner": "one sentence describing what the company does, if stated",
      "vertical": "one of: health, fintech, fow, sustainability, frontier — only if the email clearly implies one of these five, otherwise omit",
      "subcategory": "a short specific category, if stated or clearly implied (e.g. 'Remote patient monitoring')",
      "stage": "one of: Pre-seed, Seed, Series A, Stealth, Unknown — only if stated",
      "city": "string, if stated",
      "state": "two-letter state abbreviation, if stated",
      "website": "the company's URL, if stated",
      "foundedYear": "a number, if stated",
      "teamSize": "a number, if stated",
      "founders": [
        { "name": "string", "role": "string, e.g. CEO", "background": "a sentence on their background, if stated" }
      ],
      "raising": "a short description of what round/amount they're raising, if stated",
      "accelerator": "an accelerator/program name, if stated",
      "quote": "a short excerpt (1-2 sentences), copied verbatim from the email, that best supports why this company is worth looking at — this becomes the sourced evidence for the record"
    }
  ]
}

Omit any field above that the email doesn't actually state — do not include
it with a null, empty, or placeholder value. If the email names no
companies at all, respond with {"candidates": []}.

Do NOT include a traction rating, score, or judgment of any kind (e.g. no
"traction level" out of 10) — that is a deliberate analyst judgment made by
a human reviewer afterward, never an AI inference. Reporting facts the
email states (like the quote above) is fine; RATING them is not your job.

Here is the email:

---
`;
