# Vamos Deal Radar — final pilot report

Date: 2026-08-06 · Branch: `frontend-redesign` · Schema: v20

---

## 1. Overall verdict

**The local pilot is ready to use. The hosted pilot is blocked on external configuration.**

The audit found the implementation substantially complete against the stakeholder
requirements — and found that the single most consequential piece of it, the analyst
pending-evidence workflow, had never been connected to anything. The service, the HTTP
routes, the API client and the UI panel all existed and were tested; nothing in production
ever inserted a row. On a database of 209 companies, `pending_evidence` held zero.

It also found that an unsourced stage *inference* was being written to the company row and
scored, across 195 of 209 companies.

Both are fixed, with regression tests. The four named candidates are materialized
idempotently. A controlled sourcing run was executed and **found no company that qualifies
as High-Fit** — and that is reported here as the honest result, not worked around.

The most important single fact in this report:

> **No company in the database is High-Fit, and none can be until an analyst records a
> traction review.** Traction is assessable only from a human rating; it is unassessable for
> 213 of 213 companies, and it is a required component of the non-provisional gate. This is
> the model refusing to score what nobody has told it. It was not circumvented.

## 2. Local-pilot readiness

Ready. Launch, URLs, sign-in, review workflow, backup/restore and recovery are documented in
[PILOT_RUNBOOK.md](PILOT_RUNBOOK.md).

```bash
npm run dev
```

Frontend **http://localhost:5173** · Backend **http://localhost:8787**

## 3. Hosted-pilot status

**BLOCKED — external configuration required.** Not deployed, and not attempted.

Three of eighteen security prerequisites are met. The blocking ones: Microsoft Entra is
implemented but unconfigured, so the only working authentication is a shared
`ADMIN_PASSWORD`; and the datastore is a single SQLite file, which is wrong for hosted
compute. Full detail, the exact variables needed, who must provide them, and the
post-configuration verification checklist are in
[DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md).

No paid account was created, no tenant was registered, no credential was requested through
chat, and authentication was not weakened.

## 4. Baseline vs final

The handoff's figures were close but not all correct. Actuals, measured before any change:

| | Handoff claimed | Actual baseline | Final |
|---|---|---|---|
| Schema version | 19 | **19** ✓ | **20** |
| Companies | ~209 | **209** ✓ | **213** |
| Founders | ~372 | **237** ✗ | **247** |
| `founder_candidates` | — | 372 | 382 |
| Scoring rows | ~676 | **676** ✓ | **879** |
| `pending_evidence` | possibly 0 | **0** ✓ | **44** |
| `traction_reviews` | — | 0 | **0** (unchanged, by design) |
| Unit tests | 1,076 | **1,076 pass** ✓ | **1,110 pass** (56 files) |
| Playwright | 124 | **124 pass** ✓ | **131 pass** |

**The "372 founders" claim was wrong.** 372 was the `founder_candidates` count — research
candidates, not confirmed founders. The `founders` table held 237. The discrepancy mattered:
it concealed defect #3 below, where only one founder per company reached the table the UI
and the scorer actually read.

Verticals (final): health 63 · frontier 55 · fintech 36 · sustainability 36 · fow 23. Exactly
the five approved verticals; no legacy value present.

## 5. Recovery point

| | |
|---|---|
| File | `server/.data/backups/deal-radar-2026-08-06T12-27-18-874Z.db` |
| SHA-256 | `593b64c2ffd1aec19b719b34e595e74593eb44b9c21fb3e5d44adb6a89b8e66b` |
| Size / schema | 6,264 KB · v19 · 209 companies |
| Integrity | **ok** (`PRAGMA integrity_check` on an isolated copy, so the pristine file was not migrated) |
| Restore test | **passed** — damaged a copy by deleting 50 companies (209→159), restored, verified 209 |
| Rollback | Confirmed: the restore path took an automatic pre-restore safety backup |

Rehearsed on isolated copies before touching the real database. Neither the database nor any
backup is committed.

## 6. Companies added or updated

Four added, through the normal pipeline (persisted candidate → `importCandidates` →
`runEnrichment(apply)`), never by direct row writes.

