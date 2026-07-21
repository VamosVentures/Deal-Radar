import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { DEFAULT_STALE_SETTINGS, type StaleSettings } from '../../shared/integrations';

const input = 'rounded-[2px] border border-line bg-panel px-2 py-1';

/**
 * Administrator-configurable stale-record settings. Distinct from a
 * schedule job's "refresh age" (drives the stale-record-refresh job
 * type) and a discovery query's evidence-recency filter (drops
 * candidates by evidence age) — this only controls when the Companies/
 * Overview UI flags an existing company Stale. Changes apply
 * immediately; no restart, no code change.
 */
export function StaleSettingsPanel() {
  const [settings, setSettings] = useState<StaleSettings>(DEFAULT_STALE_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.staleSettings.get().then(setSettings).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await api.staleSettings.update(settings);
      setSettings(updated);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 border border-line bg-panel p-4">
      <h2 className="font-display text-base font-semibold text-ink">Stale-record settings</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-mid">
        Controls when the Companies/Overview UI flags an existing company "Stale" — separate from a
        schedule's refresh age and from discovery's evidence-recency filter.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-mid">
          Days before a company is stale
          <input
            type="number" min={1} max={365} className={input}
            value={settings.staleAfterDays}
            onChange={(e) => setSettings({ ...settings, staleAfterDays: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-mid">
          Max stale companies listed on Overview
          <input
            type="number" min={1} max={500} className={input}
            value={settings.maxStaleOnOverview}
            onChange={(e) => setSettings({ ...settings, maxStaleOnOverview: Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox" checked={settings.monitorGoesStale}
            onChange={(e) => setSettings({ ...settings, monitorGoesStale: e.target.checked })}
          />
          Monitor companies can go stale
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox" checked={settings.researchNeededGoesStale}
            onChange={(e) => setSettings({ ...settings, researchNeededGoesStale: e.target.checked })}
          />
          Research Needed companies can go stale
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox" checked={settings.showStaleOnOverview}
            onChange={(e) => setSettings({ ...settings, showStaleOnOverview: e.target.checked })}
          />
          Show stale-companies metric on Overview
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-mid">
          Default stale filter on Companies page
          <select
            className={input}
            value={settings.defaultStaleFilter}
            onChange={(e) => setSettings({ ...settings, defaultStaleFilter: e.target.value as StaleSettings['defaultStaleFilter'] })}
          >
            <option value="all">Show all companies</option>
            <option value="stale-only">Stale only</option>
            <option value="exclude-stale">Exclude stale</option>
          </select>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-[2px] border border-line bg-panel px-3 py-1.5 text-xs font-semibold hover:border-marigold hover:text-marigold disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save stale settings'}
        </button>
        {saved && <span className="text-xs text-verde">Saved — takes effect immediately.</span>}
        {err && <span className="text-xs text-alerta">{err}</span>}
      </div>
    </section>
  );
}
