import { env, hubspotOAuthConfigured, notConnected } from '../env';
import { store, type TokenRecord } from '../lib/store';
import { audit } from '../lib/guard';
import { decrypt, encrypt, randomToken } from '../lib/crypto';
import { fetchWithRetry } from '../lib/http';
import {
  normalizeDomain,
  type DuplicateMatch,
  type HubSpotCompanyRecord,
  type HubSpotContactRecord,
  type HubSpotDealRecord,
  type HubSpotPipelineInfo,
  type SyncResult,
} from '../../shared/integrations';

// ── Auth: private-app token OR user-connected OAuth ─────────────

function oauthToken(): TokenRecord | undefined {
  return store.raw.tokens.find((t) => t.provider === 'hubspot');
}

/**
 * HubSpot is connected when either a private-app token exists in the
 * environment or a user completed the OAuth flow. There is no mock
 * fallback — when disconnected, HubSpot actions fail with an honest
 * "not connected" error.
 */
export function hubspotConnected(): boolean {
  return !!env.HUBSPOT_ACCESS_TOKEN || !!oauthToken();
}

export function hubspotAuthType(): 'private-app' | 'oauth' | 'none' {
  if (env.HUBSPOT_ACCESS_TOKEN) return 'private-app';
  if (oauthToken()) return 'oauth';
  return hubspotOAuthConfigured() ? 'oauth' : 'none';
}

const HUBSPOT_NOT_CONNECTED_HINT =
  'Add HUBSPOT_ACCESS_TOKEN (private app) or HUBSPOT_CLIENT_ID/SECRET/REDIRECT_URI (OAuth) to .env, then connect under Data Sources & Refresh.';

async function exchangeHubSpotToken(body: Record<string, string>) {
  const res = await fetchWithRetry('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.HUBSPOT_CLIENT_ID!,
      client_secret: env.HUBSPOT_CLIENT_SECRET!,
      ...body,
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error('HubSpot rejected the OAuth exchange. Check HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET and the redirect URI.'), { status: 401 });
  }
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

const HUBSPOT_OAUTH_SCOPES = [
  'crm.objects.companies.read', 'crm.objects.companies.write',
  'crm.objects.contacts.read', 'crm.objects.contacts.write',
  'crm.objects.deals.read', 'crm.objects.deals.write',
  'crm.objects.notes.write',
];

export function beginHubSpotConnect(): { authUrl: string | null; message: string } {
  if (!hubspotOAuthConfigured()) {
    return {
      authUrl: null,
      message: 'HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, and HUBSPOT_REDIRECT_URI (or use a private-app token) to connect.',
    };
  }
  const state = randomToken();
  store.raw.oauthStates.push({ state: `hs:${state}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  store.save();
  const params = new URLSearchParams({
    client_id: env.HUBSPOT_CLIENT_ID!,
    redirect_uri: env.HUBSPOT_REDIRECT_URI!,
    scope: HUBSPOT_OAUTH_SCOPES.join(' '),
    state,
  });
  return { authUrl: `https://app.hubspot.com/oauth/authorize?${params}`, message: 'Redirecting to HubSpot authorization.' };
}

export async function handleHubSpotCallback(code: string, state: string): Promise<void> {
  const now = Date.now();
  store.raw.oauthStates = store.raw.oauthStates.filter((s) => new Date(s.expiresAt).getTime() > now);
  const idx = store.raw.oauthStates.findIndex((s) => s.state === `hs:${state}`);
  if (idx === -1) {
    throw Object.assign(new Error('HubSpot OAuth state is invalid or expired. Start the connection again.'), { status: 400 });
  }
  store.raw.oauthStates.splice(idx, 1);
  const tokens = await exchangeHubSpotToken({
    grant_type: 'authorization_code',
    redirect_uri: env.HUBSPOT_REDIRECT_URI!,
    code,
  });
  store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'hubspot');
  store.raw.tokens.push({
    provider: 'hubspot',
    account: env.HUBSPOT_PORTAL_ID ?? 'connected portal',
    scopes: HUBSPOT_OAUTH_SCOPES,
    cipher: encrypt(tokens.access_token),
    refreshCipher: encrypt(tokens.refresh_token),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    connectedAt: new Date().toISOString(),
  });
  store.save();
  audit({ provider: 'hubspot', mode: 'live', action: 'connect', subject: 'oauth', outcome: 'ok', detail: 'HubSpot OAuth connection established' });
}

export function disconnectHubSpot(): void {
  store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'hubspot');
  store.save();
  audit({ provider: 'hubspot', mode: 'live', action: 'disconnect', subject: 'hubspot', outcome: 'ok', detail: 'OAuth tokens removed' });
}

