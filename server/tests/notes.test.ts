import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../app';
import { store } from '../lib/store';
import { resetIdempotencyForTests } from '../lib/guard';
import { getDb, resetDbForTests } from '../db/client';
import { adminAgent } from './testAuth';
import { saveCompany } from '../db/repos/companies';
import { listNotes } from '../db/repos/notes';
import { listReviewDecisions } from '../db/repos/operations';
import { quarantine } from '../services/issuerQualification';
import { LOCAL_ADMIN_REVIEWER } from '../lib/reviewer';
import { NOTE_MAX_LENGTH, normalizeNoteBody } from '../../shared/notes';
import { buildCsv, EXPORT_COLUMNS, toCsvRow } from '../../src/lib/csvExport';
import { scoreCompany } from '../../src/lib/scoring';
import type { ImportedCompany } from '../services/imports';
import type { Company } from '../../src/types';

/**
 * Internal company review notes.
 *
 * The properties these tests exist to hold, in the order they would hurt
 * if they broke:
 *
 *   1. A note survives. Not "the request returned 200" — read back from
 *      a genuinely separate process against the same database file, and
 *      through a backup/restore cycle.
 *   2. Nothing is ever deleted. Archive is reversible and there is no
 *      route that removes a row.
 *   3. Authorship comes from the session, not the caller. A client that
 *      names its own author is writing fiction.
 *   4. A body is stored and returned as PLAIN TEXT, byte-for-byte —
 *      never escaped, never interpreted, never stripped.
 *   5. Note bodies never reach the CSV export or the bulk company
 *      payload the export is built from.
 */

const CSV_HEADER =
  'name,oneLiner,vertical,subcategory,stage,city,state,foundedYear,teamSize,tractionLevel,tractionNote,founderName,founderRole,founderBackground,evidenceClaim,evidenceSource,evidenceUrl,evidenceDate,evidenceType,website';

function fixtureCompany(over: Partial<ImportedCompany> = {}): ImportedCompany {
  return {
    id: 'note-co',
    name: 'Note Fixture Inc',
    oneLiner: 'A company a reviewer has opinions about.',
    vertical: 'fintech',
    subcategory: 'Payments',
    stage: 'Seed',
    city: 'Austin',
    state: 'TX',
    foundedYear: 2025,
    teamSize: 6,
    website: 'https://notefixture.example.com',
    traction: { level: 4, note: 'Two pilots.' },
    founders: [{ name: 'Ana Fixture', role: 'CEO', background: 'Payments engineer.' }],
    evidence: [{ claim: 'Seed round', source: 'Fixture News', url: 'https://example.com/note-co', date: '2026-06-01', type: 'News' }],
    flags: [],
    imported: true,
    ...over,
  };
}

/** Create a company and return its id. */
function seedCompany(over: Partial<ImportedCompany> = {}): string {
  const record = fixtureCompany(over);
  saveCompany(record, { origin: 'user-entered', source: 'notes-test' });
  return record.id;
}

beforeEach(() => {
  store.resetForTests();
  resetIdempotencyForTests();
  resetDbForTests();
});

// ── Schema ───────────────────────────────────────────────────────

describe('company_notes schema', () => {
  it('is a separate table, not a column on companies', () => {
    const db = getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name);
    expect(tables).toContain('company_notes');

    // No review-note text was bolted onto companies as one big column.
    // `traction_note` predates this feature and is a one-line sourced
    // fact about traction, not a reviewer's opinion — so the assertion
    // names what must not exist rather than banning the word "note".
    const companyColumns = (db.prepare('PRAGMA table_info(companies)').all() as { name: string }[]).map((c) => c.name);
    for (const forbidden of ['notes', 'note', 'internal_notes', 'internal_note', 'review_notes', 'review_note']) {
      expect(companyColumns, `companies.${forbidden} must not exist`).not.toContain(forbidden);
    }
  });

  it('records the migration at version 10 and carries every required field', () => {
    const db = getDb();
    const applied = (db.prepare('SELECT version, name FROM migrations').all() as { version: number; name: string }[])
      .find((m) => m.version === 10);
    expect(applied?.name).toBe('internal-company-review-notes');

    const columns = (db.prepare('PRAGMA table_info(company_notes)').all() as { name: string; notnull: number }[]);
    const byName = new Map(columns.map((c) => [c.name, c]));
    for (const required of [
      'id', 'company_id', 'body', 'created_at', 'updated_at', 'archived', 'archived_at',
      'reviewer_id', 'reviewer_label', 'reviewer_source',
    ]) {
      expect(byName.has(required), `company_notes.${required} is missing`).toBe(true);
    }
  });

  it('cascades with its company rather than orphaning rows', () => {
    const id = seedCompany();
    const db = getDb();
    db.prepare(`INSERT INTO company_notes (id, company_id, body, created_at, updated_at, archived, reviewer_id, reviewer_label, reviewer_source)
      VALUES ('n-cascade', ?, 'body', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', 0, 'local-admin', 'Local administrator', 'local-admin')`).run(id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM company_notes').get()).toEqual({ n: 0 });
  });
});

// ── Authentication and authorization ─────────────────────────────

