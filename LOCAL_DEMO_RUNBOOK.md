# Local demo runbook — Vamos Deal Radar

Everything needed to start the application, walk a supervisor through it, and
recover if something goes wrong. Local review build only: no hosting, no public
tunnel, no external write path.

---

## 1. Start the application

One command starts both processes (the API and the web app):

```bash
npm run dev
```

Then open:

**http://localhost:5173**

`npm run dev` runs `concurrently` over two processes:

| Process | Port | What it is |
| --- | --- | --- |
| `web` | 5173 | Vite dev server — the URL you open |
| `api` | 8787 | Express API + SQLite. The web app proxies `/api` and `/health` to it |

Both must be up. If only one starts, see **Recovering from a failed startup**.

First run after a fresh `git clone` needs dependencies first:

```bash
npm install
```

---

## 2. Sign in

The whole application is behind a single shared admin password. There is no
sign-up, and no page loads any company data until the session cookie exists.

**To read the password locally without printing it into this file or your
terminal history**, open `.env` in an editor and read the `ADMIN_PASSWORD=`
line:

```bash
open -a TextEdit .env
```

`.env` is gitignored and never leaves the machine. The browser never receives
the password — the server sets a signed, HttpOnly session cookie that expires
after 12 hours.

If `ADMIN_PASSWORD` is empty, admin actions are **unusable rather than open**
(fails closed). Set a value, then restart the API.

---

## 3. Stop the application

Press `Ctrl+C` in the terminal running `npm run dev` — it stops both processes.

If a port is still held afterwards:

```bash
lsof -ti:5173,8787 | xargs kill
```

---

## 4. Run a public-source refresh

Two ways, both manual. **There is no background scheduler in this backend** —
nothing refreshes on its own, which is why the per-connector schedule dropdown
on the Settings page is stored as configuration only and says so.

**From the UI** — Settings → *Refresh connectors* → **Run refresh (all
enabled)**. Per-connector results report as live, local, or failed. One failing
connector never discards another's work.

**From the command line:**

```bash
npx tsx scripts/source-opportunities.ts
```

Related one-off scripts:

| Command | What it does |
| --- | --- |
| `npm run db:qualify-pending` | Qualifies only companies with **no** verdict yet. Live-checks those and nothing else, so a network blip can never demote an already-verified company. |
| `npx tsx scripts/source-funding-news.ts` | Funding-press RSS pass |
| `npx tsx scripts/source-investor-news.ts` | Investor-primary announcement pass |

After any sourcing run, run `npm run db:qualify-pending` — newly imported
records have no verdict, and a record with no verdict is deliberately **never**
counted as a live opportunity.

---

## 5. Recovering from a failed startup

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser shows "The Deal Radar backend is not reachable." | API (8787) is down; web (5173) is up | Look at the `api` lines in the terminal. Most often a bad `.env` value — the server validates `.env` at boot and exits with the offending key. |
| `EADDRINUSE` on 5173 or 8787 | An older run is still alive | `lsof -ti:5173,8787 \| xargs kill`, then `npm run dev` |
| API exits immediately on boot | `SESSION_SECRET` shorter than 16 chars, or a malformed `.env` line | Fix the key named in the error, restart |
| Sign-in rejects every password | `ADMIN_PASSWORD` empty or changed since the cookie was issued | Set it in `.env`, restart the API, sign in again |
| Pages load but every list is empty | Wrong database file | Confirm `DATABASE_FILE` in `.env` is empty (defaults to `server/.data/deal-radar.db`) and run `npm run db:integrity` |

Confirm the database itself is healthy at any time:

```bash
npm run db:integrity
```

Check the API is alive without signing in:

```bash
curl http://localhost:8787/health/live
```

---

## 6. Backups

Backups live in:

```
server/.data/backups/
```

| Command | What it does |
| --- | --- |
| `npm run db:backup` | Creates a timestamped copy and prints its name, size, schema version, and company count |
| `npm run db:list-backups` | Lists every backup with the same metadata |
| `npm run db:restore` | Restores from a backup (prompts for which) |

Take a backup **before** any live-data change. The most recent verified backup
for this release is `deal-radar-2026-07-30T03-21-03-962Z.db` (209 companies,
schema v8).

Backups are also creatable from the UI: Settings → *Database backups*.

---

## 7. What is live, and what is not

### Live and real

| Area | State |
| --- | --- |
| **209 companies** | Real records, in SQLite, all persisted |
| **Three source families** | Regulatory (SEC EDGAR Form D), funding press (RSS), investor-primary (investor announcements) |
| **All 209 qualification verdicts** | Every company has a stored, non-null verdict. No record is missing one. |
| **42 live deals** | Classified from dated evidence and gated on qualification |
| **27 shortlisted / 15 held back** | Every held-back company shows a specific reason |
| **Evidence links** | Real external URLs — SEC filings, press articles, investor posts |
| **GitHub API** | Works unauthenticated (60 req/hr) |
| **SBIR / grants** | Key-free public API. Was rate-limited during earlier runs; not a credential problem. |
| **Manual refresh, sourcing history, backups, status changes** | All working and persisted |