/** Bearer token for live calls: private-app token, else OAuth (refreshing as needed). */
async function hubspotBearer(): Promise<string> {
  if (env.HUBSPOT_ACCESS_TOKEN) return env.HUBSPOT_ACCESS_TOKEN;
  const t = oauthToken();
  if (!t) {
    throw notConnected('HubSpot', HUBSPOT_NOT_CONNECTED_HINT);
  }
  if (new Date(t.expiresAt).getTime() - Date.now() > 60_000) return decrypt(t.cipher);
  if (!t.refreshCipher) {
    throw Object.assign(new Error('The HubSpot session expired and no refresh token is available. Reconnect HubSpot.'), { status: 401 });
  }
  const refreshed = await exchangeHubSpotToken({ grant_type: 'refresh_token', refresh_token: decrypt(t.refreshCipher) });
  t.cipher = encrypt(refreshed.access_token);
  t.refreshCipher = encrypt(refreshed.refresh_token);
  t.expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  store.save();
  return refreshed.access_token;
}

// ── Payload builders (pure — unit-tested) ────────────────────────

export function buildCompanyProperties(c: HubSpotCompanyRecord) {
  return {
    name: c.name,
    domain: c.domain,
    website: c.website,
    city: c.city,
    state: c.state,
    country: c.country,
    description: c.description,
    vamos_vertical: c.vertical,
    vamos_subcategory: c.subcategory,
    vamos_stage: c.stage,
    vamos_accelerator: c.accelerator,
    vamos_funding_raised: c.fundingRaised,
    vamos_date_first_surfaced: c.dateFirstSurfaced,
    vamos_last_refresh: c.lastRefreshed,
    vamos_primary_source: c.primarySource,
    vamos_policy_exception: c.policyException,
    vamos_deal_radar_id: c.dealRadarId,
    vamos_deal_radar_url: c.dealRadarUrl,
  };
}

/**
 * Contact properties. Demographic fields are written ONLY from
 * entries that already passed the verifiedDemographicSchema — each
 * carries basis, named source, source ref, and verification status.
 * Nothing here derives demographics from any other field.
 */
export function buildContactProperties(f: HubSpotContactRecord) {
  return {
    firstname: f.firstName,
    lastname: f.lastName,
    email: f.email,
    jobtitle: f.jobTitle,
    linkedin_url: f.linkedinUrl,
    company: f.companyName,
    vamos_info_source: f.infoSource,
    vamos_verification_status: f.verificationStatus,
    vamos_relationship_owner: f.relationshipOwner,
    vamos_last_outreach_date: f.lastOutreachDate,
    vamos_verified_demographics:
      f.demographics.length > 0
        ? f.demographics
            .map(
              (d) =>
                `${d.indicator} (${d.basis}; ${d.sourceName}; ${d.sourceRef}; ${d.verificationStatus})`,
            )
            .join(' | ')
        : null,
  };
}

