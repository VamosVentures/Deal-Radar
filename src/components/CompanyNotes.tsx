import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { btnGhost, btnPrimary } from './Modal';
import { normalizeNoteBody, NOTE_MAX_LENGTH, type CompanyNote } from '../../shared/notes';
import { setUnsavedNotesCheck } from '../lib/unsavedNotes';

/**
 * Internal notes on a company — the investment team's own words.
 *
 * Distinct from the Evidence section directly above it, and the
 * separation is the whole point. Evidence is sourced, cited, and
 * append-only; it is what the outside world says. A note is what WE
 * think, it has an author and no citation, and it is confidential — it
 * never enters the CSV export and never leaves these routes.
 *
 * Three rules this component exists to keep:
 *
 *   plain text   A body is rendered as text, always. No
 *                `dangerouslySetInnerHTML`, no Markdown renderer, no
 *                linkifying. `whitespace-pre-wrap` preserves the line
 *                breaks a reviewer typed without interpreting anything.
 *   no autosave  Saving is an explicit button press. A half-written
 *                opinion must not be persisted as though it were
 *                finished — which is why unsaved drafts need a guard
 *                (see src/lib/unsavedNotes.ts) rather than a timer.
 *   no delete    Archive is reversible and the note keeps its body and
 *                author. The server has no delete route at all.
 */

const textarea =
  'w-full resize-y border border-line bg-paper px-2.5 py-2 text-xs leading-relaxed text-ink placeholder:text-slate-mid focus:border-marigold focus:outline-none';
const label = 'font-mono text-[10px] uppercase tracking-widest text-slate-mid';

/** `2026-07-30 14:39` — enough to order two notes written the same afternoon. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * The counter, and the reason it counts normalized length.
 *
 * What the reviewer sees has to be what the server will measure, or the
 * box says 3,998 and the save fails at 4,001. shared/notes.ts owns both
 * the normalizer and the limit for exactly this reason.
 */
function Counter({ draft }: { draft: string }) {
  const length = normalizeNoteBody(draft).length;
  const over = length > NOTE_MAX_LENGTH;
  const close = !over && length > NOTE_MAX_LENGTH * 0.9;
  return (
    <span
      className={`font-mono text-[10px] tabular-nums ${over ? 'text-alerta' : close ? 'text-marigold' : 'text-slate-mid'}`}
      data-testid="note-counter"
    >
      {length.toLocaleString()} / {NOTE_MAX_LENGTH.toLocaleString()}
      {over && ' — too long to save'}
    </span>
  );
}

