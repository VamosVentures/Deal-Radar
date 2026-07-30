/**
 * Unsaved-note protection.
 *
 * A reviewer types a paragraph of investment reasoning into the notes
 * box, then clicks another company in the table — and the panel that
 * held the draft unmounts. There is no autosave (a half-written opinion
 * should not be persisted as if it were a finished one), so without a
 * guard the work is simply gone, with no error and nothing to recover.
 *
 * Two escapes have to be covered, and they need different mechanisms:
 *
 *   in-app     collapsing the detail row, or opening a different
 *              company — React navigation the browser knows nothing
 *              about, guarded by asking before proceeding
 *   browser    refresh, back, or closing the tab — only reachable via
 *              the `beforeunload` event, which cannot show custom text
 *
 * The check is registered by whichever notes panel is mounted. Only one
 * detail panel is ever open at a time, so a single slot is enough and a
 * registry would be pretending otherwise. `confirm()` is used rather
 * than a styled in-app dialog on purpose: it is the affordance users
 * already recognize for "you will lose work", it cannot be missed
 * mid-scroll the way an inline banner can, and it matches what the
 * browser itself shows on refresh.
 */

type DirtyCheck = () => boolean;

let dirtyCheck: DirtyCheck | null = null;

/**
 * Register (or, with null, clear) the check for the currently-open
 * notes panel. Always cleared on unmount — a stale check left behind by
 * a closed panel would block navigation forever.
 */
export function setUnsavedNotesCheck(check: DirtyCheck | null): void {
  dirtyCheck = check;
}

/** True when the open notes panel is holding text that has not been saved. */
export function hasUnsavedNotes(): boolean {
  return dirtyCheck !== null && dirtyCheck();
}

/**
 * Ask before abandoning a draft. Returns true when it is safe to
 * proceed — either nothing was unsaved, or the reviewer accepted losing
 * it. Callers navigate only on true.
 */
export function confirmLeaveUnsavedNotes(): boolean {
  if (!hasUnsavedNotes()) return true;
  return window.confirm(
    'This company has an unsaved internal note.\n\nLeaving now discards it. Continue?',
  );
}
