/**
 * Form D primary-document parsing.
 *
 * EDGAR full-text search returns only a company name, a CIK, and a
 * filing date. The financing facts that make a filing worth surfacing —
 * how much was offered, how much actually sold, when the first sale
 * happened, who the officers are — live in the filing's
 * `primary_doc.xml`. This module parses that document.
 *
 * Kept as pure functions over an XML string so the parsing can be
 * tested against real captured filings without any network access.
 */

export interface FormDRelatedPerson {
  name: string;
  relationship: string;
}

export interface FormDFiling {
  entityName: string | null;
  industryGroupType: string | null;
  /** Total offering size as filed, in USD. */
  totalOfferingAmountUsd: number | null;
  /** How much has actually been sold — the number that matters. */
  totalAmountSoldUsd: number | null;
  totalRemainingUsd: number | null;
  dateOfFirstSale: string | null;
  /** True when the issuer states the first sale has not yet occurred. */
  firstSaleYetToOccur: boolean;
  city: string | null;
  stateOrCountry: string | null;
  relatedPersons: FormDRelatedPerson[];
  isPooledInvestmentFund: boolean;
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  const inner = m[1].trim();
  // Several Form D fields wrap their content in <value>…</value>.
  const v = inner.match(/<value>([\s\S]*?)<\/value>/i);
  return (v ? v[1] : inner).trim() || null;
}

function allTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi'))]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

function money(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The SEC's OWN classification of the issuer. When an issuer selects
 * "Pooled Investment Fund" as its industry group, it is telling the
 * regulator it is a fund — far stronger evidence than guessing from the
 * entity's name, and it catches funds whose names look operational.
 */
const POOLED_FUND_GROUPS = [
  'pooled investment fund',
  'hedge fund',
  'private equity fund',
  'venture capital fund',
  'other investment fund',
];

export function parseFormD(xml: string): FormDFiling {
  const industryGroupType = tag(xml, 'industryGroupType');
  const firstSaleYetToOccur = /<yetToOccur>\s*true\s*<\/yetToOccur>/i.test(xml);

  const first = allTags(xml, 'firstName');
  const last = allTags(xml, 'lastName');
  const rel = allTags(xml, 'relationship');
  const relatedPersons: FormDRelatedPerson[] = first.map((f, i) => ({
    name: [f, last[i]].filter(Boolean).join(' ').trim(),
    relationship: rel[i] ?? 'Unknown',
  })).filter((p) => p.name.length > 1);

  return {
    entityName: tag(xml, 'entityName'),
    industryGroupType,
    totalOfferingAmountUsd: money(tag(xml, 'totalOfferingAmount')),
    totalAmountSoldUsd: money(tag(xml, 'totalAmountSold')),
    totalRemainingUsd: money(tag(xml, 'totalRemaining')),
    dateOfFirstSale: tag(xml, 'dateOfFirstSale'),
    firstSaleYetToOccur,
    city: tag(xml, 'city'),
    stateOrCountry: tag(xml, 'stateOrCountry'),
    relatedPersons: dedupePersons(relatedPersons),
    isPooledInvestmentFund: industryGroupType !== null
      && POOLED_FUND_GROUPS.some((g) => industryGroupType.toLowerCase().includes(g)),
  };
}

function dedupePersons(people: FormDRelatedPerson[]): FormDRelatedPerson[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    const k = p.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Name-based fund detection, used ALONGSIDE the issuer's own
 * industry-group answer rather than instead of it.
 *
 * The important non-rule: a legal suffix on its own means nothing. Real
 * operating startups are routinely "…, Inc." or "…, LLC" — AMP Robotics
 * Corp is an operating company. Only fund-shaped naming is rejected.
 */
const FUND_NAME_PATTERNS: { pattern: RegExp; kind: string }[] = [
  { pattern: /\bfund\s+(?:[IVXL]+|\d+)\b/i, kind: 'numbered fund' },
  { pattern: /\b(?:venture|growth|credit|opportunit(?:y|ies)|income|equity|capital)\s+fund\b/i, kind: 'investment fund' },
  { pattern: /\bfund\s*,?\s*(?:L\.?P\.?|LLC|Ltd)\b/i, kind: 'fund vehicle' },
  { pattern: /\ba\s+series\s+of\b/i, kind: 'series vehicle' },
  { pattern: /\b(?:SICAV|RAIF|SCSp|SPV)\b/i, kind: 'offshore/structured vehicle' },
  { pattern: /\b(?:feeder|master)\s+fund\b/i, kind: 'feeder/master fund' },
  { pattern: /\bco-?invest(?:ment)?\b/i, kind: 'co-investment vehicle' },
  // Separator-agnostic: real filings use a comma ("Acme, L.P."), a dash
  // ("Unique Investments & Fintech - Limited Partnership"), or nothing
  // at all. LLC/Inc are deliberately NOT here — plenty of real operating
  // startups are LLCs; almost none are LPs.
  { pattern: /[\s,–—-]+(?:L\.?P\.?|Limited\s+Partnership)\s*$/i, kind: 'limited partnership' },
  { pattern: /\b(?:partners|holdings)\s+(?:[IVXL]+|\d+)\b/i, kind: 'numbered partnership' },
  { pattern: /\breal\s+estate\s+(?:fund|trust|partners)\b/i, kind: 'real-estate vehicle' },
];

export interface OperatingCompanyVerdict {
  isOperatingCompany: boolean;
  reason: string;
}

/**
 * Decide whether a Form D issuer is an operating company worth
 * surfacing as a deal. Two independent signals; either can reject.
 */
export function isOperatingIssuer(name: string, filing?: Pick<FormDFiling, 'isPooledInvestmentFund' | 'industryGroupType'>): OperatingCompanyVerdict {
  const n = (name ?? '').trim();
  if (n.length === 0) return { isOperatingCompany: false, reason: 'No issuer name on the filing.' };

  // The issuer's own answer to the SEC beats any guess we could make.
  if (filing?.isPooledInvestmentFund) {
    return {
      isOperatingCompany: false,
      reason: `Issuer selected "${filing.industryGroupType}" as its industry group — it is a pooled investment vehicle, not an operating company.`,
    };
  }
  for (const { pattern, kind } of FUND_NAME_PATTERNS) {
    const m = n.match(pattern);
    if (m) {
      return { isOperatingCompany: false, reason: `Entity name indicates a ${kind} ("${m[0].trim()}").` };
    }
  }
  return { isOperatingCompany: true, reason: 'No fund indicators in the entity name or the filed industry group.' };
}

/** `0001699390-26-000002` + CIK → the canonical human-openable filing index page. */
export function filingIndexUrl(cik: string | null, adsh: string | undefined): string | null {
  if (!cik || !adsh) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${adsh}-index.htm`;
}

/** The machine-readable primary document for a filing. */
export function primaryDocUrl(cik: string | null, adsh: string | undefined): string | null {
  if (!cik || !adsh) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/primary_doc.xml`;
}
