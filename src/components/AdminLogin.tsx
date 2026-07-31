import { useState } from 'react';
import { api, ApiError, type AuthStatus } from '../lib/api';

const input = 'rounded-[2px] border border-line bg-panel px-2 py-1';

/**
 * Real server-side gate for Settings' admin-only actions — previously
 * this page was reachable and fully functional to anyone who could
 * load the URL; now the admin panels (system status, connectors,
 * scheduled sourcing, HubSpot/Outlook connect) require a real session
 * the backend verifies on every request (see server/lib/auth.ts).
 *
 * Reached in practice only after "Sign out" re-locks this page in
 * place — AppGate keeps unauthenticated visitors out of the app
 * entirely — so it mirrors whichever providers AppGate offers rather
 * than assuming a password is the way back in.
 */
export function AdminLogin({ auth, onAuthenticated }: { auth: AuthStatus; onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msBusy, setMsBusy] = useState(false);

  if (!auth.configured) {
    return (
      <div className="border border-alerta/40 bg-alerta-soft px-4 py-3 text-sm">
        <span className="font-semibold text-alerta">Administrator sign-in is not enabled.</span>{' '}
        Set <code className="rounded-[2px] bg-paper px-1 font-mono">ADMIN_PASSWORD</code> in the backend's{' '}
        <code className="rounded-[2px] bg-paper px-1 font-mono">.env</code> to unlock scheduled sourcing,
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

  const signInWithMicrosoft = async () => {
    setMsBusy(true);
    setErr(null);
    try {
      const { authUrl } = await api.auth.microsoftStart();
      window.location.assign(authUrl);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Microsoft sign-in could not be started.');
      setMsBusy(false);
    }
  };

  return (
    <div className="border border-line bg-panel p-4 shadow-sm">
      <h2 className="font-display text-base font-semibold text-ink">Administrator sign-in required</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Scheduled sourcing, connector management, and integration connect/disconnect are gated behind a
        real server-side session — not just this page's label. Sign in to continue.
      </p>

      {auth.microsoftLoginAvailable && (
        <button
          type="button"
          onClick={signInWithMicrosoft}
          disabled={msBusy}
          className="mt-3 rounded-[2px] border border-line bg-panel px-3 py-1.5 text-xs font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
        >
          {msBusy ? 'Redirecting to Microsoft…' : 'Sign in with your Vamos Microsoft account'}
        </button>
      )}

      {/* An explanation rather than a disabled button — what is missing is an administrator action outside this app. */}
      {auth.microsoftPending && (
        <p className="mt-3 border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-slate-mid">
          <span className="font-semibold text-ink">
            {auth.microsoftPendingMessage ?? 'Awaiting Microsoft administrator configuration'}
          </span>{' '}
          — use the administrator password until Microsoft sign-in is switched on.
        </p>
      )}

      {/*
        The default deployment's honest status: the password works today
        and is on its way out. Stated so nobody reads this form and
        concludes a shared password is how this application is meant to
        be secured — it is a stopgap with a defined end.
      */}
      {auth.awaitingSsoCutover && (
        <div className="mt-3 border border-line border-l-[3px] border-l-marigold bg-paper px-3 py-2 text-xs leading-relaxed text-slate-mid">
          <p className="font-semibold text-ink">
            Sign-in is moving to Microsoft single sign-on
          </p>
          <p className="mt-1">
            {auth.awaitingSsoCutoverMessage
              ?? `Access will be limited to @${auth.allowedEmailDomain ?? 'vamosventures.com'} accounts.`}
          </p>
        </div>
      )}

      {auth.localLoginAvailable ? (
        <form onSubmit={submit} className="mt-3 flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-mid">
            Password
            <input
              type="password"
              autoFocus={!auth.microsoftLoginAvailable}
              className={input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="rounded-[2px] border border-line bg-panel px-3 py-1.5 font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
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
