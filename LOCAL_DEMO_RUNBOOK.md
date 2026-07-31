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

The whole application is behind a sign-in. There is no sign-up, and no page
loads any company data until the session cookie exists.

**For the Friday demo, sign-in is the shared administrator password.**
Microsoft Entra SSO is built and tested but deliberately switched off, because
no Entra credentials exist yet — see *§2b* below.

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

### 2b. Microsoft sign-in — built, off until credentials arrive

`AUTH_MODE` selects which identity providers may open a session:

| `AUTH_MODE` | Behavior |
| --- | --- |
| `local` *(default, and what Friday runs)* | Administrator password only. No Microsoft button is rendered. |
| `hybrid` | Both. Use this for the first live SSO test — the password keeps working. |
| `microsoft` | Microsoft only; the password is refused (with a hint saying how to re-enable it). |

Two properties worth stating out loud during the demo:

- **A missing credential cannot lock anyone out.** Setting `AUTH_MODE=microsoft`
  or `hybrid` while the `MICROSOFT_*` variables are incomplete falls back to
  `local` and shows *"Awaiting Microsoft administrator configuration"*. There is
  no state in which the app presents a Microsoft button that cannot work.
- **The tenant id is the restriction, not the email domain.** A correctly
  signed Microsoft token from someone else's directory is still refused. The
  `@vamosventures.com` check sits on top of the tenant check, not instead of it.

To switch on once Pliancy delivers the values (see `EXTERNAL_ACTION_REQUIRED.md`
§3): put them in `.env`, set `AUTH_MODE=hybrid`, restart the API, and live-test
a real sign-in before considering `microsoft`.

What the demo **cannot** show, and should be said plainly: a real Microsoft
sign-in. There is no tenant to sign in to. The flow is covered by 46 automated
tests using a fixture keypair — including wrong-tenant, non-Vamos-account,
guest-account, replayed-state, and forged-signature refusals, which a live
tenant could not easily demonstrate anyway.

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
for this release is `deal-radar-2026-07-30T12-32-03-641Z.db` (209 companies,
schema v8) — taken immediately before the operating-evidence requalification.
The live database is now schema v9.

Backups are also creatable from the UI: Settings → *Database backups*.

---

## 7. What is live, and what is not

### Live and real

| Area | State |
| --- | --- |
| **209 companies** | Real records, in SQLite, all persisted |
| **Three source families** | Regulatory (SEC EDGAR Form D), funding press (RSS), investor-primary (investor announcements) |
| **All 209 qualification verdicts** | Every company has a stored, non-null verdict. No record is missing one. |
| **33 live deals** | Classified from dated evidence and gated on qualification |
| **23 shortlisted / 10 held back** | Every held-back company shows a specific reason |
| **Financing vs. operating evidence** | Separated. A company's own website corroborates that a business *operates*; it is never counted as an independent source for the company's own *financing*. Qualification needs both. |
| **Evidence links** | Real external URLs — SEC filings, press articles, investor posts |
| **GitHub API** | Works unauthenticated (60 req/hr) |
| **SBIR / grants** | Key-free public API. Was rate-limited during earlier runs; not a credential problem. |
| **Manual refresh, sourcing history, backups, status changes** | All working and persisted |
| **CSV export** | Companies → **Export CSV**. Exports the rows exactly as filtered and sorted, with each score's completeness and provisional flag, the qualification verdict, any disqualification reason, and the evidence URL. Built in the browser — nothing is uploaded. |

### Awaiting credentials — shown honestly in the UI, never faked