| Company | Domain | Vertical | Stage | Review status | Founders | Pending evidence | Latest score |
|---|---|---|---|---|---|---|---|
| Manifold | manifoldindustries.ai | frontier | Unknown | Awaiting Review | 2 | 4 | 8.2 **provisional** (55%) |
| Grade | usegrade.com | fintech | Unknown | Awaiting Review | 2 | 10 | 7.8 **provisional** (55%) |
| Unifold | unifold.io | fintech | Unknown | Awaiting Review | 3 | 19 | 8.2 **provisional** (55%) |
| Scheduling Wizard | schedulingwiz.com | health | Unknown | Awaiting Review | 3 | 11 | 7.1 **provisional** (55%) |

None is Approved, Passed, Synced or High-Fit. No traction or stage rating was recorded. All
44 pending items are `pending`, `company-claimed`, with **no analyst identity attached**.

Also updated: **195 companies** had an unsourced inferred stage cleared and were re-scored
append-only (§9).

**Unifold requires a partner mandate ruling.** Multi-chain crypto deposit/payment
infrastructure sits in the FinTech "DeFi & blockchain" subcategory, which the taxonomy marks
as an adjacent/exception category that may conflict with current firm exclusions. Its
presence in the pipeline is **not** an in-mandate decision.

## 7. Duplicate prevention

- Identity is the **canonical domain**, never the name.
- The YC directory contains both `Manifold` (S26, manifoldindustries.ai) and
  `Manifold Freight` (W24, manifoldfreight.com). Only one Manifold row exists, and it is the
  right one. Manifold Freight was returned by the same sweep and deliberately not matched.
- **Idempotency verified by running the entire finalization twice.** Every count identical:
  companies 213, founders 247, pending_evidence 44, scoring_results 879, evidence 244. The
  stage correction is likewise a no-op on re-run.
- `pending_evidence` dedups on `UNIQUE (company_id, kind, quote)`; re-recording a profile
  inserted 0 rows.

## 8. Founder extraction

All founders verified against the live public YC pages, matching the expected names exactly:

| Company | Founders |
|---|---|
| Manifold | Joshua Ibrahim; Nicolas Yeh |
| Grade | Lotanna Ezeike; James Heaney |
| Unifold | Timothy Chung; Hau Chu; Quang Huynh |
| Scheduling Wizard | Samuel Oberly; Zachary Dermody; Abdelrahman Hamimi |

Counts 2/2/3/3 match the team sizes YC publishes. Desktop/mobile duplicates collapsed; the
non-founder employee on Scheduling Wizard's page (`Head of Sales`) excluded; identity matched
on domain for all four.

## 9. Pending stage and traction evidence

44 items. The parser fixes changed what is captured and how it is attributed — see §11.

**Scheduling Wizard** (9 about the company, 2 not):
- "20 departments across 16 hospitals already outsource their physician scheduling to us…" → suggests *multiple-deployments*
- "…active contracts at Mass General, Johns Hopkins, UT Southwestern, LA General, UCF and more!" → suggests *pilot*
- "With our design partners at UCSF and other major healthcare systems…" → suggests *design-partner*
- "Our clients now review schedules we build…" → suggests *named-customer*
- The CTO's work "at GEICO used internally across multiple departments" → **prior-company, no suggestion**

All stored as **company-claimed**, none independently confirmed.

**Grade** (7 about the company, 3 not):
- "In the last 30 days, companies used Grade to pay out **$380k+** to creators, **up 120% MoM**" — captured with its original meaning as commercial-usage evidence. **This is payment volume, not revenue,** and it was not transformed into one. No traction state is suggested for it.
- "At my last company, I managed $10M+ in contractor payouts" → **founder-bio, aboutThisCompany=false, no suggestion** — founder-market-fit evidence about a prior company.
- "Creators were our main growth channel, and they helped us reach millions of users" → **prior-company, no suggestion** (it continues the "Before Grade…" beat).

Grade's traction remains **Unknown**: the current categories cannot represent per-payout
volume faithfully, and forcing it would corrupt the fact.

