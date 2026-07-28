import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { IntegrationsProvider, useIntegrations } from './store/integrations';
import { CompaniesProvider } from './store/companies';
import { AppGate } from './components/AppGate';

// Route-level code splitting: each page (and its dependencies, e.g.
// Overview's Recharts import) becomes its own chunk fetched on
// navigation instead of all landing in one bundle up front.
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Companies = lazy(() => import('./pages/Companies').then((m) => ({ default: m.Companies })));
const StealthRadar = lazy(() => import('./pages/StealthRadar').then((m) => ({ default: m.StealthRadar })));
const Discovery = lazy(() => import('./pages/Discovery').then((m) => ({ default: m.Discovery })));
const DataSources = lazy(() => import('./pages/DataSources').then((m) => ({ default: m.DataSources })));

type NavItem = { to: string; label: string; hint?: string; icon: (cls: string) => ReactNode };

const ICON = {
  overview: (cls: string) => (
    <svg className={cls} viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 10 L10 3.3 A6.7 6.7 0 0 1 15.7 6.7 Z" fill="currentColor" fillOpacity="0.55" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
    </svg>
  ),
  companies: (cls: string) => (
    <svg className={cls} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2.5" y="4" width="15" height="2.6" rx="0.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="8.7" width="15" height="2.6" rx="0.4" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="13.4" width="9.5" height="2.6" rx="0.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  discovery: (cls: string) => (
    <svg className={cls} viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="8.3" cy="8.3" r="5.3" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12.4" y1="12.4" x2="17" y2="17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  stealth: (cls: string) => (
    <svg className={cls} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M1.7 10 C5 4.8, 15 4.8, 18.3 10 C15 15.2, 5 15.2, 1.7 10 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2.3" fill="currentColor" />
    </svg>
  ),
  settings: (cls: string) => (
    <svg className={cls} viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 2.3v2.3M10 15.4v2.3M17.7 10h-2.3M4.6 10H2.3M15.4 4.6l-1.6 1.6M6.2 13.8l-1.6 1.6M15.4 15.4l-1.6-1.6M6.2 6.2 4.6 4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
};

/**
 * Grouped, not flat: Portfolio (what's already on record) vs Sourcing
 * (finding what isn't yet) vs System — a real information architecture,
 * not a five-item list. This is a deal-discovery and screening tool,
 * not a second CRM: outreach happens from a company's detail view;
 * relationship management lives in HubSpot.
 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Portfolio',
    items: [
      { to: '/', label: 'Overview', icon: ICON.overview },
      { to: '/companies', label: 'Companies', icon: ICON.companies },
    ],
  },
  {
    label: 'Sourcing',
    items: [
      { to: '/discovery', label: 'Deal Discovery', icon: ICON.discovery },
      { to: '/stealth', label: 'Stealth Radar', icon: ICON.stealth },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/sources', label: 'Settings', hint: 'admin only', icon: ICON.settings }],
  },
];
const NAV_FLAT = NAV_GROUPS.flatMap((g) => g.items);

function sectionLabelFor(pathname: string): string {
  if (pathname === '/') return 'Overview';
  const match = NAV_FLAT.filter((n) => n.to !== '/').find((n) => pathname.startsWith(n.to));
  return match?.label ?? 'Overview';
}

/** The radar-sweep mark — the product's own signature motif, used once as the wordmark's glyph. */
function RadarMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden className="shrink-0">
      <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx="11" cy="11" r="6" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <path d="M11 11 L11 1.5 A9.5 9.5 0 0 1 18.7 5.7 Z" fill="currentColor" fillOpacity="0.55" />
      <circle cx="11" cy="11" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Two-tier brand: VamosVentures is the institutional label; Deal Radar is the product. Never one undifferentiated string. */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-marigold"><RadarMark size={compact ? 20 : 24} /></span>
      <div className="leading-none">
        <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.28em] text-white/45">VamosVentures</div>
        <div className={`font-display font-semibold tracking-tight text-white ${compact ? 'text-base' : 'mt-0.5 text-xl'}`}>Deal Radar</div>
      </div>
    </div>
  );
}

