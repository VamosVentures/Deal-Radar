# Live Readiness

Last verified: 2026-07-29 (Phase 14). Status values are assigned only from
things actually observed in this environment — a real request that actually
succeeded, or the absence of one. Nothing here is aspirational.

**Rule this document follows:** an integration is marked *Live and verified*
only if a real request against a real external system succeeded during
verification. Everything else is labeled by what's actually missing.

| Area | Status | Evidence |
|---|---|---|
| Public live sourcing | **Live and verified** | GitHub public API, SEC EDGAR Form D full-text search, YC public directory, public funding-news RSS, and SBIR/STTR awards API all returned real responses in Phase 3 and again in Phase 8. **Phase 9 adds arXiv**: a real, unstubbed call to `export.arxiv.org` during this session returned 50 real papers for "neural interface" (0 with a listed affiliation — the honest, expected common case). Product Hunt's endpoint is confirmed reachable (a real request returned Product Hunt's own `invalid_oauth_token` error) but not yet run with a real token — see the HubSpot/Outlook/AI row for what that status means. |
| GitHub | **Live and verified** | Dedicated real health check against the GitHub REST API, observed live in the browser (`GITHUB · CONNECTED · GitHub API verified. Rate limit 60/60 remaining, unauthenticated.`). |
| HubSpot | **Implemented — awaiting credentials** | Full client (auth, duplicate-check ladder, create/update, associations, notes, search, pipeline mapping, sync history + retry queue) is implemented and covered by tests against a *stubbed* API. No `HUBSPOT_ACCESS_TOKEN`/OAuth app is configured in this environment, so it has never been exercised against a real HubSpot portal. Also requires the `vamos_*` custom properties to exist in the target portal before first use. Connect/disconnect/pipeline-mapping/retry actions are now gated behind admin sign-in (Phase 9). |
| Outlook | **Implemented — awaiting credentials** | Full Microsoft Graph OAuth + drafts-only client is implemented and tested against a stubbed Graph API. No `MICROSOFT_*` app registration or `SESSION_SECRET` is configured, so it has never created a real draft in a real mailbox. There is no send path in the codebase by design. Connect/disconnect are now gated behind admin sign-in (Phase 9); saving/reading drafts stays open to any reviewer. |
| AI scoring | **Implemented — awaiting credentials** | Refers to the AI-provider-backed features (outreach draft generation, AI portfolio-comparison analysis) — no `AI_PROVIDER`/API key is configured, so drafts currently come from the labeled deterministic local template. **Note:** the core Vamos Fit Score (`src/lib/scoring.ts`) is a deterministic weighted model, not an AI call — it is live and running regardless of AI-provider credentials; it is listed for completeness under this row's evidence, not as blocked by it. |
| Database | **Live and verified** | SQLite (`node:sqlite`, WAL) confirmed working end-to-end: a real company was created via `POST /api/companies/import-csv`, read back via `GET /api/companies/imported`, its status updated via `POST /api/companies/:id/status`, and the change was visible in the running UI — all against the real file-backed database, not a mock. |
| Scheduled sourcing | **Partially implemented** | The on-demand path is live-verified: a real schedule was saved via the UI and triggered with "Run sourcing now," which ran the real discovery pipeline against live sources and returned a real result. What is **still not** verified: the autonomous timer-driven cadence (`RUN_SCHEDULER=true` on a continuously hosted process) has never run unattended in this environment, since local dev restarts frequently and no continuous host exists yet. **Phase 9 change:** the administrator-only gate is now real and server-enforced (`requireAdmin`, live-verified in the browser: wrong password rejected, correct password admits, sign-out re-locks) — this row's "partial" status is now purely about the untested autonomous cadence, not about authorization. |
| Per-company live research refresh | **Live and verified** | `POST /api/companies/:id/refresh-research` (Phase 10) genuinely re-queries company-level-capable public sources, merges evidence, and recomputes the score — covered by tests (new evidence, no changes, conflicts, partial/full source failure, dedup, score recalculation, evidence-history preservation, budget enforcement) and exercised via the Playwright `companies.spec.ts` suite against a real backend. |
| Database backup and restore | **Live and verified** | `npm run db:backup` produces a real `VACUUM INTO` snapshot with a metadata sidecar; `npm run db:restore -- <file> --yes` was run against a real isolated database in this environment and produced the expected records back, with automated tests additionally covering invalid-file rejection, the automatic pre-restore safety backup, and overlapping-request rejection. |
| Playwright E2E suite | **Live and verified** | `npm run test:e2e` — 26/26 tests passing in this environment against a fully isolated backend/frontend/SQLite stack (dedicated ports, temp-directory database, test-only credentials). Discovery's spec intercepts every sourcing network call, so no real third-party API traffic occurs during these runs. |
| GitHub Actions CI | **Implemented — not yet exercised on GitHub** | `.github/workflows/ci.yml` exists and mirrors the exact command chain verified locally (typecheck/lint/test/build/e2e), but this environment has no ability to push to GitHub and trigger an actual Actions run — the workflow's YAML has been validated for syntax, and every command it runs has been run successfully locally, but the workflow itself has not executed on GitHub's infrastructure. |
| Health endpoints / graceful shutdown / production start | **Live and verified** | `npm run smoke-test` was actually executed in this environment against a real `NODE_ENV=production` process: `/health/live` and `/health/ready` both responded correctly, the built frontend was served from the backend process, an unauthenticated `GET /api/admin/status` returned 401, and `SIGTERM` produced a clean shutdown. |
| Docker image build | **Blocked — not verified in this environment** | `Dockerfile` and `.dockerignore` are implemented, but `docker` is not installed in this development environment (`which docker` exits 1). Docker configuration implemented — image build not verified in this environment. |
| Cloud deployment | **Blocked** | The app has never been deployed anywhere outside this local dev machine. Blocked on: (1) authentication is real but is a single shared password, not per-user accounts — acceptable for a small team, worth revisiting before a larger one; (2) no hosting target has been chosen or configured; (3) SQLite-on-local-disk needs a real backup/durability story (the Phase 10 backup tooling covers local snapshots, but there is no offsite/cloud copy yet); (4) `PLIANCY_SECURITY_REVIEW.md` has been written but **no security approval has been granted** as of this document. |

