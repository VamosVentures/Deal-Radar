# Friday readiness — Vamos Deal Radar

Audited 2026-07-30. Every row below was exercised by hand in a browser
against a **copy** of the live database, on isolated ports, with
throwaway credentials. Nothing in this document is inferred from code
reading alone, and nothing is aspirational.

**Friday local demo ready: YES.**

## Start it

```bash
npm run dev
```

Then open **http://localhost:5173** and sign in with `ADMIN_PASSWORD`
from `.env`. (The API runs on :8787; Vite proxies `/api` to it.)

---

## How this audit was run, and why it matters

The audit ran against `audit-copy.db`, a byte copy of the live database,
served by a second API on port 8911 with its own throwaway
`ADMIN_PASSWORD` and `SESSION_SECRET`. Three reasons, all of which bit:

1. **A dev server was already running on :8787 against the real
   database.** Auditing on the default ports would have pointed every
   click at live company data. The first attempt did exactly that and
   was stopped before anything was written — the live file's SHA-256 was
   checked before and after and was identical.
2. **Mutating actions had to be tested for real.** Review-status
   changes, notes, and backups were genuinely written — to the copy.
3. **The real password and session secret were never read, typed, or
   used.** Overriding them for the audit process means the production
   values stayed out of the browser and out of this transcript.

---

## Feature inventory

Classification: **Working** · **Fixed in this phase** · **Pending
credentials** (intentionally unavailable) · **External unavailable** ·
**Future** (present but not presented as active).

| Feature | Status | Verified how |
|---|---|---|
| Sign-in gate (whole app, server-enforced) | Working | Every route redirected to the sign-in screen unauthenticated; API 401s independently |
| Sign out / re-lock | Working | Settings re-locks in place; session cleared |
| Microsoft SSO button | Pending credentials | Correctly **not rendered** at all in `AUTH_MODE=local` — no dead button, no pending notice |
| Dashboard metrics (Overview) | Working | 209 discovered / 0 high-fit / 172 awaiting review / 92 not-yet-scorable — all consistent with the table |
| Vamos Fit ranking + Top-10 toggle | Working | Ranked list renders with real scores |
| Company table (172 rows) | Working | Rendered row count equals the reported count — **no silent truncation** |
| Search (company/founder/website/keyword) | Working | 172 → 25 on "robotics" → 0 on a nonsense term → 172 cleared |
| Vertical / stage / state filters | Working | Each narrows correctly |
| Sorting (fit / evidence recency / discovery date) | Working | All three produce distinct, correct orderings |
| Pagination | Working (none — by design) | No pagination exists; the full filtered set renders. At 172 rows this is honest and fast. Documented rather than invented. |
| Scorable-only filter | Working | 172 → 80; hides exactly the 92 provisional records |
| Provisional-score labels | Working | 92 `prov.` row chips, each with the full "why" tooltip; `PROVISIONAL` badge + reason in the detail panel |
| Sector shortlists | Working | 23 selected across 7 sectors; sectors shown short (FoW 0/5, Space Tech 2/5) rather than padded |
| Held-back reasons | Working | 10 held back, each with a specific stated reason (source-family cap, ranked below cutoff) |
| Company detail panel | Working | Opens with score breakdown, component rationales, recommendation |
| Evidence links + source attribution | Working | Real SEC EDGAR archive URLs, per-item source and tier |
| Qualification explanations | Working | Verdict, corroborating-source count, operating-evidence level, per-component rationale |
| Human-review queue filters | Working | Duplicate-only, missing-info, evidence confidence, staleness, human-review-required all filter |
| Status / review updates (Monitor / Pass / Research) | Working | `Monitor` persisted to `review_decisions`; reflected in the table and the CSV |
| Stamp reviewed today | Working | Records the date only, and says so in adjacent copy |
| Persistent internal notes | Working | Created, persisted with reviewer attribution and timestamp |
| Note edit / archive / restore | Working | Full cycle; archive is reversible and says so; edit timestamp recorded |
| Note privacy | Working | Note text absent from the bulk company payload, the CSV, and the audit log (which stores the note **id** only) |
| CSV export | Working | 174 lines, 26 columns, carries the provisional flag and qualification verdict, formula-injection guarded, **no note column** |
| Source analytics (quality + diversity) | Working | Real per-family / per-source / per-tier / per-sector counts |
| Public-source run history | Working | Persisted history: last run, last success, 1142 retrieved / 71 created, rate-limit status |
| Manual public-source refresh | Working | Ran; reported per-connector `LOCAL` / `FAILED` / `DISABLED` — **no fabricated successes** |
| Disabled connector "Run sync" | **Fixed in this phase** | Was disabled with no explanation at all; now states why and how to enable |
| Discovery "Import selected" | **Fixed in this phase** | Was disabled with no explanation; now says to select a candidate first |
| Copy Claude prompt | **Fixed in this phase** | New credential-free path: copies a structured prompt built from recorded evidence, for a person to run in Claude. States plainly that no AI ran here |
| Explain fit / Compare vs portfolio | Working | Real evidence-based output, labelled `LOCAL TEMPLATE — NO AI MODEL USED`; portfolio comparison honestly reports that no portfolio file is loaded |
| Generate founder outreach | Working | Full draft from verified facts, with a "why this draft says what it says" provenance block |
| Save to Outlook Drafts | Pending credentials | Button present with the reason inline: "Outlook is not connected. Connect it under Data Sources & Refresh to save drafts." |
| Approve & add to HubSpot | Pending credentials | Status change persists; the HubSpot step fails honestly |
| Database backups | Working | Created a real `VACUUM INTO` snapshot: schema v10, 209 companies, triggered-by recorded |
| Database integrity | Working | `Integrity: OK` on both the live database and the copy |
| Health endpoints | Working | Smoke test passed against a real production process |
| Integration-status panels | Working | HubSpot / Outlook / AI / refresh all report honest not-connected states |
| Correct website (with evidence) | Working | Covered by the dedicated Playwright spec (preview writes nothing; self-evidence blocked) |
| Stealth Radar | Working (empty) | Honest empty state: "Nothing is pre-populated or simulated" |
| Scheduled sourcing (autonomous timer) | Future | Stored as configuration only; the UI says there is no background scheduler in this backend |
| Outlook lead-folder reading | **Not implemented** | See below — this is the one gap worth saying out loud |

