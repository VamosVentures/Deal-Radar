import { env, hubspotOAuthConfigured, hubspotRedirectUri, notConnected } from '../env';
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

/**
 * Company/Deal owner assignment (per Andrew, 2026-09-01): Vamos assigns
 * ownership by vertical, not by an individual "relationship owner" typed
 * into Deal Radar. Keyed by the exact `industry_`/vertical display name
 * already flowing through HubSpotCompanyRecord.industry and
 * HubSpotDealRecord.vertical. A vertical with no entry (or no confident
 * industry match) leaves the owner field untouched — never guessed.
 */
const OWNER_ID_BY_INDUSTRY: Record<string, string> = {
  'Future of Work': '105209710', // Valeria Martinez
  'Health & Wellness': '48549163', // Ashley Ryder
  FinTech: '131894443', // Andres Morin
  Sustainability: '141729612', // Maya Trujillo
  Frontier: '82101654', // Andrew Gonzalez
};

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

/**
 * Every HubSpot permission this app asks a portal to grant, and the
 * feature each one pays for. Audited against the actual calls in this
 * file — the list below is not aspirational, and nothing is requested
 * "in case we need it later".
 *
 *   crm.objects.companies.read
 *     The tiered duplicate check that runs BEFORE any create
 *     (checkDuplicate: by domain, then name), the connection test
 *     (verifyConnection), and reading back the properties a sync must
 *     preserve rather than overwrite.
 *
 *   crm.objects.companies.write
 *     Creating the company record, updating an existing one when the
 *     reviewer chooses "update existing", and associating it.
 *
 *   crm.objects.contacts.read
 *     The founder-email tier of the duplicate check — the tier that
 *     catches "this founder is already in the CRM under a different
 *     company name" — plus contact search from the HubSpot panel, and
 *     the lookup before creating a contact so an existing person is
 *     updated instead of duplicated.
 *
 *   crm.objects.contacts.write
 *     Creating and updating the founder contacts that the reviewer
 *     approved as part of a sync, and associating them to the company
 *     and deal. Without this, a synced deal has no people on it.
 *
 *   crm.objects.deals.read
 *     Finding the deal previously created for a radar record, so a
 *     re-sync updates that deal instead of creating a twin, and
 *     reading the portal's deal pipelines and stages so the reviewer
 *     picks a real stage rather than typing an id.
 *
 *   crm.objects.deals.write
 *     Creating the deal, updating its stage/pipeline on re-sync, and
 *     associating it to the company and contacts.
 *
 *   crm.objects.notes.write
 *     The sync Note every syncCompany call attaches to the deal and
 *     company (provenance plus everything with no property home: fit
 *     score, rationale, risks, evidence, sourcing status, source URLs —
 *     see buildSyncNoteBody), and logging "an outreach draft was
 *     created, awaiting human review and manual send" (logActivity).
 *     Write only — this app never reads notes back, so no notes.read
 *     is requested.
 *
 * NOT requested, and deliberately so: any `.All`/owner/pipeline-admin
 * scope, `crm.objects.notes.read`, marketing/forms/timeline scopes, or
 * anything that would let this app act outside the reviewed sync
 * workflow. Adding a scope here without a call in this file that needs
 * it is a silent permission expansion; the scope test in
 * server/tests/hubspot.test.ts fails on exactly that.
 */