**Unifold** (12 about the company, 7 not):
- Design-partner / integration language: "We're already working with ecosystems … including Algorand, MegaETH, and Thru" → suggests *pilot*; "a single integration that handles deposits end-to-end" → suggests *design-partner*.
- "Before Unifold, we built wallet-as-a-service infrastructure and were acquired … where we helped onboard **30M+ users**" → **prior-company, no suggestion.** Crediting a three-person W26 company with 30M+ users would have been the single most inflating misattribution on the page.

**Manifold** (2 about the company, 2 not): no credible company traction claim exists.
**Traction remains Unknown.** Nothing was invented from accelerator selection, founder
pedigree, market size or product description. The one company-level sentence captured is a
*market-size* claim ("The US Warehouse industry spends $75bn on labor each year") and it
carries **no** suggested traction state. Recommended next step: founder outreach / further
diligence — **no outreach was sent.**

**Stage, all four:** YC batch, Active status, founding year and location are stored as cited
facts. The inference "Early-stage — round not publicly disclosed" is queued as a **pending
suggestion** whose basis explicitly states *"INFERENCE, not a stated round: YC participation
is not a financing event."* It is **not applied**; all four rows read stage `Unknown`.

## 10. Why nothing is non-provisional or High-Fit

Required components must all be assessable. Measured across all 213:

| Blocking component | Unassessable for | Share |
|---|---|---|
| **traction** | **213** | **100%** |
| stage | 199 | 93% |
| founder | 123 | 59% |
| geo | 58 | 28% |
| thesis | 54 | 26% |

Also, 182 of 213 fall below the 60% completeness floor.

**Traction alone is sufficient to block every company**, and it is unassessable by design:
`tractionSignal` treats a note of "Unknown / not yet researched / unrated" as *unrated*, and
`traction_reviews` has **0 rows** — no analyst has rated any company. So the exact blocker
for each of the top candidates is the same, and it is a missing human judgement:

| Top candidate | Score | Blocked by |
|---|---|---|
| Manifold | 8.2 | traction, stage, geo |
| Unifold | 8.2 | traction, stage |
| Grade | 7.8 | traction, stage |
| PromptLoop | 8.0 | traction, stage, founder |
| Scheduling Wizard | 7.1 | traction, stage |

Manifold and Unifold already exceed 8.0 on raw score. They are **not** High-Fit, because the
score is provisional. Reporting them as High-Fit would be exactly the inflation this pass
exists to prevent. The action that legitimately changes this is an analyst opening each
company and recording a traction review against the evidence now queued for them.

## 11. The controlled sourcing run

One run, all five verticals, two arms (pre-existing behaviour vs current), preview mode —
nothing persisted. 23 API requests, **$0.00**; every source is a key-free public endpoint.

| Metric | baseline | current |
|---|---|---|
| Candidates fetched | 84 | 42 |
| Reached the review queue | 84 | **9** |
| Dropped by thesis filter | 0 | 33 |
| Duplicates identified | 38 | 7 |
| Scorable | 59 (70%) | 3 (33%) |
| **Provisional rate** | **100%** | **100%** |
| Median score | 7.8 | 5.5 |
| Max score | 7.8 | 5.5 |
| **Scoring ≥ 8.0** | **0** | **0** |

The current arm's median is *lower*, and that is the improvement: the 7.8 median came from
old accelerator alumni scoring on evidence-quality and recency components rather than on
evidence about the business. The thesis filter removed 33 of them.

The three survivors after enrichment — Smallest.ai ($13M voice AI), Base Power ($1B round),
Natural ($30M agent payments) — are all provisional at 5.0–5.5 with 20–30% completeness, one
independent source each, no traction evidence, and each flagged *"No identifiable customer or
buyer in the published text."* Base Power is late-stage; Natural is a likely duplicate of an
existing record.

**No new candidates were imported from this run.** Under the stated criteria they are weak
filler — importing them would raise a count and inform nothing. The genuine additions from
this pass are the four current-cohort YC companies in §6.

