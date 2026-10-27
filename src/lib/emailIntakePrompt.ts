/**
 * Standing extraction prompt for the email-intake review queue.
 *
 * Used two ways, with identical wording so both paths produce the same
 * shape:
 *  - With an AI key configured, the server sends it together with the
 *    pasted email (server/services/emailIntake.ts's extractEmailWithAi —
 *    "Extract with Claude" in Settings).
 *  - Without one, a reviewer saves it once as a Claude.ai Project's custom
 *    instructions, pastes each forwarded email into that project, and
 *    pastes the JSON reply back into Deal Radar.
 *
 * Deliberately conservative, matching every other extraction/generation
 * path in this codebase: report only facts the text actually states, and
 * write nothing for anything it doesn't. An invented founder, funding or
 * traction fact is exactly the failure this app spends most of its effort
 * avoiding elsewhere (see server/services/ai.ts's factGuardIssues).
 *
 * The ONE judgment call it asks for is `vertical`: every approved company
 * needs one of the five Vamos sectors, and research never fills it in
 * later, so Claude proposes the best fit from what the company does and
 * says why in `verticalReason`. The reviewer sees that reason and confirms
 * or changes the sector before approving — it is a proposal, not a fact.
 * The sector definitions are generated from src/data/taxonomy.ts so they
 * can never drift from the official Vamos taxonomy.
 */
import { VERTICALS } from '../data/taxonomy';

const VERTICAL_DEFINITIONS = VERTICALS
  .map((v) => `- ${v.id} (${v.name}): ${v.description} Subcategories: ${v.subcategories.map((s) => s.name).join('; ')}.`)
  .join('\n');

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

The one exception is "vertical" (see below): propose the best-fit sector
for every company, and explain your choice in "verticalReason".

Respond with ONLY a JSON object, no other text, shaped exactly like this:

{
  "candidates": [
    {
      "name": "string, required",
      "oneLiner": "one sentence describing what the company does, if stated",
      "vertical": "exactly one of: health, fintech, fow, sustainability, frontier — your best fit based on what the company does (see the definitions below), even if the email doesn't name the sector. Omit ONLY if the email gives no indication at all of what the company does",
      "verticalReason": "one short sentence on why you chose that vertical, citing what the email says the company does",
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

Vertical definitions (use the id before the parentheses):
${VERTICAL_DEFINITIONS}

Omit any other field above that the email doesn't actually state — do not
include it with a null, empty, or placeholder value. If the email names no
companies at all, respond with {"candidates": []}.

Do NOT include a traction rating, score, or judgment of any kind (e.g. no
"traction level" out of 10) — that is a deliberate analyst judgment made by
a human reviewer afterward, never an AI inference. Reporting facts the
email states (like the quote above) is fine; RATING them is not your job.

Here is the email:

---
`;