export const HUBSPOT_OAUTH_SCOPES = [
  'crm.objects.companies.read', 'crm.objects.companies.write',
  'crm.objects.contacts.read', 'crm.objects.contacts.write',
  'crm.objects.deals.read', 'crm.objects.deals.write',
  'crm.objects.notes.write',
] as const;

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
    // Derived from APP_BASE_URL unless explicitly overridden.
    redirect_uri: hubspotRedirectUri(),
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
    // Must byte-match the redirect_uri sent on the authorize request.
    redirect_uri: hubspotRedirectUri(),
    code,
  });
  store.raw.tokens = store.raw.tokens.filter((t) => t.provider !== 'hubspot');
  store.raw.tokens.push({
    provider: 'hubspot',
    account: env.HUBSPOT_PORTAL_ID ?? 'connected portal',
    scopes: [...HUBSPOT_OAUTH_SCOPES],
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
//
// Every key below is one of Vamos's own pre-existing HubSpot properties
// (internal names pulled from the live portal schema) — no `vamos_*`
// property is created or written. A field with no corresponding
// property (fit score, rationale, risks, evidence, sourcing status,
// source URLs, the Deal Radar link) never becomes a new property; see
// buildSyncNoteBody, which carries all of that as a Note instead.
//
// Nullish values are stripped before returning: a field Deal Radar has
// no data for is left OUT of the payload entirely (never sent as an
// explicit null), so a resync can never clear a value a human already
// filled in — see also propertiesRespectingExisting's PRESERVE list.

function stripNullish<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export function buildCompanyProperties(c: HubSpotCompanyRecord): Record<string, string | number | null> {
  const founderProps: Record<string, string | null> = {};
  c.founders.forEach((f, i) => {
    const n = i + 1;
    founderProps[`founder_name__${n}`] = f.name || null;
    founderProps[`founder_email__${n}`] = f.email;
    founderProps[`founder_linkedin__${n}`] = f.linkedin;
    founderProps[`founder__${n}_job_title`] = f.jobTitle || null;
  });
  return stripNullish({
    name: c.name,
    domain: c.domain,
    website: c.website,
    city: c.city,
    state_: c.state,
    country_: c.country,
    description: c.description,
    industry_: c.industry,
    round_currently_raising: c.roundCurrentlyRaising,
    total_raising_for_round: c.totalRaisingForRound,
    top_accelerator_participation: c.acceleratorParticipation,
    diverse_group: c.diverseGroup,
    if_other__please_specify_diverse_group: c.diverseGroupOther,
    // Deal Radar only ever sources outbound leads — never a founder application.
    inbound_outbound: 'Outbound',
    hubspot_owner_id: OWNER_ID_BY_INDUSTRY[c.industry] ?? null,
    ...founderProps,
  });
}

/** Contact properties: only the three Vamos actually uses on the Contact object. Everything else Deal Radar knows about a founder (job title, LinkedIn, verification, demographics) lives on the Company's founder slots and the sync Note instead. */
export function buildContactProperties(f: HubSpotContactRecord) {
  return stripNullish({
    firstname: f.firstName,
    lastname: f.lastName,
    email: f.email,
  });
}

export function buildDealProperties(d: HubSpotDealRecord, stageId: string, pipelineId: string) {
  return stripNullish({
    dealname: d.companyName,
    pipeline: pipelineId,
    dealstage: stageId,
    hubspot_owner_id: OWNER_ID_BY_INDUSTRY[d.vertical] ?? null,
  });
}

/**
 * Everything Deal Radar knows that has no home in Vamos's existing
 * property schema — fit score, recommendation, rationale, risks,
 * evidence quality, sourcing status, approver, source URLs — folded
 * into one Note attached to the deal and company at sync time, per
 * Andrew's 2026-09-01 decision. Nothing here is a HubSpot property.
 */
export function buildSyncNoteBody(deal: HubSpotDealRecord, updating: boolean): string {
  const lines = [
    updating ? 'Deal Radar sync update' : 'Added by Vamos Deal Radar',
    `Fit score: ${deal.fitScore}/10 — ${deal.recommendation}`,
    `Vertical: ${deal.vertical} — Stage: ${deal.stage}`,
    `Why it fits: ${deal.rationale}`,
    `Risks: ${deal.risks}`,
    `Evidence quality: ${deal.evidenceQualityScore}/10`,
    deal.scoreExplanation ? deal.scoreExplanation : null,
    deal.policyException ? `Policy exception: ${deal.policyException}` : null,
    `Sourcing status: ${deal.sourcingStatus} (surfaced ${deal.dateSurfaced})`,
    `Next action: ${deal.nextAction}`,
    deal.approvedBy ? `Approved by ${deal.approvedBy}${deal.approvalDate ? ` on ${deal.approvalDate}` : ''}` : null,
    deal.sourceUrls.length > 0 ? `Sources:\n${deal.sourceUrls.join('\n')}` : null,
    `Deal Radar record: ${deal.dealRadarUrl}`,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
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

  /**
   * Tiered duplicate check before any create:
   * 1. normalized domain,
   * 2. normalized company name,
   * 3. verified founder emails against HubSpot contacts.
   *
   * A radar record Deal Radar already synced before is found a
   * different way — its own locally-persisted hubspot_company_id/
   * hubspot_deal_id link (see server/routes/hubspot.ts's performSync) —
   * not a HubSpot-side property, so it isn't a tier here.
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
   * HubSpot's explicit fields win over anything Deal Radar derived.
   * Every property Deal Radar writes on the Company object is one Vamos
   * already uses elsewhere and a human can (and does) edit by hand — so
   * on an update, a field that already holds a value in HubSpot is left
   * alone; only empty fields are filled. Founder slots and
   * inbound_outbound are the exception: Deal Radar is the authoritative
   * source for founder details on a Deal-Radar-sourced company and for
   * the outbound-sourcing fact, so those always refresh.
   */
  private async propertiesRespectingExisting(recordId: string, company: HubSpotCompanyRecord) {
    const PRESERVED = [
      'name', 'domain', 'website', 'city', 'state_', 'country_', 'description',
      'industry_', 'round_currently_raising', 'total_raising_for_round',
      'top_accelerator_participation', 'diverse_group', 'if_other__please_specify_diverse_group',
      'hubspot_owner_id',
    ] as const;
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
    // caller asked for create-new (e.g. a repeated click). The link
    // comes from the caller's own locally-persisted hubspot_company_id
    // (see server/routes/hubspot.ts's performSync) — there is no
    // HubSpot-side property to fall back to searching by.
    const targetId = resolution === 'update-existing' ? existingRecordId : null;
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
    // Same as the company — the caller's persisted hubspot_deal_id is
    // the only link; no HubSpot-side property to search by instead.
    const dealTargetId = existingDealId;
    const dealUpdating = !!dealTargetId;
    const dealProps = buildDealProperties(deal, stageId, pipelineId) as Record<string, string | number | null>;
    // Owner is preserve-if-set, same reasoning as the company: a human
    // may have manually reassigned the deal, and a resync shouldn't fight it.
    if (dealUpdating) delete dealProps.hubspot_owner_id;
    const dealRes = dealTargetId
      ? await this.call<{ id: string }>(`/crm/v3/objects/deals/${dealTargetId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: dealProps }),
        })
      : await this.call<{ id: string }>('/crm/v3/objects/deals', {
          method: 'POST',
          body: JSON.stringify({ properties: dealProps }),
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

    // Provenance + everything that has no property home (score,
    // rationale, risks, evidence, sourcing status, source URLs) — a
    // Note, never a new property. See buildSyncNoteBody.
    const note = await this.call<{ id: string }>('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: { hs_note_body: buildSyncNoteBody(deal, updating), hs_timestamp: new Date().toISOString() },
      }),
    });
    await assoc('notes', note.id, 'companies', companyRes.id);
    await assoc('notes', note.id, 'deals', dealRes.id);

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
        ? 'HubSpot record updated (existing explicit HubSpot field values were preserved).'
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
