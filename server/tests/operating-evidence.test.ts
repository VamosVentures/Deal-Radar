import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import { addDealEvidence, getOpportunity, reclassifyCompany } from '../db/repos/opportunities';
import {
  assessCorroboration, hasStrongFinancingEvidence, qualifyIssuer, type WebsiteCheck,
} from '../services/issuerQualification';
import { selectSectorShortlist, type ShortlistCandidate } from '../services/shortlist';
import {
  assessOperatingEvidence, hostBelongsToIssuer, SUBSTANTIVE_MIN_CHARS,
} from '../sourcing/pageSignals';
import { scoreCompany } from '../../src/lib/scoring';
import {
  isQualifiedForOpportunity, meetsOperatingCompanyStandard,
} from '../../shared/qualification';
import type { DealEvidence, Opportunity } from '../../shared/opportunity';
import type { Company } from '../../src/types';

/**
 * Three questions, kept apart.
 *
 * A company's own website used to count as independent corroboration, so a
 * Form D plus a domain that merely responded reached
 * `qualified-operating-company`. These tests pin down the distinction that
 * replaced it: financing evidence proves money moved, identity evidence
 * proves whose site this is, and operating evidence proves somebody is
 * actually running a business. Only the third can satisfy the
 * operating-company gate, and a website can never satisfy the first.
 */

const TODAY = '2026-07-30';
const daysAgo = (n: number) => new Date(Date.parse(TODAY) - n * 86_400_000).toISOString().slice(0, 10);

// ── Page fixtures ─────────────────────────────────────────────────

/** A domain that resolves and names the company. Nothing more. */
function genericLandingPage(name: string): string {
  return `<!doctype html><html><head><title>${name}</title></head><body>`
    + `<h1>${name}</h1>`
    + `<p>Welcome to ${name}. Get in touch to find out more about what we are doing. `
    + `${name} is registered in Delaware and was founded by a small group of people who care deeply.</p>`
    + `<footer>&copy; 2026 ${name}. All rights reserved.</footer></body></html>`;
}

/** A real product site: says what it sells, at length. */
function substantivePage(name: string): string {
  return `<!doctype html><html><head><title>${name} | Warehouse automation</title></head><body>`
    + `<nav><a href="/product">Product</a><a href="/pricing">Pricing</a><a href="/customers">Customers</a>`
    + `<a href="/careers">Careers</a><a href="/docs">Documentation</a></nav>`
    + `<h1>${name} builds picking robots for high-volume distribution centres</h1>`
    + `<p>Our platform combines computer vision and force-feedback grippers so a single arm can handle `
    + `mixed-SKU totes without retooling. Operators deploy in under a week and see throughput gains of `
    + `thirty per cent in the first month of running the system on a live line.</p>`
    + `<h2>Trusted by leading logistics operators</h2>`
    + `<p>Read the case study describing how a national grocery chain cut mis-picks by half after `
    + `installing fourteen cells across three regional facilities during a single peak season.</p>`
    + `<footer><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a></footer>`
    + `</body></html>`;
}

const parkedPage = '<html><head><title>ACME.COM</title></head><body>'
  + '<h1>acmerobotics.com</h1><p>This domain is for sale. Buy this domain now and make an offer. '
  + 'Free transaction support, secure payments, listed with a registrar marketplace.</p></body></html>';

const placeholderPage = '<html><head><title>Acme Robotics</title></head><body>'
  + '<h1>Acme Robotics</h1><p>Coming soon. Our new website is under construction and will be '
  + 'available shortly. Please check back later for more information about us.</p></body></html>';

const thinPage = '<html><head><title>Acme Robotics</title></head><body><div id="root"></div></body></html>';

/** A page that presents a holding vehicle rather than a business. */
const holdingPage = '<html><head><title>Acme Robotics Holdings</title></head><body>'
  + '<h1>Acme Robotics</h1><p>Acme Robotics is a holding company incorporated to manage a portfolio of '
  + 'investments across a number of sectors. We hold interests in a range of underlying entities and do '
  + 'not trade directly. Correspondence may be addressed to our registered office at the address below.</p>'
  + '<footer>Registered office. Contact us by post.</footer></body></html>';

