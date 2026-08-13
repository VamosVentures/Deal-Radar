# Vamos Deal Radar — Client Briefing

Prepared 2026-08-10. Every number here was verified against the code today, not copied from older docs.

**Assumption to correct if wrong:** this is a build-status + onboarding meeting — you explain what was built and ask them to unblock credentials/hosting. If it's a sales/demo meeting instead, lead with §1–§3 and §11, and treat §10 as "what onboarding looks like" rather than "what we need this week."

---

## 1. The 60-second version

Deal Radar is an internal deal-sourcing and review tool. It continuously pulls early-stage company signals from public, authorized data sources, scores each company against the firm's investment thesis with a fully auditable 100-point model, and puts them in a human review queue. A person — never the software — decides what advances. Approved companies sync to HubSpot; outreach gets drafted into Outlook, and a human presses send.

The design principle that runs through every layer: **it never invents anything.** No sample data, no scraping, no guessed numbers, no automatic outreach. When it doesn't know something, it says so.

---

## 2. The idea and why it exists

The problem: sourcing at the earliest stage is manual and unevenly documented. Companies get found through scattered channels, evaluated inconsistently, and the reasoning behind a pass or a pursue lives in someone's head or an email thread.

Three things we set out to fix:

1. **Coverage** — surface companies from public signals systematically instead of ad hoc.
2. **Consistency** — one transparent scoring model applied identically to every company, with a point-by-point rationale you can defend to a partner or an LP.
3. **Auditability** — every company on record traces back to a dated, named, linkable source. There is no "we heard about them somewhere."

What we deliberately did *not* build: a CRM (HubSpot is the CRM), an auto-outreach machine, or a black-box AI ranker.

---

## 3. How it works, end to end

```
Public sources → normalize → dedupe → enrich → score → HUMAN REVIEW → HubSpot / Outlook draft
                                                        ▲
                                              nothing passes this line
                                                     automatically
```

1. **Discovery** — a scheduled or manual run queries each enabled public source with a per-run API-call budget.
2. **Validate** — every external response is checked against a strict schema before it's trusted. A source returning an unexpected shape fails closed rather than writing garbage into the database.
3. **Normalize & dedupe** — results become a common company/evidence shape and get matched against existing records for likely duplicates.
4. **Enrich** — cross-source merging fills in stage, vertical, founders, funding evidence where multiple sources corroborate.
5. **Score** — the 100-point Vamos Fit Score (below), plus a separately tracked *evidence confidence* percentage.
6. **Review** — candidates sit in a queue. A human explicitly imports; nothing auto-imports. Reviewers move companies through a 7-state lifecycle: New → Awaiting Review → Research Needed / Monitor / Passed / Approved for HubSpot → Synced.
7. **Act** — an approved company can be synced to HubSpot (one at a time, explicit click) or have outreach drafted into Outlook.

**The Fit Score (v3.0)** — 100 points, displayed as 1.0–10.0: thesis/vertical fit 20 · stage fit 15 · mission alignment 15 · traction signal 10 · founder & team evidence 10 · geography 10 · funding evidence 5 · accelerator/institutional validation 5 · evidence quality 5 · evidence recency 5. Every score carries a point-by-point breakdown in the UI and a versioned snapshot, so an old score stays interpretable even if we change the model later.

**Policy exceptions flag, they don't reject.** Off-thesis, DeFi/blockchain, and hardware-heavy companies keep their score and carry a visible warning routed to partner review. The software doesn't get to veto.

---

## 4. What it's built with

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + TypeScript, Vite, Tailwind v4, React Router, Recharts | Standard, fast, no exotic dependencies |
| Backend | Node.js + Express 5, TypeScript | One router per domain; routers only validate and delegate |
| Validation | Zod schemas in `shared/`, enforced on **both** sides of the wire | The same contract validates the browser request and the server response |
| Database | SQLite via Node's built-in `node:sqlite`, WAL mode | Zero native/compiled dependencies — nothing to build, nothing to patch |
| Tests | Vitest + Supertest (unit/integration), Playwright (real-browser E2E) | See below |
| CI | GitHub Actions on every PR and push to main | typecheck → lint → tests → build → E2E |
| Deploy | Docker container; Render blueprint checked in | Single instance + persistent volume |

