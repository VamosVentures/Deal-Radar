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

  // PROJECT-FINANCE SPVs. Found by a real run: a "solar" search returned
  // "Scenic Hill Solar LI, LLC" and "Scenic Hill Solar L, LLC" — numbers
  // 51 and 50 in a Roman-numeral series of single-project entities. They
  // file real Form Ds with real amounts and the SEC's own industry group
  // says "Other Energy", not a fund, so neither the industry check nor
  // the fund-name patterns above catch them. They are not startups; they
  // are one-asset financing vehicles, and a sector shortlist full of them
  // is worse than an empty one.
  //
  // The signal is a Roman numeral or a bare number sitting immediately
  // before the legal suffix. Requires at least two characters or a comma
  // so a genuine single-letter initial ("Company X Inc") is not caught.
  { pattern: /\b(?:[IVXLCDM]{2,7}|\d{1,3})\s*,\s*(?:LLC|L\.?L\.?C\.?|Inc\.?|LP|L\.?P\.?)\s*$/i, kind: 'numbered project vehicle' },
  // The negative lookahead matters: "LLC" is itself made of Roman-numeral
  // letters (L, L, C), so without it "Moda Solar LLC" matched as
  // "Solar" + numeral "LLC" and a plausible operating company was
  // rejected. Legal suffixes are explicitly not numerals.
  { pattern: /\b(?:project|holdco|propco|opco|solar|wind|storage)\s+(?!LLC\b|LP\b|LC\b|INC\b)(?:[IVXLCDM]{1,7}|\d{1,3})\b\s*,?\s*(?:LLC|Inc\.?|LP)?\s*$/i, kind: 'single-project vehicle' },

  // ASSET-MANAGEMENT AND LENDING VEHICLES. Found in a real run:
  // "PIMCO Asset-Based Lending Co LLC" filed a Form D and passed every
  // check above. It is a lending vehicle run by a trillion-dollar asset
  // manager, not a venture-stage company.
  { pattern: /\basset[-\s]based\s+lending\b/i, kind: 'asset-based lending vehicle' },
  { pattern: /\b(?:asset\s+management|investment\s+management|advisors?|advisers?)\b\s*,?\s*(?:LLC|Inc\.?|LP)?\s*$/i, kind: 'asset manager' },
  { pattern: /\b(?:PIMCO|Blackstone|KKR|Apollo|Carlyle|Ares|Brookfield|BlackRock|Fidelity|Vanguard)\b/i, kind: 'large asset manager' },

  // CORPORATE SUBSIDIARIES AND REGIONAL JVs of established public
  // companies. "Fresenius Medical Care North Dallas, LLC" is a dialysis
  // clinic entity belonging to a listed multinational — a real Form D
  // filer, and not remotely an early-stage deal. Detected by the
  // "<known corporate> <geography>" shape.
  { pattern: /\b(?:Fresenius|Kaiser|HCA|Tenet|DaVita|UnitedHealth|Optum|CVS|Cigna|Humana)\b/i, kind: 'subsidiary of a large healthcare operator' },
  { pattern: /\b(?:North|South|East|West|Greater|Metro)\s+(?:Dallas|Houston|Atlanta|Chicago|Phoenix|Denver|Miami|Boston|Seattle|Portland)\b\s*,?\s*(?:LLC|Inc\.?|LP)?\s*$/i, kind: 'regional operating subsidiary' },

  // An entity that calls itself "Investments" is telling you what it is.
  { pattern: /\binvestments?\b\s*,?\s*(?:LLC|Inc\.?|LP|L\.?P\.?)?\s*$/i, kind: 'investment vehicle' },

  // Capacity-named energy projects: "72 MA Solar LLC", "150 MW Wind
  // Holdings". A megawatt/acre figure in the name means the entity IS a
  // project, not a company that builds them.
  { pattern: /\b\d{1,4}\s*(?:MW|MWh|KW|MA|AC|DC)\b.*\b(?:solar|wind|storage|energy)\b/i, kind: 'capacity-named energy project' },
  { pattern: /\b(?:solar|wind|storage)\s+(?:investments?|holdings?|ventures?)\b/i, kind: 'energy investment vehicle' },
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
