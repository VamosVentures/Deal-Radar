import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../lib/store';
import { getDb, resetDbForTests } from '../db/client';
import { saveCompany } from '../db/repos/companies';
import {
  isYcProfileUrl, parseYcProfile, ycProfileMatchesCandidate, ycSlugFromUrl,
} from '../enrichment/ycProfile';
import { extractPeopleFromHtml } from '../enrichment/founderExtraction';
import { buildResearchPlan, splitKnownFirst } from '../enrichment/researchPlan';
import {
  decidePendingEvidence, listPendingEvidence, recordYcPendingEvidence,
} from '../services/pendingEvidence';
import { scoreCompany } from '../../src/lib/scoring';
import {
  GRADE, MANIFOLD, MANIFOLD_FREIGHT, SCHEDULING_WIZARD, UNIFOLD,
} from './fixtures/ycProfiles';
import type { ImportedCompany } from '../services/imports';
import type { Company } from '../../src/types';

/**
 * The public YC profile extractor.
 *
 * These fixtures reproduce the real page STRUCTURE — sibling name/role
 * divs with no punctuation, duplicated desktop/mobile blocks, a sidebar
 * card, a footer link that is not the company site. The previous mocks
 * did not, which is how a parser that returned zero founders for pages
 * listing ten of them passed a green suite.
 */

const url = (slug: string) => `https://www.ycombinator.com/companies/${slug}`;

describe('YC profile URL recognition', () => {
  it('recognises a company profile and extracts its slug', () => {
    expect(isYcProfileUrl(url('manifold-2'))).toBe(true);
    expect(ycSlugFromUrl(url('manifold-2'))).toBe('manifold-2');
    expect(isYcProfileUrl('https://ycombinator.com/companies/grade/')).toBe(true);
  });

  it('does not treat the directory or a search as a company profile', () => {
    expect(isYcProfileUrl('https://www.ycombinator.com/companies')).toBe(false);
    expect(isYcProfileUrl('https://www.ycombinator.com/companies?q=Manifold')).toBe(false);
    expect(isYcProfileUrl('https://example.com/companies/grade')).toBe(false);
  });
});

describe('the generic extractor cannot read this page — that was the bug', () => {
  it('extractPeopleFromHtml finds nobody on a YC-shaped page', () => {
    // Not a criticism of the generic extractor: it works on punctuation,
    // and YC uses DOM structure. This test exists so the REASON the
    // dedicated parser is needed stays visible and cannot be "simplified"
    // away by someone who assumes one extractor is enough.
    expect(extractPeopleFromHtml(SCHEDULING_WIZARD, 8)).toHaveLength(0);
  });

  it('the dedicated parser finds all three on the same bytes', () => {
    const p = parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!;
    expect(p.founders.map((f) => f.fullName)).toEqual(
      ['Samuel Oberly', 'Zachary Dermody', 'Abdelrahman Hamimi'],
    );
  });
});

