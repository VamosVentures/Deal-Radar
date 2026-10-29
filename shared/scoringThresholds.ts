/**
 * VamosVentures Fit Score tier boundaries — the single source of truth. Previously
 * duplicated as a bare `8`/`6.5` literal in four separate files with no
 * shared constant, which meant a threshold change required finding every
 * copy and risked silent drift between them (e.g. the Executive Overview
 * "Hot" KPI disagreeing with the CompanyTable "Prioritize" badge).
 */
export const HOT_THRESHOLD = 8;
export const TRACK_THRESHOLD = 6.5;

/**
 * High-Fit: a Fit Score at or above HOT_THRESHOLD — nothing else.
 *
 * Until 2026-10-28 a provisional score (missing critical information,
 * low completeness, or too few cited sources) was excluded. In practice
 * every company was provisional, so High-Fit read 0 and thin-but-promising
 * leads from emails and CSVs could never surface. Andrew's call: missing
 * information must not keep a company out of High-Fit. The `provisional`
 * flag still exists and is still shown on each score; it just no longer
 * gates this. Every High-Fit check (Overview KPI cards, Overview ranking
 * filter) goes through here so they cannot disagree.
 */
export function isHighFit(score: number): boolean {
  return score >= HOT_THRESHOLD;
}