| Area | What the UI says |
| --- | --- |
| **Microsoft sign-in (SSO)** | Nothing is rendered at all in `AUTH_MODE=local` (the default). Under `hybrid`/`microsoft` with incomplete variables: `Awaiting Microsoft administrator configuration` — an explanation, never a disabled button. Needs `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, a single-tenant `MICROSOFT_TENANT_ID`, and `MICROSOFT_SSO_REDIRECT_URI`. |
| **Microsoft / Outlook mailbox** | `Awaiting Microsoft administrator configuration` — needs `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` from a tenant administrator. Every Outlook action fails with an explicit 503. Mailbox consent is separate from sign-in and only requested when someone clicks Connect Outlook. |
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
- **Robotics is 3/5 and General AI is 4/5**, down from 5/5 each. Nine records
  lost `qualified-operating-company` when a website stopped counting as
  corroboration for the filing it was supposed to corroborate. Four of them
  point at domains that are literally for sale — `andromedarobotics.com`,
  `evolvedrobotics.com`, `greyparrot.com`, `bluecoreenergy.io`. Say this out
  loud: the pipeline was calling a parked domain evidence of a business.
- **Sustainability is 4/5**, down from 5/5, for the same reason.
- **`AEGIS FINTECH LTD.` is still qualified, and a human should look at it.**
  It is the record that motivated this change, and the reason it qualified is
  fixed — its domain is now actually assessed rather than merely pinged. But
  `aegisfintech.com` serves a real, if generic, fintech-and-AI services
  brochure: named service lines, several thousand characters of prose. That
  clears the operating gate on its merits. What is still thin is the other
  side: a $100M offering whose only third-party evidence is its own Form D,
  with no press, no investor announcement, and an email address for a contact
  page. The detail view now says exactly that under *What remains
  unverified*. No deterministic page rule separates this from a legitimate
  small consultancy's site, and inventing one would misclassify real
  companies — so it is surfaced for judgement rather than decided.
- **92 of 174 fit scores are provisional.** The score is normalized over the
  parts of the model that could actually be judged, and for these records
  *nothing company-descriptive* could be — no stage, location, or
  classification on file. Their number reflects only how well we sourced
  them, so it is labelled `PROVISIONAL`, ranked below every assessed
  company, and excluded from the high-fit count. Recording a stage, a
  location, or a classification turns one into a real fit score. The
  remaining **80 are genuinely scored**, spanning 2.5–7.7. (The provisional
  count is unchanged by the operating-evidence change; the assessed count fell
  from 82 because two newly quarantined records — both parked domains — were
  assessed rather than provisional.)
- **Nothing scores 8.0+.** Even assessed records top out at 7.7, because
  mission alignment needs verified founder self-ID and traction needs an
  analyst rating — neither of which a Form D or a funding article carries.
- **No free-text notes field.** Workflow state is captured by review status
  (Research Needed / Monitor / Pass / Approved), not prose.
- **Single shared admin password**, not per-user accounts.

---

## 8. Five-minute demo walkthrough

**0:00 — Start and sign in.** `npm run dev`, open http://localhost:5173, sign
in. Point out that every API route requires the session, not just the screen.

**0:45 — Dashboard.** *Overview*. Four metrics computed from persisted records:
209 discovered, 0 scored 8.0+, 172 awaiting review with **37 disqualified
records excluded**, 0 stale. Say why nothing scores 8.0+ — most records have no
founder identity or traction on file, and the score refuses to infer them.

**1:15 — Sector shortlists.** Scroll to *Sector shortlists* on the same page.
23 selected across 7 sectors, 10 held back. Expand **Health & Wellness**:
five selected with source, tier, round, amount, date, and a live evidence link,
then nine companies held back by the two-per-sector SEC cap — so one source
cannot fill a sector — and **Nourish**, held back as *"Ranked #6 of 6 live
deals in this sector and only 5 slots exist."* This is the point to make:
nothing qualifying ever disappears silently. Expand **Future of Work** to show
an honest 0/5, and **Robotics** to show 3/5 — four of its former live deals
turned out to point at domains that are for sale.

**2:15 — Company search and filters.** *Companies*. 172 records. Filter by
classification, primary source, tier, or *Live opportunities only*. Note **Show
disqualified (37)** — publicly traded companies, funds, and SPVs are excluded
by default and their evidence is retained, not deleted. **Missing
corroboration** now means what it says: no independent financing source, or no
substantive evidence that the issuer describes an operating business.

**2:40 — Scores that can rank.** Tick **Scorable only (hide provisional)** —
172 drops to 80. Explain the split: the score is computed over the parts of
the model that could actually be judged, and for 92 records nothing
company-descriptive was on file, so their number only reflects our own
sourcing. Those are marked `prov.`, always rank below assessed companies, and
never count as high-fit. Then **Export CSV** — the file carries every score's
completeness and provisional flag, so the caveat survives the spreadsheet.

**3:00 — Opportunity detail and evidence.** Expand **Fish Audio**. Walk down:
primary evidence with publisher and date, a clickable TechCrunch link, *why
this is a current signal*, **qualification reasons** in plain language, and then
the three evidence sections that carry the whole argument: **financing
evidence** (one independent source — TechCrunch — with the note that the
company's own website is never counted here), **operating-company evidence**
(what fishaudio.com actually says about its product), and **what remains
unverified**. Then open **Theker** for the contrast: strong financing evidence,
but a 407-character stealth teaser, so its website appears under
*identity-only website evidence* and it is a lead rather than a deal. Then the 01–08 score breakdown, where every
point is attributed — including the zeros and why they are zero.

**4:00 — Why something failed.** Tick *Show disqualified*, open **Adagio
Medical Holdings** — publicly traded (ticker ADGM), disqualified with the
reason stored and its evidence kept for audit. Contrast with a company lead
such as **Star Catcher**: real, but resting on one investor announcement, so
not a deal.

**4:30 — Workflow and honesty.** Set a company to **Monitor**, reload the page,
show it persisted. Add an internal note under **08 Internal notes** and reload
to show that too (see §9 for the fuller version). Then *Settings*: sourcing run
history, **Run refresh (all enabled)**, and the connector cards reading
*Awaiting Microsoft administrator configuration* and *Not enabled for this local
pilot*. Close on that — the product states what it cannot do.

---

## 9. Internal note review walkthrough

Where the team records what it *thinks*, as opposed to what a source *said*.
Notes live in section **08 Internal notes** of any expanded company, below the
recommendation. They work on every record — qualified deals, held-back deals,
leads, human-review, and disqualified/quarantined companies alike — because a
quarantined record is often exactly where an explanation is most useful.

1. **Open a company.** *Companies* → click any row → scroll to **08 Internal
   notes** (or use *Internal notes* in the "On this record" rail). A company
   with none says so plainly rather than showing a blank panel.
2. **Write one.** Type into *Add a note*. The counter tracks the length against
   the 4,000-character limit and counts exactly what the server will store, so
   it cannot disagree with the limit it is counting toward. **Save note** is an
   explicit press — there is no autosave, because a half-written opinion should
   not be stored as though it were finished. Whitespace-only text is refused.
3. **Note what it records.** Each saved note shows its author and time —
   *Local administrator* today, because the sign-in is a single shared password
   and the note says so instead of inventing a name. Under Microsoft SSO the
   same field will carry the real user, and stored notes stay distinguishable
   between the two.
4. **Edit it.** **Edit** loads the body back into the box; saving marks the note
   *edited* and keeps its original author and creation time.
5. **Archive and restore.** **Archive** takes a note out of the working set and
   reveals the archived list so it never just disappears. Nothing is deleted —
   there is no delete button and no delete route. **Restore** brings it back.
   Archiving is not an edit, so an archived note is not labelled as revised.
6. **Prove it persisted.** Reload the browser: the note is still there. Sign out
   and back in: still there. Restart with `npm run dev`: still there. It is a
   row in the `company_notes` table (schema v10), so it is included in
   `npm run db:backup` and comes back with a restore.

**Two things to say out loud.**

- **Notes are confidential and stay in the tool.** They are absent from
  **Export CSV** by design, and absent from the bulk company payload the export
  is built from — so there is nothing on that side of the boundary to leak. The
  audit log records *that* a note was added, edited, archived, or restored, and
  never what it said.
- **Notes are plain text, always.** A body is rendered as text and never as
  HTML or Markdown. Paste `<b>bold</b>` into a note and it displays those
  characters literally. Notes are treated as untrusted input even though a
  colleague wrote them.

---

## 10. Founder, sector, and stage enrichment

The dashboard used to show four different kinds of nothing as if they were one
kind: `Identity not on record — requires human verification, never inferred`,
`Unknown` founder, `Unknown` vertical, and `Unknown` stage. Each was true and
useless — they read identically whether nine source families had been searched
and found nothing, or nobody had looked. Enrichment replaces them with a sourced
fact, a labelled inference, a named candidate, a stated conflict, or a research
result that says what was searched and what to do next.

### What it will not do

It does not invent a founder to empty a column, does not translate an SEC Form D
into "Seed", does not attach a person to a company on a shared name, and never
infers demographic identity from anything. Each of those turns a visibly empty
field into an invisibly wrong one, which is strictly worse: a reviewer can see a
gap, and cannot see a fabrication.

### Running it

**Dry run is the default — nothing is written without `--apply`.** A dry run
still performs the research (a preview built from nothing would be fiction), but
the database is untouched.

```bash
npm run db:enrich                                   # dry run, all active companies
npm run db:enrich -- --apply                        # write
npm run db:enrich -- --apply --company-id disc-cand-895
npm run db:enrich -- --apply --limit 25
npm run db:enrich -- --apply --resume               # only never-researched companies
npm run db:enrich -- --apply --max-requests 400     # per-run network budget
npm run db:enrich -- --apply --quiet                # summary only
```

**Back up before an `--apply` run**: `npm run db:backup`.

Retry and backoff are handled inside `server/sourcing/politeness.ts` — one
request at a time per host, a minimum gap, honoured `Retry-After`, bounded
exponential backoff with jitter, and a hard per-run request budget. The script
never retries around those decisions. Per-source failures are reported in the
run summary and stored on the run record; they are never folded into a
"not found" bucket.

### The six resolution states

Every enriched field carries one. They are not interchangeable, and the API
returns the state alongside the value rather than representing all six as `null`.

| State | Meaning |
| --- | --- |
| `confirmed` | An attributable source states the fact directly. |
| `bounded-inference` | Not stated anywhere; the evidence constrains it to a labelled range. Always displayed as inferred. |
| `candidate` | Something plausible was found and is **not** asserted. Shown as a candidate, never as the answer. |
| `conflict` | Two or more sources disagree. Both sides are shown. |
| `research-exhausted` | Every applicable source family was attempted and the fact is not public. This is a **result**, not a failure. |
| `manual-review` | A human has to look. Always carries a next action. |

`research-exhausted` is only reached when every family actually **answered**. A
source that timed out, refused, or served a browser-rendered page it could not
read counts as an attempt, not a finding — dressing a network failure up as "no
founder exists" would state something about a company we never learned.

### Source families, in the order they are searched

Company website → SEC Form D → accelerator/incubator profile → investor
portfolio and announcements → founder-authored announcements → funding press →
public speaker/award profiles → public professional profiles → corporate
registries.

The first four are **authoritative**: a statement from one of them can, on its
own, support `verified-founder`. The rest can only ever produce a candidate, no
matter how many agree — three articles repeating one another are one source.

Nothing behind a login wall is fetched, no access control is worked around, and
no address is guessed. A family with no URL on record is recorded as
`no-source-url-known`, which is a truthful description of our coverage.

### Reviewing and correcting

**In the company detail panel** (Companies → click a row → "Founders, sector &
stage"):

- **Research again** re-runs every applicable family for that company. Writes
  are idempotent upserts, so pressing it twice refreshes rather than duplicates.
- **Correct founder / vertical / stage** records an attributed correction. Your
  name, the time, the previous value, your reason, and an optional source URL
  are stored with it.

**In the Stealth Founder Radar** (`/stealth`): filter by verified, probable,
conflicting, research exhausted, or manual review; expand any row for the
research record, the relationship graph, filing facts, and financing evidence;
and confirm or reject a candidate with a stated reason.

**A correction never overwrites the automated evidence.** It is layered on top
at read time, so six months from now a reader can see both what the research
concluded and what a human decided, and can tell which is which. Overwriting
would destroy the only record of why the machine got it wrong.

### Re-running is safe

Every write is an upsert keyed on the natural identity of the thing being
written — a person from a source, an attempt against a family, an edge from a
source. Re-running does not duplicate people, evidence, attempts, edges, or
history, and it never clears a reviewer's decision. `first_seen_at` is preserved
while `last_checked_at` moves.

### What enrichment may not change

Enrichment can only ever **remove** a company from a sector ranking, never add
one. A founder match is not financing corroboration, a company's own website is
not independent financing evidence, and no company is promoted because a field
became populated. The qualification rules, the operating-company standard, and
the five-per-sector cap are untouched.

---

## 11. Sign-in, HubSpot, and per-run limits

### Sign-in is moving to Microsoft single sign-on

The end state is that **only @vamosventures.com accounts can sign in**, with no
shared password. The code for that is written, tested, and enforces the domain
already — what is missing is one Entra app registration.

`AUTH_MODE` defaults to **`auto`**, which means:

| Entra configured? | What happens |
| --- | --- |
| No (today) | The shared administrator password works. The sign-in screen says the cutover is coming. |
| Yes | The password form disappears and stops being accepted. Microsoft SSO is the only way in. |

**The switch is automatic.** Nobody has to remember to also flip a variable
afterwards — that step is exactly the kind that does not happen, and its failure
mode is silent: a shared password everyone knows quietly keeps working for
months after it was supposed to be gone.

Set `AUTH_MODE=local` to opt out of the cutover entirely, or `AUTH_MODE=hybrid`
to keep both live during testing.

**What an Entra administrator has to do once** (~15 minutes):

1. Register one application in the Vamos Entra tenant.
2. Add two redirect URIs, exactly as written in `.env.example` — one for
   sign-in, one for the Outlook mailbox. They are separate because they request
   different scopes, and a mailbox-consent response must not be redeemable by
   the sign-in handler.
3. Grant the delegated sign-in scopes (`openid`, `profile`, `email`). No
   application-level `Mail.*` permission is needed or wanted.
4. Return the **client id**, **client secret**, and **tenant GUID**.
5. Put them in `.env` as `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
   `MICROSOFT_TENANT_ID`, `MICROSOFT_SSO_REDIRECT_URI`.