describe('authentication', () => {
  const ROUTES: { method: 'get' | 'post' | 'patch'; path: (id: string) => string; body?: unknown }[] = [
    { method: 'get', path: (id) => `/api/companies/${id}/notes` },
    { method: 'post', path: (id) => `/api/companies/${id}/notes`, body: { body: 'A note.' } },
    { method: 'patch', path: (id) => `/api/companies/${id}/notes/some-note`, body: { body: 'Edited.' } },
    { method: 'post', path: (id) => `/api/companies/${id}/notes/some-note/archive` },
    { method: 'post', path: (id) => `/api/companies/${id}/notes/some-note/restore` },
  ];

  it('refuses every notes route without a session', async () => {
    const app = createApp();
    const id = seedCompany();
    for (const route of ROUTES) {
      const res = await request(app)[route.method](route.path(id)).send(route.body ?? {});
      expect(res.status, `${route.method.toUpperCase()} ${route.path(id)}`).toBe(401);
      expect(res.body.error).toBe('auth_failed');
    }
  });

  it('never leaks a note body to an unauthenticated caller', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const secret = 'CONFIDENTIAL: the CFO is the real risk here.';
    await agent.post(`/api/companies/${id}/notes`).send({ body: secret }).expect(201);

    const anon = await request(app).get(`/api/companies/${id}/notes`);
    expect(anon.status).toBe(401);
    expect(JSON.stringify(anon.body)).not.toContain('CFO');
  });

  it('accepts every notes route with a session', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = await agent.post(`/api/companies/${id}/notes`).send({ body: 'A first note.' });
    expect(created.status).toBe(201);
    const noteId = created.body.note.id;

    expect((await agent.get(`/api/companies/${id}/notes`)).status).toBe(200);
    expect((await agent.patch(`/api/companies/${id}/notes/${noteId}`).send({ body: 'Edited note.' })).status).toBe(200);
    expect((await agent.post(`/api/companies/${id}/notes/${noteId}/archive`)).status).toBe(200);
    expect((await agent.post(`/api/companies/${id}/notes/${noteId}/restore`)).status).toBe(200);
  });
});

// ── Reviewer identity ────────────────────────────────────────────

describe('reviewer identity', () => {
  it('attributes a note to the session, ignoring any author the caller supplies', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const res = await agent.post(`/api/companies/${id}/notes`).send({
      body: 'Attribution test.',
      // A caller trying to sign someone else's name to an opinion.
      reviewer: { id: 'someone-else', label: 'Managing Partner', source: 'microsoft-sso' },
      reviewerId: 'someone-else',
      actor: 'someone-else',
    });
    expect(res.status).toBe(201);
    expect(res.body.note.reviewer).toEqual(LOCAL_ADMIN_REVIEWER);

    const stored = getDb().prepare('SELECT reviewer_id, reviewer_label, reviewer_source FROM company_notes WHERE id = ?')
      .get(res.body.note.id);
    expect(stored).toEqual({
      reviewer_id: 'local-admin',
      reviewer_label: 'Local administrator',
      reviewer_source: 'local-admin',
    });
  });

  it('stores the identity provider separately, so a shared local admin stays distinguishable from a future SSO user', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: 'Written under the shared password.' }).expect(201);

    // A row as a Microsoft-SSO build would write it, alongside the local one.
    getDb().prepare(`INSERT INTO company_notes (id, company_id, body, created_at, updated_at, archived, reviewer_id, reviewer_label, reviewer_source)
      VALUES ('n-sso', ?, 'Written under SSO.', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z', 0, '8f14e45f-ea6d-4c1f-9a2b-000000000000', 'Dana Partner', 'microsoft-sso')`).run(id);

    const notes = listNotes(id);
    expect(notes.map((n) => n.reviewer.source).sort()).toEqual(['local-admin', 'microsoft-sso']);
    const sso = notes.find((n) => n.reviewer.source === 'microsoft-sso')!;
    expect(sso.reviewer.id).toBe('8f14e45f-ea6d-4c1f-9a2b-000000000000');
    expect(sso.reviewer.label).toBe('Dana Partner');
  });
});

// ── Create, edit, archive, restore ───────────────────────────────

