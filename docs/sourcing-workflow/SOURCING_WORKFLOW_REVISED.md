# Sourcing Platform Process (revised)

Workflow Last Updated: August 6, 2026 · Revises the July 22, 2026 draft against the running
application (schema v20). Every unsupported statement in the prior draft has been corrected;
see [DOCUMENT_ACCURACY_AUDIT.md](DOCUMENT_ACCURACY_AUDIT.md) for the line-by-line basis of
each change. Screenshots referenced below are in [screenshots/](screenshots/) and indexed in
[SCREENSHOT_INDEX.md](SCREENSHOT_INDEX.md); all use synthetic demonstration data (see the
"Demo — Synthetic Data" banner in every image) and no real Vamos deal or founder record.

**Description:**
Deal sourcing platform that proactively searches for and scores deals based on fit with
VamosVentures, including stage, industry, founder demographics, and geography. The platform
includes a built-in HubSpot client and an Outlook draft-creation client; both require
credentials that are not yet configured for the team (see Access, below), so today these are
implemented capabilities rather than live team workflows.

**Objective:**
Improve the efficiency and consistency of sourcing relevant deals by vertical.

**What initiates this workflow:**
An administrator runs a sourcing search — either on demand today, or on a schedule once the
platform is hosted continuously (see Frequency). Investors manually review the results and
decide next steps; no result is ever auto-approved, auto-passed, or auto-contacted.

**Frequency:**
Weekly is the **intended operating cadence once the platform is hosted**. This is not yet an
active production automation: the scheduler exists in code, defaults to inactive, and only
runs while a backend process is continuously hosted, which is not currently the case (see
Access). The underlying mechanism checks hourly whether ~7 days have elapsed since a job's
last run — it is a rolling interval, not a calendar-anchored trigger — so "Monday 8:00 a.m.
Pacific" should be read as the target planning cadence the team intends to schedule around,
not a guaranteed exact firing time even after hosting begins.

**AI Model(s):**
The sourcing and scoring pipeline itself is rule-based, not model-based — it does not call an
AI model to search, classify, or score. The one place the platform can call a model is
founder-outreach draft generation, which supports Anthropic or OpenAI once a provider key is
configured. No provider is configured today, so drafts are currently produced by a
deterministic local template with no model call.

**Automation Level:**
Automated without human involvement: discovery execution against live source connectors,
evidence capture with citations, deduplication, and score computation.
Mandatory human review, with no automated substitute: traction assessment, stage
confirmation (whenever no round has been publicly disclosed), final disposition, and all
outreach — every draft is reviewed by a person, and only a person ever sends it.

**Human Review Required:**
Yes. Investors review surfaced deals and move them through the platform's own review states
(New → Awaiting Review → Research Needed, ending in Approved for HubSpot / Monitor / Passed),
separately deciding whether to add or update the company in HubSpot and, if appropriate,
generate an outreach draft.

---

## Workflow Process Steps

**1. Automated search of best-fit companies.** The VamosVentures Deal Radar searches for
companies matching VamosVentures' criteria:
- Vertical (Health & Wellness, FinTech, Future of Work, Sustainability, Frontier — Frontier
  includes both robotics and space technology; horizontal AI is treated as a technology
  applied within Future of Work rather than a vertical of its own, and sector-specific AI is
  classified into its relevant vertical)
- Geography (U.S.-based, and other approved target markets)
- Stage (Pre-Seed – Series A)
- Diverse founding team

The platform pulls from **currently live, key-free public sources**: the Y Combinator
directory, GitHub, SEC EDGAR (Form D filings), public funding-news feeds, seventeen investor
newsroom feeds, and arXiv. Product Hunt is implemented and will activate once a
`PRODUCTHUNT_TOKEN` is configured. SBIR/STTR grant data is implemented but depends on a
government API that is intermittently unavailable — when it is down, grant coverage for that
run is reported as absent, not silently treated as empty. Accelerator directories beyond YC,
hackathons, and public registries are planned, not yet built. Every result carries a source
link and access date so the team can verify the origin of any fact pulled into the platform.

**2. Companies are ranked and categorized.** Each company receives a Vamos Fit Score out of
10, based on:
- Vertical fit
- Stage fit (higher for Seed and Series A)
- Mission alignment (diverse team)
- Traction signals — **scored only from an analyst's own recorded rating, never
  automatically inferred from a company's own claims.** A company's website or launch-post
  claims are captured for review (see Step 4) but do not by themselves move this component.
