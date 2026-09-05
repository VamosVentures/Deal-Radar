import { expect, type Page } from '@playwright/test';

/**
 * Move one company to a review status through the queue's bulk action.
 *
 * Review-status changes used to be per-company buttons inside the
 * company detail view. e9e3061 (13 Aug 2026, "Remove the Review status
 * panel from the company detail view") deleted that panel and replaced
 * it with select-a-row-then-bulk-action in the queue. The status
 * vocabulary did not change — see BULK_ACTIONS in
 * src/components/CompanyTable.tsx — so the specs still assert the same
 * outcomes, just through the interaction that now exists.
 *
 * Six specs kept clicking the deleted "Monitor" button and waiting the
 * full 30s timeout for it to appear. That is what held CI red from
 * 13 Aug onward: the application was correct and the tests were stale,
 * so every run failed identically regardless of the change under test.
 * Centralising the interaction here means the next redesign of it
 * breaks one function instead of six tests in two files.
 */
export async function bulkSetStatus(page: Page, companyName: string, status: string): Promise<void> {
  // The checkbox cell stops click propagation (CompanyTable.tsx), so
  // selecting a row never opens the detail view — selection and
  // inspection stay independent, and this helper leaves the detail
  // view in whatever state the caller found it.
  await page.getByRole('checkbox', { name: `Select ${companyName}` }).check();
  await expect(page.getByText(/\d+ selected/)).toBeVisible();

  // Staged, then confirmed. A bulk status change is deliberately never
  // one click away, so a test that only clicked "Bulk: X" would pass
  // while changing nothing.
  await page.getByRole('button', { name: `Bulk: ${status}` }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();

  // The result banner reports what the SERVER did with the ids it was
  // given, so asserting on it proves the write landed rather than that
  // a button was clickable.
  await expect(page.getByText(`Bulk "${status}"`)).toBeVisible();
  await expect(page.getByText(/1 updated/)).toBeVisible();
}