function NoteCard({ note, busy, onEdit, onArchive, onRestore }: {
  note: CompanyNote;
  busy: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const edited = note.updatedAt !== note.createdAt;
  return (
    <li
      className={`border px-3 py-2.5 text-xs ${note.archived ? 'border-dashed border-line bg-paper/60' : 'border-line bg-panel'}`}
      data-testid={note.archived ? 'note-card-archived' : 'note-card'}
    >
      {/*
        The body, as plain text. `whitespace-pre-wrap` keeps the
        reviewer's paragraph breaks; `break-words` keeps a pasted URL
        from widening the panel. React escapes the content — that is the
        entire XSS defense and it is sufficient precisely because
        nothing here opts out of it.
      */}
      <p className="whitespace-pre-wrap break-words text-ink" data-testid="note-body">{note.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-1.5">
        <span className="font-mono text-[10px] text-slate-mid" data-testid="note-meta">
          {note.reviewer.label} · {stamp(note.createdAt)}
          {edited && ` · edited ${stamp(note.updatedAt)}`}
        </span>
        {note.archived && (
          <span className="rounded-[2px] border border-line bg-paper px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-slate-mid">
            Archived{note.archivedAt ? ` ${stamp(note.archivedAt)}` : ''}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          {note.archived ? (
            <button className={btnGhost} disabled={busy} onClick={onRestore} data-testid="note-restore">
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          ) : (
            <>
              <button className={btnGhost} disabled={busy} onClick={onEdit} data-testid="note-edit">Edit</button>
              <button
                className={btnGhost} disabled={busy} onClick={onArchive} data-testid="note-archive"
                title="Archive this note. Nothing is deleted — archived notes stay readable and can be restored."
              >
                {busy ? 'Archiving…' : 'Archive'}
              </button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

export function CompanyNotes({ companyId }: { companyId: string }) {
  const [notes, setNotes] = useState<CompanyNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [draft, setDraft] = useState('');
  /** Set while editing an existing note; null while composing a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /** Which note has an archive/restore request in flight. */
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async (includeArchived: boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const { notes: rows } = await api.notes.list(companyId, includeArchived);
      setNotes(rows);
    } catch (e) {
      setNotes([]);
      setLoadError(e instanceof ApiError ? e.message : 'These notes could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load(showArchived);
  }, [load, showArchived]);

  // ── Unsaved-draft protection ───────────────────────────────────
  // A draft is anything typed and not yet saved: new text in the
  // compose box, or an edit that differs from the stored body. The
  // check is read through a ref so the guard always sees current state
  // without re-registering on every keystroke.
  const dirtyRef = useRef(false);
  dirtyRef.current = (() => {
    const normalized = normalizeNoteBody(draft);
    if (editingId === null) return normalized.length > 0;
    const original = notes.find((n) => n.id === editingId);
    return original ? normalized !== original.body : normalized.length > 0;
  })();

  useEffect(() => {
    setUnsavedNotesCheck(() => dirtyRef.current);
    // The browser-level escape hatch. `preventDefault` is what asks for
    // the native "leave site?" prompt; the text is the browser's, not
    // ours, and cannot be customized.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      setUnsavedNotesCheck(null);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // Switching companies reuses this component; drop any draft state
  // belonging to the company that just closed.
  useEffect(() => {
    setDraft('');
    setEditingId(null);
    setSaveError(null);
    setSuccess(null);
  }, [companyId]);

  const normalized = normalizeNoteBody(draft);
  const tooLong = normalized.length > NOTE_MAX_LENGTH;
  const canSave = normalized.length > 0 && !tooLong && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setSuccess(null);
    try {
      if (editingId) {
        await api.notes.edit(companyId, editingId, draft);
        setSuccess('Note updated.');
      } else {
        await api.notes.create(companyId, draft);
        setSuccess('Note saved.');
      }
      setDraft('');
      setEditingId(null);
      await load(showArchived);
    } catch (e) {
      // The draft is deliberately left in the box on failure — the
      // reviewer's words are the one thing here that cannot be
      // regenerated.
      setSaveError(e instanceof ApiError ? e.message : 'The note could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (note: CompanyNote) => {
    if (dirtyRef.current && !window.confirm('Discard the note you are currently writing?')) return;
    setEditingId(note.id);
    setDraft(note.body);
    setSaveError(null);
    setSuccess(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
    setSaveError(null);
  };

  const setArchived = async (note: CompanyNote, archived: boolean) => {
    setRowBusy(note.id);
    setSaveError(null);
    setSuccess(null);
    try {
      if (archived) await api.notes.archive(companyId, note.id);
      else await api.notes.restore(companyId, note.id);
      setSuccess(archived ? 'Note archived — it is retained and can be restored.' : 'Note restored.');
      // An archive while archived notes are hidden would make the note
      // vanish with no explanation, so reveal them.
      if (archived && !showArchived) setShowArchived(true);
      else await load(showArchived);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'That note could not be updated.');
    } finally {
      setRowBusy(null);
    }
  };

  const active = notes.filter((n) => !n.archived);
  const archived = notes.filter((n) => n.archived);

  return (
    <div data-testid="company-notes">
      <p className="mb-3 text-[11px] leading-relaxed text-slate-mid">
        The team's own assessment, kept apart from sourced evidence and never included in the CSV export.
        Notes are plain text and are never deleted — archiving is reversible, so the reasoning behind a
        past decision stays readable.
      </p>

      {/* ── Compose / edit ── */}
      <div className="border border-line bg-panel px-3 py-2.5">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className={label}>{editingId ? 'Editing note' : 'Add a note'}</span>
          <Counter draft={draft} />
        </div>
        <textarea
          className={`${textarea} h-24`}
          data-testid="note-draft"
          aria-label={editingId ? 'Edit internal note' : 'Add an internal note'}
          placeholder="What the team thinks — the read on the founders, the open question that decides this, why it is or is not a fit."
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSuccess(null); }}
        />
        {tooLong && (
          <p className="mt-1 text-[11px] text-alerta" data-testid="note-too-long">
            {normalized.length.toLocaleString()} characters — {NOTE_MAX_LENGTH.toLocaleString()} is the limit. Shorten it to save.
          </p>
        )}
        {saveError && <p className="mt-1 text-[11px] text-alerta" data-testid="note-error">{saveError}</p>}
        {success && <p className="mt-1 text-[11px] text-verde" data-testid="note-success">{success}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button className={btnPrimary} disabled={!canSave} onClick={save} data-testid="note-save">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save note'}
          </button>
          {editingId && (
            <button className={btnGhost} disabled={saving} onClick={cancelEdit} data-testid="note-cancel-edit">
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── Existing notes ── */}
      <div className="mt-3">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
          <span className={label}>
            {active.length} note{active.length === 1 ? '' : 's'}
            {showArchived && archived.length > 0 && ` · ${archived.length} archived`}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-slate-mid">
            <input
              type="checkbox" checked={showArchived} data-testid="note-show-archived"
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived notes
          </label>
        </div>

        {loading && <p className="text-xs text-slate-mid" data-testid="notes-loading">Loading notes…</p>}
        {loadError && <p className="text-xs text-alerta" data-testid="notes-load-error">{loadError}</p>}

        {!loading && !loadError && notes.length === 0 && (
          <p className="border border-dashed border-line px-3 py-4 text-center text-xs text-slate-mid" data-testid="notes-empty">
            No internal notes on this company yet. The first one is the most useful — write down what made
            it worth opening.
          </p>
        )}

        {!loading && !loadError && notes.length > 0 && (
          <ul className="space-y-2">
            {[...active, ...archived].map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                busy={rowBusy === note.id}
                onEdit={() => beginEdit(note)}
                onArchive={() => void setArchived(note, true)}
                onRestore={() => void setArchived(note, false)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
