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
