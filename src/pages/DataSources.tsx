import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { IntegrationCards } from '../components/IntegrationCards';
import { ConnectorPanel } from '../components/Connectors';
import { PortfolioPanel } from '../components/Portfolio';
import { useIntegrations } from '../store/integrations';


export function DataSources() {
  const [params, setParams] = useSearchParams();
  const { refresh } = useIntegrations();
  const [connectedBanner, setConnectedBanner] = useState<string | null>(null);

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
        title="Data Sources & Refresh Settings"
        blurb="What feeds the radar, how often it refreshes, and the rules every source must follow. The MVP ships with a bundled sample dataset; live connectors validate through the same Zod schemas in src/data/loader.ts."
      />

      {connectedBanner && (
        <div className="mb-4 rounded-sm bg-verde-soft px-3 py-2 text-sm text-verde">{connectedBanner}</div>
      )}

      <IntegrationCards />

      <ConnectorPanel />

      <PortfolioPanel />

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-line bg-panel p-4">
          <h2 className="font-display text-sm font-bold">Data rules (enforced in code)</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-slate-mid">
            <li><span className="font-semibold text-ink">Demographics are verified or absent.</span> Latino-led, female-led, and other indicators appear only with a self-identification basis and a named source. The Zod schema rejects any record without one; nothing is ever inferred from names, photos, or location.</li>
            <li><span className="font-semibold text-ink">Every recommendation is auditable.</span> Companies without at least one sourced evidence item fail validation and never reach the UI.</li>
            <li><span className="font-semibold text-ink">Public sources only.</span> Signals come from information people chose to publish. No private-data scraping.</li>
            <li><span className="font-semibold text-ink">Human-in-the-loop outreach.</span> The system tracks outreach; it never sends it.</li>
            <li><span className="font-semibold text-ink">Exceptions flag, never reject.</span> DeFi/blockchain and hardware-heavy companies are routed to partner review with a visible warning.</li>
          </ul>
        </div>
        <div className="rounded-md border border-line bg-panel p-4">
          <h2 className="font-display text-sm font-bold">Wiring live data</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-mid">
            The app runs on a local data layer by default. To go live: (1) add Supabase credentials to <code className="rounded-sm bg-paper px-1 font-mono">.env</code> as <code className="rounded-sm bg-paper px-1 font-mono">VITE_SUPABASE_URL</code> / <code className="rounded-sm bg-paper px-1 font-mono">VITE_SUPABASE_ANON_KEY</code>, (2) point <code className="rounded-sm bg-paper px-1 font-mono">loadCompanies()</code> in <code className="rounded-sm bg-paper px-1 font-mono">src/data/loader.ts</code> at your tables, keeping the existing schemas as the validation gate, (3) swap the pipeline store's localStorage persistence for the same table so the team shares one pipeline. Scoring weights live in <code className="rounded-sm bg-paper px-1 font-mono">src/lib/scoring.ts</code> and can be tuned without touching the UI.
          </p>
        </div>
      </section>
    </div>
  );
}
