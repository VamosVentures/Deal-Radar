import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type HubSpotSearchHit } from '../lib/api';
import { useIntegrations } from '../store/integrations';
import { btnGhost, btnPrimary, ErrorNote } from './Modal';
import {
  AI_UNAVAILABLE_STATUS,
  OUTLOOK_UNAVAILABLE_STATUS,
  RADAR_HUBSPOT_STAGES,
  type HubSpotPipelineInfo,
  type HubSpotPipelineMapping,
  type IntegrationConnection,
} from '../../shared/integrations';

/**
 * Settings cards for the three integrations. Secrets never appear
 * here — credentials live only in the backend's .env; these cards
 * show status, connection controls, and the pipeline mapping.
 */
export function IntegrationCards() {
  const { status, backendUp, refresh } = useIntegrations();

  if (backendUp === false) {
    return (
      <section className="mt-6">
        <h2 className="mb-2 font-display text-base font-semibold text-ink">Integrations</h2>
        <ErrorNote
          message="The Deal Radar backend is not running."
          hint="Integration status, HubSpot sync, and Outlook drafts need the API. Start everything with `npm run dev`."
        />
      </section>
    );
  }
  if (!status) return <p className="mt-6 text-sm text-slate-mid">Checking integration status…</p>;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Integrations</h2>
      </div>
      <p className="mb-3 max-w-3xl text-xs text-slate-mid">
        Credentials live only in the backend&rsquo;s <code className="rounded-[2px] bg-paper px-1 font-mono">.env</code> — the browser never sees tokens or keys, and this
        page never displays saved secrets. Each integration goes live independently once its credentials exist; until then
        it is simply not connected and every action fails with an honest error. See <code className="rounded-[2px] bg-paper px-1 font-mono">.env.example</code>.
      </p>
      <div className="grid gap-4 xl:grid-cols-3">
        <HubSpotCard conn={status.hubspot} refreshAll={refresh} />
        <OutlookCard conn={status.outlook} refreshAll={refresh} />
        <AiCard conn={status.ai} />
      </div>
    </section>
  );
}

/**
 * The badge for an unconfigured connector.
 *
 * Outlook and AI get specific wording rather than the generic
 * "Implemented — credentials required", which describes the state of the
 * code and leaves a reviewer unable to tell a broken feature from a
 * deliberately unconfigured one.
 */
function unavailableLabel(provider: IntegrationConnection['provider']): string {
  if (provider === 'outlook') return OUTLOOK_UNAVAILABLE_STATUS;
  if (provider === 'ai') return AI_UNAVAILABLE_STATUS;
  return 'Implemented — credentials required';
}

function CardShell({ title, conn, children }: { title: string; conn: IntegrationConnection; children: React.ReactNode }) {
  return (
    <div className="flex flex-col border border-line bg-panel p-4">
      <div className="flex items-start gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className={`ml-auto rounded-[2px] px-1.5 py-0.5 text-right font-mono text-[10px] font-bold uppercase ${conn.connected ? 'bg-verde-soft text-verde' : 'bg-marigold-soft text-marigold'}`}>
          {conn.mode === 'live' ? (conn.connected ? 'Connected' : 'Configured · not connected') : unavailableLabel(conn.provider)}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-mid">{conn.detail}</p>
      {conn.account && (
        <div className="mt-1.5 font-mono text-[11px] text-ink">
          {conn.account}
        </div>
      )}
      {conn.permissions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {conn.permissions.map((p) => (
            <span key={p} className="rounded-[2px] bg-paper px-1.5 py-0.5 font-mono text-[10px] text-slate-mid">{p}</span>
          ))}
        </div>
      )}
      {conn.lastConnectedAt && (
        <div className="mt-1 font-mono text-[10px] text-slate-mid">Last connected {conn.lastConnectedAt.slice(0, 16).replace('T', ' ')}</div>
      )}
      <div className="mt-3 border-t border-line pt-3">{children}</div>
    </div>
  );
}

// ── HubSpot ──────────────────────────────────────────────────────