describe('note lifecycle', () => {
  it('creates a note with both timestamps equal and nothing archived', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const res = await agent.post(`/api/companies/${id}/notes`).send({ body: 'Strong founder-market fit.' }).expect(201);
    const note = res.body.note;
    expect(note.body).toBe('Strong founder-market fit.');
    expect(note.companyId).toBe(id);
    expect(note.id).toMatch(/^[0-9a-f]{8}-/); // a real unique id, not a row counter
    expect(note.createdAt).toBe(note.updatedAt);
    expect(note.archived).toBe(false);
    expect(note.archivedAt).toBeNull();
  });

  it('gives each note its own id', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const a = await agent.post(`/api/companies/${id}/notes`).send({ body: 'First.' }).expect(201);
    const b = await agent.post(`/api/companies/${id}/notes`).send({ body: 'Second.' }).expect(201);
    expect(a.body.note.id).not.toBe(b.body.note.id);
    expect(listNotes(id)).toHaveLength(2);
  });

  it('an edit changes the body and updated_at, but never created_at or the author', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Initial read.' }).expect(201)).body.note;

    const edited = (await agent.patch(`/api/companies/${id}/notes/${created.id}`)
      .send({ body: 'Revised read after the founder call.' }).expect(200)).body.note;

    expect(edited.id).toBe(created.id);
    expect(edited.body).toBe('Revised read after the founder call.');
    expect(edited.createdAt).toBe(created.createdAt);
    expect(edited.updatedAt >= created.updatedAt).toBe(true);
    expect(edited.reviewer).toEqual(created.reviewer);
    expect(listNotes(id)).toHaveLength(1); // edited in place, not appended
  });

  it('archives without deleting, and restores', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Pass — market too early.' }).expect(201)).body.note;

    const archived = (await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200)).body.note;
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.body).toBe('Pass — market too early.'); // body retained

    // The row is still there — archiving is a state change, not a delete.
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM company_notes').get()).toEqual({ n: 1 });
    expect(listNotes(id)).toHaveLength(0);                          // hidden by default
    expect(listNotes(id, { includeArchived: true })).toHaveLength(1); // still readable

    const restored = (await agent.post(`/api/companies/${id}/notes/${created.id}/restore`).expect(200)).body.note;
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeNull();
    expect(restored.createdAt).toBe(created.createdAt);
    expect(listNotes(id)).toHaveLength(1);
  });

  it('archiving is not an edit — updated_at does not move and the note is not labelled edited', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Never revised.' }).expect(201)).body.note;

    const archived = (await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200)).body.note;
    // The UI reads "edited" off updatedAt !== createdAt. Archiving must
    // not make an untouched note claim it was revised.
    expect(archived.updatedAt).toBe(created.updatedAt);
    expect(archived.updatedAt).toBe(archived.createdAt);
    expect(archived.archivedAt).not.toBeNull();

    const restored = (await agent.post(`/api/companies/${id}/notes/${created.id}/restore`).expect(200)).body.note;
    expect(restored.updatedAt).toBe(created.updatedAt);
    expect(restored.updatedAt).toBe(restored.createdAt);

    // A genuine edit still moves it.
    const edited = (await agent.patch(`/api/companies/${id}/notes/${created.id}`).send({ body: 'Now revised.' }).expect(200)).body.note;
    expect(edited.updatedAt).not.toBe(edited.createdAt);
  });

  it('archive and restore are idempotent', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Idempotency.' }).expect(201)).body.note;

    const first = (await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200)).body.note;
    const second = (await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200)).body.note;
    // A repeat archive must not rewrite WHEN it was archived.
    expect(second.archivedAt).toBe(first.archivedAt);

    await agent.post(`/api/companies/${id}/notes/${created.id}/restore`).expect(200);
    const restoredTwice = (await agent.post(`/api/companies/${id}/notes/${created.id}/restore`).expect(200)).body.note;
    expect(restoredTwice.archived).toBe(false);
  });

  it('exposes no route that permanently deletes a note', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Undeletable.' }).expect(201)).body.note;

    for (const p of [`/api/companies/${id}/notes/${created.id}`, `/api/companies/${id}/notes`]) {
      const res = await agent.delete(p);
      expect([404, 405], `DELETE ${p} should not be a working route`).toContain(res.status);
    }
    expect(listNotes(id, { includeArchived: true })).toHaveLength(1);
  });

  it('returns notes newest first, with archived ones after being asked for', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const first = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Oldest.' }).expect(201)).body.note;
    await agent.post(`/api/companies/${id}/notes`).send({ body: 'Newest.' }).expect(201);
    await agent.post(`/api/companies/${id}/notes/${first.id}/archive`).expect(200);

    const visible = (await agent.get(`/api/companies/${id}/notes`).expect(200)).body.notes;
    expect(visible.map((n: { body: string }) => n.body)).toEqual(['Newest.']);

    const all = (await agent.get(`/api/companies/${id}/notes?includeArchived=true`).expect(200)).body.notes;
    expect(all).toHaveLength(2);
    expect(all.find((n: { body: string }) => n.body === 'Oldest.').archived).toBe(true);
  });
});

// ── Invalid company and cross-company isolation ──────────────────

