# External Action Required

Last verified: 2026-07-28, against the actual local environment.

This file lists **only** things that cannot be completed by writing code. Everything on this list is blocked on a credential, an account, or an infrastructure decision that a human with the right access has to make.

**What is NOT on this list**, because it is already done or is our job rather than anyone else's: writing code, running public sourcing, pushing to GitHub, building Docker images, and any security review. Public credential-free sources (SEC, YC, GitHub public API, arXiv, RSS) need no permission from anybody and are already live. SBIR is the one exception, and not for a credential reason — see §3b.

**Nothing here is a request to Pliancy unless the "Owner" column says Pliancy.** Only §5 and §6 are theirs. §3b is nobody's to fix — it is recorded so it is not mistaken for a missing credential.

---

## Summary

| # | System | Blocked feature | Owner | Rest of app works without it? |
|---|---|---|---|---|
| 1 | AI provider | AI drafts, fit narrative, AI research | Vamos | **Yes** |
| 2 | HubSpot | CRM sync + duplicate check against the real portal | Vamos | **Yes** |
| 3 | Microsoft / Outlook | Draft creation in a real mailbox | Pliancy + Vamos | **Yes** |
| 4 | Product Hunt | The Product Hunt discovery source | Vamos | **Yes** |
| 5 | Hosting | A durable deployment with a persistent volume | Pliancy | **Yes** (runs locally) |
| 6 | Secret storage | Moving secrets off `.env` files | Pliancy | **Yes** |
| 7 | Review link | A shareable URL for Andrew's review | Vamos | **Yes** (localhost works) |
| 8 | Docker verification | Confirming the image builds | Vamos | **Yes** |
| 9 | GitHub Actions | Confirming CI passes on GitHub | Vamos | **Yes** |
| 10 | SBIR/STTR public API | The government-award source | **Nobody — the API itself is down** | **Yes** |

**Every one of these is optional.** The dashboard — live sourcing across all 7 sectors, deterministic scoring, dedup, the full review queue, backups — runs today with zero credentials.

---

## 1. AI provider (Anthropic)

