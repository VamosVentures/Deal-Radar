# Hosted pilot — deployment readiness

**Status: BLOCKED — external configuration required.**

Verified 2026-08-06 against the current worktree (branch `frontend-redesign`, schema v20).

The local pilot is ready and documented in [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md). A hosted
pilot of the **real application and real data is not deployed**, and was not attempted,
because the security prerequisites for hosting real deal and founder data are not met.
Nothing in this document is a to-do list for the app code — every remaining item needs an
administrator with authority this session does not have.

**Separately**, a protected demo *preview* — synthetic data only, fully static, no backend,
no database — was built and deployed this session for documentation/team-demo purposes. See
§8. **Do not confuse the two.** The demo preview proves the UI and screenshots; it proves
nothing about the real hosted pilot's readiness, which remains blocked exactly as described
below.

---

## 1. Why this is blocked, in one paragraph

The only authentication that currently works is a **single shared administrator password**
(`ADMIN_PASSWORD`). Microsoft Entra ID sign-in is fully implemented in the codebase but
**not configured** — no tenant, client id, client secret, or redirect URI exists. Because
`AUTH_MODE` defaults to `auto`, `effectiveAuthMode()` resolves to `local` whenever Entra is
incompletely configured (`server/env.ts:195-202`), so the shared password is the live
mechanism. A shared password is acceptable for a laptop pilot and is **not** acceptable
authentication for a hosted application holding sourced company and founder records.

Separately, the datastore is a **single SQLite file** (`server/db/client.ts`). That is the
right choice for a local pilot and the wrong one for a hosted multi-user deployment on
ephemeral compute, where the file is destroyed on redeploy.

---

## 2. Prerequisite checklist

Each row is the gate stated for a hosted pilot, and what is actually true today.

| # | Prerequisite | Status | Evidence |
|---|---|---|---|
| 1 | Vamos-controlled private environment | **ABSENT** | No hosting configuration in the repo. Only `.github/workflows/ci.yml` (test/build CI) and a `Dockerfile`. No `vercel.json`, no infra manifests, no environment references. |
| 2 | Microsoft Entra ID authentication | **IMPLEMENTED, NOT CONFIGURED** | Code exists (`server/lib/microsoftAuth.ts`, `MICROSOFT_*` in `server/env.ts:20-38`). No `MICROSOFT_*` variable is set in the local environment; only `ADMIN_PASSWORD` and `SESSION_SECRET` are. |
| 3 | Access restricted to approved `@vamosventures.com` accounts | **ABSENT** | `MICROSOFT_ALLOWED_EMAIL_DOMAIN` defaults correctly to `vamosventures.com`, but it is a *secondary* check and is unreachable until #2 is done. The tenant id is the real restriction and is unset. |
| 4 | No production `ADMIN_PASSWORD` fallback | **NOT MET** | `effectiveAuthMode()` returns `local` today. The password is the only way in. |
| 5 | HTTPS | **ABSENT** | No hosting environment, so no TLS terminator. |
| 6 | Secure session cookies | **PARTIAL** | The session cookie is HMAC-signed and `httpOnly` (`server/lib/auth.ts`). `secure` and `sameSite` behaviour under a real HTTPS origin has not been exercised, because there is no such origin. Must be re-verified after #1/#5. |
| 7 | CSRF protection where applicable | **NEEDS VERIFICATION** | Not verifiable without a deployed cross-origin setup. |
| 8 | Appropriate session expiration | **PARTIAL** | A 12-hour expiry is used by the E2E session fixture. `SESSION_SECRET` is *optional*; when unset it is randomised per process (`server/env.ts:264-270`), so a restart silently invalidates every session — acceptable locally, not for hosted use. It must be a managed secret. |
| 9 | Durable database / managed database | **NOT MET** | Single SQLite file. Ephemeral on serverless compute; destroyed on redeploy. |
| 10 | Working backend/API deployment | **NOT MET** | Historically a Vercel deployment served only the static frontend and every API route returned 404. That deployment must not be repeated. |
| 11 | Persistent migration state | **NOT MET** | Migrations run on database open (`runMigrations`), so state persists only as long as the file does. Follows from #9. |
| 12 | Backups and a tested restore path | **MET LOCALLY, NOT HOSTED** | `npm run db:backup` / `db:restore` work and the restore path was tested this session (see §5 of the final report). There is no hosted backup target. |
| 13 | Secrets only via the provider's secret system | **N/A UNTIL #1** | Locally secrets live in `.env`, which is gitignored and was not committed. |
| 14 | Least-privilege access | **ABSENT** | No environment, no roles. Note the app has exactly one privilege level today (shared admin), so least-privilege is not expressible until #2 provides identities. |
| 15 | No public exposure of deal or founder data | **ENFORCED IN CODE** | Every API route is behind the session gate (`server/app.ts`); `PUBLIC_API_PATHS` is a short allowlist. Verified locally: an unauthenticated request to an admin route returns 401 (`npm run smoke-test`). |
| 16 | Health and readiness endpoints | **MET** | `/health/live` and `/health/ready` exist and pass; `/health/ready` withholds diagnostics from anonymous callers. |
| 17 | Clear rollback mechanism | **NOT MET** | No deployment, so no rollback. Locally, `npm run db:restore` is the data rollback and takes an automatic safety backup first. |
| 18 | No uncontrolled usage-based API spend | **LOW RISK** | Every sourcing adapter used is a key-free public endpoint; the controlled run this session cost **$0.00** and made 23 requests. AI provider keys are optional and unset. Per-run request budgets are enforced (`RequestBudget`). |