`MICROSOFT_TENANT_ID` must be the real tenant GUID. `common`, `organizations`,
and `consumers` are **refused**: they would let any Microsoft account anywhere
complete the flow, leaving a domain string as the only defense.

Access is gated three ways, in this order: the token must come from the Vamos
tenant, the directory must report the address as verified, and the address must
end in `@vamosventures.com`. The domain check is the *last* of the three on
purpose — on its own it is just text in a token.

An incomplete handover never locks anyone out: any mode falls back to the
password when Entra cannot actually run.

### HubSpot

HubSpot is **implemented and not connected**. It reports itself that way and
never simulates: `hubspotService()` throws an honest "not connected" error
rather than returning fake data, and the status panel only says *Connected*
after a real verified call to your portal.

To connect, add to `.env` either:

- `HUBSPOT_ACCESS_TOKEN` (private app token — simplest), or
- `HUBSPOT_CLIENT_ID` + `HUBSPOT_CLIENT_SECRET` + `HUBSPOT_REDIRECT_URI` (OAuth).

Then set the pipeline mapping in **Data Sources & Refresh → HubSpot → Pipeline
mapping**. Submissions are blocked until every Deal Radar status maps to a real
HubSpot stage id — an unmapped sync would otherwise land deals in whatever stage
HubSpot defaulted to.