// ── Record fixtures ───────────────────────────────────────────────

function company(id: string, over: Record<string, unknown> = {}) {
  saveCompany({
    id, name: (over.name as string) ?? 'Acme Robotics Inc.',
    oneLiner: (over.oneLiner as string) ?? 'Unknown — not stated by the source',
    vertical: (over.vertical as string) ?? 'robotics',
    subcategory: 'Industrial & warehouse automation',
    stage: 'Unknown', city: 'Austin', state: (over.state as string) ?? 'TX',
    foundedYear: 2024, teamSize: 4,
    website: over.website as string | undefined,
    traction: { level: 0, note: 'Unknown' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [], flags: [], imported: true,
  } as never, { origin: 'extracted', source: 'test' });
}

function formD(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'form-d-filing', sourceId: 'sec', sourceName: 'SEC EDGAR (Form D)', tier: 1,
    url: 'https://www.sec.gov/Archives/edgar/data/1699390/x-index.htm',
    publishedAt: daysAgo(30), retrievedAt: TODAY,
    summary: 'Form D exempt-offering filing.', whyCurrent: 'Filed 30 days ago.',
    amountUsd: 5_000_000, amountText: '$5,000,000 offering', roundType: null, investors: [], ...over,
  };
}

function press(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'funding-announcement', sourceId: 'funding-news',
    sourceName: 'techcrunch.com (public RSS)', tier: 2,
    url: 'https://techcrunch.com/2026/07/10/acme-robotics-raises-30m/',
    publishedAt: daysAgo(20), retrievedAt: TODAY,
    summary: 'Acme Robotics raises $30M.', whyCurrent: 'Reported 20 days ago.',
    amountUsd: 30_000_000, amountText: '$30M', roundType: 'Series A', investors: ['Example Ventures'], ...over,
  };
}

function investor(over: Partial<DealEvidence> = {}): DealEvidence {
  return {
    opportunityType: 'funding-announcement', sourceId: 'investor-news',
    sourceName: 'Example Ventures', tier: 2,
    url: 'https://exampleventures.com/writing/our-investment-in-acme-robotics',
    publishedAt: daysAgo(18), retrievedAt: TODAY,
    summary: 'Why we invested in Acme Robotics.', whyCurrent: 'Published 18 days ago.',
    amountUsd: 30_000_000, amountText: '$30M', roundType: 'Series A', investors: ['Example Ventures'], ...over,
  };
}

/** The evidence row a discovered/confirmed website writes. */
function websiteRow(url: string): DealEvidence {
  return {
    opportunityType: 'none', sourceId: 'websites', sourceName: 'Official company website', tier: 3,
    url, publishedAt: null, retrievedAt: TODAY,
    summary: 'Official website responds with real content naming the company.',
    whyCurrent: 'Confirms an operating business; carries no date.',
    amountUsd: null, amountText: null, roundType: null, investors: [],
  };
}

/** Inject what the network would have answered, from a real page fixture. */
function checkFor(html: string, name: string, url: string): WebsiteCheck {
  const a = assessOperatingEvidence(html, name, url);
  return {
    verified: a.identityConfirmed, url, level: a.level, signals: a.signals,
    parked: a.level === 'parked', thin: a.level === 'thin', detail: a.detail,
  };
}

beforeEach(() => {
  store.resetForTests();
  resetDbForTests();
});

// ── The detector ──────────────────────────────────────────────────