- **System:** Anthropic Claude API (or OpenAI, if preferred)
- **Feature blocked:** AI-generated outreach drafts, AI fit explanation, AI portfolio comparison, and AI-assisted candidate research
- **Environment variables (exact names from `server/env.ts`):** `AI_PROVIDER` (`anthropic` | `openai`), plus **one** of `AI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Optionally `AI_MODEL` (defaults to `claude-sonnet-5`).
- **Credential required:** An Anthropic Console API key with billing enabled.
- **Minimum permission:** A standard API key. No special scope. Recommend a key dedicated to this app so its spend is separable.
- **Why required:** Model calls need an authenticated key. There is no unauthenticated tier.
- **Owner:** **Vamos** — this is a company API account, not something Pliancy administers.
- **Exact current state:** `AI_PROVIDER=` and all three key variables are empty in `.env`. `aiConfigured()` returns `false`; `assertAiAllowed` refuses with reason `no-credential`; zero rows in `ai_usage`; **$0.00 spent**.
- **Already implemented:** Everything except the key. Full client for both providers, the $50/month and $10/run caps, kill switch, per-call ledger, prompt-injection sanitization, secret-leak prevention, structured output validation, and 44 passing guardrail tests. See `AI_COSTS_AND_GUARDRAILS.md`.
- **Exact next action:** Create a key at console.anthropic.com, then add to the backend `.env`:
  `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=<key>`. Restart the backend. Confirm at Settings → AI budget & guardrails that it reports connected, then generate one outreach draft and check that a row appears in the usage ledger.
- **Without it:** Everything works. Outreach drafts come from a deterministic local template built only from verified facts and are clearly labeled "Local template — no AI model".

## 2. HubSpot

- **System:** HubSpot CRM
- **Feature blocked:** Syncing an approved company to the real portal, searching real records, duplicate-checking against real HubSpot data
- **Environment variables:** either `HUBSPOT_ACCESS_TOKEN` (+ optional `HUBSPOT_PORTAL_ID` for deep links), **or** the OAuth trio `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`.
- **Credential required:** A HubSpot private-app token, or a HubSpot OAuth app.
- **Minimum permission:** `crm.objects.companies.read` + `.write`, `crm.objects.contacts.read` + `.write`, `crm.objects.deals.read` + `.write`. **If you want to start read-only, the `.read` scopes alone are enough** to verify the connection, run search, and exercise duplicate detection — write scopes are only needed for the sync action itself.
- **Why required:** HubSpot has no anonymous API.
- **Owner:** **Vamos** — the HubSpot portal is a Vamos account.
- **Exact current state:** `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_PORTAL_ID` all empty. `HUBSPOT_REDIRECT_URI` is set to a localhost callback. Status reports *"Implemented — credentials required"*. Every HubSpot action returns `503 not_connected` with a setup hint.
- **Also required before first write:** the `vamos_*` custom properties must exist in the target portal, or writes fail on HubSpot's side. See the README for the recommended property set.
- **Already implemented:** Full client — private-app and OAuth auth, the 4-tier duplicate-check ladder (radar id → domain → name → founder email), create/update with explicit-field preservation, associations, notes, search across companies/contacts/deals, sync history, and a retry queue for failures. Tested against a stubbed portal.
- **Exact next action:** Create a private app in HubSpot with the read scopes above, add `HUBSPOT_ACCESS_TOKEN=<token>` to `.env`, restart, and click **Test connection** in Settings → Integrations. Add write scopes and the `vamos_*` properties only when you are ready to sync for real.
- **Without it:** Everything else works. Companies are reviewed in-app; the sync button reports honestly that it is not connected.

## 3. Microsoft / Outlook

- **System:** Microsoft Graph (Entra ID app registration)
- **Feature blocked:** Creating a real outreach **draft** in a Vamos mailbox, and reading lead emails
- **Environment variables:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, plus `SESSION_SECRET` (used to encrypt the stored OAuth tokens at rest).
- **Credential required:** An Entra ID (Azure AD) app registration in the Vamos tenant, with admin consent granted.
- **Minimum permission:** Delegated `Mail.ReadWrite`, `User.Read`, `offline_access`.
  **Please review the scope.** `Mail.ReadWrite` is broader than this app needs — it only ever creates drafts. If Microsoft offers a narrower drafts-only delegated permission that your policy would prefer, we will use it instead.
  **`Mail.Send` is deliberately NOT requested and must not be granted.** There is no send path anywhere in this codebase; a human sends from their own mailbox.
- **Why required:** Graph requires a registered application and tenant consent. Neither can be created from code.
- **Owner:** **Pliancy** (tenant administration, app registration, admin consent) **with Vamos** (deciding which mailbox).
- **Exact current state:** `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are empty; `MICROSOFT_TENANT_ID=common`; `MICROSOFT_REDIRECT_URI` points at a localhost callback. `SESSION_SECRET` is empty. `outlookConfigured()` returns `false`; status reports *"Implemented — credentials required"*; draft creation returns `503 not_connected`.
- **Already implemented:** Full Graph client — OAuth authorization-code flow with server-side single-use expiring state validation, AES-256-GCM token encryption at rest, token refresh, and drafts-only creation. Tokens never reach the browser.
- **Exact next action for Pliancy:**
  1. Register an application in the Vamos Entra tenant.
  2. Add delegated `Mail.ReadWrite`, `User.Read`, `offline_access` (or a narrower drafts-only equivalent if one exists and you prefer it). **Do not add `Mail.Send`.**
  3. Grant admin consent.
  4. Add the redirect URI matching the eventual deployment: `{APP_ORIGIN}/api/outlook/callback`.
  5. Return the client id, client secret, and tenant id through whatever secret channel you prefer — please do not email them in plain text.
- **Without it:** Everything else works. Drafts can still be generated and reviewed in-app; they just cannot be pushed into a mailbox.

## 3b. SBIR/STTR public awards API — **no credential exists to fix this**

- **System:** `api.www.sbir.gov/public/api/awards`
- **Feature blocked:** the SBIR/STTR government-award source (a tier-1 commercialization signal)
- **Environment variable:** **none.** This API is documented as key-free; there is nothing to configure.
- **Owner:** **nobody at Vamos or Pliancy can fix this.** Listed here only so it is not mistaken for a credential gap.
- **Exact current state, probed 2026-07-28:**
  - With no `User-Agent`: **HTTP 403.**
  - With any identifying `User-Agent`: **HTTP 429** on the *first* request of a run, with body `{"Code":"TooManyRequestsError","Message":"The SBIR Public API is not available at this time."}` and **no `Retry-After` header**. Repeated across spaced attempts.
  - Meanwhile `https://www.sbir.gov/awards` (the human-facing site) returns **200**.
- **Diagnosis:** this is the API refusing everyone at the service level, not us being throttled. No backoff, queueing, or caching strategy changes it. It reads as the public API being disabled or gated while the website stays up.
- **What is already implemented:** the full politeness layer it would need the moment it comes back — identifying User-Agent, a 2-second per-host minimum gap, request queueing, bounded exponential backoff, `Retry-After` handling, a 30-minute response cache, and a per-run request budget (`server/sourcing/politeness.ts`). The adapter also parses the full award record (recipient, date, amount, agency, program, project description, direct award URL) and labels awards as **non-dilutive commercialization signals, never equity rounds**.
- **Deliberately NOT done:** scraping `www.sbir.gov`'s HTML as a workaround. The API is saying no; routing around that would be bypassing an access restriction.
- **Exact next action:** none available to us. Optionally contact SBIR support to ask whether the public API has been retired or moved. Re-probe periodically — the adapter will start working with no code change if the service returns.
- **Without it:** SEC Form D, Y Combinator, and funding-news RSS all still work. SBIR is reported as a failed source in every run report rather than silently omitted.

