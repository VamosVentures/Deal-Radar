/**
 * Sanitized, minimal fixtures shaped like a real public YC company
 * profile.
 *
 * These reproduce the STRUCTURE that broke the old extractor, because a
 * mock that did not was how the failure survived a green test suite:
 *
 *  - name and role in sibling divs with NO punctuation between them
 *    (`text-xl font-bold` then `text-gray-600`) — the exact shape the
 *    generic name-then-title pattern cannot see;
 *  - every founder block emitted TWICE, desktop (`hidden gap-4 md:flex`)
 *    and mobile (`md:hidden`), identical content;
 *  - a `Label: Value` sidebar card carrying batch, status, location,
 *    team size, founded year and the company's own website;
 *  - a footer link that is NOT the company's site, so "first outbound
 *    link" remains a wrong answer;
 *  - a Company Launches section with traction sentences;
 *  - a non-founder employee in the same section;
 *  - two companies sharing the name "Manifold" with different domains.
 *
 * Content is paraphrased and shortened. Names are the real, publicly
 * listed founders, because the acceptance criterion is that the parser
 * finds them.
 */

interface FounderSeed { name: string; role: string; bio: string; li: string }

/** One founder, rendered the way YC does: desktop block + mobile duplicate. */
function founderBlock(f: FounderSeed): string {
  const inner = `
      <div class="min-w-0 flex-1">
        <div class="flex flex-row items-center gap-x-2">
          <div class="text-xl font-bold">${f.name}</div>
          <div class="flex gap-x-1 flex">
            <a class="white flex h-6 w-6" href="${f.li}"><div class="inline-block h-4 w-4 bg-image-linkedin"></div></a>
          </div>
        </div>
        <div class="text-gray-600">${f.role}</div>
        <div class="prose max-w-none">
          <div class="prose max-w-full whitespace-pre-line">${f.bio}</div>
        </div>
      </div>`;
  return `
  <div class="flex flex-col gap-2 border-b border-gray-100 last:border-b-0">
    <div class="w-full">
      <div class="ycdc-card-new w-full space-y-1.5 w-full">
        <div class="hidden gap-4 md:flex">
          <div class="aspect-square h-20"><img src="https://bookface-images.s3.example/avatar.jpg?X-Amz-Signature=deadbeef" /></div>
          ${inner}
        </div>
        <div class="group space-y-3 md:hidden">
          <div class="flex gap-4">
            <div class="aspect-square h-16"><img src="https://bookface-images.s3.example/avatar.jpg?X-Amz-Signature=deadbeef" /></div>
            ${inner}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

export interface YcFixtureSeed {
  slug: string;
  name: string;
  website: string;
  batch: string;
  location: string;
  teamSize: number;
  founded: number;
  status?: string;
  description: string;
  founders: FounderSeed[];
  /** Non-founder staff listed in the same region — must NOT be extracted. */
  staff?: { name: string; role: string }[];
  /**
   * Raw markup for the launch post, so a fixture can reproduce the
   * BLOCK structure a real one has: headings and list items with no
   * terminal punctuation. A plain sentence-per-line string cannot
   * exercise that, which is how a claim stated in an unpunctuated
   * `<p>` stayed invisible to the extractor through a green suite.
   */
  launch?: string;
  /**
   * Other companies' one-liners rendered AFTER the launch post, exactly
   * where YC puts them. A launch post read as a fixed-length slab runs
   * into these, and a neighbouring company's sentence then gets filed as
   * this company's claim.
   */
  similarCompanies?: string[];
}

export function ycProfileFixture(seed: YcFixtureSeed): string {
  return `<!doctype html><html><head><title>${seed.name} | Y Combinator</title></head><body>
<nav><a href="https://www.ycombinator.com/companies">Companies</a></nav>

<div class="prose max-w-full">${seed.description}</div>

<div class="relative isolate z-0"><div class="mx-auto max-w-ycdc-page px-4">
  <div class="my-4 text-2xl font-bold text-[#333333] md:mt-0">Active Founders</div>
  <div class="max-w-[800px]"><div class="flex flex-col gap-y-4">
    ${seed.founders.map(founderBlock).join('\n')}
    ${(seed.staff ?? []).map((p) => `
    <div class="ycdc-card-new w-full">
      <div class="min-w-0 flex-1">
        <div class="text-xl font-bold">${p.name}</div>
        <div class="text-gray-600">${p.role}</div>
      </div>
    </div>`).join('\n')}
  </div></div>
</div></div>

${seed.launch ? `
<div class="my-4 text-2xl font-bold">Company Launches</div>
<div class="prose max-w-full">${seed.launch}</div>
` : ''}

${seed.similarCompanies && seed.similarCompanies.length > 0 ? `
<div class="my-4 text-2xl font-bold">Similar Companies</div>
<div class="flex flex-col gap-4">
  ${seed.similarCompanies.map((s) => `<div class="ycdc-card-new"><div class="prose">${s}</div></div>`).join('\n')}
</div>
` : ''}

<div class="ycdc-card-new space-y-1.5 w-full min-w-[300px]">
  <div class="space-y-1"><div class="text-xl font-medium">
    <a class="hover:text-linkColor" href="/companies/${seed.slug}">${seed.name}</a>
  </div></div>
  <div class="space-y-2 pt-4">
    <div class="flex flex-row justify-between"><span>Founded:</span><span>${seed.founded}</span></div>
    <div class="flex flex-row justify-between"><span>Batch:</span><span class="whitespace-nowrap">${seed.batch}</span></div>
    <div class="flex flex-row justify-between"><span>Team Size:</span><span>${seed.teamSize}</span></div>
    <div class="flex flex-row justify-between"><span>Status:</span><span class="flex items-center"><div class="mr-[6px] h-2 w-2 bg-green-500"></div>${seed.status ?? 'Active'}</span></div>
    <div class="flex flex-row justify-between"><span>Location:</span><span>${seed.location}</span></div>
    <div class="flex flex-row justify-between"><span>Primary Partner:</span>
      <a class="text-linkColor" href="https://www.ycombinator.com/people/example-partner">Example Partner</a></div>
  </div>
  <div class="flex flex-wrap items-center gap-3 pt-2">
    <a class="flex h-9 w-9" href="${seed.website}"><span>site</span></a>
    <a class="flex h-9 w-9" href="https://www.linkedin.com/company/${seed.slug}/"><span>li</span></a>
    <a class="flex h-9 w-9" href="https://x.com/${seed.slug}"><span>x</span></a>
  </div>
</div>

<footer><a href="https://plus.google.com/113116812547402050884">Google Plus</a></footer>
</body></html>`;
}

// ── The four acceptance companies ────────────────────────────────

export const MANIFOLD = ycProfileFixture({
  slug: 'manifold-2', name: 'Manifold', website: 'https://www.manifoldindustries.ai/',
  batch: 'Summer 2026', location: 'Los Angeles, CA', teamSize: 2, founded: 2026,
  description: 'Low-cost, deployment-ready robotic labor for warehouses.',
  founders: [
    { name: 'Joshua Ibrahim', role: 'Founder', li: 'https://www.linkedin.com/in/joshibrahim/',
      bio: 'Founder at Manifold. PhD in Applied Mathematics from Caltech. Previously Software Engineering Intern at Facebook.' },
    { name: 'Nicolas Yeh', role: 'Founder', li: 'https://www.linkedin.com/in/nicolasyeh/',
      bio: 'Founder at Manifold. Grew up in a 3rd-gen supply chain family business.' },
  ],
});

/** Same NAME, different company and domain. Must never be conflated. */
export const MANIFOLD_FREIGHT = ycProfileFixture({
  slug: 'manifold', name: 'Manifold', website: 'https://www.manifoldfreight.com',
  batch: 'Winter 2021', location: 'Seattle, WA', teamSize: 12, founded: 2020,
  description: 'Freight brokerage software.',
  founders: [
    { name: 'Other Person', role: 'Founder', li: 'https://www.linkedin.com/in/other-person/',
      bio: 'Founder at Manifold Freight. Previously in logistics.' },
  ],
});

export const GRADE = ycProfileFixture({
  slug: 'grade', name: 'Grade', website: 'https://usegrade.com',
  batch: 'Winter 2026', location: 'San Francisco', teamSize: 2, founded: 2025,
  description: 'Grade is the API for performance-based payroll.',
  founders: [
    { name: 'Lotanna Ezeike', role: 'CEO, Co-founder', li: 'https://www.linkedin.com/in/lotanna/',
      bio: '2x VC-backed founder. Previously product lead at Barclays. At my last company, I managed $10M+ in contractor payouts.' },
    { name: 'James Heaney', role: 'Founder, CTO', li: 'https://www.linkedin.com/in/jamesheaney/',
      bio: '2x exited founder and now the CTO of Grade. Previously built and exited a cryptography startup for over $5M.' },
  ],
  /**
   * Shaped like the real post, including the two things that broke:
   *
   *  - the Traction figure lives in a `<p>` with NO terminal punctuation,
   *    between two headings. This is the whole claim Grade makes about
   *    its own commercial result, and it names a MONEY amount and no
   *    other traction keyword — so it exercises both the block-boundary
   *    segmentation and the currency branch of TRACTION_SENTENCE.
   *  - an "Our Unique Insight" beat that opens with "Before Grade" and
   *    then keeps describing the PRIOR apps in the following sentence
   *    without naming them again. The prior-company narrative has to
   *    carry forward across that sentence break, or "millions of users"
   *    is credited to Grade.
   */
  launch: `
    <h3>The Problem ❌</h3>
    <ul><li>The rules live in spreadsheets</li><li>Payouts are slow and mistakes happen</li></ul>
    <h3>Our Unique Insight 💡</h3>
    <p>Before Grade, we built, scaled, and exited 4 mobile AI apps. Creators were our main growth channel, and they helped us reach millions of users.</p>
    <h3>The Solution ✅</h3>
    <p>Grade makes performance pay run like real payroll, starting with creators.</p>
    <h3>Traction 📊</h3>
    <p>In the last 30 days, companies used Grade to pay out $380k+ to creators, up 120% MoM</p>
    <h3>Our ask 📣</h3>
    <p>If your company is paying creators at scale, we would love to talk.</p>`,
  similarCompanies: ['Rival Co processes $50M in payment volume for 400 paying customers.'],
});

export const UNIFOLD = ycProfileFixture({
  slug: 'unifold', name: 'Unifold', website: 'https://unifold.io',
  batch: 'Winter 2026', location: 'New York City, NY', teamSize: 3, founded: 2026,
  description: 'Multi-chain deposit and payment infrastructure.',
  founders: [
    { name: 'Timothy Chung', role: 'Founder', li: 'https://www.linkedin.com/in/timothychung/',
      bio: 'Co-founder of Unifold (W26). Previously co-founded Streambird, a wallet as a service company, acquired in 2024.' },
    { name: 'Hau Chu', role: 'Founder/Chief Engineer', li: 'https://www.linkedin.com/in/hauchu/',
      bio: 'Graduated from Cornell Tech. Previously at MoonPay building deposit infrastructure.' },
    { name: 'Quang Huynh', role: 'Founder', li: 'https://www.linkedin.com/in/quanghuynh/',
      bio: 'A full-stack engineer with 15+ years across fintech. Previously at Polymarket.' },
  ],
  /**
   * The "Our Story" beat credits a company the founders SOLD. "we helped
   * onboard 30M+ users" is the acquirer's number, and reading it as
   * Unifold's is the single most inflating misattribution available on
   * this page — Unifold is a three-person W26 company.
   */
  launch: `
    <h3>TL;DR</h3>
    <p>We have shipped integrations with several partners and are live with design partners today.</p>
    <h3>Our Story</h3>
    <p>Before Unifold, we built wallet-as-a-service infrastructure and were acquired by a leading crypto payments company, where we helped onboard 30M+ users.</p>
    <h3>What we are building</h3>
    <p>Unifold gives developers a single integration that handles deposits end-to-end.</p>`,
});

export const SCHEDULING_WIZARD = ycProfileFixture({
  slug: 'scheduling-wizard', name: 'Scheduling Wizard', website: 'https://www.schedulingwiz.com',
  batch: 'Winter 2026', location: 'Washington, DC', teamSize: 3, founded: 2024,
  description: 'Logistics infrastructure to modernize healthcare operations.',
  founders: [
    { name: 'Samuel Oberly', role: 'Founder', li: 'https://www.linkedin.com/in/samueloberly/',
      bio: 'Johns Hopkins and Cambridge trained Mathematician. Award-winning published mathematician with a civilian service medal for logistics algorithms.' },
    { name: 'Zachary Dermody', role: 'Founder', li: 'https://www.linkedin.com/in/zacharydermody/',
      bio: 'Co-Founder and COO of Scheduling Wizard. Logistics management experience at Amazon and McMaster-Carr.' },
    { name: 'Abdelrahman Hamimi', role: 'Founder', li: 'https://www.linkedin.com/in/abdelrahmanhamimi/',
      bio: 'Co-Founder and CTO. MS and BS in computer science and a BA in Economics from Johns Hopkins.' },
  ],
  staff: [{ name: 'Dana Example', role: 'Head of Sales' }],
  /**
   * "The Team" paragraph describes a founder's work at a PREVIOUS
   * employer, and phrases it with the same "across multiple departments"
   * language the company uses for its own deployments. Read as a company
   * claim it inflates deployment breadth; it is a fact about GEICO.
   */
  launch: `
    <h3>Our Beginning</h3>
    <p>We support 20 departments across 16 hospitals. We have named active contracts and are onboarding new design partners.</p>
    <p>Our clients now review schedules we build.</p>
    <h3>The Team</h3>
    <p>Our CTO, Abdelrahman Hamimi, built internal automation software at GEICO used internally across multiple departments.</p>`,
});