function HubSpotCard({ conn, refreshAll }: { conn: IntegrationConnection; refreshAll: () => Promise<void> }) {
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [busy, setBusy] = useState(false);

  async function testConnection() {
    setError(null);
    setTestResult(null);
    try {
      const v = await api.hubspot.verify();
      setTestResult(v.ok ? `Verified: ${v.detail}` : `Verification failed: ${v.detail}`);
    } catch (e) {
      setError(e as ApiError);
    }
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.hubspot.connect();
      if (res.authUrl) window.location.href = res.authUrl; // real HubSpot sign-in
      else setTestResult(res.message);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.hubspot.disconnect();
      setTestResult('Disconnected. OAuth tokens were removed from the backend.');
      await refreshAll();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="HubSpot CRM" conn={conn}>
      <div className="space-y-2 text-xs text-slate-mid">
        <div>Auth type: <span className="font-mono text-ink">{conn.mode === 'live' ? (conn.account === 'oauth' ? 'OAuth (user connection)' : 'private-app token / OAuth') : 'none — not connected'}</span> (secrets stay on the backend)</div>
        <div>Property mapping: Deal Radar fields write onto Vamos's own existing Company/Deal/Contact properties — the same ones every other deal in the portal uses. No new custom property is ever created (see README for the exact mapping).</div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button className={btnGhost} onClick={testConnection} disabled={busy}>Test connection</button>
          {!conn.connected && <button className={btnGhost} onClick={connect} disabled={busy}>Connect (OAuth)</button>}
          {conn.connected && conn.mode === 'live' && <button className={btnGhost} onClick={disconnect} disabled={busy}>Disconnect</button>}
          <button className={btnPrimary} onClick={() => setShowMapping((s) => !s)}>
            {showMapping ? 'Hide pipeline mapping' : 'Pipeline mapping'}
          </button>
        </div>
        {testResult && <div className="rounded-[2px] bg-paper px-2 py-1.5">{testResult}</div>}
        {error && <ErrorNote message={error.message} hint={error.hint} />}
        {showMapping && <PipelineMappingEditor />}
        <HubSpotSearch />
        <SyncHistory provider="hubspot" />
      </div>
    </CardShell>
  );
}

