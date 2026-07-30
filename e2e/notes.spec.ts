import { test, expect, type Page } from '@playwright/test';
import { NOTE_MAX_LENGTH } from '../shared/notes';
import { E2E_ADMIN_PASSWORD } from './env';

/**
 * Internal notes, from the reviewer's side of the screen.
 *
 * The server suite (server/tests/notes.test.ts) already proves storage,
 * authorization, validation, and persistence. What can only be checked
 * here is the part a reviewer actually touches: that saving is explicit,
 * that a note body reaches the DOM as text rather than as markup, that
 * archiving hides a note without destroying it, and that a half-written
 * opinion is not silently thrown away when the panel closes.
 *
 * Each test tags its note with a unique marker and asserts on that
 * marker rather than on how many notes exist, so the tests stay
 * independent while sharing one seeded database.
 */

const HEALTH = 'E2E Health Fixture Co';
const FINTECH = 'E2E FinTech Fixture Co';

async function openCompany(page: Page, name: string): Promise<void> {
  await page.goto('/companies');
  await page.getByText(name).click();
  await expect(page.getByTestId('company-notes')).toBeVisible();
}

/** The card holding a specific note, matched by its unique marker text. */
function cardWith(page: Page, marker: string) {
  return page.getByTestId('note-card').filter({ hasText: marker });
}
function archivedCardWith(page: Page, marker: string) {
  return page.getByTestId('note-card-archived').filter({ hasText: marker });
}

async function addNote(page: Page, body: string): Promise<void> {
  await page.getByTestId('note-draft').fill(body);
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('note-success')).toBeVisible();
}