**Met: 3 of 18** (#15, #16, #18). Partially met: #6, #8, #12. Absent or not met: the rest.

---

## 3. What is needed, and from whom

### 3.1 Microsoft Entra application registration — needs a Microsoft 365 / Entra administrator

Someone with **Application Administrator** or **Global Administrator** on the
`vamosventures.com` tenant must register the application. This session cannot and did not
do this: registering a tenant application is an act of authority over the firm's identity
system.

Required afterwards, as environment variables (names exactly as the code reads them,
`server/env.ts`):

| Variable | What it is |
|---|---|
| `MICROSOFT_TENANT_ID` | The Vamos tenant **GUID**. Not `common`, not `organizations` — a concrete GUID is what actually restricts sign-in to the firm. |
| `MICROSOFT_CLIENT_ID` | Application (client) id of the registration. |
| `MICROSOFT_CLIENT_SECRET` | Client secret. Store only in the host's secret manager. |
| `MICROSOFT_SSO_REDIRECT_URI` | Must exactly match a **Redirect URI** registered on the app, and must be `https://`. |
| `MICROSOFT_ALLOWED_EMAIL_DOMAIN` | `vamosventures.com`. Already the default; set it explicitly so it is visible in the environment. |
| `AUTH_MODE` | Leave at `auto`, **or** set `microsoft` to refuse the password fallback outright. See the note below. |
| `SESSION_SECRET` | A managed random value ≥16 chars. Required so sessions survive a restart. |
| `DATABASE_FILE` | Path on durable storage, or replaced entirely — see §3.2. |

Redirect URI requirements: register the exact `https://<host>/api/auth/microsoft/callback`
value the deployment will use (confirm the path against `server/routes/` before registering
— a mismatch fails the OAuth exchange with an opaque error). Platform type: **Web**. Grant
`openid`, `profile`, `email` delegated permissions.

**A deliberate note on `AUTH_MODE`.** `auto` was designed so the password stops working the
moment Entra is fully configured, without anyone remembering to flip a flag — that is good
design for the local-to-SSO transition. For a **hosted** deployment, set `AUTH_MODE=microsoft`
explicitly anyway. Under `auto`, if an Entra variable is ever removed or mistyped, the app
degrades to the shared password rather than failing closed, and on a public host that
degradation is a silent authentication downgrade. `microsoft` also degrades to `local` when
Entra is incompletely configured (`server/env.ts:201`), so **this must be re-verified after
deployment** with the negative test in §4 — do not assume the variable alone closes it.

### 3.2 Durable database — needs an infrastructure decision and budget approval

SQLite-on-a-file must not be hosted as-is. Two viable paths; **neither may be started
without explicit approval**, since both may incur cost:

1. **A managed Postgres** (or equivalent) plus a repository migration. Highest effort — the
   whole data layer is `node:sqlite` — but the only option that fits a normal multi-user
   hosted service.
2. **A single small VM or container with a persistent volume**, keeping SQLite. Far less
   code change; the volume is the durability guarantee and must be backed up on a schedule.
   Appropriate for a pilot with a handful of users.

Option 2 is the smaller step and matches the pilot's actual scale. It is still an
infrastructure and spending decision, not a code decision.

### 3.3 The environment itself — needs whoever owns Vamos infrastructure

A private, Vamos-controlled host with HTTPS, secret storage, and a rollback mechanism.

---

## 4. Verification checklist to run *after* the above is configured

Do not treat the deployment as done until every line passes. The first four are the ones
that actually matter.

```bash
# 1. Unauthenticated access is denied (expect 401/302, never 200 with data)
curl -si https://<host>/api/companies/imported | head -1

# 2. No data route is public
curl -si https://<host>/api/overview/kpis | head -1

# 3. Health checks answer
curl -s https://<host>/health/live
curl -s https://<host>/health/ready

# 4. The password fallback is genuinely closed
#    Expect a refusal. If this returns a session cookie, AUTH_MODE degraded
#    to `local` and the deployment is NOT secure — stop and fix §3.1.
curl -si -X POST https://<host>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"anything"}' | head -1
```

Then, interactively:

- [ ] An approved `@vamosventures.com` account can sign in via Entra.
- [ ] A **non-approved** domain account is denied (test with a personal Microsoft account).
- [ ] Backend APIs return real data once signed in.
- [ ] A write persists: change a review status, then confirm it after a **redeploy**, not
      just after a page refresh. This is the test that catches ephemeral storage.
- [ ] Session cookie carries `Secure`, `HttpOnly`, and a sane `SameSite` under HTTPS.
- [ ] `npm run db:backup` produces a file on durable storage, and a restore has been
      rehearsed against a copy.
- [ ] Deal and founder data appear nowhere in an unauthenticated response body.

## 5. Rollback

- **Application:** the host's previous-revision rollback. Confirm it exists and has been
  exercised once before the pilot carries real review work.
- **Data:** `npm run db:restore -- <backup-file>`. It validates the file header, takes an
  automatic safety backup of the current database first, runs `PRAGMA integrity_check`, and
  rolls itself back if that check fails. This path was tested this session against an
  isolated copy: a database damaged by 50 deleted rows restored to its full 209.

## 6. Estimated sequence

No dates — every step below is gated on someone else's availability, and inventing a
schedule would be fiction.

1. Entra app registration (Entra administrator).
2. Hosting + durable storage decision and approval (infrastructure owner + budget).
3. Provision the environment, load secrets through the host's secret manager.
4. Deploy backend **and** frontend; confirm `/api` and `/health` respond on the host.
5. Run §4 in full, including the negative tests.
6. Rehearse backup/restore against the hosted database.
7. Only then invite pilot users.

## 7. What was explicitly not done, and why

- No paid account was created and no charge was incurred.
- No Microsoft tenant or application was registered — that requires authority over the
  firm's identity system.
- No credentials were requested through chat, and none were extracted from the local
  environment into any file, log, or report.
- Authentication was not weakened anywhere to make a deployment possible.
- No deal data was deployed publicly.
- The earlier static-frontend-only Vercel deployment was not repeated, and a static
  deployment is not treated here as a working hosted application.

## 8. Is Vercel appropriate for the *real* hosted pilot?

Vercel is not assumed to be the only option, and the answer changes depending on what "the
real hosted pilot" actually needs once #2 (durable database) is decided. Evaluated fresh
against the current architecture (Express API + `node:sqlite`, both in `server/`):

**What Vercel handles well, unmodified:**
- The static frontend build (`vite build`) — this is exactly what Vercel's Vite framework
  preset already deploys correctly (confirmed working for the demo preview in §9).
- Preview Deployments with Vercel Authentication / password protection for pre-launch review
  — used for the demo preview in §9, and equally usable for a real-data preview once auth and
  storage are fixed, before inviting real users.
- Secret management via the project's Environment Variables (separate values per
  Production/Preview/Development) — a reasonable home for `MICROSOFT_*`, `SESSION_SECRET`,
  and `HUBSPOT_*` once they exist, provided they are entered directly in the dashboard/CLI,
  never committed.

