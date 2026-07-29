# IMPLEMENTATION_STATUS

Audit date: 2026-07-17. Everything below was verified directly from the repository
(code read, tests/lint/build executed) — not taken from prior chat claims or the README.

> **Phase 2 (reorganize + demo-data removal) was completed on 2026-07-17 — see the
> "PHASE 2 COMPLETED" section at the end of this file.** Sections 1–10 below describe
> the codebase as it was at audit time; where they conflict, the Phase 2 section wins.

---

## 1. Current architecture

**Stack (verified from `package.json` and configs):**

| Layer | Technology |
|---|---|
| Frontend | Vite 8, React 19, TypeScript ~6.0, Tailwind CSS v4 (`@tailwindcss/vite`), React Router 7, Recharts 3 |
| Backend | Express 5 on Node via `tsx` (no compile step in dev), Zod 4, express-rate-limit, cors |
| Shared | `shared/integrations.ts` + `shared/discovery.ts` — Zod schemas validated on both sides of the wire |
| Persistence | Single JSON file `server/.data/dev-store.json` (gitignored); `DATA_FILE=':memory:'` in tests; kanban board in browser `localStorage` |
| Tests | vitest 4 + supertest (94 tests, 7 suites, all passing) |
| Lint | oxlint (3 fast-refresh warnings, no errors) |

**Folder structure (actual):**

```
server/
  index.ts            entry (app.listen + startScheduler no-op)
  app.ts              ALL ~50 API routes in one 829-line factory
  env.ts              Zod-validated env + mode resolution (mock vs live)
  lib/                store.ts (JSON dev store), guard.ts (audit/idempotency/logging),
                      crypto.ts (AES-256-GCM), http.ts (fetch retry/timeout)
  services/           hubspot, outlook, ai (email gen), analysis (fit/portfolio AI),
                      refresh (9 connectors), sources (discovery adapters), discovery,
                      stealth, schedule, imports, records
  tests/              7 vitest suites
shared/               integrations.ts (410 ln), discovery.ts — cross-tier Zod schemas
src/
  App.tsx             router + sidebar (10 nav routes)
  pages/              Overview, Vertical (x5 routes), Discovery, StealthRadar,
                      Outreach, DataSources
  components/         CompanyTable, Ranking, HubSpotModal, OutreachPanel, Connectors,
                      Schedule, IntegrationCards, Portfolio, Modal, AiAnalysis, ui
  store/              React contexts: companies.tsx, pipeline.tsx (localStorage kanban),
                      integrations.tsx
  lib/                api.ts (typed fetch client), scoring.ts (Vamos Fit model), crm.ts
                      (Company → HubSpot payload mapping)
  data/               companies.ts, enrichment.ts, stealth.ts (ALL FICTIONAL),
                      taxonomy.ts, loader.ts (Zod gate)
scripts/              smoke.ts (data/scoring invariants), guardrail.ts (identity rejection)
```

**State management:** three React context providers (`CompaniesProvider`,
`PipelineProvider`, `IntegrationsProvider`). No Redux/Zustand. Companies = bundled
sample data + server-imported rows merged in `src/store/companies.tsx`. The kanban
pipeline persists to `localStorage` key `vamos-deal-radar:pipeline:v1`.

**Server routes (verified in `server/app.ts`):**
`GET /api/integrations/status`, `GET /api/audit`;
HubSpot: `check-duplicate`, `pipelines`, `pipeline-mapping` (GET/PUT), `connect`,
`callback`, `disconnect`, `verify`, `search`, `company`, `sync-company`, `contact`,
`deal`, `log-activity`;
Outlook: `status`, `connect`, `callback`, `disconnect`, `drafts`, `sync-status`;
AI: `explain-fit`, `compare-portfolio`;
Refresh: `connectors`, `connectors/:id/enabled`, `run`, `cancel`, `log`;
Discovery: `sources`, `estimate`, `run`, `cancel`, `candidates`, `import`, `runs`;
Stealth: `signals` (GET/POST), `signals/:id` (POST), `signals/:id/hypothesis`;
Schedule: GET/POST `/api/schedule`, DELETE `/api/schedule/:id`;
Portfolio: GET `/api/portfolio`, PUT `/api/portfolio`, `portfolio/company`,
`portfolio/import-csv`;
Imports: `companies/import-csv`, `companies/imported`, `companies/imported/clear`;
Outreach: `generate`, `regenerate`, `records`, `upsert`, `status`, `mark-sent`,
`follow-up`, `meeting`.
(A duplicate `GET /api/portfolio` registration was removed during this audit.)

---

## 2. Fake-data locations

There is **no `Math.random()` anywhere in source** and no invented dashboard numbers —
all Overview stats are computed from the (fictional) dataset. The fake data lives in:

| Location | Contents |
|---|---|
| `src/data/companies.ts` | **27 fictional companies** (SolCare Health, NeuroLista, Cuadrilla, …) with fictional founders, evidence URLs all pointing at `example.com` |
| `src/data/enrichment.ts` | Fictional websites (`*.example.com`) and founder emails merged in by the loader |
| `src/data/stealth.ts` | **8 fictional stealth founders** (Natalia Vega, Javier Morales, …) with fictional signals |
| `src/store/pipeline.tsx` | `SEED` — 6 hardcoded kanban items referencing the fictional companies, persisted to localStorage |
| `server/services/sources.ts` | `SIM` fixtures — 5 fictional discovery candidates (Cosecha Labs, Verdea Grid, Anda Care, Solar Cocina, Turno HQ), each labeled "(fictional)" and "Local Mode fixture" |
| `server/services/stealth.ts` | `SEEDED` — 2 simulated stealth signals (J. Almeida, S. Quintero) auto-inserted into the store when it's empty, flagged `simulated: true` |
| `server/.data/dev-store.json` | Accumulated demo state on this machine: 2 outreach records, 2 seeded stealth signals, 9 connector states, audit entries (gitignored) |
| Mock service classes | `MockHubSpot` (hubspot.ts), `MockOutlook` (outlook.ts), `TemplateGenerator` (ai.ts) — all label output "Demo Mode" |
| `src/pages/Overview.tsx` | Hardcoded MVP-deadline countdown to `2026-07-24` |

Honesty is good throughout: fictional records are labeled fictional, mock results say
"simulated", and demo mode never fabricates HubSpot/Outlook links.

---

## 3. Integration status

`.env` is **byte-identical to `.env.example`**: `INTEGRATION_MODE=mock`, zero
credentials. Everything currently runs in Demo Mode.

| Integration | Code status | Live-verified? |
|---|---|---|
| **HubSpot** (`server/services/hubspot.ts`) | Complete live client: private-app token or OAuth (state validation, AES-256-GCM token storage, auto-refresh), duplicate check, pipelines, company/contact/deal sync + associations, notes, search | **Never run against a real portal** (no credentials ever supplied) |
| **Outlook** (`server/services/outlook.ts`) | Complete Graph client: OAuth code flow, token refresh, drafts-only (no send path exists — verified), draft sent-status check | **Never run against a real tenant** |
| **AI provider** (`server/services/ai.ts`, `analysis.ts`) | Anthropic + OpenAI clients with fact-guard output validation, 24h cache, deterministic fallback templates. Default Anthropic model is hardcoded `claude-sonnet-4-6` (outdated) | **Never run with a real key** |
| **GitHub** (`sources.ts`, `refresh.ts`) | Live, unauthenticated: repo search (discovery) + rate-limit reachability (refresh). Org-owned repos only; 0 records for sample data (no org mappings) | Real API, weak signal only |
| **Y Combinator** | Live adapter targets `api.ycombinator.com/v0.1/companies` (unofficial endpoint; README notes it was unreachable from the dev sandbox) | Unconfirmed endpoint |
| **SEC EDGAR** | Reachability check only; **Form D parsing not implemented** → always 0 candidates (honestly labeled) | Partial |
| 9 other discovery sources | `accelerators`, `funding-news`, `grants`, `patents`, `research`, `hackathons`, `registries` return simulated fixtures or empty; `producthunt`/`licensed` skip without credentials | Simulated |
| **Scheduler** (`schedule.ts`) | Jobs stored as config; execution gated behind `RUN_SCHEDULER=true` (default false) | Inactive |

**Environment variables** (validated in `server/env.ts`): `PORT`, `APP_BASE_URL`,
`FRONTEND_URL`, `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID`, `HUBSPOT_CLIENT_ID/SECRET/REDIRECT_URI`,
`MICROSOFT_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI`, `AI_PROVIDER`, `AI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `RUN_SCHEDULER`, `INTEGRATION_MODE`,
`SESSION_SECRET`, `DATA_FILE`. Frontend uses none (`VITE_SUPABASE_*` is mentioned in the
README but referenced nowhere in code).

---

## 4. Database status

**There is no database.** Persistence is:

1. `server/.data/dev-store.json` — one JSON file, debounced 50 ms full-file rewrite,
   best-effort (write errors swallowed). Holds mock CRM objects, outreach records,
   drafts, follow-ups, pipeline mapping, encrypted OAuth tokens, audit log, AI cache,
   connector state, refresh/discovery run logs, candidates, stealth signals, portfolio,
   scheduled jobs, imported companies. Not safe for concurrent users.
2. Browser `localStorage` — the kanban board only.
3. Bundled TypeScript modules — the 27 sample companies + 8 stealth founders
   (read-only, re-validated by Zod on every load).

The store shape in `server/lib/store.ts` is a reasonable table plan for a real DB
(Postgres/Supabase), but no migration path, ORM, or connection code exists.

---

## 5. Recommended new folder structure

The current layout is mostly sound; the problem is a few god-files, not the tree.
Recommended target:

```
server/
  index.ts
  app.ts                     ← slim: middleware + router mounting only
  routes/                    ← NEW: split app.ts by domain
    status.ts  hubspot.ts  outlook.ts  outreach.ts  ai.ts
    refresh.ts  discovery.ts  stealth.ts  schedule.ts  portfolio.ts  imports.ts
  services/                  (as-is; split hubspot.ts → hubspot/{mock,live,auth,payloads}.ts)
  db/                        ← NEW: real persistence layer replacing lib/store.ts
    schema.sql / migrations/  client.ts  repositories/
  lib/
shared/                      (as-is)
src/
  pages/                     (split Discovery.tsx and Outreach.tsx into page + subcomponents)
  components/
    datasources/             ← IntegrationCards.tsx (483 ln) → one file per card
  store/  lib/  data/
    data/fixtures/           ← move fictional datasets here, loaded ONLY in demo mode