describe('invalid targets', () => {
  it('rejects every route for a company that does not exist', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const missing = 'no-such-company';
    // Awaited one at a time rather than collected into an array of
    // in-flight promises: supertest binds an ephemeral listener per
    // request, and firing five at once against one agent races on it.
    const responses = [
      await agent.get(`/api/companies/${missing}/notes`),
      await agent.post(`/api/companies/${missing}/notes`).send({ body: 'Orphan note.' }),
      await agent.patch(`/api/companies/${missing}/notes/whatever`).send({ body: 'Orphan edit.' }),
      await agent.post(`/api/companies/${missing}/notes/whatever/archive`),
      await agent.post(`/api/companies/${missing}/notes/whatever/restore`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Company not found.');
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM company_notes').get()).toEqual({ n: 0 });
  });

  it('reports an unknown company BEFORE complaining about the note text', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    // Both things are wrong; the caller needs to hear about the id.
    const res = await agent.post('/api/companies/no-such-company/notes').send({ body: '   ' });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Company not found.');
  });

  it('will not reach one company\'s note through another company\'s URL', async () => {
    const app = createApp();
    const a = seedCompany({ id: 'company-a', name: 'Company A' });
    const b = seedCompany({ id: 'company-b', name: 'Company B' });
    const agent = await adminAgent(app);
    const note = (await agent.post(`/api/companies/${a}/notes`).send({ body: 'Belongs to A.' }).expect(201)).body.note;

    for (const res of [
      await agent.patch(`/api/companies/${b}/notes/${note.id}`).send({ body: 'Hijacked.' }),
      await agent.post(`/api/companies/${b}/notes/${note.id}/archive`),
      await agent.post(`/api/companies/${b}/notes/${note.id}/restore`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    // A's note is untouched and still visible on A.
    expect(listNotes(a)[0].body).toBe('Belongs to A.');
    expect(listNotes(b)).toHaveLength(0);
  });

  it('404s an unknown note id on a real company', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const res = await agent.patch(`/api/companies/${id}/notes/00000000-0000-0000-0000-000000000000`).send({ body: 'Nope.' });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Note not found/);
  });
});

// ── Empty, oversized, and whitespace ─────────────────────────────

describe('note content validation', () => {
  it('rejects an empty note, and every whitespace-only disguise of one', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    for (const body of ['', '   ', '\n\n\n', '\t\t', ' \r\n \r\n ', '\u0000\u0001']) {
      const res = await agent.post(`/api/companies/${id}/notes`).send({ body });
      expect(res.status, `body ${JSON.stringify(body)} should be refused`).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(JSON.stringify(res.body.issues)).toMatch(/cannot be empty/);
    }
    expect(listNotes(id, { includeArchived: true })).toHaveLength(0);
  });

  it('rejects a missing body outright rather than storing an empty note', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    expect((await agent.post(`/api/companies/${id}/notes`).send({})).status).toBe(400);
    expect((await agent.post(`/api/companies/${id}/notes`).send({ body: null })).status).toBe(400);
    expect((await agent.post(`/api/companies/${id}/notes`).send({ body: 42 })).status).toBe(400);
    expect(listNotes(id, { includeArchived: true })).toHaveLength(0);
  });

  it('will not let an edit empty out an existing note', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Real content.' }).expect(201)).body.note;
    const res = await agent.patch(`/api/companies/${id}/notes/${created.id}`).send({ body: '    ' });
    expect(res.status).toBe(400);
    // The original survived the refused edit.
    expect(listNotes(id)[0].body).toBe('Real content.');
  });

  it('accepts a note at exactly the limit and refuses one character more', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);

    const atLimit = 'a'.repeat(NOTE_MAX_LENGTH);
    const ok = await agent.post(`/api/companies/${id}/notes`).send({ body: atLimit });
    expect(ok.status).toBe(201);
    expect(ok.body.note.body).toHaveLength(NOTE_MAX_LENGTH);

    const over = await agent.post(`/api/companies/${id}/notes`).send({ body: 'a'.repeat(NOTE_MAX_LENGTH + 1) });
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body.issues)).toMatch(new RegExp(String(NOTE_MAX_LENGTH)));

    // Nothing was truncated into storage as a consolation prize.
    expect(listNotes(id)).toHaveLength(1);
  });

  it('refuses a grossly oversized body without trying to normalize it', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const res = await agent.post(`/api/companies/${id}/notes`).send({ body: 'x'.repeat(NOTE_MAX_LENGTH * 8) });
    expect(res.status).toBe(400);
    expect(listNotes(id)).toHaveLength(0);
  });

  it('measures the limit AFTER normalization, so trailing whitespace cannot push a valid note over', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    // Exactly at the limit once the padding is normalized away.
    const res = await agent.post(`/api/companies/${id}/notes`).send({ body: `${'a'.repeat(NOTE_MAX_LENGTH)}\n\n\n   ` });
    expect(res.status).toBe(201);
    expect(res.body.note.body).toHaveLength(NOTE_MAX_LENGTH);
  });

  it('normalizes whitespace: line endings, trailing spaces, blank runs, and the outer trim', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const res = await agent.post(`/api/companies/${id}/notes`).send({
      body: '  \r\n\r\nFirst paragraph.   \r\n\r\n\r\n\r\nSecond paragraph.\t\t\r\n  ',
    }).expect(201);
    expect(res.body.note.body).toBe('First paragraph.\n\nSecond paragraph.');
    // Read back from the database, not just echoed by the response.
    expect(listNotes(id)[0].body).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('strips invisible control characters but keeps tabs, newlines, and real text', () => {
    expect(normalizeNoteBody('a\u0000b\u0007c\u001Fd\u007Fe')).toBe('abcde');
    expect(normalizeNoteBody('col\tone\nrow two')).toBe('col\tone\nrow two');
    expect(normalizeNoteBody('Café — 90% margin, €2M ARR ✅')).toBe('Café — 90% margin, €2M ARR ✅');
  });

  it('keeps internal single blank lines, so paragraph structure survives', () => {
    expect(normalizeNoteBody('One\n\nTwo')).toBe('One\n\nTwo');
    expect(normalizeNoteBody('One\nTwo')).toBe('One\nTwo');
  });
});

// ── Plain-text safety ────────────────────────────────────────────

