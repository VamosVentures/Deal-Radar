import { NavLink, Route, Routes } from 'react-router-dom';
import { PipelineProvider, usePipeline } from './store/pipeline';
import { IntegrationsProvider, useIntegrations } from './store/integrations';
import { CompaniesProvider } from './store/companies';
import { Overview } from './pages/Overview';
import { VerticalPage } from './pages/Vertical';
import { StealthRadar } from './pages/StealthRadar';
import { Discovery } from './pages/Discovery';
import { OutreachPipeline } from './pages/Outreach';
import { DataSources } from './pages/DataSources';

const NAV: { to: string; label: string; hint?: string }[] = [
  { to: '/', label: 'Overview' },
  { to: '/discovery', label: 'Deal Discovery' },
  { to: '/health', label: 'Health & Wellness' },
  { to: '/fintech', label: 'FinTech' },
  { to: '/future-of-work', label: 'Future of Work' },
  { to: '/sustainability', label: 'Sustainability' },
  { to: '/areas-of-interest', label: 'Areas of Interest', hint: 'adjacent' },
  { to: '/stealth', label: 'Stealth Founder Radar' },
  { to: '/pipeline', label: 'Outreach Pipeline' },
  { to: '/sources', label: 'Data Sources & Refresh' },
];

function Sidebar() {
  const { items } = usePipeline();
  const { status, backendUp } = useIntegrations();
  const active = items.filter((i) => i.stage !== 'Passed' && i.stage !== 'Invested').length;
  const modeLabel = backendUp === false ? 'API offline' : status?.mode === 'live' ? 'Live integrations' : 'Demo Mode';
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-ink text-white max-lg:w-full max-lg:flex-row max-lg:items-center max-lg:overflow-x-auto lg:min-h-screen">
      <div className="px-5 py-5 max-lg:py-3">
        <div className="font-display text-lg font-extrabold leading-none tracking-tight">
          Vamos <span className="text-marigold">Deal Radar</span>
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-white/50 max-lg:hidden">
          VamosVentures · internal
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-3 pb-5 max-lg:flex-row max-lg:pb-0" aria-label="Main">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `rounded-sm px-2.5 py-1.5 text-[13px] transition-colors max-lg:whitespace-nowrap ${
                isActive ? 'bg-white/10 font-semibold text-marigold' : 'text-white/75 hover:bg-white/5 hover:text-white'
              }`
            }
          >
            {n.label}
            {n.to === '/pipeline' && active > 0 && (
              <span className="ml-2 rounded-sm bg-marigold px-1 font-mono text-[10px] font-bold text-ink">{active}</span>
            )}
            {n.hint && <span className="ml-2 font-mono text-[9px] uppercase text-white/40">{n.hint}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto px-5 pb-5 font-mono text-[10px] leading-relaxed text-white/40 max-lg:hidden">
        <span className={backendUp === false ? 'text-alerta' : status?.mode === 'live' ? 'text-verde' : 'text-marigold'}>● {modeLabel}</span>
        {status?.statuses && (
          <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5" aria-label="Integration status">
            {(['hubspot', 'outlook', 'ai', 'refresh'] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-2" title={status.statuses[k].detail}>
                <span className="capitalize">{k === 'ai' ? 'AI provider' : k === 'refresh' ? 'Data refresh' : k}</span>
                <StatusDot s={status.statuses[k].status} />
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 border-t border-white/10 pt-1.5">
          Sample data · MVP target Jul 24, 2026
          <br />Demographics: verified / self-ID only
          <br />Outreach: drafts only, humans send
        </div>
      </div>
    </aside>
  );
}

function StatusDot({ s }: { s: string }) {
  const tone =
    s === 'Connected' ? 'text-verde'
    : s === 'Local Mode' ? 'text-marigold'
    : s === 'Disconnected' || s === 'Configuration required' ? 'text-white/50'
    : 'text-alerta'; // Expired / Error
  return <span className={tone}>{s}</span>;
}

export default function App() {
  return (
    <PipelineProvider>
      <IntegrationsProvider>
      <CompaniesProvider>
      <div className="flex min-h-screen max-lg:flex-col">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-6 lg:px-8">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/health" element={<VerticalPage id="health" />} />
            <Route path="/fintech" element={<VerticalPage id="fintech" />} />
            <Route path="/future-of-work" element={<VerticalPage id="fow" />} />
            <Route path="/sustainability" element={<VerticalPage id="sustainability" />} />
            <Route path="/areas-of-interest" element={<VerticalPage id="aoi" />} />
            <Route path="/stealth" element={<StealthRadar />} />
            <Route path="/discovery" element={<Discovery />} />
            <Route path="/pipeline" element={<OutreachPipeline />} />
            <Route path="/sources" element={<DataSources />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </main>
      </div>
      </CompaniesProvider>
      </IntegrationsProvider>
    </PipelineProvider>
  );
}