**What does not fit as-is, and why:**
- **The backend is a long-running Express process with an in-process interval scheduler**
  (`server/services/schedule.ts` — `setInterval`, checked hourly). Vercel's compute model is
  serverless functions that start per-request and do not persist a timer between invocations.
  Deployed to Vercel unmodified, the scheduler simply never fires — this is the same defect
  the prior static-only Vercel deployment had in a different form (§1's note that "every API
  route returned 404" was the front end deployed without the backend at all; even *with* the
  backend deployed as functions, this specific in-process loop still would not survive).
- **`node:sqlite` is a single file on local disk.** Vercel's serverless filesystem is
  ephemeral and read-only outside `/tmp`, and `/tmp` does not persist or share across
  invocations or regions. This is the datastore problem §2 already identifies; Vercel does
  not change which of the two options there (managed Postgres, or a small persistent-volume
  host) is right — it only rules out "keep SQLite and put it on Vercel," which was never a
  viable option on *any* serverless platform, not specifically this one.

**If Vercel remains the proposed host after #2 is decided, the concrete adaptation is:**
1. Convert `server/index.ts`'s Express app into Vercel Serverless (or Edge, if the crypto/DB
   calls are compatible) Functions — typically one catch-all function wrapping the existing
   Express app via a request adapter, not a rewrite of the route handlers themselves.