**Architecture in one line:** the browser holds no secrets and no tokens, ever. It talks only to same-origin `/api/*`; the Express backend owns every credential.

**Test posture — the number worth quoting:**
- **1,158 automated tests across 57 files, full suite runs in ~11 seconds.** All passing as of today.
- Plus Playwright end-to-end tests driving a real Chromium browser against an isolated backend, frontend, and throwaway database. The E2E harness intercepts every outbound network call, so no third-party API is ever contacted during a browser test.
- CI needs **no secrets** to run — the harness is fully self-contained.

*(Note: the README still says "242 tests across 22 suites." That's stale — it's 1,158 now. Worth fixing before anyone reads the repo.)*

---

## 5. Where the data comes from

This is the section most likely to get scrutiny, and it's a strength. **Every live source is a public, official, credential-free API or feed.** Nothing is scraped.

**Live today (no credentials needed):**

| Source | What it gives us |
|---|---|
| SEC EDGAR — Form D filings | Official full-text search. Real filings parsed into candidates: company name, CIK, filing-index URL, business state, filing date |
| Investor newsrooms (17 VC firms) | A page counts **only** if it's hosted on that firm's verified domain *and* states the firm took part in the round. A VC writing about someone else's deal is press, not a record. Live-verified: one real run read 177 items → 18 financing events |
| Public funding-news RSS | Headline-stated fundings only — no inference |
| SBIR/STTR government awards | Official federal award API |
| GitHub public API | Engineering-activity signal |
| arXiv | Public research papers. A lead requires a listed author affiliation, used verbatim — most papers omit it, so honest zeros are common |
| Y Combinator public directory | Public directory entries |
| CSV / JSON upload | Manual import, validated server-side |

**Needs one credential:** Product Hunt (developer token). Built and schema-validated; refuses to run without a token rather than faking a result.

**Honestly unavailable, and the UI says so:** patent databases (the free PatentsView API was retired — we won't build against an endpoint that doesn't exist), plus accelerator sites, hackathons, and state registries (no adapter built yet).

**Explicitly refused:** LinkedIn, PitchBook, and Crunchbase requests are rejected with a 422. They are never scraped. Licensed data would require a real agreement first — there isn't even a credential variable for it.

**Two rules to say out loud:**
- A source with no working adapter returns **zero results and says so**. It never falls back to sample data.
- The app ships **completely empty**. No bundled demo companies, no seeded leads, no mock integrations. Test fixtures exist only under `server/tests/` and are injected through test-only hooks the running app can't reach.

**On sensitive data:** demographic indicators are *verified or absent*. They only cross the wire with a self-identification basis, a named source, a source URL, and a verification status — the schema rejects anything less. Identity columns in a CSV import are refused outright with a 422. Nothing is ever inferred about a founder. The Stealth Founder Radar is deterministic, permanently labeled *Hypothesis · Unverified · Requires human review*, and structurally cannot include names, schools, locations, or networks.

---

## 6. Database and storage

- **SQLite**, WAL journal mode, one file on disk. Versioned, forward-only migrations run automatically on boot.
- **Why SQLite:** at 1–3 concurrent users with low write volume it's the right call — no separate database to host, secure, patch, or pay for, and no native dependency. It's a deliberate scale-appropriate choice, not a shortcut.
- **The honest limit:** SQLite is single-instance. Horizontal scaling or multi-region needs a migration to Postgres. That's a known, planned-for boundary, not a surprise.
- **Backups:** `VACUUM INTO` snapshots (WAL-safe, consistent) to a local `backups/` directory with a metadata sidecar recording counts and timestamps only — never row contents. Default retention: 14 files or 30 days.
- **Restore is CLI-only, by design.** There is no restore button in the browser anywhere. A restore validates the file's SQLite header, takes an automatic pre-restore safety backup, runs an integrity check before *and* after, and auto-rolls-back on any failure.
- **Gap to disclose:** backups are local-disk only. There is no offsite/cloud backup destination configured yet. If they need one, that's a hosting decision (§10).

