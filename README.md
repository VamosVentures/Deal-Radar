# Vamos Deal Radar

Internal sourcing dashboard for VamosVentures. Discover early-stage companies, organize them by vertical, rank them against the firm's thesis with a fully auditable score, surface likely stealth founders from public signals, and track outreach — with verified-only demographic data and human-in-the-loop contact baked into the code, not just the docs.

**No demo data.** The app ships empty: there are no bundled sample companies, no seeded stealth leads, and no mock integrations. Companies enter only through validated CSV imports or Deal Discovery; an integration without credentials is simply *not connected* and every action against it fails with an honest error.

**Read next:** [`TECHNICAL_HANDOFF.md`](TECHNICAL_HANDOFF.md) for a full engineering walkthrough, [`LIVE_READINESS.md`](LIVE_READINESS.md) for what's actually been verified against real external services, and [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) — most importantly, **authentication is a single shared admin password, not per-user accounts** — for everything else that needs attention before a shared deployment.

## Run it

```bash
npm install
npm run dev        # web (http://localhost:5173) + API (http://localhost:8787) together
npm run dev:web    # frontend only
npm run dev:server # backend only
npm test           # backend + integration test suite (vitest)
npm run lint       # oxlint
npm run typecheck  # tsc -b (app + node + server projects)
npm run build      # type-check + production build
npm run preview    # serve the production build
```

No `.env` is needed to boot — the app starts with everything disconnected and says so. Copy `.env.example` to `.env` and add credentials to bring integrations live.

Stack: Vite + React 19 + TypeScript, Tailwind v4, React Router, Recharts, Zod; backend: Express + Zod on Node/TS (tsx), vitest + supertest.

## Architecture

```
React frontend (no secrets, no tokens — ever)
   │  /api/* (Vite dev proxy → Express)
   ▼
Express backend — owns ALL credentials via .env
   ├─ server/routes/     one router per domain (status, hubspot, outlook,
   │                     ai, outreach, refresh, discovery, stealth,
   │                     schedule, portfolio, imports)
   ├─ server/services/   business logic + live API clients
   ├─ server/db/         SQLite client, migrations, repositories (primary datastore)
   ├─ server/sourcing/   pluggable discovery adapters, normalize/dedupe/enrich
   ├─ server/lib/        http (timeout/retry/DNS-aware SSRF guard), crypto, auth (admin sessions), audit/redaction, error sanitization
   └─ shared/            Zod schemas validated on both sides of the wire
```