test.describe('Internal company notes', () => {
  test('a company with no notes shows an honest empty state, not a blank panel', async ({ page }) => {
    await openCompany(page, FINTECH);
    await expect(page.getByRole('heading', { name: /Internal notes/ })).toBeVisible();
    await expect(page.getByTestId('notes-empty')).toBeVisible();
    await expect(page.getByTestId('notes-empty')).toContainText('No internal notes on this company yet');
    // The compose box is available immediately — an empty state is an
    // invitation, not a dead end.
    await expect(page.getByTestId('note-draft')).toBeVisible();
  });

  test('saving is explicit: the button stays disabled until there is something to save', async ({ page }) => {
    await openCompany(page, HEALTH);
    await expect(page.getByTestId('note-save')).toBeDisabled();

    // Whitespace is not content — the server refuses it and so does this.
    await page.getByTestId('note-draft').fill('    \n\n  ');
    await expect(page.getByTestId('note-save')).toBeDisabled();

    await page.getByTestId('note-draft').fill('Real content.');
    await expect(page.getByTestId('note-save')).toBeEnabled();
  });

  test('a note can be added and is listed with its author and timestamp', async ({ page }) => {
    const marker = 'MARKER-ADD-A note the reviewer wrote about the founders.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    const card = cardWith(page, marker);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('note-meta')).toContainText('Local administrator');
    await expect(card.getByTestId('note-meta')).toContainText('UTC');
    // A fresh note is not labelled as edited.
    await expect(card.getByTestId('note-meta')).not.toContainText('edited');
    // The draft box is cleared, so the next note starts empty.
    await expect(page.getByTestId('note-draft')).toHaveValue('');
  });

  test('the character counter tracks the draft and an oversized note cannot be saved', async ({ page }) => {
    await openCompany(page, HEALTH);
    await expect(page.getByTestId('note-counter')).toContainText(`0 / ${NOTE_MAX_LENGTH.toLocaleString()}`);

    await page.getByTestId('note-draft').fill('12345');
    await expect(page.getByTestId('note-counter')).toContainText(`5 / ${NOTE_MAX_LENGTH.toLocaleString()}`);

    await page.getByTestId('note-draft').fill('x'.repeat(NOTE_MAX_LENGTH + 1));
    await expect(page.getByTestId('note-too-long')).toBeVisible();
    await expect(page.getByTestId('note-save')).toBeDisabled();

    // Back under the limit and it becomes saveable again.
    await page.getByTestId('note-draft').fill('x'.repeat(NOTE_MAX_LENGTH));
    await expect(page.getByTestId('note-too-long')).toHaveCount(0);
    await expect(page.getByTestId('note-save')).toBeEnabled();
  });

  test('a note can be edited, and says so afterwards', async ({ page }) => {
    const marker = 'MARKER-EDIT-Initial read on this company.';
    const revised = 'MARKER-EDIT-Revised read after the founder call.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    await cardWith(page, marker).getByTestId('note-edit').click();
    // The existing body is loaded into the box for editing, not appended to.
    await expect(page.getByTestId('note-draft')).toHaveValue(marker);
    await expect(page.getByTestId('note-save')).toContainText('Save changes');

    await page.getByTestId('note-draft').fill(revised);
    await page.getByTestId('note-save').click();
    await expect(page.getByTestId('note-success')).toContainText('Note updated.');

    await expect(cardWith(page, revised)).toBeVisible();
    await expect(cardWith(page, revised).getByTestId('note-meta')).toContainText('edited');
    // Edited in place — the pre-edit version is not left behind as a second note.
    await expect(page.getByTestId('note-card').filter({ hasText: 'MARKER-EDIT-Initial read' })).toHaveCount(0);
  });

  test('cancelling an edit leaves the stored note alone', async ({ page }) => {
    const marker = 'MARKER-CANCEL-Do not change me.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    await cardWith(page, marker).getByTestId('note-edit').click();
    await page.getByTestId('note-draft').fill('MARKER-CANCEL-abandoned rewrite');
    await page.getByTestId('note-cancel-edit').click();

    await expect(page.getByTestId('note-draft')).toHaveValue('');
    await expect(cardWith(page, marker)).toBeVisible();
    await expect(page.getByTestId('note-card').filter({ hasText: 'abandoned rewrite' })).toHaveCount(0);
  });

  test('archiving hides a note without deleting it, and it can be restored', async ({ page }) => {
    const marker = 'MARKER-ARCHIVE-Pass for now, market too early.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    await cardWith(page, marker).getByTestId('note-archive').click();
    await expect(page.getByTestId('note-success')).toContainText('retained');

    // It is no longer in the working set, but it has NOT vanished: the
    // panel reveals archived notes rather than letting it disappear
    // without explanation.
    await expect(cardWith(page, marker)).toHaveCount(0);
    await expect(page.getByTestId('note-show-archived')).toBeChecked();
    await expect(archivedCardWith(page, marker)).toBeVisible();
    await expect(archivedCardWith(page, marker)).toContainText('Archived');

    // Hiding archived notes hides it; showing them brings it back.
    await page.getByTestId('note-show-archived').uncheck();
    await expect(archivedCardWith(page, marker)).toHaveCount(0);
    await page.getByTestId('note-show-archived').check();
    await expect(archivedCardWith(page, marker)).toBeVisible();

    // Archiving is not a revision, so the card must not claim it was edited.
    await expect(archivedCardWith(page, marker).getByTestId('note-meta')).not.toContainText('edited');

    await archivedCardWith(page, marker).getByTestId('note-restore').click();
    await expect(page.getByTestId('note-success')).toContainText('Note restored.');
    await expect(cardWith(page, marker)).toBeVisible();
    await expect(archivedCardWith(page, marker)).toHaveCount(0);
    await expect(cardWith(page, marker).getByTestId('note-meta')).not.toContainText('edited');
  });

  test('an archived note offers restore, and no way to delete it', async ({ page }) => {
    const marker = 'MARKER-NODELETE-Retained forever.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);
    await cardWith(page, marker).getByTestId('note-archive').click();
    await expect(archivedCardWith(page, marker)).toBeVisible();

    await expect(archivedCardWith(page, marker).getByTestId('note-restore')).toBeVisible();
    // There is no delete affordance anywhere in the notes panel.
    await expect(page.getByTestId('company-notes').getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(page.getByTestId('company-notes').getByRole('button', { name: /remove/i })).toHaveCount(0);
  });

  test('a note body reaches the page as plain text — no markup, no Markdown, no script', async ({ page }) => {
    const marker = 'MARKER-XSS-<script>window.__noteXssRan = true</script> **bold** <b>b</b> <img src=x onerror="window.__noteXssRan = true">';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    const card = cardWith(page, marker);
    await expect(card).toBeVisible();

    // 1. The characters are shown literally, exactly as typed.
    await expect(card.getByTestId('note-body')).toHaveText(marker);

    // 2. Nothing executed, and no element was created from the text.
    expect(await page.evaluate(() => (window as unknown as { __noteXssRan?: boolean }).__noteXssRan)).toBeUndefined();
    const injected = await card.getByTestId('note-body').evaluate((el) => ({
      scripts: el.querySelectorAll('script').length,
      images: el.querySelectorAll('img').length,
      bold: el.querySelectorAll('b, strong').length,
      // The body is one text node, not parsed markup.
      childElements: el.children.length,
    }));
    expect(injected).toEqual({ scripts: 0, images: 0, bold: 0, childElements: 0 });
  });

  test('a multi-line note keeps its paragraph breaks without becoming markup', async ({ page }) => {
    const marker = 'MARKER-LINES-First line.';
    await openCompany(page, HEALTH);
    await addNote(page, `${marker}\n\nSecond paragraph.`);

    const body = cardWith(page, marker).getByTestId('note-body');
    await expect(body).toHaveText(`${marker}\n\nSecond paragraph.`);
    // Line breaks are preserved by CSS, not by injected <br> elements.
    expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    expect(await body.evaluate((el) => el.querySelectorAll('br').length)).toBe(0);
  });

  test('notes survive a page reload', async ({ page }) => {
    const marker = 'MARKER-RELOAD-This must still be here after F5.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);
    await expect(cardWith(page, marker)).toBeVisible();

    await page.reload();
    await page.getByText(HEALTH).click();
    await expect(cardWith(page, marker)).toBeVisible();
    await expect(cardWith(page, marker).getByTestId('note-meta')).toContainText('Local administrator');
  });

  test('notes survive signing out and signing back in', async ({ page }) => {
    const marker = 'MARKER-LOGOUT-Written before signing out.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    await page.request.post('/api/auth/logout', { data: {} });
    await page.goto('/companies');
    // Really signed out: the whole-application gate is showing, and no
    // company content (let alone a note) is behind it.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(marker)).toHaveCount(0);

    await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.goto('/companies');
    await page.getByText(HEALTH).click();
    await expect(cardWith(page, marker)).toBeVisible();
  });

  test('an unsaved draft warns before the panel is closed, and survives declining', async ({ page }) => {
    const draft = 'MARKER-UNSAVED-Half-written thought that must not vanish.';
    await openCompany(page, HEALTH);
    await page.getByTestId('note-draft').fill(draft);

    // Decline the warning: the panel stays open with the draft intact.
    let seen = '';
    const decline = (d: import('@playwright/test').Dialog) => { seen = d.message(); void d.dismiss(); };
    page.on('dialog', decline);
    await page.getByText(HEALTH).first().click();
    await expect.poll(() => seen).toContain('unsaved internal note');
    await expect(page.getByTestId('note-draft')).toHaveValue(draft);
    page.off('dialog', decline);

    // Accept it: the panel closes and the draft is deliberately gone.
    page.on('dialog', (d) => void d.accept());
    await page.getByText(HEALTH).first().click();
    await expect(page.getByTestId('company-notes')).toHaveCount(0);
  });

  test('an unsaved draft warns before switching to a different company', async ({ page }) => {
    const draft = 'MARKER-SWITCH-Draft that should block navigation.';
    await openCompany(page, HEALTH);
    await page.getByTestId('note-draft').fill(draft);

    let seen = '';
    const decline = (d: import('@playwright/test').Dialog) => { seen = d.message(); void d.dismiss(); };
    page.on('dialog', decline);
    await page.getByText(FINTECH).click();
    await expect.poll(() => seen).toContain('unsaved internal note');
    // Still on the original company, draft untouched.
    await expect(page.getByTestId('note-draft')).toHaveValue(draft);
    page.off('dialog', decline);

    page.on('dialog', (d) => void d.accept());
    await page.getByText(FINTECH).click();
    // The other company's panel is open, with its own empty draft box.
    await expect(page.getByTestId('note-draft')).toHaveValue('');
  });

  test('a saved note does not trigger the unsaved-work warning', async ({ page }) => {
    const marker = 'MARKER-CLEAN-Saved, so closing is free.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);

    let dialogs = 0;
    page.on('dialog', (d) => { dialogs += 1; void d.dismiss(); });
    await page.getByText(HEALTH).first().click();
    await expect(page.getByTestId('company-notes')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test('a failed save reports the failure and keeps the reviewer\'s text', async ({ page }) => {
    const draft = 'MARKER-FAIL-Words that must not be lost to a 500.';
    await openCompany(page, HEALTH);

    await page.route('**/api/companies/*/notes', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 500, json: { error: 'error', message: 'Something went wrong. This has been logged.' } });
    });

    await page.getByTestId('note-draft').fill(draft);
    await page.getByTestId('note-save').click();

    await expect(page.getByTestId('note-error')).toBeVisible();
    await expect(page.getByTestId('note-success')).toHaveCount(0);
    // The one thing here that cannot be regenerated is still on screen.
    await expect(page.getByTestId('note-draft')).toHaveValue(draft);
    await expect(page.getByTestId('note-card').filter({ hasText: 'MARKER-FAIL' })).toHaveCount(0);

    await page.unroute('**/api/companies/*/notes');
    // Retrying the same draft now works, with nothing retyped.
    page.on('dialog', (d) => void d.accept());
    await page.getByTestId('note-save').click();
    await expect(page.getByTestId('note-success')).toBeVisible();
  });

  test('a failed load reports the failure instead of an empty notes list', async ({ page }) => {
    await page.route('**/api/companies/*/notes?*', (route) =>
      route.fulfill({ status: 503, json: { error: 'error', message: 'The notes service is unavailable.' } }));

    await page.goto('/companies');
    await page.getByText(HEALTH).click();
    await expect(page.getByTestId('notes-load-error')).toBeVisible();
    // Critically NOT the empty state — "no notes" and "could not load
    // the notes" must never look the same to a reviewer.
    await expect(page.getByTestId('notes-empty')).toHaveCount(0);
  });

  test('the internal notes section is reachable from the memo table of contents', async ({ page }) => {
    await openCompany(page, HEALTH);
    await expect(page.getByRole('link', { name: 'Internal notes' })).toBeVisible();
    await page.getByRole('link', { name: 'Internal notes' }).click();
    await expect(page.getByTestId('note-draft')).toBeVisible();
  });

  /**
   * A full pass through the feature with the console watched.
   *
   * Asserted here rather than checked by hand once, so "no console
   * errors" is a property the suite re-proves on every run instead of a
   * claim someone made about one browser session. React surfaces most of
   * its own correctness complaints this way — a missing key, a state
   * update on an unmounted component, a failed prop type — and every one
   * of those is a real defect in a panel that mounts and unmounts as
   * rows expand.
   */
  test('a full add/edit/archive/restore pass logs nothing to the console', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

    const marker = 'MARKER-CONSOLE-A clean pass through every note action.';
    await openCompany(page, HEALTH);
    await addNote(page, marker);
    await cardWith(page, marker).getByTestId('note-edit').click();
    await page.getByTestId('note-draft').fill(`${marker} Edited.`);
    await page.getByTestId('note-save').click();
    await expect(page.getByTestId('note-success')).toBeVisible();
    await cardWith(page, `${marker} Edited.`).getByTestId('note-archive').click();
    await expect(archivedCardWith(page, marker)).toBeVisible();
    await archivedCardWith(page, marker).getByTestId('note-restore').click();
    await expect(cardWith(page, `${marker} Edited.`)).toBeVisible();

    // Vite's dev-server HMR chatter is the environment, not this feature.
    const unexplained = problems.filter((p) => !/\[vite\]|React DevTools/i.test(p));
    expect(unexplained, `unexplained console output:\n${unexplained.join('\n')}`).toEqual([]);
  });
});
