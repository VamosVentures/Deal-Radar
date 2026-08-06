/**
 * Build-time demo flag.
 *
 * Enabled ONLY by setting VITE_DEMO_MODE=true at build time (Vite
 * inlines `import.meta.env.*` at build time, so a build without the
 * flag literally does not contain this branch's code path — see
 * `npm run build:demo`). A normal `npm run build` / `npm run dev`
 * always has this false and is completely unaffected.
 *
 * When true, src/lib/api.ts serves every request from bundled
 * synthetic fixtures (src/demo/*) instead of calling the real backend
 * — no fetch() to a real API, no real database, no real credentials,
 * and no external service is ever reached. See docs/sourcing-workflow/
 * DOCUMENT_ACCURACY_AUDIT.md and DEPLOYMENT_READINESS.md for the full
 * safety contract this flag is part of.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

export const DEMO_BANNER_TEXT = 'Demo — Synthetic Data — External actions disabled';

/** Standard message used by every disabled mutation in demo mode. */
export const DEMO_DISABLED_MESSAGE =
  'This is a read-only demo build with synthetic data. External actions (sourcing runs, HubSpot, Outlook, outreach, admin changes) are disabled here — see the banner at the top of the page.';