function Sidebar() {
  const { status, backendUp } = useIntegrations();
  const modeLabel = backendUp === false ? 'API offline' : status?.mode === 'live' ? 'Integrations configured' : 'No integrations connected';
  return (
    <aside className="relative flex w-full shrink-0 flex-col bg-ink text-white lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 lg:block lg:px-5 lg:py-5">
        <Brand compact />
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around gap-0.5 border-t border-white/10 bg-ink px-1 py-1 lg:static lg:z-auto lg:flex-1 lg:flex-col lg:items-stretch lg:justify-start lg:gap-3.5 lg:border-0 lg:bg-transparent lg:px-3 lg:py-0"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="contents lg:block">
            <div className="hidden px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/30 lg:block">
              {group.label}
            </div>
            <div className="contents lg:flex lg:flex-col lg:gap-0.5">
              {group.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/'}
                  className={({ isActive }) =>
                    `group relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-[2px] py-1.5 text-[10px] transition-colors lg:flex-none lg:flex-row lg:items-center lg:gap-2.5 lg:py-1.5 lg:pl-3 lg:pr-2.5 lg:text-[13px] ${
                      isActive
                        ? 'bg-white/[0.06] font-semibold text-marigold lg:text-white'
                        : 'text-white/55 hover:text-white lg:text-white/65'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`absolute inset-x-2 -top-[3px] h-[2px] rounded-full bg-marigold transition-opacity lg:inset-y-1 lg:inset-x-auto lg:left-0 lg:top-auto lg:w-[2px] lg:h-auto ${isActive ? 'opacity-100' : 'opacity-0'}`}
                        aria-hidden
                      />
                      {n.icon('h-[18px] w-[18px] lg:h-4 lg:w-4')}
                      <span className="lg:whitespace-nowrap">{n.label}</span>
                      {n.hint && <span className="hidden font-mono text-[9px] uppercase text-white/35 lg:ml-auto lg:inline">{n.hint}</span>}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="hidden px-5 pb-5 font-mono text-[10px] leading-relaxed text-white/45 lg:block">
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

/** Slim console frame above every page: breadcrumb context + live system pulse. */
function TopBar() {
  const location = useLocation();
  const { status, backendUp } = useIntegrations();
  const section = sectionLabelFor(location.pathname);
  const live = backendUp !== false && status?.mode === 'live';
  const dotClass = backendUp === false ? 'bg-alerta' : live ? 'bg-verde' : 'bg-marigold';
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-white/10 bg-ink px-6 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-white/45 max-lg:hidden lg:px-9">
      <span className="text-white/35">VamosVentures</span>
      <span className="text-white/20">/</span>
      <span className="text-white/80">Deal Radar</span>
      <span className="text-white/20">/</span>
      <span className="text-marigold">{section}</span>
      <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-white/50">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        {backendUp === false ? 'API offline' : live ? 'Live sourcing' : 'Local mode'}
      </span>
    </div>
  );
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
    <AppGate>
    <IntegrationsProvider>
      <CompaniesProvider>
      <div className="flex min-h-screen max-lg:flex-col">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-w-0 flex-1 px-5 py-6 pb-24 max-lg:pt-4 lg:px-10 lg:py-8 lg:pb-8">
            <div className="mx-auto max-w-[1680px]">
              <Suspense fallback={<PageLoading />}>
                <Routes>
                  <Route path="/" element={<Overview />} />
                  <Route path="/companies" element={<Companies />} />
                  <Route path="/health" element={<VerticalRedirect vertical="health" />} />
                  <Route path="/fintech" element={<VerticalRedirect vertical="fintech" />} />
                  <Route path="/future-of-work" element={<VerticalRedirect vertical="fow" />} />
                  <Route path="/sustainability" element={<VerticalRedirect vertical="sustainability" />} />
                  <Route path="/robotics" element={<VerticalRedirect vertical="robotics" />} />
                  <Route path="/space-tech" element={<VerticalRedirect vertical="spacetech" />} />
                  <Route path="/ai" element={<VerticalRedirect vertical="ai" />} />
                  <Route path="/areas-of-interest" element={<VerticalRedirect vertical="aoi" />} />
                  <Route path="/stealth" element={<StealthRadar />} />
                  <Route path="/discovery" element={<Discovery />} />
                  <Route path="/pipeline" element={<Navigate to="/companies" replace />} />
                  <Route path="/sources" element={<DataSources />} />
                  <Route path="*" element={<Overview />} />
                </Routes>
              </Suspense>
            </div>
          </main>
        </div>
      </div>
      </CompaniesProvider>
    </IntegrationsProvider>
    </AppGate>
  );
}

function PageLoading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-mid" role="status" aria-live="polite">
      <svg width="16" height="16" viewBox="0 0 16 16" className="animate-spin text-marigold" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M8 1.5 A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Loading VamosVentures Deal Radar…
    </div>
  );
}