---

## Fixed in this phase

1. **Disabled "Run sync" buttons explained.** Four public-source
   connectors render `Run sync` disabled when the connector is off. They
   carried no tooltip and no adjacent explanation — a greyed-out control
   that told the reader nothing. Now each states either "a refresh run
   is already in progress" or "<connector> is disabled. Use Enable
   first, then run a sync."
2. **Discovery "Import selected" explained.** Same class of problem;
   now says "Select at least one candidate above to import."
3. **A credential-free path to real AI analysis.** The two in-app AI
   actions answer from a deterministic local template, which is honest
   but is a summary of the score rather than analysis — it cannot judge
   whether a $30M Form D with no press coverage is a real round. A new
   **Copy Claude prompt** action assembles the recorded evidence and the
   audited score into a structured prompt for a person to run in Claude
   themselves. It says "Copied — no AI ran here," and it deliberately
   excludes internal notes, founder contact details, and identity
   fields — the clipboard is one paste away from a chat window.

Nothing else needed repair. No qualification, scoring, or shortlist rule
was changed.

---

## Still unavailable, and the exact reason

| Area | Reason |
|---|---|
| Microsoft SSO (live) | No Entra app registration exists. Needs the six values in the next section. Falls back to password sign-in; no lockout is possible. |
| Outlook drafts into a real mailbox | Same app registration, plus mailbox consent. Every Outlook action returns `503 not_connected`. |
| **Outlook lead-folder reading** | **Never implemented.** The intended workflow reads leads a person moves into a `Deal Radar Leads` folder. No code calls a folder-listing or message-reading Graph endpoint, and no UI offers it. `LEAD_FOLDER_NAME` in `server/services/outlook.ts` records the boundary the integration is designed to stay inside; it is not an implementation. Do not describe Deal Radar as ingesting email. Building it needs a live mailbox to develop against. |
| HubSpot sync | No `HUBSPOT_ACCESS_TOKEN` or OAuth app. Optional; blocks nothing. |
| AI provider | No `AI_PROVIDER` + key, deliberately (no paid AI in the local pilot). Local templates answer instead, always labelled. |
| Product Hunt source | Needs a developer token; the source refuses to run rather than guessing. |
| Autonomous scheduled sourcing | Needs a continuously hosted backend. On-demand runs work today. |
| Cloud deployment | No hosting target, and no security approval yet (`PLIANCY_SECURITY_REVIEW.md`). |

---

## What Pliancy must provide

One Entra app registration in the **Vamos Ventures** tenant. Full detail
in `EXTERNAL_ACTION_REQUIRED.md` §3.

| Variable | Notes |
|---|---|
| `MICROSOFT_CLIENT_ID` | Application (client) id |
| `MICROSOFT_CLIENT_SECRET` | Send via a secret channel, not email |
| `MICROSOFT_TENANT_ID` | **The Vamos directory GUID.** `common` / `organizations` / `consumers` are refused — they would let any Microsoft account anywhere complete the flow |
| `MICROSOFT_SSO_REDIRECT_URI` | `http://localhost:8787/api/auth/microsoft/callback` |
| `MICROSOFT_REDIRECT_URI` | `http://localhost:8787/api/outlook/callback` (unchanged) |
| `SESSION_SECRET` | 32+ random chars — we generate this, not Pliancy |