describe('plain-text safety', () => {
  /**
   * Every one of these is stored and returned EXACTLY as written.
   *
   * The temptation is to escape or strip on the way in. That would be
   * the wrong fix in two directions at once: it corrupts legitimate text
   * (a note about a `<term sheet>` clause, or a regex a reviewer pasted),
   * and it implies the output is safe because the input was cleaned —
   * which stops being true the moment anything renders a body it did not
   * fetch through this path. Safety belongs at render time, where the UI
   * treats a body as text and never as markup. See CompanyNotes.tsx.
   */
  const HOSTILE = [
    '<script>alert("xss")</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '"><svg/onload=alert(1)>',
    "'; DROP TABLE company_notes; --",
    '{{constructor.constructor("alert(1)")()}}',
    '[link](javascript:alert(1))',
    '# Heading **bold** `code` <b>bold</b>',
    '\\u003cscript\\u003e',
    '../../etc/passwd',
  ];

  it('stores hostile-looking text verbatim, without escaping or stripping it', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    for (const body of HOSTILE) {
      const res = await agent.post(`/api/companies/${id}/notes`).send({ body }).expect(201);
      expect(res.body.note.body, `round-trip of ${body}`).toBe(body);

      // And the same bytes come back out of the database.
      const stored = getDb().prepare('SELECT body FROM company_notes WHERE id = ?').get(res.body.note.id) as { body: string };
      expect(stored.body).toBe(body);
      // Specifically NOT entity-encoded — that would be a lie about what
      // the reviewer wrote, and would double-encode on render.
      expect(stored.body).not.toContain('&lt;');
      expect(stored.body).not.toContain('&amp;');
    }
  });

  it('a SQL-injection-shaped note leaves the table intact', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: "x'); DROP TABLE company_notes; --" }).expect(201);
    await agent.post(`/api/companies/${id}/notes`).send({ body: 'still here' }).expect(201);
    expect(listNotes(id)).toHaveLength(2);
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name);
    expect(tables).toContain('company_notes');
  });

  it('the response is JSON, so a body is data and never executable markup in transit', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: '<script>alert(1)</script>' }).expect(201);
    const res = await agent.get(`/api/companies/${id}/notes`).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // The raw payload escapes the tag characters per JSON rules; parsing
    // gives back the original. Both halves matter.
    expect(res.body.notes[0].body).toBe('<script>alert(1)</script>');
  });

  it('the UI never opts out of React escaping for a note body', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'components', 'CompanyNotes.tsx'), 'utf8');
    // Matches USE, not mention: the file documents at length why it does
    // not do this, and a bare substring check would fail on its own
    // comment — then get "fixed" by deleting the explanation.
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*[=:]/);
    expect(source).not.toMatch(/\.innerHTML\s*=/);
    // The body is rendered as text with preserved line breaks.
    expect(source).toContain('whitespace-pre-wrap');
  });
});

// ── Audit history ────────────────────────────────────────────────

describe('audit history', () => {
  it('records every lifecycle action in the audit log and the review decisions', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'Auditable.' }).expect(201)).body.note;
    await agent.patch(`/api/companies/${id}/notes/${created.id}`).send({ body: 'Auditable, revised.' }).expect(200);
    await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200);
    await agent.post(`/api/companies/${id}/notes/${created.id}/restore`).expect(200);

    const actions = store.raw.audit.map((a) => a.action);
    for (const expected of [
      'company-note-add', 'company-note-edit', 'company-note-archive', 'company-note-restore',
    ]) {
      expect(actions, `audit is missing ${expected}`).toContain(expected);
    }
    for (const entry of store.raw.audit.filter((a) => a.action.startsWith('company-note'))) {
      expect(entry.subject).toBe(id);
      expect(entry.outcome).toBe('ok');
    }

    const decisions = listReviewDecisions(id).map((d) => d.decision);
    expect(decisions).toContain('note-added');
    expect(decisions).toContain('note-edited');
    expect(decisions).toContain('note-archived');
    expect(decisions).toContain('note-restored');
    for (const d of listReviewDecisions(id).filter((x) => x.decision.startsWith('note-'))) {
      expect(d.actor).toBe('local-admin'); // the session's identity, not a client string
    }
  });

  it('audit records THAT a note changed, never what it said', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const secret = 'The founder misrepresented the pipeline on the last call.';
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body: secret }).expect(201)).body.note;
    await agent.patch(`/api/companies/${id}/notes/${created.id}`).send({ body: `${secret} Confirmed twice.` }).expect(200);
    await agent.post(`/api/companies/${id}/notes/${created.id}/archive`).expect(200);

    const dumped = JSON.stringify(store.raw.audit);
    expect(dumped).not.toContain('misrepresented');
    expect(dumped).not.toContain('pipeline');
    // The reason field on a review decision is equally not a place for it.
    expect(JSON.stringify(listReviewDecisions(id))).not.toContain('misrepresented');

    // What IS recorded: the note id, so the trail can be followed.
    expect(dumped).toContain(created.id);
  });

  it('the audit endpoint exposes note activity without exposing note bodies', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: 'Sensitive-opinion-marker.' }).expect(201);
    const res = await agent.get('/api/audit').expect(200);
    const dumped = JSON.stringify(res.body);
    expect(dumped).toContain('company-note-add');
    expect(dumped).not.toContain('Sensitive-opinion-marker');
  });
});

// ── Every kind of record ─────────────────────────────────────────