---

## 7. Security measures

**Authentication — this is stronger than the older security doc says.** Microsoft Entra SSO is now implemented in code:

- Two modes: shared admin password (`local`) and Microsoft Entra SSO (`microsoft`), plus `hybrid`. The default `auto` mode uses the password until SSO is fully configured, then switches itself over — nobody has to remember to turn the password off.
- **SSO validates 11 things** on every sign-in: signature, issuer, **tenant GUID pinned to the Vamos directory**, audience, expiry, not-before, issued-at, nonce (constant-time compared), a stable subject, verified-email flag, and email domain.
- **`common` is refused.** The app will not consider SSO configured without a concrete tenant GUID — because `common` would let any Microsoft account on earth complete the flow, leaving a text string in a token as the only thing keeping strangers out.
- **Guest and externally-federated accounts are rejected**, even inside the tenant. They live in the directory but their credentials are checked elsewhere.
- Sessions: HMAC-SHA256-signed, HttpOnly, SameSite=Lax, Secure in production, 12-hour expiry, verified statelessly. **No Microsoft token ever goes into the cookie.**

**Everything else:**

| Control | Implementation |
|---|---|
| Fails closed | No credential configured = feature entirely **disabled**, never open |
| Rate limiting | 300 req/min global; 10 login attempts/15 min; 30/min outreach; 20/min refresh — per IP |
| Input validation | Every request body and query parsed through Zod before use; malformed input rejected with 400, never partially processed |
| External-response validation | Every third-party response schema-checked before it's trusted |
| SSRF protection | Rejects non-http(s) schemes, private/loopback/link-local literals, **and** does a DNS lookup to reject hostnames that *resolve* to internal addresses |
| Secrets at rest | OAuth tokens AES-256-GCM encrypted in the database, key derived from `SESSION_SECRET`. Never sent to the browser |
| Timeouts | Every outbound call has a 10s timeout (8s GitHub) with one bounded retry — never infinite |
| Error sanitization | Stack traces and internal detail stripped from client responses; 5xx logged server-side only |
| Secret redaction | Bearer tokens, `sk-` keys, long hex strings, and JWTs scrubbed from any text before audit logging |
| Password handling | Constant-time comparison (`timingSafeEqual`), never logged, never echoed |
| Idempotency | Mutating routes accept an `Idempotency-Key`; a repeat within 2 minutes returns 409 — a double-clicked button can't create duplicate CRM records |
| Audit logging | Every admin login (success and failure) and admin-gated action recorded, with redaction applied first |
| Blast-radius limits | Bulk review capped at 200 IDs/request; **no bulk HubSpot sync exists** — it's excluded server-side, not just hidden in the UI |

**The single most important security fact:** *there is no code path anywhere in this application that sends an email.* Every Microsoft Graph call site targets draft creation only. A human opens Outlook and sends. That's an architectural constraint, not a config toggle someone can flip.

**Scope minimization we flagged ourselves:** `Mail.ReadWrite` is broader than draft-only creation needs. We raised it for review rather than quietly requesting it. Sign-in and mailbox access are deliberately separate consents with separate redirect URIs — signing in to read company records never requires handing over mailbox access.

---

## 8. Compliance posture

Framed as: what data, from where, with what basis.