```

**Oversized files to divide:** `server/app.ts` (829 → routers),
`server/services/hubspot.ts` (612 → auth/payloads/mock/live), `src/pages/Discovery.tsx`
(515), `src/components/IntegrationCards.tsx` (483), `src/pages/Outreach.tsx` (478),
`src/data/companies.ts` (625 — fine as data, but should move behind a demo-mode flag).

---

## 6. Features to remove

1. **The localStorage kanban board** (`src/store/pipeline.tsx` + the "Board" tab in
   `src/pages/Outreach.tsx`). It duplicates the server-backed outreach tracker with a
   different, unsynchronized stage model, is seeded with fake items, and is invisible to
   teammates. Keep the tracker; retire the board.
2. **Duplicate portfolio write paths**: Phase 3 `PUT /api/portfolio` (`savePortfolio`)
   vs Phase 4 `POST /api/portfolio/company` + `POST /api/portfolio/import-csv`.
   Consolidate on the Phase 4 shape.
3. **Bundled fictional datasets as the default view** (`src/data/companies.ts`,
   `enrichment.ts`, `stealth.ts`, kanban `SEED`, `SIM`/`SEEDED` server fixtures). Don't
   delete — demote to explicit demo-mode fixtures the UI loads only when the backend
   reports mock mode, so a live deployment starts empty and honest.
4. **Simulated discovery fixtures** for sources that will get real adapters — replace,
   don't accumulate.
5. **`void modes;` re-export hack** at the bottom of `server/services/hubspot.ts`.
6. **MVP-deadline countdown** in `Overview.tsx` (hardcoded 2026-07-24, expires in 7 days).

## 7. Features to retain

- **Scoring engine** (`src/lib/scoring.ts`) — deterministic, auditable, unit-tested,
  isolated from the UI. Keep as-is.
- **Data guardrails** — Zod loader rules (verified-only demographics, evidence-required),
  identity-column refusal on CSV import, fact-guard on AI output, restricted-source
  (LinkedIn/PitchBook/Crunchbase) 422s. These are the product's differentiator.
- **HubSpot and Outlook live clients** — well-built (OAuth state, encrypted tokens,
  refresh, dedupe, association wiring); they need real-credential exercise, not rewrite.
- **Human-in-the-loop workflow** — drafts-only mail, duplicate-resolution modal,
  selective discovery import, no auto-anything. Preserve through any refactor.
- **Mock/live mode split per integration**, idempotency keys, audit log, rate limits.
- **Server-backed outreach tracker, discovery pipeline, stealth signal feed, refresh
  connectors, run history** — the real product surface.
- **Test suite** (94 tests incl. full HTTP workflow) and `scripts/smoke.ts` /
  `scripts/guardrail.ts` invariant checks.

---

## 8. Major technical risks

1. **JSON-file store** — no concurrency safety, debounced best-effort writes can lose
   data on crash, whole-file rewrite. Blocks any multi-user deployment. Biggest single
   risk; everything Phase-worthy depends on the DB swap.
2. **Live integrations are untested against real services.** HubSpot custom properties
   must pre-exist in the portal or writes fail; Graph consent/tenant policies untested;
   the YC endpoint is unofficial and may not exist as coded.
3. **AI default model is stale** (`claude-sonnet-4-6` hardcoded) and JSON is extracted
   from free text (`JSON.parse` after stripping code fences) — brittle vs structured output.
4. **Demo data can masquerade as product data**: the UI always shows the 27 fictional
   companies, even if live integrations are on. Fictional and real rows would silently mix.
5. **Frontend bundle is 853 kB** (single chunk, Recharts inlined) — build warns; no code
   splitting.
6. **`server/app.ts` monolith** — every route change touches one 829-line file; the
   in-memory `verifyCache`/rate-limit state also won't survive multi-instance hosting.
7. **Kanban vs tracker divergence** — two pipelines with different stage vocabularies can
   contradict each other today.
8. **Secrets hygiene**: `.env` is gitignored and currently credential-free, but tokens at
   rest depend entirely on `SESSION_SECRET` strength; ephemeral key fallback means a
   restart orphans any tokens saved without it.

## 9. Recommended phase order

1. **Phase A — Foundation:** split `server/app.ts` into routers; replace the JSON store
   with a real DB (Supabase/Postgres) behind repository functions keeping the current
   store shape; keep `:memory:` test mode.
2. **Phase B — Demo/live separation:** gate all fictional datasets (frontend bundles,
   server fixtures, kanban seed) behind demo mode; make a live deployment start empty;
   remove the kanban board in favor of the tracker.
3. **Phase C — Prove one integration live end-to-end (HubSpot):** real portal, create the
   custom properties (or a bootstrap script), exercise sync/dedupe/pipeline mapping,
   fix what breaks.
4. **Phase D — Outlook + AI live:** real Entra app, draft flow verified in a mailbox;
   update AI defaults to current models and switch to structured JSON output.
5. **Phase E — Real discovery:** implement SEC Form D parsing, verify/replace the YC
   adapter, add one or two real adapters where fixtures sit today; GitHub org mappings.
6. **Phase F — Polish & scale:** code-split the bundle, split oversized pages/components,
   scheduler hosting decision, multi-user auth (currently there is **no authentication
   on the API at all** — required before any shared deployment).

## 10. Exact commands (all verified working on 2026-07-17)

```bash
npm test              # vitest run — 7 files, 94 tests, all passing (~1 s)
npm run lint          # oxlint — 0 errors, 3 react fast-refresh warnings
npx tsc -b            # type-check all three tsconfig projects (app/node/server)
npm run build         # tsc -b && vite build — passes; warns: 853 kB chunk
npm run dev           # web (5173) + API (8787) via concurrently
npm run dev:web       # frontend only
npm run dev:server    # backend only (tsx watch)
npm run preview       # serve production build
npm run smoke         # tsx scripts/smoke.ts — data + scoring invariants
npx tsx scripts/guardrail.ts   # unverified-demographics rejection check
```

There is no standalone `typecheck` script in package.json (`npx tsc -b` fills that role),
and no frontend component tests — all 94 tests are backend/integration.

---

# PHASE 2 COMPLETED — Reorganization & demo-data removal (2026-07-17)

All work below verified by: `npm test` (8 files, 100 tests passing), `npm run lint`
(0 errors, 3 pre-existing fast-refresh warnings), `npm run typecheck`, `npm run build`
(passing), and a live boot with zero credentials (`tsx server/index.ts` → status endpoint
reports every integration "not connected", `/api/stealth/signals` and
`/api/companies/imported` return empty, HubSpot/Outlook actions return
`503 not_connected` with setup hints).

## 1. Files moved

| From | To | Why |
|---|---|---|
| `server/app.ts` routes (829 lines, ~50 routes) | `server/routes/{status,hubspot,outlook,ai,outreach,refresh,discovery,stealth,schedule,portfolio,imports,helpers}.ts` | One router per domain; `app.ts` is now ~90 lines of middleware + mounting + error handler |
| `MockHubSpot` class (was in `server/services/hubspot.ts`) | `server/tests/mocks/hubspot.ts` | Test fixture only — production has no mock CRM |
| `MockOutlook` class (was in `server/services/outlook.ts`) | `server/tests/mocks/outlook.ts` | Test fixture only — production has no mock mailbox |
| `SIM` discovery fixtures (were in `server/services/sources.ts`) | `server/tests/fixtures/sources.ts` | Injected via a test-only hook; the app never simulates sources |
| `scripts/smoke.ts` scoring invariants | `server/tests/scoring.test.ts` | Ran against the deleted bundled dataset; now uses in-test fixtures |

New test plumbing: `server/tests/mocks/install.ts` (install/uninstall helpers + a full
test pipeline mapping) and test-only injection hooks `__setHubSpotServiceForTests`,
`__setOutlookServiceForTests`, `__setSourceRunnerForTests`, `resetVerifyCacheForTests`.

## 2. Files removed

- `src/data/companies.ts` — 27 fictional companies
- `src/data/enrichment.ts` — fictional websites/founder emails
- `src/data/stealth.ts` — 8 fictional stealth founders (the "Sample watchlist")
- `src/data/loader.ts` — loader/validator for the deleted bundled data
- `scripts/smoke.ts`, `scripts/guardrail.ts` (+ `scripts/` dir) — validated bundled data; replaced by tests
- `server/.data/dev-store.json` — local dev store containing demo-era artifacts (seeded signals, demo outreach records); regenerates empty
- `PHASE4_STATUS.md` — stale status doc superseded by this file

## 3. New folder structure

```
server/
  index.ts            entry
  app.ts              middleware + router mounting + error handler only
  routes/             status, hubspot, outlook, ai, outreach, refresh,
                      discovery, stealth, schedule, portfolio, imports, helpers
  services/           live clients + business logic (no mock classes)
  lib/                store, guard, crypto, http
  tests/
    *.test.ts         8 suites, 100 tests
    mocks/            in-memory HubSpot/Outlook fixtures + install helpers (tests only)
    fixtures/         fictional discovery candidates (tests only)
shared/               cross-tier Zod schemas
src/
  pages/  components/  store/  lib/
  data/taxonomy.ts    real sector taxonomy (only file left in src/data)