function HubSpotSearch() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'companies' | 'contacts' | 'deals'>('companies');
  const [hits, setHits] = useState<HubSpotSearchHit[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function search() {
    if (query.trim().length === 0) return;
    setError(null);
    try {
      const res = await api.hubspot.search(query.trim(), type);
      setHits(res.hits);
    } catch (e) {
      setError(e as ApiError);
      setHits(null);
    }
  }

  return (
    <div className="border-t border-line pt-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider">Search HubSpot</div>
      <div className="flex flex-wrap gap-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder={type === 'companies' ? 'Company name or domain' : 'Name or email'}
          className="min-w-40 flex-1 rounded-[2px] border border-line bg-panel px-2 py-1"
          aria-label="HubSpot search query"
        />
        <select value={type} onChange={(e) => setType(e.target.value as 'companies' | 'contacts' | 'deals')} className="rounded-[2px] border border-line bg-panel px-1.5 py-1" aria-label="Record type">
          <option value="companies">Companies</option>
          <option value="contacts">Contacts</option>
          <option value="deals">Deals</option>
        </select>
        <button className={btnGhost} onClick={search}>Search</button>
      </div>
      {error && <div className="mt-1.5"><ErrorNote message={error.message} hint={error.hint} /></div>}
      {hits && (
        <ul className="mt-1.5 divide-y divide-line rounded-[2px] border border-line">
          {hits.length === 0 && <li className="px-2 py-1.5">No matches.</li>}
          {hits.map((h) => (
            <li key={`${h.type}-${h.recordId}`} className="flex items-center gap-2 px-2 py-1.5">
              <span className="font-mono text-[10px] uppercase text-slate-mid">{h.type}</span>
              <span className="font-semibold text-ink">{h.title}</span>
              <span>{h.subtitle}</span>
              {h.url
                ? <a href={h.url} target="_blank" rel="noreferrer" className="ml-auto text-verde underline">Open in HubSpot</a>
                : <span className="ml-auto font-mono text-[10px]">no portal link (set HUBSPOT_PORTAL_ID)</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SyncHistory({ provider }: { provider: string }) {
  const [entries, setEntries] = useState<{ at: string; action: string; subject: string; outcome: string; detail: string }[] | null>(null);
  return (
    <div className="border-t border-line pt-2">
      <button
        className="font-mono text-[10px] uppercase tracking-wider underline decoration-dotted hover:text-ink"
        onClick={async () => {
          if (entries) { setEntries(null); return; }
          try {
            const res = await fetch('/api/audit');
            const data = (await res.json()) as { at: string; provider: string; action: string; subject: string; outcome: string; detail: string }[];
            setEntries(data.filter((e) => e.provider === provider).slice(0, 8));
          } catch { setEntries([]); }
        }}
      >
        {entries ? 'Hide sync history' : 'Sync history'}
      </button>
      {entries && (
        <ul className="mt-1.5 space-y-1">
          {entries.length === 0 && <li>No sync activity yet.</li>}
          {entries.map((e, i) => (
            <li key={i} className="flex flex-wrap gap-1.5 font-mono text-[10px]">
              <span>{e.at.slice(5, 16).replace('T', ' ')}</span>
              <span className={e.outcome === 'ok' ? 'text-verde' : 'text-alerta'}>{e.outcome}</span>
              <span className="text-ink">{e.action}</span>
              <span className="truncate">{e.subject} — {e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PipelineMappingEditor() {
  const [pipelines, setPipelines] = useState<HubSpotPipelineInfo[]>([]);
  const [mapping, setMapping] = useState<HubSpotPipelineMapping | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ pipelines }, { mapping }] = await Promise.all([
        api.hubspot.pipelines(),
        api.hubspot.getMapping(),
      ]);
      setPipelines(pipelines);
      setMapping(
        mapping ?? {
          pipelineId: pipelines[0]?.id ?? '',
          pipelineLabel: pipelines[0]?.label ?? '',
          stages: {},
        },
      );
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorNote message={error.message} hint={error.hint} />;
  if (!mapping) return <p>Loading pipelines…</p>;

  const pipeline = pipelines.find((p) => p.id === mapping.pipelineId);

  return (
    <div className="rounded-[2px] border border-line bg-paper p-3">
      <p className="mb-2 leading-relaxed">
        Map each Deal Radar status to an existing HubSpot stage. Submissions are blocked for any status without a
        mapping — the app never guesses stage IDs.
      </p>
      <label className="block font-mono text-[10px] uppercase tracking-wider">
        HubSpot deal pipeline
        <select
          value={mapping.pipelineId}
          onChange={(e) => {
            const p = pipelines.find((x) => x.id === e.target.value);
            setMapping({ pipelineId: e.target.value, pipelineLabel: p?.label ?? '', stages: {} });
          }}
          className="mt-0.5 w-full rounded-[2px] border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case"
        >
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <div className="mt-2 grid gap-1.5">
        {RADAR_HUBSPOT_STAGES.map((rs) => (
          <label key={rs} className="grid grid-cols-2 items-center gap-2">
            <span className="text-xs text-ink">{rs}</span>
            <select
              value={mapping.stages[rs] ?? ''}
              onChange={(e) =>
                setMapping({
                  ...mapping,
                  stages: e.target.value
                    ? { ...mapping.stages, [rs]: e.target.value }
                    : Object.fromEntries(Object.entries(mapping.stages).filter(([k]) => k !== rs)),
                })
              }
              className="rounded-[2px] border border-line bg-panel px-2 py-1 text-xs"
              aria-label={`HubSpot stage for ${rs}`}
            >
              <option value="">— not mapped —</option>
              {pipeline?.stages.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.id})</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          className={btnPrimary}
          disabled={busy || !mapping.pipelineId}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.hubspot.saveMapping(mapping);
              setSavedAt(new Date().toLocaleTimeString());
            } catch (e) {
              setError(e as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save mapping'}
        </button>
        {savedAt && <span className="font-mono text-[10px] text-verde">Saved {savedAt}</span>}
      </div>
    </div>
  );
}

// ── Outlook ──────────────────────────────────────────────────────

function OutlookCard({ conn, refreshAll }: { conn: IntegrationConnection; refreshAll: () => Promise<void> }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.outlook.connect();
      if (res.authUrl) {
        window.location.href = res.authUrl; // real Microsoft sign-in
        return;
      }
      setMessage(res.message);
      await refreshAll();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.outlook.disconnect();
      setMessage('Disconnected. Tokens were removed from the backend.');
      await refreshAll();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.outlook.saveDraft({
        companyId: 'connection-test',
        to: conn.account && conn.account.includes('@') ? conn.account : 'you@example.com',
        subject: 'VamosVentures Deal Radar — connection test draft',
        body: 'This is a test draft created from VamosVentures Deal Radar settings. It was saved as a draft only and will never be sent automatically. You can delete it.',
        senderName: 'Connection test',
        tone: '—',
      });
      setMessage(res.message);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Microsoft Outlook" conn={conn}>
      <div className="space-y-2 text-xs text-slate-mid">
        <div>OAuth authorization-code flow via Microsoft Graph. Drafts only — this app has no send path.</div>
        <div className="flex flex-wrap gap-2 pt-1">
          {!conn.connected && <button className={btnPrimary} onClick={connect} disabled={busy}>Connect Outlook</button>}
          {conn.connected && (
            <>
              <button className={btnGhost} onClick={connect} disabled={busy}>Reconnect</button>
              <button className={btnGhost} onClick={testDraft} disabled={busy}>Test draft creation</button>
              <button className={btnGhost} onClick={disconnect} disabled={busy}>Disconnect</button>
            </>
          )}
        </div>
        {message && <div className="rounded-[2px] bg-paper px-2 py-1.5">{message}</div>}
        {error && <ErrorNote message={error.message} hint={error.hint} />}
      </div>
    </CardShell>
  );
}

// ── AI provider ──────────────────────────────────────────────────

function AiCard({ conn }: { conn: IntegrationConnection }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function testGeneration() {
    setBusy(true);
    setError(null);
    setSample(null);
    try {
      const email = await api.outreach.generate({
        companyId: 'generation-test',
        companyName: 'Ejemplo Health',
        companyDescription: 'a test company used only to verify email generation.',
        vertical: 'Health & Wellness',
        subcategory: 'Test',
        whyFits: 'This is a settings-page generation test.',
        founderFirstName: 'Test',
        founderFullName: 'Test Founder',
        founderRole: 'CEO',
        founderEmail: null,
        verifiedFounderDetail: null,
        recentMilestone: null,
        acceleratorOrFunding: null,
        sourceLinks: [],
        senderName: 'Settings test',
        senderRole: 'Analyst',
        tone: 'Concise and direct',
        customInstructions: '',
        meetingAsk: 'a quick call',
      });
      setSample(`Subject: ${email.subject}${email.demo ? ' (local template — no AI model)' : ''}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="AI email provider" conn={conn}>
      <div className="space-y-2 text-xs text-slate-mid">
        <div>
          Provider abstraction supports Anthropic or OpenAI. Without a configured provider, drafts come from a
          deterministic local template built only from verified facts and are labeled that way. Every provider&rsquo;s
          output passes the same fact-validation gate (no invented funding, traction, customers, or accelerators).
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button className={btnGhost} onClick={testGeneration} disabled={busy}>
            {busy ? 'Generating…' : 'Test generation'}
          </button>
        </div>
        {sample && <div className="rounded-[2px] bg-paper px-2 py-1.5 font-mono text-[11px]">{sample}</div>}
        {error && <ErrorNote message={error.message} hint={error.hint} issues={error.issues} />}
      </div>
    </CardShell>
  );
}