2. Replace the in-process scheduler with **Vercel Cron Jobs** (`vercel.json` `crons`), calling
   a dedicated `/api/cron/sourcing` route that runs one discovery pass and returns — cron
   invocations on Vercel are still subject to a function's execution-time limit, so a single
   sourcing run must complete (or checkpoint) within that window, which the existing budget
   caps (`MAX_RESULTS_PER_RUN`, per-run API/model/token limits) already keep small.
3. Point `DATABASE_FILE` at whatever #2 resolves to — a managed Postgres connection string
   (requiring the `node:sqlite`-based repository layer to be ported to a Postgres client) or,
   for the smaller-effort path, a persistent volume on a non-serverless compute tier that
   Vercel does not itself provide (i.e., Vercel would then host only the frontend/functions,
   with the database living elsewhere — worth naming explicitly rather than assuming one
   provider must do both).
4. Re-run the full §4 verification checklist against the adapted deployment, including the
   redeploy-durability write test — a passing demo preview (§9) proves none of this, since it
   has no backend or database to fail.

None of the above was implemented or provisioned this session — it is an assessment, not a
migration, and every step still depends on #1 (Entra) and #2 (database/hosting decision)
being made by someone with that authority first.

## 9. This session's protected demo preview — what it is and is not

A separate, read-only **demo** build (`VITE_DEMO_MODE=true`) was deployed as a Vercel
**Preview** deployment under the existing, already-authorized `vamos-ventures/deal-radar`
project (`prj_z9zKeT1Eff2iRRs3pzddL3poc0kr`) — not production, and not a new project.

**URL:** `https://deal-radar-nr9mpczv6-vamos-ventures.vercel.app`
**Deployment:** `dpl_DPw8ReWdYBH1n8iPWdP8F8M8iJsJ` — `target: null` (Preview, not Production),
`functions: none` (confirmed via the Vercel API — purely static, no serverless compute).
(An earlier deployment of the same build, `dpl_5Jrf8nkHJJbt581Q5vA11XYbqi2Z`, is superseded —
see the auto-sign-in note below.)

It is:

- **Fully static.** No Express backend, no database, no server secrets, and no outbound
  network calls of any kind — every screen renders from bundled synthetic fixtures.
- **Protected.** Vercel Authentication (Deployment Protection) was enabled this session,
  scoped to Preview deployments only (Production is untouched). Verified with `curl`:
  every path tested — `/`, `/index.html`, and a built JS asset under `/assets/` — returns
  **302** to `vercel.com/sso-api`, never 200 with content, for an unauthenticated caller.
- **Auto-signed-in on load.** Because Vercel Authentication in front of the whole deployment
  is the real access boundary here, the demo build's own internal sign-in screen (a synthetic
  check that accepts any input) defaults to signed in rather than asking a second time —
  anyone who reaches the bundle at all has already cleared the real gate. "Sign out" (in
  Settings) still returns to that screen for anyone who wants to see it. This only applies to
  `VITE_DEMO_MODE=true` builds; the real application's sign-in is untouched.
- **Not a demonstration of hosted-pilot readiness.** It proves the frontend renders correctly
  when hosted on Vercel; it proves nothing about the backend, the database, the scheduler, or
  authentication, none of which exist in that build. Sections 1–7 above are unchanged by its
  existence.
