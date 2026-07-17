import { env, hubspotOAuthConfigured, integrationModeForcedMock, modes } from '../env';
import { store, type MockHubSpotObject, type TokenRecord } from '../lib/store';
import { audit } from '../lib/guard';
import { decrypt, encrypt, randomToken } from '../lib/crypto';
import { fetchWithRetry } from '../lib/http';
import {
  normalizeCompanyName,
  normalizeDomain,
  type DuplicateMatch,
  type HubSpotCompanyRecord,
  type HubSpotContactRecord,
  type HubSpotDealRecord,
  type HubSpotPipelineInfo,
  type SyncResult,
  RADAR_HUBSPOT_STAGES,
} from '../../shared/integrations';

// ── Auth: private-app token OR user-connected OAuth ─────────────

function oauthToken(): TokenRecord | undefined {
  return store.raw.tokens.find((t) => t.provider === 'hubspot');
}

/**
 * HubSpot is live when NOT forced to mock AND either a private-app
 * token exists in the environment or a user completed the OAuth flow.
 */
export function hubspotMode(): 'mock' | 'live' {
  if (integrationModeForcedMock()) return 'mock';
  if (env.HUBSPOT_ACCESS_TOKEN) return 'live';
  return oauthToken() ? 'live' : 'mock';
}

export function hubspotAuthType(): 'private-app' | 'oauth' | 'none' {
  if (env.HUBSPOT_ACCESS_TOKEN) return 'private-app';
  if (oauthToken()) return 'oauth';
  return hubspotOAuthConfigured() ? 'oauth' : 'none';
}

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
];