**Source outage, reported not hidden:** the SBIR/STTR grants API refused all traffic
("The SBIR Public API is not available at this time"). Grant coverage for this run is
**ABSENT, not empty-but-checked**. Nothing was inferred or substituted.

## 12. Defects found and fixed

Nineteen. Each has a regression test; none was fixed by relaxing a threshold, a test, or an
evidence rule.

**Evidence pipeline**
1. **`pending_evidence` was unreachable in production.** `recordYcPendingEvidence` had no caller outside tests, while enrichment wrote a note claiming claims were "captured for analyst review". Wired into `runEnrichment`'s apply block.
2. **An unsourced stage inference was scoring itself.** The `early-stage-round-not-disclosed` residual — whose own explanation says *"not because any evidence establishes it"* — was stamped on the company row, worth 9/15 and `assessable`, on **195 of 209** companies, every one `inferred`, none explicit. Gated to explicit resolutions; the inference stays visible with its confidence.
3. **Only one founder per company reached the `founders` table.** All were resolved as `verified-founder` in `founder_candidates`; the UI and scorer saw one. Unifold and Scheduling Wizard displayed 1 of 3.
4. **The currency branch of the traction pattern could never match.** `\b` before `$` cannot hold after a space, so money-only claims were invisible — including Grade's entire commercial result.
5. **Claims stated in unpunctuated block elements were dropped or mangled.** Launch posts use markup, not periods. Segmentation now preserves block boundaries; an excerpt no longer begins mid-URL.
6. **Prior-company narrative inside launch posts was attributed to the current company.** Unifold's "30M+ users", Grade's "millions of users", Scheduling Wizard's GEICO sentence.
7. **The launch-post slab was unbounded** and could read a neighbouring company's sentence as this company's claim.
8. **Not-about-this-company claims were deleted rather than labelled.** They are now stored, flagged, and given **no suggested state** — readable and citable, never one click from becoming traction.

**Dashboard and navigation**
9. `?vertical=ai` (and `robotics`, `spacetech`, `aoi`) produced an empty table with no filter lit. Normalized; multi-vertical lists supported; unrecognized values fall back to the unfiltered view.
10. **`/spacetech` had no route** — the canonical historical spelling fell through to the catch-all and rendered the Overview under a `/spacetech` URL.
11. `verticalById` used a non-null assertion on an unvalidated database value — a latent TypeError mid-render for a legacy `aoi` row.
12. The Overview ranking widget used a bare `>= 8` and **ignored provisionality**, so a provisional 8.2 appeared in the High-Fit list while the High-Fit card excluded it.
13. **Partial-run disclosure was dead code.** `KpiCard.warning` and `KpiBreakdownModal.partialRunNote` had no callers; a run that completed with failing sources produced a normal-looking number.
14. The Cumulative modal showed **All-Time data under another period's heading** when the period query failed or was in flight.
15. Simulated runs were **not** excluded from "latest completed run" despite a comment saying they were.

**Queue precision**
16. `enterprise-buyer` fired from **our own subcategory label** — "Healthcare infrastructure", "warehouse and logistics robotics". One taxonomy match satisfied both the substantive-evidence gate and the quality band, making "Promising" reachable from sector language alone.
17. Uncited, **machine-written** founder backgrounds counted as substantive, while the parallel path required a citation for the same evidence.

**Workflow integrity**
18. **"Edit" edited nothing** — it posted a status and discarded the analyst's change. Migration 20 adds `edited_quote`; the published quote is retained alongside it.
19. **A recorded decision was silently overwritable**, and `saveCompany` was **not transactional** — a mid-write failure could leave a half-written company, or destroy founders while replacing them.

### Test expectations changed (4, each an intentional documented correction)

- Grade's prior-company `$10M+` is now asserted **present and flagged** with no suggestion, rather than absent. Absence passed for the wrong reason.
- Re-deciding a decided item is now asserted to be **refused**, rather than succeeding by last-write-wins on a table documented as append-only.
- An uncited founder background is asserted **not** substantive; a cited `founder-market-fit` signal is asserted to still qualify.
- Grade's payment-volume assertion now matches the words the live page prints (`$380k+`, `120% MoM`) instead of a phrase only the fixture contained.

