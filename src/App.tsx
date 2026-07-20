import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { IntegrationsProvider, useIntegrations } from './store/integrations';
import { CompaniesProvider } from './store/companies';

// Route-level code splitting: each page (and its dependencies, e.g.
// Overview's Recharts import) becomes its own chunk fetched on
// navigation instead of all landing in one bundle up front.
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Companies = lazy(() => import('./pages/Companies').then((m) => ({ default: m.Companies })));
const StealthRadar = lazy(() => import('./pages/StealthRadar').then((m) => ({ default: m.StealthRadar })));
const Discovery = lazy(() => import('./pages/Discovery').then((m) => ({ default: m.Discovery })));
const DataSources = lazy(() => import('./pages/DataSources').then((m) => ({ default: m.DataSources })));

/**
 * Focused navigation: this is a deal-discovery and screening tool,
 * not a second CRM. Outreach happens from a company's detail view;
 * relationship management lives in HubSpot.
 */
const NAV: { to: string; label: string; hint?: string }[] = [
  { to: '/', label: 'Overview' },
  { to: '/discovery', label: 'Deal Discovery' },
  { to: '/companies', label: 'Companies' },
  { to: '/stealth', label: 'Stealth Radar' },
  { to: '/sources', label: 'Settings', hint: 'admin only' },
];

function Sidebar() {
  const { status, backendUp } = useIntegrations();
  const modeLabel = backendUp === false ? 'API offline' : status?.mode === 'live' ? 'Integrations configured' : 'No integrations connected';
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
          Demographics: verified / self-ID only
          <br />Outreach: drafts only, humans send
        </div>
      </div>
    </aside>
  );
}

function StatusDot({ s }: { s: string }) {
  const tone =
    s === 'Connected' ? 'text-verde'
    : s === 'Not connected' || s === 'Disconnected' || s === 'Configuration required' ? 'text-white/50'
    : 'text-alerta'; // Expired / Error
  return <span className={tone}>{s}</span>;
}

/** Old per-vertical routes → the Companies page, pre-filtered. */
function VerticalRedirect({ vertical }: { vertical: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set('vertical', vertical);
  return <Navigate to={`/companies?${params.toString()}`} replace />;
}

export default function App() {
  return (
    <IntegrationsProvider>
      <CompaniesProvider>
      <div className="flex min-h-screen max-lg:flex-col">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-6 lg:px-8">
          <Suspense fallback={<div className="text-sm text-slate-mid">Loading…</div>}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/companies" element={<Companies />} />
              <Route path="/health" element={<VerticalRedirect vertical="health" />} />
              <Route path="/fintech" element={<VerticalRedirect vertical="fintech" />} />
              <Route path="/future-of-work" element={<VerticalRedirect vertical="fow" />} />
              <Route path="/sustainability" element={<VerticalRedirect vertical="sustainability" />} />
              <Route path="/areas-of-interest" element={<VerticalRedirect vertical="aoi" />} />
              <Route path="/stealth" element={<StealthRadar />} />
              <Route path="/discovery" element={<Discovery />} />
              <Route path="/pipeline" element={<Navigate to="/companies" replace />} />
              <Route path="/sources" element={<DataSources />} />
              <Route path="*" element={<Overview />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      </CompaniesProvider>
    </IntegrationsProvider>
  );
}
