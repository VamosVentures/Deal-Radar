import type { Company } from '../types';
import type { CompanyMeta } from '../lib/api';
import type { CompanyEnrichment } from '../../shared/enrichment';
import type { CompanyNote } from '../../shared/notes';
import type { PendingEvidenceItem } from '../lib/api';
import type { DiscoveryCandidate, DiscoveryRun, StealthSignal } from '../../shared/discovery';
import type { RadarEntry } from '../../shared/enrichment';

/**
 * Synthetic demonstration fixtures for VITE_DEMO_MODE.
 *
 * Every name, domain, founder, and evidence quote below is invented for
 * this package. None of it describes a real company, a real person, or
 * any actual VamosVentures deal, decision, or investment. The one
 * "High-Fit" example is explicitly labelled as illustrative in its own
 * data (name, one-liner, and traction note) so a screenshot of it can
 * never be mistaken for a real sourced company reaching that bar.
 *
 * Scores are NOT hand-entered: every company here runs through the
 * real `scoreCompany()` in src/lib/scoring.ts, exactly like production
 * data. Nothing about the scoring model, thresholds, or provisional
 * gate is altered for this fixture set.
 */

const DAY = 86_400_000;
// A fixed reference instant so the fixture set (recency, "this week",
// "stale") renders identically on every capture — see scripts/demo note
// in demoApi.ts for how `now` is threaded through instead of `Date.now()`.
export const DEMO_NOW = new Date('2026-08-06T16:00:00.000Z');
const iso = (offsetDays: number) => new Date(DEMO_NOW.getTime() + offsetDays * DAY).toISOString();
const isoDate = (offsetDays: number) => iso(offsetDays).slice(0, 10);

export interface DemoCompanyExtra {
  reviewStatus: string;
  discoverySource: string;
  discoveredAtOffsetDays: number; // relative to DEMO_NOW
  lastReviewedOffsetDays: number | null; // null = never reviewed
}

