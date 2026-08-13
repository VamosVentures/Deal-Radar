import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned, forward-only migrations. Each entry runs once per
 * database inside a transaction and is recorded in `migrations`.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      -- ── Companies (the lead domain) ────────────────────────────
      CREATE TABLE companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        domain TEXT,
        website TEXT,
        one_liner TEXT NOT NULL,
        vertical TEXT NOT NULL,
        subcategory TEXT NOT NULL,
        stage TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        founded_year INTEGER NOT NULL,
        team_size INTEGER NOT NULL,
        traction_level REAL NOT NULL,
        traction_note TEXT NOT NULL,
        flags TEXT NOT NULL DEFAULT '[]',            -- JSON array of policy flags
        status TEXT NOT NULL DEFAULT 'active',       -- active | merged
        merged_into TEXT,
        review_status TEXT,                          -- e.g. Needs Review
        discovery_source TEXT,
        discovered_at TEXT,
        last_refreshed TEXT,
        hubspot_company_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_companies_normalized_name ON companies (normalized_name);
      CREATE INDEX idx_companies_domain ON companies (domain);
      CREATE INDEX idx_companies_hubspot ON companies (hubspot_company_id);

      CREATE TABLE founders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        background TEXT NOT NULL,
        email TEXT,
        email_source TEXT,
        linkedin TEXT
      );
      CREATE INDEX idx_founders_company ON founders (company_id);

      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        claim TEXT NOT NULL,
        source TEXT NOT NULL,
        url TEXT NOT NULL,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        added_by TEXT NOT NULL DEFAULT 'import',     -- import | discovery | merge | user
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_evidence_company ON evidence (company_id);

      CREATE TABLE company_external_ids (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        UNIQUE (source_id, external_id)
      );

      -- Field provenance: verified | extracted | user-entered | ai-inferred | unverified | missing
      CREATE TABLE field_provenance (
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        origin TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        UNIQUE (company_id, field)
      );

      -- Uncertain matches wait here for a human decision.
      CREATE TABLE possible_duplicates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        other_company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
        matched_by TEXT NOT NULL,                    -- fuzzy-name | founder-evidence | …
        similarity REAL NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',      -- pending | confirmed-duplicate | not-duplicate
        created_at TEXT NOT NULL,
        resolved_by TEXT,
        resolved_at TEXT
      );

      -- ── Sourcing ───────────────────────────────────────────────
      CREATE TABLE source_runs (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        run_type TEXT NOT NULL,
        mode TEXT NOT NULL,
        query TEXT NOT NULL,                         -- JSON
        discovered INTEGER NOT NULL,
        updated_existing INTEGER NOT NULL,
        duplicates_skipped INTEGER NOT NULL,
        rejected_by_validation INTEGER NOT NULL,
        imported INTEGER NOT NULL,
        errors TEXT NOT NULL,                        -- JSON array
        api_calls INTEGER NOT NULL,
        model_calls INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        initiated_by TEXT NOT NULL
      );

      CREATE TABLE source_run_results (
        run_id TEXT NOT NULL REFERENCES source_runs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        found INTEGER NOT NULL,
        detail TEXT NOT NULL,
        failure_kind TEXT
      );
      CREATE INDEX idx_run_results_run ON source_run_results (run_id);

      -- ── Decisions, scores, sync, health, config ────────────────
      CREATE TABLE review_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,                  -- candidate | company | possible-duplicate
        subject_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );

      CREATE TABLE scoring_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        total_points INTEGER NOT NULL,
        components TEXT NOT NULL,                    -- JSON
        exceptions TEXT NOT NULL DEFAULT '[]',       -- JSON
        computed_at TEXT NOT NULL
      );
      CREATE INDEX idx_scoring_company ON scoring_results (company_id);

      CREATE TABLE hubspot_sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        action TEXT NOT NULL,                        -- created | updated | note
        hubspot_company_id TEXT,
        hubspot_deal_id TEXT,
        contact_count INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );

      CREATE TABLE integration_health (
        provider TEXT PRIMARY KEY,
        ok INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE TABLE sourcing_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,                         -- JSON
        updated_at TEXT NOT NULL
      );

      -- Operational state (tokens, drafts, outreach tracker, audit …)
      -- kept as JSON collections inside the SAME durable database.
      CREATE TABLE kv (
        collection TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'funding-fields-and-scoring-metadata',
    sql: `
      -- Recorded funding / validation facts (absent = unknown, never guessed).
      ALTER TABLE companies ADD COLUMN raising TEXT;
      ALTER TABLE companies ADD COLUMN accelerator TEXT;
      ALTER TABLE companies ADD COLUMN last_funding_date TEXT;

      -- Transparent scoring snapshots: version, confidence, explanation, evidence.
      ALTER TABLE scoring_results ADD COLUMN version TEXT NOT NULL DEFAULT 'v2 (pre-versioning)';
      ALTER TABLE scoring_results ADD COLUMN evidence_confidence REAL;
      ALTER TABLE scoring_results ADD COLUMN explanation TEXT NOT NULL DEFAULT '';
      ALTER TABLE scoring_results ADD COLUMN supporting_evidence TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 3,
    name: 'retryable-hubspot-sync-history',
    sql: `
      -- Full request payload so failed synchronizations can be retried.
      ALTER TABLE hubspot_sync_history ADD COLUMN payload TEXT;
    `,
  },
  {
    version: 4,
    name: 'scheduled-run-detail-and-simple-company-status',
    sql: `
      -- Explicit run end time + broader duplicate/policy-filter counts
      -- for scheduled-sourcing observability. started_at/completed_at
      -- are left NULL on rows that predate this migration; the read
      -- path (listRuns) derives them from the existing at/duration_ms.
      ALTER TABLE source_runs ADD COLUMN completed_at TEXT;
      ALTER TABLE source_runs ADD COLUMN duplicates_identified INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE source_runs ADD COLUMN filtered_by_policy INTEGER NOT NULL DEFAULT 0;

      -- Simple company-status lifecycle: New, Awaiting Review, Research
      -- Needed, Approved for HubSpot, Synced to HubSpot, Monitor, Passed.
      -- Backfill existing rows onto the new vocabulary; 'Stale' is never
      -- stored — it is computed from last_refreshed at read time.
      UPDATE companies SET review_status = 'Awaiting Review' WHERE review_status = 'Needs Review';
      UPDATE companies SET review_status = 'New' WHERE review_status IS NULL OR review_status = '';
    `,
  },
  {
    version: 5,
    name: 'per-source-run-timing',
    sql: `
      -- Per-source elapsed time so source-quality analytics (Settings)
      -- can report a real average response time instead of fabricating
      -- one — rows from before this migration have NULL (unknown, not
      -- zero) and are excluded from the average, not counted as instant.
      ALTER TABLE source_run_results ADD COLUMN duration_ms INTEGER;
    `,
  },
  {
    version: 6,
    name: 'ai-usage-ledger',
    sql: `
      -- Every model call gets one immutable row here, written whether
      -- the call succeeded or failed. This is the ONLY basis for spend
      -- reporting and budget enforcement — nothing is estimated after
      -- the fact and no figure in the UI is derived from anything else.
      --
      -- estimated_cost_usd is what our pricing table says the reported
      -- tokens are worth. actual_cost_usd stays NULL unless a provider
      -- reports a real billed amount (none currently do on the request
      -- path), so a NULL means "not reported", never "free".
      --
      -- month is stored denormalised as YYYY-MM so the monthly rollup
      -- is an index seek rather than a scan over a date function.
      CREATE TABLE ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        month TEXT NOT NULL,
        feature TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        company_id TEXT,
        run_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        web_searches INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        actual_cost_usd REAL,
        ok INTEGER NOT NULL DEFAULT 1,
        detail TEXT
      );
      CREATE INDEX idx_ai_usage_month ON ai_usage (month);
      CREATE INDEX idx_ai_usage_run ON ai_usage (run_id);
      CREATE INDEX idx_ai_usage_company ON ai_usage (company_id);
    `,
  },
  {
    version: 7,
    name: 'opportunity-classification',
    sql: `
      -- Separates "this company exists" from "this company is raising".
      -- The dashboard previously showed 35 Y Combinator directory
      -- entries as investment opportunities; a directory listing proves
      -- existence and accelerator participation, nothing about a raise.
      --
      -- One row per company. Absence of a row means the company has not
      -- been classified yet and must be treated as a lead, never as a
      -- deal — the read path defaults that way rather than assuming.
      CREATE TABLE company_opportunity (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        classification TEXT NOT NULL,
        primary_source_id TEXT NOT NULL,
        primary_tier INTEGER NOT NULL,
        opportunity_type TEXT NOT NULL,
        evidence_url TEXT NOT NULL,
        evidence_published_at TEXT,
        evidence_retrieved_at TEXT NOT NULL,
        evidence_summary TEXT NOT NULL,
        why_current TEXT NOT NULL,
        amount_usd REAL,
        amount_text TEXT,
        round_type TEXT,
        investors TEXT NOT NULL DEFAULT '[]',
        evidence_confidence REAL NOT NULL DEFAULT 0,
        conflicts TEXT NOT NULL DEFAULT '[]',
        missing_information TEXT NOT NULL DEFAULT '[]',
        classified_at TEXT NOT NULL
      );
      CREATE INDEX idx_company_opportunity_class ON company_opportunity (classification);
      CREATE INDEX idx_company_opportunity_source ON company_opportunity (primary_source_id);

      -- Every discrete piece of deal evidence, append-only, so a later
      -- reclassification can be re-derived and audited rather than
      -- trusted. Multiple rows per company are expected and desirable:
      -- diversity is measured from these.
      CREATE TABLE deal_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        opportunity_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        tier INTEGER NOT NULL,
        url TEXT NOT NULL,
        published_at TEXT,
        retrieved_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        why_current TEXT NOT NULL,
        amount_usd REAL,
        amount_text TEXT,
        round_type TEXT,
        investors TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        UNIQUE (company_id, url, opportunity_type)
      );
      CREATE INDEX idx_deal_evidence_company ON deal_evidence (company_id);
      CREATE INDEX idx_deal_evidence_source ON deal_evidence (source_id);
    `,
  },
  {
    version: 8,
    name: 'issuer-qualification-and-quarantine',
    sql: `
      -- A Form D filing proves an exempt offering was reported. It does
      -- NOT prove the filer is a venture-stage operating company. Real
      -- runs surfaced a publicly traded company (Adagio Medical, ticker
      -- ADGM), dialysis subsidiaries of a listed multinational, a PIMCO
      -- lending vehicle, a Roman-numeral solar project series, and $100M
      -- offerings from entities with no discoverable product.
      --
      -- One verdict row per company, rebuilt from evidence. Absence of a
      -- row means "not yet qualified", which the read path treats as NOT
      -- qualified — the cautious default.
      CREATE TABLE issuer_qualification (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        result TEXT NOT NULL,
        operating_confidence REAL NOT NULL DEFAULT 0,
        website_verified INTEGER NOT NULL DEFAULT 0,
        website_url TEXT,
        is_publicly_traded INTEGER NOT NULL DEFAULT 0,
        ticker TEXT,
        is_fund_or_spv INTEGER NOT NULL DEFAULT 0,
        parent_entity TEXT,
        corroborating_sources TEXT NOT NULL DEFAULT '[]',
        reason_codes TEXT NOT NULL DEFAULT '[]',
        fields_requiring_human_review TEXT NOT NULL DEFAULT '[]',
        qualified_at TEXT NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX idx_issuer_qualification_result ON issuer_qualification (result);

      -- Quarantine, so a questionable record can be taken out of the live
      -- shortlist WITHOUT destroying its evidence. Deleting would lose the
      -- audit trail and re-import the same entity on the next run.
      ALTER TABLE companies ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE companies ADD COLUMN quarantine_reason TEXT;
      ALTER TABLE companies ADD COLUMN quarantined_at TEXT;

      -- Classification history: every time a company's opportunity class
      -- changes, the previous verdict is kept with the reason. Lets us
      -- answer "why did this stop being a deal?" months later.
      CREATE TABLE classification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        previous_classification TEXT,
        new_classification TEXT NOT NULL,
        previous_qualification TEXT,
        new_qualification TEXT,
        reason TEXT NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX idx_classification_history_company ON classification_history (company_id);
    `,
  },
  {
    version: 9,
    name: 'operating-evidence-separate-from-identity',
    sql: `
      -- A company's own website was counted as independent corroboration,
      -- which let a Form D plus a domain that merely LOADS reach
      -- 'qualified-operating-company' — AEGIS FINTECH LTD., a $100M
      -- offering with no discoverable product, among them.
      --
      -- Three questions were being answered by one fact: did a financing
      -- event occur, does this website belong to this issuer, and does the
      -- issuer describe an actual business. The third was never asked.
      --
      -- corroborating_sources now holds independent FINANCING sources only
      -- (never the issuer itself); this column holds what the issuer's own
      -- site established, on its own scale. Existing rows get no value and
      -- are read back as 'not-checked' — honest, because at the time they
      -- were written the question was not being asked. Re-running
      -- qualification fills them in.
      ALTER TABLE issuer_qualification ADD COLUMN operating_evidence TEXT;
    `,
  },
  {
    version: 10,
    name: 'internal-company-review-notes',
    sql: `
      -- Free-text internal notes a reviewer writes about a company:
      -- investment-team opinion, not sourced evidence. Kept in its own
      -- table rather than a column on companies for three reasons —
      -- there are many notes per company, each carries its own
      -- authorship and lifecycle, and a note must never be able to
      -- ride along with the company row into a payload (or a CSV
      -- export) that was only meant to carry facts.
      --
      -- Notes are NEVER deleted. Archiving is a reversible state
      -- change, so a note that shaped a decision months ago can still
      -- be read back — a hard delete would silently rewrite the review
      -- history that justifies a pass or an investment.
      --
      -- body is PLAIN TEXT, stored exactly as normalized on the way in
      -- (see shared/notes.ts). It is never HTML and never Markdown:
      -- every reader treats it as untrusted text.
      CREATE TABLE company_notes (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        -- Reviewer identity, resolved from the authenticated session and
        -- never from the request body. Three columns because the single
        -- shared local administrator and a future Microsoft SSO user are
        -- not the same kind of identity, and a note written under one
        -- must stay distinguishable from a note written under the other:
        --   reviewer_id     stable subject — 'local-admin' today, an
        --                   Entra object id (oid) under SSO
        --   reviewer_label  what to show a human
        --   reviewer_source which provider established the identity
        -- See server/lib/reviewer.ts.
        reviewer_id TEXT NOT NULL,
        reviewer_label TEXT NOT NULL,
        reviewer_source TEXT NOT NULL
      );
      -- The read path is always "this company's notes, newest first",
      -- filtered by archived state.
      CREATE INDEX idx_company_notes_company ON company_notes (company_id, archived, created_at);
    `,
  },
  {
    version: 11,
    name: 'founder-stage-vertical-enrichment',
    sql: `
      -- ── Why these are TABLES and not columns on companies ────────
      --
      -- The dashboard was displaying "Unknown founder", "Unknown" stage,
      -- and a canned "Identity not on record — requires human
      -- verification, never inferred" for records that had never been
      -- researched at all. Those strings are true and useless: they read
      -- identically whether we searched nine source families and found
      -- nothing, or never looked.
      --
      -- Making them useful requires storing what was searched, when,
      -- what each source said, and how a person was tied to a company —
      -- none of which fits in a scalar column. Packing it into JSON on
      -- the companies row was rejected for the reason the opportunity and
      -- qualification tables already exist: evidence that cannot be
      -- queried cannot be audited, and a blob rewritten on every run
      -- destroys the history that makes a verdict checkable.
      --
      -- Nothing here fabricates a value. Every table below can represent
      -- "researched, genuinely not public" as a first-class row.

      -- One row per (company, person, source). Append-mostly: a second
      -- source naming the same person adds a row rather than replacing
      -- one, because two independent statements are the corroboration
      -- that separates a verified founder from a candidate.
      --
      -- A person is attached ONLY when match_signals clear the scoring
      -- threshold in shared/enrichment.ts. A shared name scores zero, so
      -- name agreement alone can never create a row here — attaching a
      -- stranger to a company would name a private individual wrongly,
      -- which is worse than an empty field, not better.
      CREATE TABLE founder_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        person_key TEXT NOT NULL,              -- folded name; see personKey()
        full_name TEXT NOT NULL,
        title TEXT,                            -- as STATED by the source; never inferred
        source_url TEXT NOT NULL,
        source_family TEXT NOT NULL,
        source_type TEXT NOT NULL,
        published_at TEXT,                     -- NULL = the source states no date
        retrieved_at TEXT NOT NULL,
        supporting_text TEXT NOT NULL,         -- verbatim, truncated, always untrusted plain text
        match_signals TEXT NOT NULL DEFAULT '[]',
        match_score REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        -- Reviewer decision. Deliberately columns on the SAME row rather
        -- than an overwrite: confirming a candidate must not erase the
        -- automated evidence that produced it, or the record of why the
        -- machine was wrong disappears along with the mistake.
        review_decision TEXT,                  -- confirmed | rejected | NULL
        reviewed_by TEXT,
        reviewed_at TEXT,
        review_reason TEXT,
        -- Re-running enrichment must not duplicate people. The same
        -- person from the same URL is one row, updated in place.
        UNIQUE (company_id, person_key, source_url)
      );
      CREATE INDEX idx_founder_candidates_company ON founder_candidates (company_id, status);
      CREATE INDEX idx_founder_candidates_person ON founder_candidates (person_key);

      -- Every attempt against every source family, whether or not it
      -- found anything. This table is what makes "research exhausted" a
      -- provable claim instead of a shrug: without it, "we looked
      -- everywhere" is an assertion with no evidence behind it, which is
      -- the same category of empty statement as the placeholder this
      -- work removes.
      --
      -- A timeout is recorded as an unreachable ATTEMPT, never as a
      -- finding. Dressing a network failure up as "no founder exists"
      -- would state something about a company that we did not learn.
      CREATE TABLE founder_research_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        run_id TEXT,
        source_family TEXT NOT NULL,
        url TEXT,
        attempted_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        candidates_found INTEGER NOT NULL DEFAULT 0,
        -- Idempotency: re-running updates the attempt for a family
        -- rather than growing an unbounded log of identical rows.
        UNIQUE (company_id, source_family)
      );
      CREATE INDEX idx_research_attempts_company ON founder_research_attempts (company_id);

      -- The per-company verdict, rebuilt from the two tables above.
      -- Absence of a row means "never researched", which the read path
      -- reports as exactly that rather than as an absence of founders.
      CREATE TABLE company_founder_resolution (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        resolved_person_key TEXT,
        resolved_name TEXT,
        resolved_title TEXT,
        summary TEXT NOT NULL,
        next_action TEXT NOT NULL,
        sources_attempted TEXT NOT NULL DEFAULT '[]',
        researched_at TEXT NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX idx_founder_resolution_status ON company_founder_resolution (status);

      -- Sector classification with its reasoning attached.
      --
      -- primary_sector holds either a Vamos sector id or the explicit
      -- non-sector status 'not-classifiable-company-identity-unresolved'.
      -- The literal string 'unknown' is never written here: a record we
      -- cannot classify is excluded from sector rankings and carries the
      -- specific evidence gap, rather than being parked in a grey bucket
      -- that ranks alongside real classifications.
      CREATE TABLE company_vertical_classification (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        primary_sector TEXT NOT NULL,
        secondary_sector TEXT,
        subvertical TEXT,
        reason TEXT NOT NULL,
        source_url TEXT,
        confidence REAL NOT NULL DEFAULT 0,
        basis TEXT NOT NULL,                   -- explicit | inferred
        evidence_gap TEXT,                     -- set only for the non-sector status
        classified_at TEXT NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX idx_vertical_classification_sector ON company_vertical_classification (primary_sector);

      -- Stage, with the distinction a Form D cannot make.
      --
      -- A Form D proves a securities offering was reported. It does not
      -- name a venture round, and the previous behaviour of leaving 200
      -- of 209 companies at 'Unknown' was at least honest about that.
      -- The answer is not to translate every filing into "Seed" — that
      -- invents a financing event no source states — but to record
      -- 'early-stage-round-not-disclosed' with the basis spelled out in
      -- the explanation column, and to reserve named stages for sources that
      -- actually name them.
      CREATE TABLE company_stage_resolution (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        basis TEXT NOT NULL,                   -- explicit | inferred
        confidence REAL NOT NULL DEFAULT 0,
        evidence_url TEXT,
        evidence_date TEXT,
        explanation TEXT NOT NULL,
        conflicts TEXT NOT NULL DEFAULT '[]',
        last_checked_at TEXT NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX idx_stage_resolution_stage ON company_stage_resolution (stage);

      -- Evidence-backed edges between companies, people, domains,
      -- filings, investors and accelerators. This is what turns Stealth
      -- Founder Radar from a static label into a graph a reviewer can
      -- interrogate: every edge names the source that justifies it, so
      -- "these two records are the same company" is a claim with a URL
      -- behind it rather than a heuristic nobody can check.
      CREATE TABLE entity_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_type TEXT NOT NULL,               -- company | person | domain | filing | investor | accelerator
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        source_family TEXT NOT NULL,
        evidence_url TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        -- Idempotent re-runs: the same edge from the same source is one
        -- row whose last_seen_at moves, not a new row every run.
        UNIQUE (from_type, from_id, to_type, to_id, relation, evidence_url)
      );
      CREATE INDEX idx_entity_rel_from ON entity_relationships (from_type, from_id);
      CREATE INDEX idx_entity_rel_to ON entity_relationships (to_type, to_id);

      -- One row per enrichment run, dry or applied, so a summary printed
      -- at a terminal months ago can still be checked against what was
      -- actually written.
      CREATE TABLE enrichment_runs (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        completed_at TEXT,
        mode TEXT NOT NULL,                    -- dry-run | apply
        scope TEXT NOT NULL,
        companies_attempted INTEGER NOT NULL DEFAULT 0,
        founders_verified INTEGER NOT NULL DEFAULT 0,
        founders_candidate INTEGER NOT NULL DEFAULT 0,
        founders_conflicting INTEGER NOT NULL DEFAULT 0,
        founders_exhausted INTEGER NOT NULL DEFAULT 0,
        founders_manual_review INTEGER NOT NULL DEFAULT 0,
        verticals_classified INTEGER NOT NULL DEFAULT 0,
        verticals_unclassifiable INTEGER NOT NULL DEFAULT 0,
        stages_named INTEGER NOT NULL DEFAULT 0,
        stages_bounded INTEGER NOT NULL DEFAULT 0,
        stages_conflicting INTEGER NOT NULL DEFAULT 0,
        source_errors TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        initiated_by TEXT NOT NULL
      );

      -- Reviewer corrections, layered ON TOP of the automated evidence
      -- rather than replacing it. Append-only: the previous value, the
      -- reason, the reviewer's identity and the source all stay, so a
      -- reader can see both what the research concluded and what a human
      -- decided, and can tell the two apart.
      --
      -- Reviewer identity comes from the authenticated session (see
      -- server/lib/reviewer.ts), never from a request body, for the same
      -- reason it does on notes: an attributed correction that the
      -- client could sign as anyone is decoration, not a fact.
      CREATE TABLE field_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        field TEXT NOT NULL,                   -- founder | vertical | stage
        previous_value TEXT,
        new_value TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_url TEXT,
        reviewer_id TEXT NOT NULL,
        reviewer_label TEXT NOT NULL,
        reviewer_source TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX idx_field_corrections_company ON field_corrections (company_id, field, at);
    `,
  },
  {
    version: 12,
    name: 'drop-per-source-deal-evidence-confidence',
    sql: `
      -- The per-source confidence on a deal-evidence row was assigned by
      -- each adapter from a small set of hardcoded constants — 0.5, 0.55,
      -- 0.6, 0.65, 0.7 — with no stated basis for any of them and no way
      -- to check whether one was right.
      --
      -- A number nobody can falsify is worse than no number. It reads as
      -- a measurement, it sorts and filters as a measurement, and it is a
      -- guess wearing a decimal point. Keeping it "just in case" would
      -- have meant every future reader assuming somebody had measured
      -- something.
      --
      -- What actually distinguishes these rows is already on them and IS
      -- checkable: tier (1 = filing or primary document, 2 = independent
      -- press or a participating investor, 3 = the company's own site),
      -- published_at, and whether other rows contradict it. Opportunity
      -- confidence is now derived from those — see
      -- deriveEvidenceConfidence() in shared/opportunity.ts.
      --
      -- company_opportunity.evidence_confidence is deliberately KEPT: it
      -- is still reported, it is simply computed from facts now instead
      -- of copied from an invented per-source figure.
      ALTER TABLE deal_evidence DROP COLUMN confidence;
    `,
  },
  {
    version: 13,
    name: 'run-attribution-and-score-completeness',
    sql: `
      -- "Last Run" executive KPIs (unique companies / founders pulled by
      -- the most recent completed run) need to attribute a record to the
      -- SPECIFIC run that surfaced it. Neither table had that before.
      --
      -- No REFERENCES clause, matching the existing convention on
      -- founder_research_attempts.run_id (plain TEXT) rather than
      -- companies' other FK columns — a sourcing run and an enrichment
      -- run are two different tables (source_runs / enrichment_runs)
      -- depending on which column this is, and neither is guaranteed
      -- populated (a company can arrive with no run at all, e.g. a CSV
      -- import or the standalone investor-news/funding-news CLI scripts,
      -- which write companies directly and predate any run concept).
      --
      -- Deliberately NOT backfilled here: a company's discovered_at is a
      -- date-only string set at IMPORT time (a separate, later human
      -- action from when the run itself executed), so there is no
      -- reliable timestamp-window to reconstruct old attributions from,
      -- and guessing would be exactly the kind of fabricated linkage this
      -- codebase's provenance rules exist to prevent. Existing rows stay
      -- NULL; every row created from here forward is attributed exactly,
      -- at the point of creation (server/db/repos/companies.ts saveCompany,
      -- server/db/repos/enrichment.ts upsertFounderCandidate).
      ALTER TABLE companies ADD COLUMN discovery_run_id TEXT;
      CREATE INDEX idx_companies_discovery_run ON companies (discovery_run_id);

      ALTER TABLE founder_candidates ADD COLUMN discovered_run_id TEXT;
      CREATE INDEX idx_founder_candidates_discovered_run ON founder_candidates (discovered_run_id);

      -- The Hot KPI must exclude provisional scores (a provisional score
      -- reflects only our own sourcing quality, not the company — see
      -- src/lib/scoring.ts), and completeness is the basis for the
      -- completeness indicator this pass adds. Neither survived past the
      -- in-memory FitScore object before now; scoring_results stored
      -- only the fields something already read.
      ALTER TABLE scoring_results ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scoring_results ADD COLUMN completeness REAL;
      ALTER TABLE scoring_results ADD COLUMN assessable_points REAL;
    `,
  },
  {
    version: 14,
    name: 'human-review-timestamp',
    sql: `
      -- last_refreshed conflates two different facts: an automated
      -- connector/stale-record refresh sweep (server/services/refresh.ts,
      -- bulk, unattended) and a human deliberately looking at ONE record
      -- again (POST /companies/:id/refresh "Mark reviewed"). Both wrote
      -- the same column, so an automated bulk sweep could make an
      -- ignored record silently look "reviewed". Confirmed on this very
      -- database before this migration: 35 companies shared the exact
      -- same last_refreshed date — one automated batch, not 35 people
      -- individually reviewing anything.
      --
      -- last_reviewed_at is the new, separate, human-only signal.
      -- review_decisions (subject_type = 'company') is already the
      -- authoritative log of every explicit human action taken against
      -- a specific company — status changes, "Mark reviewed", "Refresh
      -- live research", notes, and a founder-candidate confirm/reject
      -- recorded against its company. None of those are ever written by
      -- the automated discovery or enrichment pipelines (server/services/
      -- discovery.ts and enrichment.ts call recordReviewDecision only
      -- with subject_type = 'candidate', never 'company') — see
      -- server/db/repos/operations.ts recordReviewDecision, which now
      -- stamps this column going forward for every subject_type='company'
      -- event, so the backfill below and future behavior use the exact
      -- same definition of "reviewed".
      --
      -- Backfilled ONLY from real, already-recorded human actions — a
      -- company with no such history stays NULL (the application layer
      -- falls back to discovered_at/created_at for it), never defaulted
      -- to this migration's run time, which would fabricate a review
      -- that never happened.
      --
      -- 'phase11-refresh' is EXCLUDED by name: direct verification against
      -- this database found all 105 historical 'refresh-research' rows
      -- attributed to that single actor — one automated batch script from
      -- an earlier development phase, not 105 individual analysts each
      -- reviewing a company. Including it would repeat exactly the
      -- automated-action-mistaken-for-review bug this migration exists to
      -- fix, just moved into the backfill instead of into last_refreshed.
      -- The 2 real 'team'-attributed status-change rows are kept — a
      -- status change is a specific, deliberate per-company business
      -- decision, not a generic bulk sweep, and 'team' is this app's
      -- normal default actor for the single-shared-password auth model,
      -- not evidence of automation.
      ALTER TABLE companies ADD COLUMN last_reviewed_at TEXT;
      CREATE INDEX idx_companies_last_reviewed ON companies (last_reviewed_at);

      UPDATE companies
      SET last_reviewed_at = (
        SELECT MAX(at) FROM review_decisions
        WHERE subject_type = 'company' AND subject_id = companies.id AND actor != 'phase11-refresh'
      )
      WHERE EXISTS (
        SELECT 1 FROM review_decisions
        WHERE subject_type = 'company' AND subject_id = companies.id AND actor != 'phase11-refresh'
      );
    `,
  },
  {
    version: 15,
    name: 'five-approved-verticals',
    sql: `
      -- Consolidates the taxonomy from seven sectors (health, fintech,
      -- fow, sustainability, robotics, spacetech, ai) plus the legacy
      -- 'aoi' catch-all down to the five Marcos approved (health,
      -- fintech, fow, sustainability, frontier) — see
      -- src/data/taxonomy.ts's header comment for the full rationale.
      -- Every company and founder row is PRESERVED (this only rewrites
      -- the vertical/primary_sector/secondary_sector text columns);
      -- founder_candidates has no vertical column of its own (it
      -- inherits via company_id), so it needs no change here at all.
      --
      -- 'aoi' is deliberately left untouched by this migration: it was
      -- already the non-core catch-all, already excluded from every core
      -- breakdown, and already folds into "Unassigned" wherever
      -- CORE_VERTICAL_IDS-based code reads it (src/data/taxonomy.ts,
      -- server/services/executiveKpis.ts) — nothing behavioral changes
      -- for it, and rewriting it to some other value now would be a
      -- guess this migration has no evidence to support. No 'aoi' row
      -- exists in this database as of this migration (verified directly
      -- before writing it), so this is a dormant safety note, not a
      -- live case.
      --
      -- vertical_reclassification_log is the permanent, queryable audit
      -- trail this migration writes to BEFORE each UPDATE that changes a
      -- row — every company whose vertical actually changes gets one
      -- row here naming its previous value, its new value, and why.

      CREATE TABLE IF NOT EXISTS vertical_reclassification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        previous_vertical TEXT NOT NULL,
        new_vertical TEXT NOT NULL,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vertical_reclassification_company ON vertical_reclassification_log (company_id);

      -- ── Robotics + Space Tech → Frontier ─────────────────────────
      -- Mechanical: both were physical/hard-tech sectors reviewed the
      -- same way, so every row moves regardless of its specific text —
      -- no per-company judgment call is needed or made here. Aliases
      -- cover known historical spelling variants ('space-tech',
      -- 'space_tech', 'space tech') even though none are present in this
      -- database, so the migration stays correct if one ever is.
      INSERT INTO vertical_reclassification_log (company_id, company_name, previous_vertical, new_vertical, reason, at)
      SELECT id, name, vertical, 'frontier',
        'Robotics and Space Tech were combined into Frontier — a mechanical taxonomy consolidation (both are the same hard-tech sector), not a per-company evidence judgment.',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE vertical IN ('robotics', 'spacetech', 'space-tech', 'space_tech', 'space tech');

      UPDATE companies SET vertical = 'frontier'
      WHERE vertical IN ('robotics', 'spacetech', 'space-tech', 'space_tech', 'space tech');

      UPDATE company_vertical_classification SET primary_sector = 'frontier'
      WHERE primary_sector IN ('robotics', 'spacetech', 'space-tech', 'space_tech', 'space tech');

      UPDATE company_vertical_classification SET secondary_sector = 'frontier'
      WHERE secondary_sector IN ('robotics', 'spacetech', 'space-tech', 'space_tech', 'space tech');

      -- ── General AI retired → per-company reassignment ────────────
      -- AI is a technology attribute, not a market (src/data/taxonomy.ts),
      -- so each formerly-'ai' company is reassigned to the market it
      -- actually serves, based on a direct reading of its OWN recorded
      -- one-liner/evidence — never a blind alias. Two companies had a
      -- clear, specific domain; every other formerly-'ai' company is
      -- horizontal AI infrastructure/tooling with no market-specific
      -- product, which defaults to Future of Work exactly as the task
      -- specifies. Each exception is logged and applied BEFORE the final
      -- blanket statement, so the blanket only catches what is left.

      -- Greyparrot: "physical AI to recycling as packaging grows more
      -- complex" — a circular-economy/recycling business.
      INSERT INTO vertical_reclassification_log (company_id, company_name, previous_vertical, new_vertical, reason, at)
      SELECT id, name, vertical, 'sustainability',
        'Own description states "physical AI to recycling" — a circular-economy/recycling business, not a horizontal AI company.',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'news-greyparrot' AND vertical = 'ai';
      UPDATE companies SET vertical = 'sustainability' WHERE id = 'news-greyparrot' AND vertical = 'ai';
      UPDATE company_vertical_classification SET primary_sector = 'sustainability' WHERE company_id = 'news-greyparrot' AND primary_sector = 'ai';
      UPDATE company_vertical_classification SET secondary_sector = 'sustainability' WHERE company_id = 'news-greyparrot' AND secondary_sector = 'ai';

      -- Mireye: "index every inch of the earth" / geospatial data API for
      -- agents; YC categories include Geographic Information System,
      -- Location-based — matches Frontier's earth-observation/geospatial
      -- subvertical (the former Space Tech sector), not a horizontal AI
      -- company.
      INSERT INTO vertical_reclassification_log (company_id, company_name, previous_vertical, new_vertical, reason, at)
      SELECT id, name, vertical, 'frontier',
        'Own description is geospatial/earth-observation infrastructure ("index every inch of the earth"; YC categories include Geographic Information System) — matches Frontier''s earth-observation subvertical, not a horizontal AI company.',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'opp-mireye' AND vertical = 'ai';
      UPDATE companies SET vertical = 'frontier' WHERE id = 'opp-mireye' AND vertical = 'ai';
      UPDATE company_vertical_classification SET primary_sector = 'frontier' WHERE company_id = 'opp-mireye' AND primary_sector = 'ai';
      UPDATE company_vertical_classification SET secondary_sector = 'frontier' WHERE company_id = 'opp-mireye' AND secondary_sector = 'ai';

      -- Every remaining formerly-'ai' company: horizontal AI
      -- infrastructure/tooling (inference runtimes, voice/model APIs,
      -- agent frameworks, developer/devtools security, sales/ops/GTM
      -- automation, engineering-productivity copilots, GovTech permitting
      -- workflow automation) sold across industries with no single
      -- market of its own — defaults to Future of Work.
      INSERT INTO vertical_reclassification_log (company_id, company_name, previous_vertical, new_vertical, reason, at)
      SELECT id, name, vertical, 'fow',
        'Horizontal AI infrastructure/tooling with no market-specific product (inspected individually) — defaults to Future of Work per the retirement of General AI as a standalone vertical.',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE vertical = 'ai';
      UPDATE companies SET vertical = 'fow' WHERE vertical = 'ai';
      UPDATE company_vertical_classification SET primary_sector = 'fow' WHERE primary_sector = 'ai';
      UPDATE company_vertical_classification SET secondary_sector = 'fow' WHERE secondary_sector = 'ai';
    `,
  },
  {
    version: 16,
    name: 'per-company-ai-reclassification-audit',
    sql: `
      -- ── Why this migration exists ────────────────────────────────
      -- Migration 15 reassigned 18 formerly-'ai' companies. Two of them
      -- (Greyparrot → sustainability, Mireye → frontier) were logged with
      -- specific, per-company evidence. The other SIXTEEN all received
      -- one identical blanket sentence: "Horizontal AI infrastructure/
      -- tooling with no market-specific product (inspected individually)".
      --
      -- A re-audit of all 18 against their own stored evidence found the
      -- DESTINATIONS hold up — every one of the sixteen is defensible as
      -- Future of Work under the rule that horizontal enterprise/
      -- workforce/workflow/developer/general-AI-infrastructure companies
      -- default there. What does NOT hold up is the explanation: a single
      -- sentence repeated sixteen times is not a per-company judgment,
      -- and for at least one company (Agon, whose only recorded evidence
      -- names defence as its market) the words "no market-specific
      -- product" are simply false, even though 'fow' remains the
      -- best-supported of the five approved verticals for it.
      --
      -- This migration therefore corrects the AUDIT TRAIL rather than the
      -- data: no company's vertical changes, no earlier row is edited or
      -- deleted (migration 15's rows stay exactly as written, which is
      -- what "preserve the audit history" requires), and each of the
      -- sixteen gains one new row stating what ITS OWN recorded text says,
      -- which rule that triggers, how confident that is, and what remains
      -- ambiguous. If a later reviewer disagrees with one of these, the
      -- disagreement is now with a specific, quotable claim.
      --
      -- 'kind' distinguishes the two row types so neither is mistaken for
      -- the other: migration 15's rows moved data ('reclassification');
      -- these rows move nothing ('audit-correction', previous = new).

      ALTER TABLE vertical_reclassification_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'reclassification';
      ALTER TABLE vertical_reclassification_log ADD COLUMN confidence TEXT;
      ALTER TABLE vertical_reclassification_log ADD COLUMN ambiguity TEXT;
      CREATE INDEX IF NOT EXISTS idx_vertical_reclassification_kind ON vertical_reclassification_log (kind);

      -- Every statement below is INSERT...SELECT keyed on a specific id,
      -- so on a database that never held these companies (a fresh install,
      -- the E2E fixture DB, a test in-memory DB) each one inserts zero
      -- rows and the migration is a structural no-op. Nothing is created
      -- that the evidence does not already support.

      INSERT INTO vertical_reclassification_log (company_id, company_name, previous_vertical, new_vertical, reason, at, kind, confidence, ambiguity)
      SELECT c.id, c.name, c.vertical, c.vertical, r.reason, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'audit-correction', r.confidence, r.ambiguity
      FROM companies c
      JOIN (
        SELECT 'investor-ai fabrik' AS id,
          'Recorded evidence is an investor post titled "The Inference Era Is Here: Backing AI Fabrik From Inception" — inference serving, i.e. general AI infrastructure sold to whoever runs models. Rule applied: horizontal / general AI infrastructure defaults to Future of Work.' AS reason,
          'low' AS confidence,
          'The ONLY text on record is an investor announcement title. No product page, customer, or buyer has been captured, so the sector reading rests on the single word "inference". Re-check against the company''s own site before relying on this.' AS ambiguity
        UNION ALL SELECT 'disc-cand-969',
          'Own YC description: "Agent simulation and RL for researchers ... creating environments and datasets for RL", stating it powers "3 of the top 6 global AI labs and multiple Fortune 500 enterprises". The buyer is AI labs and enterprises, not any one end market — general AI infrastructure, so Future of Work.',
          'high',
          'The team describes itself as including roboticists and the product involves simulation, which could suggest Frontier. It does not: the customer is model developers, not a robotics market.'
        UNION ALL SELECT 'opp-agnost-ai',
          'Own YC description: "Product analytics for teams building conversational agents ... read production AI conversations ... open PRs against prompts, tools, and harnesses". A developer/product-analytics tool sold to software teams — horizontal developer tooling, so Future of Work.',
          'high',
          'None. The buyer (teams building agents) and the product (analytics + PRs) are both stated explicitly.'
        UNION ALL SELECT 'news-agon',
          'Own recorded evidence: "Ex-Anduril and Applied Intuition duo raise $30M for European defence AI infrastructure". The literal phrase on record is "AI infrastructure", which is why Future of Work is retained — but defence IS a specific market, so migration 15''s stated reason ("no market-specific product") was wrong for this company and is corrected here.',
          'low',
          'Genuinely unresolved, and the single weakest classification of the eighteen. Both founders come from autonomy companies (Anduril, Applied Intuition), which would point at Frontier under the autonomy rule; the only recorded text says "AI infrastructure", which points at Future of Work. One headline cannot settle it. Two further issues are flagged rather than acted on: the company is described as EUROPEAN (outside the US geography thesis) and defence is not itself one of the five approved verticals. Route to partner review.'
        UNION ALL SELECT 'investor-bespoke',
          'Recorded evidence is an investor post titled "Backing Bespoke Labs: Building the Infrastructure for AI Agents" — agent infrastructure, i.e. general AI infrastructure, so Future of Work.',
          'low',
          'The record CONTRADICTS ITSELF: the stored website is bespoke.health (a health domain) while the only description on record is agent infrastructure. Health & Wellness is NOT applied here, because a domain name is not a product description and inferring a market from a TLD is exactly the kind of guess this codebase forbids. The conflict is a data-quality defect in the record itself and needs a human to resolve which website actually belongs to this company.'
        UNION ALL SELECT 'investor-fireworks',
          'Recorded evidence: "Menlo''s Investment in Fireworks: The Runtime for Specialized Intelligence". A model-serving runtime is infrastructure sold across industries — general AI infrastructure, so Future of Work.',
          'high',
          'Vertical is clear. Separately flagged on STAGE, not sector: this record is stored as Series B+, past the stage the firm leads.'
        UNION ALL SELECT 'news-fish audio',
          'Recorded evidence: "Fish Audio raises $52M seed to build AI voice models for creators and enterprises". A voice-model API serving both creators and enterprises is horizontal tooling with no single market — Future of Work.',
          'medium',
          'The buyer is stated as two different segments at once ("creators and enterprises"), which is consistent with horizontal, but no named customer is on record to confirm either.'
        UNION ALL SELECT 'news-general intuition',
          'Recorded evidence: "General Intuition''s $2.3B bet that video games can train AI agents for the real world" — a foundation-model/training-data company whose output is a general capability, so Future of Work.',
          'medium',
          'Real ambiguity: "agents for the real world" is embodied/spatial reasoning, and if the buyer turns out to be robotics or autonomy companies this belongs in Frontier. The recorded text does not name a buyer, so the horizontal reading is the only one the evidence supports today.'
        UNION ALL SELECT 'news-infinity',
          'Recorded evidence: "Inference startup Infinity raises $15M from Touring Capital, OpenAI and Anthropic researchers". Inference serving is general AI infrastructure — Future of Work.',
          'medium',
          'Evidence is a single funding headline; the investors are named but the product beyond "inference" is not.'
        UNION ALL SELECT 'news-multiverse',
          'Recorded evidence: "AI model compression startup Multiverse raises $570M at $1.7B valuation". Model compression is a technique applied to any model in any industry — general AI infrastructure, so Future of Work.',
          'high',
          'Vertical is clear. Flagged on STAGE, not sector: a $570M raise at a $1.7B valuation is far past pre-seed/seed and should not be competing for early-stage attention.'
        UNION ALL SELECT 'opp-onecli',
          'Own YC description: "a credential isolation gateway for AI agents ... per-agent access control, full audit logs ... open source (2.5K+ GitHub stars, 300K+ downloads)". Developer security infrastructure sold to any team running agents — Future of Work.',
          'high',
          'None for the vertical. Worth noting the usage evidence (stars, downloads) is real and specific, which is unusual in this cohort.'
        UNION ALL SELECT 'disc-cand-972',
          'Own YC description: "AI agents to build B2B datasets ... helps GTM teams automate account research and data enrichment". A sales/go-to-market workflow tool — Future of Work.',
          'high',
          'None for the vertical. The stored SUBCATEGORY ("warehouse and logistics robotics") is unrelated to the description and is a separate data-quality defect.'
        UNION ALL SELECT 'disc-cand-1144',
          'Own YC description: "AI for AI Infrastructure — We deploy fleets of AI Infrastructure Engineers ... to optimize your training/inference infrastructure". Infrastructure tooling for teams running models — Future of Work.',
          'high',
          'None. The company describes itself as AI infrastructure in its own first four words.'
        UNION ALL SELECT 'opp-tara-ai',
          'Own YC description: "engineering efficiency co-pilot ... helps engineering leaders measure and improve engineering efficiency", naming MongoDB, Clearbit and Prometric as customers. Engineering-productivity software — Future of Work.',
          'high',
          'None for the vertical. Flagged on STAGE: this is a YC W15 company with named enterprise customers, stored as "Early-stage — round not publicly disclosed", which is very unlikely to be accurate a decade on.'
        UNION ALL SELECT 'disc-cand-1150',
          'Own YC description: "the AI software suite for underserved industries, starting with Automotive ... AI receptionist and customer support platform". Customer-operations workflow automation — Future of Work is the closest of the five approved verticals.',
          'medium',
          'This is vertical SaaS for automotive retail, not horizontal software, and automotive is not one of the five approved verticals. Future of Work is applied as the nearest fit on the WORKFLOW-AUTOMATION character of the product, not because the company is horizontal. Whether it is in thesis at all is a partner question.'
        UNION ALL SELECT 'disc-cand-1146',
          'Own YC description: "AI-native land-use permit management for local gov ... our AI reads documents, plans, and diagrams, then flags issues and drafts the final report. Staff just sign off." Document-review workflow automation with local-government staff as the buyer — Future of Work.',
          'medium',
          'Land-use permitting touches housing and energy siting, which could suggest Sustainability. It does not follow: the product is permit-review workflow software, and the environmental subject matter of the permits is not the company''s market.'
      ) r ON r.id = c.id;
    `,
  },
  {
    version: 17,
    name: 'verified-record-corrections',
    sql: `
      -- ── Verified stored-data corrections ─────────────────────────
      -- Four defects found during the per-company AI re-audit, each
      -- corrected here ONLY because a primary source was fetched and
      -- read directly on 2026-08-05. Migrations 15 and 16 are already
      -- applied and are not touched; every change below is a new write
      -- with its own row in field_corrections naming the previous
      -- value, the new value, the evidence, and the source URL.
      --
      -- Each statement is keyed on a specific company id AND on the
      -- exact wrong value it is replacing, so it is a no-op on any
      -- database that does not hold that defect (a fresh install, the
      -- E2E fixture DB, an in-memory test DB) and cannot overwrite a
      -- value some later human already fixed by hand.

      -- 1. Bespoke Labs: the record carried the wrong company's website.
      --    Verified: https://bespoke.health serves a page titled
      --    "Home - Bespoke Heath" — a different, unrelated healthcare
      --    business. The company the investor post actually describes
      --    ("Building the Infrastructure for AI Agents") is at
      --    https://www.bespokelabs.ai, whose page title reads "Bespoke
      --    Labs: Ship Reliable AI Agents with SOTA Data Curation".
      --    This also RESOLVES the conflict migration 16 flagged: the
      --    Future of Work classification was right, and the health
      --    domain was simply the wrong URL — which is exactly why the
      --    audit refused to infer a vertical from a TLD.
      INSERT INTO field_corrections (company_id, field, previous_value, new_value, reason, source_url, reviewer_id, reviewer_label, reviewer_source, at)
      SELECT 'investor-bespoke', 'website', website, 'https://www.bespokelabs.ai',
        'Stored website belonged to a different company. https://bespoke.health serves "Home - Bespoke Heath", an unrelated healthcare site; https://www.bespokelabs.ai serves "Bespoke Labs: Ship Reliable AI Agents with SOTA Data Curation", matching the recorded description "Building the Infrastructure for AI Agents". Both pages fetched and read directly. Resolves the website/product conflict recorded in migration 16.',
        'https://www.bespokelabs.ai', 'migration-17', 'Verified record correction', 'primary-source fetch',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'investor-bespoke' AND website = 'https://bespoke.health';

      UPDATE companies SET website = 'https://www.bespokelabs.ai', domain = 'bespokelabs.ai', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'investor-bespoke' AND website = 'https://bespoke.health';

      -- 2. Greyparrot: same defect, and a more obvious one.
      --    Verified: https://greyparrot.com is a hobbyist blog titled
      --    "Discover the Vibrant World of Grey Parrots" — about the
      --    birds. The company is at https://greyparrot.ai, titled
      --    "Unlock the power of AI waste analytics | Greyparrot waste
      --    intelligence", which independently confirms migration 15's
      --    reassignment of this company to Sustainability.
      INSERT INTO field_corrections (company_id, field, previous_value, new_value, reason, source_url, reviewer_id, reviewer_label, reviewer_source, at)
      SELECT 'news-greyparrot', 'website', website, 'https://greyparrot.ai',
        'Stored website was not the company. https://greyparrot.com is a hobbyist blog titled "Discover the Vibrant World of Grey Parrots"; https://greyparrot.ai is "Unlock the power of AI waste analytics | Greyparrot waste intelligence". Both fetched and read directly.',
        'https://greyparrot.ai', 'migration-17', 'Verified record correction', 'primary-source fetch',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'news-greyparrot' AND website = 'https://greyparrot.com';

      UPDATE companies SET website = 'https://greyparrot.ai', domain = 'greyparrot.ai', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'news-greyparrot' AND website = 'https://greyparrot.com';

      -- 3. Greyparrot subcategory: "financial crime and compliance" is
      --    unrelated to a waste-analytics company and was almost
      --    certainly mis-joined during an earlier sector pass.
      --
      --    Deliberately NOT forced onto a taxonomy row: none of
      --    Sustainability's subcategories covers recycling or the
      --    circular economy (they are all energy-side). A truthful
      --    descriptive value is better than a wrong exact match, and
      --    scoring already handles this case explicitly — thesisFit
      --    scores a known sector with a more-specific subvertical at
      --    16/20 rather than treating it as unclassified.
      INSERT INTO field_corrections (company_id, field, previous_value, new_value, reason, source_url, reviewer_id, reviewer_label, reviewer_source, at)
      SELECT 'news-greyparrot', 'subcategory', subcategory, 'Circular economy & waste intelligence',
        'Recorded subcategory "financial crime and compliance" is unrelated to this company. greyparrot.ai describes AI waste analytics for the recycling industry. No Sustainability taxonomy subcategory covers recycling, so a truthful descriptive value is stored rather than a wrong exact match.',
        'https://greyparrot.ai', 'migration-17', 'Verified record correction', 'primary-source fetch',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'news-greyparrot' AND subcategory = 'financial crime and compliance';

      UPDATE companies SET subcategory = 'Circular economy & waste intelligence', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'news-greyparrot' AND subcategory = 'financial crime and compliance';

      -- 4. PromptLoop subcategory: "warehouse and logistics robotics"
      --    for a sales-research tool. Verified: promptloop.com is
      --    titled "PromptLoop | AI-Powered GTM Data & Automated B2B
      --    Research Solutions" and states "AI Research to find company
      --    datasets for Sales and Marketing". This maps onto an EXACT
      --    Future of Work taxonomy row.
      INSERT INTO field_corrections (company_id, field, previous_value, new_value, reason, source_url, reviewer_id, reviewer_label, reviewer_source, at)
      SELECT 'disc-cand-972', 'subcategory', subcategory, 'Workflow & collaboration tools',
        'Recorded subcategory "warehouse and logistics robotics" is unrelated. promptloop.com is titled "AI-Powered GTM Data & Automated B2B Research Solutions" and describes research automation for sales and marketing teams — an exact match for the Future of Work taxonomy row "Workflow & collaboration tools". Page fetched and read directly.',
        'https://www.promptloop.com/', 'migration-17', 'Verified record correction', 'primary-source fetch',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'disc-cand-972' AND subcategory = 'warehouse and logistics robotics';

      UPDATE companies SET subcategory = 'Workflow & collaboration tools', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'disc-cand-972' AND subcategory = 'warehouse and logistics robotics';

      -- 5. Agon: route out of the NORMAL review queue via the existing
      --    exception mechanism.
      --
      --    Its own recorded evidence reads "Ex-Anduril and Applied
      --    Intuition duo raise $30M for European defence AI
      --    infrastructure". Two facts follow from that sentence and
      --    neither is an inference: the company is European, which is
      --    outside the firm's US geography requirement, and defence is
      --    not one of the five approved verticals.
      --
      --    The 'outside-thesis' FLAG is the right instrument and the
      --    only one used here. Per src/lib/scoring.ts it surfaces as a
      --    partner-review exception, never auto-rejects and never zeroes
      --    a score, and CompanyTable renders any company carrying an
      --    exception as "Partner review" instead of routing it through
      --    ordinary triage. The vertical is deliberately left as
      --    migration 16 recorded it — still pending partner review, as
      --    that audit said.
      --
      --    The subcategory ("learning and development") is left alone:
      --    it is also wrong, but no primary source was successfully
      --    fetched for this company, and correcting a field on a guess
      --    is the thing this whole pass exists to stop.
      INSERT INTO field_corrections (company_id, field, previous_value, new_value, reason, source_url, reviewer_id, reviewer_label, reviewer_source, at)
      SELECT 'news-agon', 'flags', flags, '["outside-thesis"]',
        'Own recorded evidence states "European defence AI infrastructure". European is outside the US geography requirement and defence is not one of the five approved verticals, so this record must not enter the normal review queue without an explicit exception. Flagged for partner review rather than rejected; vertical left pending partner review per migration 16.',
        'https://resiliencemedia.co/agon-emerges-from-stealth-with-30m-to-build-ai-training-models-for-defence/',
        'migration-17', 'Verified record correction', 'recorded evidence text',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM companies WHERE id = 'news-agon' AND flags = '[]';

      UPDATE companies SET flags = '["outside-thesis"]', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 'news-agon' AND flags = '[]';
    `,
  },
  {
    version: 18,
    name: 'analyst-traction-reviews',
    sql: `
      -- ── Analyst traction review ──────────────────────────────────
      -- Traction is worth 10 of the model's 100 points and is one of the
      -- five components the v4.1 provisional policy requires, yet it was
      -- unassessable for all 209 companies: every single one carried the
      -- literal string "Unknown — not yet researched". The pipeline could
      -- surface a claim from a web page but had nowhere for a person to
      -- record a judgement about whether a pilot was real — so no company
      -- could ever become fully assessed, however good it was.
      --
      -- This table is that missing step. It is APPEND-ONLY and parallel
      -- to scoring_results by design: companies.traction_level and
      -- traction_note hold the CURRENT value (that is what the scorer
      -- reads, unchanged), and every review that ever produced one is
      -- kept here with the value it replaced. Nothing is ever updated or
      -- deleted, so a reviewer can always see how a rating was reached
      -- and what it used to be.
      --
      -- actor is a free-text string, matching this build's
      -- single-shared-password auth model. It is NOT a verified identity
      -- and nothing in the app may present it as one.
      --
      -- Purely additive: no existing table or column is altered, so an
      -- upgrade cannot disturb any company, founder, evidence, review or
      -- scoring row.
      CREATE TABLE IF NOT EXISTS traction_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        -- One of shared/traction.ts TRACTION_STATES.
        state TEXT NOT NULL,
        -- The state this review replaced. NULL on the first review.
        previous_state TEXT,
        -- The 0-10 rating written onto companies.traction_level. Zero for
        -- the two non-scoring states, which keep the component
        -- unassessable rather than scoring it zero.
        level INTEGER NOT NULL,
        evidence_type TEXT NOT NULL,
        customer_name TEXT,
        -- company-claimed | independently-confirmed | analyst-assessment.
        -- Kept separate from the state so an analyst's judgement is never
        -- displayed as a published fact.
        verification TEXT NOT NULL,
        -- Verbatim figure, only ever stored alongside a source_url.
        metric_value TEXT,
        source_url TEXT,
        analyst_note TEXT,
        evidence_date TEXT,
        confidence TEXT NOT NULL,
        missing_diligence TEXT,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traction_reviews_company ON traction_reviews (company_id, at);

      -- Separate from last_reviewed_at (migration 14), which records ANY
      -- human action on a company. This one records specifically that a
      -- person assessed traction, so "never had a traction review" stays
      -- distinguishable from "reviewed once, long ago". NULL means it has
      -- never happened — never defaulted to this migration's run time,
      -- which would fabricate a review nobody performed.
      ALTER TABLE companies ADD COLUMN traction_reviewed_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_companies_traction_reviewed ON companies (traction_reviewed_at);
    `,
  },
  {
    version: 19,
    name: 'pending-evidence-for-analyst-review',
    sql: `
      -- ── Pending evidence awaiting an analyst decision ────────────
      -- Extraction can now read a public accelerator profile properly
      -- (server/enrichment/ycProfile.ts), which surfaces two kinds of
      -- claim that must NOT flow straight into a score:
      --
      --   traction  "20 departments across 16 hospitals" — real, cited,
      --             and written by the company about itself. It is a
      --             lead for diligence, not a verified fact.
      --   stage     a current YC batch. The rubric HAS a matching bucket
      --             ("Early-stage — round not publicly disclosed"), but
      --             auto-applying it is exactly what put Brex and Deel in
      --             the pipeline as early-stage companies. It needs a
      --             person to confirm.
      --
      -- So both land here as PENDING, with the quote and the URL, and a
      -- person accepts, edits or rejects. Nothing in this table affects
      -- any score while it is pending — the score changes only when an
      -- accepted row is written through the normal traction-review or
      -- field-update path, which already audits itself.
      --
      -- Append-only in the same sense as traction_reviews: a decision
      -- updates status/decided_* on the row it applies to and never
      -- deletes it, so a rejected claim stays visible and nobody
      -- re-researches it.
      CREATE TABLE IF NOT EXISTS pending_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        -- traction | stage
        kind TEXT NOT NULL,
        -- The verbatim sentence the source printed. Never a paraphrase.
        quote TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_family TEXT NOT NULL,
        -- Which part of the page it came from. A founder biography
        -- almost always describes a PRIOR company, so a claim from there
        -- is founder-market-fit evidence and must never be presented as
        -- this company's traction.
        section TEXT NOT NULL,
        about_this_company INTEGER NOT NULL,
        -- company-claimed | independently-confirmed. Anything an
        -- accelerator hosts on the company's behalf is company-claimed.
        provenance TEXT NOT NULL,
        -- What the extractor thinks this implies, for the analyst to
        -- accept or overrule. Never applied automatically.
        suggested_state TEXT,
        suggestion_basis TEXT,
        published_at TEXT,
        accessed_at TEXT NOT NULL,
        -- pending | accepted | rejected | edited
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at TEXT,
        decision_note TEXT,
        at TEXT NOT NULL,
        UNIQUE (company_id, kind, quote)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_evidence_company ON pending_evidence (company_id, kind, status);
    `,
  },
  {
    version: 20,
    name: 'pending-evidence-analyst-edit',
    sql: `
      -- ── The analyst's edited excerpt ─────────────────────────────
      -- The review workflow is specified as accept / EDIT BEFORE
      -- ACCEPTING / reject, and the middle one had nowhere to go: the UI
      -- posted status = 'edited' and discarded whatever the analyst
      -- changed, so the control promised an edit it could not perform.
      --
      -- Stored in a NEW column rather than by overwriting \`quote\`.
      -- \`quote\` is the verbatim sentence the source published, and the
      -- reviewer requirement is to be able to see the ORIGINAL claim
      -- alongside the decision. Overwriting it would destroy the only
      -- record of what the page actually said, which is the one thing a
      -- second reviewer needs to check the first reviewer's judgement.
      --
      -- Nullable: almost every row is accepted or rejected as published.
      ALTER TABLE pending_evidence ADD COLUMN edited_quote TEXT;
    `,
  },
  {
    version: 21,
    name: 'hubspot-deal-id',
    sql: `
      -- Sync used to POST a brand-new HubSpot deal on every call, with no
      -- record of which deal belonged to which company — so a resync (a
      -- retry, or a later stage change) always created a duplicate deal
      -- instead of updating the one already in HubSpot. This column is
      -- the same idempotency link hubspot_company_id already provides,
      -- just for the deal object.
      ALTER TABLE companies ADD COLUMN hubspot_deal_id TEXT;
    `,
  },
];

/** The highest migration version this build of the app knows about — used by /health/ready. */
export function latestMigrationVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
}