## 13. KPI totals and reconciliation

| | |
|---|---|
| Companies (retained, active) | 213 |
| Awaiting Review | 211 · Approved for HubSpot 2 |
| Cumulative (All Time, sourced) | counts records with a `discovery_source`; CSV imports are excluded, so it is legitimately lower than the All Deals row count |
| High-Fit | **0** (requires latest non-provisional ≥ 8.0) |
| Provisional | **213 of 213** |
| Stale | driven by `last_reviewed_at` only; automated refreshes never stamp it |
| Stage | Unknown 199 · Series B+ 6 · Series A 4 · Seed 2 · Pre-seed 2 |
| Scoring rows | 879, append-only (676 baseline + 195 corrections + 4 imports + 4 re-scores) |

Reconciliation of the score-row growth: 676 + 195 (stage correction) + 4 (new imports) + 4
(post-enrichment re-score of the four) = 879. No row was updated or deleted.

## 14. Taxonomy verification

Five approved verticals only, declared once in `src/types.ts` and given display metadata in
`src/data/taxonomy.ts`. No stored value outside the five. Robotics and SpaceTech resolve to
Frontier (Manifold — warehouse robotics — is stored `frontier`). AI is not a standalone
vertical; horizontal AI defaults to Future of Work and market-specific AI goes to its market.
Every alias in `LEGACY_VERTICAL_ALIASES` now has a route, asserted by a test that iterates
the alias table so a future alias cannot be added without one. No company was lost or
duplicated by reclassification; founder relationships and historical evidence are intact.

## 15. Review-workflow verification

Verified in a real browser (7 new Playwright specs) against an **isolated** database — no
fabricated analyst decision was written to the development database:

- The original claim, its openable source, provenance and access date are all visible.
- A suggestion renders as *"Suggested: … — not applied"*.
- A founder's prior-company claim is labelled and carries no suggested state.
- Accept, **edit-before-accepting**, and reject all work; the edit stores the correction and keeps the published quote.
- Accepting a claim leaves traction at level 0 with an unrated note — **no score moved**.
- Re-deciding a decided item returns **409** naming the prior decider.
- Automated refreshes never stamp `last_reviewed_at` (`countsAsCompanyReview: false`).
- Re-applying the same parsed evidence inserts nothing.
- Failed writes roll back completely (asserted for both create and update paths).

## 16. Browser walkthrough

- Launched with `npm run dev`; frontend 5173, backend 8787.
- Sign-in gate renders and correctly states that sign-in is moving to Microsoft SSO limited to `@vamosventures.com`.
- **Unauthenticated `/api/companies/imported` and `/api/overview/kpis` both return 401.**
- `/health/live` → `{"status":"live"}`; `/health/ready` → `{"status":"ready"}`.
- **No console errors.**
- The authenticated UI — Overview, all ten KPI cards, cumulative filters, All Deals, multi-vertical filtering, the five vertical pages, company profiles, founder detail, pending evidence, Source Health, review queues, absence of "Research Coverage", API persistence after refresh, and responsive/mobile layout — is covered by the 131-test Playwright suite, which drives a real Chromium against the real UI.
- **I did not type the administrator password into the sign-in form.** Entering a user's credential is not an action I take; the authenticated walkthrough was performed by the E2E suite using its own test-only credential against an isolated database. To view the four companies in the running dev app yourself, sign in at http://localhost:5173 and open `/companies?vertical=fintech` (Grade, Unifold), `?vertical=frontier` (Manifold), `?vertical=health` (Scheduling Wizard).

## 17. Commands run, and results