export const DEMO_COMPANIES: (Company & { _demo: DemoCompanyExtra })[] = [
  // ── The one clearly-labelled synthetic High-Fit example ──────────
  {
    id: 'demo-solstice-robotics',
    name: 'Solstice Robotics (Illustrative Example)',
    oneLiner:
      'SYNTHETIC DEMO EXAMPLE — not a real company. Illustrates the platform once an analyst has recorded a traction review; no real company in the database currently reaches High-Fit.',
    vertical: 'frontier',
    subcategory: 'Industrial & warehouse automation',
    stage: 'Seed',
    city: 'San Francisco',
    state: 'CA',
    foundedYear: 2025,
    teamSize: 9,
    raising: '$3.2M seed',
    lastFundingDate: isoDate(-40),
    traction: {
      level: 7,
      note:
        'Named customer — three regional distribution centers running the palletizing module in production. Source: demo launch post (synthetic). Independently confirmed by a demo industry-newsletter mention.',
    },
    founders: [
      {
        name: 'Priya Nakamura', role: 'CEO & Co-founder',
        background: 'Ex-robotics lead at a large logistics automation firm; led perception team for 5 years before founding.',
        identity: { femaleLed: true, basis: 'Self-identified', source: 'Demo founder profile (synthetic)' },
      },
      {
        name: 'Marcus Oduya', role: 'CTO & Co-founder',
        background: 'PhD in controls engineering; previously built warehouse robotics software at a mid-size automation startup, acquired in 2023.',
      },
    ],
    evidence: [
      { claim: 'Raised a $3.2M seed round led to expand deployment capacity.', source: 'Demo funding brief (synthetic)', url: 'https://example.com/demo/solstice/funding', date: isoDate(-40), type: 'Filing' },
      { claim: '"We now run the palletizing module across three regional distribution centers."', source: 'Demo founder statement (synthetic)', url: 'https://example.com/demo/solstice/launch', date: isoDate(-10), type: 'Founder statement' },
      { claim: 'Graduated from a Winter 2025 accelerator cohort.', source: 'Demo accelerator directory (synthetic)', url: 'https://example.com/demo/accelerator/solstice', date: isoDate(-120), type: 'Accelerator' },
      { claim: 'Featured in a regional logistics-tech roundup as one of three warehouse-automation startups to watch.', source: 'Demo trade newsletter (synthetic)', url: 'https://example.com/demo/news/solstice', date: isoDate(-8), type: 'News' },
    ],
    flags: [],
    website: 'https://example.com/demo/solstice',
    accelerator: 'Demo Accelerator W25 (synthetic)',
    dateFirstSurfaced: isoDate(-45),
    lastRefreshed: isoDate(-2),
    _demo: {
      reviewStatus: 'Approved for HubSpot',
      discoverySource: 'yc',
      discoveredAtOffsetDays: -45,
      lastReviewedOffsetDays: -2,
    },
  },

  // ── Awaiting Review, provisional, various verticals/states ───────
  {
    id: 'demo-ledgerline',
    name: 'Ledgerline',
    oneLiner: 'Demo synthetic company — reconciliation infrastructure for regional banks.',
    vertical: 'fintech',
    subcategory: 'New financial infrastructure',
    stage: 'Unknown',
    city: 'New York',
    state: 'NY',
    foundedYear: 2025,
    teamSize: 5,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Devon Achebe', role: 'CEO & Co-founder', background: 'Unknown — requires manual research' },
      { name: 'Sara Lindqvist', role: 'CTO & Co-founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Filed a Form D reporting an exempt securities offering.', source: 'Demo SEC EDGAR (synthetic)', url: 'https://example.com/demo/sec/ledgerline', date: isoDate(-6), type: 'Filing' },
    ],
    flags: [],
    website: 'https://example.com/demo/ledgerline',
    dateFirstSurfaced: isoDate(-6),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'sec', discoveredAtOffsetDays: -6, lastReviewedOffsetDays: null },
  },
  {
    id: 'demo-carewell-triage',
    name: 'Carewell Triage',
    oneLiner: 'Demo synthetic company — AI-assisted intake triage for outpatient clinics.',
    vertical: 'health',
    subcategory: 'Personalized care (AI / tech-enabled)',
    stage: 'Pre-seed',
    city: 'Austin',
    state: 'TX',
    foundedYear: 2026,
    teamSize: 3,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Renata Silva', role: 'Founder', background: 'Former nurse practitioner; built the first prototype after seeing intake bottlenecks firsthand.' },
    ],
    evidence: [
      { claim: '"We are launching a pilot with two outpatient clinics next quarter."', source: 'Demo founder statement (synthetic)', url: 'https://example.com/demo/carewell/post', date: isoDate(-3), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/carewell',
    dateFirstSurfaced: isoDate(-3),
    _demo: { reviewStatus: 'New', discoverySource: 'funding-news', discoveredAtOffsetDays: -3, lastReviewedOffsetDays: null },
  },
  {
    id: 'demo-gridwatch',
    name: 'Gridwatch Analytics',
    oneLiner: 'Demo synthetic company — anomaly detection for distribution-grid sensors.',
    vertical: 'sustainability',
    subcategory: 'Smart grids',
    stage: 'Seed',
    city: 'Denver',
    state: 'CO',
    foundedYear: 2024,
    teamSize: 11,
    raising: '$4.5M seed',
    lastFundingDate: isoDate(-200),
    traction: { level: 0, note: 'Unknown for scoring — analyst searched and found no publicly disclosed traction as of ' + isoDate(-14) + '. Absence of public evidence is not evidence of absence, so this is excluded from the score rather than counted as zero.' },
    founders: [
      { name: 'Owen Baptiste', role: 'CEO & Co-founder', background: 'Ex-utility operations engineer, 8 years at a regional grid operator before founding.' },
      { name: 'Mei Tanaka', role: 'Head of Data', background: 'Applied statistics researcher; previously led anomaly-detection work at an industrial sensing company.' },
    ],
    evidence: [
      { claim: 'Announced a $4.5M seed round to expand sensor-network coverage.', source: 'Demo funding brief (synthetic)', url: 'https://example.com/demo/gridwatch/funding', date: isoDate(-200), type: 'News' },
      { claim: 'Presented anomaly-detection results at a regional grid-modernization conference.', source: 'Demo conference program (synthetic)', url: 'https://example.com/demo/gridwatch/conf', date: isoDate(-95), type: 'Database record' },
    ],
    flags: [],
    website: 'https://example.com/demo/gridwatch',
    dateFirstSurfaced: isoDate(-210),
    lastRefreshed: isoDate(-40),
    _demo: { reviewStatus: 'Research Needed', discoverySource: 'investor-news', discoveredAtOffsetDays: -210, lastReviewedOffsetDays: -40 },
  },
  {
    id: 'demo-copilot-forge',
    name: 'Copilot Forge',
    oneLiner: 'Demo synthetic company — workflow copilots for back-office operations teams.',
    vertical: 'fow',
    subcategory: 'AI copilots',
    stage: 'Series A',
    city: 'Chicago',
    state: 'IL',
    foundedYear: 2023,
    teamSize: 22,
    raising: '$14M Series A',
    lastFundingDate: isoDate(-300),
    traction: { level: 6, note: 'Paid pilot — one enterprise back-office team paying for a limited rollout. Source: demo customer case study (synthetic). Company-claimed; not independently confirmed.' },
    founders: [
      { name: 'Jonah Petrakis', role: 'CEO & Co-founder', background: 'Product lead at a workflow-automation company for 6 years prior to founding; led enterprise rollout.' },
      { name: 'Aisha Farouk', role: 'CTO & Co-founder', background: 'Machine-learning engineer; built the first copilot prototype nights and weekends before raising.' },
      { name: 'Ben Okafor', role: 'Head of Sales', background: 'Enterprise sales, previously at a large productivity-software vendor.' },
    ],
    evidence: [
      { claim: 'Closed a $14M Series A to expand enterprise rollout.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/copilotforge/series-a', date: isoDate(-300), type: 'News' },
      { claim: '"Our first enterprise customer is now paying for the limited rollout across two departments."', source: 'Demo case study (synthetic)', url: 'https://example.com/demo/copilotforge/case-study', date: isoDate(-25), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/copilotforge',
    accelerator: 'Demo Accelerator S23 (synthetic)',
    dateFirstSurfaced: isoDate(-310),
    lastRefreshed: isoDate(-25),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'yc', discoveredAtOffsetDays: -310, lastReviewedOffsetDays: -25 },
  },

  // ── Stale example: last reviewed 9 days ago (> fixed 7-day KPI rule) ─
  {
    id: 'demo-farmloop',
    name: 'FarmLoop Robotics',
    oneLiner: 'Demo synthetic company — autonomous weeding robots for row-crop farms.',
    vertical: 'frontier',
    subcategory: 'Field & agricultural robotics',
    stage: 'Unknown',
    city: 'Fresno',
    state: 'CA',
    foundedYear: 2024,
    teamSize: 7,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Hana Kowalski', role: 'Founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Repository activity shows an active perception-model codebase.', source: 'Demo GitHub (synthetic)', url: 'https://example.com/demo/github/farmloop', date: isoDate(-60), type: 'Database record' },
    ],
    flags: [],
    website: 'https://example.com/demo/farmloop',
    dateFirstSurfaced: isoDate(-70),
    lastRefreshed: isoDate(-9),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'github', discoveredAtOffsetDays: -70, lastReviewedOffsetDays: -9 },
  },

  // ── Newly discovered this week ────────────────────────────────────
  {
    id: 'demo-harborline',
    name: 'Harborline Capital Tools',
    oneLiner: 'Demo synthetic company — portfolio reconciliation tooling for RIAs.',
    vertical: 'fintech',
    subcategory: 'Wealth & capital markets',
    stage: 'Unknown',
    city: 'Miami',
    state: 'FL',
    foundedYear: 2026,
    teamSize: 4,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Talia Reyes', role: 'Co-founder', background: 'Unknown — requires manual research' },
      { name: 'Noah Bergstrom', role: 'Co-founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Filed a Form D reporting an exempt securities offering.', source: 'Demo SEC EDGAR (synthetic)', url: 'https://example.com/demo/sec/harborline', date: isoDate(-1), type: 'Filing' },
    ],
    flags: [],
    website: 'https://example.com/demo/harborline',
    dateFirstSurfaced: isoDate(-1),
    _demo: { reviewStatus: 'New', discoverySource: 'sec', discoveredAtOffsetDays: -1, lastReviewedOffsetDays: null },
  },
  {
    id: 'demo-lumenroot',
    name: 'Lumenroot Diagnostics',
    oneLiner: 'Demo synthetic company — at-home biomarker testing for longevity clinics.',
    vertical: 'health',
    subcategory: 'Longevity',
    stage: 'Unknown',
    city: 'Boulder',
    state: 'CO',
    foundedYear: 2026,
    teamSize: 6,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Grace Odhiambo', role: 'Founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Announced participation in a demo accelerator cohort.', source: 'Demo accelerator directory (synthetic)', url: 'https://example.com/demo/accelerator/lumenroot', date: isoDate(-2), type: 'Accelerator' },
    ],
    flags: [],
    website: 'https://example.com/demo/lumenroot',
    accelerator: 'Demo Accelerator Su26 (synthetic)',
    dateFirstSurfaced: isoDate(-2),
    _demo: { reviewStatus: 'New', discoverySource: 'yc', discoveredAtOffsetDays: -2, lastReviewedOffsetDays: null },
  },

  // ── Passed / Monitor / Synced examples, for review-action variety ──
  {
    id: 'demo-voltframe',
    name: 'Voltframe Energy',
    oneLiner: 'Demo synthetic company — grid-scale battery monitoring software.',
    vertical: 'sustainability',
    subcategory: 'Digital energy infrastructure',
    stage: 'Series B+',
    city: 'Seattle',
    state: 'WA',
    foundedYear: 2020,
    teamSize: 60,
    raising: '$40M Series C',
    lastFundingDate: isoDate(-500),
    traction: { level: 9, note: 'Multiple deployments — several utility customers in production. Source: demo customer list (synthetic). Independently confirmed by a demo trade-press article.' },
    founders: [
      { name: 'Elias Thornbury', role: 'CEO', background: 'Serial energy-sector founder; exited a prior grid-software company.' },
    ],
    evidence: [
      { claim: 'Closed a $40M Series C.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/voltframe/series-c', date: isoDate(-500), type: 'News' },
    ],
    flags: [],
    website: 'https://example.com/demo/voltframe',
    dateFirstSurfaced: isoDate(-900),
    lastRefreshed: isoDate(-5),
    _demo: { reviewStatus: 'Passed', discoverySource: 'investor-news', discoveredAtOffsetDays: -900, lastReviewedOffsetDays: -5 },
  },
  {
    id: 'demo-unifynow',
    name: 'UnifyNow Payments',
    oneLiner: 'Demo synthetic company — DeFi-adjacent cross-border settlement rails.',
    vertical: 'fintech',
    subcategory: 'DeFi & blockchain',
    stage: 'Unknown',
    city: 'Miami',
    state: 'FL',
    foundedYear: 2025,
    teamSize: 8,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Kwame Asante', role: 'Co-founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: '"We already integrate with several settlement partners for cross-border deposits."', source: 'Demo launch post (synthetic)', url: 'https://example.com/demo/unifynow/launch', date: isoDate(-30), type: 'Founder statement' },
    ],
    flags: ['defi-adjacent'],
    website: 'https://example.com/demo/unifynow',
    accelerator: 'Demo Accelerator W26 (synthetic)',
    dateFirstSurfaced: isoDate(-30),
    _demo: { reviewStatus: 'Monitor', discoverySource: 'yc', discoveredAtOffsetDays: -30, lastReviewedOffsetDays: -20 },
  },
  {
    id: 'demo-humaform',
    name: 'Humaform Devices',
    oneLiner: 'Demo synthetic company — general-purpose humanoid platform for light assembly.',
    vertical: 'frontier',
    subcategory: 'Humanoid & general-purpose robots',
    stage: 'Series A',
    city: 'Boston',
    state: 'MA',
    foundedYear: 2023,
    teamSize: 34,
    raising: '$22M Series A',
    lastFundingDate: isoDate(-150),
    traction: { level: 4, note: 'Pilot — one design-partner manufacturing line. Source: demo case study (synthetic). Company-claimed.' },
    founders: [
      { name: 'Ines Carvalho', role: 'CEO & Co-founder', background: 'Robotics PhD; led a hardware team at a large automation company before founding.' },
      { name: 'Tomasz Wieczorek', role: 'CTO & Co-founder', background: 'Mechanical engineer, previously built actuator systems at an industrial robotics firm.' },
    ],
    evidence: [
      { claim: 'Closed a $22M Series A to fund a second manufacturing pilot.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/humaform/series-a', date: isoDate(-150), type: 'News' },
    ],
    flags: ['hardware-heavy'],
    website: 'https://example.com/demo/humaform',
    dateFirstSurfaced: isoDate(-400),
    lastRefreshed: isoDate(-15),
    _demo: { reviewStatus: 'Approved for HubSpot', discoverySource: 'investor-news', discoveredAtOffsetDays: -400, lastReviewedOffsetDays: -15 },
  },
  {
    id: 'demo-workwell-collective',
    name: 'Workwell Collective',
    oneLiner: 'Demo synthetic company — human-centered automation for frontline scheduling.',
    vertical: 'fow',
    subcategory: 'Frontline & essential-worker technology',
    stage: 'Unknown',
    city: 'Columbus',
    state: 'OH',
    foundedYear: 2025,
    teamSize: 5,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Dara Whitfield', role: 'Founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Company website describes a frontline-scheduling product for hourly retail teams.', source: 'Demo company website (synthetic)', url: 'https://example.com/demo/workwell', date: isoDate(-18), type: 'Product' },
    ],
    flags: [],
    website: 'https://example.com/demo/workwell',
    dateFirstSurfaced: isoDate(-18),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'websites', discoveredAtOffsetDays: -18, lastReviewedOffsetDays: null },
  },

  // ── Additional synthetic companies — broader coverage per vertical ──
  {
    id: 'demo-meridian-health',
    name: 'Meridian Health Analytics',
    oneLiner: 'Demo synthetic company — claims-denial prediction for independent physician groups.',
    vertical: 'health',
    subcategory: 'Healthcare finance',
    stage: 'Seed',
    city: 'Nashville',
    state: 'TN',
    foundedYear: 2024,
    teamSize: 10,
    raising: '$5.1M seed',
    lastFundingDate: isoDate(-110),
    traction: { level: 6, note: 'Paid pilot — one regional physician group paying for the denial-prediction module. Source: demo case study (synthetic). Company-claimed.' },
    founders: [
      { name: 'Marcus Delgado', role: 'CEO & Co-founder', background: 'Former revenue-cycle director at a regional hospital system; built the first model on nights and weekends.' },
      { name: 'Fatima Nasser', role: 'CTO & Co-founder', background: 'Machine-learning engineer, previously at a healthcare claims-processing company.' },
    ],
    evidence: [
      { claim: 'Raised a $5.1M seed round to expand the denial-prediction product.', source: 'Demo funding brief (synthetic)', url: 'https://example.com/demo/meridianhealth/funding', date: isoDate(-110), type: 'News' },
      { claim: '"Our first regional physician group is now paying for the denial-prediction module."', source: 'Demo case study (synthetic)', url: 'https://example.com/demo/meridianhealth/case-study', date: isoDate(-14), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/meridianhealth',
    dateFirstSurfaced: isoDate(-115),
    lastRefreshed: isoDate(-6),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'funding-news', discoveredAtOffsetDays: -115, lastReviewedOffsetDays: -6 },
  },
  {
    id: 'demo-brightpath-genomics',
    name: 'Brightpath Genomics',
    oneLiner: 'Demo synthetic company — pharmacogenomic screening for primary-care prescribing.',
    vertical: 'health',
    subcategory: 'Genomics & personalized medicine',
    stage: 'Grant-funded',
    city: 'Durham',
    state: 'NC',
    foundedYear: 2023,
    teamSize: 14,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Priyanka Deshmukh', role: 'CEO & Co-founder', background: 'Genetic counselor; founded after seeing repeated adverse-drug-reaction cases that pharmacogenomic testing could have flagged.' },
    ],
    evidence: [
      { claim: 'Awarded a non-dilutive research grant to validate the screening panel in a primary-care setting.', source: 'Demo grants database (synthetic)', url: 'https://example.com/demo/grants/brightpath', date: isoDate(-200), type: 'Filing' },
    ],
    flags: [],
    website: 'https://example.com/demo/brightpath',
    dateFirstSurfaced: isoDate(-210),
    _demo: { reviewStatus: 'Research Needed', discoverySource: 'sec', discoveredAtOffsetDays: -210, lastReviewedOffsetDays: -35 },
  },
  {
    id: 'demo-tandem-ledger',
    name: 'Tandem Ledger',
    oneLiner: 'Demo synthetic company — embedded accounts-receivable automation for B2B marketplaces.',
    vertical: 'fintech',
    subcategory: 'New financial infrastructure',
    stage: 'Seed',
    city: 'Salt Lake City',
    state: 'UT',
    foundedYear: 2024,
    teamSize: 9,
    raising: '$4M seed',
    lastFundingDate: isoDate(-80),
    traction: { level: 3, note: 'Design partner — one B2B marketplace co-developing the integration, unpaid. Source: demo launch post (synthetic). Company-claimed.' },
    founders: [
      { name: 'Chloe Bergman', role: 'CEO & Co-founder', background: 'Ex-product manager at a payments infrastructure company for 4 years before founding.' },
      { name: 'Rafael Ortiz', role: 'CTO & Co-founder', background: 'Backend engineer, previously built ledger systems at a fintech infrastructure startup.' },
    ],
    evidence: [
      { claim: 'Raised a $4M seed round to build out the accounts-receivable automation product.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/tandemledger/funding', date: isoDate(-80), type: 'News' },
      { claim: '"We\'re co-developing the integration with our first design partner, a mid-size B2B marketplace."', source: 'Demo launch post (synthetic)', url: 'https://example.com/demo/tandemledger/launch', date: isoDate(-12), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/tandemledger',
    accelerator: 'Demo Accelerator W24 (synthetic)',
    dateFirstSurfaced: isoDate(-85),
    lastRefreshed: isoDate(-12),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'yc', discoveredAtOffsetDays: -85, lastReviewedOffsetDays: -12 },
  },
  {
    id: 'demo-clearcourse-capital',
    name: 'Clearcourse Capital Tools',
    oneLiner: 'Demo synthetic company — automated cash-sweep and treasury tooling for RIAs.',
    vertical: 'fintech',
    subcategory: 'Wealth planning',
    stage: 'Series A',
    city: 'Charlotte',
    state: 'NC',
    foundedYear: 2022,
    teamSize: 26,
    raising: '$16M Series A',
    lastFundingDate: isoDate(-240),
    traction: { level: 8, note: 'Recurring revenue — contracted subscription revenue from multiple RIA customers. Source: demo customer list (synthetic). Independently confirmed by a demo trade-press article.' },
    founders: [
      { name: 'Simone Achterberg', role: 'CEO & Co-founder', background: 'Former RIA operations lead; built the first treasury-automation prototype after years of manual cash-sweep work.' },
    ],
    evidence: [
      { claim: 'Closed a $16M Series A to expand the treasury-automation product.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/clearcourse/series-a', date: isoDate(-240), type: 'News' },
      { claim: 'Featured in a trade-press roundup of treasury-automation vendors serving independent advisors.', source: 'Demo trade newsletter (synthetic)', url: 'https://example.com/demo/news/clearcourse', date: isoDate(-30), type: 'News' },
    ],
    flags: [],
    website: 'https://example.com/demo/clearcourse',
    dateFirstSurfaced: isoDate(-500),
    lastRefreshed: isoDate(-10),
    _demo: { reviewStatus: 'Approved for HubSpot', discoverySource: 'investor-news', discoveredAtOffsetDays: -500, lastReviewedOffsetDays: -10 },
  },
  {
    id: 'demo-fieldshift-ops',
    name: 'Fieldshift Ops',
    oneLiner: 'Demo synthetic company — AI copilots for field-service dispatch and scheduling.',
    vertical: 'fow',
    subcategory: 'Human-AI collaboration',
    stage: 'Pre-seed',
    city: 'Kansas City',
    state: 'MO',
    foundedYear: 2026,
    teamSize: 4,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Nadia Okonkwo', role: 'Founder', background: 'Former field-service operations manager at a regional HVAC company; built the first prototype to solve her own scheduling problem.' },
    ],
    evidence: [
      { claim: '"We\'re launching a pilot with two regional field-service companies next month."', source: 'Demo founder statement (synthetic)', url: 'https://example.com/demo/fieldshift/post', date: isoDate(-4), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/fieldshift',
    dateFirstSurfaced: isoDate(-4),
    _demo: { reviewStatus: 'New', discoverySource: 'funding-news', discoveredAtOffsetDays: -4, lastReviewedOffsetDays: null },
  },
  {
    id: 'demo-loomwork-labs',
    name: 'Loomwork Labs',
    oneLiner: 'Demo synthetic company — autonomous-agent QA and testing for enterprise software teams.',
    vertical: 'fow',
    subcategory: 'Autonomous agents',
    stage: 'Seed',
    city: 'Raleigh',
    state: 'NC',
    foundedYear: 2024,
    teamSize: 12,
    raising: '$6.8M seed',
    lastFundingDate: isoDate(-95),
    traction: { level: 4, note: 'Pilot — one enterprise software team running an unpaid trial of the autonomous QA agent. Source: demo case study (synthetic). Company-claimed.' },
    founders: [
      { name: 'Teodor Vasilenko', role: 'CEO & Co-founder', background: 'Engineering lead at a large enterprise software company for 6 years before founding.' },
      { name: 'Amara Osei', role: 'CTO & Co-founder', background: 'Machine-learning researcher; published work on autonomous agent evaluation before founding.' },
    ],
    evidence: [
      { claim: 'Raised a $6.8M seed round to expand the autonomous QA agent product.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/loomwork/funding', date: isoDate(-95), type: 'News' },
    ],
    flags: [],
    website: 'https://example.com/demo/loomwork',
    accelerator: 'Demo Accelerator S24 (synthetic)',
    dateFirstSurfaced: isoDate(-100),
    lastRefreshed: isoDate(-22),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'yc', discoveredAtOffsetDays: -100, lastReviewedOffsetDays: -22 },
  },
  {
    id: 'demo-solheat-systems',
    name: 'Solheat Systems',
    oneLiner: 'Demo synthetic company — geothermal heat-pump retrofit financing and installation software.',
    vertical: 'sustainability',
    subcategory: 'Geothermal',
    stage: 'Seed',
    city: 'Minneapolis',
    state: 'MN',
    foundedYear: 2023,
    teamSize: 15,
    raising: '$7.2M seed',
    lastFundingDate: isoDate(-160),
    traction: { level: 7, note: 'Named customer — a regional utility program named as a customer of the installation-scheduling software. Source: demo customer announcement (synthetic). Independently confirmed by a demo trade-press mention.' },
    founders: [
      { name: 'Henrik Solberg', role: 'CEO & Co-founder', background: 'Former geothermal installation contractor; founded after years of manual scheduling and financing paperwork.' },
    ],
    evidence: [
      { claim: 'Named as the scheduling-software vendor for a regional utility\'s geothermal retrofit program.', source: 'Demo customer announcement (synthetic)', url: 'https://example.com/demo/solheat/customer', date: isoDate(-40), type: 'News' },
      { claim: 'Covered in a regional energy-trade roundup of geothermal retrofit vendors.', source: 'Demo trade newsletter (synthetic)', url: 'https://example.com/demo/news/solheat', date: isoDate(-35), type: 'News' },
    ],
    flags: [],
    website: 'https://example.com/demo/solheat',
    dateFirstSurfaced: isoDate(-170),
    lastRefreshed: isoDate(-7),
    _demo: { reviewStatus: 'Awaiting Review', discoverySource: 'funding-news', discoveredAtOffsetDays: -170, lastReviewedOffsetDays: -7 },
  },
  {
    id: 'demo-riverline-hydrogen',
    name: 'Riverline Hydrogen',
    oneLiner: 'Demo synthetic company — electrolyzer monitoring and optimization software for green-hydrogen plants.',
    vertical: 'sustainability',
    subcategory: 'Hydrogen',
    stage: 'Unknown',
    city: 'Houston',
    state: 'TX',
    foundedYear: 2025,
    teamSize: 7,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [
      { name: 'Camille Fontaine', role: 'Co-founder', background: 'Unknown — requires manual research' },
      { name: 'Adaeze Nnamdi', role: 'Co-founder', background: 'Unknown — requires manual research' },
    ],
    evidence: [
      { claim: 'Filed a Form D reporting an exempt securities offering.', source: 'Demo SEC EDGAR (synthetic)', url: 'https://example.com/demo/sec/riverline', date: isoDate(-9), type: 'Filing' },
    ],
    flags: [],
    website: 'https://example.com/demo/riverline',
    dateFirstSurfaced: isoDate(-9),
    _demo: { reviewStatus: 'New', discoverySource: 'sec', discoveredAtOffsetDays: -9, lastReviewedOffsetDays: null },
  },
  {
    id: 'demo-ironwing-aero',
    name: 'Ironwing Aerospace',
    oneLiner: 'Demo synthetic company — ground-segment software for small-satellite operators.',
    vertical: 'frontier',
    subcategory: 'Ground-segment & mission software',
    stage: 'Series A',
    city: 'Boulder',
    state: 'CO',
    foundedYear: 2022,
    teamSize: 28,
    raising: '$18M Series A',
    lastFundingDate: isoDate(-180),
    traction: { level: 9, note: 'Multiple deployments — several small-satellite operators running the ground-segment platform in production. Source: demo customer list (synthetic). Independently confirmed by a demo trade-press article.' },
    founders: [
      { name: 'Dmitri Volkov', role: 'CEO & Co-founder', background: 'Former mission operations engineer at a satellite operator; founded after seeing repeated ground-segment tooling gaps.' },
      { name: 'Yuki Tanaka', role: 'CTO & Co-founder', background: 'Aerospace software engineer, previously built flight-software tooling at a launch company.' },
    ],
    evidence: [
      { claim: 'Closed an $18M Series A to expand the ground-segment platform.', source: 'Demo funding announcement (synthetic)', url: 'https://example.com/demo/ironwing/series-a', date: isoDate(-180), type: 'News' },
      { claim: '"We now run mission operations for five small-satellite constellations in production."', source: 'Demo founder statement (synthetic)', url: 'https://example.com/demo/ironwing/launch', date: isoDate(-20), type: 'Founder statement' },
    ],
    flags: [],
    website: 'https://example.com/demo/ironwing',
    dateFirstSurfaced: isoDate(-380),
    lastRefreshed: isoDate(-11),
    _demo: { reviewStatus: 'Approved for HubSpot', discoverySource: 'investor-news', discoveredAtOffsetDays: -380, lastReviewedOffsetDays: -11 },
  },
  {
    id: 'demo-pathforge-surgical',
    name: 'Pathforge Surgical',
    oneLiner: 'Demo synthetic company — surgical-robotics simulation and training software.',
    vertical: 'frontier',
    subcategory: 'Robotics software & simulation',
    stage: 'Unknown',
    city: 'Cleveland',
    state: 'OH',
    foundedYear: 2025,
    teamSize: 6,
    traction: { level: 0, note: 'Unknown for scoring — analyst searched and found no publicly disclosed traction as of ' + isoDate(-16) + '. Absence of public evidence is not evidence of absence, so this is excluded from the score rather than counted as zero.' },
    founders: [
      { name: 'Sofia Marchetti', role: 'Founder', background: 'Surgical resident turned engineer; built the first simulation prototype during residency.' },
    ],
    evidence: [
      { claim: 'Demo day pitch describes a surgical-robotics training simulator for residency programs.', source: 'Demo accelerator directory (synthetic)', url: 'https://example.com/demo/accelerator/pathforge', date: isoDate(-16), type: 'Accelerator' },
    ],
    flags: [],
    website: 'https://example.com/demo/pathforge',
    accelerator: 'Demo Accelerator W26 (synthetic)',
    dateFirstSurfaced: isoDate(-16),
    _demo: { reviewStatus: 'Research Needed', discoverySource: 'yc', discoveredAtOffsetDays: -16, lastReviewedOffsetDays: -16 },
  },
];

