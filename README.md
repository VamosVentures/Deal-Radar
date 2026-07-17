# Vamos Deal Radar

Internal sourcing dashboard MVP for VamosVentures. Discover early-stage companies, organize them by vertical, rank them against the firm's thesis with a fully auditable score, surface likely stealth founders from public signals, and track outreach — with verified-only demographic data and human-in-the-loop contact baked into the code, not just the docs.

**MVP target: July 24, 2026.** Ships with a bundled sample dataset (fictional companies) so every screen is exercisable before live sources are connected.

## Run it

```bash
npm install
npm run dev        # web (http://localhost:5173) + API (http://localhost:8787) together
npm run dev:web    # frontend only
npm run dev:server # backend only
npm test           # backend + integration test suite (vitest)
npm run build      # type-check (app + server) + production build (verified passing)
npm run preview    # serve the production build
npx tsx scripts/smoke.ts      # validate data + scoring invariants
npx tsx scripts/guardrail.ts  # confirm unverified demographics are rejected
```

No `.env` is needed to start: everything boots in **Demo Mode** with all integrations simulated and labeled. Copy `.env.example` to `.env` to configure live integrations.

Stack: Vite + React 19 + TypeScript, Tailwind v4, React Router, Recharts, Zod; backend: Express + Zod on Node/TS (tsx), vitest + supertest.

## Sections

1. **Overview** — top 10 by Vamos Fit Score, sector coverage, policy exceptions awaiting review, pipeline stats.
2–5. **Health & Wellness / FinTech / Future of Work / Sustainability** — the four core sectors, each with its full subcategory taxonomy, filters (stage, subcategory, verified-team, search), and expandable rows showing the score breakdown and evidence.
6. **Areas of Interest** — robotics, space, general AI. Scored on a separate adjacent scale; hardware-heavy or off-thesis companies show a visible **Policy Exception** banner.
7. **Stealth Founder Radar** — operators likely building pre-announcement, from public signals only, with per-signal sources and a confidence meter.
8. **Outreach Pipeline** — two tabs: an **Outreach tracker** (server-backed: HubSpot status + record links, 12 outreach statuses, draft/sent/follow-up/response dates, meeting status, source quality, policy exceptions, and filters for owner/vertical/stage/HubSpot status/outreach status/follow-up due/exception/fit score, plus follow-up summary cards) and the original six-stage kanban **Board** (To research → Invested), preserved unchanged.
9. **Data Sources & Refresh Settings** — integration cards (HubSpot, Outlook, AI provider) with connection status, pipeline mapping, and test actions, plus the source registry with cadence/toggle settings and the data rules.

## Vamos Fit Score (1.0–10.0)

100-point weighted model in `src/lib/scoring.ts`; every point is shown with a rationale in the UI.

| Component | Max | Notes |
|---|---|---|
| Thesis / vertical fit | 25 | Full credit for core subcategory match; adjacent areas cap at 14; exception subcategories (DeFi/blockchain) cap at 15 |
| Stage fit | 20 | Seed strongest (20), Pre-seed 16, Series A 12 |
| Mission alignment | 20 | Verified underrepresented founding team — **verified/self-identified only** |
| Traction signal | 15 | Analyst 0–10 rating with written justification |
| Geography | 10 | Preferred states NM, NY, NJ, OR, CA, TX, IL; partial credit elsewhere |
| Evidence quality | 10 | Breadth plus primary-source (filings, founder statements) weighting |

**Policy exceptions flag, never reject.** DeFi/blockchain, hardware-heavy, and outside-thesis companies keep their score and carry a visible warning routed to partner review.

## Data rules (enforced by Zod in `src/data/loader.ts`)

- **Demographic indicators are verified or absent.** Latino-led / female-led / other indicators require a self-identification basis (`Self-identified` or `Verified public statement`) plus a named source, or the record fails validation. Nothing is ever inferred from names, photos, or geography; "not on record" is displayed as exactly that.
- **Every company needs at least one sourced evidence item** — recommendations stay auditable.
- **Public sources only** for stealth signals; **no automated outreach** — the pipeline tracks contact, people make it.

## Going live

Point `loadCompanies()` / `loadStealthFounders()` at Supabase (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `.env`) and keep the existing schemas as the validation gate; swap the pipeline store's localStorage layer for a shared table. Scoring weights are isolated from the UI and tunable in one file.

