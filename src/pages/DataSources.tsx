import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { SystemStatus } from '../components/SystemStatus';
import { IntegrationCards } from '../components/IntegrationCards';
import { ConnectorPanel } from '../components/Connectors';
import { SchedulePanel } from '../components/Schedule';
import { PortfolioPanel } from '../components/Portfolio';
import { AdminLogin } from '../components/AdminLogin';
import { StaleSettingsPanel } from '../components/StaleSettingsPanel';
import { SourceAnalyticsPanel } from '../components/SourceAnalytics';
import { DiversityAnalyticsPanel } from '../components/DiversityAnalytics';
import { BackupPanel } from '../components/BackupPanel';
import { useIntegrations } from '../store/integrations';
import { api } from '../lib/api';


export function DataSources() {
  const [params, setParams] = useSearchParams();
  const { refresh } = useIntegrations();
  const [connectedBanner, setConnectedBanner] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ configured: boolean; authenticated: boolean } | null>(null);

  const loadAuth = useCallback(() => {
    api.auth.status().then(setAuth).catch(() => setAuth({ configured: false, authenticated: false }));
  }, []);
  useEffect(loadAuth, [loadAuth]);

  const logout = async () => {
    await api.auth.logout().catch(() => {});
    // Re-read auth state in place. This deliberately re-locks the Settings
    // panel behind "Administrator sign-in required" rather than navigating
    // away — the admin plane is what was unlocked, so the admin plane is
    // what visibly re-locks. Every API call now 401s regardless, and any
    // navigation re-evaluates AppGate. Covered by e2e/auth.spec.ts
    // ("logout re-locks Settings").
    loadAuth();
  };

  // Handle OAuth callback redirects (?outlook=connected / ?hubspot=connected)
  useEffect(() => {
    let banner: string | null = null;
    if (params.get('outlook') === 'connected') banner = `Outlook connected as ${params.get('account') ?? 'your Microsoft account'}. Drafts can now be saved to that mailbox.`;
    if (params.get('hubspot') === 'connected') banner = 'HubSpot connected via OAuth. Records can now sync to your portal.';
    if (banner) {
      setConnectedBanner(banner);
      void refresh();
      const next = new URLSearchParams(params);
      next.delete('outlook');
      next.delete('account');
      next.delete('hubspot');
      setParams(next, { replace: true });
    }
  }, [params, setParams, refresh]);

  return (
    <div>
      <PageHeader
        eyebrow="Configuration"
        title="Settings — Admin Only"
        blurb="What feeds the radar, how often it refreshes, and the rules every source must follow. Nothing is pre-populated: companies enter only through validated CSV imports or Deal Discovery, and integrations that are not connected say so."
      />

      <div className="mb-4 flex items-start justify-between gap-3 border border-alerta/40 border-l-[3px] border-l-alerta bg-alerta-soft px-4 py-3 text-sm">
        <div>
          <span className="font-semibold text-alerta">Administrators only.</span>{' '}
          Changes to these settings may affect live sourcing, scoring, integrations, and data quality.
          Do not modify without administrator approval. Enforced by a real sign-in below, not just this label.
        </div>
        {auth?.authenticated && (
          <button onClick={logout} className="shrink-0 rounded-[2px] border border-line bg-panel px-2 py-1 text-xs font-semibold transition-colors hover:border-marigold hover:text-marigold">
            Sign out
          </button>
        )}
      </div>

      {connectedBanner && (
        <div className="mb-4 rounded-[2px] bg-verde-soft px-3 py-2 text-sm text-verde">{connectedBanner}</div>
      )}

      {auth === null ? null : !auth.authenticated ? (
        <AdminLogin configured={auth.configured} onAuthenticated={loadAuth} />
      ) : (
        <>
          <SystemStatus />

          <IntegrationCards />

          <ConnectorPanel />

          <SchedulePanel />

          <SourceAnalyticsPanel />
          <DiversityAnalyticsPanel />

          <BackupPanel />

          <StaleSettingsPanel />
        </>
      )}

      <PortfolioPanel />

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="border border-line bg-panel p-4 shadow-sm">
          <h2 className="font-display text-base font-semibold text-ink">Data rules (enforced in code)</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-slate-mid">
            <li><span className="font-semibold text-ink">Demographics are verified or absent.</span> Latino-led, female-led, and other indicators appear only with a self-identification basis and a named source. The Zod schema rejects any record without one; nothing is ever inferred from names, photos, or location.</li>
            <li><span className="font-semibold text-ink">Every recommendation is auditable.</span> Companies without at least one sourced evidence item fail validation and never reach the UI.</li>
            <li><span className="font-semibold text-ink">Public sources only.</span> Signals come from information people chose to publish. No private-data scraping.</li>
            <li><span className="font-semibold text-ink">Human-in-the-loop outreach.</span> The system tracks outreach; it never sends it.</li>
            <li><span className="font-semibold text-ink">Exceptions flag, never reject.</span> DeFi/blockchain and hardware-heavy companies are routed to partner review with a visible warning.</li>
          </ul>
        </div>
        <div className="border border-line bg-panel p-4 shadow-sm">
          <h2 className="font-display text-base font-semibold text-ink">Wiring live data</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-mid">
            Companies enter through the Local CSV connector or Deal Discovery — both validate server-side with the same guardrails (sourced evidence required, identity columns refused). Integrations go live by adding credentials to the backend <code className="rounded-[2px] bg-paper px-1 font-mono">.env</code> (see <code className="rounded-[2px] bg-paper px-1 font-mono">.env.example</code>); until then every card reports an honest not-connected state. Scoring weights live in <code className="rounded-[2px] bg-paper px-1 font-mono">src/lib/scoring.ts</code> and can be tuned without touching the UI.
          </p>
        </div>
      </section>
    </div>
  );
}