describe('what a fetched page establishes', () => {
  const NAME = 'Acme Robotics Inc.';
  const URL = 'https://acmerobotics.com';

  it('calls a substantive product site substantive', () => {
    const a = assessOperatingEvidence(substantivePage(NAME), NAME, URL);
    expect(a.level).toBe('substantive');
    expect(a.identityConfirmed).toBe(true);
    expect(a.signals.join(' ')).toMatch(/offering/);
  });

  it('refuses a bare reachable domain: a name and a title tag are identity, not operations', () => {
    const a = assessOperatingEvidence(genericLandingPage(NAME), NAME, URL);
    expect(a.level).toBe('identity-only');
    // Identity IS established — that is the distinction being drawn.
    expect(a.identityConfirmed).toBe(true);
    expect(a.textLength).toBeLessThan(SUBSTANTIVE_MIN_CHARS);
  });

  it('refuses parked, placeholder and thin pages, and names each correctly', () => {
    expect(assessOperatingEvidence(parkedPage, NAME, URL).level).toBe('parked');
    expect(assessOperatingEvidence(placeholderPage, NAME, URL).level).toBe('parked');
    // "Thin" is a statement about the checker, never an accusation about
    // the business — infinity.inc is a real company that renders in the
    // browser, and calling it parked would be false.
    const thin = assessOperatingEvidence(thinPage, NAME, URL);
    expect(thin.level).toBe('thin');
    expect(thin.detail).toMatch(/finding about the check/i);
  });

  it('refuses an unrelated domain even when the page names the company', () => {
    // The live failure this catches: a funding article on a media outlet's
    // domain was recorded as Agon's "official company website".
    const articleUrl = 'https://resiliencemedia.co/acme-robotics-emerges-from-stealth-with-30m/';
    const a = assessOperatingEvidence(substantivePage(NAME), NAME, articleUrl);
    expect(a.level).toBe('unrelated');
    expect(a.detail).toMatch(/page ABOUT a company/i);
  });

  it('refuses a holding-company page: a vehicle is not an operating business', () => {
    expect(assessOperatingEvidence(holdingPage, NAME, URL).level).toBe('identity-only');
  });

  it('reports a page it cannot interpret as unread rather than as empty', () => {
    // pascalmedical.com sells surgical lamps, entirely in Spanish. Every
    // marker in the detector is English. Recording that as "describes no
    // business" would state something we did not find out.
    const spanish = '<html><head><title>Pascal Medical</title></head><body>'
      + '<h1>Pascal Medical</h1><p>Con las lamparas frontales y lupas quirurgicas de Pascal Medical '
      + 'disfrutaras de la calidad y constante evolucion que necesitas en tu consulta diaria, con envio '
      + 'a toda la peninsula y garantia de dos anos sobre cada unidad que sale de nuestro taller propio. '
      + 'Nuestro catalogo incluye modelos para cirugia dental, veterinaria y dermatologia avanzada, '
      + 'fabricados con materiales ligeros y baterias de larga duracion para jornadas completas. '
      + 'Cada equipo se entrega calibrado y acompanado de un manual detallado en castellano, y '
      + 'nuestro equipo tecnico atiende cualquier consulta sobre mantenimiento durante toda la vida util.</p>'
      + '</body></html>';
    const a = assessOperatingEvidence(spanish, 'Pascal Medical', 'https://pascalmedical.com');
    expect(a.level).toBe('undetermined');
    expect(a.detail).toMatch(/language/i);
  });

  it('matches a shortened host to its issuer but not an unrelated one', () => {
    expect(hostBelongsToIssuer('https://www.venusaero.com', 'Venus Aerospace')).toBe(true);
    expect(hostBelongsToIssuer('https://acmerobotics.com', 'Acme Robotics Inc.')).toBe(true);
    expect(hostBelongsToIssuer('https://resiliencemedia.co/x', 'Agon')).toBe(false);
    expect(hostBelongsToIssuer('https://techcrunch.com/2026/x', 'Ramp')).toBe(false);
  });
});

// ── The gate ──────────────────────────────────────────────────────