- Founder signals (count, education, relevant experience, prior company-building experience)
- Geography

A score of 8.0 or higher counts as **High-Fit only when it is also non-provisional** — every
required component (thesis, stage, traction, founder, geography) must be assessable, overall
completeness must be at least 60%, and at least one cited source must support it. **As of
this writing, zero companies in the platform are High-Fit**, because no analyst has yet
recorded a traction rating for any company — traction is the one component that can never be
inferred, only rated by a person, and it currently blocks every record. This is the intended
behavior of the gate, not a defect: it prevents an unverified claim from reading as a
verified one.

**3. Optional Deal Discovery tool.** Team members can run an additional search at any time,
independent of the scheduled cadence, configured by vertical, subcategory (free text),
search terms, geography, states, stages, and an evidence date range. An "Advanced Settings"
section (left at its defaults for most users) controls a de-duplication scope (new records
only / stale records only / all, including known duplicates), a minimum evidence-confidence
threshold, and budget caps on results, external API calls, model calls, and estimated token
usage, with a live running cost estimate. Every run — scheduled or manual — always produces a
Candidate Preview for review before anything is saved to the review queue; nothing is
imported automatically.

**4. Optional Stealth Radar tool.** Similar to Deal Discovery, but for founders who may be
building in stealth. It reviews public signals — GitHub activity, patent filings, conference
participation, grants, role changes, and public announcements — and presents a founder
profile, likely area of focus, the supporting signals, and a numeric confidence score. The
team can research further, confirm or reject the candidate with a stated reason, assign a
review status, or begin outreach.

**5. Human action.** The Deal Radar surfaces candidates; every next step is a human decision.
Reviewing a company moves it through the platform's own states — **New, Awaiting Review,
Research Needed, Approved for HubSpot, Synced to HubSpot, Monitor, or Passed** — which are
distinct from HubSpot's own pipeline stages. Separately, for any company the team wants
tracked externally, "Add to HubSpot" / "Update in HubSpot" creates or updates the CRM record
and lets the team pick the pipeline and stage — **this requires a configured HubSpot
connection, which the team does not yet have** (see Access). For companies the team wants to
contact, "Generate Founder Outreach" produces a draft for review and editing; the only
available action after that is **saving the draft to the founder's own Outlook drafts
folder** for the team member to review and send themselves — the platform has no send
capability at all, by design, and saving likewise requires a configured Outlook connection
the team does not yet have.

---

## Access

