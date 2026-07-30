import { getDb } from '../db/client';
import { QUALIFICATION_VERSION, type QualificationResult } from '../../shared/qualification';

/**
 * Persist a qualification verdict for a company, for tests whose subject
 * is something OTHER than qualification.
 *
 * This helper exists because `reclassifyCompany` treats a MISSING verdict
 * as "not qualified" — an unchecked record is surfaced for review, never
 * counted as a live deal. That is the correct production rule, but it
 * means any test that wants to observe a live-deal classification has to
 * state that the issuer passed qualification, exactly as real data does.
 *
 * Before that rule existed the gate was skipped entirely when no verdict
 * was on file, so these tests passed while asserting something production
 * would never do. Making the fixture explicit is the point: a test that
 * needs a live deal now has to say why the company is allowed to be one.
 */
export function markQualifiedForTests(
  companyId: string,
  result: QualificationResult = 'qualified-operating-company',
  opts: { independentSources?: number; websiteUrl?: string | null } = {},
): void {
  const sources = Array.from({ length: opts.independentSources ?? 2 }, (_, i) => ({
    sourceId: `test-source-${i + 1}`,
    family: `test-family-${i + 1}`,
    url: `https://example.test/${companyId}/${i + 1}`,
    publishedAt: null,
  }));

  getDb().prepare(`
    INSERT INTO issuer_qualification (
      company_id, result, operating_confidence, website_verified, website_url,
      is_publicly_traded, ticker, is_fund_or_spv, parent_entity,
      corroborating_sources, reason_codes, fields_requiring_human_review,
      qualified_at, version
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, 0, NULL, ?, '[]', '[]', ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET
      result = excluded.result,
      corroborating_sources = excluded.corroborating_sources,
      website_verified = excluded.website_verified,
      website_url = excluded.website_url
  `).run(
    companyId,
    result,
    result === 'qualified-operating-company' ? 1 : 0.4,
    opts.websiteUrl === null ? 0 : 1,
    opts.websiteUrl ?? `https://example.test/${companyId}`,
    JSON.stringify(sources),
    new Date().toISOString(),
    QUALIFICATION_VERSION,
  );
}