describe('the operating-company gate', () => {
  it('Form D + a bare reachable domain does NOT qualify', async () => {
    company('c1', { website: 'https://acmerobotics.com' });
    addDealEvidence('c1', formD());
    addDealEvidence('c1', websiteRow('https://acmerobotics.com'));

    const q = await qualifyIssuer('c1', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(genericLandingPage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });

    expect(isQualifiedForOpportunity(q.result)).toBe(false);
    expect(q.result).toBe('company-lead-requires-corroboration');
    expect(q.operatingEvidence.level).toBe('identity-only');
    expect(q.reasonCodes).toContain('operating-evidence-unconfirmed');
    // Identity was still established; the verdict does not pretend otherwise.
    expect(q.reasonCodes).toContain('website-verified');
    expect(reclassifyCompany('c1', { today: TODAY }).classification).toBe('company-lead');
  });

  it('Form D + a substantive matching company website DOES qualify, with no second article demanded', async () => {
    company('c2', { website: 'https://acmerobotics.com' });
    addDealEvidence('c2', formD());
    addDealEvidence('c2', websiteRow('https://acmerobotics.com'));

    const q = await qualifyIssuer('c2', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(substantivePage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });

    expect(q.result).toBe('qualified-operating-company');
    expect(q.operatingEvidence.level).toBe('substantive');
    expect(q.reasonCodes).toContain('strong-financing-evidence');
    // One financing source is enough WHEN operating evidence is real.
    expect(q.corroboratingSources).toHaveLength(1);
    expect(reclassifyCompany('c2', { today: TODAY }).classification).toBe('recent-financing-signal');
  });

  it('press or investor evidence + a substantive official website qualifies', async () => {
    for (const [id, ev] of [['p1', press()], ['i1', investor()]] as const) {
      company(id, { website: 'https://acmerobotics.com' });
      addDealEvidence(id, ev);
      addDealEvidence(id, websiteRow('https://acmerobotics.com'));
      const q = await qualifyIssuer(id, {
        offline: true, today: TODAY,
        websiteCheck: checkFor(substantivePage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com'),
      });
      expect(q.result, id).toBe('qualified-operating-company');
      expect(q.corroboratingSources.map((s) => s.sourceId), id).toEqual([ev.sourceId]);
    }
  });

  it('parked, placeholder, thin and unrelated websites all fail the gate', async () => {
    const cases: [string, string, string][] = [
      ['w1', parkedPage, 'https://acmerobotics.com'],
      ['w2', placeholderPage, 'https://acmerobotics.com'],
      ['w3', thinPage, 'https://acmerobotics.com'],
      ['w4', substantivePage('Acme Robotics Inc.'), 'https://resiliencemedia.co/acme-robotics-raises-30m/'],
    ];
    for (const [id, html, url] of cases) {
      company(id, { website: url });
      addDealEvidence(id, formD({ url: `https://www.sec.gov/${id}` }));
      const q = await qualifyIssuer(id, {
        offline: true, today: TODAY,
        websiteCheck: checkFor(html, 'Acme Robotics Inc.', url),
      });
      expect(isQualifiedForOpportunity(q.result), `${id} (${q.operatingEvidence.level})`).toBe(false);
      expect(q.operatingEvidence.level, id).not.toBe('substantive');
    }
  });

  it('sends an unconfirmable page to a human, and a definitely-empty one to the lead pile', async () => {
    // The two failures are not the same and must not be reported the same.
    // A page we could not read is a gap in the CHECK; a parked domain is a
    // finding about the company.
    company('h1', { website: 'https://acmerobotics.com', oneLiner: 'Robots that pick parts off a line.' });
    addDealEvidence('h1', press());
    const inconclusive = await qualifyIssuer('h1', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(thinPage, 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });
    expect(inconclusive.result).toBe('human-review-required');
    expect(reclassifyCompany('h1', { today: TODAY }).classification).toBe('unverified-opportunity');

    company('h2', { website: 'https://acmerobotics.com', oneLiner: 'Robots that pick parts off a line.' });
    addDealEvidence('h2', press({ url: 'https://techcrunch.com/2026/07/10/other/' }));
    const definite = await qualifyIssuer('h2', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(parkedPage, 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });
    expect(definite.result).toBe('company-lead-requires-corroboration');
    expect(reclassifyCompany('h2', { today: TODAY }).classification).toBe('company-lead');
  });

  /**
   * The record this change exists for.
   *
   * AEGIS FINTECH LTD. — a $100M offering from an entity with no
   * discoverable product — reached `qualified-operating-company` on a Form
   * D plus a domain that loaded. The shape is the thing being tested: one
   * self-reported filing, no third-party account of it, no product
   * description on the record, and a website that says only who owns it.
   */
  it('refuses an AEGIS FINTECH LTD.-shaped record: one filing and a landing page', async () => {
    company('shell', {
      name: 'AEGIS FINTECH LTD.', website: 'https://aegisfintech.example',
      oneLiner: 'Unknown — not stated by the source', vertical: 'fintech',
    });
    addDealEvidence('shell', formD({ amountUsd: 100_000_000, amountText: '$100,000,000 offering' }));
    addDealEvidence('shell', websiteRow('https://aegisfintech.example'));

    const q = await qualifyIssuer('shell', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(genericLandingPage('AEGIS FINTECH LTD.'), 'AEGIS FINTECH LTD.', 'https://aegisfintech.example'),
    });

    expect(isQualifiedForOpportunity(q.result)).toBe(false);
    expect(q.reasonCodes).toContain('only-evidence-is-form-d');
    expect(q.reasonCodes).toContain('website-identity-only');
    // A large offering does not buy confidence it has not earned.
    expect(q.operatingConfidence).toBeLessThan(0.5);
    expect(reclassifyCompany('shell', { today: TODAY }).classification).toBe('company-lead');
  });

  it('still excludes public companies and funds/SPVs, whatever their website says', async () => {
    company('pub', { name: 'Adagio Medical Holdings, Inc.', website: 'https://adagiomedical.com' });
    addDealEvidence('pub', formD());
    const pub = await qualifyIssuer('pub', {
      offline: true, today: TODAY,
      publicCheck: { isPubliclyTraded: true, ticker: 'ADGM', exchanges: ['Nasdaq'], periodicForms: ['10-Q'], detail: 'public' },
      // Even a genuinely substantive site cannot make a listed company a venture deal.
      websiteCheck: checkFor(substantivePage('Adagio Medical Holdings, Inc.'), 'Adagio Medical Holdings, Inc.', 'https://adagiomedical.com'),
    });
    expect(pub.result).toBe('public-company');

    for (const [id, name] of [['f1', 'Tribe Capital Fintech Fund I, L.P.'], ['f2', 'Scenic Hill Solar LI, LLC']] as const) {
      company(id, { name, website: 'https://example.test' });
      addDealEvidence(id, formD({ url: `https://www.sec.gov/${id}` }));
      const q = await qualifyIssuer(id, {
        offline: true, today: TODAY,
        websiteCheck: checkFor(substantivePage(name), name, 'https://example.test'),
      });
      expect(isQualifiedForOpportunity(q.result), name).toBe(false);
      expect(q.isFundOrSpv, name).toBe(true);
    }
  });
});