export function buildDealProperties(d: HubSpotDealRecord, stageId: string, pipelineId: string) {
  return {
    dealname: `${d.companyName} — Vamos Deal Radar`,
    pipeline: pipelineId,
    dealstage: stageId,
    vamos_fit_score: d.fitScore,
    vamos_recommendation: d.recommendation,
    vamos_vertical: d.vertical,
    vamos_stage: d.stage,
    vamos_score_breakdown: d.scoreBreakdown
      .map((s) => `${s.label}: ${s.points}/${s.max}`)
      .join('; '),
    vamos_rationale: d.rationale,
    vamos_risks: d.risks,
    vamos_score_explanation: d.scoreExplanation,
    vamos_reviewer: d.approvedBy,
    vamos_approval_date: d.approvalDate,
    vamos_source_urls: d.sourceUrls.join('\n') || null,
    vamos_evidence_quality: d.evidenceQualityScore,
    vamos_policy_exception: d.policyException,
    vamos_sourcing_status: d.sourcingStatus,
    vamos_date_surfaced: d.dateSurfaced,
    vamos_next_action: d.nextAction,
    vamos_relationship_owner: d.relationshipOwner,
    vamos_deal_radar_id: d.dealRadarId,
    vamos_deal_radar_url: d.dealRadarUrl,
  };
}

// ── Service interface ────────────────────────────────────────────

export interface HubSpotSearchHit {
  recordId: string;
  type: 'company' | 'contact' | 'deal';
  title: string;
  subtitle: string;
  url: string | null;
  demo: boolean;
}

export interface DuplicateCheckInput {
  name: string;
  domain: string | null;
  /** Verified founder emails, when available — matched against HubSpot contacts. */
  founderEmails?: string[];
  /** Our record id — matched against the vamos_deal_radar_id property. */
  dealRadarId?: string;
}

export interface HubSpotService {
  mode: 'mock' | 'live';
  /** Cheap real call that proves the credentials work. */
  verifyConnection(): Promise<{ ok: boolean; detail: string }>;
  search(query: string, type: 'companies' | 'contacts' | 'deals'): Promise<HubSpotSearchHit[]>;
  checkDuplicate(input: DuplicateCheckInput): Promise<DuplicateMatch[]>;
  getPipelines(): Promise<HubSpotPipelineInfo[]>;
  syncCompany(args: {
    company: HubSpotCompanyRecord;
    contacts: HubSpotContactRecord[];
    deal: HubSpotDealRecord;
    stageId: string;
    pipelineId: string;
    resolution: 'create-new' | 'update-existing';
    existingRecordId: string | null;
    /** The HubSpot deal previously created for this radar record, if known — updates its stage/pipeline instead of creating a twin. */
    existingDealId: string | null;
  }): Promise<SyncResult>;
  logActivity(args: {
    companyRecordId: string;
    note: string;
  }): Promise<{ noteId: string; demo: boolean }>;
}

// ── Live implementation ──────────────────────────────────────────

const HS = 'https://api.hubapi.com';