## What "verified" means here, concretely

- **Public live sourcing / GitHub**: real HTTP calls to public APIs, whose
  results were displayed in the running app (not asserted only in a test
  mock). arXiv was verified the same way, directly against the real adapter
  code, outside the test suite's stubbed fetch.
- **Database**: a real row written to and read back from the on-disk SQLite
  file via the actual HTTP API and observed in the browser.
- Nothing involving HubSpot, Outlook, or an AI provider has been marked live
  because no credentials for those services exist in this environment — the
  code paths are real and tested against stubs, but a stub is not a real
  request.

---

## Funding-news (RSS) — Live and verified, 2026-07-29

Marked live on the strength of a real import, not a passing test suite. The
run that established this fetched 12 public feeds, retrieved **241 articles**,
extracted **38 funding events**, merged **11 duplicate articles**, and
imported **15 new companies** — 9 of which are visible in the browser as
`Recent Financing` opportunities with two or more independent sources.

| Feed | Publisher | Robots | Observed |
|---|---|---|---|
| `/category/venture/feed/` | techcrunch.com | allows | 19 items → 5 events |
| `/category/startups/feed/` | techcrunch.com | allows | 18 items → 5 events |
| `/category/artificial-intelligence/feed/` | techcrunch.com | allows | 20 items → 4 events |
| `/category/fintech/feed/` | techcrunch.com | allows | 20 items → 2 events |
| `/category/climate/feed/` | techcrunch.com | allows | 20 items → 4 events |
| `/category/space/feed/` | techcrunch.com | allows | 20 items → 1 event |
| `/category/robotics/feed/` | techcrunch.com | allows | 20 items → 3 events |
| `/category/enterprise/feed/` | techcrunch.com | allows | 20 items → 1 event |
| `/category/transportation/feed/` | techcrunch.com | allows | 20 items → 1 event |
| `/feed/` | techfundingnews.com | allows | 10 items → 5 events |
| `/feed/` | siliconangle.com | allows | 30 items → 5 events |
| `/feed` | sifted.eu | allows | 24 items → 2 events |

A ~85% "not a financing event" rate is the expected, healthy figure: most of
what a startup publication writes is not a funding announcement, and the
pipeline now says so per article rather than dropping it silently.

**Feeds deliberately excluded, with the reason** (an honest gap beats a
silently broken source):

| Feed | Reason |
|---|---|
| tech.eu | `robots.txt` disallows `/feed` |
| eu-startups.com | `robots.txt` returns 403 — permission unverifiable |
| finsmes.com | 403 to automated readers |
| axios.com | 403 to automated readers |
| news.crunchbase.com | reachable, but Crunchbase is a `RESTRICTED_SOURCE` for this project and the rule is not bent for its editorial arm |
| venturebeat.com | reachable and permitted, but produced 0 funding events across a full feed — it does not cover rounds |
| businesswire.com | the subject page is not a feed |

**No credential is required for any of this.** RSS must not be added to the
Pliancy access request.