export function beginHubSpotConnect(): { authUrl: string | null; demo: boolean; message: string } {
  if (!hubspotOAuthConfigured() || integrationModeForcedMock()) {
    return {
      authUrl: null,
      demo: true,
      message: hubspotOAuthConfigured()
        ? 'INTEGRATION_MODE=mock forces Local Mode. Set INTEGRATION_MODE=auto to use the real OAuth flow.'
        : 'HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, and HUBSPOT_REDIRECT_URI (or use a private-app token) to connect.',
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
  return { authUrl: `https://app.hubspot.com/oauth/authorize?${params}`, demo: false, message: 'Redirecting to HubSpot authorization.' };
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
  audit({ provider: 'hubspot', mode: hubspotMode(), action: 'disconnect', subject: 'hubspot', outcome: 'ok', detail: 'OAuth tokens removed' });
}

/** Bearer token for live calls: private-app token, else OAuth (refreshing as needed). */
async function hubspotBearer(): Promise<string> {
  if (env.HUBSPOT_ACCESS_TOKEN) return env.HUBSPOT_ACCESS_TOKEN;
  const t = oauthToken();
  if (!t) {
    throw Object.assign(new Error('HubSpot is not connected. Connect it under Data Sources or set HUBSPOT_ACCESS_TOKEN.'), { status: 401 });
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
  type: 'company' | 'contact';
  title: string;
  subtitle: string;
  url: string | null;
  demo: boolean;
}

export interface HubSpotService {
  mode: 'mock' | 'live';
  /** Cheap real call that proves the credentials work. */
  verifyConnection(): Promise<{ ok: boolean; detail: string }>;
  search(query: string, type: 'companies' | 'contacts'): Promise<HubSpotSearchHit[]>;
  checkDuplicate(name: string, domain: string | null): Promise<DuplicateMatch[]>;
  getPipelines(): Promise<HubSpotPipelineInfo[]>;
  syncCompany(args: {
    company: HubSpotCompanyRecord;
    contacts: HubSpotContactRecord[];
    deal: HubSpotDealRecord;
    stageId: string;
    pipelineId: string;
    resolution: 'create-new' | 'update-existing';
    existingRecordId: string | null;
  }): Promise<SyncResult>;
  logActivity(args: {
    companyRecordId: string;
    note: string;
  }): Promise<{ noteId: string; demo: boolean }>;
}

// ── Mock implementation ──────────────────────────────────────────

class MockHubSpot implements HubSpotService {
  mode = 'mock' as const;

  async verifyConnection() {
    return {
      ok: true,
      detail: 'Local Mode: simulated store responded. No real HubSpot connection was verified.',
    };
  }

  async search(query: string, type: 'companies' | 'contacts'): Promise<HubSpotSearchHit[]> {
    const q = query.trim().toLowerCase();
    const objType = type === 'companies' ? 'company' : 'contact';
    return store.raw.mockHubSpot
      .filter((o) => o.type === objType)
      .filter((o) => JSON.stringify(o.properties).toLowerCase().includes(q))
      .slice(0, 8)
      .map((o) => ({
        recordId: o.id,
        type: objType as 'company' | 'contact',
        title: String(o.properties.name ?? `${o.properties.firstname ?? ''} ${o.properties.lastname ?? ''}`.trim()),
        subtitle: String(o.properties.domain ?? o.properties.email ?? '—'),
        url: null,
        demo: true,
      }));
  }

  async checkDuplicate(name: string, domain: string | null): Promise<DuplicateMatch[]> {
    const nDomain = normalizeDomain(domain);
    const nName = normalizeCompanyName(name);
    const companies = store.raw.mockHubSpot.filter((o) => o.type === 'company');

    const byDomain = nDomain
      ? companies.filter((o) => normalizeDomain(String(o.properties.domain ?? '')) === nDomain)
      : [];
    const pool = byDomain.length > 0 ? byDomain : companies.filter(
      (o) => normalizeCompanyName(String(o.properties.name ?? '')) === nName,
    );
    return pool.map((o) => ({
      recordId: o.id,
      name: String(o.properties.name ?? ''),
      domain: (o.properties.domain as string | null) ?? null,
      matchedOn: byDomain.length > 0 ? 'domain' : 'name',
      url: null, // Demo Mode — no real HubSpot record exists
      demo: true,
    }));
  }

  async getPipelines(): Promise<HubSpotPipelineInfo[]> {
    return [
      {
        id: 'demo-pipeline',
        label: 'Demo Mode sample pipeline (not a real HubSpot pipeline)',
        stages: RADAR_HUBSPOT_STAGES.map((s) => ({
          id: `demo-${s.toLowerCase().replace(/\s+/g, '-')}`,
          label: s,
        })),
      },
    ];
  }

  private put(
    type: MockHubSpotObject['type'],
    properties: Record<string, string | number | null>,
    existingId?: string | null,
  ): MockHubSpotObject {
    const now = new Date().toISOString();
    if (existingId) {
      const found = store.raw.mockHubSpot.find((o) => o.id === existingId);
      if (found) {
        found.properties = { ...found.properties, ...properties };
        found.updatedAt = now;
        store.save();
        return found;
      }
    }
    const obj: MockHubSpotObject = {
      id: store.nextId(`mock-${type}`),
      type,
      properties,
      associations: [],
      createdAt: now,
      updatedAt: now,
    };
    store.raw.mockHubSpot.push(obj);
    store.save();
    return obj;
  }

  async syncCompany(args: Parameters<HubSpotService['syncCompany']>[0]): Promise<SyncResult> {
    const { company, contacts, deal, stageId, pipelineId, resolution, existingRecordId } = args;
    const updating = resolution === 'update-existing' && !!existingRecordId;
    const companyObj = this.put(
      'company',
      buildCompanyProperties(company),
      updating ? existingRecordId : null,
    );
    const contactObjs = contacts.map((c) => {
      // Reuse an existing mock contact with the same email to avoid duplicates.
      const email = c.email;
      const existing = email
        ? store.raw.mockHubSpot.find(
            (o) => o.type === 'contact' && o.properties.email === email,
          )
        : undefined;
      return this.put('contact', buildContactProperties(c), existing?.id ?? null);
    });
    const dealObj = this.put('deal', buildDealProperties(deal, stageId, pipelineId), null);

    dealObj.associations = [companyObj.id, ...contactObjs.map((o) => o.id)];
    companyObj.associations = Array.from(
      new Set([...companyObj.associations, dealObj.id, ...contactObjs.map((o) => o.id)]),
    );
    store.save();

    audit({
      provider: 'hubspot', mode: 'mock',
      action: updating ? 'update-company' : 'create-company',
      subject: company.dealRadarId, outcome: 'ok',
      detail: `Demo Mode: simulated ${updating ? 'update of' : 'creation of'} company, ${contactObjs.length} contact(s), 1 deal`,
    });

    return {
      demo: true,
      companyId: companyObj.id,
      companyUrl: null, // no real record — never fabricate a HubSpot link
      contactIds: contactObjs.map((o) => o.id),
      dealId: dealObj.id,
      dealUrl: null,
      action: updating ? 'updated' : 'created',
      message: `Demo Mode: simulated HubSpot sync. No real HubSpot ${updating ? 'update' : 'records'} occurred.`,
    };
  }

  async logActivity(args: { companyRecordId: string; note: string }) {
    const note = this.put('note', { body: args.note, about: args.companyRecordId }, null);
    const target = store.raw.mockHubSpot.find((o) => o.id === args.companyRecordId);
    if (target) {
      target.associations.push(note.id);
      store.save();
    }
    audit({
      provider: 'hubspot', mode: 'mock', action: 'log-activity',
      subject: args.companyRecordId, outcome: 'ok',
      detail: 'Demo Mode: simulated HubSpot note',
    });
    return { noteId: note.id, demo: true };
  }
}

// ── Live implementation (requires HUBSPOT_ACCESS_TOKEN) ──────────

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

  async checkDuplicate(name: string, domain: string | null): Promise<DuplicateMatch[]> {
    const nDomain = normalizeDomain(domain);
    const search = async (prop: string, value: string) =>
      this.call<{ results: { id: string; properties: Record<string, string> }[] }>(
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
    let results = nDomain ? (await search('domain', nDomain)).results : [];
    let matchedOn: 'domain' | 'name' = 'domain';
    if (results.length === 0) {
      results = (await search('name', name)).results;
      matchedOn = 'name';
    }
    return results.map((r) => ({
      recordId: r.id,
      name: r.properties.name ?? '',
      domain: r.properties.domain ?? null,
      matchedOn,
      url: env.HUBSPOT_PORTAL_ID
        ? `https://app.hubspot.com/contacts/${env.HUBSPOT_PORTAL_ID}/company/${r.id}`
        : null,
      demo: false,
    }));
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

  async search(query: string, type: 'companies' | 'contacts'): Promise<HubSpotSearchHit[]> {
    const props = type === 'companies' ? ['name', 'domain'] : ['firstname', 'lastname', 'email'];
    const data = await this.call<{ results: { id: string; properties: Record<string, string> }[] }>(
      `/crm/v3/objects/${type}/search`,
      {
        method: 'POST',
        body: JSON.stringify({ query, properties: props, limit: 8 }),
      },
    );
    const portal = env.HUBSPOT_PORTAL_ID;
    return data.results.map((r) => ({
      recordId: r.id,
      type: type === 'companies' ? 'company' as const : 'contact' as const,
      title: type === 'companies'
        ? (r.properties.name ?? r.id)
        : `${r.properties.firstname ?? ''} ${r.properties.lastname ?? ''}`.trim() || r.id,
      subtitle: (type === 'companies' ? r.properties.domain : r.properties.email) ?? '—',
      url: portal
        ? `https://app.hubspot.com/contacts/${portal}/${type === 'companies' ? 'company' : 'contact'}/${r.id}`
        : null,
      demo: false,
    }));
  }

  async syncCompany(args: Parameters<HubSpotService['syncCompany']>[0]): Promise<SyncResult> {
    const { company, contacts, deal, stageId, pipelineId, resolution, existingRecordId } = args;
    const updating = resolution === 'update-existing' && !!existingRecordId;

    const companyRes = updating
      ? await this.call<{ id: string }>(`/crm/v3/objects/companies/${existingRecordId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: buildCompanyProperties(company) }),
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

    const dealRes = await this.call<{ id: string }>('/crm/v3/objects/deals', {
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
      detail: `Company ${companyRes.id}, ${contactIds.length} contact(s), deal ${dealRes.id}`,
    });
    return {
      demo: false,
      companyId: companyRes.id,
      companyUrl: portal ? `https://app.hubspot.com/contacts/${portal}/company/${companyRes.id}` : null,
      contactIds,
      dealId: dealRes.id,
      dealUrl: portal ? `https://app.hubspot.com/contacts/${portal}/deal/${dealRes.id}` : null,
      action: updating ? 'updated' : 'created',
      message: 'HubSpot records saved.',
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

export function hubspotService(): HubSpotService {
  return hubspotMode() === 'live' ? new LiveHubSpot() : new MockHubSpot();
}

// modes.hubspot from env stays for private-app-only checks; keep the
// import referenced so both entry points agree in that case.
void modes;
