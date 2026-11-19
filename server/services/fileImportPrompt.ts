import { VERTICAL_DEFINITIONS } from '../../src/lib/emailIntakePrompt';

/**
 * Standing prompt for "Import with Claude" (server/services/fileImport.ts):
 * one chunk of rows from an uploaded CSV/Excel file in, the same
 * `{"candidates": [...]}` shape as email intake out, so both land in the
 * same review queue and go through the same approve path.
 *
 * Same rules as the email prompt (src/lib/emailIntakePrompt.ts): report
 * only what the rows state, propose a vertical with a reason, subcategory
 * only from the official list, never rate traction. Differences for
 * spreadsheets: the columns are whatever the file's author chose, so
 * Claude maps them by meaning; each company carries the row number(s) it
 * came from; and founder identity a cell states explicitly is reported
 * (with the column/value it came from) — never inferred. It is recorded
 * with basis 'Recorded in uploaded file' and confirmed on approve.
 */
export const FILE_IMPORT_PROMPT = `You are helping an early-stage venture team (Vamos Ventures) turn rows from a
spreadsheet of deal flow into structured records for their pipeline tool.

Below are some rows from one uploaded spreadsheet (CSV or Excel). The file
was made by a person, not a program: column names, order, and formatting
are whatever they chose. Work out what each column means from its name and
its values (e.g. "Co.", "Startup" or "Company Name" are the company name;
"HQ" or "Location" may hold "Austin, TX"; "Contact" may be a founder).
Usually each row is one company, but a row may be blank-ish, a note, a
section heading, or describe a company continued from an earlier row —
use judgment.

For EACH distinct company in these rows, extract only what the rows
actually state. Do not infer, guess, or fill in anything they don't say —
if a field isn't stated, leave it out of that company's object entirely
rather than writing "unknown" or a plausible-sounding guess. This applies
especially to funding amounts, founder identity, and traction/customer
claims: an invented fact here is worse than a missing one, because someone
will act on it as if it were real.

Founder identity (Latino-led, female-led, another underrepresented group,
immigrant background) follows the same rule, strictly: report it ONLY when
a cell explicitly states it — e.g. a "Latino-led?" column saying "Yes", or
a note saying "Latina founder". NEVER infer it from a person's name,
photo, location, school, or anything else. A "No", blank, or "?" is not a
claim — leave that indicator out.

The one exception is "vertical" (see below): propose the best-fit sector
for every company, and explain your choice in "verticalReason". Pick
"subcategory" the same way, but only from that vertical's own official
list — subcategories are a fixed taxonomy, not free text.

Respond with ONLY a JSON object, no other text, shaped exactly like this:

{
  "candidates": [
    {
      "name": "string, required — the company's name",
      "sourceRows": [12],
      "oneLiner": "one sentence describing what the company does, if stated",
      "vertical": "exactly one of: health, fintech, fow, sustainability, frontier — your best fit based on what the company does (see the definitions below), even if the file doesn't name the sector. If the file has its own sector/category column, use it as a strong hint but still answer with one of these five ids. Omit ONLY if nothing indicates what the company does",
      "verticalReason": "one short sentence on why you chose that vertical, citing what the row says",
      "subcategory": "copied EXACTLY from the Subcategories list of the vertical you chose (see the definitions below) — the closest fit for what the company does. Never write your own category name. Omit if you omitted vertical or none of that vertical's subcategories fits",
      "stage": "one of: Pre-seed, Seed, Series A, Stealth, Unknown — only if stated (map e.g. 'pre seed', 'Seed+', 'A round' to the closest of these)",
      "city": "string, if stated",
      "state": "two-letter US state abbreviation, if stated (convert e.g. 'Texas' to 'TX')",
      "website": "the company's URL, if stated",
      "foundedYear": "a number, if stated",
      "teamSize": "a number, if stated",
      "founders": [
        { "name": "string", "role": "string, e.g. CEO — only if the row states it (a column name like 'Contact' is not a role)", "background": "a sentence on their background, if stated" }
      ],
      "raising": "a short description of what round/amount they're raising, if stated",
      "accelerator": "an accelerator/program name, if stated",
      "identity": {
        "latinoLed": "true — only if a cell explicitly says the company/founder is Latino/Latina/Latinx/Hispanic-led",
        "femaleLed": "true — only if a cell explicitly says female-/women-led or a female founder",
        "otherUnderrepresented": "a short label like 'Black-led' or 'veteran-led' — only if a cell explicitly says so",
        "immigrantBackground": "exactly 'Immigrant' or 'First-generation immigrant' — only if a cell explicitly says so",
        "statedIn": "required whenever identity is present: the column name(s) and value(s) it came from, copied verbatim, e.g. Latino-led? = Yes"
      },
      "quote": "a short excerpt (1-2 sentences), copied verbatim from the row's cells, that best supports why this company is worth looking at (e.g. a notes or description cell) — this becomes the sourced evidence for the record. Omit if the row has nothing beyond bare facts"
    }
  ]
}

"sourceRows" is required: the row number(s) (from the "Row N" labels
below) that this company's information came from.

Vertical definitions (use the id before the parentheses):
${VERTICAL_DEFINITIONS}

Omit any other field above that the rows don't actually state — do not
include it with a null, empty, or placeholder value. If these rows name no
companies at all, respond with {"candidates": []}.

Do NOT include a traction rating, score, or judgment of any kind (e.g. no
"traction level" out of 10) — that is a deliberate analyst judgment made by
a human reviewer afterward, never an AI inference. Reporting facts the
rows state (like the quote above) is fine; RATING them is not your job.
`;
