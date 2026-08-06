# Screenshot index

All images in [screenshots/](screenshots/) were captured with Playwright
(`playwright.demo.config.ts`, `e2e-demo/screenshots.spec.ts`) against the
static demo build (`npm run build:demo` + `npm run preview:demo`,
`VITE_DEMO_MODE=true`) — the real application's own components and
routes, rendering bundled synthetic fixtures. Desktop viewport
1440×900, device scale factor 1. Every image carries the
"Demo — Synthetic Data — External actions disabled" banner. **No image
in this package shows real company, founder, or deal data.**

To regenerate: `npm run build:demo && npx playwright test -c playwright.demo.config.ts`.

## Mapping to the supplied document's placeholders

| Placeholder in the source document | Screenshot(s) used |
|---|---|
| `[screenshot of Overview page here]` | `02-overview-dashboard.png` |
| `[screenshot of Companies page here]` | `04-all-deals-filters.png` (master table); `03-vertical-deals-page.png` as the companion per-vertical view referenced elsewhere in the same section |
| `[screenshot of founder outreach here]` | `11-founder-outreach-preview.png` |
| `[screenshot of HubSpot menu here]` | **Omitted — see §12 below.** |
| `[screenshot of Deal Discovery page here]` | `07-deal-discovery-configuration.png` + `08-deal-discovery-results.png` (one placeholder, two sequential images — configuration then results) |
| `[screenshot of Stealth Radar here]` | `09-stealth-radar.png` |

Four images (`01`, `05`, `06`, `10`) have no placeholder in the original
draft; they support material the revised document added (Access,
Company profile, Score/founders/evidence, Review actions) and are new
additions, not duplicates of an existing placeholder.

---

## 01 — `01-access-screen.png`

- **Document section:** Access (new section in the revised document).
- **Caption:** "Current access screen — password sign-in works today; Microsoft sign-in is built and shown here as planned, pending Entra registration. Configuration pending."
- **Demonstrates:** The real sign-in screen, unmodified. The amber notice ("Sign-in is moving to Microsoft single sign-on…") is the application's own honest, live status text — not added for this screenshot.
- **Synthetic data:** N/A (no company data on this screen).
- **Feature-availability caveat:** Microsoft sign-in is **implemented, not configured** — there is no working Microsoft button on this screen today, by design; it is not rendered until Entra is registered.
- **Suggested crop:** Full frame (banner + card).
- **Alt text:** "Vamos Deal Radar sign-in screen showing the administrator password field and a notice that sign-in is moving to Microsoft single sign-on, limited to @vamosventures.com accounts."

## 02 — `02-overview-dashboard.png`

- **Document section:** Walkthrough of Platform → Overview.
- **Caption:** "Overview — five KPI cards (Discovered This Week, High-Fit, Stale, Awaiting Review, Cumulative), the Vamos Fit Ranking snapshot, and the vertical breakdown chart. Synthetic demo values."
- **Demonstrates:** The current five-card KPI layout (not four, and not the retired "Research Coverage"/"Last Run" cards); the ranking table correctly ranks the one synthetic High-Fit example above provisional scores regardless of raw number.
- **Synthetic data:** Yes — all counts and the ranked company are demo fixtures.
- **Feature-availability caveat:** None — this is the real, current Overview.
- **Suggested crop:** Full frame.
- **Alt text:** "Deal Radar Overview page with five KPI cards, a stale-companies list, a Vamos Fit ranking table led by a labelled synthetic example, and a coverage-by-sector chart."

## 03 — `03-vertical-deals-page.png`

- **Document section:** Walkthrough of Platform → Companies (per-vertical view).
- **Caption:** "Frontier vertical view — score, company, subcategory, stage, geography, and founder/team information for one sector."
- **Demonstrates:** A single-vertical filtered view of the All Deals table, reached via the sidebar's Frontier link.
- **Synthetic data:** Yes.
- **Feature-availability caveat:** None.
- **Suggested crop:** Full frame, or the table region only.
- **Alt text:** "All Deals table filtered to the Frontier vertical, showing two synthetic companies with their fit score, subcategory, stage, location, and founder."

## 04 — `04-all-deals-filters.png`

