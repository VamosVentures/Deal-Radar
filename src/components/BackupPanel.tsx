import { useEffect, useState } from 'react';
import { api, ApiError, type BackupMetadata } from '../lib/api';

/**
 * Backup list + "create backup now" — deliberately NOT a restore
 * button. Restoring is a server-side/CLI-only action
 * (`npm run db:restore`) documented in TECHNICAL_HANDOFF.md; exposing
 * it in the browser would make a destructive, hard-to-undo action one
 * accidental click away.
 */
export function BackupPanel() {
  const [backups, setBackups] = useState<BackupMetadata[] | null>(null);
  const [settings, setSettings] = useState<{ maxBackups: number; maxBackupAgeDays: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api.admin.backups.list().then((r) => { setBackups(r.backups); setSettings(r.settings); }).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const createNow = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.admin.backups.create('admin');
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Database backups</h2>
        <button onClick={createNow} disabled={busy} className="ml-auto rounded-[2px] border border-line bg-panel px-3 py-1.5 text-xs font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50">
          {busy ? 'Backing up…' : 'Create backup now'}
        </button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Timestamped, consistent SQLite snapshots (VACUUM INTO), stored outside the active database path.
        {settings && ` Retention: max ${settings.maxBackups} files or ${settings.maxBackupAgeDays} days, whichever is reached first.`}
        {' '}Restoring is deliberately a server-side/CLI command only (<code className="rounded-[2px] bg-paper px-1 font-mono">npm run db:restore</code>) — never a browser button.
      </p>
      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
      {backups && (
        backups.length === 0 ? (
          <p className="mt-2 text-xs text-slate-mid">No backups yet — click "Create backup now" or run <code className="rounded-[2px] bg-paper px-1 font-mono">npm run db:backup</code>.</p>
        ) : (
          <table className="mt-3 w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line font-mono uppercase tracking-wider text-slate-mid">
                <th className="py-1.5 pr-3">File</th>
                <th className="py-1.5 pr-3">Created</th>
                <th className="py-1.5 pr-3">Size</th>
                <th className="py-1.5 pr-3">Schema</th>
                <th className="py-1.5 pr-3">Companies</th>
                <th className="py-1.5 pr-3">Triggered by</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.file} className="border-b border-line">
                  <td className="py-1.5 pr-3 font-mono">{b.file}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{b.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-1.5 pr-3">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
                  <td className="py-1.5 pr-3">v{b.schemaVersion}</td>
                  <td className="py-1.5 pr-3">{b.companyCount}</td>
                  <td className="py-1.5 pr-3">{b.triggeredBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}