*(screenshot: [01-access-screen.png](screenshots/01-access-screen.png) — "Planned Microsoft
access screen / configuration pending")*

The application requires sign-in. A complete Microsoft Entra (Vamos SSO) sign-in flow is
built into the platform, but **it is not yet registered with Microsoft and is not
operational** — no tenant, application, or redirect URI has been created for it yet. Until
an Entra administrator completes that registration, the only way to sign in is a single
shared administrator password, and access is **not** currently restricted to
`@vamosventures.com` accounts by anything other than who is told that password. There is
also currently no team-accessible hosted URL — the application runs only on a developer
machine today. The Microsoft sign-in option appears in the interface as a preview of the
intended access model, not as a working path.

## Walkthrough of Platform

**Overview** — *(screenshot:
[02-overview-dashboard.png](screenshots/02-overview-dashboard.png))*

The Overview page shows five statistics, for both Companies and Stealth Founders:
- **Discovered This Week** — new records surfaced since the start of the current week
- **High-Fit** — companies (or founders) currently scoring ≥8.0 **and** non-provisional (see
  Step 2 above — this is currently zero for companies in the live database, and the
  screenshot's synthetic High-Fit example is clearly labeled as illustrative)
- **Stale** — not reviewed in the last **seven days** (a fixed rule for this card,
  deliberately separate from the longer administrator-configurable staleness setting used
  elsewhere in the app)
- **Awaiting Review** — active records still in New or Awaiting Review status
- **Cumulative** — a running total with selectable time filters (all-time, this month, last
  month, this year, last year)

A Vamos Fit Ranking snapshot lists the top companies from the most recent sourcing activity,
filterable by vertical and stage, and correctly excludes provisional scores from its
High-Fit view even when the raw number would otherwise qualify. It is a snapshot, not the
full company list — the All Deals page is the complete view.

**All Deals** — *(screenshots:
[03-vertical-deals-page.png](screenshots/03-vertical-deals-page.png),
[04-all-deals-filters.png](screenshots/04-all-deals-filters.png))*

The All Deals / vertical pages list every company currently tracked, with filters for
vertical (multi-select), stage, state, a numeric "not reviewed in N days" control,
minimum-evidence-confidence, and several data-quality flags (possible duplicate, missing
information). Companies can be sorted by Vamos Fit Score, discovery date, or evidence
recency, and exported to CSV exactly as filtered. Each row shows the score, company name,
vertical, subcategory, stage, location, and team information at a glance.

**Company profile** — *(screenshot:
[05-company-profile.png](screenshots/05-company-profile.png))*

Opening a company shows its header, summary, score, vertical/subcategory, stage,
headquarters, and current review status.

**Score, founders, and evidence** — *(screenshot:
[06-score-founders-evidence.png](screenshots/06-score-founders-evidence.png))*

Clicking through shows the full score breakdown component by component, founder
information, and every supporting evidence item with its source link and access date.
Evidence appears in two distinct groups: **verified/cited evidence** already backing the
company record, and a separate **pending evidence** queue of company-claimed statements
(e.g., from a launch post or "About" page) awaiting analyst accept, edit, or reject — a
claim in the pending queue is never presented as an accepted fact until a person disposes of
it, and accepting it still does not by itself change a score.

**Deal Discovery** — *(screenshots:
[07-deal-discovery-configuration.png](screenshots/07-deal-discovery-configuration.png),
[08-deal-discovery-results.png](screenshots/08-deal-discovery-results.png))*

Standard search fields (vertical, subcategory as free text, search terms, geography, states,
stages, evidence date range) appear alongside a set of advanced settings (de-duplication
scope, minimum evidence confidence, and budget caps) with recommended defaults most users
should leave unchanged — these render inline today rather than behind a separate collapsed
section. Running a search produces a Candidate Preview — using the same layout as All Deals —
plus an entry in Sourcing Run History recording the date, criteria, status, and result count
of every run.

**Stealth Radar** — *(screenshot: [09-stealth-radar.png](screenshots/09-stealth-radar.png))*

Shows a founder's name, title, location, likely area of focus, the public signals behind that
assessment, and a numeric confidence score, with actions to research further, confirm or
reject with a reason, change review status, or begin outreach.

**Review actions** — *(screenshot:
[10-review-actions.png](screenshots/10-review-actions.png))*

Shows the platform's own current disposition controls (New / Awaiting Review / Research
Needed / Approved for HubSpot / Synced to HubSpot / Monitor / Passed) — these are the
platform's internal review states, separate from HubSpot's own pipeline stages described
below.

**Founder outreach** — *(screenshot:
[11-founder-outreach-preview.png](screenshots/11-founder-outreach-preview.png))*

Clicking "Generate Founder Outreach" produces an editable draft. The only action available
afterward is saving the draft to the founder's own Outlook Drafts folder for a human to
review and send from their own mailbox — there is no send action anywhere in the platform,
and saving requires a configured Outlook connection the team does not yet have (see Access).
Nothing was sent to produce this screenshot; the founder shown is synthetic.

**HubSpot** — *(no screenshot — see [SCREENSHOT_INDEX.md](SCREENSHOT_INDEX.md) §12 for why one
was not captured)*

"Add to HubSpot" / "Update in HubSpot" opens a menu for selecting the pipeline and stage. The
integration is fully built, including the CRM pipeline mapping (Surfaced → Needs Review →
Approved to Track → Outreach Approved → Outreach Drafted → Founder Contacted → Meeting
Scheduled → Active Diligence → Monitor/Passed), but **no HubSpot account is connected for the
team yet**. Reaching this menu requires first changing a company's review status, which — like
every other mutation — is not permitted in the read-only demo build used for this screenshot
package; rather than fabricate the resulting screen, no image of it is included here.

---

## What is genuinely automated today vs. what always requires a person

| Automated (no human in the loop) | Always requires a human |
|---|---|
| Running a configured search against live source connectors | Confirming traction (score component is unassessable without it) |
| Capturing evidence with a source link and access date | Confirming a financing stage when no round has been publicly disclosed |
| De-duplicating candidates against existing records | Deciding a company's final disposition (Approved for HubSpot / Monitor / Passed) |
| Computing the Vamos Fit Score from assessable components | Reviewing and editing every outreach draft before it exists outside the platform |
| Flagging a score as provisional when a required component is missing | Sending any email — there is no send capability in the platform at all |
| | Connecting HubSpot and Outlook (both require credentials only an administrator can provision) |
| | Registering Microsoft Entra sign-in (requires a tenant administrator) |