- **Document section:** Walkthrough of Platform → Companies (master table).
- **Caption:** "All Deals — multi-vertical filtering (FinTech + Frontier selected here), stage/state/review-age controls, and the opportunity & evidence filter row."
- **Demonstrates:** Multi-select vertical filtering and the full filter bar, including the "possible duplicate"/"missing information" data-quality flags and the opportunity/evidence secondary filter row.
- **Synthetic data:** Yes.
- **Feature-availability caveat:** The "not reviewed in N days" control is a free numeric input in the current UI, not a preset 7/14/30-day dropdown — see [DOCUMENT_ACCURACY_AUDIT.md](DOCUMENT_ACCURACY_AUDIT.md) §6.
- **Suggested crop:** Full frame.
- **Alt text:** "All Deals page with FinTech and Frontier vertical filters selected, showing the full filter bar and a ranked table of synthetic companies."

## 05 — `05-company-profile.png`

- **Document section:** Walkthrough of Platform → Company profile (new subsection).
- **Caption:** "Company profile — header, score, vertical/subcategory, stage, location, and review state for the illustrative High-Fit example."
- **Demonstrates:** The expanded company detail header and its "Company overview" section.
- **Synthetic data:** Yes — "Solstice Robotics (Illustrative Example)," explicitly labelled in its own on-screen copy as a synthetic demo example.
- **Feature-availability caveat:** None.
- **Suggested crop:** Top portion of the expanded row (score card + overview section).
- **Alt text:** "Expanded company detail for the synthetic example Solstice Robotics, showing its Vamos Fit Score, company overview fields, and review status."

## 06 — `06-score-founders-evidence.png`

- **Document section:** Walkthrough of Platform → Score, founders, evidence (new subsection).
- **Caption:** "Detailed score breakdown, founder resolution, and evidence — scrolled to the Founders section of the same company record."
- **Demonstrates:** Component-by-component score rationale, a confirmed founder resolution with its source, and the "as originally imported" founder comparison.
- **Synthetic data:** Yes.
- **Feature-availability caveat:** None. Pending-vs-verified evidence is demonstrated more directly by the pending-evidence queue attached to this same company (visible further down this record; also present on Copilot Forge in the underlying fixture set).
- **Suggested crop:** Founders section through the top of Funding & traction.
- **Alt text:** "Company detail scrolled to the Founders section, showing a confirmed founder resolution with source citation next to the originally imported founder record."

## 07 — `07-deal-discovery-configuration.png`

- **Document section:** Walkthrough of Platform → Deal Discovery.
- **Caption:** "Deal Discovery search configuration — standard fields alongside budget/advanced settings, and the three-of-eight source picker."
- **Demonstrates:** Vertical, subcategory (free text), search terms, geography, states, stages, date range, record mode, and the budget caps, plus per-source live/credentials-required state.
- **Synthetic data:** N/A (configuration screen; no company data).
- **Feature-availability caveat:** "Run discovery" is disabled in this demo build (sourcing runs are never performed here) — visible on screen as "Disabled in demo." Advanced settings render inline today, not under a separate collapsed section — see [DOCUMENT_ACCURACY_AUDIT.md](DOCUMENT_ACCURACY_AUDIT.md) §12.
- **Suggested crop:** Full frame.
- **Alt text:** "Deal Discovery configuration form with vertical, geography, stage, and budget fields, and a disabled 'Run discovery' button labelled Disabled in demo."

## 08 — `08-deal-discovery-results.png`

- **Document section:** Walkthrough of Platform → Deal Discovery (results).
- **Caption:** "Candidate Preview with evidence confidence and source provenance, and Sourcing Run History below it."
- **Demonstrates:** Two pre-populated candidates (confidence, duplicate status, evidence count) awaiting import, and a run-history row with cost/timing detail.
- **Synthetic data:** Yes — candidates and run history are bundled fixtures, never the output of a live run in this build.
- **Feature-availability caveat:** These results are illustrative, not the output of a live search — no sourcing run was executed to produce this screenshot.
- **Suggested crop:** Full frame.
- **Alt text:** "Deal Discovery candidate preview listing two synthetic candidate companies with confidence and evidence counts, above a sourcing run history table."