- **Admin authentication** (`server/lib/auth.ts`) — a single shared `ADMIN_PASSWORD` gates a real, signed, HttpOnly session cookie in front of every administrator-plane action (scheduled sourcing, connector management, refresh runs, HubSpot/Outlook connect-disconnect). Unset → those actions are unusable, not open. Company-review actions and CRM/outreach actions stay open to any reviewer, by design.
- **HubSpot** (`server/services/hubspot.ts`) — private-app token or OAuth (state-validated, AES-256-GCM token storage, auto-refresh); duplicate check, pipelines, company/contact/deal sync with associations, notes, search. Not connected → `503 not_connected` with instructions.
- **Outlook** (`server/services/outlook.ts`) — Microsoft Graph OAuth; **drafts only, there is no send path anywhere in the codebase**. Not configured → honest not-connected status and errors.
- **AI** (`server/services/ai.ts`, `analysis.ts`) — Anthropic or OpenAI when configured; otherwise a deterministic **local template** builds drafts from verified facts only and is labeled "Local template — no AI model". Every provider's output (live or local) passes a fact guard that rejects invented funding amounts, accelerators, traction claims, and statistics.
- **Discovery** (`server/services/discovery.ts` + `server/sourcing/`) — a modular sourcing layer with separated responsibilities: adapters (`sourcing/adapters/`), response validation, evidence/company normalization, dedup, cross-source enrichment, run logging, and typed error states. Live adapters: **SEC EDGAR Form D filings** (official full-text-search API), **public funding-news RSS** (headline-stated fundings only — no guessing), **SBIR/STTR government awards** (official API), **GitHub** (official API, engineering signal), **arXiv** (public research publications — a weak signal, real only when a paper lists an author affiliation), and the **YC public directory**. **Product Hunt** is implemented but requires `PRODUCTHUNT_TOKEN`. Sources without a live adapter return **zero results and say so** — nothing is simulated, and a failed source never falls back to sample data. LinkedIn/PitchBook/Crunchbase requests are rejected with 422; they are never scraped.
- **Stealth Founder Radar** — starts empty. Signals come only from authorized public sources or explicit manual entry (a pasted public-profile URL is stored as evidence, never crawled). Hypotheses are deterministic, built only from recorded signal fields, permanently labeled *Hypothesis · Unverified · Requires human review*, and structurally exclude names, schools, locations, and networks.
- **Datastore** — SQLite (`node:sqlite`, WAL mode) at `server/.data/deal-radar.db` (gitignored), with versioned forward-only migrations (`server/db/migrations.ts`) applied automatically on boot; `:memory:` in tests. Fine for one team on one machine; swap for Postgres before a multi-instance deployment.
- **Scheduled sourcing** (`server/services/schedule.ts`) — administrators configure enabled sources, cadence, vertical/stage/geography focus, keywords, max results, evidence-recency threshold, and stale-refresh age; a persisted overlap lock means only one run (manual, scheduled, or an admin's "Run sourcing now") executes at a time. Every run's start/end time, sources queried, results retrieved, companies created/updated, duplicates identified, and errors are persisted and shown in Settings. Runs server-side — no browser tab needs to stay open — but the automatic cadence only fires when `RUN_SCHEDULER=true` on a continuously hosted backend; otherwise it's "Configured but inactive."
- **Company status** — a simple 7-value lifecycle (New, Awaiting Review, Research Needed, Approved for HubSpot, Synced to HubSpot, Monitor, Passed) plus a computed "Stale" overlay for anything non-terminal left untouched past 30 days. This is deliberately not a CRM: a reviewer can Refresh, send for more research, Monitor, Pass, or Approve for HubSpot — nothing more.

## Data rules (enforced in code)

- **Demographic indicators are verified or absent.** They cross the wire only with a self-identification basis, a named source, a source URL/identifier, and a verification status (Zod-rejected otherwise). Identity columns in CSV imports are refused outright (422). Nothing is ever inferred.
- **Every company needs at least one sourced evidence item** — CSV and discovery imports are validated server-side.
- **No automated outreach.** The only mail action is *Save to Outlook Drafts*; a person sends from Outlook and marks it sent (or confirms via an explicit draft-status check).
- **Policy exceptions flag, never reject.** DeFi/blockchain, hardware-heavy, and off-thesis companies keep their score and carry a visible warning routed to partner review.
- **Honest empty states.** When data is unavailable the UI says so ("No companies are on record yet", "This integration is not connected") — it never shows fake records to look populated.

## Vamos Fit Score — v3.0

100-point weighted model in `src/lib/scoring.ts`: thesis/vertical fit 20, stage fit 15, mission alignment 15 (verified identity only), traction signal 10, founder & team evidence 10, geography 10, funding evidence 5, accelerator/institutional validation 5, evidence quality 5, evidence recency 5 — displayed as 1.0–10.0 with a full point-by-point rationale in the UI, plus a separately-tracked **evidence confidence** percentage (how well-sourced the record is, independent of fit) and a versioned snapshot so past scores stay interpretable if the model changes. Invariants are tested in `server/tests/scoring.test.ts`.

## Going live

0. **Administrator sign-in**: set `ADMIN_PASSWORD` in `.env`, then sign in from Settings before using any admin-only action — without it, those actions are unusable.
1. **HubSpot**: private-app token (`HUBSPOT_ACCESS_TOKEN` + scopes `crm.objects.companies/contacts/deals` read+write, notes write) or OAuth app (`HUBSPOT_CLIENT_ID/SECRET/REDIRECT_URI`). Set `HUBSPOT_PORTAL_ID` for deep links. Create the `vamos_*` custom properties on the **Company** object before syncing — `vamos_deal_radar_id`, `vamos_deal_radar_url`, `vamos_vertical`, `vamos_subcategory`, `vamos_stage`, `vamos_accelerator`, `vamos_funding_raised`, `vamos_date_first_surfaced`, `vamos_last_refresh`, `vamos_primary_source`, `vamos_policy_exception`, `vamos_fit_score`, `vamos_recommendation`, `vamos_score_breakdown`, `vamos_rationale`, `vamos_risks`, `vamos_score_explanation`, `vamos_reviewer`, `vamos_approval_date`, `vamos_source_urls`, `vamos_evidence_quality`, `vamos_sourcing_status`, `vamos_date_surfaced`, `vamos_next_action`, `vamos_relationship_owner` — plus on **Contact**: `vamos_info_source`, `vamos_verification_status`, `vamos_relationship_owner`, `vamos_last_outreach_date`, `vamos_verified_demographics`. Map pipeline stages under Data Sources → HubSpot → Pipeline mapping — **submissions are blocked until every used status is mapped; stage IDs are never guessed**.
2. **Outlook**: Entra app registration with delegated `Mail.ReadWrite`, `User.Read`, `offline_access`; set `MICROSOFT_*` vars and a strong `SESSION_SECRET` (encrypts tokens at rest).
3. **AI**: `AI_PROVIDER=anthropic|openai` + an API key (+ optional `AI_MODEL`).
4. **Scheduler**: `RUN_SCHEDULER=true` only on a continuously hosted backend; otherwise schedules are stored configuration labeled "Configured but inactive".

## API

All routes under `/api` (JSON, rate-limited, CORS-restricted, sanitized errors). Mutating routes accept an `Idempotency-Key` header; a repeated key within 2 minutes returns `409 duplicate_submission`. Actions against unconnected integrations return `503 not_connected` with setup hints.

## Testing

`npm test` — 242 tests across 22 suites. Integration mocks (in-memory HubSpot/Outlook) and fictional discovery candidates live **only under `server/tests/`** (`mocks/`, `fixtures/`) and are injected through test-only hooks (`__set*ForTests`); the running application never uses them. Covered: duplicate detection, payload builders, identity-guardrail rejection (HTTP + schema), pipeline mapping (blocked-without-mapping, not-connected 503), Outlook draft validation and token-expiry handling, forged-OAuth-state rejection, generation determinism + fact-guard, discovery pipeline (budgets, dedupe, merge-evidence, selective import, overlap lock, evidence-recency/stale-only filters), persistence/normalization, scoring invariants, stealth guardrails, portfolio analysis, the scheduled-sourcing run-log and run-now flow, the company-status lifecycle, admin authentication (login/logout/session/fail-closed), DNS-aware SSRF guard, redaction/error-sanitization security units, the arXiv and Product Hunt adapters, database backup/restore, configurable stale-record settings, source-quality analytics, and the full workflow over HTTP.

### End-to-end tests (Playwright)

`npm run test:e2e` (or `npm run test:e2e:ui` for the interactive runner) drives a real Chromium browser against a fully isolated backend + frontend + SQLite database — dedicated ports, a temp-directory database file, and test-only `ADMIN_PASSWORD`/`SESSION_SECRET` values, all defined in [`e2e/env.ts`](e2e/env.ts). Nothing here can touch a developer's local `.env` or database. Discovery's spec intercepts every sourcing network call (`page.route()`) so no real third-party API is ever contacted during a browser test. Covers: the admin login gate and 401s on protected API routes (`e2e/auth.spec.ts`), the discovery search → review → import flow with an honest empty state (`e2e/discovery.spec.ts`), the company review queue — filters, detail view, status actions, possible-duplicate resolution (`e2e/companies.spec.ts`), Settings — honest source states, sourcing history, schedule configuration (`e2e/settings.spec.ts`), and desktop/small-laptop/mobile navigation and review actions (`e2e/responsive.spec.ts`).

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and every push to `main`: `npm ci`, typecheck, lint, `npm test`, `npm run build`, then a Playwright browser install and `npm run test:e2e`. No workflow secrets are required — the E2E harness is self-contained. The Playwright HTML report uploads as a build artifact on every run (pass or fail) for post-mortem review.

## Known limitations

See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) for the full, current list. Most important:

- **Authentication is a single shared admin password** (`ADMIN_PASSWORD`), not per-user accounts — do not treat it as sufficient for a larger team without adding real user identity.
- Live HubSpot/Outlook/AI paths are implemented and tested against stubs, but have never been exercised against real external services from this environment — see [`LIVE_READINESS.md`](LIVE_READINESS.md).
- A few discovery sources (accelerator sites, patent databases, hackathons, state registries, licensed data) have no adapter yet and honestly return zero results; arXiv and Product Hunt were added and are real (Product Hunt awaits a token).
- The SSRF guard (`isSafeExternalUrlResolved`) is now DNS-resolution-aware but the resolved address isn't pinned for the fetch that follows, so a narrow window remains.
- Replies are tracked manually; the draft-status check confirms *sent*, not *replied*.
