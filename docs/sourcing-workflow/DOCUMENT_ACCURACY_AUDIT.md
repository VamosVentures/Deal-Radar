# Document accuracy audit — "Sourcing Platform Process"

**Document audited:** *Sourcing Platform - Workflow Process v2 - All Comments Addressed.docx*
(the most recently modified of the three workflow-process drafts supplied; "Workflow Last
Updated: July 22, 2026" per its own header).

**Audited against:** `vamos-deal-radar`, branch `frontend-redesign`, schema v20, working tree
at commit `9e08a6b`, verified 2026-08-06.

**Method:** every material claim was checked against the running code, the database, and a
live test/build execution — not against prior reports. Baseline figures (schema v20, 213
companies, 247 founders, 879 scoring rows, 44 pending-evidence rows, 0 traction reviews,
1,110 unit tests / 56 files, 131 Playwright tests, clean typecheck/lint/build) were
independently re-measured this session and match [FINAL_PILOT_REPORT.md](../../FINAL_PILOT_REPORT.md).

**Classification key:** Verified live · Verified locally only · Implemented but not
configured · Prototype/demo only · Planned · Inaccurate or outdated · Unable to verify.

---

## 1. Header fields

| Doc claim | Classification | Finding |
|---|---|---|
| "AI Model(s): Claude Code." | **Inaccurate or outdated** | Claude Code is the tool used to *build* the platform, not a runtime component of it. The one AI-model call the running app itself makes is founder-outreach draft generation (`server/services/ai.ts`), which uses **Anthropic or OpenAI** depending on `AI_PROVIDER`/API keys (`server/services/aiClient.ts`) — and today neither is configured, so it runs a **deterministic local template with no model call at all**. The sourcing/scoring pipeline itself makes no AI-model calls; it is score-and-rule based (`shared/scoringThresholds.ts`, `src/lib/scoring.ts`). |
| "Automation Level: 80%." | **Inaccurate or outdated** | Not a defensible single number — see §7 (Automation percentage) below for the replacement language. |
| "Frequency: Weekly. Monday at 8:00 a.m. PT is the initial placeholder cadence…" | **Implemented but not configured** — see §2. The "placeholder" framing is honest; the mechanism underneath is described precisely in §2. |
| "Human Review Required: Yes… mark them Not a Fit, Track them, or begin Outreach." | **Inaccurate or outdated** | "Not a Fit," "Track," and "Outreach" are not stored disposition values. The authoritative enum is `COMPANY_STATUSES` (`shared/integrations.ts:197-206`): `New`, `Awaiting Review`, `Research Needed`, `Approved for HubSpot`, `Synced to HubSpot`, `Monitor`, `Passed`. "Track"/"Prioritize" are score-derived **display labels** computed in `CompanyTable.tsx`, never written to the database. See §8. |

## 2. Weekly sourcing schedule

**Claim (line 25):** *"The VamosVentures Deal Radar runs on a weekly cadence… Monday at 8:00
a.m. PT is the initial placeholder cadence."*

**Classification: Implemented but not configured (application code only; no hosted cron).**

What exists:
- A real scheduling **data model and admin UI** for saving recurring jobs (`server/services/schedule.ts`, `server/routes/schedule.ts`).
- An **in-process interval loop**, not a calendar-time cron: `startScheduler()` runs `setInterval(…, 60 * 60_000)` — an hourly due-check — and a job is "due" purely by elapsed time since its last run (`CADENCE_MS.weekly = 7 * 24 * 3600_000`). There is **no anchor to a specific day-of-week or time-of-day anywhere in the code.** Even fully configured and hosted, this mechanism would fire roughly every 7 days from whenever it last ran — not deterministically "Monday 8:00 a.m. Pacific."
- The loop is gated by `RUN_SCHEDULER=true` and is **`false` by default** (`.env.example`), with `schedulerStatus()` returning the label *"Configured but inactive — schedules are stored configuration only. No job will run automatically"* when off.
- The loop only executes at all while a Node process hosting the backend stays continuously running. **No backend is currently deployed anywhere** (no `vercel.json`, no `.vercel/`, no hosting config in the repo beyond CI and a Dockerfile) — so there is no environment in which this loop could be running today, configured or not.
- No Vercel Cron / GitHub Actions `schedule:` trigger exists. `.github/workflows/ci.yml` triggers only on `pull_request` and `push`.
- What genuinely works today: an admin-only **manual** "Run sourcing now" action (`POST /api/schedule/:id/run-now`) and the `Discovery` page / `npm run discovery:preview` CLI.

**Correction required in the revised document:** describe Monday 8:00 a.m. Pacific as the
**intended operating cadence once hosted**, not an active production automation, and note
that the underlying mechanism is a rolling ~7-day interval rather than a calendar-anchored
cron — so even once hosting exists, "Monday 8am" is a target, not a guarantee, unless the
scheduler is later changed to anchor to wall-clock time.

## 3. Sources

**Claim (line 31):** describes YC/accelerator directories, company websites, funding
announcements, news, founder profiles, public filings, conference/grant listings, "and other
available sources," feeding a standard profile with attached evidence.

**Classification: mixed — see table.** Registered adapters, `server/sourcing/index.ts`:

| Source family | Adapter | Credentials | Status |
|---|---|---|---|
| Y Combinator directory | `ycombinator.ts` | None | **Verified live** — public directory API |
| GitHub (developer/OSS signal) | `github.ts` | None required; optional `GITHUB_TOKEN` for higher rate limits | **Verified live** |
| SEC EDGAR full-text search (Form D) | `sec.ts` | None required (`SEC_CONTACT_EMAIL` requested for User-Agent only) | **Verified live** |
| SBIR/STTR government awards | `sbir.ts` | None | **Temporarily unavailable** — the public SBIR API refused all traffic during this session's controlled run ("The SBIR Public API is not available at this time," see [FINAL_PILOT_REPORT.md](../../FINAL_PILOT_REPORT.md) §11). The adapter is implemented and registered; the outside API was down. Coverage for grants is currently **absent, not empty-but-checked**, whenever this holds. |
| Funding-news RSS/Atom feeds | `rss.ts` | None | **Verified live** |
| Investor/VC-firm newsroom feeds (17 firms) | `investorNews.ts` | None | **Verified live** |
| arXiv (research signal) | `arxiv.ts` | None | **Verified live** |
| Product Hunt | `producthunt.ts` | **Requires `PRODUCTHUNT_TOKEN`** | **Implemented but not configured** — no token is set; the adapter self-documents as "implemented, awaiting credentials," never exercised with a real token |
| Company websites | — | None | **Verified live**, but only as a *refresh/verification* source (confirming an existing company's URL), not a discovery source in its own right |
| Accelerator directories beyond YC | — | — | **Planned** (`server/sourcing/index.ts` marks `accelerators: 'planned'`) |
| Patents | — | — | **Unavailable** — the PatentsView API this would have used is confirmed retired |
| Hackathons | — | — | **Planned** |
| Public registries | — | — | **Planned** |
| Licensed data feeds | — | — | **Planned** — no licensing agreement exists |
| CSV upload | — | None (local file) | **Verified live**, but it is a manual import path, not an automated source |

Every source with no live adapter returns an honest zero result and a `not-configured`
status — the dispatcher never fabricates a result for a source it cannot reach.

**Correction required:** replace "ADD MORE SOURCES HERE"-style completeness language with
this exact table. Do not claim SBIR/grants coverage as active; state it as intermittently
available and dependent on an external government API's uptime.

## 4. Scoring

**Claim (lines 33–41, 68–74):** Vamos Fit Score /10 from vertical fit, stage fit, mission
alignment, traction, founder signals, geography.

**Classification: Verified live for the mechanics; the document's implicit "the score tells
you who to pursue" framing needs a caveat — see below.**

- The six factors listed are real, live-scored components (`src/lib/scoring.ts`); the exact
  weights are unchanged and documented in-code.
- **High-Fit threshold is real and exact:** `HOT_THRESHOLD = 8` (`shared/scoringThresholds.ts`).
- **A score only counts as High-Fit if it is *non-provisional*.** `NON_PROVISIONAL_POLICY`
  requires all of `thesis`, `stage`, `traction`, `founder`, `geo` to be assessable, ≥60%
  completeness, and ≥1 cited source. Both the Overview KPI and the Ranking widget explicitly
  exclude provisional scores from "High-Fit," even when the raw number is ≥8.0 — this was a
  defect that has since been fixed and is now covered by tests.
- **Traction is scored only from an analyst's own rating**, never inferred from public
  claims. `traction_reviews` currently holds **zero rows** — no analyst has rated any
  company — which is why traction is unassessable for all 213 companies today and,
  consequently, **zero companies currently qualify as High-Fit.** This is not a bug; it is
  the gate working as designed. **The document must not claim the platform currently
  contains 8–10 High-Fit companies — the true count is zero.**
- **Company-claimed evidence (e.g., a launch post or "About" page) is not independent
  verification.** It is captured to a `pending_evidence` queue as `company-claimed` and
  requires analyst accept/edit/reject before it can inform anything, and even an accepted
  claim does not, by itself, move a score — a human traction rating is still required
  separately.
- **Stage is inference-labeled, not asserted as fact.** The resolver marks every stage
  determination `basis: 'explicit'` (a source literally names a round) or `basis:
  'inferred'` (e.g., accelerator participation, SEC Form D presence) with materially lower
  confidence. An inferred stage is never presented as a confirmed financing round, and 199
  of 213 companies currently carry `stage = Unknown` precisely because no explicit round has
  been published for them.

**Correction required:** add one sentence to the scoring section making explicit that
company-supplied claims are queued for review, not treated as verified; and do not let the
walkthrough imply any current company is High-Fit.

## 5. Verticals

**Claim (implicit — the document does not enumerate verticals explicitly, but references
"vertical" filtering throughout).**

**Classification: Verified live.** Exactly five verticals exist (`src/data/taxonomy.ts`):
Health & Wellness, FinTech, Future of Work, Sustainability, Frontier. `LEGACY_VERTICAL_ALIASES`
confirms Robotics and SpaceTech both resolve to Frontier; AI is not a standalone vertical
(`ai → fow` alias covers horizontal/general AI); sector-specific AI (health AI, fintech AI,
etc.) is handled as a manual per-company reclassification into its relevant vertical, not an
automatic alias. No legacy vertical value exists in the live database (verified: `fintech
36 · fow 23 · frontier 55 · health 63 · sustainability 36`, summing to all 213 companies).

## 6. Overview / walkthrough claims

**Claim (lines 55–62):** four statistics ("deals discovered," "high-fit companies," "awaiting
review," "stale — not reviewed in over a month") plus a vertical breakdown chart, plus a
"Vamos Fit Ranking" snapshot.

**Classification: mostly Verified live, with one Inaccurate or outdated figure.**

- The current Overview implements **five** KPI cards per entity (Companies and Stealth
  Founders): **Discovered This Week, High-Fit, Stale, Awaiting Review, Cumulative** — the
  document's list is missing **Cumulative** entirely and should include it, with its
  supported time filters (all-time, this month, last month, this year, last year).
- **"Stale… not reviewed in over a month" is inaccurate.** The Overview KPI card uses a
  **fixed 7-day** rule by design ("a distinct, executive-facing metric the task specifies as
  exactly seven days," `server/services/executiveKpis.ts`). A *separate*,
  administrator-configurable staleness setting (default 30 days) exists elsewhere in the app
  (the Companies table and Settings), but it is not what the Overview KPI card measures. The
  document must not describe the KPI card's stale window as "over a month."
- **"Research Coverage" does not exist anywhere in the current application** and is actively
  tested against reappearing (11+ Playwright assertions across every route). No action
  needed in the revised document beyond not mentioning it — consistent with the source
  document's own note that this section is being removed.
- The ranking widget correctly excludes provisional scores from its "High-Fit" filter and
  sorts non-provisional companies ahead of provisional ones regardless of raw score —
  verified live, matches the document's implicit assumption that ranking respects fit.

## 7. Automation percentage

**Claim:** "Automation Level: 80%."

**Classification: Inaccurate or outdated — not defensible as a single number.**

Automated end-to-end, without a human in the loop: discovery (search execution across the
live source adapters), evidence capture and citation, deduplication, and score computation.

Requiring mandatory analyst judgment, by design, with no automated substitute: traction
assessment, stage confirmation (when no round has been publicly disclosed), final
disposition (Awaiting Review → Approved for HubSpot / Monitor / Passed), and all outreach
(a human reviews and edits every generated draft, and only a human ever sends it — there is
no send path in the code at all).

**Recommended replacement:** *"Automated: discovery, enrichment, evidence collection, and
score computation. Mandatory analyst review: traction, stage confirmation, final
disposition, and all outreach."* No percentage.

## 8. Review actions / disposition workflow

**Claim (lines 49–52):** "Not a Fit," "Track," "Outreach" as the three actions, each tied to
a specific HubSpot stage placement.

**Classification: Inaccurate or outdated (terminology); Implemented but not configured
(the HubSpot half of the action).**

The application's own stored disposition values are `New`, `Awaiting Review`, `Research
Needed`, `Approved for HubSpot`, `Synced to HubSpot`, `Monitor`, `Passed`
(`shared/integrations.ts`). "Track" and a score-derived "Prioritize" label exist only as
*display* text computed from the score in the Companies table — never written to the
database. The revised document should describe the workflow using these real status names,
and describe "Add/Update in HubSpot" as the action that carries a company into the separate
CRM pipeline (`RADAR_HUBSPOT_STAGES`: Surfaced → Needs Review → Approved to Track → Outreach
Approved → Outreach Drafted → Founder Contacted → Meeting Scheduled → Active Diligence →
Monitor/Passed) rather than conflating the app's own review status with the CRM's stage
names.

## 9. HubSpot integration

**Claim:** "Add to HubSpot" / "Update in HubSpot" button opens a menu, select pipeline and
stage.

**Classification: Implemented but not configured.**

- A complete, real HubSpot API client exists (`server/services/hubspot.ts`,
  `server/routes/hubspot.ts`, `src/components/HubSpotModal.tsx`), supporting either a
  private-app token (`HUBSPOT_ACCESS_TOKEN`) or a full OAuth flow.
- **No HubSpot credential of either kind is present in `.env`.** Calling the connect action
  today throws a real, honest "not connected" error — the code contains no mock/simulated
  success path that would make an unconfigured integration look functional.
- The UI and modal render correctly and can be **shown truthfully** in a screenshot labeled
  "implemented, not configured" — the button, pipeline/stage selectors, and menu are real
  UI, not a mockup — but **no live HubSpot record was created or updated to produce any
  screenshot in this package**, per this audit's own constraints.

## 10. Outlook integration and founder outreach

**Claim:** "Generate Founder Outreach" opens a menu, creates a personalized email draft for
review before sending; outreach drafts are saved/sent via Outlook.

**Classification: Implemented but not configured (Outlook); Verified live but template-only
today (draft generation).**

- Draft generation is real (`src/components/OutreachPanel.tsx`, `server/services/ai.ts`).
  When an AI provider is configured it calls a real model (Anthropic or OpenAI, selected by
  `AI_PROVIDER`); today **no AI provider is configured**, so drafts are produced by a
  **deterministic local template with no model call**.
- There is **exactly one send-adjacent action in the entire app: "Save to Outlook Drafts."**
  There is no send button and no send code path anywhere — a human always sends from their
  own Outlook after review. The document's phrasing ("the team member can review and edit
  the draft before it is sent") should make explicit that "sent" always means a human sends
  it from their own mailbox, never the platform.
- Saving to Outlook Drafts requires a live Outlook connection
  (`MICROSOFT_CLIENT_ID`/`SECRET`/`REDIRECT_URI`/`SESSION_SECRET`), **none of which are
  configured today** — the Save button is correctly disabled in this state, with an
  explanatory tooltip, rather than silently failing.
- The Outlook client, when configured, requests only `Mail.ReadWrite` and `User.Read` scopes
  — it explicitly never requests `Mail.Send`, so no code path in this application could send
  an email even once fully configured. This is a stronger guarantee than the document
  states and is worth keeping in the revised copy as a trust point.

## 11. Access / Microsoft Entra sign-in

**Classification: Implemented but not configured.**

- A complete, real OIDC authorization-code + PKCE flow for Microsoft Entra exists
  (`server/lib/microsoftAuth.ts`, `server/routes/auth.ts`), including JWKS verification, RSA
  signature checking, tenant-id checking, and audience checking.
- **It is not registered and not operational.** `.env` sets no `MICROSOFT_*` variable at
  all; `MICROSOFT_TENANT_ID` therefore falls back to its schema default of `'common'`, which
  the code's own tenant check explicitly rejects as invalid for this purpose (a concrete
  tenant GUID is required). `microsoftSsoConfigured()` is false today.
- **The shared `ADMIN_PASSWORD` is the only sign-in mechanism that currently works.**
  `effectiveAuthMode()` resolves to `'local'` because Entra is incomplete. The Microsoft
  sign-in button does not render in the UI while this is the case.
- **Access is not currently limited to `@vamosventures.com`.** The domain check exists in
  code and defaults correctly to `vamosventures.com`, but it only executes inside the
  Microsoft sign-in flow, which cannot run yet. Today, anyone who has the shared admin
  password can sign in — there is no per-user identity or domain restriction in force.
- **No team-accessible production URL exists.** No `vercel.json`, no `.vercel/` directory,
  and no hosting configuration of any kind is present in the repository. A team member
  cannot currently reach a hosted instance of the real application at all — only a developer
  running it locally can.
- **The document must not say Vamos email login is live.** The revised document instead
  describes an access screen with a Microsoft sign-in option present in the UI, captioned
  "Configuration pending" — never as a working sign-in path.

## 12. Deal Discovery configuration

**Claim (lines 89–104):** vertical, subcategory (dependent dropdown), search terms,
geography, states, stages, evidence date range; advanced: record mode (preview/save), min
confidence, max results, max API/model calls, max tokens.

**Classification: Verified live, with two naming corrections.**

- All standard fields exist and are functional. **Correction:** Subcategory is a **free-text
  input**, not a dependent dropdown constrained to the selected vertical's subcategories —
  the document's "dependent dropdown… displays only the subcategories associated with that
  vertical" oversells the current UI and should be revised to describe a free-text field
  (or the app should be described as-is; this audit does not recommend building the
  dependent dropdown to match the document, per the instruction not to manufacture
  functionality for documentation).
- **Correction:** "Record mode" in the running app is not literally a Preview/Save toggle.
  Its options are **New records only / Stale records only / All (include known
  duplicates)** — a de-duplication scope, not a preview-vs-persist choice. Every discovery
  run always produces a **Candidate Preview** of results before anything is imported; there
  is no separate mode that skips the preview step.
- All five advanced settings (max results, max API calls, max model calls, max tokens, min
  confidence) exist exactly as named, with live defaults and a running cost estimate.
  **Correction:** they render inline alongside the standard fields today, not under a visually
  separate, collapsed "Advanced Settings" heading as the source document describes. The
  revised document below describes them as presented "with recommended defaults" rather than
  claiming a collapsed section that does not exist in the UI.

## 13. Stealth Radar

**Claim (line 108):** founder profile, likely focus, public signals, confidence level, save
to research queue, outreach.

**Classification: Verified live, with one precision note.** The page is real and functions
as described: founder cards, GitHub/patent/conference/grant/role-change signals, "Confirm
founder"/"Reject" actions with a required reason, a status field restricted to `Awaiting
Review / Research Needed / Monitor / Passed`, and outreach/HubSpot/notes actions per
candidate. **Precision note:** the on-screen confidence value is a **numeric percentage**
(e.g., "confidence 72%"), not a low/medium/high label — the document's "low, medium, or
high confidence level" phrasing describes a different feature (the analyst Traction Review
control) and should be corrected for Stealth Radar specifically.

## 14. Reconciliation with the reported engineering baseline

Independently re-verified this session, matching the reported baseline exactly:

| Metric | Value |
|---|---|
| Schema version | 20 |
| Companies | 213 |
| Founders (resolved) | 247 |
| Founder candidates | 382 |
| Scoring rows | 879 |
| Pending evidence | 44 |
| Traction reviews | 0 |
| High-Fit companies | 0 |
| Unit tests | 1,110 passed / 56 files |
| Playwright tests | 131 passed |
| Typecheck / lint / build | clean |
| `db:integrity` | OK |
| `smoke-test` | all checks passed |

No discrepancy was found between this session's direct measurement and the reported
baseline.

---

## Summary of required corrections to the revised document

1. Remove "Claude Code" as the runtime AI model; describe the actual (currently
   template-only) outreach-drafting model path.
2. Remove the flat "80%" automation figure; use the itemized automated-vs-reviewed language.
3. Describe Monday 8:00 a.m. Pacific as the **intended cadence once hosted**, and describe
   the actual mechanism (rolling ~7-day interval, hourly due-check, inactive by default, no
   hosted environment exists yet).
4. Replace the source list with the exact per-source availability table in §3, including the
   SBIR outage.
5. State plainly that **zero** companies are currently High-Fit, and why (traction requires
   an analyst rating; none has been recorded).
6. Add the missing **Cumulative** KPI card and correct "stale" to a **fixed seven days** for
   that card.
7. Correct the review-action names to the real `COMPANY_STATUSES` enum; stop describing
   "Not a Fit / Track / Outreach" as stored dispositions.
8. Label Microsoft sign-in, HubSpot, Outlook send-adjacent actions, and live-model outreach
   generation as **implemented, not configured** — never as currently working end to end.
9. Correct Deal Discovery's subcategory field (free text, not a dependent dropdown) and
   record mode (dedup scope, not preview/save).
10. Correct Stealth Radar's confidence display to a numeric percentage.
11. State that company-claimed evidence requires analyst accept/edit/reject and is not
    independent verification by itself.