## 09 — `09-stealth-radar.png`

- **Document section:** Walkthrough of Platform → Stealth Radar.
- **Caption:** "Stealth Radar — founder profile, likely focus, supporting public signals, and a numeric confidence level."
- **Demonstrates:** A probable-candidate founder card with match evidence, confidence, and the Confirm/Reject action.
- **Synthetic data:** Yes.
- **Feature-availability caveat:** Confidence renders as a numeric percentage on this page, not a low/medium/high label — see [DOCUMENT_ACCURACY_AUDIT.md](DOCUMENT_ACCURACY_AUDIT.md) §13. Confirm/Reject is present but disabled from writing anything in this demo build.
- **Suggested crop:** Full frame.
- **Alt text:** "Stealth Founder Radar showing one probable candidate with GitHub and departure-announcement signals, a 58% confidence score, and a Confirm or reject control."

## 10 — `10-review-actions.png`

- **Document section:** Walkthrough of Platform → Human action / review actions (new subsection).
- **Caption:** "Current review-status controls (Stamp reviewed, Refresh live research, Send for research, Monitor, Pass) and team actions (Approve & add to HubSpot, Generate founder outreach)."
- **Demonstrates:** The exact, current workflow control names — no retired status ("Not a Fit," bare "Approved," "Synced") is shown because none exists in the running application.
- **Synthetic data:** Yes.
- **Feature-availability caveat:** All buttons on this panel are real, but every one is disabled from completing a write in this read-only demo build.
- **Suggested crop:** Left review-status column plus the Team actions panel.
- **Alt text:** "Company review panel with status controls (Stamp reviewed today, Refresh live research, Send for research, Monitor, Pass) and team actions Approve and add to HubSpot, Generate founder outreach."

## 11 — `11-founder-outreach-preview.png`

- **Document section:** Walkthrough of Platform → Founder outreach.
- **Caption:** "Generated outreach draft (template-generated — no AI model configured) with editable subject/body and required human-review framing before any send."
- **Demonstrates:** The complete draft-review UI: editable fields, the "no AI model called" badge, the supporting-evidence link, and the explicit "This is a demo draft. No email can be sent or saved from this build" notice.
- **Synthetic data:** Yes — synthetic founder ("Priya Nakamura," part of the Solstice Robotics fixture).
- **Feature-availability caveat:** Saving to Outlook Drafts is disabled in this demo build (Outlook is not connected). Nothing was sent or saved to produce this image.
- **Suggested crop:** Full modal.
- **Alt text:** "Founder outreach draft modal for a synthetic founder, showing an editable subject and body, a note that no AI model was called, and a notice that no email can be sent or saved from this build."

## 12 — omitted: HubSpot review menu

**Not captured, by design — not an oversight.**

The real "Add to HubSpot" action first requires changing the company's
review status to "Approved for HubSpot" (`setStatus`, see
[src/components/CompanyTable.tsx](../../src/components/CompanyTable.tsx)),
and only opens the HubSpot menu after that write succeeds. The demo
build's explicit "does not permit writes" rule blocks every mutation,
including that one internal status change — so the button that would
open the HubSpot menu correctly shows an error rather than opening it.

Capturing this screenshot would have required either (a) performing a
write, which the demo-mode safety rules exist specifically to prevent,
or (b) fabricating a UI state that no real interaction produces —
either of which contradicts this package's own ground rules. The
[SOURCING_WORKFLOW_REVISED.md](SOURCING_WORKFLOW_REVISED.md) document
instead describes the HubSpot menu's real, current fields (pipeline,
stage, the CRM stage list) in prose, and states plainly that the
integration is implemented but not connected for the team today — see
[DOCUMENT_ACCURACY_AUDIT.md](DOCUMENT_ACCURACY_AUDIT.md) §9.

---

## Package

`Vamos-Deal-Radar-Screenshot-Pack.zip` (same directory) contains the 11
PNGs above and this index file — nothing else. Build with:

```bash
cd docs/sourcing-workflow
zip -j Vamos-Deal-Radar-Screenshot-Pack.zip screenshots/*.png SCREENSHOT_INDEX.md
```