| Command | Result |
|---|---|
| `npm run typecheck` | **clean** |
| `npm run lint` | **clean** (3 pre-existing `react-refresh` warnings, untouched) |
| `npm test` | **1,110 passed / 56 files** (baseline 1,076 / 54) |
| `npm run test:e2e` | **131 passed** (baseline 124 + 7 new) |
| `npm run build` | **success** |
| `npm run db:integrity` | **OK** |
| Fresh-empty-database migration | **schema v20, 33 tables** |
| Upgrade path v19 → v20 | **succeeded, 209 companies preserved** |
| Backup open + integrity | **ok** |
| Restore + rollback | **passed** (209 → 159 damaged → 209 restored) |
| `npm run smoke-test` | **all checks passed** |
| `npm run db:correct-stage` | 195 corrected, 0 skipped, append-only re-score |
| `npm run pilot:finalize` | 4 imported; **re-run = 0 changes** |
| `npm run discovery:preview` | 1 run, 23 requests, $0.00, 0 candidates ≥ 8.0 |

No test was weakened and no threshold was moved. The build initially failed on a real error
in one of my own new tests (a server test importing a `.tsx` module); the helper was moved to
a `.ts` module rather than loosening the compiler.

## 18. Launch command and URLs

```bash
npm run dev
```

- Frontend: **http://localhost:5173**
- Backend API: **http://localhost:8787**
- Health: `http://localhost:8787/health/live`, `http://localhost:8787/health/ready`

## 19. Git

| | |
|---|---|
| Commit | **`eb6845640786d24822386820a1cdc50b17cb424b`** |
| Subject | `Connect the analyst evidence queue, and stop scoring a stage nobody stated` |
| Branch | `frontend-redesign` (not pushed — no push authorization was given) |
| Scope | 112 files changed, 16,157 insertions, 706 deletions |
| Working tree after | **clean** |

One local checkpoint commit. **Nothing was pushed, no PR was opened, and no release was
published** — none of those was separately authorized.

Excluded from the commit and verified not staged: `.env`, `server/.data/` (the database and
every backup), `dist/`, `test-results/`, and logs — all gitignored. A targeted credential
scan over every staged file (OpenAI/GitHub/Slack/AWS key shapes, private-key headers, quoted
password assignments) returned nothing. The only credential-like strings in the tree are the
E2E fixture's deliberately fake `e2e-test-admin-password` / `e2e-test-session-secret`.

Nothing was left uncommitted: all 112 changed files belong to this stacked implementation
effort, and there were no unrelated user files in the worktree.

## 20. Remaining human decisions

1. **Record traction reviews.** Nothing is High-Fit until this happens. The evidence is
   queued; the judgement is not automatable and was not automated.
2. **Rule on Unifold's mandate** — DeFi/crypto adjacency needs an explicit partner decision.
3. **Decide Grade's traction representation.** Payment volume is not revenue and no current
   category fits it faithfully. Either accept Unknown, or extend the traction vocabulary.
4. **Decide the four companies' stage.** The pipeline will no longer assert a round nobody
   published.
5. **Manifold next step** — no traction claim exists publicly; founder outreach or further
   diligence is the recommended step, and no outreach was sent.
6. Confirm whether the Cumulative **card** (as opposed to the modal) should stay All-Time.
7. Consider whether 195 companies with stage `Unknown` warrants a targeted stage-research
   pass, now that the gap is visible rather than papered over.

## 21. External administrator actions still required

1. **Microsoft Entra app registration** on the `vamosventures.com` tenant — needs an
   Application/Global Administrator. Blocks all hosted deployment.
2. **Hosting + durable storage decision and budget approval** — SQLite-on-a-file must not be
   hosted as-is.
3. **Provision the Vamos-controlled private environment** with HTTPS, secret storage and a
   rollback mechanism.

Exact variable names, redirect-URI requirements, verification checklist and rollback steps
are in [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md).

---

## Appendix — what was deliberately not done

- No company was marked Approved, Passed, Synced or High-Fit by hand.
- No traction or stage rating was recorded. `traction_reviews` is still empty on purpose.
- No outreach, no CRM record, no email; no company, founder, investor or third party was contacted.
- No production data was mutated; only the local development database, after a verified recovery point.
- No secret, `.env` file, database, backup or log was committed.
- No test, threshold, evidence rule, authentication check or data-integrity protection was weakened to produce a passing result.
- No fabricated analyst decision was written to the development database; mutation testing used an isolated one.
