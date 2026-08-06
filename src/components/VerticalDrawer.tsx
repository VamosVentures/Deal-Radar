import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CORE_VERTICAL_IDS, verticalById } from '../data/taxonomy';

/**
 * Mobile-only bottom sheet listing all 5 approved verticals — the same
 * links the desktop sidebar's "Verticals" group shows, just collapsed
 * behind one tab so the mobile bottom bar doesn't have to fit every
 * item. Built on the same overlay/Escape/scroll-lock pattern as Modal.tsx.
 */
export function VerticalDrawer({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const activeParams = new URLSearchParams(location.search);
  const activeVertical = location.pathname === '/companies' ? activeParams.get('vertical') : null;

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
      className="fixed inset-0 z-50 flex items-end bg-ink/60 backdrop-blur-[2px] lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Investment verticals"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full border-t border-white/10 bg-ink pb-[env(safe-area-inset-bottom)] text-white shadow-2xl">
        <div className="h-[3px] bg-marigold" aria-hidden />
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-marigold">Verticals</span>
          <button onClick={onClose} aria-label="Close verticals menu" className="rounded-[2px] px-2 py-1 text-white/60 hover:text-white">✕</button>
        </div>
        <nav aria-label="Verticals" className="grid grid-cols-2 gap-1 px-3 pb-4">
          {CORE_VERTICAL_IDS.map((id) => {
            const v = verticalById(id);
            const isActive = activeVertical === id;
            return (
              <Link
                key={id}
                to={`/companies?vertical=${id}`}
                onClick={onClose}
                className={`rounded-[2px] px-3 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-white/[0.08] font-semibold text-marigold' : 'text-white/75 hover:bg-white/[0.05] hover:text-white'
                }`}
              >
                {v.name}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