## 4. Product Hunt

- **System:** Product Hunt API v2 (GraphQL)
- **Feature blocked:** The Product Hunt discovery source only
- **Environment variable:** `PRODUCTHUNT_TOKEN`
- **Credential required:** A Product Hunt developer token from producthunt.com/v2/oauth/applications
- **Minimum permission:** Public read. No write scope.
- **Why required:** The endpoint rejects unauthenticated requests (a real probe returns Product Hunt's own `invalid_oauth_token` error).
- **Owner:** **Vamos**
- **Exact current state:** `PRODUCTHUNT_TOKEN` is not present in `.env`. The adapter refuses to run and is honestly labeled **"Credentials required"** — it never simulates a result. Its source-quality row shows zeros because it has never run, and the UI says so.
- **Already implemented:** Full GraphQL client. The endpoint's existence and auth requirement were confirmed with a real request.
- **Exact next action:** Create a developer token, add `PRODUCTHUNT_TOKEN=<token>` to `.env`, restart. The source flips from "Credentials required" to "Live" automatically — `getSourceMeta()` recomputes on every call, so no code change is needed.
- **Without it:** Six of seven discovery adapters still run. This one is skipped at zero cost and reported as skipped, not failed.

## 5. Hosting — PLIANCY

- **System:** Wherever this application will actually run
- **Feature blocked:** Any durable deployment; the autonomous scheduler (`RUN_SCHEDULER=true` needs a continuously running process); a stable URL
- **Environment variables affected:** `FRONTEND_URL`, `PORT`, `DATABASE_FILE`, and the OAuth redirect URIs, all of which depend on the final origin
- **Access required:** A decision and provisioning of an approved internal hosting target
- **Why required:** This is an infrastructure decision inside Vamos/Pliancy's environment, not a coding task.
- **Owner:** **Pliancy** (approved hosting guidance and provisioning)
- **Exact current state:** Runs only on a developer's machine. There is also a **Vercel deployment** at `deal-radar-4r8i2ue67-vamos-ventures.vercel.app` that predates this work — see §7 for an important note about it.
- **Already implemented:** `Dockerfile` + `.dockerignore` (multi-stage, non-root, healthcheck), `npm start` production mode serving the built frontend from the backend, `/health/live` and `/health/ready`, graceful shutdown on SIGTERM/SIGINT, and a passing production smoke test.
- **What we need from Pliancy specifically:**
  1. Which hosting target is approved for an internal tool holding sourced company data.
  2. **A persistent volume for the SQLite file.** This is the one hard infrastructure requirement — the database is a single file at `DATABASE_FILE` (default `server/.data/deal-radar.db`), and an ephemeral filesystem means total data loss on every redeploy.
  3. Whether an offsite backup destination is required. Backups currently write to local disk only (retention: 14 files or 30 days).
  4. Any network restrictions — this app makes outbound calls to `api.github.com`, `efts.sec.gov`, `api.ycombinator.com`, `api.www.sbir.gov`, `export.arxiv.org`, `techcrunch.com`, and (once configured) `api.hubapi.com`, `graph.microsoft.com`, `api.anthropic.com`.
- **Without it:** The app runs locally and is fully reviewable there.

## 6. Secret storage — PLIANCY

- **System:** Secret management for the deployment
- **Feature blocked:** Nothing functionally — this is a policy/hardening question
- **Owner:** **Pliancy**
- **Exact current state:** Secrets are read from a `.env` file on disk (`server/env.ts`, Zod-validated at boot). `.env` is gitignored and currently contains no live credentials.
- **What we need:** Whether `.env`-on-disk is acceptable for this deployment, or whether secrets must come from a managed secret store. If a store is required, tell us which one and we will wire it in — that part *is* a coding task, we just need the decision.
- **Related:** `SESSION_SECRET` has a rotation consequence worth knowing: rotating it invalidates every admin session **and** makes any stored Outlook OAuth token undecryptable, requiring a mailbox reconnect.
- **Without it:** Works as-is with file-based secrets.

## 7. Secure review link for Andrew

- **System:** A tunnel or hosted preview
- **Feature blocked:** Sharing a working URL for the workflow-document review
- **Owner:** **Vamos**
- **Exact current state:** No tunneling tool is installed — `cloudflared`, `ngrok`, and `tailscale` are all absent (`which` returns nothing for each). Creating a tunnel requires installing one *and* authenticating it against an account, which needs a human login.
- **Existing Vercel deployments — checked 2026-07-28, and the earlier warning in this file was wrong.** A previous draft of this document warned that `deal-radar-4r8i2ue67-vamos-ventures.vercel.app` and `deal-radar-pzk6auj7b-vamos-ventures.vercel.app` were probably exposing data, because they predate the application-wide auth gate. That was speculation, and probing them disproved it:
  - **Reachable:** yes, both return 200 at `/`.
  - **Protected:** no data is exposed. Every API path tested (`/api/companies/imported`, `/api/audit`, `/api/integrations/status`, `/health/ready`) returns **404**, not data — Vercel is serving the static frontend bundle only, with no backend or serverless functions deployed. There is no API there to bypass, and no company records behind it.
  - **Recommended action:** low urgency, but still take them down or redeploy. They are dead front-ends that will show errors to anyone who opens them, and leaving stale builds around invites someone later attaching a real backend to an ungated bundle. If you redeploy, deploy from the current gated branch and set `ADMIN_PASSWORD` and `SESSION_SECRET` as project environment variables **before** the deployment goes public.
- **Exact next action:** Decide between (a) redeploying to Vercel from the current gated branch with `ADMIN_PASSWORD` and `SESSION_SECRET` set as project environment variables, or (b) `brew install cloudflared`, authenticate, and run a temporary tunnel. Either way, set `ADMIN_PASSWORD` **before** exposing anything — with it unset the app fails closed and nobody can sign in at all.
- **Without it:** The app is fully reviewable at `http://localhost:5173` locally.

## 8. Docker image build verification

- **Owner:** **Vamos** (any machine with Docker)
- **Exact current state:** `docker` is not installed here (`which docker` exits 1).
- **Already implemented:** `Dockerfile` and `.dockerignore` are written — multi-stage `node:24-slim`, runs the full verification chain in the build stage, non-root runtime user, volume for the SQLite directory, healthcheck against `/health/live`, no embedded secrets.
- **Honest status:** *Docker configuration implemented — image build not verified in this environment.*
- **Exact next action:** On a machine with Docker: `docker build -t vamos-deal-radar .`
- **Without it:** Irrelevant to local use.

## 9. GitHub Actions CI verification

- **Owner:** **Vamos**
- **Exact current state:** `.github/workflows/ci.yml` exists and its YAML is valid. Every command it runs (typecheck, lint, test, build, Playwright E2E) passes locally. The workflow itself has not been observed running on GitHub's infrastructure from this session.
- **Requires no secrets** — the E2E harness is self-contained with its own ports, temp database, and test-only credentials.
- **Exact next action:** Open a pull request against `main` and confirm the run goes green.
- **Without it:** Local verification covers the same ground.

---

## What is genuinely NOT blocked

To be explicit, since the point of this document is to keep the ask small:

- **Public sourcing** — SEC Form D (including full filing-document parsing for amounts, first-sale dates and officers), Y Combinator, GitHub public API, arXiv, and funding-news RSS all work today with no credential. Live-probed 2026-07-28. SBIR is the exception: its public API refuses everyone at the service level (§3b).
- **The Vamos Fit Score** — deterministic, no AI, no credential.
- **The entire review workflow** — filters, sorting, detail view, bulk status changes, duplicate detection, per-company research refresh, source analytics, stale settings, backup and restore.
- **Authentication** — implemented and enforced application-wide. Set `ADMIN_PASSWORD` locally to use it.

---

## Phase 14 note: RSS needs nothing from Pliancy

The funding-news pipeline is live and importing real opportunities using only
public RSS feeds. It requires **no credential, no API key, no account, and no
access request.** Do not add it to the Pliancy request.

What Phase 14 did *not* change: the credential-gated items above (HubSpot,
Outlook, the AI provider, Product Hunt) are still blocked on exactly the same
things they were blocked on before, and the SBIR public-API outage is still a
service-side outage rather than a credential problem.

## Phase 15A note: the manual lookup task is done, and nothing was unblocked

Phase 14 flagged one non-credential action a human could take: look up the
websites of the companies whose names were too common to derive a domain from.
Phase 15A did it. Six of them — *Natural*, *Enigma*, *Multiverse*, *Antares*,
*Ramp*, *Venus Aerospace* — are now corroborated opportunities. *Infinity* is
surfaced for human review. *Cascade* was never in the database; it was an
error in these documents, now corrected.

There is a dashboard workflow for this now (company detail → Opportunity
status → **Confirm website**), so the next one does not need an engineer. It
asks for the site, a supporting evidence URL, and a written reason, shows what
it would replace, and records the change in classification history.

**None of this changed the Pliancy ask.** The credential-gated items above
(HubSpot, Outlook, the AI provider, Product Hunt) are blocked on exactly the
same things, and the SBIR public-API outage is still a service-side outage.
Adding website confirmations to the request would be padding it.
