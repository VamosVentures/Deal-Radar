# Vamos Deal Radar — local pilot runbook

Everything below is derived from this repository (`package.json`, `server/db/client.ts`,
`server/env.ts`, `vite.config.ts`, `.claude/launch.json`). No command here is invented; each
one exists as an npm script.

**This runbook is for a LOCAL pilot on a Vamos machine.** It is not a hosted deployment
guide — see [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md), which records hosted
deployment as blocked on external configuration.

---

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| Node.js | **≥ 24**. The datastore uses `node:sqlite` (`DatabaseSync`), a built-in module — there is no native SQLite dependency to compile, but the module must exist. Verified on Node 24.18.0. |
| Package manager | **npm** (a `package-lock.json` is committed; do not substitute another). |
| SQLite CLI | Optional. Only for ad-hoc read-only inspection; the app never needs it. |
| Network | Outbound HTTPS for sourcing runs. Every source used is a key-free public endpoint. |
| Credentials | None required to boot. See §3. |

## 2. Install

```bash
npm ci
```

Use `npm ci` rather than `npm install` so the committed lockfile is honoured exactly.

## 3. Environment variables

The app boots with **zero credentials**. A blank value in `.env` is treated as unset
(`server/env.ts`), so a literal copy of `.env.example` works.

```bash
cp .env.example .env
```

Names only — never commit values, and `.env` is gitignored:

| Variable | Needed for | Notes |
|---|---|---|
| `ADMIN_PASSWORD` | Signing in to the local pilot | **Local pilot only.** See §12. Unset means the admin-only actions are unusable (fail closed), not open. |
| `SESSION_SECRET` | Sessions surviving a restart | ≥16 chars. When unset it is randomised per process, so every restart signs everyone out. |
| `DATABASE_FILE` | Pointing at a different database | Defaults to `server/.data/deal-radar.db`. |
| `PORT` | Backend port | Defaults to 8787 via the `dev:server` script. |
| `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_SSO_REDIRECT_URI`, `MICROSOFT_ALLOWED_EMAIL_DOMAIN` | Entra SSO | Not set today. See DEPLOYMENT_READINESS.md §3.1. |
| `AUTH_MODE` | Which providers may sign in | Defaults to `auto`: Entra once fully configured, the shared password until then. |
| `AI_PROVIDER`, `AI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `AI_MODEL` | Optional AI features | Entirely optional; unset is fine. |
| `GITHUB_TOKEN`, `SEC_CONTACT_EMAIL`, `FUNDING_NEWS_FEEDS`, `INVESTOR_NEWS_FEEDS`, `PRODUCTHUNT_TOKEN` | Individual sourcing adapters | Optional. `producthunt` refuses to run without its token rather than pretending. |
| `RUN_SCHEDULER` | Background scheduled sourcing | Defaults to `false`. Leave it off for a pilot. |

## 4. Database location policy

- **Active database:** `server/.data/deal-radar.db` (override with `DATABASE_FILE`).
- `server/.data/` is **gitignored**. The database, its WAL/SHM sidecars, and every backup
  are never committed.
- **Backups:** `server/.data/backups/`, one `.db` plus a `.meta.json` sidecar per backup.
  The sidecar holds counts and timestamps only — no row data.
- Tests use `:memory:` or an isolated temp file; the E2E suite uses its own file under the
  OS temp directory on ports 8788/5183 so it can never touch the dev database.

## 5. Backup and restore

Always back up before applying data changes.

```bash
npm run db:backup
```

Uses `VACUUM INTO`, which produces a single consistent fully-checkpointed snapshot and is
safe while the server is running. Prints the filename, size, schema version and company
count.

```bash
npm run db:list-backups
npm run db:integrity
```

Restore — interactive, with a confirmation gate:

```bash
npm run db:restore -- deal-radar-2026-08-06T12-27-18-874Z.db
```

The restore path validates the file's SQLite header, takes an **automatic safety backup** of
the current database first, clears stale WAL/SHM sidecars, runs `PRAGMA integrity_check`,
and **rolls itself back automatically** if that check fails.

> **Caveat worth knowing:** `checkIntegrity()` opens a database through `openDatabase()`,
> which self-migrates. Running an integrity check directly against an old backup file will
> therefore upgrade that file's schema. To inspect a backup without modifying it, copy it
> first and check the copy.

Record a checksum when a backup is a recovery point you intend to rely on:

```bash
shasum -a 256 server/.data/backups/<file>.db
```

## 6. Start the application

```bash
npm run dev
```

Runs both processes concurrently:

| Process | URL |
|---|---|
| Frontend (Vite) | **http://localhost:5173** |
| Backend (API) | **http://localhost:8787** |

The frontend proxies `/api`, `/health/live` and `/health/ready` to the backend, so use
**http://localhost:5173** in the browser. Only the two health *endpoints* are proxied, not
the `/health` prefix — `/health` is the Health & Wellness vertical route.

Production-mode single process (serves the built frontend):

```bash
npm run build && npm start
```

## 7. Health and readiness

```bash
curl -s http://localhost:8787/health/live
curl -s http://localhost:8787/health/ready
```

`/health/ready` reports migration state and withholds diagnostic detail from anonymous
callers. A full end-to-end check against an isolated database:

```bash
npm run smoke-test
```

It boots a production server on port 8799 against a temp database and asserts: live, ready,
diagnostics withheld from anonymous callers, the frontend loads, and an unauthenticated
admin route returns 401.

## 8. Sign in

Open http://localhost:5173. The whole application is gated — **every API route requires the
session, enforced by the server, not just the sign-in screen.**

Enter the `ADMIN_PASSWORD` from your `.env`. The sign-in screen states that sign-in is
moving to Microsoft SSO limited to `@vamosventures.com`, and that the shared password stops
working automatically once the Entra registration is complete.

## 9. Safe shutdown

`Ctrl+C` in the `npm run dev` terminal. The backend closes the database connection cleanly
on shutdown (`closeDb()`). Because backups use `VACUUM INTO`, no shutdown is needed to take
one.

## 10. Reviewing deals

### Awaiting Review and the review queues

- **Overview** (`/`) — ten KPI cards, five per entity (Companies and Stealth Founders):
  Discovered This Week, High-Fit, Stale, Awaiting Review, Cumulative. Click any card for a
  by-vertical breakdown. Cumulative offers All Time / This Month / Last Month / This Year /
  Last Year; each non-All-Time period runs a **real server query** against UTC calendar
  boundaries.
- **All Deals** (`/companies`) — the master cross-vertical table. Search, and filter across
  **one or several** verticals at once, plus stage/state/score/date/review filters.
- The five vertical pages (`/health`, `/fintech`, `/future-of-work`, `/sustainability`,
  `/frontier`) are pre-filtered views of that same table, not a second deal system.
- Legacy links resolve safely: `/robotics`, `/spacetech`, `/space-tech`, `/space_tech` →
  Frontier; `/ai` → Future of Work; `/areas-of-interest` → unfiltered All Deals;
  `/pipeline` → `/companies`. A `?vertical=` value is normalised, and an unrecognised one
  falls back to the unfiltered view rather than an empty table.
- **Awaiting Review** means `review_status` is `New` or `Awaiting Review`, excluding
  quarantined records.
- **Needs Diligence / Promising** — expand a company row. Needs Diligence requires a
  provisional score with a closable gap and no exclusions. Promising additionally requires
  substantive, **cited** evidence — sector, geography and accelerator participation are
  excluded by definition, and buyer clarity cannot fire from the bare word "enterprise".

### Deciding pending evidence

Expand a company; the **Pending evidence** panel lists claims an extractor read from a
public source. For each item you see the verbatim quote, an openable source link,
provenance (`company-claimed` vs `independently-confirmed`), the access date, the section it
came from, and whether it is about **this** company or a founder's **prior** company.

Three actions:

- **Accept** — records that the claim is real. It does **not** assign a rating.
- **Edit** — opens the excerpt for correction, then saves it. The published quote is kept
  unchanged alongside your correction, so a later reviewer sees both.
- **Reject** — records that the claim should not be relied on.

Two things to internalise:

1. **Accepting a quote is not rating the company.** A suggested state is displayed as
   "Suggested: … — not applied". Stage and traction are separate, explicit actions.
2. **A decision is not silently overwritable.** Deciding an already-decided item returns a
   409 naming who decided it and when. If a conclusion changes, record a new traction
   review rather than editing history.

Items flagged **not about this company** (a founder biography, or a "Before <company>" beat
inside a launch post) are shown but carry **no suggested traction state**, so they can be
read and cited but can never be one click from becoming this company's traction.

### How stage and traction decisions affect provisional status

A score is **non-provisional** only when all of `thesis`, `stage`, `traction`, `founder` and
`geo` are assessable, at least 60% of the model was judgeable, and at least one source is
cited (`NON_PROVISIONAL_POLICY`, `src/lib/scoring.ts`).

**Traction is assessable only from an analyst rating.** As of this pilot, `traction_reviews`
is empty, so **every one of the 213 companies is provisional and none is High-Fit** — and
that is correct behaviour, not a defect. Recording a traction review is the action that
unblocks it. Likewise, a stage the pipeline merely *inferred* (the
"Early-stage — round not publicly disclosed" residual) is deliberately **not** written to
the company row and does not score; it is visible with its confidence and reasoning, and a
person confirms or replaces it.

### The four named pilot companies

```
/companies?vertical=frontier   → Manifold            (manifoldindustries.ai)
/companies?vertical=fintech    → Grade               (usegrade.com)
/companies?vertical=fintech    → Unifold             (unifold.io)
/companies?vertical=health     → Scheduling Wizard   (schedulingwiz.com)
```

Or search All Deals by name. Each is **Awaiting Review** with stage `Unknown`, all founders
recorded, and its pending evidence queued. Note **Unifold requires a partner mandate ruling**
— multi-chain crypto deposit infrastructure sits in the FinTech "DeFi & blockchain"
adjacent/exception category.

### Newly sourced candidates

```bash
# Read-only. Writes nothing; recommended against a disposable copy.
cp server/.data/deal-radar.db /tmp/preview.db
DATABASE_FILE=/tmp/preview.db npm run discovery:preview
DATABASE_FILE=/tmp/preview.db npm run discovery:preview -- health fintech
```

Runs the pipeline against live public sources in **preview mode** — no candidate, run,
company, score or review decision is persisted — and prints each survivor's real Vamos Fit
Score under the unchanged rubric, with its cited evidence and what is missing.

## 11. Recovery

### A failed migration

Migrations run inside a transaction and roll back on failure (`runMigrations`), so a failed
migration leaves the schema at its previous version rather than half-applied. The app throws
naming the failing version.

```bash
npm run db:list-backups
npm run db:restore -- <a backup from before the upgrade>
```

### A corrupt local database

```bash
npm run db:integrity          # PRAGMA integrity_check on the active file
npm run db:restore -- <file>  # validates, safety-backs-up, checks, auto-rolls-back
```

If no backup exists, the last resort is to move `server/.data/deal-radar.db` aside and let
the app create a fresh one — **this loses all local data**, including review decisions.
Prefer a restore.

### Verifying a recovery point before you rely on it

```bash
npm run db:backup
shasum -a 256 server/.data/backups/<file>.db
cp server/.data/backups/<file>.db /tmp/verify.db     # copy: the check migrates what it opens
sqlite3 /tmp/verify.db "PRAGMA integrity_check; SELECT MAX(version) FROM migrations; SELECT COUNT(*) FROM companies;"
```

## 12. Local pilot authentication vs production authentication

**These are not the same thing, and `ADMIN_PASSWORD` must never be presented as acceptable
production authentication.**

| | Local pilot (today) | Production requirement |
|---|---|---|
| Mechanism | One shared administrator password | Microsoft Entra ID SSO |
| Who can sign in | Anyone with the password | Only approved `@vamosventures.com` accounts |
| Identity | None — the actor is an unauthenticated string | A verified account per person |
| Attribution | A review decision records whatever actor string was sent | A real identity |
| Transport | Plain HTTP on localhost | HTTPS, secure cookies |
| Password fallback | Is the only mechanism | Must be closed (`AUTH_MODE=microsoft`, re-verified) |

`AUTH_MODE=auto` is designed so the password stops working the moment Entra is fully
configured, with nobody needing to remember to disable it. Until that registration exists,
the shared password is what there is — which is why this pilot stays on a Vamos machine and
why the hosted pilot is blocked.

Because the local actor is not a verified identity, treat review decisions recorded during
the pilot as **attributable to the machine, not to a person**, and re-record anything that
matters once SSO is live.

## 13. Known limitations

- **No company is High-Fit, and none can be, until an analyst records a traction review.**
  Traction is assessable only from a human rating; all 213 companies are provisional. This
  is the model refusing to score what it has not been told, not a bug.
- **195 companies have stage `Unknown`.** Their stage was previously an unsourced inference
  that was scoring itself; it has been cleared from the row and is now an honest gap. The
  inference remains visible in `company_stage_resolution` with its confidence.
- **The SBIR/STTR grants source was down** during the last controlled run and reported its
  coverage as *absent*, not empty. Grant-derived evidence is missing from that run.
- Review decisions carry an unauthenticated actor string (see §12).
- Traction/stage suggestions from an accelerator profile are **company-claimed**, never
  independent confirmation. YC participation is not evidence of a financing round.
- `SESSION_SECRET` unset means a restart signs everyone out.
- The audit log (`server/lib/guard.ts`) is a capped ring buffer of 500 entries; durable
  decision history lives in the database tables, not the log.
- Hosted deployment is blocked — see DEPLOYMENT_READINESS.md.

## 14. Command reference

```bash
npm ci                     # install exactly the committed lockfile
npm run dev                # frontend :5173 + backend :8787
npm run build              # tsc -b && vite build
npm start                  # production single process
npm run typecheck          # tsc -b
npm run lint               # oxlint
npm test                   # vitest run (unit/integration)
npm run test:e2e           # playwright (isolated db, ports 8788/5183)
npm run smoke-test         # boot a prod server on :8799 against a temp db
npm run db:backup          # VACUUM INTO a timestamped snapshot
npm run db:list-backups    # list snapshots with metadata
npm run db:restore -- <f>  # validate, safety-backup, restore, integrity-check
npm run db:integrity       # PRAGMA integrity_check
npm run discovery:preview  # controlled sourcing run, writes nothing
npm run pilot:finalize     # materialize the four named candidates (idempotent)
npm run db:correct-stage   # clear unsourced inferred stage; append-only re-score
npm run db:rescore         # re-score when the model version changes (append-only)
npm run diligence          # preview-only diligence on named candidates
```