- **Data collected is public and business-level.** Company names, filings, funding announcements, repos, papers, directory entries. No consumer PII, no health data, no financial account data. The schema has no free-text PII fields.
- **Lawful collection basis.** Official public APIs and published feeds only. Rate-limit politeness is enforced in code (per-host minimum gaps and attempt caps). SEC's automated-client identification request is honored via `SEC_CONTACT_EMAIL`. Investor feeds were each probed for a permissive robots.txt. Terms-restricted platforms are refused at the API layer.
- **Human decision-making.** No automated outreach, no automated CRM writes, no automated status transitions. Every consequential action has a named human approval point. This matters if anyone asks about automated-processing rules.
- **Demographic/identity data.** Verified-only, self-identified, sourced, or absent. Inference is impossible by schema design, not by policy.
- **AI data-sharing — the open item.** If an AI key is configured, company facts already in our database go to Anthropic or OpenAI under their retention terms. **Those terms have not yet been reviewed against an internal data-handling policy.** Nothing is currently sent — no key is configured anywhere. Raise this proactively; it's the one compliance question with a genuinely open answer.
- **Audit trail — a real gap.** Currently capped at the 500 most recent entries with no export and no external log sink. If they need durable audit retention, that's a build item, and it's small.
- **Attribution gap under the shared password.** In `local` mode every admin action is attributed to "admin," not an individual. Under SSO it's attributed to a named Entra identity. If individual accountability is a requirement, SSO isn't optional — it's the prerequisite. The session deliberately records *which* provider answered, so shared-password work can never be mistaken for a named employee's.

---

## 9. Costs

**AI (optional, currently $0.00 — no key configured anywhere):**

| Scenario | Monthly |
|---|---|
| Light — 1 dashboard rebuild, ~20 refreshes, ~10 drafts | ≈ $3–4 |
| Normal — weekly rebuild, ~100 refreshes, ~50 drafts | ≈ $12–16 |
| Heavy — twice-weekly rebuild, ~300 refreshes, ~150 drafts | ≈ $35–45 |

Unit economics: ≈ **$0.03 per company researched** typically, $0.11 worst case. A full 35-company dashboard across all 7 sectors ≈ **$2.31** typical, $7.70 worst case.

**The guardrails are the story here, not the numbers:**
- **$50/month hard cap.** The 51st dollar cannot be spent — the check compares *projected* spend (current + worst case of the call about to be made) against the cap, so a single expensive call can't straddle the limit.
- **$10 per-run cap** — deliberately above the $7.70 worst-case full rebuild, so a complete rebuild can never breach a run budget on its own.
- Warnings at $25 and $40 that warn without blocking. Per-candidate caps: 3 web searches, 30k input tokens, 2k output tokens. Concurrency capped at 2.
- A kill switch, a per-call cost ledger, and prompt-injection sanitization. Model pricing is encoded with the September 1 price change already built in — the budget math updates itself on the changeover date.
- **Unknown model pricing defaults to an expensive fallback**, so the budget refuses *earlier* than reality requires. Safe direction by construction.
- **Best case is genuinely $0.00/month.** With no key, every AI feature falls back to a deterministic local template built only from verified facts, clearly labeled "Local template — no AI model."

**Hosting:** a single small container plus a 1GB persistent volume (Render blueprint is checked in, `starter` plan, Oregon region). Small-single-digit dollars per month territory — *confirm current list price before quoting a number.*

**Data sources: $0.** Every live source is credential-free and free to use. This is worth emphasizing — the sourcing engine has no data-licensing line item at all.

**Everything else — HubSpot, Microsoft, GitHub — runs on licenses they already own.**

So: **the realistic all-in run rate is hosting plus $0–45/month of optional AI, with a hard $50 ceiling.**

---

## 10. What we need from them, and why

Ordered by what unblocks the most. Every single item is optional — **the dashboard runs today with zero credentials**: live sourcing across all sectors, scoring, dedupe, the full review queue, and backups all work right now.

| # | What | Why it's needed | Owner | What breaks without it |
|---|---|---|---|---|
| 1 | **Hosting decision** — provider, region, persistent volume | SQLite needs a durable disk; the scheduler only fires on a continuously-running backend | IT/infra | Runs locally only; scheduled sourcing shows "Configured but inactive" |
| 2 | **Microsoft Entra app registration** — client ID, secret, **tenant GUID**, two redirect URIs | Enables named-user SSO and (separately) Outlook drafts | IT/infra | Falls back to the shared password; no per-user attribution; no Outlook drafts |
| 3 | **Secret storage decision** — managed secret store vs. `.env` on host | Currently `.env` files on the backend host | IT/infra | Works, but secrets live in files on disk |
| 4 | **HubSpot private-app token** + the `vamos_*` custom properties | HubSpot has no anonymous API; writes fail without the properties | Client | Sync button honestly reports "not connected." Review still works |
| 5 | **AI API key** (Anthropic recommended) | No unauthenticated tier exists | Client | Drafts come from the deterministic local template |
| 6 | **Product Hunt developer token** | Adapter refuses to run without one | Client | That one source returns zero and says so |

