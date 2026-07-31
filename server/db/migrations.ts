import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned, forward-only migrations. Each entry runs once per
 * database inside a transaction and is recorded in `migrations`.
 */

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
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