// ── Enrichment (founder/vertical/stage resolution), keyed by company id ─

export function buildDemoEnrichment(): Record<string, CompanyEnrichment> {
  const out: Record<string, CompanyEnrichment> = {};
  for (const c of DEMO_COMPANIES) {
    const firstFounder = c.founders[0];
    const hasRealFounder = !!firstFounder && !/unknown/i.test(firstFounder.name);
    out[c.id] = {
      founder: {
        state: hasRealFounder ? 'confirmed' : 'research-exhausted',
        value: hasRealFounder ? { name: firstFounder.name, title: firstFounder.role } : null,
        inferred: false,
        confidence: hasRealFounder ? 0.9 : 0,
        summary: hasRealFounder
          ? `${firstFounder.name} is named as ${firstFounder.role} on the company's own materials (demo/synthetic source).`
          : 'Every applicable source family was checked (demo/synthetic) and no attributable founder name was found yet.',
        nextAction: hasRealFounder ? 'Re-check after the next scheduled research pass.' : 'Attempt research again, or record a manual finding.',
        evidence: hasRealFounder
          ? [{ url: c.website ?? 'https://example.com/demo', family: 'company-site', label: 'Company website (synthetic)', publishedAt: c.dateFirstSurfaced ?? null }]
          : [],
        sourcesAttempted: ['company-site', 'accelerator', 'founder-announcement'],
        lastResearchedAt: c.lastRefreshed ?? c.dateFirstSurfaced ?? null,
        conflicts: [],
        candidates: [],
        status: hasRealFounder ? 'verified-founder' : 'research-exhausted',
      },
      vertical: {
        state: 'confirmed',
        value: {
          primarySector: c.vertical,
          primaryLabel: c.vertical,
          secondarySector: null,
          subvertical: c.subcategory,
          countsTowardRanking: true,
          evidenceGap: null,
        },
        inferred: false,
        confidence: 0.85,
        summary: `Classified as ${c.subcategory} within the researched sector (demo/synthetic source).`,
        nextAction: 'Re-check after the next scheduled research pass.',
        evidence: [{ url: c.website ?? 'https://example.com/demo', family: 'company-site', label: 'Company website (synthetic)', publishedAt: c.dateFirstSurfaced ?? null }],
        sourcesAttempted: ['company-site'],
        lastResearchedAt: c.lastRefreshed ?? c.dateFirstSurfaced ?? null,
        conflicts: [],
      },
      stage: {
        state: c.stage === 'Unknown' ? 'research-exhausted' : 'confirmed',
        value: c.stage === 'Unknown' ? null : { stage: c.stage, label: c.stage },
        inferred: false,
        confidence: c.stage === 'Unknown' ? 0 : 0.8,
        summary: c.stage === 'Unknown'
          ? 'Every applicable source family was checked (demo/synthetic) and no source names a specific round.'
          : `${c.stage} is stated directly by a demo/synthetic source.`,
        nextAction: 'Re-check after the next scheduled research pass.',
        evidence: c.stage === 'Unknown' ? [] : [{ url: c.website ?? 'https://example.com/demo', family: 'funding-press', label: 'Demo funding brief (synthetic)', publishedAt: c.lastFundingDate ?? null }],
        sourcesAttempted: ['company-site', 'sec-form-d', 'funding-press'],
        lastResearchedAt: c.lastRefreshed ?? c.dateFirstSurfaced ?? null,
        conflicts: [],
      },
      corrections: [],
      attempts: [],
    };
  }
  return out;
}

