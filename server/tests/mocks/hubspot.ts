import { store, type MockHubSpotObject } from '../../lib/store';
import { audit } from '../../lib/guard';
import {
  buildCompanyProperties,
  buildContactProperties,
  buildDealProperties,
  type DuplicateCheckInput,
  type HubSpotService,
  type HubSpotSearchHit,
} from '../../services/hubspot';
import {
  normalizeCompanyName,
  normalizeDomain,
  RADAR_HUBSPOT_STAGES,
  type DuplicateMatch,
  type HubSpotPipelineInfo,
  type SyncResult,
} from '../../../shared/integrations';

/**
 * TEST FIXTURE ONLY. An in-memory HubSpot used by the automated tests
 * to exercise the full HTTP workflow without a real portal. This class
 * is never used by the running application — production resolves to
 * the live client or an honest "not connected" error.
 */
export class MockHubSpot implements HubSpotService {
  mode = 'mock' as const;

  async verifyConnection() {
    return {
      ok: true,
      detail: 'Test fixture: in-memory HubSpot store responded. No real HubSpot connection was verified.',
    };
  }

  async search(query: string, type: 'companies' | 'contacts' | 'deals'): Promise<HubSpotSearchHit[]> {
    const q = query.trim().toLowerCase();
    const objType = type === 'companies' ? 'company' : type === 'contacts' ? 'contact' : 'deal';
    return store.raw.mockHubSpot
      .filter((o) => o.type === objType)
      .filter((o) => JSON.stringify(o.properties).toLowerCase().includes(q))
      .slice(0, 8)
      .map((o) => ({
        recordId: o.id,
        type: objType as 'company' | 'contact' | 'deal',
        title: String(o.properties.name ?? `${o.properties.firstname ?? ''} ${o.properties.lastname ?? ''}`.trim()),
        subtitle: String(o.properties.domain ?? o.properties.email ?? '—'),
        url: null,
        demo: true,
      }));
  }

  async checkDuplicate(input: DuplicateCheckInput): Promise<DuplicateMatch[]> {
    const companies = store.raw.mockHubSpot.filter((o) => o.type === 'company');
    const asMatch = (o: MockHubSpotObject, matchedOn: DuplicateMatch['matchedOn']): DuplicateMatch => ({
      recordId: o.id,
      name: String(o.properties.name ?? ''),
      domain: (o.properties.domain as string | null) ?? null,
      matchedOn,
      url: null, // fixture — no real HubSpot record exists, so no link is fabricated
      demo: true,
    });

    // Same tier order as the live client.
    if (input.dealRadarId) {
      const byRadar = companies.filter((o) => o.properties.vamos_deal_radar_id === input.dealRadarId);
      if (byRadar.length > 0) return byRadar.map((o) => asMatch(o, 'radar-id'));
    }
    const nDomain = normalizeDomain(input.domain);
    if (nDomain) {
      const byDomain = companies.filter((o) => normalizeDomain(String(o.properties.domain ?? '')) === nDomain);
      if (byDomain.length > 0) return byDomain.map((o) => asMatch(o, 'domain'));
    }
    const nName = normalizeCompanyName(input.name);
    const byName = companies.filter((o) => normalizeCompanyName(String(o.properties.name ?? '')) === nName);
    if (byName.length > 0) return byName.map((o) => asMatch(o, 'name'));

    const emails = new Set((input.founderEmails ?? []).map((e) => e.toLowerCase()));
    if (emails.size > 0) {
      return store.raw.mockHubSpot
        .filter((o) => o.type === 'contact' && emails.has(String(o.properties.email ?? '').toLowerCase()))
        .map((o) => ({
          recordId: o.id,
          name: `Contact: ${o.properties.firstname ?? ''} ${o.properties.lastname ?? ''} (${o.properties.email})`.trim(),
          domain: null,
          matchedOn: 'founder-email' as const,
          url: null,
          demo: true,
        }));
    }
    return [];
  }

  async getPipelines(): Promise<HubSpotPipelineInfo[]> {
    return [
      {
        id: 'test-pipeline',
        label: 'Test fixture pipeline (not a real HubSpot pipeline)',
        stages: RADAR_HUBSPOT_STAGES.map((s) => ({
          id: `test-${s.toLowerCase().replace(/\s+/g, '-')}`,
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
    const { company, contacts, deal, stageId, pipelineId, resolution, existingRecordId, existingDealId } = args;
    // Same idempotency as the live client: a radar record synced before
    // updates its existing company instead of creating a twin.
    const prior = store.raw.mockHubSpot.find(
      (o) => o.type === 'company' && o.properties.vamos_deal_radar_id === company.dealRadarId,
    );
    const targetId = (resolution === 'update-existing' && existingRecordId) ? existingRecordId : prior?.id ?? null;
    const updating = !!targetId;
    const companyObj = this.put(
      'company',
      buildCompanyProperties(company),
      targetId,
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
    // Same idempotency for the deal: prefer the caller's persisted
    // hubspot_deal_id, else fall back to a search by our own
    // vamos_deal_radar_id property (records synced before this link
    // was tracked).
    const priorDeal = store.raw.mockHubSpot.find(
      (o) => o.type === 'deal' && o.properties.vamos_deal_radar_id === deal.dealRadarId,
    );
    const dealTargetId = existingDealId ?? priorDeal?.id ?? null;
    const dealUpdating = !!dealTargetId;
    const dealObj = this.put('deal', buildDealProperties(deal, stageId, pipelineId), dealTargetId);

    dealObj.associations = Array.from(new Set([...dealObj.associations, companyObj.id, ...contactObjs.map((o) => o.id)]));
    companyObj.associations = Array.from(
      new Set([...companyObj.associations, dealObj.id, ...contactObjs.map((o) => o.id)]),
    );
    store.save();

    audit({
      provider: 'hubspot', mode: 'local',
      action: updating ? 'update-company' : 'create-company',
      subject: company.dealRadarId, outcome: 'ok',
      detail: `Test fixture: simulated ${updating ? 'update of' : 'creation of'} company, ${contactObjs.length} contact(s), ${dealUpdating ? 'update of' : 'creation of'} 1 deal`,
    });

    return {
      demo: true,
      companyId: companyObj.id,
      companyUrl: null, // no real record — never fabricate a HubSpot link
      contactIds: contactObjs.map((o) => o.id),
      dealId: dealObj.id,
      dealUrl: null,
      action: updating ? 'updated' : 'created',
      message: 'Test fixture: simulated HubSpot sync. No real HubSpot records were created.',
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
      provider: 'hubspot', mode: 'local', action: 'log-activity',
      subject: args.companyRecordId, outcome: 'ok',
      detail: 'Test fixture: simulated HubSpot note',
    });
    return { noteId: note.id, demo: true };
  }
}