---

# Integrations: HubSpot · Outlook · AI outreach

## Architecture

```
React frontend (no secrets, no tokens — ever)
   │  /api/* (Vite dev proxy → Express)
   ▼
Express backend (server/) — owns ALL credentials via .env
   ├─ HubSpot API        (crm objects, search, pipelines, notes)
   ├─ Microsoft Graph    (OAuth code flow → Outlook DRAFTS only)
   ├─ AI provider        (Anthropic | OpenAI | deterministic template)
   └─ Dev datastore      (server/.data/dev-store.json; swap for a DB)
```

Shared Zod schemas in `shared/integrations.ts` validate payloads on both sides of the wire. The frontend never stores tokens in localStorage; OAuth tokens are encrypted (AES-256-GCM, key derived from `SESSION_SECRET`) at rest on the backend.

**Automatic email sending is intentionally disabled.** The only mail action in the entire codebase is *Save to Outlook Drafts*. Sending happens manually, from Outlook, by a person — who then marks the outreach as sent in the tracker.

## Human-review workflow (enforced, not suggested)

Company surfaced → team reviews evidence → **editable review modal** → duplicate check (update / create-new / cancel) → company + founder contacts + deal created and associated in HubSpot → outreach generation reviewed → AI draft (facts only, fact-guard validated) → **user edits** → *Save to Outlook Drafts* → user sends manually from Outlook → user marks sent → follow-up date set. Follow-up emails are only ever new drafts through the same review flow.

## Mock Mode vs Live Mode

| | Mock (default) | Live |
|---|---|---|
| Trigger | no credentials, or `INTEGRATION_MODE=mock` | `INTEGRATION_MODE=auto` + per-integration credentials |
| HubSpot | simulated locally, records in dev datastore, labeled **Demo Mode**, no fake links | real API, portal deep links, friendly auth errors |
| Outlook | simulated connection + drafts, labeled | real OAuth sign-in, drafts in your mailbox, `Open in Outlook` links |
| AI | deterministic template from verified facts | Anthropic/OpenAI, same fact-validation gate |

Integrations go live independently — HubSpot can be live while Outlook stays in Demo Mode. Demo Mode never claims a real external action occurred.

## HubSpot setup (Live)

Two auth options — either enables Live Mode:

**A. Private app:** create one in HubSpot (Settings → Integrations → Private apps) with scopes `crm.objects.companies`, `crm.objects.contacts`, `crm.objects.deals` (read+write) and `crm.objects.notes` write. Put the token in `HUBSPOT_ACCESS_TOKEN`; set `HUBSPOT_PORTAL_ID` for record deep links.

**B. OAuth app:** create a HubSpot app, set its redirect URL to `HUBSPOT_REDIRECT_URI` (default `http://localhost:8787/api/hubspot/callback`), fill `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_REDIRECT_URI`, then click **Connect (OAuth)** on the HubSpot card. State is validated server-side, tokens are encrypted at rest, and short-lived HubSpot access tokens refresh automatically. **Disconnect** removes them.

The HubSpot card also provides a verified **Test connection** (a real API call — the UI never shows Connected without one succeeding), **search** across HubSpot companies/contacts with open-in-portal links, and a **sync history** view from the audit log.
3. **Recommended custom properties** (created once in HubSpot; the app writes them):
   - Companies: `vamos_vertical`, `vamos_subcategory`, `vamos_stage`, `vamos_accelerator`, `vamos_funding_raised`, `vamos_date_first_surfaced`, `vamos_last_refresh`, `vamos_primary_source`, `vamos_policy_exception`, `vamos_deal_radar_id`, `vamos_deal_radar_url`
   - Contacts: `vamos_info_source`, `vamos_verification_status`, `vamos_relationship_owner`, `vamos_last_outreach_date`, `vamos_verified_demographics`, `linkedin_url`
   - Deals: `vamos_fit_score`, `vamos_recommendation`, `vamos_vertical`, `vamos_stage`, `vamos_score_breakdown`, `vamos_rationale`, `vamos_risks`, `vamos_evidence_quality`, `vamos_policy_exception`, `vamos_sourcing_status`, `vamos_date_surfaced`, `vamos_next_action`, `vamos_relationship_owner`, `vamos_deal_radar_id`, `vamos_deal_radar_url`