// ── Pending evidence, keyed by company id — company-claimed + independently-confirmed examples ─

export function buildDemoPendingEvidence(): Record<string, PendingEvidenceItem[]> {
  let nextId = 1;
  return {
    'demo-solstice-robotics': [
      {
        id: nextId++, kind: 'traction',
        quote: 'We now run the palletizing module across three regional distribution centers.',
        sourceUrl: 'https://example.com/demo/solstice/launch', section: 'Launch post',
        aboutThisCompany: true, provenance: 'company-claimed',
        suggestedState: 'multiple-deployments', suggestionBasis: 'Company describes multiple live production deployments (demo/synthetic).',
        editedQuote: null, accessedAt: isoDate(-10), status: 'accepted', decidedBy: 'demo-analyst', decisionNote: 'Matches the independently confirmed trade-newsletter mention.',
      },
      {
        id: nextId++, kind: 'traction',
        quote: 'One of three warehouse-automation startups to watch this quarter, already running production pilots with regional logistics operators.',
        sourceUrl: 'https://example.com/demo/news/solstice', section: 'Trade newsletter',
        aboutThisCompany: true, provenance: 'independently-confirmed',
        suggestedState: 'multiple-deployments', suggestionBasis: 'Independent trade press corroborates the company-claimed deployment count (demo/synthetic).',
        editedQuote: null, accessedAt: isoDate(-8), status: 'pending', decidedBy: null, decisionNote: null,
      },
      {
        id: nextId++, kind: 'stage',
        quote: 'Graduated from a Winter 2025 accelerator cohort.',
        sourceUrl: 'https://example.com/demo/accelerator/solstice', section: 'Accelerator directory',
        aboutThisCompany: true, provenance: 'company-claimed',
        suggestedState: 'early-stage-round-not-disclosed', suggestionBasis: 'INFERENCE, not a stated round: accelerator participation is not a financing event (demo/synthetic).',
        editedQuote: null, accessedAt: isoDate(-120), status: 'pending', decidedBy: null, decisionNote: null,
      },
    ],
    'demo-copilot-forge': [
      {
        id: nextId++, kind: 'traction',
        quote: 'Our first enterprise customer is now paying for the limited rollout across two departments.',
        sourceUrl: 'https://example.com/demo/copilotforge/case-study', section: 'Customer case study',
        aboutThisCompany: true, provenance: 'company-claimed',
        suggestedState: 'paid-pilot', suggestionBasis: 'Company describes a customer paying for a limited rollout (demo/synthetic).',
        editedQuote: null, accessedAt: isoDate(-25), status: 'pending', decidedBy: null, decisionNote: null,
      },
      {
        id: nextId++, kind: 'traction',
        quote: 'Before Copilot Forge, our CTO led ML platform work reaching millions of internal users at a prior employer.',
        sourceUrl: 'https://example.com/demo/copilotforge/bio', section: 'Founder bio',
        aboutThisCompany: false, provenance: 'company-claimed',
        suggestedState: null, suggestionBasis: null,
        editedQuote: null, accessedAt: isoDate(-25), status: 'pending', decidedBy: null, decisionNote: null,
      },
    ],
  };
}