describe('founder extraction', () => {
  const cases: [string, string, string[]][] = [
    ['Manifold', MANIFOLD, ['Joshua Ibrahim', 'Nicolas Yeh']],
    ['Grade', GRADE, ['Lotanna Ezeike', 'James Heaney']],
    ['Unifold', UNIFOLD, ['Timothy Chung', 'Hau Chu', 'Quang Huynh']],
    ['Scheduling Wizard', SCHEDULING_WIZARD, ['Samuel Oberly', 'Zachary Dermody', 'Abdelrahman Hamimi']],
  ];

  for (const [name, html, expected] of cases) {
    it(`extracts every founder of ${name}, exactly once`, () => {
      const p = parseYcProfile(html, url(p_slug(name)))!;
      expect(p.founders.map((f) => f.fullName)).toEqual(expected);
      // The page renders each founder twice; the parser must not.
      expect(new Set(p.founders.map((f) => f.fullName)).size).toBe(expected.length);
    });
  }

  function p_slug(name: string): string {
    return { Manifold: 'manifold-2', Grade: 'grade', Unifold: 'unifold', 'Scheduling Wizard': 'scheduling-wizard' }[name]!;
  }

  it('keeps distinct co-founders apart rather than collapsing them', () => {
    const p = parseYcProfile(UNIFOLD, url('unifold'))!;
    expect(p.founders).toHaveLength(3);
    expect(new Set(p.founders.map((f) => f.fullName)).size).toBe(3);
  });

  it('captures the role and the biography verbatim', () => {
    const p = parseYcProfile(GRADE, url('grade'))!;
    const lotanna = p.founders.find((f) => f.fullName === 'Lotanna Ezeike')!;
    expect(lotanna.role).toBe('CEO, Co-founder');
    expect(lotanna.bio).toMatch(/Barclays/);
    expect(lotanna.bio).toMatch(/\$10M\+ in contractor payouts/);
  });

  it('excludes a non-founder employee listed in the same section', () => {
    const p = parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!;
    expect(p.founders.map((f) => f.fullName)).not.toContain('Dana Example');
  });

  it('records that a LinkedIn profile exists without ever fetching it', () => {
    const p = parseYcProfile(MANIFOLD, url('manifold-2'))!;
    expect(p.founders[0].linkedInUrl).toMatch(/linkedin\.com\/in\//);
    // The parser is pure — it takes HTML in and returns data. There is no
    // fetch of any kind in it, so a linked profile can never be followed.
  });
});

describe('company facts from the sidebar card', () => {
  it('reads batch, status, location, team size, founded year and the OWN website', () => {
    const p = parseYcProfile(MANIFOLD, url('manifold-2'))!;
    expect(p.batch).toBe('Summer 2026');
    expect(p.status).toBe('Active');
    expect(p.location).toBe('Los Angeles, CA');
    expect(p.teamSize).toBe(2);
    expect(p.foundedYear).toBe(2026);
    expect(p.website).toBe('https://www.manifoldindustries.ai/');
  });

  it('does not mistake a footer link for the company website', () => {
    // Scanning the whole document for the first non-YC outbound link
    // returned a Google Plus URL from the footer for all four real pages.
    for (const html of [MANIFOLD, GRADE, UNIFOLD, SCHEDULING_WIZARD]) {
      const p = parseYcProfile(html, url('x'))!;
      expect(p.website).not.toMatch(/plus\.google/);
    }
  });
});

describe('identity matching — Manifold is not Manifold Freight', () => {
  it('both fixtures really are called "Manifold"', () => {
    expect(parseYcProfile(MANIFOLD, url('manifold-2'))!.name).toBe('Manifold');
    expect(parseYcProfile(MANIFOLD_FREIGHT, url('manifold'))!.name).toBe('Manifold');
  });

  it('matches the right one on DOMAIN', () => {
    const robotics = parseYcProfile(MANIFOLD, url('manifold-2'))!;
    expect(ycProfileMatchesCandidate(robotics, { website: 'https://www.manifoldindustries.ai/' }))
      .toEqual({ matches: true, basis: 'domain' });
    expect(ycProfileMatchesCandidate(robotics, { website: 'https://www.manifoldfreight.com' }))
      .toEqual({ matches: false, basis: 'none' });
  });

  it('matches on canonical slug when the website is unknown', () => {
    const robotics = parseYcProfile(MANIFOLD, url('manifold-2'))!;
    expect(ycProfileMatchesCandidate(robotics, { website: null, ycSlug: 'manifold-2' }).basis).toBe('slug');
    expect(ycProfileMatchesCandidate(robotics, { website: null, ycSlug: 'manifold' }).matches).toBe(false);
  });

  it('never matches on name alone', () => {
    const freight = parseYcProfile(MANIFOLD_FREIGHT, url('manifold'))!;
    // Same display name, different company: no website, no slug, no match.
    expect(ycProfileMatchesCandidate(freight, { website: null, ycSlug: null }).matches).toBe(false);
  });
});

describe('research plan: known URLs before guessed paths', () => {
  const plan = () => buildResearchPlan({
    id: 'x', name: 'Manifold', website: 'https://www.manifoldindustries.ai/',
    accelerator: 'Y Combinator', city: null, state: null,
    evidence: [{ claim: 'YC', source: 'Y Combinator', url: url('manifold-2'), date: '2026-08-01', type: 'Database record' }],
    dealEvidence: [],
  });

  it('puts the YC profile in the accelerator family', () => {
    const accel = plan().find((p) => p.family === 'accelerator')!;
    expect(accel.fetches.map((f) => f.url)).toContain(url('manifold-2'));
  });

  it('marks conventional team paths as guessed and real URLs as known', () => {
    const site = plan().find((p) => p.family === 'company-site')!;
    expect(site.fetches[0].guessed).toBe(false);                   // the home page
    expect(site.fetches.slice(1).every((f) => f.guessed)).toBe(true); // /about, /team, …
    const accel = plan().find((p) => p.family === 'accelerator')!;
    expect(accel.fetches.every((f) => !f.guessed)).toBe(true);
  });

  it('splitKnownFirst runs every known URL before any guessed path', () => {
    const { known, guessed } = splitKnownFirst(plan());
    const knownUrls = known.flatMap((p) => p.fetches.map((f) => f.url));
    const guessedUrls = guessed.flatMap((p) => p.fetches.map((f) => f.url));
    expect(knownUrls).toContain(url('manifold-2'));
    expect(knownUrls).toContain('https://manifoldindustries.ai');
    expect(guessedUrls.every((u) => /\/(about|team|about-us|our-team)$/.test(u))).toBe(true);
    // The accelerator profile is never stranded behind four 404s.
    expect(guessedUrls).not.toContain(url('manifold-2'));
  });
});

describe('traction claims become PENDING evidence, never a score', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  const company = (id: string): ImportedCompany => ({
    id, name: 'Fixture Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
    stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2026, teamSize: 3,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
  });

  it('queues Scheduling Wizard’s hospital and design-partner claims for review', () => {
    saveCompany(company('sw'), { origin: 'extracted', source: 'test' });
    const p = parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!;
    const res = recordYcPendingEvidence('sw', p, { accessedAt: '2026-08-06' });
    expect(res.inserted).toBeGreaterThan(0);

    const traction = listPendingEvidence('sw', 'traction');
    const text = traction.map((t) => t.quote).join(' ');
    expect(text).toMatch(/16 hospitals/);
    expect(text).toMatch(/design partners/);
    expect(traction.every((t) => t.status === 'pending')).toBe(true);
  });

  it('marks every YC-hosted claim company-claimed, never independently confirmed', () => {
    saveCompany(company('u'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('u', parseYcProfile(UNIFOLD, url('unifold'))!, { accessedAt: '2026-08-06' });
    const all = listPendingEvidence('u');
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((t) => t.provenance === 'company-claimed')).toBe(true);
  });

  it('captures Unifold’s integrations and design partners', () => {
    saveCompany(company('u2'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('u2', parseYcProfile(UNIFOLD, url('unifold'))!, { accessedAt: '2026-08-06' });
    const text = listPendingEvidence('u2', 'traction').map((t) => t.quote).join(' ');
    expect(text).toMatch(/integrations/i);
    expect(text).toMatch(/design partners/i);
  });

  it('captures Grade’s payment-volume growth claim', () => {
    saveCompany(company('g'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('g', parseYcProfile(GRADE, url('grade'))!, { accessedAt: '2026-08-06' });
    const text = listPendingEvidence('g', 'traction').map((t) => t.quote).join(' ');
    /**
     * Matched on the words the real page actually prints.
     *
     * This assertion used to look for the literal phrase "payment
     * volume", which the fixture supplied and the live page does not:
     * Grade states its volume as "companies used Grade to pay out $380k+
     * to creators, up 120% MoM". The fixture now mirrors the page, so the
     * expectation follows it. The claim being tested is unchanged —
     * payment volume and growth are captured — and it is now tested
     * against text the source really contains.
     */
    expect(text).toMatch(/\$380k\+/);
    expect(text).toMatch(/120% MoM/);
  });

  it('does NOT file Grade’s prior-company $10M as Grade traction', () => {
    saveCompany(company('g2'), { origin: 'extracted', source: 'test' });
    const p = parseYcProfile(GRADE, url('grade'))!;
    // The claim IS extracted from the bio...
    const bioClaims = p.tractionClaims.filter((c) => c.section === 'founder-bio');
    expect(bioClaims.some((c) => /\$10M\+/.test(c.quote))).toBe(true);
    expect(bioClaims.every((c) => c.aboutThisCompany === false)).toBe(true);
    /**
     * ...and it is queued FLAGGED, not deleted.
     *
     * This expectation was tightened deliberately. It used to assert the
     * quote was absent from the queue entirely, which passed for the
     * wrong reason: an analyst reading Grade's YC page sees "$10M+ in
     * contractor payouts" and, finding nothing about it in the app, has
     * to re-read the source to work out whether we missed it or judged
     * it. Silence is not an explanation.
     *
     * The invariant that actually protects the score is narrower and is
     * what is asserted now: the row exists, it is marked as NOT about
     * this company, and it carries NO suggested traction state — so it
     * can be read and cited but can never be one click from becoming
     * Grade's traction rating.
     */
    const res = recordYcPendingEvidence('g2', p, { accessedAt: '2026-08-06' });
    expect(res.notAboutCompany).toBeGreaterThan(0);
    const tenM = listPendingEvidence('g2', 'traction').find((t) => /\$10M\+/.test(t.quote));
    expect(tenM).toBeDefined();
    expect(tenM!.aboutThisCompany).toBe(false);
    expect(tenM!.suggestedState).toBeNull();
    expect(tenM!.section).toBe('founder-bio');
    expect(tenM!.suggestionBasis).toMatch(/not this company’s traction/i);
  });

  it('changes no score while a claim is pending', () => {
    saveCompany(company('sw2'), { origin: 'extracted', source: 'test' });
    const before = scoreCompany(company('sw2') as unknown as Company);
    recordYcPendingEvidence('sw2', parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!, { accessedAt: '2026-08-06' });
    const rows = (getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results WHERE company_id = ?').get('sw2') as { n: number }).n;
    expect(rows).toBe(0);
    const after = scoreCompany(company('sw2') as unknown as Company);
    expect(after.score).toBe(before.score);
    expect(after.components.find((x) => x.key === 'traction')!.assessable).toBe(false);
  });

  it('accept / edit / reject records a decision and still writes no score', () => {
    saveCompany(company('sw3'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('sw3', parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!, { accessedAt: '2026-08-06' });
    const first = listPendingEvidence('sw3', 'traction')[0];

    expect(decidePendingEvidence({ id: first.id, status: 'accepted', actor: 'team', note: 'Matches the launch post.' }).ok).toBe(true);
    const after = listPendingEvidence('sw3', 'traction').find((t) => t.id === first.id)!;
    expect(after.status).toBe('accepted');
    expect(after.decidedBy).toBe('team');
    // Accepting the CLAIM is not the same as rating the traction.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results WHERE company_id = ?').get('sw3') as { n: number }).n).toBe(0);

    /**
     * A recorded decision is NOT silently overwritable.
     *
     * This used to re-decide the SAME item accepted → rejected and assert
     * success, pinning last-write-wins on a table migration 19 describes
     * as "append-only in the same sense as traction_reviews". It was not:
     * the second call overwrote decided_by/decided_at/decision_note, so
     * the first reviewer's decision survived only in the audit log — a
     * 500-entry ring buffer that evicts older entries. "Review actions
     * must be auditable" cannot rest on a store that forgets.
     */
    const second = decidePendingEvidence({ id: first.id, status: 'rejected', actor: 'someone-else' });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already accepted/i);
    const unchanged = listPendingEvidence('sw3', 'traction').find((t) => t.id === first.id)!;
    expect(unchanged.status).toBe('accepted');
    expect(unchanged.decidedBy).toBe('team');

    // A DIFFERENT pending item can still be rejected normally.
    const other = listPendingEvidence('sw3', 'traction').find((t) => t.status === 'pending')!;
    expect(decidePendingEvidence({ id: other.id, status: 'rejected', actor: 'team' }).ok).toBe(true);
    expect(listPendingEvidence('sw3', 'traction').find((t) => t.id === other.id)!.status).toBe('rejected');

    // An "edited" decision must carry the corrected excerpt, and must
    // never overwrite the published quote.
    const third = listPendingEvidence('sw3', 'traction').find((t) => t.status === 'pending')!;
    expect(decidePendingEvidence({ id: third.id, status: 'edited', actor: 'team' }).ok).toBe(false);
    expect(decidePendingEvidence({
      id: third.id, status: 'edited', actor: 'team', editedQuote: '20 departments across 16 hospitals',
    }).ok).toBe(true);
    const edited = listPendingEvidence('sw3', 'traction').find((t) => t.id === third.id)!;
    expect(edited.status).toBe('edited');
    expect(edited.editedQuote).toBe('20 departments across 16 hospitals');
    expect(edited.quote).toBe(third.quote);

    // Still no score written by any of it.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM scoring_results WHERE company_id = ?').get('sw3') as { n: number }).n).toBe(0);
  });

  it('suggests a traction state without applying it', () => {
    saveCompany(company('sw4'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('sw4', parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!, { accessedAt: '2026-08-06' });
    const withSuggestion = listPendingEvidence('sw4', 'traction').filter((t) => t.suggestedState);
    expect(withSuggestion.length).toBeGreaterThan(0);
    for (const s of withSuggestion) expect(s.suggestionBasis).toBeTruthy();
    // The company's stored traction is untouched.
    const row = getDb().prepare('SELECT traction_level, traction_note FROM companies WHERE id = ?').get('sw4') as
      { traction_level: number; traction_note: string };
    expect(row.traction_level).toBe(0);
    expect(row.traction_note).toMatch(/^Unknown/);
  });
});

describe('stage: a YC batch is a fact, not a round', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  const company = (id: string): ImportedCompany => ({
    id, name: 'Stage Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
    stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2026, teamSize: 3,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
  });

  it('queues a stage SUGGESTION citing the batch, and applies nothing', () => {
    saveCompany(company('st'), { origin: 'extracted', source: 'test' });
    recordYcPendingEvidence('st', parseYcProfile(MANIFOLD, url('manifold-2'))!, { accessedAt: '2026-08-06' });

    const stage = listPendingEvidence('st', 'stage');
    expect(stage).toHaveLength(1);
    expect(stage[0].quote).toMatch(/Summer 2026/);
    expect(stage[0].suggestedState).toBe('Early-stage — round not publicly disclosed');
    expect(stage[0].suggestionBasis).toMatch(/INFERENCE/);
    expect(stage[0].suggestionBasis).toMatch(/not a financing event/);
    expect(stage[0].status).toBe('pending');

    // The company's stage is untouched, so the component stays a gap.
    const row = getDb().prepare('SELECT stage FROM companies WHERE id = ?').get('st') as { stage: string };
    expect(row.stage).toBe('Unknown');
    expect(scoreCompany(company('st') as unknown as Company).components.find((x) => x.key === 'stage')!.assessable).toBe(false);
  });

  it('does not award seed-stage points for YC participation', () => {
    // The rubric has no accelerator stage, and none was added. A company
    // whose only stage evidence is a batch stays Unknown, which is
    // excluded from the score rather than scored as Seed.
    const fit = scoreCompany(company('st2') as unknown as Company);
    const stage = fit.components.find((x) => x.key === 'stage')!;
    expect(stage.assessable).toBe(false);
    expect(stage.max).toBe(15);
  });
});

/**
 * Attribution and segmentation — the two ways a correctly-fetched page
 * still produced a false statement about a company.
 *
 * Both bugs were found by running the parser against the four real pages
 * rather than against these fixtures, so each fixture below was extended
 * to carry the structure that hid them: a claim stated in an
 * unpunctuated block element, and a prior-company beat inside a launch
 * post.
 */
describe('YC profile attribution', () => {
  beforeEach(() => {
    store.resetForTests();
    resetDbForTests();
  });

  const claims = (fixture: string, slug: string) =>
    parseYcProfile(fixture, url(slug))!.tractionClaims;

  const company = (id: string): ImportedCompany => ({
    id, name: 'Attribution Co', oneLiner: 'x', vertical: 'health', subcategory: 'Cancer',
    stage: 'Unknown', city: 'Unknown', state: '??', foundedYear: 2026, teamSize: 3,
    traction: { level: 0, note: 'Unknown — not yet researched' },
    founders: [{ name: 'Unknown founder', role: 'Unknown', background: 'Unknown' }],
    evidence: [{ claim: 'c', source: 's', url: 'https://example.com/1', date: '2026-08-01', type: 'Database record' }],
    flags: [], imported: true,
  });

  it('captures a money claim stated in an unpunctuated block element', () => {
    /**
     * The regression: `\b\$` can never match, because the character
     * before a currency amount in prose is a space and both are non-word
     * characters. Grade's only claim about its own commercial result
     * names a money amount and no other traction keyword, so it was
     * dropped entirely while thinner sentences survived.
     */
    const c = claims(GRADE, 'grade');
    const money = c.find((x) => /\$380k\+/.test(x.quote));
    expect(money).toBeDefined();
    expect(money!.aboutThisCompany).toBe(true);
    expect(money!.section).toBe('launch-post');
    expect(money!.quote).toMatch(/up 120% MoM/);
    // Bounded to its own block, not run together with the next heading.
    expect(money!.quote).not.toMatch(/Our ask/);
  });

  it('carries a prior-company narrative across a sentence break', () => {
    // "Before Grade, we built ... 4 mobile AI apps." then, still about
    // those apps, "Creators were our main growth channel, and they
    // helped us reach millions of users."
    const c = claims(GRADE, 'grade');
    const creators = c.find((x) => /millions of users/.test(x.quote));
    expect(creators).toBeDefined();
    expect(creators!.aboutThisCompany).toBe(false);
    expect(creators!.section).toBe('prior-company');
  });

  it('re-anchors on the company after the prior-company beat ends', () => {
    // Naming the company again ends the narrative, so later claims are
    // not swept up by an over-broad exclusion.
    const c = claims(GRADE, 'grade');
    expect(c.find((x) => /\$380k\+/.test(x.quote))!.aboutThisCompany).toBe(true);
    const unifold = claims(UNIFOLD, 'unifold');
    expect(unifold.find((x) => /single integration/.test(x.quote))?.aboutThisCompany).toBe(true);
  });

  it('does not credit Unifold with the acquirer’s 30M+ users', () => {
    const c = claims(UNIFOLD, 'unifold');
    const acquired = c.find((x) => /30M\+ users/.test(x.quote));
    expect(acquired).toBeDefined();
    expect(acquired!.aboutThisCompany).toBe(false);
    expect(acquired!.section).toBe('prior-company');
  });

  it('does not credit Scheduling Wizard with a founder’s work at GEICO', () => {
    const c = claims(SCHEDULING_WIZARD, 'scheduling-wizard');
    const geico = c.find((x) => /GEICO/.test(x.quote));
    expect(geico).toBeDefined();
    expect(geico!.aboutThisCompany).toBe(false);
    // ...while the company's OWN deployment claim is still captured.
    const hospitals = c.find((x) => /16 hospitals/.test(x.quote));
    expect(hospitals?.aboutThisCompany).toBe(true);
  });

  it('does not read a neighbouring company’s sentence as this company’s claim', () => {
    // "Similar Companies" cards follow the launch post. A fixed-length
    // slab from the launch heading runs straight into them.
    const c = claims(GRADE, 'grade');
    expect(c.some((x) => /Rival Co/.test(x.quote))).toBe(false);
    expect(c.some((x) => /400 paying customers/.test(x.quote))).toBe(false);
  });

  it('gives a not-about-this-company item no suggested traction state', () => {
    saveCompany(company('attr'), { origin: 'extracted', source: 'test' });
    const res = recordYcPendingEvidence('attr', parseYcProfile(UNIFOLD, url('unifold'))!, { accessedAt: '2026-08-06' });
    expect(res.notAboutCompany).toBeGreaterThan(0);
    for (const item of listPendingEvidence('attr', 'traction')) {
      if (item.aboutThisCompany) continue;
      expect(item.suggestedState).toBeNull();
      expect(item.suggestionBasis).toBeTruthy();
    }
  });

  it('re-recording the same profile inserts nothing new', () => {
    saveCompany(company('idem'), { origin: 'extracted', source: 'test' });
    const p = parseYcProfile(SCHEDULING_WIZARD, url('scheduling-wizard'))!;
    const first = recordYcPendingEvidence('idem', p, { accessedAt: '2026-08-06' });
    expect(first.inserted).toBeGreaterThan(0);
    const before = listPendingEvidence('idem').length;
    const second = recordYcPendingEvidence('idem', p, { accessedAt: '2026-08-07' });
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicate).toBe(first.inserted);
    expect(listPendingEvidence('idem').length).toBe(before);
  });
});
