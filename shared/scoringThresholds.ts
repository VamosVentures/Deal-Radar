/**
 * Vamos Fit Score tier boundaries — the single source of truth. Previously
 * duplicated as a bare `8`/`6.5` literal in four separate files with no
 * shared constant, which meant a threshold change required finding every
 * copy and risked silent drift between them (e.g. the Executive Overview
 * "Hot" KPI disagreeing with the CompanyTable "Prioritize" badge).
 */
export const HOT_THRESHOLD = 8;
export const TRACK_THRESHOLD = 6.5;