**Who becomes a contact.** Only a founder the research **verified**, or one a
reviewer corrected by hand. Two exclusions, enforced on the server so they hold
for any client:

- **Placeholder rows.** The imported founder list still carries "Unknown
  founder" for most companies. Syncing one creates a contact literally named
  that in a CRM the whole team shares and builds outreach from.
- **Probable candidates.** A candidate is a person the research found and is not
  willing to assert. Writing one to HubSpot asserts it — to everyone,
  permanently, in the system of record.

When no founder qualifies, the company and deal still sync and the modal says
why. Confirm a founder on the Stealth Founder Radar, then re-sync to attach the
person.

### Per-run limits

A discovery run may query at most **3 sources** and return at most **20
candidates**. Both are enforced server-side, so the limit holds regardless of
which client built the request.

The constraint is reviewer attention and cost, not storage. Every extra source
costs third-party requests and tokens for candidates that are usually discarded
before a human sees them, and two or three well-chosen sources answer the
question actually being asked.

Deliberately **not** capped: the per-company **refresh**, which re-checks one
company you already hold across every source that might mention it. Its cost is
bounded by the single company and its own API-call budget, and breadth is the
entire point.

### What the enrichment writes back, and what stays empty

Enrichment writes researched facts onto the company row — stage, sector,
subvertical, city/state, funding amount and date, accelerator, a self-description,
and a verified founder. This matters because the **fit score reads the company
row**, not the enrichment tables: before the write-back, 195 companies had a
researched stage and still scored as `Unknown` with the 15-point stage component
excluded entirely. The research was being done and then ignored.

