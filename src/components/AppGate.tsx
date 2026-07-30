import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AuthStatus } from '../lib/api';

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
  const [auth, setAuth] = useState<AuthStatus | null>(null);
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
  if (!auth.authenticated) return <Shell><SignIn auth={auth} onSignedIn={load} /></Shell>;

  return <>{children}</>;
}

/**
 * Why a Microsoft sign-in came back refused.
 *
 * The server redirects here with `?signin=failed&reason=…` and the
 * reason is a message it authored for a person — "That account is not
 * in the Vamos Ventures Microsoft directory", not a stack trace or an
 * error code. Showing it is the difference between someone
 * understanding that their guest account was rejected and staring at a
 * screen that simply refuses them.
 *
 * The parameters are stripped from the URL once read so a refresh (or a
 * shared link) does not resurface a stale failure.
 */
function useSignInRedirectNotice(): string | null {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('signin') === 'failed') {
      setReason(params.get('reason') || 'Microsoft sign-in did not complete.');
    }
    if (params.has('signin')) {
      params.delete('signin');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}`,
      );
    }
  }, []);
  return reason;
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

/** Microsoft's four-square mark, drawn inline — no remote asset to fetch. */
function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="0" y="0" width="7.4" height="7.4" fill="#F25022" />
      <rect x="8.6" y="0" width="7.4" height="7.4" fill="#7FBA00" />
      <rect x="0" y="8.6" width="7.4" height="7.4" fill="#00A4EF" />
      <rect x="8.6" y="8.6" width="7.4" height="7.4" fill="#FFB900" />
    </svg>
  );
}

function SignIn({ auth, onSignedIn }: { auth: AuthStatus; onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msBusy, setMsBusy] = useState(false);
  const redirectNotice = useSignInRedirectNotice();

  // Fails closed by design: with no provider configured the backend
  // 401s everything, so there is no credential that would work and we
  // say so rather than presenting a form that cannot succeed.
  if (!auth.configured) {
    return (
      <div className="border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
        <p className="font-semibold text-alerta">Sign-in is not enabled.</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-mid">
          Set <code className="rounded-[2px] bg-paper px-1 font-mono">ADMIN_PASSWORD</code> in the
          backend&rsquo;s <code className="rounded-[2px] bg-paper px-1 font-mono">.env</code> (or
          finish the Microsoft configuration) and restart it. Until then the whole application is
          locked — not open.
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

  const signInWithMicrosoft = async () => {
    setMsBusy(true);
    setErr(null);
    try {
      const { authUrl } = await api.auth.microsoftStart();
      // A full navigation, not fetch: the OpenID Connect flow is a
      // browser redirect and must be able to show Microsoft's own
      // sign-in and consent screens.
      window.location.assign(authUrl);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Microsoft sign-in could not be started.');
      setMsBusy(false);
    }
  };

  return (
    <div className="border border-line bg-panel p-4 shadow-sm">
      <h1 className="font-display text-base font-semibold text-ink">Sign in</h1>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        This application holds sourced company records and is not public. Every API route requires
        this session — the sign-in is enforced by the server, not just this screen.
      </p>

      {redirectNotice && (
        <p className="mt-3 border border-alerta/40 bg-alerta-soft px-3 py-2 text-xs leading-relaxed text-alerta">
          {redirectNotice}
        </p>
      )}

      {auth.microsoftLoginAvailable && (
        <button
          type="button"
          onClick={signInWithMicrosoft}
          disabled={msBusy}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[2px] border border-line bg-panel px-3 py-2 text-sm font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
        >
          <MicrosoftMark />
          {msBusy ? 'Redirecting to Microsoft…' : 'Sign in with your Vamos Microsoft account'}
        </button>
      )}

      {/*
        Requested but not configured. An explanation, deliberately NOT a
        disabled button: a greyed-out control invites clicking and
        implies the feature is a moment away, when what is actually
        missing is an administrator action outside this app.
      */}
      {auth.microsoftPending && (
        <div className="mt-3 border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-slate-mid">
          <p className="font-semibold text-ink">
            {auth.microsoftPendingMessage ?? 'Awaiting Microsoft administrator configuration'}
          </p>
          <p className="mt-1">
            Microsoft sign-in is built and waiting on credentials for the Vamos tenant. Use the
            administrator password below until it is switched on.
          </p>
        </div>
      )}

      {auth.microsoftLoginAvailable && auth.localLoginAvailable && (
        <div className="mt-4 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-slate-mid">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      )}

      {auth.localLoginAvailable ? (
        <form onSubmit={submit}>
          <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-mid">
            Administrator password
            <input
              type="password"
              autoFocus={!auth.microsoftLoginAvailable}
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
        </form>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-slate-mid">
          Password sign-in is turned off for this deployment. Use your Vamos Microsoft account.
        </p>
      )}

      {err && <p className="mt-2 text-xs text-alerta">{err}</p>}
    </div>
  );
}