**Callback URLs to register in Entra (both, exactly as written):**

```
http://localhost:8787/api/auth/microsoft/callback
http://localhost:8787/api/outlook/callback
```

**Scopes.** Sign-in: `openid`, `profile`, `email`, `User.Read`.
Mailbox (incremental, only when someone clicks Connect Outlook):
`Mail.ReadWrite`, `offline_access`, `User.Read`.
**Never grant `Mail.Send`, any `Mail.*.Shared`, or any application-level
`Mail.*` permission.** A test asserts no scope list in the codebase
contains them.

**Switch-on:** put the values in `.env`, set `AUTH_MODE=hybrid`, restart
the API, live-test a real sign-in. The administrator password keeps
working throughout. Only consider `AUTH_MODE=microsoft` after that test
passes.

---

## Checks run

| Check | Result |
|---|---|
| Unit suite (`npm test`) | **690 passed**, 37 files |
| Playwright suite (`npm run test:e2e`) | **62 passed** |
| Typecheck (`npm run typecheck`) | Clean |
| Lint (`npm run lint`) | 3 pre-existing `react-refresh` warnings, unchanged from before this phase; 0 errors |
| Production build (`npm run build`) | Clean |
| Smoke test (`npm run smoke-test`) | All checks passed against a real `NODE_ENV=production` process |
| Database integrity (`npm run db:integrity`) | `Integrity: OK` — live database and audit copy |
| Backup validation (`npm run db:backup` / `db:list-backups`) | Real snapshot created and listed: schema v10, 209 companies |
| `git diff --check` | Clean |
| Browser walkthrough | Every page and action above; **zero console errors and zero server errors** |

New tests added this phase: 46 for Microsoft SSO security (wrong tenant,
non-Vamos account, guest/federated account, unverified email domain,
forged signature, `alg: none`, RS256→HS256 confusion, wrong audience,
wrong issuer, expired, nonce mismatch, replayed state, Outlook state
redeemed on the sign-in callback, missing configuration, local-mode
fallback, reviewer identity, scope boundaries, no token persisted, no
secret in the audit log), 7 for the Claude-prompt leakage rules, and 3
E2E (no Microsoft button in local mode, the prompt action, the
disabled-connector explanation).

All Microsoft flows are tested with a fixture RSA keypair. **No test
contacts a live tenant, and no credentials were invented.**

---

## Live data

**No live company data was modified.** Verified by content comparison,
not by file hash — and the distinction matters, so here is the whole
picture rather than a reassuring summary.

The file's SHA-256 *did* change during the session (`0d1b944c…` →
`dd300072…`). That is not a data change. Two things re-opened the
database read-only, and SQLite checkpoints its write-ahead log into the
main file when a connection closes, which rewrites bytes without
changing a single row:

1. the developer's own `npm run dev` server, which was already running
   against the live database and which `tsx watch` restarted each time a
   server file was edited during this phase;
2. `npm run db:integrity`, which opens the database to check it.

What was actually verified, table by table (`companies`, `evidence`,
`founders`, `scoring_results`, `issuer_qualification`, `deal_evidence`,
`field_provenance`, `classification_history`, `source_runs`,
`source_run_results`, `migrations`, and the rest — row counts plus a
content hash of every row):

- **Every table the audit did not write to is byte-identical** between
  the live database and the audit copy.
- **`company_notes`: live 0 rows.** The audit's probe note exists only in
  the copy.
- **`review_decisions`: live 176 rows, newest dated 2026-07-28** by
  `phase11-refresh`. The audit's five actions (note created/edited/
  archived/restored, and one `Monitor`) are ids 177–181 **in the copy
  only**. Nothing was written to live today.
- **`companies`: live's most recent `updated_at` is
  `2026-07-30T03:09:53Z`** — the developer's own work from before this
  session. Every audit write carries a 17:54–17:58Z timestamp and
  appears only in the copy.

Company verdicts, scores, and notes are untouched. The real
`ADMIN_PASSWORD` and `SESSION_SECRET` were never read, typed, or used —
the audit process ran with throwaway values of its own.

One thing worth knowing rather than discovering: because a dev server
was running on :8787 throughout, `tsx watch` picked up this phase's
server changes and restarted it. That process is now serving the new
code. Restart it (`Ctrl-C`, then `npm run dev`) if you want a clean
start before the demo.