// ── Internal review notes (synthetic, no confidential content) ──────

export function buildDemoNotes(): Record<string, CompanyNote[]> {
  return {
    'demo-copilot-forge': [
      {
        id: 'demo-note-1', companyId: 'demo-copilot-forge',
        body: 'Demo note (synthetic): worth a second look once the paid-pilot expands past one customer.',
        createdAt: isoDate(-20), updatedAt: isoDate(-20), archived: false, archivedAt: null,
        reviewer: { id: 'demo-analyst', label: 'Demo Analyst', source: 'local-admin' },
      },
    ],
  };
}

// ── Discovery: candidate preview + run history (pre-populated, never a live run) ─

export const DEMO_DISCOVERY_CANDIDATES: DiscoveryCandidate[] = [
  {
    id: 'demo-cand-1', runId: 'demo-run-1', discoveredAt: isoDate(-2), sourceId: 'yc', simulated: false,
    externalId: 'demo-yc-001', companyName: 'Northlight Diagnostics', website: 'https://example.com/demo/northlight',
    pitch: 'Demo synthetic candidate — home-based sleep diagnostics for primary-care referrals.',
    vertical: 'health', subcategory: 'Personalized care (AI / tech-enabled)', stage: 'Pre-seed',
    hqCity: 'Denver', hqState: 'CO', foundingYear: 2026, founderNames: ['Demo Founder A'], founderCount: 1,
    accelerator: 'Demo Accelerator Su26 (synthetic)', publicFunding: 'Unknown', mostRecentRound: 'Unknown', fundingDate: null,
    tractionSignals: [], evidence: [
      { claim: 'Accelerator directory lists this company in its current cohort.', source: 'Demo accelerator directory (synthetic)', url: 'https://example.com/demo/accelerator/northlight', dateAccessed: isoDate(-2), publishedAt: isoDate(-2), verificationStatus: 'Verified', confidence: 0.8, notes: '', assertionType: 'fact' },
    ],
    confidence: 0.62, verificationStatus: 'Verified', duplicateStatus: 'none', duplicateOfId: null, duplicateOfName: null,
    policyExceptionFlags: [], suggestedNextStep: 'Add to review queue', status: 'pending',
    thesisEligible: true, thesisRejections: [], qualityPriority: 68, qualityBand: 'medium', qualitySignals: [], independentSources: 1,
  },
  {
    id: 'demo-cand-2', runId: 'demo-run-1', discoveredAt: isoDate(-2), sourceId: 'sec', simulated: false,
    externalId: 'demo-sec-002', companyName: 'Ferrovia Systems', website: 'https://example.com/demo/ferrovia',
    pitch: 'Demo synthetic candidate — predictive maintenance sensing for rail freight operators.',
    vertical: 'frontier', subcategory: 'Perception & control systems', stage: 'Unknown',
    hqCity: 'Pittsburgh', hqState: 'PA', foundingYear: 2025, founderNames: [], founderCount: null,
    accelerator: 'Unknown', publicFunding: '$1.8M reported', mostRecentRound: 'Unknown', fundingDate: isoDate(-15),
    tractionSignals: [], evidence: [
      { claim: 'Filed a Form D reporting an exempt securities offering of $1.8M.', source: 'Demo SEC EDGAR (synthetic)', url: 'https://example.com/demo/sec/ferrovia', dateAccessed: isoDate(-2), publishedAt: isoDate(-15), verificationStatus: 'Verified', confidence: 0.85, notes: '', assertionType: 'fact' },
    ],
    confidence: 0.55, verificationStatus: 'Verified', duplicateStatus: 'none', duplicateOfId: null, duplicateOfName: null,
    policyExceptionFlags: [], suggestedNextStep: 'Add to review queue', status: 'pending',
    thesisEligible: true, thesisRejections: [], qualityPriority: 54, qualityBand: 'medium', qualitySignals: [], independentSources: 1,
  },
];

