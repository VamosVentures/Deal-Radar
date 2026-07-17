import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { loadCompanies } from '../data/loader';
import type { Company } from '../types';
import { api, type CompanyMeta } from '../lib/api';

/**
 * Single source of companies for the UI: the bundled sample dataset
 * plus any locally-imported CSV companies (validated server-side
 * through the same guardrails — sourced evidence required, identity
 * columns refused). Refresh metadata from refresh jobs is merged in.
 */

interface CompaniesApi {
  companies: Company[];
  importedCount: number;
  meta: Record<string, CompanyMeta>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<CompaniesApi | null>(null);

export function CompaniesProvider({ children }: { children: ReactNode }) {
  const bundled = useMemo(loadCompanies, []);
  const [imported, setImported] = useState<Company[]>([]);
  const [meta, setMeta] = useState<Record<string, CompanyMeta>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await api.imports.imported();
      setImported(
        (data.companies as (Company & { imported: boolean })[]).map((c) => ({
          ...c,
          // Imported rows never carry identity data — the server refuses
          // those columns — so founders arrive without `identity` and the
          // UI correctly shows "Identity not on record — never inferred".
        })),
      );
      setMeta(data.companyMeta ?? {});
    } catch {
      // Backend offline — bundled data still works.
      setImported([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const companies = useMemo(() => {
    const merged = [...bundled, ...imported];
    return merged.map((c) => (meta[c.id]?.lastRefreshed ? { ...c, lastRefreshed: meta[c.id].lastRefreshed } : c));
  }, [bundled, imported, meta]);

  return (
    <Ctx.Provider value={{ companies, importedCount: imported.length, meta, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCompanies(): CompaniesApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCompanies must be used inside CompaniesProvider');
  return ctx;
}