**How to frame the ask:** these are decisions and credentials, not development work. Everything on the other side of each one is already built, tested, and waiting.

**Two things to say explicitly:**
- **Start read-only on HubSpot.** The `.read` scopes alone are enough to verify the connection, run search, and exercise duplicate detection. Write scopes only matter for the sync action itself. This is a genuinely low-risk first step and it's a good de-risking offer to put on the table.
- **Send the client secret through a secure channel, not email.**

---

## 11. Status — what's real and what isn't

Lead with this rather than letting them find it. The credibility of everything above depends on it.

**Verified real:** the sourcing pipeline against live public APIs, scoring, dedupe, the review queue, admin auth, SSO validation logic, backup/restore, and all 1,158 tests.

**Built and tested against stubs, never yet exercised against a real production account:** HubSpot, Outlook, and the AI providers. The client code is complete and unit-tested; no real token has been used from this environment. Say this plainly — it's exactly what item #4/#5/#6 above unblock.

**Known limitations, stated up front:**
- Shared admin password until Entra SSO is configured (then it switches itself off).
- SQLite is single-instance — Postgres before any multi-instance deployment.
- Audit log capped at 500 entries, no export yet.
- Backups are local-disk only, no offsite copy.
- A narrow DNS-rebinding TOCTOU window remains in the SSRF guard (documented; closing it fully needs a custom fetch agent).
- Replies are tracked manually — the draft-status check confirms *sent*, not *replied*.
- No third-party security review or red-team has been done.

---

## 12. Things worth adding that you didn't ask about

1. **Show it, don't just describe it.** There's a demo build (`npm run build:demo`, then `npm run preview:demo`) with populated companies — far more convincing than slides. Ten minutes clicking through Discovery → review queue → a score breakdown → an honest "not connected" empty state will land harder than any of this document.
2. **Make the honesty the pitch.** "It ships empty and tells you when it doesn't know" is unusual and it's your differentiator. Most tools in this category quietly guess. Lead with it rather than treating it as a caveat.
3. **The evidence-confidence metric.** Separate from the fit score: it tells you how well-sourced a record is, independent of how good the company is. A 9.0 on thin evidence and a 9.0 on deep evidence are different decisions. That distinction is a good demo moment.
4. **Ask what "done" means to them.** Their answer determines whether the audit-log export, offsite backups, and Postgres are must-haves or someday-items. Right now those are engineering judgment calls made without their input — get their requirements on record in this meeting.
5. **Propose a bounded first phase.** Read-only HubSpot + SSO + hosting, no AI key, no write scopes. It's a small, reversible surface that proves the whole loop, and it gives a cautious reviewer an easy yes.
6. **Get the AI data-retention question answered.** It's the one open compliance item. Ask whether it needs a DPA or specific retention settings before a key goes in — don't let it surface later as a surprise.
7. **Fix the stale README test count before anyone reads the repo.** 242 → 1,158. Small thing, but if a technical reviewer spots a stale number they start doubting the rest.

---

## Quick-reference numbers

- **1,158 tests**, 57 files, ~11 seconds, all passing
- **8 live data sources**, all public and credential-free, $0 in data costs
- **100-point** scoring model across 10 weighted components
- **11 validation checks** on every SSO sign-in
- **$50/month** hard AI ceiling; **$0.00** spent to date
- **≈ $0.03** per company researched; **≈ $2.31** for a full 35-company dashboard
- **Zero** code paths that send an email
- **Zero** bundled demo or sample data in the shipping app
