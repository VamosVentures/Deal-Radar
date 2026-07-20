import { useState } from 'react';
import { api, ApiError } from '../lib/api';

const input = 'rounded-sm border border-line bg-panel px-2 py-1';

/**
 * Real server-side gate for Settings' admin-only actions — previously
 * this page was reachable and fully functional to anyone who could
 * load the URL; now the admin panels (system status, connectors,
 * scheduled sourcing, HubSpot/Outlook connect) require a real session
 * the backend verifies on every request (see server/lib/auth.ts).
 */
export function AdminLogin({ configured, onAuthenticated }: { configured: boolean; onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!configured) {
    return (
      <div className="rounded-md border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
        <span className="font-semibold text-alerta">Administrator sign-in is not enabled.</span>{' '}
        Set <code className="rounded-sm bg-paper px-1 font-mono">ADMIN_PASSWORD</code> in the backend's{' '}
        <code className="rounded-sm bg-paper px-1 font-mono">.env</code> to unlock scheduled sourcing,
        connector management, and HubSpot/Outlook connect actions. Until then, these admin-only actions
        are unusable — not open.
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.auth.login(password);
      setPassword('');
      onAuthenticated();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-md border border-line bg-panel p-4">
      <h2 className="font-display text-sm font-bold">Administrator sign-in required</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Scheduled sourcing, connector management, and integration connect/disconnect are gated behind a
        real server-side session — not just this page's label. Sign in to continue.
      </p>
      <div className="mt-3 flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-mid">
          Password
          <input
            type="password"
            autoFocus
            className={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="rounded-sm border border-line bg-panel px-3 py-1.5 font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
    </form>
  );
}