// ── Financing independence ────────────────────────────────────────

describe('who counts as a financing source', () => {
  it('never counts the company\'s own website', () => {
    company('s1', { website: 'https://acmerobotics.com' });
    addDealEvidence('s1', formD());
    addDealEvidence('s1', websiteRow('https://acmerobotics.com'));

    const corr = assessCorroboration('s1');
    expect(corr.independentFamilies).toEqual(['regulatory']);
    expect(corr.selfPublished).toHaveLength(1);
    expect(corr.selfPublished[0].reason).toMatch(/not an independent financing source/i);
    // "Only a Form D" stays true — a website does not change that.
    expect(corr.onlyEvidenceIsFormD).toBe(true);
  });

  it('does not count a company self-announcement on its own domain', () => {
    // An entity announcing its own round is not a source for it, whatever
    // family the adapter that fetched it filed the row under.
    company('s2', { website: 'https://acmerobotics.com' });
    addDealEvidence('s2', formD());
    addDealEvidence('s2', press({
      sourceId: 'funding-news', sourceName: 'acmerobotics.com (blog)',
      url: 'https://acmerobotics.com/blog/announcing-our-series-a',
    }));

    const corr = assessCorroboration('s2');
    expect(corr.independentFamilies).toEqual(['regulatory']);
    expect(corr.selfPublished.map((s) => s.reason).join(' ')).toMatch(/own domain/i);
  });

  it('counts a genuinely third-party announcement', () => {
    company('s3', { website: 'https://acmerobotics.com' });
    addDealEvidence('s3', formD());
    addDealEvidence('s3', press());
    expect(assessCorroboration('s3').independentFamilies).toContain('press:techcrunch.com');
    expect(hasStrongFinancingEvidence('s3')).toBe(true);
  });

  it('a website alone is not strong financing evidence', () => {
    company('s4', { website: 'https://acmerobotics.com' });
    addDealEvidence('s4', websiteRow('https://acmerobotics.com'));
    expect(hasStrongFinancingEvidence('s4')).toBe(false);
  });

  it('states the standard in one place, and it needs both halves', () => {
    expect(meetsOperatingCompanyStandard({ independentFinancingSources: 1, operatingEvidence: 'substantive' })).toBe(true);
    expect(meetsOperatingCompanyStandard({ independentFinancingSources: 1, operatingEvidence: 'identity-only' })).toBe(false);
    expect(meetsOperatingCompanyStandard({ independentFinancingSources: 0, operatingEvidence: 'substantive' })).toBe(false);
    // Two sources do not substitute for knowing there is a business.
    expect(meetsOperatingCompanyStandard({ independentFinancingSources: 3, operatingEvidence: 'thin' })).toBe(false);
  });
});

