import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Application-wide sign-in gate.
 *
 * This wraps the ENTIRE app, outside the data providers, because
 * CompaniesProvider fetches every persisted company the moment it
 * mounts. Gating inside the providers would still leak the data — the
 * request would already be in flight before any UI decided to hide it.
 *
 * The server is the real boundary (see the whole-application gate in
 * server/app.ts, which 401s every /api route bar the auth handshake
 * and the two OAuth callbacks). This component exists so the browser
 * shows an honest sign-in screen instead of a page full of failed
 * requests — it is a usability layer over the enforcement, never the
 * enforcement itself.
 */
export function AppGate({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    api.auth
      .status()
      .then(setAuth)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  if (failed) return <Shell><BackendUnreachable onRetry={load} /></Shell>;
  if (auth === null) return <Shell><p className="text-sm text-slate-mid">Checking sign-in…</p></Shell>;
  if (!auth.authenticated) return <Shell><SignIn configured={auth.configured} onSignedIn={load} /></Shell>;

  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5">
          <div className="font-display text-lg font-semibold text-ink">Vamos Deal Radar</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-slate-mid">
            VamosVentures · internal
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function BackendUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
      <p className="font-semibold text-alerta">Cannot reach the backend.</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        The API did not respond. If you are running locally, start it with{' '}
        <code className="rounded-[2px] bg-paper px-1 font-mono">npm run dev</code>.
      </p>
      <button
        onClick={onRetry}
        className="mt-3 rounded-[2px] border border-line bg-panel px-3 py-1.5 text-xs font-semibold hover:border-marigold hover:text-marigold"
      >
        Retry
      </button>
    </div>
  );
}

function SignIn({ configured, onSignedIn }: { configured: boolean; onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fails closed by design: with no ADMIN_PASSWORD the backend 401s
  // everything, so there is no password that would work and we say so
  // rather than presenting a form that cannot succeed.
  if (!configured) {
    return (
      <div className="border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
        <p className="font-semibold text-alerta">Sign-in is not enabled.</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-mid">
          Set <code className="rounded-[2px] bg-paper px-1 font-mono">ADMIN_PASSWORD</code> in the
          backend&rsquo;s <code className="rounded-[2px] bg-paper px-1 font-mono">.env</code> and
          restart it. Until then the whole application is locked — not open.
        </p>
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
      onSignedIn();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border border-line bg-panel p-4 shadow-sm">
      <h1 className="font-display text-base font-semibold text-ink">Sign in</h1>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        This application holds sourced company records and is not public. Every API route requires
        this session — the sign-in is enforced by the server, not just this screen.
      </p>
      <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-mid">
        Password
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          className="mt-1 w-full rounded-[2px] border border-line bg-panel px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="mt-3 w-full rounded-[2px] border border-line bg-panel px-3 py-1.5 text-sm font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
    </form>
  );
}
