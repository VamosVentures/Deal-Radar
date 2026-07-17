import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type FullStatus } from '../lib/api';

interface IntegrationsApi {
  status: FullStatus | null;
  /** null while loading; false when the backend is unreachable. */
  backendUp: boolean | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<IntegrationsApi | null>(null);

export function IntegrationsProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FullStatus | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setBackendUp(true);
    } catch {
      setStatus(null);
      setBackendUp(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ status, backendUp, refresh }}>{children}</Ctx.Provider>;
}

export function useIntegrations(): IntegrationsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useIntegrations must be used inside IntegrationsProvider');
  return ctx;
}