describe('record coverage', () => {
  /**
   * Notes must work on every record a reviewer can open, not just the
   * healthy ones. A quarantined or human-review record is precisely
   * where an explanatory note is most valuable — "we looked, here is why
   * it stays out" — so gating notes on qualification would remove them
   * exactly where they matter most. Note routes therefore check company
   * existence and nothing else.
   */
  function setQualification(companyId: string, result: string): void {
    getDb().prepare(`INSERT INTO issuer_qualification (company_id, result, operating_confidence, qualified_at, version)
      VALUES (?, ?, 0.5, '2026-07-30T00:00:00.000Z', 'test')`).run(companyId, result);
  }
  function setClassification(companyId: string, classification: string): void {
    getDb().prepare(`INSERT INTO company_opportunity (company_id, classification, primary_source_id, primary_tier,
        opportunity_type, evidence_url, evidence_retrieved_at, evidence_summary, why_current, classified_at)
      VALUES (?, ?, 'funding-news', 2, 'funding-announcement', 'https://example.com/e', '2026-07-30T00:00:00.000Z', 's', 'w', '2026-07-30T00:00:00.000Z')`)
      .run(companyId, classification);
  }

  const CASES: { label: string; setup: (id: string) => void }[] = [
    {
      label: 'qualified live deal',
      setup: (id) => { setQualification(id, 'qualified-operating-company'); setClassification(id, 'recent-financing-signal'); },
    },
    {
      label: 'held-back live deal (qualified but off the shortlist)',
      setup: (id) => { setQualification(id, 'company-lead-requires-corroboration'); setClassification(id, 'recent-financing-signal'); },
    },
    {
      label: 'company lead',
      setup: (id) => { setQualification(id, 'insufficient-evidence'); setClassification(id, 'company-lead'); },
    },
    {
      label: 'human-review-required',
      setup: (id) => { setQualification(id, 'human-review-required'); setClassification(id, 'unverified-opportunity'); },
    },
    {
      label: 'quarantined',
      setup: (id) => {
        setQualification(id, 'public-company');
        setClassification(id, 'unverified-opportunity');
        quarantine(id, 'Publicly traded — not a venture-stage operating company.');
      },
    },
    { label: 'unclassified, unqualified record', setup: () => {} },
  ];

  for (const { label, setup } of CASES) {
    it(`supports the full note lifecycle on a ${label} record`, async () => {
      const app = createApp();
      const companyId = `co-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
      seedCompany({ id: companyId, name: `Fixture ${label}` });
      setup(companyId);
      const agent = await adminAgent(app);

      const created = await agent.post(`/api/companies/${companyId}/notes`).send({ body: `Note on a ${label}.` });
      expect(created.status, `create on ${label}`).toBe(201);
      const noteId = created.body.note.id;
      expect((await agent.get(`/api/companies/${companyId}/notes`)).body.notes).toHaveLength(1);
      expect((await agent.patch(`/api/companies/${companyId}/notes/${noteId}`).send({ body: 'Revised.' })).status).toBe(200);
      expect((await agent.post(`/api/companies/${companyId}/notes/${noteId}/archive`)).status).toBe(200);
      expect((await agent.post(`/api/companies/${companyId}/notes/${noteId}/restore`)).status).toBe(200);
      expect(listNotes(companyId)[0].body).toBe('Revised.');
    });
  }
});

// ── The CSV export must not carry note bodies ────────────────────

describe('CSV export does not leak note bodies', () => {
  const SECRET = 'Do not forward: the CEO is not coachable and we should pass.';

  function companyFor(id: string): Company {
    return {
      id,
      name: 'Note Fixture Inc',
      oneLiner: 'A company a reviewer has opinions about.',
      vertical: 'fintech',
      subcategory: 'Payments',
      stage: 'Seed',
      city: 'Austin',
      state: 'TX',
      foundedYear: 2025,
      teamSize: 6,
      website: 'https://notefixture.example.com',
      traction: { level: 4, note: 'Two pilots.' },
      founders: [{ name: 'Ana Fixture', role: 'CEO', background: 'Payments engineer.' }],
      evidence: [{ claim: 'Seed round', source: 'Fixture News', url: 'https://example.com/note-co', date: '2026-06-01', type: 'News' }],
      flags: [],
    };
  }

  it('has no note column, and no note text, in a built CSV', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: SECRET }).expect(201);

    const company = companyFor(id);
    const csv = buildCsv([{ company, fit: scoreCompany(company) }]);
    expect(csv).not.toContain(SECRET);
    expect(csv).not.toContain('coachable');
    expect(csv.toLowerCase()).not.toContain('internal note');
    expect(EXPORT_COLUMNS.some((c) => /note/i.test(c))).toBe(false);
    expect(toCsvRow({ company, fit: scoreCompany(company) })).not.toContain('coachable');
  });

  it('the bulk company payload the export is built from carries no note bodies', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    await agent.post(`/api/companies/${id}/notes`).send({ body: SECRET }).expect(201);

    const res = await agent.get('/api/companies/imported').expect(200);
    const dumped = JSON.stringify(res.body);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain('coachable');
    // Not merely absent from the serialization — genuinely not a field.
    expect(res.body).not.toHaveProperty('notes');
    expect(res.body.companies[0]).not.toHaveProperty('notes');
  });

  it('an archived note is no more exportable than an active one', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const note = (await agent.post(`/api/companies/${id}/notes`).send({ body: SECRET }).expect(201)).body.note;
    await agent.post(`/api/companies/${id}/notes/${note.id}/archive`).expect(200);

    const dumped = JSON.stringify((await agent.get('/api/companies/imported').expect(200)).body);
    expect(dumped).not.toContain('coachable');
  });
});

// ── Persistence ──────────────────────────────────────────────────

describe('persistence', () => {
  it('a note read back through a fresh request survives, unchanged', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const body = 'Multi-line note.\n\nSecond paragraph with <angle brackets> and a "quote".';
    const created = (await agent.post(`/api/companies/${id}/notes`).send({ body }).expect(201)).body.note;

    // A brand-new app instance over the same database — the closest
    // in-process equivalent of a page reload.
    const reloaded = await (await adminAgent(createApp())).get(`/api/companies/${id}/notes`).expect(200);
    expect(reloaded.body.notes).toHaveLength(1);
    expect(reloaded.body.notes[0]).toMatchObject({ id: created.id, body, archived: false });
  });

  it('survives a logout and a fresh login', async () => {
    const app = createApp();
    const id = seedCompany();
    const agent = await adminAgent(app);
    const body = 'Written before signing out.';
    await agent.post(`/api/companies/${id}/notes`).send({ body }).expect(201);

    await agent.post('/api/auth/logout').send({}).expect(200);
    // Really signed out: the notes are unreachable without a session.
    expect((await agent.get(`/api/companies/${id}/notes`)).status).toBe(401);

    const freshAgent = await adminAgent(app);
    const after = await freshAgent.get(`/api/companies/${id}/notes`).expect(200);
    expect(after.body.notes[0].body).toBe(body);
  });

  it('survives a real application restart — two separate processes, one database file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-notes-'));
    const dbPath = path.join(dir, 'notes-restart.db');
    const projectRoot = path.resolve(__dirname, '..', '..');
    // Windows requires a file:// URL for a dynamic import() with an
    // absolute path — a raw 'C:\...' string isn't a valid ESM specifier.
    const projectRootUrl = pathToFileURL(projectRoot).href;
    const runScript = (body: string): string => {
      const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.mts`);
      fs.writeFileSync(file, body);
      // Invoke tsx's own CLI script directly via the Node binary, rather
      // than 'npx tsx' — 'npx' is a .cmd shim on Windows, not a .exe, and
      // spawning it needs either shell: true (which Node now warns is
      // unsafe with an args array — DEP0190) or a platform-specific
      // 'npx.cmd' resolution (which Node refuses to run directly as a
      // hardened-by-default guard against batch-file argument injection).
      // Going straight to Node with tsx's CLI script avoids the shell
      // entirely, on every OS.
      const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      return execFileSync(process.execPath, [tsxCli, file], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'restart-test' },
        encoding: 'utf8',
      });
    };

    // Process 1: create a company, write a note and an archived note, exit.
    runScript(`
      const { saveCompany } = await import('${projectRootUrl}/server/db/repos/companies');
      const { createNote, archiveNote } = await import('${projectRootUrl}/server/db/repos/notes');
      saveCompany(${JSON.stringify(fixtureCompany({ id: 'restart-note-co' }))}, { origin: 'user-entered', source: 'notes-restart-test' });
      const reviewer = { id: 'local-admin', label: 'Local administrator', source: 'local-admin' };
      createNote('restart-note-co', 'Survives a restart.\\n\\nWith <markup> intact.', reviewer);
      const gone = createNote('restart-note-co', 'Archived but retained.', reviewer);
      archiveNote(gone.id);
      console.log('WROTE');
    `);

    // Process 2: a completely new process reads them back off disk.
    const out = runScript(`
      const { listNotes } = await import('${projectRootUrl}/server/db/repos/notes');
      const active = listNotes('restart-note-co');
      const all = listNotes('restart-note-co', { includeArchived: true });
      console.log(JSON.stringify({
        active: active.length,
        all: all.length,
        body: active[0]?.body,
        reviewer: active[0]?.reviewer,
        archivedBody: all.find((n) => n.archived)?.body,
      }));
    `);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.active).toBe(1);
    expect(result.all).toBe(2);
    expect(result.body).toBe('Survives a restart.\n\nWith <markup> intact.');
    expect(result.reviewer).toEqual(LOCAL_ADMIN_REVIEWER);
    expect(result.archivedBody).toBe('Archived but retained.'); // archived ≠ deleted, across a restart
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('survives a backup and restore cycle, including archived notes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-notes-backup-'));
    const dbPath = path.join(dir, 'notes-backup.db');
    const projectRoot = path.resolve(__dirname, '..', '..');
    // Windows requires a file:// URL for a dynamic import() with an
    // absolute path — a raw 'C:\...' string isn't a valid ESM specifier.
    const projectRootUrl = pathToFileURL(projectRoot).href;
    const runScript = (body: string): string => {
      const file = path.join(dir, `step-${Math.random().toString(36).slice(2)}.mts`);
      fs.writeFileSync(file, body);
      // Invoke tsx's own CLI script directly via the Node binary, rather
      // than 'npx tsx' — 'npx' is a .cmd shim on Windows, not a .exe, and
      // spawning it needs either shell: true (which Node now warns is
      // unsafe with an args array — DEP0190) or a platform-specific
      // 'npx.cmd' resolution (which Node refuses to run directly as a
      // hardened-by-default guard against batch-file argument injection).
      // Going straight to Node with tsx's CLI script avoids the shell
      // entirely, on every OS.
      const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      return execFileSync(process.execPath, [tsxCli, file], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_FILE: dbPath, DATA_FILE: dbPath.replace('.db', '-kv.db'), NODE_ENV: 'restart-test' },
        encoding: 'utf8',
      });
    };

    // Write notes, back up, then destroy the notes in the live database.
    const backupOut = runScript(`
      const { saveCompany } = await import('${projectRootUrl}/server/db/repos/companies');
      const { createNote, archiveNote, listNotes } = await import('${projectRootUrl}/server/db/repos/notes');
      const { createBackup } = await import('${projectRootUrl}/server/services/backup');
      const { getDb } = await import('${projectRootUrl}/server/db/client');
      saveCompany(${JSON.stringify(fixtureCompany({ id: 'backup-note-co' }))}, { origin: 'user-entered', source: 'notes-backup-test' });
      const reviewer = { id: 'local-admin', label: 'Local administrator', source: 'local-admin' };
      createNote('backup-note-co', 'Present in the backup.', reviewer);
      const archived = createNote('backup-note-co', 'Archived, and in the backup.', reviewer);
      archiveNote(archived.id);
      const result = await createBackup('notes-backup-test');
      if (!result.ok) throw new Error('backup failed: ' + result.error);
      // Simulate the loss the restore is meant to undo.
      getDb().exec('DELETE FROM company_notes');
      console.log(JSON.stringify({ file: result.backup.file, afterDelete: listNotes('backup-note-co', { includeArchived: true }).length }));
    `);
    const { file, afterDelete } = JSON.parse(backupOut.trim().split('\n').pop()!);
    expect(afterDelete).toBe(0);

    // Restore, then read the notes back in yet another process.
    const restoreOut = runScript(`
      const { restoreBackup } = await import('${projectRootUrl}/server/services/backup');
      const result = await restoreBackup(${JSON.stringify(file)}, 'notes-backup-test');
      if (!result.ok) throw new Error('restore failed: ' + result.error);
      console.log('RESTORED');
    `);
    expect(restoreOut).toContain('RESTORED');

    const verifyOut = runScript(`
      const { listNotes } = await import('${projectRootUrl}/server/db/repos/notes');
      const all = listNotes('backup-note-co', { includeArchived: true });
      console.log(JSON.stringify({
        total: all.length,
        active: all.filter((n) => !n.archived).map((n) => n.body),
        archived: all.filter((n) => n.archived).map((n) => n.body),
      }));
    `);
    const restored = JSON.parse(verifyOut.trim().split('\n').pop()!);
    expect(restored.total).toBe(2);
    expect(restored.active).toEqual(['Present in the backup.']);
    expect(restored.archived).toEqual(['Archived, and in the backup.']);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