// ── Downstream: scoring, shortlist, idempotence ───────────────────

describe('what demotion does and does not disturb', () => {
  /**
   * The 92 provisional scores are computed from what is KNOWN ABOUT THE
   * COMPANY — sector fit, stage, founders, traction, geography. None of
   * that is qualification, and a demotion must not silently reshape the
   * scoring population.
   */
  it('leaves provisional scoring untouched when a verdict is demoted', async () => {
    company('sc1', { website: 'https://acmerobotics.com' });
    addDealEvidence('sc1', formD());
    addDealEvidence('sc1', websiteRow('https://acmerobotics.com'));

    const asCompany = (): Company => ({
      id: 'sc1', name: 'Acme Robotics Inc.', oneLiner: 'Unknown — not stated by the source',
      // Nothing the model can assess ABOUT THE COMPANY: no taxonomy match,
      // no stage, no traction, no founder, no jurisdiction, no round. This
      // is the shape of the 92 provisional records.
      vertical: 'robotics', subcategory: 'Unknown', stage: 'Unknown',
      city: 'Unknown', state: '??', foundedYear: 2024, teamSize: 4,
      traction: { level: 0, note: 'Unknown' },
      founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
      evidence: [], flags: [], imported: true,
    } as unknown as Company);

    const qualified = await qualifyIssuer('sc1', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(substantivePage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });
    expect(qualified.result).toBe('qualified-operating-company');
    const before = scoreCompany(asCompany());

    const demoted = await qualifyIssuer('sc1', {
      offline: true, today: TODAY,
      websiteCheck: checkFor(genericLandingPage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com'),
    });
    expect(isQualifiedForOpportunity(demoted.result)).toBe(false);
    const after = scoreCompany(asCompany());

    // A record with nothing known about the company stays provisional, and
    // the score is identical either side of the demotion.
    expect(before.provisional).toBe(true);
    expect(after.provisional).toBe(before.provisional);
    expect(after.score).toBe(before.score);
    expect(after.provisionalReason).toBe(before.provisionalReason);
  });

  it('recalculates the shortlist so a demoted record leaves it and is accounted for', () => {
    const opportunity = (id: string): Opportunity => ({
      companyId: id, classification: 'recent-financing-signal', primarySourceId: 'funding-news',
      primaryTier: 2, opportunityType: 'funding-announcement',
      evidenceUrl: `https://example.test/${id}`, evidencePublishedAt: '2026-07-01',
      evidenceRetrievedAt: TODAY, evidenceSummary: 'Raised a round.', whyCurrent: 'Reported.',
      amountUsd: null, amountText: null, roundType: null, investors: [], evidenceConfidence: 0.8,
      conflicts: [], missingInformation: [], classifiedAt: `${TODAY}T00:00:00.000Z`,
    });
    const cand = (name: string, extra: Partial<ShortlistCandidate>): ShortlistCandidate => ({
      companyId: name, name, opportunity: opportunity(name), fitScore: 5,
      independentSources: 1, quarantined: false, ...extra,
    });

    const pool = [
      cand('Real Site', { operatingEvidence: 'substantive' }),
      cand('Bare Domain', { operatingEvidence: 'identity-only' }),
      cand('Parked', { operatingEvidence: 'parked' }),
    ];
    const result = selectSectorShortlist('robotics', pool);

    expect(result.selected.map((s) => s.name)).toEqual(['Real Site']);
    expect(result.heldBack).toHaveLength(2);
    // The accounting invariant survives: nothing vanishes.
    expect(result.selected.length + result.heldBack.length).toBe(result.eligible);
    for (const h of result.heldBack) expect(h.reasonCode).toBe('insufficient-corroboration');
  });

  it('is idempotent: requalifying unchanged inputs changes nothing', async () => {
    company('id1', { website: 'https://acmerobotics.com' });
    addDealEvidence('id1', formD());
    addDealEvidence('id1', websiteRow('https://acmerobotics.com'));
    const check = () => checkFor(genericLandingPage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com');

    const first = await qualifyIssuer('id1', { offline: true, today: TODAY, websiteCheck: check() });
    const firstClass = reclassifyCompany('id1', { today: TODAY }).classification;
    const second = await qualifyIssuer('id1', { offline: true, today: TODAY, websiteCheck: check() });
    const secondClass = reclassifyCompany('id1', { today: TODAY }).classification;
    const third = await qualifyIssuer('id1', { offline: true, today: TODAY, websiteCheck: check() });

    for (const q of [second, third]) {
      expect(q.result).toBe(first.result);
      expect(q.reasonCodes).toEqual(first.reasonCodes);
      expect(q.operatingEvidence).toEqual(first.operatingEvidence);
      expect(q.corroboratingSources).toEqual(first.corroboratingSources);
      expect(q.operatingConfidence).toBe(first.operatingConfidence);
    }
    expect(secondClass).toBe(firstClass);
    expect(getOpportunity('id1')!.classification).toBe(firstClass);
  });

  it('a dry run computes the same verdict it would write, and writes nothing', async () => {
    company('dr1', { website: 'https://acmerobotics.com' });
    addDealEvidence('dr1', formD());
    const check = checkFor(genericLandingPage('Acme Robotics Inc.'), 'Acme Robotics Inc.', 'https://acmerobotics.com');

    const dry = await qualifyIssuer('dr1', { offline: true, today: TODAY, websiteCheck: check, dryRun: true });
    // Nothing persisted, so the classifier still sees an unqualified record.
    expect(reclassifyCompany('dr1', { today: TODAY }).classification).not.toBe('recent-financing-signal');

    const real = await qualifyIssuer('dr1', { offline: true, today: TODAY, websiteCheck: check });
    expect(real.result).toBe(dry.result);
    expect(real.reasonCodes).toEqual(dry.reasonCodes);
    expect(real.operatingEvidence).toEqual(dry.operatingEvidence);
  });
});