```

## 4. Demo logic removed

- **`INTEGRATION_MODE` deleted** from `server/env.ts`, `.env`, `.env.example`, and
  `vitest.config.ts`. An integration is live iff its credentials exist; otherwise it is
  "not connected" and actions fail with `503 not_connected` + a setup hint (new error
  code in the shared error handler).
- **Mock HubSpot/Outlook services removed from production.** `hubspotService()` throws
  an honest not-connected error; `outlookService()` returns a `DisconnectedOutlook`
  that reports "This integration is not connected" and refuses drafts.
- **Demo pipeline-stage fallback removed** — submissions are blocked (409, with
  instructions) until a real mapping exists, in every mode.
- **Simulated discovery fixtures removed** — sources without live adapters return
  0 results with "No live adapter is configured for this source — nothing was simulated."
- **Seeded stealth signals removed** — the feed starts empty; legacy `simulated:true`
  records are filtered out on read; manual entries are stored `simulated:false`.
- **Refresh runners** report unconnected integrations as `failed` ("not connected"),
  never `simulated` successes.
- **Frontend**: kanban seed rows deleted (storage key bumped to `pipeline:v2` so stale
  browser seeds are discarded; "Reset sample data" → "Clear board"); Stealth "Sample
  watchlist" tab deleted; "Bundled sample" ranking filter deleted; hardcoded MVP-deadline
  countdown deleted; "Demo Mode" badges/labels replaced with not-connected states and
  disabled buttons; HubSpot modal and Outlook save are disabled with an honest notice
  when unconnected; Overview/tables/stealth show "No … on record yet" empty states.
- **AI template generator retained deliberately**: it is not a simulation of an external
  service — it deterministically assembles drafts from verified facts, is labeled
  "Local template — no AI model", and its output passes the same fact guard. Default
  live models updated (`claude-sonnet-5`).
- Audit-log mode enum changed `mock|live` → `live|local`; status schema mode changed
  `mock|live` → `disconnected|live`.

## 5. Remaining fake-data paths

- **Automated tests only** (permitted): `server/tests/mocks/`, `server/tests/fixtures/`,
  and fixture records inside test files. They reach production code exclusively through
  `__set*ForTests` hooks that nothing in the app calls.
- The Data Sources AI card's "Test generation" button sends an explicitly labeled
  fixture context ("a test company used only to verify email generation") as a
  user-initiated diagnostic — output is labeled and never stored as a company.
- `simulated` fields/enum values remain in shared schemas and type unions for
  compatibility (and for the test fixtures); no production code path produces them.
- The `dist/` folder on disk may contain a stale pre-cleanup build; it is gitignored
  and regenerated by `npm run build`.

## 6. Errors or blockers

- None. Tests, lint, type-check, and build all pass; the zero-credential boot was
  verified end-to-end. Two pre-existing notes stand: the 820 kB frontend chunk warning
  (code-splitting is future work) and the API still has no authentication (unchanged
  scope — required before shared deployment).
- Behavior change to be aware of: with no HubSpot credentials, the "Approve & add to
  HubSpot" flow is intentionally unusable (button disabled; server would return 503).
  Previously demo mode simulated success. This is the requested honest behavior.

## Commands (all verified 2026-07-17, post-phase-2)

```bash
npm test           # vitest — 8 files, 100 tests passing
npm run lint       # oxlint — 0 errors, 3 fast-refresh warnings (pre-existing)
npm run typecheck  # tsc -b — passing
npm run build      # tsc -b && vite build — passing (820 kB chunk warning)
npm run dev        # web + API; boots empty and honest with no .env credentials
```

---

# PHASE 3 COMPLETED — Live sourcing foundation (2026-07-17)

Verified by: `npm test` (9 files, **121 tests** passing), `npm run typecheck`,
`npm run lint` (0 errors), `npm run build`, plus a **real end-to-end discovery run
against the live internet** from this machine (results below). HubSpot/Outlook were
not touched in this phase.

## Architecture — `server/sourcing/`

Responsibilities are now separate modules; `server/services/sources.ts` is a thin
compatibility façade so existing imports keep working:

| Module | Responsibility |
|---|---|
| `sourcing/types.ts` | `LeadEvidence` shared adapter output (Zod-validated: real `sourceUrl` required, unknown facts stay absent) + `SourceAdapter` / `AdapterOutcome` contracts |
| `sourcing/errors.ts` | Typed failure states (`timeout`, `rate-limited`, `http-error`, `invalid-response`, `network`, `missing-credentials`, `not-configured`) + fetch/HTTP classifiers |
| `sourcing/validate.ts` | External-response validation (per-adapter Zod schemas; malformed bodies → `invalid-response`), per-lead validation with rejected-count reporting |
| `sourcing/normalize.ts` | Evidence normalization (LeadEvidence → citable evidence row) and company normalization (name cleanup, domain derivation; leads without a company name are dropped, never guessed) |
| `sourcing/dedupe.ts` | Exact-by-domain / likely-by-name duplicate detection against imported companies + prior candidates (moved out of discovery.ts) |
| `sourcing/enrich.ts` | Cross-source merge within a run: additive evidence, Unknown fields filled only from recorded values, max confidence — conflicts stay visible |
| `sourcing/runlog.ts` | Per-source run results incl. `failureKind` (also added, optional, to the shared `discoveryRunSchema`) |
| `sourcing/index.ts` | Adapter registry + dispatcher (`runSource`), `SOURCE_META` readiness, test-only runner hook |
| `sourcing/adapters/*` | One file per source (below) |

Failure handling is uniform: a failed source contributes **zero candidates** — there
is no code path that substitutes sample records (tested).

## Live sources — truthful readiness (each probed for real on 2026-07-17)

| Source | Adapter | Access basis | Verified status today |
|---|---|---|---|
| **SEC EDGAR Form D** (`sec`) | `adapters/sec.ts` | Official public full-text-search API (efts.sec.gov); one request/run; identifies itself via `SEC_CONTACT_EMAIL` User-Agent per SEC guidance | **WORKING.** Live run returned 13 real 2025–2026 Form D filers (Equip Health, XO Health, …) with real filing-index URLs and business states. Defaults to an 18-month window (EFTS needs both date bounds) |
| **Public funding announcements** (`funding-news`) | `adapters/rss.ts` | Public RSS feeds published for syndication (default: TechCrunch venture + startups); stores headline/link/date only. Leads created **only** from headlines that literally state a funding event ("X raises $5M") — no guessing | **WORKING.** Live run extracted real funding headlines with real article URLs. FinSMEs was removed from defaults because it returns 403 to automated readers — we do not bypass anti-bot protections |
| **SBIR/STTR government awards** (`grants`) | `adapters/sbir.ts` | Official key-free public JSON API (api.www.sbir.gov) | **IMPLEMENTED; API currently throttled.** The endpoint returned 429 "not available at this time" on every probe today; the adapter reports this honestly as `rate-limited` with zero records. Schema is tolerant and validated; will work when the API accepts requests |
| **GitHub** (`github`) | `adapters/github.ts` | Official REST API, unauthenticated (optional `GITHUB_TOKEN` raises limits); org-owned repos only | **WORKING** (rate-limit probe 200). Explicitly labeled an engineering signal (confidence 0.4) — not proof a company exists |
| **Y Combinator directory** (`yc`) | `adapters/ycombinator.ts` | Public directory endpoint (api.ycombinator.com), no login | **WORKING** (probe 200, schema verified against the real response) |
| `websites` | (refresh connector) | HEAD reachability checks of recorded sites | Verification only, not discovery — unchanged |
| `accelerators`, `patents`, `research`, `hackathons`, `registries` | none | — | **NOT IMPLEMENTED** — return 0 results with `not-configured`; never simulated |
| `producthunt`, `licensed` | none | requires authorized credentials | **SKIPPED** with `missing-credentials`; never scraped |
| LinkedIn / PitchBook / Crunchbase | — | restricted | **Rejected with 422** anywhere in a request (unchanged guardrail). No claim of support |

Compliance posture: adapters use only official APIs/feeds, send identifying
User-Agents, make one request per source per run (feeds capped by the API-call
budget), treat 429/403-rate-limit responses as hard stops with no aggressive retry,
and never bypass paywalls, logins, CAPTCHAs, robots.txt, or ToS.

## Live end-to-end run (real network, 2026-07-17)

`sources: [github, sec, grants, funding-news, yc], terms: ["health"], maxResults 15, maxApiCalls 8` →
status **Completed with warnings**, 15 discovered:
`github: live, 0 found (honest zero)` · `sec: live, 13 found (real 2025–26 Form D filings)` ·
`grants: failed [rate-limited] (honest)` · `funding-news: live, real TechCrunch headlines` ·
`yc: skipped (result budget reached)`. Every stored candidate carries ≥1 real,
clickable source URL.

## Tests added (`server/tests/sourcing.test.ts`, all network stubbed)

Successful validation (GitHub/SBIR/SEC/RSS + LeadEvidence schema rejection cases) ·
empty responses reported honestly · invalid responses (schema mismatch, non-JSON,
non-RSS bodies) · timeout (aborted request) · rate limits (GitHub 403+headers, HTTP
429) · missing credentials (gated sources skipped, 401 classified) · not-configured
sources return zero with no simulation · **no-fallback guarantee** (a fully failed
run stores zero candidates and its record contains no fictional/sample content) ·
every stored candidate has a real source URL · parsing helpers (SEC display names /
filing URLs, funding-headline extraction, RSS item parsing).

## New environment variables (all optional)

`GITHUB_TOKEN` (raises GitHub rate limits), `SEC_CONTACT_EMAIL` (SEC-requested
User-Agent identification), `FUNDING_NEWS_FEEDS` (override the default public RSS
feed list). Documented in `.env.example`.

## Errors / blockers

- SBIR public API is throttled today (429 on every probe) — adapter ready, source
  honestly reports rate-limited until the API accepts requests again.
- SEC full-text search covers filings from 2001+ and matches on filing text (mostly
  company names for Form D); it is a filings feed, not a startup classifier —
  vertical/stage stay Unknown for human review, by design.

---

# PHASE 4 COMPLETED — Persistence, normalization, deduplication (2026-07-18)

Verified by: `npm test` (10 files, **135 tests** passing — includes a genuine
two-process restart test), `npm run typecheck`, `npm run lint` (0 errors),
`npm run build`, plus a real server boot → CSV import → **process kill →
restart** → the company was still there, served from disk.

## 1. Persistence layer (new primary datastore)

No production database existed (audit: single best-effort JSON file). The primary
datastore is now **SQLite via Node's built-in `node:sqlite` driver** — zero new
dependencies, transactional writes, WAL mode, survives restarts. Location:
`server/.data/deal-radar.db` (gitignored), configurable via `DATABASE_FILE`;
tests run `:memory:`.

- `server/db/client.ts` — connection factory (+ `openDatabase(path)` used by the
  restart test), `server/db/migrations.ts` — versioned, transactional, forward-only
  migrations (v1 applied).
- **Data models (real tables):** `companies` (+ `normalized_name`, `domain`, status
  active/merged), `founders`, `evidence` (append-only, URL-deduped, `added_by`
  origin), `company_external_ids`, `field_provenance`, `possible_duplicates`,
  `source_runs` + `source_run_results`, `scoring_results`, `review_decisions`,
  `hubspot_sync_history`, `integration_health`, `sourcing_config` (connector state,
  scheduled jobs, HubSpot pipeline mapping), and `kv` for remaining operational
  state (outreach tracker, drafts, encrypted tokens, audit log, pending candidates)
  — all inside the same durable database. Browser localStorage holds only the
  optional personal kanban board; no JSON files, no hardcoded records.
- Repositories: `server/db/repos/companies.ts`, `server/db/repos/operations.ts`.
  Services/routes now write through them: CSV import + discovery import persist
  companies with founders/evidence/external ids; every import stores a **scoring
  snapshot**; candidate import/merge/skip and duplicate resolutions store **review
  decisions**; HubSpot sync-company writes **sync history** and links
  `hubspot_company_id`; the status endpoint records **integration health** rows.

## 2. Normalization + deduplication service

`server/sourcing/identity.ts` — one place decides company identity:

- **Normalization:** capitalization, punctuation, whitespace collapse, corporate
  suffixes (Inc/LLC/Ltd/Corp/Co/PLC/GmbH/…), alias folding (&→and, Intl→International,
  Grp→Group, …), domain and URL canonicalization.
- **Fuzzy:** Damerau–Levenshtein; "high confidence" = distance ≤ 2, similarity ≥ 0.85,
  length ≥ 5 — so `Pacific Rim Energ` ↔ `Pacific Rim Energy` is flagged, `acme` ↔
  `acne` is not.
- **Matching priority implemented exactly as specified:** (1) exact normalized
  domain → (2) exact external-source ID (`company_external_ids`; discovery
  candidates now carry `externalId`) → (3) exact HubSpot record ID → (4) exact
  normalized name → (5) high-confidence fuzzy name → (6) founder + name-token
  evidence → (7) manual review. Tiers 1–3 are treated as the same company; tier 4
  upserts on CSV import and shows as a 'likely' duplicate in discovery; tiers 5–6
  are **possible matches only — never auto-merged**: the record imports as its own
  row plus a `possible_duplicates` review item.
- **Possible-duplicate review state:** `GET /api/duplicates` and
  `POST /api/duplicates/:id/resolve` (`not-duplicate` keeps both; `confirmed-duplicate`
  appends the newer record's evidence to the older and marks the newer `merged` —
  kept in the table, excluded from active listings). Every resolution is a recorded
  review decision.

## 3. Field provenance

`field_provenance` tracks per-field origins: **verified / user-entered / extracted /
ai-inferred / unverified / missing**, with precedence enforcement in
`applyFieldUpdate`: an automatic write never replaces a value whose origin outranks
it — specifically, **a verified value is never overwritten by an AI inference**
(tested); an explicit human override is allowed and recorded as user-entered.
Conflicting source data keeps the higher-provenance value AND preserves the
conflicting claim as visible evidence.

## 4. Tests added (`server/tests/persistence.test.ts`, 14 tests)

Persistence across restarts (two real `tsx` processes sharing one DB file — also
verified manually against the raw SQLite tables) · exact domain matching ·
normalized-name matching (suffixes/case/aliases) · fuzzy typo matching ·
**Pacific Rim Energ vs Pacific Rim Energy** (exact-suffix variant upserts; the typo
imports separately + opens a pending review item; both records exist until a human
decides) · duplicate prevention (same domain, different names → one record, merged
evidence) · uncertain-duplicate handling over HTTP (both resolutions) · conflicting
source data (user-entered city survives an extracted claim; the conflict stays in
evidence) · verified-vs-AI provenance guard · scoring snapshot on import.
Existing suites were migrated off `store.raw.importedCompanies` / `companyMeta` /
`discoveryRuns` / `connectors` / `scheduledJobs` / `pipelineMapping` onto the
repositories (all 121 prior tests still pass).

## 5. Errors / blockers

- None. One design note: the outreach tracker, drafts, tokens, and audit log are
  JSON collections inside the SQLite `kv` table (durable + transactional) rather
  than normalized tables — they were not in this phase's model list; promoting them
  is straightforward follow-up work.
- The API still has no authentication (unchanged, pre-existing).

## Commands (verified 2026-07-18)

```bash
npm test           # 10 files, 135 tests passing
npm run typecheck  # passing
npm run lint       # 0 errors (3 pre-existing fast-refresh warnings)
npm run build      # passing
npm run dev        # boots; companies persist across restarts in server/.data/deal-radar.db
```

---

# PHASE 5 COMPLETED — Interface simplification (2026-07-18)

Verified by: `npm test` (135 tests passing — the suite is backend/integration; there
are no frontend unit tests, stated honestly), `npm run typecheck`, `npm run lint`
(0 errors; the fast-refresh warnings dropped from 3 to 2 with the kanban store gone),
`npm run build` (bundle shrank 820 kB → 795 kB), **plus a live visual pass in the
browser** (Overview, Companies, Settings screenshots checked against a real imported
record; the API-offline error state was also observed rendering honestly).

## Navigation (deal-discovery tool, not a second CRM)

New nav: **Overview · Deal Discovery · Companies · Stealth Radar · Settings (admin
only)**. Removed: **Outreach Pipeline page** (tracker + the CRM-style kanban board),
the five per-vertical pages, and the Areas of Interest tab. Portfolio remains only
inside Settings (it powers the sourcing-context portfolio comparison).

- New `src/pages/Companies.tsx` — the review queue: every persisted company, strongest
  fit first, expandable rows with score breakdown, evidence, and the screening actions
  (Approve & add to HubSpot, Generate outreach draft) — outreach lives in the company
  detail, relationship management lives in HubSpot.
- Deleted: `src/pages/Outreach.tsx`, `src/pages/Vertical.tsx`, `src/store/pipeline.tsx`
  (kanban store + its localStorage persistence) and the kanban types in `src/types.ts`.
  Old routes redirect: `/health` → `/companies?vertical=health` (etc.), `/pipeline` →
  `/companies`. `/sources` keeps its path (the server's OAuth redirects target it) but
  is labeled Settings.
- Stealth Radar: the redundant feed/queue tabs collapsed into a single signal feed
  (the queue was just a filter of the feed). The sample watchlist was already gone.

## Overview — four live metrics, clear language

Exactly: **Discovered this week · High-fit companies · Awaiting review · Stale
companies** — all computed from persisted records, each with a plain-English subtitle
("4 companies scored 8.0 or higher"), no `10 / 7`-style values. Removed tiles/panels:
policy-exceptions count + exceptions review panel, verified diverse-led count,
verification-needed count, unreviewed-candidates count, stealth-signal count,
awaiting-approval/connector-failures (technical), Top-10/8.0+ compound counter, and
the hardcoded MVP-deadline countdown (already gone in Phase 2). The coverage-by-sector
chart stays (live counts, sourcing context).

## Filters & search

Primary filters everywhere (Companies table + Overview ranking): **Vertical, Stage,
State** — plus one search box covering **company, founder, website, and keywords**.
Removed: identity/verification filters, freshness/source/exception/review filters,
the verified-Latino-first sort toggle and research-queue split (identity chips remain
visible on rows; they filter nothing). Default order is always fit score descending —
strongest current opportunities first. Subcategory banners on vertical pages are gone;
subcategories remain visible per row and in company details.

## Renames

- "Areas of Interest" → **"Other Industries"** (taxonomy name/short, chart legend,
  connector options, scoring rationale wording; internal id `aoi` unchanged).
- "Data Sources & Refresh" → **"Settings — Admin Only"**, with the required warning
  banner verbatim: "Changes to these settings may affect live sourcing, scoring,
  integrations, and data quality. Do not modify without administrator approval."

## Also

- `dev:server` now pins `PORT=8787` so the API can't inherit a conflicting port from
  a wrapping process (found during the live visual pass).
- `.claude/launch.json` added for one-command previews.
- Backend outreach/tracker APIs are unchanged (the OutreachPanel still saves drafts);
  only the duplicate CRM-style views were removed from the UI.

## Commands (verified 2026-07-18)

```bash
npm test           # 135 tests passing (backend/integration; no frontend unit tests exist)
npm run typecheck  # passing
npm run lint       # 0 errors, 2 warnings (pre-existing fast-refresh notes)
npm run build      # passing — 795 kB bundle (was 820 kB)
```

---

# PHASE 6 COMPLETED — Transparent scoring, company details, Stealth Radar (2026-07-18)

Verified by: `npm test` (10 files, **142 tests** passing), `npm run typecheck`,
`npm run lint` (0 errors), `npm run build`, **plus a live browser pass**: imported a
real record with funding/accelerator facts, verified the full fact sheet, the v3
score breakdown, and a stealth signal card with suspected geography.

## Vamos Fit Score — scoring model v3.0 (2026-07)

- Displayed as **"Vamos Fit Score: 7.3/10"** in every company detail, with the model
  version one hover away. No unexplained AI numbers anywhere: every point is
  deterministic and carries a written rationale (tested: rationale required on all
  components).
- **Repeatable weighted framework (weights sum to 100, tested):** Thesis/vertical fit
  20 · Stage fit 15 · Mission alignment (verified only) 15 · Traction 10 · Founder &
  team evidence 10 · Geography 10 · **Funding evidence 5 (new)** · **Accelerator /
  institutional validation 5 (new)** · Evidence quality 5 · **Evidence recency 5
  (new)**. Unknown facts score 0 with an honest "unscored, not guessed" rationale.
- **Stored per snapshot** (`scoring_results`, migration v2): total score, component
  scores, weights, explanation, supporting evidence URLs, **scoring version**, and
  calculation date (all asserted in tests).
- **Clearly distinguished measures:** fit score (thesis fit) vs **evidence confidence**
  (new 0–1 metric: evidence count, primary-source share, source diversity, freshness —
  shown as "Evidence confidence 36%" with an explanatory tooltip) vs **stealth signal
  confidence** (High/Medium/Low on signals) vs plain company counts. Tested that
  richer evidence raises confidence without touching fit-relevant facts.
- New recorded company facts: `raising`, `accelerator`, `lastFundingDate` (DB columns,
  CSV columns, and discovery-candidate mapping — funding facts found by sources now
  persist instead of being dropped).

## Company details — full fact sheet

Every expanded company now shows: name · website · description · founders · stage ·
geography · vertical · funding · last funding date · accelerator · discovery date ·
last refreshed · source URLs (every evidence row links out) · Vamos Fit Score ·
score breakdown with weights · evidence confidence · **missing information** (exact
list of unknown facts) · **risks** (exceptions + weak components) · **recommended
next step** (deterministic) · review status · HubSpot sync status.
**Field-origin marks:** each fact carries its provenance chip (Verified /
User-entered / Extracted public info / AI-inferred / Unverified) from the
`field_provenance` table, absent facts display *Missing*, and "Unknown" values render
as unverified — nothing is dressed up.

## Founder information

Unchanged hard rule, now labeled per spec: indicators come only from explicit public
statements, approved data, or user entry — never inferred from names, photos,
appearance, language, or geography. Chips read as **"Publicly identified founder
signal"** (with basis + source on hover); absent identity reads **"Identity not on
record — requires human verification, never inferred"**, and the founders section
carries the no-inference notice. Mission scoring still gives 0 without verification
(tested).

## Stealth Radar

- Sample records were already gone (Phase 2); the feed still starts empty and nothing
  is created to populate the page.
- A stealth lead now requires/records ALL of: founder identifier · ≥1 real source URL
  (Zod-rejected otherwise — tested) · evidence/signal date (format-validated) ·
  reason for the hypothesis (signal type + "why this looks like stealth activity") ·
  confidence level · suspected vertical · **suspected geography (new field, defaults
  honestly to Unknown — tested)** · review status · **missing-information list (new
  card section)**.
- Permitted signal types extended with **"Hiring announcement"** and **"Public
  filing"** (tested); the full list already covered GitHub orgs/repos, founder
  announcements, conference bios, grants, registrations, domains, accelerators.

## Tests

+7 tests (142 total): weighted-framework invariants (weights=100, all components
explained, version in snapshot), evidence-confidence separation, funding/validation
scoring from recorded facts only, recency scoring, versioned snapshot persistence
(version, explanation, supporting evidence, calculation date), stealth URL/date/
reason rejection, suspected-geography default, new signal types.

## Commands (verified 2026-07-18)

```bash
npm test           # 10 files, 142 tests passing
npm run typecheck  # passing
npm run lint       # 0 errors
npm run build      # passing
```

---

# PHASE 7 COMPLETED — HubSpot, Outlook, and Settings integrations (2026-07-18)

Verified by: `npm test` (11 files, **147 tests** passing — includes a new
integration suite exercising the REAL HubSpot client against a stubbed API),
`npm run typecheck`, `npm run lint` (0 errors), `npm run build`, **plus a live
browser pass** of the new Settings system panel (GitHub showed a genuine
"Connected" from a real rate-limit health check; HubSpot/Outlook/AI showed
"Implemented — credentials required").

## HubSpot — system of record, not recreated internally

- **Search** now covers companies, contacts, AND deals (live client + settings card).
- **Pre-create duplicate check runs the full required ladder** (`checkDuplicate`):
  (1) existing Vamos property `vamos_deal_radar_id` (prior sync) → (2) normalized
  domain → (3) normalized company name → (4) founder emails against HubSpot
  contacts; the review modal now sends founder emails + the radar id, and our own
  persisted HubSpot link is consulted before any create.
- **Idempotent actions:** repeated clicks are blocked by the Idempotency-Key window,
  AND a later re-submission with `create-new` converts to an update — the live
  client re-checks `vamos_deal_radar_id` server-side before every create, so a
  duplicate company can never be created (tested at both the route and the live
  client with a stubbed portal: exactly one POST /companies across repeated syncs).
- **Explicit HubSpot fields win:** on update, the live client reads the record first
  and drops our values for any non-empty `name/domain/website/city/state/country/
  description` — geography is never inferred over a HubSpot geography field, and no
  AI output can overwrite anything (AI text never reaches CRM fields at all); only
  empty fields are filled from recorded facts, and `vamos_*` properties are always
  refreshed (tested).
- **Recorded on every approved sync:** source URLs (`vamos_source_urls`), Vamos Fit
  Score, score explanation (`vamos_score_explanation`), approval date
  (`vamos_approval_date`), reviewer (`vamos_reviewer`) — plus the existing score
  breakdown/rationale/risks properties.
- **Success AND failure recorded** in `hubspot_sync_history` (migration v3 adds the
  request payload), with `GET /api/hubspot/failed-syncs` (retry queue) and
  `POST /api/hubspot/retry-sync` re-running the stored payload — tested with a
  fixture that fails once then succeeds. The Settings panel lists failures with a
  Retry button.
- **No credentials:** the real implementation stays; live actions are disabled with
  **"Implemented — credentials required"** (status endpoint, integration card badge,
  admin panel); nothing simulates success and no fake HubSpot records exist anywhere
  in the running app.

## Outlook — drafts only

Kept: create a reviewable draft, link to it (`webLink`), and record that a draft was
created (`GET /api/outlook/drafts`, bodies never echoed in lists; a note lands on
the linked HubSpot company). **Removed: the entire internal outreach tracker and
pipeline stages** — `services/records.ts` deleted; outreach statuses/activities/
follow-ups/meeting routes and types deleted; the draft-status "sent" check deleted
(delivery is neither performed nor simulated); `/api/outreach` is now generate/
regenerate only. No automatic sending — there is still no send path in the codebase.

## Settings — Admin Only

New `GET /api/admin/status` + "System status" panel showing everything required:
database status (engine, location, active companies, schema version) · GitHub ·
HubSpot · Outlook · AI-provider status · **credential presence as booleans only —
values never leave the server** · last sourcing run · last successful run · last
failed run · records retrieved / created / updated (aggregated from persisted run
history) · source errors from the latest run · rate-limit status (GitHub remaining/
limit + recently rate-limited sources). **"Connected" appears only after a real
health check succeeds** (cached 5 minutes; tested).

## Environment

`.env.example` now contains only variables the code actually reads; unused
`APP_BASE_URL` was removed from both the schema and the example.

## Tests

147 total (+6 new live-client/route tests, tracker tests removed/rewritten):
create-once idempotency against a stubbed HubSpot portal · explicit-field
preservation on update (geography never overwritten) · empty-field filling ·
failure recording + payload retry + retry-queue drainage · honest 404 for retry
without a failure · admin status (Connected only via real check, credentials as
booleans, no simulated success). The 12-step workflow test was rewritten as the
tracker-free screening workflow, asserting the new `vamos_*` recording fields and
radar-id/founder-email duplicate tiers.

## Commands (verified 2026-07-18)

```bash
npm test           # 11 files, 147 tests passing
npm run typecheck  # passing
npm run lint       # 0 errors
npm run build      # passing
```

---

# PHASE 8 COMPLETED — Scheduling, security, final testing, and documentation (2026-07-18)

Verified by: `npm test` (**12 files, 176 tests** passing), `npm run typecheck`
(passing), `npm run lint` (0 errors, 2 pre-existing fast-refresh warnings
unrelated to this phase), `npm run build` (passing), **plus a live browser
pass**: seeded a real company through the running API, expanded its fact
sheet and confirmed the new review-status buttons and Stale badge render
correctly, clicked "Monitor" and confirmed the status changed live in the
UI; separately, saved a real schedule in Settings and clicked its "Run
sourcing now" button, which executed the real discovery pipeline against
live sources (`yc, github, funding-news`) and returned a 200 in 1538ms.

## Scheduled sourcing — real server-side execution, not a browser-tab timer

- Migration v4 (`server/db/migrations.ts`) adds `source_runs.completed_at`,
  `duplicates_identified`, and `filtered_by_policy`, so every run's record
  captures **start time, end time, sources queried, results retrieved,
  companies created/updated, duplicates identified, records filtered by
  policy, errors, and final status** — all of it already persisted in
  SQLite, none of it dependent on a browser tab staying open.
- `runDiscovery()` now takes a **persisted, cross-process run lock**
  (`discovery-run-lock` in `sourcing_config`, not just an in-memory flag) so
  a manual run, a scheduler tick, and an admin's "Run sourcing now" can
  never overlap; a lock older than 15 minutes is treated as abandoned and
  reclaimed so a crashed run can't wedge the system.
- Two new query filters give real meaning to previously-decorative config:
  **evidence-recency threshold** (`minEvidenceRecencyDays` — drops
  candidates whose evidence is entirely older than the window; a candidate
  with no parseable evidence date is never excluded, since recency can't be
  guessed) and **stale-only mode** (`staleAfterDays` — restricts results to
  candidates matching an existing company overdue for refresh; previously
  `'stale-only'` existed as an enum value with no implementation at all).
- New administrator action: **`POST /api/schedule/:id/run-now`**
  (`runJobNow()` in `server/services/schedule.ts`) — runs a saved
  schedule's exact configuration immediately, through the same lock and
  pipeline as every other run path, and records `lastRunAt` + an audit
  entry. Exposed in the UI as a labeled "Administrator-only" button per
  saved job in the rebuilt `Schedule` component (moved from the Discovery
  page into Settings, and made fully self-contained with its own
  source/vertical/stage/geography/keywords/maxResults/evidence-recency/
  refresh-age fields).

## Simple company-status lifecycle — explicitly not a CRM

- `COMPANY_STATUSES` (`shared/integrations.ts`): **New, Awaiting Review,
  Research Needed, Approved for HubSpot, Synced to HubSpot, Monitor,
  Passed** — seven values, no more. `'Needs Review'` was renamed to
  `'Awaiting Review'` everywhere (migration v4 backfills existing rows).
- **Stale is a computed overlay, never a stored status**
  (`companyMetaView()` in `server/db/repos/companies.ts`): any non-terminal
  company (`TERMINAL_COMPANY_STATUSES` = Passed, Synced to HubSpot) whose
  `last_refreshed`/`discovered_at`/`created_at` exceeds
  `DEFAULT_STALE_AFTER_DAYS` (30) gets `stale: true` at read time — never
  written to the database, so it can't drift out of sync with the clock.
- New actions, each a recorded review decision + audit entry:
  `POST /api/companies/:id/status` (Zod-validated against
  `COMPANY_STATUSES`, 404 for an unknown company) and
  `POST /api/companies/:id/refresh` (marks reviewed today via
  `markRefreshed`, does not change status — refreshing and re-approving are
  different actions). The company fact sheet now shows a "Review status —
  no CRM workflow, just the calls a reviewer actually makes" section with
  **Refresh, Send for research, Monitor, Pass** buttons, alongside the
  existing HubSpot/outreach actions; **Approve & add to HubSpot** sets the
  status and opens the sync modal in one click.
- **Bug found and fixed during this phase, not by a test failure:**
  `saveCompany`'s update path was unconditionally applying
  `opts.reviewStatus` on every save — meaning a routine CSV re-import of an
  unchanged row would silently reset a company's review progress back to
  `New`. Fixed by restricting `reviewStatus` to apply only at creation;
  re-imports never touch an existing company's status again.
- `Synced to HubSpot` is now set automatically by `performSync()`'s success
  branch — the one status transition allowed to happen without a human
  clicking a button, because a confirmed sync is a fact, not a guess.

## Security — read-only audit findings, now fixed

Findings from Phase 7's audit are addressed, and none of them assume or
claim any external security sign-off:

- **SSRF prevention** (`server/lib/http.ts#isSafeExternalUrl`): rejects
  non-http(s) schemes and hostnames matching loopback/private/link-local/
  cloud-metadata literal patterns (`localhost`, `127.*`, `10.*`,
  `192.168.*`, `172.16–31.*`, `169.254.*` including the AWS/GCP metadata
  address, `.local`/`.internal`). Wired into the `websites` refresh
  connector before every HEAD request; unsafe URLs are logged as refused
  and never fetched. **Explicitly not** DNS-rebinding-safe — documented as
  a hostname/IP-literal check, not full protection (see
  `KNOWN_LIMITATIONS.md`).
- **Secret redaction, generalized:** `server/lib/guard.ts` replaced the old
  key-name-based `redact(obj)` with `redactSecrets(text)` — a set of
  regexes (Bearer tokens, `sk-`-style API keys, long hex tokens/hashes,
  JWT-shaped strings) applied to **free-text** audit fields (`subject`,
  `detail`), so a secret pasted into a free-form string can't leak into the
  audit log the way a key-based check would miss.
- **Error sanitization extracted and made independently testable:**
  `server/lib/errors.ts` (`sanitizeErrorForClient`) distinguishes
  "operational" errors — thrown deliberately with an explicit `.status`,
  meant to be shown to a user — from unexpected bugs (a bare `Error` with
  no `.status`), and only ever echoes the real message for the former.
  `server/app.ts`'s error middleware is now a thin wrapper around this
  function; stack traces are never sent to a client.
- **Confirmed already in place, re-verified this phase:** secrets stay
  server-side (frontend never receives tokens; Settings shows credential
  presence as booleans only); environment variables are Zod-validated at
  boot (`server/env.ts`); external HTTP calls use a 10s timeout and one
  bounded retry on 429/5xx (`fetchWithTimeout`/`fetchWithRetry`,
  `server/lib/http.ts`); GitHub's real rate-limit headroom is surfaced, not
  ignored; CRM writes are recorded in `hubspot_sync_history` regardless of
  success or failure; Outlook has no send path anywhere in the codebase;
  arbitrary URL scraping is refused (LinkedIn/PitchBook/Crunchbase names
  trigger a 422 anywhere in a request).
- **Confirmed NOT in place, disclosed rather than hidden:** there is **no
  authentication or authorization anywhere in the API** — every
  "Administrator-only" UI label is a convention enforced only by the
  frontend, not a real access boundary. This was true before this phase
  and remains the top item in `KNOWN_LIMITATIONS.md` and
  `TECHNICAL_HANDOFF.md`'s security-review section. **No claim of Pliancy
  or any other firm security approval is made anywhere in this codebase or
  its documentation.**

## Tests

+29 tests in the new `server/tests/scheduling-status-security.test.ts` (176
total, up from 147): run-lock overlap rejection, run-log timing/counters,
evidence-recency filter (including the never-exclude-on-unknown-date rule),
stale-only filter, run-now at both the service and HTTP layer, the full
status lifecycle (defaults, no-reset-on-reimport, all four transitions,
404/400 handling, refresh action, auto-Synced-to-HubSpot on real sync), the
computed Stale overlay (flags old non-terminal companies, never flags
recent ones, never flags terminal ones), SSRF-guard unit tests, secret-
redaction unit tests, and error-sanitization unit tests.

## Documentation

Added `TECHNICAL_HANDOFF.md` (full engineering walkthrough: architecture,
environment, database setup, live-sourcing mechanics, adding a source
adapter, scoring methodology, review/HubSpot/Outlook workflows,
troubleshooting, required security reviews, safe-vs-sensitive code areas,
and guidance for future Claude Code sessions), `LIVE_READINESS.md` (the
five-value honest status table — nothing marked "Live and verified" without
an actual successful real request), and `KNOWN_LIMITATIONS.md` (consolidated,
current list superseding scattered mentions across earlier phases). Updated
`README.md` to reflect SQLite persistence, the current 176-test suite,
scheduled sourcing, the status lifecycle, and the current Vamos Fit Score
v3.0 weights (the README had drifted to describe the pre-v3 model).

## Commands (verified 2026-07-18)

```bash
npm test           # 12 files, 176 tests passing
npm run typecheck  # passing
npm run lint       # 0 errors (2 pre-existing fast-refresh warnings)
npm run build      # passing
```

---

# PHASE 9 COMPLETED — Real admin authentication, SSRF hardening, two new adapters, code-splitting (2026-07-19)

Requested as a direct follow-up to Phase 8's gap analysis: the user asked to
"tackle all" of the items flagged as missing/needing code in Phase 8's
report. Verified by: `npm test` (**15 files, 201 tests** passing),
`npm run typecheck`, `npm run lint` (0 errors, same 2 pre-existing
fast-refresh warnings), `npm run build` (passing, chunk-size warning now
gone), **plus a live browser pass**: signed in with the wrong password
(rejected), then the right one (admin panels rendered), clicked Sign Out
(re-locked), and navigated every route to confirm the new lazy-loaded chunks
render with zero console errors. Also live-verified the new arXiv adapter
against the real API (not stubbed) and confirmed the Product Hunt endpoint
is genuinely reachable via a real unauthenticated request.

## Real admin authentication (previously: none at all)

- `ADMIN_PASSWORD` (`.env`) + `server/lib/auth.ts`: a signed, HttpOnly
  session cookie (HMAC-SHA256, 12h TTL, `SESSION_SECRET`-derived key or an
  ephemeral per-process key if unset), a constant-time password comparison,
  and a `requireAdmin` middleware that **fails closed** — if
  `ADMIN_PASSWORD` was never set, admin routes are entirely unusable (401),
  never silently open.
- New routes: `GET /api/auth/status`, `POST /api/auth/login` (rate-limited,
  10/15min), `POST /api/auth/logout`.
- `requireAdmin` now gates: all of `/api/schedule/*`, all of
  `/api/refresh/*`, `/api/admin/status`, and HubSpot/Outlook
  connect/disconnect/pipeline-mapping/failed-syncs/retry-sync. Left
  deliberately open (matching the product's "reviewer, not admin" design):
  company status/refresh, HubSpot search/sync-company/check-duplicate,
  Outlook draft save/list, and both services' OAuth `callback` routes
  (protected by their own forged-state rejection instead).
- **Bug found and fixed during implementation, not by a pre-existing test**:
  the first pass gated `scheduleRouter`/`refreshRouter`/`adminRouter` with
  `router.use(requireAdmin)` while still mounting them at the shared `/api`
  prefix in `app.ts`. Because an unauthorized response never calls `next()`,
  and Express dispatches every `app.use('/api', X)` registration in
  sequence regardless of which routes X actually defines, this 401'd
  **every** request under `/api` that reached one of these routers first —
  not just their own routes. Fixed by mounting each at its own prefix
  (`/api/schedule`, `/api/refresh`, `/api/admin`) instead, so their
  unconditional gate can only ever intercept requests actually bound for
  them. A new test (`rejects run-now without an authenticated admin
  session`) pins the correct, narrow behavior down.
- Frontend: `AdminLogin` component + a login gate in `DataSources.tsx` —
  the whole admin panel (System status, Integration cards, Connectors,
  Schedule) is replaced by a sign-in form until authenticated; Portfolio and
  the static data-rules cards stay visible either way, matching what the
  backend actually gates.
- **Pre-existing, unrelated bug surfaced by testing this live**: the dev
  server never actually loaded `.env` at all — no `dotenv` call, no
  `--env-file` flag anywhere. `dev:server` now runs with
  `--env-file-if-exists=.env` (Node's built-in loader). This in turn
  surfaced a second latent bug: a freshly-copied `.env.example` ships every
  key present but blank, and a blank string fails Zod's `.optional()`
  check (`""` ≠ `undefined`) — `server/env.ts` now strips blank-valued keys
  before validating.

## SSRF guard — now DNS-resolution-aware

`isSafeExternalUrlResolved()` (`server/lib/http.ts`) adds a resolved-address
check on top of the existing literal check: it resolves the hostname (with
its own 3s timeout, separate from the fetch timeout) and rejects it if any
resolved address is loopback/private/link-local/cloud-metadata — closing
the specific gap the Phase 8 audit disclosed (a public-looking hostname
that actually resolves to internal infrastructure). Still not full
DNS-rebinding protection (the resolved address isn't pinned for the actual
fetch), and this is documented rather than hidden. Wired into the
`websites` refresh connector; the original synchronous `isSafeExternalUrl`
remains for anything that can't await a DNS lookup.

## SEC EDGAR Form D parsing — documentation correction, not new code

Discovered while starting this task: `server/sourcing/adapters/sec.ts`
**already** parses real Form D filings into candidates (company name, CIK,
filing-index URL, business state, filing date) — this was built and tested
in Phase 3. `KNOWN_LIMITATIONS.md`, `TECHNICAL_HANDOFF.md`, and `README.md`
had carried forward a stale "reachability only, parsing is a follow-up"
claim from the original pre-Phase-3 audit without re-checking the current
code. Corrected in all three; no code changed here.

## Two new source adapters

- **arXiv** (`server/sourcing/adapters/arxiv.ts`, source id `research`) —
  the official, key-free `export.arxiv.org` search API. Confirmed reachable
  and returning real Atom XML (live-checked against the real endpoint, not
  just stubbed). A deliberately weak, honestly-labeled signal: a candidate
  is created ONLY when a paper's `<arxiv:affiliation>` field is present,
  and that text is used verbatim as the company name — never inferred from
  an author's name or lab. Most submissions omit this field, so an honest
  zero is the expected common outcome, not a bug.
- **Product Hunt** (`server/sourcing/adapters/producthunt.ts`, source id
  `producthunt`) — real GraphQL client against
  `api.producthunt.com/v2/api/graphql`, gated on `PRODUCTHUNT_TOKEN`
  (refuses to run without one — zero-cost, reported as `skipped`, not
  `failed`). The endpoint's existence and auth requirement were confirmed
  live (an unauthenticated request returns Product Hunt's own
  `invalid_oauth_token` error); the query shape has NOT been exercised
  against a real token from this environment.
- A hardcoded shortcut in `server/sourcing/index.ts` that unconditionally
  skipped `producthunt` before ever checking the adapter registry was
  removed so the real adapter is actually reachable. A new generic rule
  was added instead: any adapter failure with `failure ===
  'missing-credentials'` AND `apiCalls === 0` is reported as `skipped`
  (zero cost, never attempted) rather than `failed` — preserving the
  existing skipped/failed distinction for any future credential-gated
  adapter, not just this one.
- **Patents (USPTO) were investigated and deliberately NOT implemented.**
  PatentsView's previously-known key-free API is retired:
  `api.patentsview.org` now redirects to a USPTO transition-guide page, and
  the newer `search.patentsview.org` host doesn't resolve in DNS at all
  from this environment. Shipping an adapter against a guessed schema for
  an API that can't be confirmed working would violate this codebase's
  "never guess, never fabricate" rule either by inventing a response shape
  or by silently always failing. This is recorded as an honest gap with
  specific next steps in `KNOWN_LIMITATIONS.md`, not quietly dropped.

## Frontend code-splitting

`src/App.tsx`: every route component is now `React.lazy()`-loaded behind a
`Suspense` boundary, replacing the single ~817 kB bundle with one chunk per
page (largest: Overview + Recharts at ~352 kB gzip 102 kB). The production
build no longer warns about chunk size. All five routes were live-checked
in the browser after the change with zero console errors.

## Tests

+22 tests (201 total, up from 176 across 12 files → 15 files): new
`server/tests/auth.test.ts` (session token round-trip/tamper/expiry,
password matching, login/logout/status routes, fail-closed when
unconfigured, gating an admin route), new `server/tests/ssrf.test.ts`
(DNS-mocked: literal-unsafe skips the lookup entirely, public/private
resolved addresses, mixed-address rejection, lookup failure, lookup
timeout), new `server/tests/adapters-research-producthunt.test.ts` (arXiv
affiliation-only lead creation, honest zero, invalid-response handling;
Product Hunt zero-cost skip without a token, a real launch with a token,
a genuine 401 reported as failed not skipped). Existing tests across
`phase3`, `phase4`, `mapping`, `hubspot-live`, `scheduling-status-security`,
and `workflow` were updated to authenticate via a new
`server/tests/testAuth.ts` helper (`adminAgent()`) wherever they exercise a
now-gated route.

## Documentation

Updated `KNOWN_LIMITATIONS.md`, `LIVE_READINESS.md`, `TECHNICAL_HANDOFF.md`,
and `README.md` throughout to reflect: real (if single-password) admin
auth, the DNS-aware SSRF guard, the corrected SEC Form D history, the two
new adapters, the honest patents gap and why, code-splitting, and the
env-loading fixes.

## Commands (verified 2026-07-19)

```bash
npm test           # 15 files, 201 tests passing
npm run typecheck  # passing
npm run lint       # 0 errors (2 pre-existing fast-refresh warnings)
npm run build      # passing, no chunk-size warning
```

---

# PHASE 10 — QUALITY, OPERATIONS, AND DEPLOYMENT PREPARATION

**Note on numbering:** the request that opened this phase asked for a
section titled "PHASE 9 — …", but Phase 9 (admin authentication, SSRF
hardening, arXiv/Product Hunt adapters, code-splitting) was already
completed and recorded above. This is **Phase 10**, continuing the
sequence rather than overwriting Phase 9's record.

## Audit (performed before any implementation)

Read `IMPLEMENTATION_STATUS.md`, `LIVE_READINESS.md`, `KNOWN_LIMITATIONS.md`,
`TECHNICAL_HANDOFF.md`, and `README.md` in full, then inspected the current
code directly rather than trusting older documents' claims. Findings:

| Area | What actually exists today | What this phase changes |
|---|---|---|
| Authentication | Real (Phase 9): `ADMIN_PASSWORD` + signed session cookie + `requireAdmin` gating the admin-plane routes. Single shared password, no per-user identity. | Unchanged — E2E tests exercise it; no code changes needed here. |
| Database models/migrations | SQLite via `node:sqlite`, 4 forward-only migrations, repos for companies/founders/evidence/runs/scores/config. `getConfig`/`setConfig` already exist as a generic JSON key-value config store (used today for the pipeline mapping and scheduled jobs). | Add migration(s) for backup metadata if needed; reuse `getConfig`/`setConfig` for stale-record settings rather than new tables. |
| Source adapters | 7 real adapters (GitHub, SEC, SBIR grants, RSS funding-news, YC, arXiv, Product Hunt) registered in `server/sourcing/index.ts`'s `ADAPTERS` map; `SOURCE_META` lists all 14 `DiscoverySourceId`s with only `liveCapable: boolean` + a free-text `needs` string — no formal state enum. | Add an explicit `state: 'live' \| 'credentials-required' \| 'planned' \| 'unavailable'` to `SourceMeta`, computed from adapter presence + credential presence, and reflect it honestly in Discovery/Schedule source checklists. |
| Company refresh | `POST /api/companies/:id/refresh` (`markRefreshed`) — stamps `last_refreshed` to today. Does **not** re-query any source or touch evidence/score. This is exactly the gap the task describes. | Add a new `POST /api/companies/:id/refresh-research` action that actually queries adapters, merges evidence, recomputes score, and returns a What-Changed summary. Keep the existing stamp-only action as "Mark reviewed." |
| Review queue | `CompanyTable`/`CompanyDetail` support per-company status changes (Refresh/Research Needed/Monitor/Pass/Approve) one at a time. No bulk selection, no possible-duplicate indicator, no missing-info/evidence-confidence/staleness filters, no sort control (fixed by fit score). Backend `possible_duplicates` table + `/api/duplicates` route exist but have **no frontend surface at all** — a real, previously-undiscovered gap. | Add bulk selection + bulk status actions (server-validated, audited), new filters/sorts, and a possible-duplicate badge/filter wired to the existing backend table. |
| Source-run metrics | `source_runs`/`source_run_results` tables persist every run (mode, found, duration, failures) via `listRuns()`. Nothing aggregates this per-source today — Settings shows only the latest run's headline numbers. | Add a read-only aggregation function over persisted runs (no new tracking needed) and a compact Settings table. |
| Test structure | Vitest + supertest, 15 files / 201 tests, `server/tests/mocks` and `fixtures/` for integration stubs. No browser-level/E2E tests, no Playwright. | Add Playwright with its own isolated SQLite file and env, global setup/teardown, specs per the task's checklist. |
| GitHub workflows | `.github/workflows/` does not exist. | Add `ci.yml` running the full verification chain on PRs and pushes to `main`. |
| Deployment files | No `Dockerfile`, `.dockerignore`, health endpoints, or graceful shutdown — `SIGINT`/`SIGTERM` handlers exist but only call `process.exit(0)` immediately (not graceful: no server/db close, no in-flight-request grace period). | Add both health endpoints, real graceful shutdown, a production start script, `Dockerfile`, `.dockerignore`, and a deployment smoke-test script. |
| Backup logic | None. `server/.data/deal-radar.db` (WAL mode) has no backup/restore tooling of any kind. | Add a backup service (SQLite's `VACUUM INTO`, which produces a consistent single-file snapshot including WAL-pending data without stopping the process), metadata, retention, admin routes, and a documented CLI restore path. |
| Stale-record configuration | `DEFAULT_STALE_AFTER_DAYS = 30` is a hardcoded constant in `shared/integrations.ts`; whether Monitor/Research-Needed count toward staleness is implicit (anything non-terminal does); Overview's stale count has no visibility/limit controls. | Move to a `getConfig`/`setConfig`-backed settings object with validation (1–365 days), admin API + UI, and explicit per-status inclusion flags. |
| Documentation | Five docs from Phase 8/9 are current and accurate as of Phase 9. `PLIANCY_SECURITY_REVIEW.md` does not exist. | Add the security-review package; update all five existing docs for everything built in this phase. |

No area was assumed missing without checking the actual code first — the
review-queue possible-duplicate gap and the "refresh only stamps a
timestamp" gap were both confirmed by reading `CompanyTable.tsx` and
`server/routes/imports.ts` directly, not inferred from older docs.

## What this phase implements

1. Playwright E2E suite against an isolated SQLite file, never the
   developer's `server/.data/deal-radar.db`.
2. GitHub Actions CI (PRs + pushes to `main`) running the full checked
   command chain with test-only secrets.
3. SQLite backup (`VACUUM INTO`) + restore tooling, admin routes, retention,
   and tests.
4. A real per-company "Refresh live research" action alongside the existing
   "Mark reviewed" stamp.
5. Review-queue bulk actions, new filters/sorts, and a possible-duplicate
   surface wired to the previously-unused `/api/duplicates` backend.
6. Source-quality analytics computed from already-persisted run history —
   no new tracking, no fabricated numbers.
7. An honest four-state source-selection model (Live / Credentials required
   / Planned / Unavailable) replacing the current binary `liveCapable`.
8. Configurable, persisted stale-record settings.
9. Deployment-preparation files: health endpoints, graceful shutdown,
   production start script, Dockerfile, smoke test — no deployment
   performed.
10. `PLIANCY_SECURITY_REVIEW.md`.

Explicitly out of scope, per the request: real HubSpot/Outlook/AI-provider
verification, cloud deployment, new patent-source work (no verified
key-free API exists — see Phase 9's finding), new CRM pipeline features,
and automatic email sending.

---

# PHASE 10 COMPLETED — Quality, operations, and deployment preparation (2026-07-19)

Verified by: `npm test` (**22 files, 242 tests** passing), `npm run typecheck`
(passing), `npm run lint` (0 errors, same 2 pre-existing fast-refresh
warnings), `npm run build` (passing), **`npm run test:e2e`** (**26/26
Playwright tests passing** against a fully isolated backend/frontend/SQLite
stack), `npm run smoke-test` (all checks passed against a real production-mode
process), and a live browser pass of stale settings, source analytics,
honest source-selection states, and the bulk-action toolbar (confirm → API →
result summary, verified round-trip).

## 1. Playwright E2E suite

`e2e/` — 5 spec files, 26 tests, real Chromium via `@playwright/test`:

- `e2e/env.ts` — dedicated ports (backend 8788, frontend 5183), a
  temp-directory SQLite file (`os.tmpdir()/vamos-deal-radar-e2e/`), and
  test-only `ADMIN_PASSWORD`/`SESSION_SECRET` — never the developer's real
  `.env` or `server/.data/deal-radar.db`.
- `playwright.config.ts` — `webServer` array (backend + frontend, both
  `reuseExistingServer: false` always), `workers: 1` (specs share one seeded
  database and must not race), `globalSetup`/`globalTeardown` (seeds 2 real
  companies via a real CSV-import call; wipes the temp data directory after).
- `e2e/auth.spec.ts` (5 tests) — login gate shown/rejected/accepted, logout
  re-locks, protected admin API routes 401 unauthenticated.
- `e2e/discovery.spec.ts` (3 tests) — page loads, honest empty state, and a
  full search → review → select → import flow with **every discovery network
  call intercepted via `page.route()`** — no real GitHub/SEC/etc. call is ever
  made during an automated browser test.
- `e2e/companies.spec.ts` (7 tests) — seeded data loads with no demo/sample
  companies, search, vertical/stage/state filters, detail view + Monitor/
  Research-Needed/Pass actions, and possible-duplicate indicators (real
  company id fetched from the live backend, duplicate entry injected via
  `page.route()`, resolve buttons verified present).
- `e2e/settings.spec.ts` (5 tests) — honest source states, credential-required
  integrations never shown as connected, no-adapter sources never shown as
  enabled, sourcing history loads, schedule configuration loads.
- `e2e/responsive.spec.ts` (6 tests) — desktop/small-laptop/mobile nav and a
  company review action at each width.
- `npm run test:e2e` / `npm run test:e2e:ui` added to `package.json`.

**Bug found and fixed while writing `discovery.spec.ts`:** `src/pages/Discovery.tsx`
still had 3 UI strings reading "Needs Review" — a Phase 8 rename to
"Awaiting Review" that missed this one file. Fixed.

**Bug found and fixed while running the suite:** the global `/api` rate
limiter (300 req/min/IP) is realistic for one user but not for a fast,
serial E2E run that reloads the (request-heavy) Settings page dozens of
times inside one 60-second window from a single IP. `server/app.ts` now
raises the ceiling to 5,000/min **only** when `NODE_ENV=test` (the value the
E2E harness and vitest both set); production keeps the real 300/min limit.

## 2. GitHub Actions CI

`.github/workflows/ci.yml` — triggers on every pull request and every push to
`main` (the repository's only long-lived branch); one job: `actions/checkout`
→ `actions/setup-node` (Node 24, `cache: npm`) → `npm ci` → typecheck → lint →
`npm test` → `npm run build` → `npx playwright install --with-deps chromium`
→ `npm run test:e2e` → upload the Playwright HTML report as a build artifact
(pass or fail). **No repository secrets are required** — the E2E harness is
fully self-contained (its own port range, database, and admin credentials),
so nothing sensitive needs to exist in GitHub Actions config. A concurrency
group cancels superseded runs on the same ref/PR. Documented in `README.md`.

## 3. SQLite backup and restore tooling

`server/services/backup.ts` — `VACUUM INTO` for a consistent, WAL-safe
single-file snapshot; timestamped filenames + a JSON metadata sidecar (file,
size, schema version, company count, timestamp — never row contents) written
to a sibling `backups/` directory, never inside the active database path. A
file-lock (`acquireBackupLock`/`releaseBackupLock`) prevents overlapping
backup jobs. Retention (`backupSettingsSchema`: `maxBackups` 1–500, default
14; `maxBackupAgeDays` 1–3650, default 30) prunes after every successful
backup, admin-configurable via `PUT /api/admin/backup-settings`.

Admin routes: `GET /api/admin/backups` (list + metadata), `POST
/api/admin/backups` (create now), `GET /api/admin/backups/:file/metadata`,
`GET /api/admin/backups/:file/location`. **No restore route exists in the
API at all** — restore is deliberately CLI-only:

```bash
npm run db:backup           # create a backup now
npm run db:list-backups     # list existing backups + metadata
npm run db:integrity        # PRAGMA integrity_check on the active database
npm run db:restore -- <file> --yes   # restore from a named backup file
```

`db-restore.ts` requires the backend to be stopped (a best-effort `/health/live`
probe warns if it's still running), validates the target file's SQLite header
and `PRAGMA integrity_check` result, takes an automatic pre-restore safety
backup of the current database, restores, re-checks integrity, and
automatically rolls back to the safety backup with a clear error if the
post-restore check fails. Tested (`server/tests/backup.test.ts`): backup
creation, backup contains real records, restore produces the expected
records, an invalid (non-SQLite) file is rejected, existing data is protected
by the automatic safety backup before every restore, and overlapping backup
requests are rejected by the lock.

**Two bugs found and fixed during implementation:** (1) `acquireBackupLock`
was called before the function's `try` block, so a lock-already-held error
propagated as an unhandled rejection instead of a clean `{ok:false}` result —
fixed by wrapping lock acquisition in its own try/catch. (2)
`getBackupPath()`'s filename-validation regex didn't include `Z`, but
`toISOString()`-based filenames always end in `Z` — every real backup file
failed its own validation. Fixed. (3) `restoreBackup()` hit "database is
locked" because the safety-backup step left the module's SQLite singleton
open when the file-copy and post-restore integrity check ran — fixed by
adding `closeDb()` and calling it before the file copy.

## 4. Per-company live research refresh

`server/services/companyRefresh.ts` — `refreshCompanyResearch(companyId,
actor)`, exposed as `POST /api/companies/:id/refresh-research` (rate-limited,
20/min), alongside the **unchanged, still-present** `POST
/api/companies/:id/refresh` ("Mark reviewed" — stamps `last_refreshed` only).
The new action: queries only company-level-capable sources (github, sec,
grants, yc, funding-news, research, producthunt) within budget, matches the
company by normalized identity, appends new evidence (URL-deduped, existing
evidence never deleted or rewritten), applies field-by-field updates through
the **existing** provenance guard (`applyFieldUpdate`) — so a refresh can
never overwrite a verified or user-entered value with a weaker
extracted/AI-inferred one — recomputes and stores a new versioned score, and
returns a `RefreshResearchResult` distinguishing new evidence, updated
fields, conflicting fields (refused by the provenance guard, surfaced for
human review), unchanged-field count, newly-found founder names (**never
auto-merged** — founders are identity-sensitive and are only ever
human-reviewed), which sources ran/failed/were skipped, and the old vs. new
score. `CompanyTable.tsx`'s detail view now shows both actions side by side
("Mark reviewed" vs. "Refresh live research") plus a "What changed" panel
rendering the result. Tested: new evidence found, no changes found,
conflicting evidence found, partial source failure, complete source failure,
duplicate-evidence prevention, score recalculation, historical evidence
preservation, and source-budget enforcement.

## 5. Review-queue bulk actions and filters

`CompanyTable.tsx` — checkbox-based bulk selection; a bulk action bar with
Pass/Monitor/Research-Needed/Awaiting-Review (confirmation prompt, then a
result summary showing updated vs. skipped counts). New filters: possible-
duplicate only, missing-information only, minimum evidence confidence,
"not reviewed in N days"; new sort modes (Fit Score / evidence recency /
discovery date); keyboard navigation (Arrow Up/Down) between rows.
Possible-duplicate badge + resolve UI wired to the previously-backend-only
`/api/duplicates` table.

`POST /api/companies/bulk-status` (`server/routes/imports.ts`) —
server-validates the target status against an explicit allow-list
(`Awaiting Review`, `Research Needed`, `Monitor`, `Passed` — **HubSpot-bound
statuses are not in the list**, so bulk HubSpot sync is impossible even if a
caller tries), skips (never force-changes) any company already `Synced to
HubSpot`, records a review decision and an audit entry per changed company,
and returns honest per-request `updated`/`skipped` counts — never a bare
"success." Max 200 ids per request.

## 6. Source-quality analytics

`server/services/sourceAnalytics.ts` — `computeSourceAnalytics()` aggregates
**only already-persisted** `source_runs`/`source_run_results` rows (no new
tracking, nothing fabricated): per source — total/successful/failed/skipped
runs, failure rate, average response time (from the per-source
`duration_ms` added this phase via migration v5), results retrieved, results
imported, companies eventually approved/synced, average Vamos Fit Score of
imported companies, most recent successful/failed run. Exposed as `GET
/api/admin/source-analytics` and a Settings table
(`src/components/SourceAnalytics.tsx`). A source with all zeros has simply
never been selected in a run yet — this is stated in the UI, not left
ambiguous.

## 7. Honest source-selection states

`server/sourcing/index.ts` — `SourceMeta.state` is now an explicit `'live' |
'credentials-required' | 'planned' | 'unavailable'` (replacing the old
binary `liveCapable`), computed fresh on every call from the adapter
registry plus current credential presence (so a credential added at runtime
reflects immediately, no restart needed). Classification: github / sec /
grants / funding-news / yc / research / user-uploaded CSV → live; Product
Hunt → live if `PRODUCTHUNT_TOKEN` is set, else credentials-required;
accelerators / hackathons / state registries / licensed data → planned (no
adapter); company websites / patents → unavailable (websites is structurally
a refresh-check, not a discovery source; PatentsView's key-free API is
confirmed retired — see Phase 9). No-adapter sources are never selectable in
the schedule UI (checkbox disabled) and never show as a working option
anywhere; Discovery/Schedule/Settings/Source-analytics all read from this
one source of truth.

## 8. Configurable stale-record settings

`shared/integrations.ts` — `staleSettingsSchema` (`staleAfterDays` 1–365,
default 30; `monitorGoesStale`/`researchNeededGoesStale` booleans, default
true; `showStaleOnOverview` boolean; `maxStaleOnOverview` 1–500, default 50;
`defaultStaleFilter`: all/stale-only/exclude-stale), persisted via the
existing generic `getConfig`/`setConfig` key-value store (no new table).
`GET /api/stale-settings` (public read, for Overview/Companies to render
correctly for any visitor) + `PUT /api/admin/stale-settings` (admin-only
write). `companyMetaView()`'s staleness computation now reads these settings
live — applies without a restart or code change. `StaleSettingsPanel.tsx` in
Settings; `Overview.tsx` respects `showStaleOnOverview`/`maxStaleOnOverview`
and lists stale companies with links into the review queue. Tested: default
values, updated values persist and take effect, terminal statuses always
excluded regardless of settings, Monitor/Research-Needed inclusion is
settings-driven, Overview visibility toggle, invalid values (0, 366, etc.)
rejected, and settings persist across a real process restart.

## 9. Deployment preparation (not deployed)

- **Health endpoints** (`server/routes/health.ts`): `GET /health/live`
  (process is up — always 200) and `GET /health/ready` (real `SELECT 1`
  against the database, migration-version check, config-parse check;
  reports HubSpot/Outlook/AI/GitHub/Product Hunt connection state as
  **informational only** — never blocks readiness — plus scheduler
  enabled/running state). Mounted before rate limiting and gating, at bare
  paths (not under `/api`), since orchestrators probe these frequently and
  expect a fast, unauthenticated response.
- **Graceful shutdown** (`server/index.ts`): `SIGTERM`/`SIGINT` now stop
  accepting new connections, stop the scheduler's interval timer
  (`stopScheduler()`), allow in-flight requests to finish (bounded by a 10s
  force-exit timer), close the HTTP server, close the database connection
  (`closeDb()`), flush the legacy KV store, and log the outcome — replacing
  the previous bare `process.exit(0)`.
- **Production start**: `npm start` → `NODE_ENV=production tsx
  --env-file-if-exists=.env server/index.ts`. `server/app.ts` now serves the
  built `dist/` bundle directly when it exists (falling back to a clear 503
  message, never a silent 404, if `NODE_ENV=production` but no build is
  present) — in production there is one process, one origin, no separate
  Vite server.
- **Dockerfile** + **.dockerignore**: multi-stage build (`node:24-slim`) —
  the build stage runs the full verification chain
  (`typecheck && test && lint && build`) before the runtime image is
  assembled; runtime stage copies only `dist/`, `server/`, `shared/`,
  `scripts/`, runs as a non-root `dealradar` user, declares a `VOLUME` for
  the SQLite data directory, `EXPOSE`s only the app port, and a
  `HEALTHCHECK` against `/health/live`. No secret is embedded in the image —
  all credentials are runtime environment variables.
- **Deployment smoke test** (`scripts/smoke-test.ts`, `npm run smoke-test`):
  builds the frontend if missing, starts a real production-mode server
  process on an isolated port with an isolated temp database and
  **deliberately no `ADMIN_PASSWORD`** (to prove the fail-closed behavior),
  polls `/health/live`, checks `/health/ready`, confirms the frontend loads
  and contains the app title, confirms an unauthenticated
  `GET /api/admin/status` returns 401, then stops the server cleanly via
  `SIGTERM` and confirms it exits. **Actually executed in this environment,
  not just written** — full pass confirmed.
- Docker itself: **`docker` is not available in this development
  environment** (`which docker` exits 1). Docker configuration implemented —
  image build not verified in this environment.

## 10. `PLIANCY_SECURITY_REVIEW.md`

New document, written for a security/IT reviewer rather than as marketing:
executive summary, architecture (with a Mermaid component diagram), a
per-flow data-flow inventory (public sourcing, company review, HubSpot sync,
Outlook draft creation, optional AI use, authentication, audit logs,
backups) with a Mermaid data-flow diagram, an external-systems table (every
API this app can call, its real auth method, actual OAuth scopes requested,
and honest live-verified status — every external integration is currently
**not connected in any environment**, stated plainly), a secret inventory
(purpose/storage/rotation/required-or-optional/frontend-exposure — never
values), a security-controls section describing what's actually implemented
and tested, a known-risks section (shared admin password, no per-user
identity, SQLite single-instance limits, the documented DNS-rebinding TOCTOU
window, untested optional integrations, no hosting decision, no completed
Pliancy approval), and eleven specific review decisions requested of
Pliancy. **Makes no claim that any approval has been granted.**

## Tests

+41 tests (242 total, up from 201 across 15 files → 22 files): new
`server/tests/backup.test.ts`, `server/tests/stale-settings.test.ts`, new
`server/tests/scoring.test.ts` and `server/tests/sourcing.test.ts` coverage
for the source-state classification, plus additions to existing suites for
bulk-status validation/permissions/partial-failure/audit history and the
company-refresh-research algorithm. Plus the 26 new Playwright E2E tests
(counted separately, run via `test:e2e`, not `test`).

## Commands (all verified 2026-07-19)

```bash
npm test              # 22 files, 242 tests passing
npm run typecheck      # passing
npm run lint           # 0 errors (2 pre-existing fast-refresh warnings)
npm run build          # passing
npm run test:e2e       # 26/26 Playwright tests passing
npm run smoke-test     # all checks passed (real production-mode process)
npm run db:backup      # creates a real timestamped snapshot
npm run db:list-backups
npm run db:integrity
```

Docker build was not run (`docker` unavailable in this environment) — stated
above, not silently skipped.

---

# Phase 14 — Funding-news (RSS) pipeline: root cause and repair

**Date:** 2026-07-29. **Starting state:** 176 companies, 8 qualified
opportunities, 100% of them SEC-primary. The funding-news adapter had
retrieved 77 candidates and produced **zero** usable opportunities, and the
run report said nothing about why.

## The root cause

A structured field was dropped between two modules.

`leadToEvidence` (`server/sourcing/normalize.ts`) knew each article's real
publication date. It wrote that date into a free-text `notes` string
(`"Published 2026-07-23"`) and set `dateAccessed` to the run time. Downstream,
`candidateToDealEvidence` (`server/services/shortlist.ts`) could only read
`dateAccessed`, and additionally required an exact `YYYY-MM-DD` — so it
compared the run time against itself, concluded there was no publication date,
and `classifyOpportunity` demoted every RSS candidate to `company-lead` with
the reason *"No evidence carries a publication date, so currency cannot be
established."*

That single lost field accounted for 100% of the zero-opportunity outcome. It
was invisible because nothing in the pipeline was required to say why a
candidate had been dropped.

Four further defects were found by the mandated five-candidate trace, each of
which would have blocked most candidates on its own:

| # | Defect | Effect |
|---|---|---|
| 1 | `publishedAt` lost in normalization | every candidate demoted to a lead |
| 2 | Company name = headline prefix before "raises" | produced "Edtech platform", "Travis Kalanick's robotics company" |
| 3 | Only the headline was classified | 3 of 5 traced candidates had no sector |
| 4 | No website resolution at all | nothing could be confirmed as an operating company |
| 5 | One source family (`press`) only | nothing could reach the 2-source corroboration bar |

## What changed

- **`shared/discovery.ts`** — `candidateEvidenceSchema` gains a structured,
  nullable `publishedAt`. `dateAccessed` is now documented as *when we
  fetched it*, which is not a publication date.
- **`server/sourcing/normalize.ts`** — `toIsoDate` normalizes an RFC-822 or
  ISO timestamp to `YYYY-MM-DD`, or returns null. Never guesses.
- **`server/services/shortlist.ts`** — `candidateToDealEvidence` reads
  `publishedAt` first; carries named `investors` through; tier 3 still may
  not assert an amount, a round, or an investor.
- **`server/sourcing/fundingEvent.ts` (new, ~700 lines)** — feed parsing for
  RSS 2.0 *and* Atom using each format's own field names; funding-event
  extraction; 31 named reason codes; company-name validation; deduplication
  and conflict detection. Pure functions, no network, no database.
- **`server/sourcing/adapters/rss.ts` (rewritten)** — 12 feeds across 4
  publishers, per-feed item/event counts and failure rates, reason-code
  tallies in the run detail.
- **`server/services/fundingNews.ts` (new)** — the end-to-end run: website
  resolution from article links then derived domains, approved-publisher
  check, entity check, sector gate, persistence, reclassification. Every
  event either becomes an import or appears in a rejection list with a code.
- **`server/services/issuerQualification.ts`** — independence is now counted
  per *publisher* within the press family, so TechCrunch and SiliconAngle
  reporting the same round are two sources while two syndicated copies of one
  article are one. Also: a blank US state only means "foreign" for sources
  that always record an address (SEC, grants); for a press-derived record it
  means the jurisdiction was not stated.
- **`shared/opportunity.ts`** — a recent accelerator batch is a fundraising
  signal only alongside a *verified operating website*; the three mandated
  accelerator labels are exported and stored on the opportunity record.
- **`src/components/OpportunityBadge.tsx`, `CompanyTable.tsx`,
  `server/routes/imports.ts`, `src/store/companies.tsx`** — publisher,
  event date, verified amount, verified round, named investors, every
  corroborating source, duplicate-event grouping, and conflicting financing
  details are all visible in the existing detail panel. The review queue was
  not rebuilt.
- **`scripts/source-funding-news.ts`, `scripts/corroborate-all.ts` (new)** —
  live verification and second-source discovery.

## Result

| Metric | Before | After |
|---|---|---|
| Companies | 176 | 191 |
| Qualified opportunities | 8 | 17 |
| SEC-primary share | 100% | 47% |
| RSS-primary share | 0% | 53% |
| Sectors with any opportunity | 4 of 7 | 5 of 7 |
| RSS companies with ≥2 independent sources | 0 | 9 |
| Unit tests | 396 | 464 |

## Corrections made during this phase

Two false attributions were created and then removed inside this phase. Both
are recorded here because a silent correction is indistinguishable from a
cover-up:

1. **A false YC corroboration.** `corroborateCompany` matched a
   TechCrunch-reported inference startup called *Infinity* against a YC
   company also called *Infinity* — a different business — and adopted its
   website. `findInYc` now refuses to answer for a common single word, and
   the falsely-attributed evidence row and website were removed.
2. **A misattributed amount.** The merged event's primary `amountText` was
   written onto every article's evidence row, so a TechFundingNews row read
   *"$27M (as stated by siliconangle.com)"*. Each source now records what it
   actually printed; the one stored row affected was corrected.

One pre-existing record was quarantined: **"Travis Kalanick's robotics
company"**, created by the old headline-prefix extractor. It is not a company
name, so no amount of corroboration could ever make it a deal. Quarantined,
not deleted — the article evidence stays auditable.

---

# PHASE 15A COMPLETED (2026-07-29) — Resolve the remaining company-verification problems

Seven records were held as company leads for one reason: no confirmed official
website. Six are now corroborated opportunities. This phase is mostly about
*how* they were confirmed, because the tempting shortcut is the thing that
already produced a wrong answer once.

## The eight records that were investigated

| Record | Website confirmed | Established by | Result |
|---|---|---|---|
| Natural | `https://www.natural.com` | Its own PR Newswire release: "Natural (www.natural.com) is building payments infrastructure for AI agents." | Recent Financing |
| Enigma | `https://www.enigma.inc` | The TechCrunch article on record links to it; the site is Enigma AI Labs, Inc., the robot-AI company the article describes | Recent Financing |
| Multiverse | `https://multiversecomputing.com` | The company's own Series C announcement is hosted on that domain, matching SiliconANGLE's $570M / $1.7B | Recent Financing |
| Antares | `https://antaresindustries.com` | The company's own `/updates/antares-raises-seriesc` page, linked by GovConWire, matching TechCrunch's $470M | Recent Financing |
| Ramp | `https://ramp.com` | Its own PR Newswire release, "Learn more at www.ramp.com"; TechCrunch also links to a post by the co-CEO on that domain | Recent Financing |
| Venus Aerospace | `https://www.venusaero.com` | The TechCrunch article links to it; the site is Venus Aerospace Corp. and its product is the RDRE the article is about | Recent Financing |
| Infinity | `https://infinity.inc` | SiliconANGLE names "Infinity Inc." and links to `infinity.inc`; TechCrunch links to `infinity.inc/research/dmatrix-corsair` | **Unverified — human review** |
| Cascade | — | **No such record exists**, in the live database or in any of the eight backups | Documentation error, corrected |

Two of these were near-misses worth recording. **Antares'** domain is
`antaresindustries.com` while the company is *Antares Nuclear, Inc.* — a
derived domain would never have found it. **Enigma** is `enigma.inc`;
`enigma.com` is an unrelated company, which an earlier automated run had
"confirmed". Each confirmation also states which same-named company it is
*not* (Antares Pharma/Capital, Ramp Network, multiverse.io, the YC Infinity).

**Infinity is not resolved.** Its identity is well evidenced, but every path on
`infinity.inc` returns about eight characters of server-rendered text — the
site renders in the browser. The verifier cannot execute JavaScript, so it
cannot confirm the business operates, and the record sits at
`human-review-required` / `unverified-opportunity` rather than being counted as
a deal.

## What was built

- **`server/services/websiteConfirmation.ts` (new)** — the manual path.
  Requires an official website URL, a supporting evidence URL, and a written
  reason; refuses a page offered as evidence for itself; runs the SSRF guard;
  stores the website with `verified` provenance, adds one undated web-family
  evidence row, re-qualifies live, re-classifies, and writes both URLs and the
  reason into `classification_history`. Preview and confirm are separate
  operations — the preview writes nothing, and the write refuses without an
  explicit `confirmed: true`.
- **`server/routes/imports.ts`, `src/components/WebsiteConfirmation.tsx`,
  `src/lib/api.ts`, `src/components/CompanyTable.tsx`** — the same two steps in
  the dashboard, in the Opportunity-status panel next to the verdict that
  explains why the website matters.
- **`server/db/repos/opportunities.ts`** — `addDealEvidence` now fills a NULL
  `published_at` when the same article is read again with a date, and never
  changes a date already on record. Without this, the Phase 14 parser fix could
  not reach rows the broken parser had already written: dedupe on
  `(company, url, type)` meant re-running sourcing changed nothing, and Natural
  and Enigma were pinned to "no publication date" permanently.
- **`server/services/evidenceDates.ts`, `scripts/backfill-evidence-dates.ts`
  (new, `npm run db:backfill-dates`)** — re-reads the configured feeds and
  writes back the publisher's own `<pubDate>` for undated rows. Nothing is
  inferred from a URL path; an article that has rolled off its feed keeps its
  NULL. Recovered 3 dates (Natural 2026-07-20, Enigma 2026-07-27, and the
  quarantined Kalanick record 2026-07-22).
- **`shared/qualification.ts`, `server/services/issuerQualification.ts`** — a
  site that responds with almost no readable text now reports
  `website-thin-or-client-rendered` instead of `website-parked-or-placeholder`.
  The verdict is unchanged (unverifiable either way); calling a real company's
  real site "parked" was simply false. Found via Infinity.

The single-word guard was **not** weakened. `AMBIGUOUS_NAME_WORDS` is
unchanged, and a regression test asserts `discoverOfficialWebsite('Natural')`
still refuses to guess *after* a human has confirmed Natural's site.

## Result

| Metric | Before | After |
|---|---|---|
| Companies | 191 | 191 |
| Classified opportunities (non-lead) | 35 | 42 |
| Qualified shortlist opportunities | 17 | 23 |
| Qualified operating companies | 30 | 36 |
| Company leads | 156 | 149 |
| Sectors with any opportunity | 5 of 7 | 6 of 7 |
| Unit tests | 464 | 477 |
| Playwright tests | 35 | 38 |

Shortlists after the rebuild: fintech 5/5, sustainability 5/5, robotics 5/5,
ai 5/5, health 2/5, spacetech 1/5, fow 0/5. Every classification change is one
of the seven confirmations; the full requalification pass that followed
reported **0 further changes**, which is the check that the targeted pass and
the full pass agree.

## Known cost of this phase

Press concentration rose from 53% to 65%. Confirming a website promotes a
press-derived record without adding a source family, so the shortlist got
larger and less diverse at the same time. That trade is real and is recorded in
KNOWN_LIMITATIONS.md rather than smoothed over.

---

# PHASE 15B (2026-07-29) — Preserve specific quarantine reasons during requalification

A follow-up to a regression Phase 15A surfaced in its own full
requalification pass.

## Root cause

`scripts/qualify-all.ts` rewrote every disqualified record's
`quarantine_reason` from the fresh qualifier verdict. That is correct for
evidence-based verdicts — "insufficient evidence" *should* be restated as
evidence arrives — but one record carried a finding the qualifier could not
make. `opp-travis-kalanick-s-robotics-company` had a hand-written explanation
that the string is not a company name; the RSS extractor knows this
(`PERSON_POSSESSIVE`, reason code `company-name-is-person`) but
`qualifyIssuer` did not, so every pass replaced the specific finding with a
generic one. The record stayed correctly quarantined and correctly classified
throughout — only the explanation degraded.

## Design

Re-derivation, not memory. Remembering the string would only have moved the
problem: the next pass would still not know *why*.

- `server/sourcing/classify.ts` gains `classifyPossessiveName`, one pure
  detector for both callers, handling straight and curly apostrophes. It
  returns a graded verdict rather than a boolean, because the two callers
  need different thresholds and both are right: a **headline subject**
  containing any possessive names no company ("Kalshi's rival raises $20M"),
  while a **stored legal name** may legitimately own one — McDonald's
  Corporation, Lowe's Companies, Ben's Original, Trader Joe's. Only
  `possessive-descriptor` (lowercase remainder, or a remainder ending in a
  category noun) is a finding on the second path.
- `checkEntityType` returns a structured `kind` alongside its sentence.
- `server/sourcing/fundingEvent.ts` calls the shared detector instead of its
  own copy of the regex, so extraction and qualification cannot drift.
- `shared/qualification.ts` gains the `not-a-company-name` verdict, the
  `name-is-not-a-company` reason code, and `DURABLE_ENTITY_RESULTS` — the
  verdicts that describe the entity rather than the evidence about it.
- `qualifyIssuer` decides `not-a-company-name` first, ahead of the
  public-company check: everything below that line reasons about an entity,
  and this is the branch that says there isn't one. It also skips the website
  fetch and scores operating confidence 0.
- `quarantineReasonFor()` is now the single place a quarantine reason is
  composed, used by both `qualify-all` and the website-confirmation service.
  For an evidence verdict it returns the rolling explanation, which still
  updates on every pass. For `not-a-company-name` it leads with the entity
  sentence, re-derived from the stored name.

No migration. The existing tables already carry everything needed once the
finding is re-derivable.

## Verification

`server/tests/requalification-entity-findings.test.ts` drives the **real
`scripts/qualify-all.ts`** against a throwaway database, offline. A unit test
of `qualifyIssuer` would not have caught the original bug, because the bug was
in what the script did with the verdict afterwards. It asserts the record stays
quarantined and a company lead, that its specific explanation is regenerated,
that a second pass is byte-identical, that an ordinary insufficient-evidence
record still gets its generic reason refreshed, and that seven real
apostrophe-owning company names are not rejected.

481 unit tests, 38 Playwright tests, typecheck, lint, build, `git diff --check`
all clean.

## Live data

One record was re-qualified on the live database, after a verified backup
(`deal-radar-2026-07-29T20-29-59-172Z.db`, 191 companies, schema v8): the
Kalanick record moved from `insufficient-evidence` to `not-a-company-name` and
recovered its specific explanation. Classification (`company-lead`), quarantine
status, and every other record are unchanged; a scan confirmed exactly one of
the 191 stored names matches the detector.