export const DEMO_DISCOVERY_RUNS: DiscoveryRun[] = [
  {
    id: 'demo-run-1', at: iso(-2), completedAt: iso(-2), runType: 'manual', mode: 'live',
    query: {
      vertical: null, subcategory: null, areasOfInterest: [], terms: [], geography: 'United States', states: [],
      stages: ['Pre-seed', 'Seed', 'Series A'], sources: ['yc', 'sec'], dateFrom: null, dateTo: null,
      maxResults: 20, maxApiCalls: 10, maxModelCalls: 0, maxEstimatedTokens: 20000, minConfidence: 0,
      mode: 'new-only', minEvidenceRecencyDays: null, staleAfterDays: 30, preview: true, enforceThesisFilter: true,
      minQualityPriority: null,
    },
    sourceResults: [
      { sourceId: 'yc', mode: 'live', found: 1, detail: 'Demo/synthetic result — 1 candidate.', durationMs: 410 },
      { sourceId: 'sec', mode: 'live', found: 1, detail: 'Demo/synthetic result — 1 candidate.', durationMs: 380 },
    ],
    discovered: 2, updatedExisting: 0, duplicatesSkipped: 0, duplicatesIdentified: 0,
    filteredByPolicy: 0, filteredByThesis: 0, filteredByQuality: 0, preview: true,
    rejectedByValidation: 0, imported: 0, errors: [], apiCalls: 2, modelCalls: 0,
    estimatedTokens: 0, estimatedCostUsd: 0, durationMs: 900, status: 'Completed', initiatedBy: 'demo',
  },
];