### Awaiting credentials — shown honestly in the UI, never faked

| Area | What the UI says |
| --- | --- |
| **Microsoft / Outlook** | `Awaiting Microsoft administrator configuration` — needs `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` from a tenant administrator. Every Outlook action fails with an explicit 503. |
| **AI provider** | `Not enabled for this local pilot` — no key, no paid API call. Outreach drafts and fit explanations come from a deterministic local template built only from recorded evidence, labelled *"Local template — no AI model used"* wherever it appears. |
| **HubSpot** | `Implemented — credentials required`. Optional; its absence blocks nothing. |
| **Product Hunt** | `Credentials required` — needs a developer token. Skipped on every run rather than failed; never blocks startup or health. |

No connector fabricates a response. Nothing claims to be connected without a
real health check succeeding first.

### Known gaps — say these out loud rather than being caught by them

- **Future of Work is 0/5.** Seven company leads, no current financing
  evidence for any of them. Shown empty rather than padded.
- **Space Tech is 2/5.** Two live deals. (It read 3/5 before qualification;
  Star Catcher rests on a single investor announcement and is now correctly a
  company lead.)
- **No CSV export.** CSV *import* exists; export was never built.
- **No free-text notes field.** Workflow state is captured by review status
  (Research Needed / Monitor / Pass / Approved), not prose.
- **Highest Vamos Fit score is 3.7/10.** Honest: most records are SEC filings
  with no founder identity, no verified mission alignment, and no traction
  data on file. The score never infers those.
- **Single shared admin password**, not per-user accounts.

---

## 8. Five-minute demo walkthrough

**0:00 — Start and sign in.** `npm run dev`, open http://localhost:5173, sign
in. Point out that every API route requires the session, not just the screen.

**0:45 — Dashboard.** *Overview*. Four metrics computed from persisted records:
209 discovered, 0 scored 8.0+, 174 awaiting review with **35 disqualified
records excluded**, 0 stale. Say why nothing scores 8.0+ — most records have no
founder identity or traction on file, and the score refuses to infer them.

**1:15 — Sector shortlists.** Scroll to *Sector shortlists* on the same page.
27 selected across 7 sectors, 15 held back. Expand **General AI**: five
selected with source, tier, round, amount, date, and a live evidence link —
then **General Intuition**, held back, reading *"Ranked #6 of 6 live deals in
this sector and only 5 slots exist."* This is the point to make: nothing
qualifying ever disappears silently. Expand **Health & Wellness** to show
twelve companies held back by the two-per-sector SEC cap, so one source cannot
fill a sector. Expand **Future of Work** to show an honest 0/5.

**2:15 — Company search and filters.** *Companies*. 174 records. Filter by
classification, primary source, tier, or *Live opportunities only*. Note **Show
disqualified (35)** — publicly traded companies, funds, and SPVs are excluded
by default and their evidence is retained, not deleted.

**3:00 — Opportunity detail and evidence.** Expand **Fish Audio**. Walk down:
primary evidence with publisher and date, a clickable TechCrunch link, *why
this is a current signal*, **qualification reasons** in plain language, the two
independent sources and their families, and the caveat that undated supporting
records cannot establish currency. Then the 01–08 score breakdown, where every
point is attributed — including the zeros and why they are zero.

**4:00 — Why something failed.** Tick *Show disqualified*, open **Adagio
Medical Holdings** — publicly traded (ticker ADGM), disqualified with the
reason stored and its evidence kept for audit. Contrast with a company lead
such as **Star Catcher**: real, but resting on one investor announcement, so
not a deal.

**4:30 — Workflow and honesty.** Set a company to **Monitor**, reload the page,
show it persisted. Then *Settings*: sourcing run history, **Run refresh (all
enabled)**, and the connector cards reading *Awaiting Microsoft administrator
configuration* and *Not enabled for this local pilot*. Close on that — the
product states what it cannot do.

---

## 9. Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start web + API (the demo command) |
| `npm test` | Unit suite (540 tests) |
| `npm run test:e2e` | Playwright suite (40 tests, isolated DB and ports) |
| `npm run typecheck` | TypeScript across app, server, and scripts |
| `npm run lint` | oxlint |
| `npm run build` | Production build |
| `npm run smoke-test` | End-to-end API smoke test |
| `npm run db:integrity` | SQLite integrity check |
| `npm run db:backup` | Timestamped backup |
| `npm run db:qualify-pending` | Qualify companies that have no verdict yet |

Do not expose this application through a public tunnel. It holds sourced
company records, is gated by one shared password, and is intended to run on one
machine.