4. **Pipeline mapping**: Data Sources → HubSpot card → *Pipeline mapping*. Load your portal's deal pipelines and map each Deal Radar status (Surfaced, Needs Review, Approved to Track, Outreach Approved, Outreach Drafted, Founder Contacted, Meeting Scheduled, Active Diligence, Monitor, Passed) to an existing HubSpot stage ID. **Live submissions are blocked with instructions until mapped — the app never guesses stage IDs.**

Demographic contact data is written only when it carries a stated basis, a named source, a source URL/identifier, and a verification status (enforced by Zod on every request; unsupported claims are rejected with a 400 and nothing is written). Nothing is ever inferred.

## Microsoft Entra / Outlook setup (Live)

1. Entra admin center → App registrations → New. Single- or multi-tenant.
2. Add a **Web** redirect URI exactly matching `MICROSOFT_REDIRECT_URI` (default `http://localhost:8787/api/outlook/callback`).
3. Create a client secret → `MICROSOFT_CLIENT_SECRET`; copy the application id → `MICROSOFT_CLIENT_ID`; tenant id (or `common`) → `MICROSOFT_TENANT_ID`.
4. Delegated Graph permissions: `Mail.ReadWrite` (drafts), `User.Read`, `offline_access` (refresh tokens). **No send permission is requested.**
5. Set a strong `SESSION_SECRET` (≥16 chars) — it encrypts tokens at rest.
6. Data Sources → Outlook card → *Connect Outlook* → Microsoft sign-in → redirected back with the account shown. OAuth `state` is validated server-side (10-minute expiry); expired access tokens refresh transparently; a missing refresh token produces a clear "reconnect" error.

## AI provider setup (Live)

`AI_PROVIDER=anthropic` (or `openai`) + `AI_API_KEY` (+ optional `AI_MODEL`). Regardless of provider, output passes a fact guard that rejects invented funding amounts, accelerators, traction/customer/revenue claims, and statistics not present in the supplied context. Missing evidence produces honest general wording plus a visible weak-evidence warning — never fabricated personalization.

## API (all under `/api`, JSON, rate-limited, CORS-restricted)

`GET /integrations/status` · `GET /audit` · `POST /hubspot/check-duplicate` · `GET /hubspot/pipelines` · `GET|PUT /hubspot/pipeline-mapping` · `POST /hubspot/company|contact|deal|sync-company|log-activity` · `GET /outlook/status` · `POST /outlook/connect|disconnect` · `GET /outlook/callback` · `POST /outlook/drafts` · `POST /outreach/generate|regenerate|upsert|status|mark-sent|follow-up|meeting` · `GET /outreach/records`

Mutating routes accept an `Idempotency-Key` header (the frontend always sends one); a repeated key within 2 minutes returns `409 duplicate_submission`, so a double-clicked button can't create two records or two drafts.

## Security notes

Backend-only secrets · Zod-validated environment on boot · Zod input+output validation on every route · OAuth state validation · AES-256-GCM token encryption with expiry/refresh handling · sanitized user-friendly errors (401/409/422 with hints) · request logging limited to method/path/status/duration (never bodies, tokens, or email content) · audit log (`GET /api/audit`, capped at 500 entries, no secrets or bodies) · rate limiting (300/min API, 30/min generation) · CORS restricted to the frontend origin · confirmation modals in front of every external action.

## Testing

`npm test` — 46 tests across 5 suites: duplicate detection (domain-first, name fallback, normalization), company/contact/deal payload builders, identity-guardrail rejection (HTTP + schema level), policy-exception preservation, pipeline-stage mapping (including live-mode blocked-without-mapping), Outlook draft payload + missing-recipient validation, failed-auth + expired-token + forged-OAuth-state handling, generation determinism/tones/weak-evidence/missing-source honesty, fact-guard rejection of invented facts, Mock Mode labeling, duplicate-submission protection, and the full 12-step workflow over HTTP (supertest).

## Production deployment

1. Host the Express app (`server/index.ts` via `tsx` or compile with `tsc`) behind HTTPS; set `APP_BASE_URL`, `FRONTEND_URL`, and all live credentials as platform secrets.
2. Serve `dist/` (from `npm run build`) from any static host; route `/api/*` to the backend (or serve `dist` from Express).
3. Replace the JSON dev datastore (`server/lib/store.ts`) with Postgres/Supabase — the store shape is the table plan; keep `DATA_FILE` unset.
4. Update the Entra redirect URI to the production callback URL.

