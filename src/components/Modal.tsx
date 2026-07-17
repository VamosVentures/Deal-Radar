import { useEffect } from 'react';
import type { ReactNode } from 'react';

export function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 p-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} rounded-md border border-line bg-panel shadow-xl`}>
        <header className="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            {eyebrow && <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-marigold">{eyebrow}</div>}
            <h2 className="font-display text-lg font-bold leading-tight">{title}</h2>
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="rounded-sm px-2 py-1 text-slate-mid hover:bg-paper hover:text-ink">✕</button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function DemoBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="rounded-sm bg-marigold-soft px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-marigold">
      Demo Mode
    </span>
  );
}

export function ErrorNote({ message, hint, issues }: { message: string; hint?: string; issues?: string[] }) {
  return (
    <div className="rounded-sm border border-alerta/40 bg-alerta-soft px-3 py-2 text-xs text-alerta">
      <div className="font-semibold">{message}</div>
      {hint && <div className="mt-1 text-ink/80">{hint}</div>}
      {issues && issues.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-ink/80">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Field({
  label, value, onChange, textarea = false, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  placeholder?: string;
}) {
  const cls = 'mt-0.5 w-full rounded-sm border border-line bg-panel px-2 py-1.5 font-body text-xs normal-case';
  return (
    <label className="block font-mono text-[10px] uppercase tracking-wider text-slate-mid">
      {label}
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className={cls} placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={cls} placeholder={placeholder} />
      )}
    </label>
  );
}

export const btnPrimary =
  'rounded-sm bg-marigold px-3 py-1.5 font-mono text-[11px] font-bold text-ink transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40';
export const btnGhost =
  'rounded-sm border border-line bg-panel px-3 py-1.5 font-mono text-[11px] font-semibold text-slate-mid transition-colors hover:border-marigold hover:text-marigold disabled:cursor-default disabled:opacity-40';
export const btnDanger =
  'rounded-sm border border-alerta/40 bg-panel px-3 py-1.5 font-mono text-[11px] font-semibold text-alerta transition-colors hover:bg-alerta-soft disabled:opacity-40';