Provenance is enforced on every write (`extracted` never overwrites `verified` or
`user-entered`), so a human confirmation always wins.

Two components stay unassessable for almost every company, by design:

- **Mission alignment (15 pts)** needs a *verified* demographic indicator —
  founder self-identification or a verified public statement. This is the one
  field that must never be automated, and no amount of research will fill it.
  It is filled by a human recording an explicit source, or not at all.
- **Traction signal (10 pts)** is a 0–10 analyst judgement with a written
  justification. There is no public source for "how much traction does this have";
  a reviewer enters it.

Everything else fell as the pipeline improved: average model coverage went from
**30% to 56%**, and no company is `provisional` any more (previously most were).
Remaining gaps are genuine absences of public information, not plumbing.

---

## 12. Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start web + API (the demo command) |
| `npm test` | Unit suite (767 tests) |
| `npm run test:e2e` | Playwright suite (isolated DB and ports) |
| `npm run typecheck` | TypeScript across app, server, and scripts |
| `npm run lint` | oxlint |
| `npm run build` | Production build |
| `npm run smoke-test` | End-to-end API smoke test |
| `npm run db:integrity` | SQLite integrity check |
| `npm run db:backup` | Timestamped backup |
| `npm run db:qualify-pending` | Qualify companies that have no verdict yet |
| `npm run db:enrich` | Founder / sector / stage research (dry run; `-- --apply` to write) |

Do not expose this application through a public tunnel. It holds sourced
company records, is gated by one shared password, and is intended to run on one
machine.