## Phase 3: refresh system, connectors, analysis

- **Global status indicator** (sidebar): HubSpot / Outlook / AI provider / Data refresh, using `Connected` (only after a real verified call), `Disconnected`, `Configuration required`, `Expired`, `Error`, or `Local Mode`. Verification results are cached for 5 minutes.
- **Refresh connectors** (Data Sources): nine functional cards — HubSpot, Outlook, AI provider, Local CSV, Local portfolio file, Public company websites, Y Combinator directory, GitHub public API, SEC public data. Each supports enable/disable, run sync, last sync time, records imported, credential requirements, setup instructions, and last error. LinkedIn/PitchBook/Crunchbase are intentionally absent: no scraping of restricted services.
- **Refresh runs are manual-only.** There is no background scheduler; per-connector Weekly/Biweekly schedules are stored as configuration only. Scope controls: vertical, stale-only, and a max-records/API-calls cap (protects rate limits and AI token budgets). Runs can be cancelled between connectors; one failing connector never discards the others' results. The log (last 50 runs) labels every connector result `live`, `local`, `simulated`, or `failed` — Local Mode work is never labeled live.
- **Local CSV import** (`POST /api/companies/import-csv`): rows validate through the same guardrails as bundled data (sourced evidence required); demographic/identity columns are refused outright (422) — those fields require verified sources and never come from bulk files. Row-level rejection reports; re-imports upsert instead of duplicating; imported companies merge into every page, filter, score, and outreach flow.
- **Local portfolio file** (`PUT /api/portfolio`): JSON array of `{name, vertical, stage, status}` powering portfolio comparison.
- **AI analysis** (`POST /api/ai/explain-fit`, `POST /api/ai/compare-portfolio`): structured JSON, Zod-validated, built only from the audited score components and exceptions; 24-hour cache (labeled `cached`), one retry on transient errors, 10s timeouts, token cap. Without a key, deterministic local templates answer and are labeled `Local template — no AI model used`. Output is advisory text — it approves or rejects nothing.
- **Outlook draft-status sync** (`POST /api/outlook/sync-status`): an explicit "Check Outlook status" action on tracker rows asks Graph whether a draft this app created was sent; sent status is only ever set from that confirmation or manual marking. Local Mode reports drafts as honestly unsent.
- New routes: `/api/hubspot/connect|callback|disconnect|verify|search`, `/api/ai/explain-fit|compare-portfolio`, `/api/refresh/connectors|run|cancel|log`, `/api/companies/import-csv|imported|imported/clear`, `/api/portfolio`.

## Phase 4: live deal discovery & stealth founder radar