class LiveHubSpot implements HubSpotService {
  mode = 'live' as const;

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await hubspotBearer();
    const res = await fetchWithRetry(`${HS}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('HubSpot rejected the credentials. Check that the private-app token is valid and has the crm.objects scopes.'), { status: 401 });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HubSpot returned ${res.status}. ${await safeText(res)}`), { status: res.status });
    }
    return (await res.json()) as T;
  }

  private async searchCompaniesBy(prop: string, value: string) {
    return this.call<{ results: { id: string; properties: Record<string, string> }[] }>(
      '/crm/v3/objects/companies/search',
      {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: prop, operator: 'EQ', value }] }],
          properties: ['name', 'domain'],
          limit: 5,
        }),
      },
    );
  }

  private async searchDealsBy(prop: string, value: string) {
    return this.call<{ results: { id: string }[] }>(
      '/crm/v3/objects/deals/search',
      {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: prop, operator: 'EQ', value }] }],
          properties: [],
          limit: 1,
        }),
      },
    );
  }

  /**
   * Tiered duplicate check before any create:
   * 1. our Vamos property (vamos_deal_radar_id) — exact prior sync,
   * 2. normalized domain,
   * 3. normalized company name,
   * 4. verified founder emails against HubSpot contacts.
   */
  async checkDuplicate(input: DuplicateCheckInput): Promise<DuplicateMatch[]> {
    const portal = env.HUBSPOT_PORTAL_ID;
    const companyUrl = (id: string) => (portal ? `https://app.hubspot.com/contacts/${portal}/company/${id}` : null);
    const toMatch = (r: { id: string; properties: Record<string, string> }, matchedOn: DuplicateMatch['matchedOn']): DuplicateMatch => ({
      recordId: r.id,
      name: r.properties.name ?? '',
      domain: r.properties.domain ?? null,
      matchedOn,
      url: companyUrl(r.id),
      demo: false,
    });

    if (input.dealRadarId) {
      const byRadar = await this.searchCompaniesBy('vamos_deal_radar_id', input.dealRadarId).catch(() => ({ results: [] }));
      if (byRadar.results.length > 0) return byRadar.results.map((r) => toMatch(r, 'radar-id'));
    }
    const nDomain = normalizeDomain(input.domain);
    if (nDomain) {
      const byDomain = await this.searchCompaniesBy('domain', nDomain);
      if (byDomain.results.length > 0) return byDomain.results.map((r) => toMatch(r, 'domain'));
    }
    const byName = await this.searchCompaniesBy('name', input.name);
    if (byName.results.length > 0) return byName.results.map((r) => toMatch(r, 'name'));

    const matches: DuplicateMatch[] = [];
    for (const email of (input.founderEmails ?? []).slice(0, 3)) {
      const contacts = await this.call<{ results: { id: string; properties: Record<string, string> }[] }>(
        '/crm/v3/objects/contacts/search',
        {
          method: 'POST',
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
            properties: ['firstname', 'lastname', 'email', 'company'],
            limit: 2,
          }),
        },
      ).catch(() => ({ results: [] }));
      for (const r of contacts.results) {
        matches.push({
          recordId: r.id,
          name: `Contact: ${`${r.properties.firstname ?? ''} ${r.properties.lastname ?? ''}`.trim() || r.properties.email} (${r.properties.email})${r.properties.company ? ` — company on record: ${r.properties.company}` : ''}`,
          domain: null,
          matchedOn: 'founder-email',
          url: portal ? `https://app.hubspot.com/contacts/${portal}/contact/${r.id}` : null,
          demo: false,
        });
      }
    }
    return matches;
  }

  async getPipelines(): Promise<HubSpotPipelineInfo[]> {
    const data = await this.call<{
      results: { id: string; label: string; stages: { id: string; label: string }[] }[];
    }>('/crm/v3/pipelines/deals');
    return data.results.map((p) => ({
      id: p.id,
      label: p.label,
      stages: p.stages.map((s) => ({ id: s.id, label: s.label })),
    }));
  }

  async verifyConnection() {
    try {
      await this.call('/crm/v3/objects/companies?limit=1');
      return { ok: true, detail: 'HubSpot responded — credentials verified.' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async search(query: string, type: 'companies' | 'contacts' | 'deals'): Promise<HubSpotSearchHit[]> {
    const props =
      type === 'companies' ? ['name', 'domain']
      : type === 'contacts' ? ['firstname', 'lastname', 'email']
      : ['dealname', 'dealstage', 'amount'];
    const data = await this.call<{ results: { id: string; properties: Record<string, string> }[] }>(
      `/crm/v3/objects/${type}/search`,
      {
        method: 'POST',
        body: JSON.stringify({ query, properties: props, limit: 8 }),
      },
    );
    const portal = env.HUBSPOT_PORTAL_ID;
    const kind = type === 'companies' ? 'company' as const : type === 'contacts' ? 'contact' as const : 'deal' as const;
    return data.results.map((r) => ({
      recordId: r.id,
      type: kind,
      title:
        type === 'companies' ? (r.properties.name ?? r.id)
        : type === 'contacts' ? (`${r.properties.firstname ?? ''} ${r.properties.lastname ?? ''}`.trim() || r.id)
        : (r.properties.dealname ?? r.id),
      subtitle:
        (type === 'companies' ? r.properties.domain
        : type === 'contacts' ? r.properties.email
        : [r.properties.dealstage, r.properties.amount ? `$${r.properties.amount}` : null].filter(Boolean).join(' · ')) ?? '—',
      url: portal
        ? `https://app.hubspot.com/contacts/${portal}/${kind === 'company' ? 'company' : kind === 'contact' ? 'contact' : 'deal'}/${r.id}`
        : null,
      demo: false,
    }));
  }

  /**
   * HubSpot's explicit fields win over anything we derived: when
   * updating, core fields (name, domain, website, geography,
   * description) that already hold values in HubSpot are NOT
   * overwritten — only empty fields are filled, and vamos_* properties
   * (which are ours) are always refreshed. Geography is never inferred:
   * if HubSpot has city/state, ours are dropped.
   */
  private async propertiesRespectingExisting(recordId: string, company: HubSpotCompanyRecord) {
    const PRESERVED = ['name', 'domain', 'website', 'city', 'state', 'country', 'description'] as const;
    const ours = buildCompanyProperties(company) as Record<string, string | number | null>;
    const existing = await this.call<{ properties: Record<string, string | null> }>(
      `/crm/v3/objects/companies/${recordId}?properties=${PRESERVED.join(',')}`,
    ).catch(() => null);
    if (existing) {
      for (const field of PRESERVED) {
        const current = existing.properties[field];
        if (current !== null && current !== undefined && String(current).trim() !== '') {
          delete ours[field]; // explicit HubSpot value wins
        }
      }
    }
    return ours;
  }

  async syncCompany(args: Parameters<HubSpotService['syncCompany']>[0]): Promise<SyncResult> {
    const { company, contacts, deal, stageId, pipelineId, resolution, existingRecordId, existingDealId } = args;

    // Idempotency: if this radar record was ever synced, update that
    // HubSpot company instead of creating a twin — even when the
    // caller asked for create-new (e.g. a repeated click).
    let targetId = resolution === 'update-existing' ? existingRecordId : null;
    if (!targetId) {
      const prior = await this.searchCompaniesBy('vamos_deal_radar_id', company.dealRadarId).catch(() => ({ results: [] }));
      if (prior.results[0]) targetId = prior.results[0].id;
    }
    const updating = !!targetId;

    const companyRes = targetId
      ? await this.call<{ id: string }>(`/crm/v3/objects/companies/${targetId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: await this.propertiesRespectingExisting(targetId, company) }),
        })
      : await this.call<{ id: string }>('/crm/v3/objects/companies', {
          method: 'POST',
          body: JSON.stringify({ properties: buildCompanyProperties(company) }),
        });

    const contactIds: string[] = [];
    for (const c of contacts) {
      const res = await this.call<{ id: string }>('/crm/v3/objects/contacts', {
        method: 'POST',
        body: JSON.stringify({ properties: buildContactProperties(c) }),
      }).catch(async (e: { status?: number }) => {
        // 409 = contact exists; HubSpot returns the existing id in the message.
        if (e.status === 409 && c.email) {
          const found = await this.call<{ results: { id: string }[] }>(
            '/crm/v3/objects/contacts/search',
            {
              method: 'POST',
              body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: c.email }] }],
                limit: 1,
              }),
            },
          );
          if (found.results[0]) {
            return this.call<{ id: string }>(`/crm/v3/objects/contacts/${found.results[0].id}`, {
              method: 'PATCH',
              body: JSON.stringify({ properties: buildContactProperties(c) }),
            });
          }
        }
        throw e;
      });
      contactIds.push(res.id);
    }

    // Idempotency: reuse the deal previously created for this radar
    // record instead of creating a twin on every resync/stage change.
    // Prefer the caller's persisted hubspot_deal_id (the fast path);
    // fall back to a live search by our own vamos_deal_radar_id
    // property for records synced before this link was tracked.
    let dealTargetId = existingDealId;
    if (!dealTargetId) {
      const priorDeal = await this.searchDealsBy('vamos_deal_radar_id', deal.dealRadarId).catch(() => ({ results: [] }));
      if (priorDeal.results[0]) dealTargetId = priorDeal.results[0].id;
    }
    const dealUpdating = !!dealTargetId;
    const dealRes = dealTargetId
      ? await this.call<{ id: string }>(`/crm/v3/objects/deals/${dealTargetId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: buildDealProperties(deal, stageId, pipelineId) }),
        })
      : await this.call<{ id: string }>('/crm/v3/objects/deals', {
          method: 'POST',
          body: JSON.stringify({ properties: buildDealProperties(deal, stageId, pipelineId) }),
        });

    // Associations: deal↔company, deal↔contacts, company↔contacts.
    const assoc = (fromType: string, fromId: string, toType: string, toId: string) =>
      this.call(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, {
        method: 'PUT',
      });
    await assoc('deals', dealRes.id, 'companies', companyRes.id);
    for (const id of contactIds) {
      await assoc('deals', dealRes.id, 'contacts', id);
      await assoc('companies', companyRes.id, 'contacts', id);
    }

    const portal = env.HUBSPOT_PORTAL_ID;
    audit({
      provider: 'hubspot', mode: 'live',
      action: updating ? 'update-company' : 'create-company',
      subject: company.dealRadarId, outcome: 'ok',
      detail: `Company ${companyRes.id} (${updating ? 'updated' : 'created'}), ${contactIds.length} contact(s), deal ${dealRes.id} (${dealUpdating ? 'updated' : 'created'})`,
    });
    return {
      demo: false,
      companyId: companyRes.id,
      companyUrl: portal ? `https://app.hubspot.com/contacts/${portal}/company/${companyRes.id}` : null,
      contactIds,
      dealId: dealRes.id,
      dealUrl: portal ? `https://app.hubspot.com/contacts/${portal}/deal/${dealRes.id}` : null,
      action: updating ? 'updated' : 'created',
      message: updating
        ? 'HubSpot record updated (existing explicit HubSpot fields were preserved; Vamos properties refreshed).'
        : 'HubSpot records saved.',
    };
  }

  async logActivity(args: { companyRecordId: string; note: string }) {
    const note = await this.call<{ id: string }>('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: { hs_note_body: args.note, hs_timestamp: new Date().toISOString() },
      }),
    });
    await this.call(
      `/crm/v4/objects/notes/${note.id}/associations/default/companies/${args.companyRecordId}`,
      { method: 'PUT' },
    );
    return { noteId: note.id, demo: false };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

// ── Service resolution ───────────────────────────────────────────

/** Test-only override so automated tests can inject an in-memory fixture. */
let serviceOverride: HubSpotService | null = null;
export function __setHubSpotServiceForTests(svc: HubSpotService | null): void {
  serviceOverride = svc;
}

/** The service when available: a test fixture, or the live client when connected. */
export function hubspotServiceIfAvailable(): HubSpotService | null {
  if (serviceOverride) return serviceOverride;
  return hubspotConnected() ? new LiveHubSpot() : null;
}

/** The service, or an honest "not connected" error — never a simulation. */
export function hubspotService(): HubSpotService {
  const svc = hubspotServiceIfAvailable();
  if (!svc) throw notConnected('HubSpot', HUBSPOT_NOT_CONNECTED_HINT);
  return svc;
}
