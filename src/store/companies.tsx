import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Company } from '../types';
import { api, ApiError, type CompanyMeta } from '../lib/api';
import type { Opportunity } from '../../shared/opportunity';
import type { IssuerQualification } from '../../shared/qualification';

/**
 * Single source of companies for the UI: rows imported through the
 * server (CSV import or Deal Discovery — both validated server-side
 * with sourced-evidence guardrails; identity columns refused). There
 * is no bundled sample dataset: when nothing has been imported yet,
 * the UI shows an honest empty state.
 */

interface CompaniesApi {
  companies: Company[];
  importedCount: number;
  meta: Record<string, CompanyMeta>;
  /** Opportunity classification per company id. Absent = treated as a lead. */
  opportunities: Record<string, Opportunity>;
  /** Issuer qualification verdict per company id. */
  qualifications: Record<string, IssuerQualification>;
  /** Quarantined (disqualified) companies, with the reason. */
  quarantine: Record<string, { reason: string; at: string }>;
  /** null while the first load is in flight. */
  loaded: boolean;
  /** Set when the backend can't be reached — pages surface it honestly. */
  loadError: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<CompaniesApi | null>(null);

export function CompaniesProvider({ children }: { children: ReactNode }) {
  const [imported, setImported] = useState<Company[]>([]);
  const [meta, setMeta] = useState<Record<string, CompanyMeta>>({});
  const [opportunities, setOpportunities] = useState<Record<string, Opportunity>>({});
  const [qualifications, setQualifications] = useState<Record<string, IssuerQualification>>({});
  const [quarantine, setQuarantine] = useState<Record<string, { reason: string; at: string }>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.imports.imported();
      // Imported rows never carry identity data — the server refuses
      // those columns — so founders arrive without `identity` and the
      // UI correctly shows "Identity not on record — never inferred".
      setImported(data.companies as Company[]);
      setMeta(data.companyMeta ?? {});
      setOpportunities((data.opportunities ?? {}) as Record<string, Opportunity>);
      setQualifications((data.qualifications ?? {}) as Record<string, IssuerQualification>);
      setQuarantine(data.quarantine ?? {});
      setLoadError(null);
    } catch (e) {
      setImported([]);
      setOpportunities({});
      setQualifications({});
      setQuarantine({});
      setLoadError(e instanceof ApiError ? e.message : 'The company list could not be loaded.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const companies = useMemo(
    () => imported.map((c) => (meta[c.id]?.lastRefreshed ? { ...c, lastRefreshed: meta[c.id].lastRefreshed } : c)),
    [imported, meta],
  );

  return (
    <Ctx.Provider value={{ companies, importedCount: imported.length, meta, opportunities, qualifications, quarantine, loaded, loadError, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCompanies(): CompaniesApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCompanies must be used inside CompaniesProvider');
  return ctx;
}
