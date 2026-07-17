// SAMPLE DATA — fictional stealth-founder signals. In production these
// rows come from public-source monitoring only (LinkedIn updates the
// person made public, new incorporations, conference bios, GitHub
// activity, Form D filings). No scraping of private data, no automated
// outreach: every record requires human review before contact.
import type { StealthFounder } from '../types';

export const STEALTH_FOUNDERS: StealthFounder[] = [
  {
    id: 's-nvega',
    name: 'Natalia Vega',
    lastKnownRole: 'Director of Clinical Product, Included Health (departed May 2026)',
    likelyVertical: 'health',
    likelyFocus: "Women's health / personalized care",
    city: 'Oakland',
    state: 'CA',
    confidence: 'High',
    signals: [
      { signal: 'LinkedIn headline changed to "Building something new in women\'s health"', source: 'LinkedIn (public profile)', url: 'https://example.com/li-nvega', date: '2026-06-02' },
      { signal: 'Delaware C-corp "Vega Health Labs Inc." incorporated', source: 'DE Division of Corporations', url: 'https://example.com/de-vegahealth', date: '2026-06-11' },
      { signal: 'Speaking at HLTH 2026 as "Founder, stealth startup"', source: 'HLTH agenda', url: 'https://example.com/hlth-nvega', date: '2026-07-01' },
    ],
    identity: { latinoLed: true, femaleLed: true, basis: 'Self-identified', source: 'HLTH speaker bio, self-authored' },
  },
  {
    id: 's-jmorales',
    name: 'Javier Morales',
    lastKnownRole: 'Staff Engineer, Stripe Treasury (departed Apr 2026)',
    likelyVertical: 'fintech',
    likelyFocus: 'New financial infrastructure',
    city: 'Brooklyn',
    state: 'NY',
    confidence: 'Medium',
    signals: [
      { signal: 'Public GitHub activity on ledger-infrastructure prototype spiked', source: 'GitHub (public repos)', url: 'https://example.com/gh-jmorales', date: '2026-05-20' },
      { signal: 'Form D filed by "Ledgerline Inc." listing Morales as executive', source: 'SEC EDGAR', url: 'https://example.com/edgar-ledgerline', date: '2026-06-27' },
    ],
    identity: { latinoLed: true, basis: 'Verified public statement', source: 'Techqueria member spotlight, 2025 (self-authored)' },
  },
  {
    id: 's-kobi',
    name: 'Kayla Obi',
    lastKnownRole: 'Product Lead, Deel (departed Mar 2026)',
    likelyVertical: 'fow',
    likelyFocus: 'Frontline & essential-worker technology',
    city: 'Chicago',
    state: 'IL',
    confidence: 'Medium',
    signals: [
      { signal: 'Posted publicly about interviewing 60 home-care agencies', source: 'LinkedIn post (public)', url: 'https://example.com/li-kobi', date: '2026-06-18' },
      { signal: 'Registered domain + waitlist page "CrewNorth — coming soon"', source: 'Public site', url: 'https://example.com/crewnorth', date: '2026-07-05' },
    ],
    identity: { femaleLed: true, otherUnderrepresented: 'Black-led', basis: 'Self-identified', source: 'LinkedIn About section (self-authored)' },
  },
  {
    id: 's-rcastellanos',
    name: 'Rodrigo Castellanos',
    lastKnownRole: 'Principal Grid Engineer, PG&E (departed Jun 2026)',
    likelyVertical: 'sustainability',
    likelyFocus: 'Digital energy infrastructure',
    city: 'Sacramento',
    state: 'CA',
    confidence: 'Low',
    signals: [
      { signal: 'Attending Camp EnergyTech founder track', source: 'Public attendee list', url: 'https://example.com/camp-rc', date: '2026-06-30' },
    ],
  },
  {
    id: 's-mtorres',
    name: 'Dr. Marisol Torres',
    lastKnownRole: 'Oncology informatics faculty, MD Anderson (sabbatical announced)',
    likelyVertical: 'health',
    likelyFocus: 'Cancer',
    city: 'Houston',
    state: 'TX',
    confidence: 'High',
    signals: [
      { signal: 'University announcement of entrepreneurial sabbatical', source: 'MD Anderson newsroom', url: 'https://example.com/mda-torres', date: '2026-05-15' },
      { signal: '"Torres Oncology Systems LLC" registered in Texas', source: 'TX SOS filings', url: 'https://example.com/txsos-torres', date: '2026-06-08' },
      { signal: 'Job post for founding engineer (via personal site)', source: 'Personal site', url: 'https://example.com/torres-hiring', date: '2026-07-02' },
    ],
    identity: { latinoLed: true, femaleLed: true, basis: 'Verified public statement', source: 'MD Anderson faculty profile + AAMC interview (self-described)' },
  },
  {
    id: 's-dpham',
    name: 'Danny Pham',
    lastKnownRole: 'Applied AI Lead, Notion (departed May 2026)',
    likelyVertical: 'fow',
    likelyFocus: 'AI copilots',
    city: 'San Francisco',
    state: 'CA',
    confidence: 'Medium',
    signals: [
      { signal: 'Two ex-Notion engineers list "stealth co" with Pham on LinkedIn', source: 'LinkedIn (public profiles)', url: 'https://example.com/li-dpham', date: '2026-06-21' },
    ],
  },
  {
    id: 's-lreyes',
    name: 'Lorena Reyes',
    lastKnownRole: 'VP Lending, Self Financial (departed Feb 2026)',
    likelyVertical: 'fintech',
    likelyFocus: 'Access to capital',
    city: 'Austin',
    state: 'TX',
    confidence: 'High',
    signals: [
      { signal: 'Form D: "Puente Credit Inc." — $750k SAFE round', source: 'SEC EDGAR', url: 'https://example.com/edgar-puente', date: '2026-06-19' },
      { signal: 'Accepted to On Deck Founders ODF cohort', source: 'Public cohort page', url: 'https://example.com/odf-lreyes', date: '2026-05-01' },
    ],
    identity: { latinoLed: true, femaleLed: true, basis: 'Self-identified', source: 'On Deck founder profile (self-authored)' },
  },
  {
    id: 's-tnguyenmarks',
    name: 'Tara Nguyen-Marks',
    lastKnownRole: 'Sr. Director, Enphase software (departed Apr 2026)',
    likelyVertical: 'sustainability',
    likelyFocus: 'Energy & operations optimization',
    city: 'Portland',
    state: 'OR',
    confidence: 'Medium',
    signals: [
      { signal: 'Public talk: "What I\'m building next in distributed energy"', source: 'Meetup recording (public)', url: 'https://example.com/meetup-tnm', date: '2026-06-25' },
      { signal: 'Hiring a founding designer via public job board', source: 'Job board', url: 'https://example.com/job-tnm', date: '2026-07-08' },
    ],
    identity: { femaleLed: true, basis: 'Self-identified', source: 'Meetup speaker bio (self-authored)' },
  },
];