// ── Stealth Founder Radar ────────────────────────────────────────────

export const DEMO_STEALTH_SIGNALS: StealthSignal[] = [];

export const DEMO_RADAR_ENTRIES: RadarEntry[] = [
  // ── Probable candidate — unconfirmed (no company name yet) ──────────
  {
    companyId: 'demo-stealth-1', companyName: '(Stealth — no company name on record)', website: null,
    city: 'Seattle', state: 'WA',
    stealthReason: 'Demo synthetic example — a former staff engineer at a large logistics company left recently and started a new GitHub organization focused on route-optimization tooling.',
    status: 'probable-founder-candidate', statusLabel: 'Probable candidate — unconfirmed',
    verifiedFounders: [],
    candidates: [
      {
        candidateId: 9001, personKey: 'demo founder b', fullName: 'Demo Founder B', title: 'Previously Staff Engineer, Logistics Co. (synthetic)',
        sourceUrl: 'https://example.com/demo/github/org-b', sourceFamily: 'company-site', sourceFamilyLabel: 'Company website',
        publishedAt: isoDate(-12), supportingText: 'New GitHub organization created with three early commits to a route-optimization library (demo/synthetic).',
        matchEvidence: ['New GitHub organization/repository', 'Public departure announcement'],
        matchScore: 6, confidence: 0.58, verified: false, reviewDecision: null, reviewedBy: null, reviewedAt: null,
      },
    ],
    conflicts: [],
    progress: { answered: 3, total: 5, families: [
      { family: 'company-site', label: 'Company website', outcome: 'source-not-applicable', detail: 'No company yet — pre-incorporation (demo/synthetic).' },
      { family: 'accelerator', label: 'Accelerator / incubator profile', outcome: 'reached-no-founder-stated', detail: 'No accelerator profile found (demo/synthetic).' },
    ] },
    lastCheckedAt: isoDate(-1), nextAction: 'Continue monitoring; consider a research pass once a company name appears.',
    relationships: [], financing: [],
    filingFacts: [],
  },

  // ── Verified founder — a filed company, confirmed identity, financing + relationships ──
  {
    companyId: 'demo-stealth-2', companyName: 'Northbeam Robotics (stealth, demo/synthetic)', website: 'https://example.com/demo/northbeam',
    city: 'Pittsburgh', state: 'PA',
    stealthReason: 'Demo synthetic example — an SEC Form D names a related person who also appears on the company\'s own (unlisted) leadership page.',
    status: 'verified-founder', statusLabel: 'Verified founder',
    verifiedFounders: [
      {
        candidateId: 9010, personKey: 'demo founder c', fullName: 'Demo Founder C', title: 'CEO & Co-founder (synthetic)',
        sourceUrl: 'https://example.com/demo/sec/northbeam', sourceFamily: 'sec-form-d', sourceFamilyLabel: 'SEC Form D',
        publishedAt: isoDate(-40), supportingText: 'Related person listed on a Form D reporting a $2.1M exempt offering (demo/synthetic).',
        matchEvidence: ['SEC Form D related-person record', 'Statement on the company\'s own domain'],
        matchScore: 10, confidence: 0.92, verified: true, reviewDecision: 'confirmed', reviewedBy: 'Demo Analyst', reviewedAt: isoDate(-38),
      },
    ],
    candidates: [],
    conflicts: [],
    progress: { answered: 5, total: 5, families: [
      { family: 'sec-form-d', label: 'SEC Form D', outcome: 'found-candidate', detail: 'Filing reached and read (demo/synthetic).' },
      { family: 'company-site', label: 'Company website', outcome: 'found-candidate', detail: 'Unlisted leadership page reached (demo/synthetic).' },
      { family: 'accelerator', label: 'Accelerator / incubator profile', outcome: 'reached-no-founder-stated', detail: 'No accelerator profile found (demo/synthetic).' },
    ] },
    lastCheckedAt: isoDate(-2), nextAction: 'Confirmed — proceed to standard research/outreach workflow like any other founder record.',
    relationships: [
      { relation: 'related person', to: 'Northbeam Robotics, Inc. (demo/synthetic)', toType: 'company', evidenceUrl: 'https://example.com/demo/sec/northbeam', sourceFamily: 'sec-form-d', confidence: 0.92 },
    ],
    financing: [
      { amountText: '$2.1M', roundType: 'Exempt offering (Form D)', investors: [], url: 'https://example.com/demo/sec/northbeam', publishedAt: isoDate(-40) },
    ],
    filingFacts: [
      { label: 'Filing type', value: 'Form D', url: 'https://example.com/demo/sec/northbeam' },
      { label: 'Offering amount', value: '$2.1M', url: 'https://example.com/demo/sec/northbeam' },
    ],
  },

  // ── Conflicting evidence — two sources disagree ─────────────────────
  {
    companyId: 'demo-stealth-3', companyName: '(Stealth — no company name on record)', website: null,
    city: 'Austin', state: 'TX',
    stealthReason: 'Demo synthetic example — a conference bio and a professional profile name different titles for the same person at the same unnamed project.',
    status: 'conflicting-founder-evidence', statusLabel: 'Conflicting evidence',
    verifiedFounders: [],
    candidates: [
      {
        candidateId: 9020, personKey: 'demo founder d', fullName: 'Demo Founder D', title: 'Founder (synthetic, per conference bio)',
        sourceUrl: 'https://example.com/demo/conference/founder-d', sourceFamily: 'public-profile', sourceFamilyLabel: 'Public speaker / award profile',
        publishedAt: isoDate(-20), supportingText: 'Conference program bio: "…is building a new company in the agtech space." (demo/synthetic)',
        matchEvidence: ['Public bio states building/founder/stealth'],
        matchScore: 5, confidence: 0.5, verified: false, reviewDecision: null, reviewedBy: null, reviewedAt: null,
      },
      {
        candidateId: 9021, personKey: 'demo founder d', fullName: 'Demo Founder D', title: 'Advisor (synthetic, per professional profile)',
        sourceUrl: 'https://example.com/demo/profile/founder-d', sourceFamily: 'professional-profile', sourceFamilyLabel: 'Public professional profile',
        publishedAt: isoDate(-10), supportingText: 'Public professional profile lists this person as an advisor, not a founder, to an unnamed early-stage project (demo/synthetic).',
        matchEvidence: ['Title stated in source'],
        matchScore: 5, confidence: 0.5, verified: false, reviewDecision: null, reviewedBy: null, reviewedAt: null,
      },
    ],
    conflicts: [
      { detail: 'Conference bio states "founder"; professional profile states "advisor" for the same unnamed project (demo/synthetic). Not resolved automatically.', sourceUrl: 'https://example.com/demo/profile/founder-d' },
    ],
    progress: { answered: 4, total: 5, families: [
      { family: 'public-profile', label: 'Public speaker / award profile', outcome: 'found-candidate', detail: 'Conference bio reached (demo/synthetic).' },
      { family: 'professional-profile', label: 'Public professional profile', outcome: 'found-candidate', detail: 'Profile reached (demo/synthetic).' },
    ] },
    lastCheckedAt: isoDate(-3), nextAction: 'Manual review required — the two sources disagree on this person\'s role and neither can settle it alone.',
    relationships: [], financing: [],
    filingFacts: [],
  },

  // ── Research exhausted — every applicable source checked, nothing public ──
  {
    companyId: 'demo-stealth-4', companyName: '(Stealth — no company name on record)', website: null,
    city: 'Denver', state: 'CO',
    stealthReason: 'Demo synthetic example — a government grant lists a principal investigator, but no other public source names a company or co-founders.',
    status: 'research-exhausted', statusLabel: 'Research completed — no attributable founder',
    verifiedFounders: [],
    candidates: [],
    conflicts: [],
    progress: { answered: 5, total: 5, families: [
      { family: 'company-site', label: 'Company website', outcome: 'source-not-applicable', detail: 'No company website on record (demo/synthetic).' },
      { family: 'accelerator', label: 'Accelerator / incubator profile', outcome: 'reached-no-founder-stated', detail: 'No accelerator profile found (demo/synthetic).' },
      { family: 'founder-announcement', label: 'Founder-authored announcement', outcome: 'reached-no-founder-stated', detail: 'No founder-authored post found (demo/synthetic).' },
      { family: 'public-profile', label: 'Public speaker / award profile', outcome: 'reached-no-founder-stated', detail: 'No conference or award profile found (demo/synthetic).' },
      { family: 'professional-profile', label: 'Public professional profile', outcome: 'reached-no-founder-stated', detail: 'No public professional profile found (demo/synthetic).' },
    ] },
    lastCheckedAt: isoDate(-5), nextAction: 'Research completed — this is a result, not a failure. Re-check after the grant\'s public reporting period ends.',
    relationships: [],
    financing: [
      { amountText: '$275,000', roundType: 'Government grant (non-dilutive)', investors: [], url: 'https://example.com/demo/grants/entry-4', publishedAt: isoDate(-60) },
    ],
    filingFacts: [
      { label: 'Award type', value: 'SBIR Phase I (demo/synthetic)', url: 'https://example.com/demo/grants/entry-4' },
    ],
  },

  // ── Manual review required — ambiguous signal, needs a human look ───
  {
    companyId: 'demo-stealth-5', companyName: '(Stealth — no company name on record)', website: null,
    city: 'Boston', state: 'MA',
    stealthReason: 'Demo synthetic example — a hiring announcement for "founding engineer" at an unnamed stealth company was posted by someone with relevant prior experience.',
    status: 'manual-review-required', statusLabel: 'Manual review required',
    verifiedFounders: [],
    candidates: [
      {
        candidateId: 9030, personKey: 'demo founder e', fullName: 'Demo Founder E', title: 'Posting a "founding engineer" role (synthetic)',
        sourceUrl: 'https://example.com/demo/hiring/founder-e', sourceFamily: 'founder-announcement', sourceFamilyLabel: 'Founder-authored announcement',
        publishedAt: isoDate(-6), supportingText: '"We\'re hiring our first founding engineer" — posted by this person, no company named (demo/synthetic).',
        matchEvidence: ['Hiring announcement', 'Public bio states building/founder/stealth'],
        matchScore: 5, confidence: 0.5, verified: false, reviewDecision: null, reviewedBy: null, reviewedAt: null,
      },
    ],
    conflicts: [],
    progress: { answered: 2, total: 5, families: [
      { family: 'founder-announcement', label: 'Founder-authored announcement', outcome: 'found-candidate', detail: 'Hiring post reached (demo/synthetic).' },
      { family: 'company-site', label: 'Company website', outcome: 'source-not-applicable', detail: 'No company name to check yet (demo/synthetic).' },
    ] },
    lastCheckedAt: isoDate(-1), nextAction: 'A person can review the hiring post and decide whether to reach out directly.',
    relationships: [], financing: [],
    filingFacts: [],
  },
];

// ── Notes exports for reference by demoApi.ts ────────────────────────
export type { CompanyMeta };