// ── Notes are independent of company review data ─────────────────

describe('isolation from qualification data', () => {
  it('writing notes changes no verdict, score, classification, or quarantine state', async () => {
    const app = createApp();
    const id = seedCompany();
    const db = getDb();
    db.prepare(`INSERT INTO issuer_qualification (company_id, result, operating_confidence, qualified_at, version)
      VALUES (?, 'qualified-operating-company', 0.9, '2026-07-30T00:00:00.000Z', 'test')`).run(id);
    db.prepare(`INSERT INTO company_opportunity (company_id, classification, primary_source_id, primary_tier,
        opportunity_type, evidence_url, evidence_retrieved_at, evidence_summary, why_current, classified_at)
      VALUES (?, 'recent-financing-signal', 'funding-news', 2, 'funding-announcement', 'https://example.com/e', '2026-07-30T00:00:00.000Z', 's', 'w', '2026-07-30T00:00:00.000Z')`).run(id);

    const before = {
      qualification: db.prepare('SELECT * FROM issuer_qualification WHERE company_id = ?').get(id),
      opportunity: db.prepare('SELECT * FROM company_opportunity WHERE company_id = ?').get(id),
      scores: db.prepare('SELECT * FROM scoring_results WHERE company_id = ?').all(id),
      company: db.prepare('SELECT * FROM companies WHERE id = ?').get(id),
    };

    const agent = await adminAgent(app);
    const note = (await agent.post(`/api/companies/${id}/notes`).send({ body: 'This should move nothing.' }).expect(201)).body.note;
    await agent.patch(`/api/companies/${id}/notes/${note.id}`).send({ body: 'Still moves nothing.' }).expect(200);
    await agent.post(`/api/companies/${id}/notes/${note.id}/archive`).expect(200);
    await agent.post(`/api/companies/${id}/notes/${note.id}/restore`).expect(200);

    expect(db.prepare('SELECT * FROM issuer_qualification WHERE company_id = ?').get(id)).toEqual(before.qualification);
    expect(db.prepare('SELECT * FROM company_opportunity WHERE company_id = ?').get(id)).toEqual(before.opportunity);
    expect(db.prepare('SELECT * FROM scoring_results WHERE company_id = ?').all(id)).toEqual(before.scores);
    // Every other company field is untouched by note actions — EXCEPT
    // last_reviewed_at, which notes are supposed to move: writing a note
    // is exactly the kind of deliberate analyst engagement that counts
    // as a human review action (recordReviewDecision stamps it for every
    // subjectType='company' event — see server/db/repos/operations.ts).
    const after = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Record<string, unknown>;
    expect({ ...after, last_reviewed_at: null }).toEqual({ ...(before.company as Record<string, unknown>), last_reviewed_at: null });
    expect(after.last_reviewed_at).not.toBeNull();
  });

  it('a note is not evidence — it never appears in the company\'s evidence list', async () => {
    const app = createApp();
    const agent = await adminAgent(app);
    const importRes = await agent.post('/api/companies/import-csv').send({
      csv: [CSV_HEADER, 'Evidence Boundary Co,Grid software,sustainability,Energy transition software,Seed,Portland,OR,2025,8,5,Two pilots,Jo Rivera,CEO,Grid engineer,Pilot announced,Local news,https://example.com/evidence-boundary,2026-06-01,News,'].join('\n'),
    }).expect(200);
    expect(importRes.body.imported).toBe(1);

    const listed = await agent.get('/api/companies/imported').expect(200);
    const company = listed.body.companies[0] as { id: string; evidence: unknown[] };
    const evidenceBefore = company.evidence.length;

    await agent.post(`/api/companies/${company.id}/notes`).send({ body: 'An opinion, not a citation.' }).expect(201);

    const after = await agent.get('/api/companies/imported').expect(200);
    expect((after.body.companies[0] as { evidence: unknown[] }).evidence).toHaveLength(evidenceBefore);
    expect(JSON.stringify(after.body.companies[0])).not.toContain('An opinion, not a citation.');
  });
});