- **Deal Discovery page** (`/discovery`): configure vertical/subcategory/terms/geography (Preferred states NM NY NJ OR CA TX IL, United States, LATAM), stages (Pre-seed/Seed/Series A), date range, authorized sources, budgets (max results / API calls / model calls / estimated tokens), min confidence, and new-only/stale-only/all mode. Shows a labeled rough cost estimate before running.
- **Authorized sources only**: YC public directory, accelerator sites, company websites, funding announcements, SEC EDGAR, GitHub public API, grants, patents, research publications, hackathon sites, Product Hunt (authorized token only — otherwise skipped), state registries, uploads, and licensed exports. Requests naming LinkedIn, PitchBook, or Crunchbase are rejected with 422 — those services are never scraped. YC/GitHub/SEC have live adapters; the rest return clearly-labeled simulated fixtures until per-source adapters are configured.
- **Pipeline**: run → normalize → Zod-validate (invalid records counted, never imported) → duplicate detection (exact by domain, likely by normalized name, against bundled + imported + prior candidates) → human preview with evidence drawer and side-by-side duplicate comparison → **selective import**. Imports land in `Needs Review` with an outreach record in `Not Reviewed`; duplicates can be skipped, imported anyway, or have their evidence **merged (append-only — conflicting claims stay visible)**. Unknown fields stay `Unknown`; candidates with Unknown verticals are refused at import rather than guessed. Nothing is ever auto-approved, auto-rejected, auto-synced, or auto-contacted.
- **Run history**: every run logs type, mode (live/local/simulated/mixed), query, per-source results, discovered/updated/dup-skipped/rejected/imported counts, errors, API calls, model calls, estimated tokens and cost, duration, status (Completed / Completed with warnings / Cancelled / Failed / Simulated), and initiator.
- **Stealth Founder Radar** (`/stealth`): server-backed signal feed ranked by confidence, research queue, manual signal entry (a pasted public-profile URL is stored as evidence, never crawled), owner assignment, outreach-status tracking, and a "Generate outreach draft" action that opens the standard human-approval outreach flow. Hypotheses are deterministic, built only from recorded signal fields, permanently labeled **Hypothesis · Unverified · Requires human review**, and always include supporting/contradictory evidence, at least one alternative, and missing information. No sensitive-trait inference — names, photos, schools, locations, languages, and networks are structurally excluded from hypothesis inputs. The Phase 1 bundled watchlist remains as a tab.
- **Vamos Fit rebalance**: new Founder signal component (max 10) — 2–5 founders ideal, solo or >5 founders score lower but are **never rejected**; prior founding, relevant recorded background, and accelerator participation add points, all cited from recorded data only. Traction is now /10 and evidence quality /5; totals remain /100. Identity remains a separate, verified-only component and never gates anything automatically.
- **Ranking** (Overview): top-10 default, 8.0+ toggle, filters for vertical, stage, state, founder verification (verified Latino / verified female / any verified underrepresented / unknown / requires manual review), freshness, discovery source, policy exception, and new-vs-reviewed. "Verified Latino founders first" is a sort, never a score change; unknown/unverified records move to a visible research-queue section instead of being hidden or deleted.
- **Portfolio layer** (Data Sources): list, manual creation, and CSV import with per-row validation and upsert-by-name; fields include website, themes, public description, investment date (public only), evidence URLs, partnership themes, and competitive-overlap themes. Portfolio comparison reports shared themes, partnership opportunities, concentration risk, theme expansion, confidence, and evidence notes — computed only from recorded data, with honest "not guessed" messaging when fields are empty. Phase 3 portfolio files still parse unchanged.
- **Scheduled sourcing** (`RUN_SCHEDULER`, default `false`): weekly/biweekly jobs are storable as configuration and clearly shown as **Configured but inactive** until the backend runs persistently with `RUN_SCHEDULER=true`. When active, the hourly due-checker runs jobs through the same discovery pipeline with duplicate-run locking and one retry — scheduled runs also never contact founders, send email, approve/reject deals, or change HubSpot stages.
- New routes: `/api/discovery/sources|estimate|run|cancel|candidates|import|runs`, `/api/stealth/signals`, `/api/stealth/signals/:id`, `/api/stealth/signals/:id/hypothesis`, `/api/schedule`, `/api/portfolio` (GET), `/api/portfolio/company`, `/api/portfolio/import-csv`.

## Known limitations

- The dev datastore is a single JSON file — fine for one reviewer, not for concurrent team use (swap for a DB before shared deployment).
- Live HubSpot/Outlook/AI paths are implemented and unit-tested for error handling, but **have not been exercised against real external services** (no credentials were provided in this environment). Demo Mode is fully tested.
- Replies are tracked manually (`Replied` status / last-response date); the draft-status sync confirms *sent*, not *replied* — automatic reply detection would need `Mail.Read` and a polling job, intentionally out of scope.
- The YC/SEC/website connectors perform real reachability checks but import 0 records for the bundled dataset (fictional companies have no real filings, directory entries, or reachable domains) and report that honestly. The GitHub connector needs per-company org mappings before it can collect repo signals.
- Discovery live adapters: GitHub works unauthenticated; the YC directory adapter targets the public API but is unreachable from this sandbox; SEC EDGAR verifies reachability while Form D parsing into candidates is a follow-up (0 imported, honestly labeled). Accelerators/funding-news/grants/patents/research/hackathons/registries return labeled simulated fixtures until per-source adapters are configured.
- Scheduled execution requires a continuously hosted backend; in serverless or on-demand hosting keep RUN_SCHEDULER=false and run sourcing manually.
- HubSpot custom properties must exist in the portal before live sync (see the recommended list above).
- "Sent" status is manual by design; confirming sent status from Microsoft would require additional permissions and explicit user action.
