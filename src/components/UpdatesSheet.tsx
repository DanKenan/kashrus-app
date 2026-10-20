import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Announcements } from './Announcements';
import { HandoffNotes } from './HandoffNotes';
import { AnnouncementItem } from '../lib/updates';
import { UpdatesTab } from './UpdatesCenter';

// 5a — the Updates sheet. Phone (<640 px): a bottom sheet at ~85% height
// whose grab handle toggles full height; dvh units keep it correct with the
// keyboard open. Tablet/desktop: a 420 px right-side panel. Opens and closes
// at the D1 slow duration (320 ms) with transform only; reduced motion gets
// no slide. Focus is trapped while open, Esc / backdrop / handle close it,
// and focus returns to the bell.

interface UpdatesSheetProps {
  open: boolean;
  onClose: () => void;
  activeTab: UpdatesTab;
  onTabChange: (tab: UpdatesTab) => void;
  unreadAnnouncements: number;
  unreadNotes: number;
  // Tab bodies
  announcements: React.ReactNode;
  notes: React.ReactNode;
}

export function UpdatesSheet({
  open,
  onClose,
  activeTab,
  onTabChange,
  unreadAnnouncements,
  unreadNotes,
  announcements,
  notes,
}: UpdatesSheetProps) {
  const [expanded, setExpanded] = useState(false);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Slide in on the next frame so the transition runs; the sheet unmounts
  // only after App closes it (the exit is instant — closing must never lag
  // behind a context switch).
  useEffect(() => {
    if (!open) { setEntered(false); return; }
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(r);
  }, [open ]);

  // Focus trap + Esc + focus the panel on open; return focus to the bell.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const prevFocus = document.getElementById('updates-bell');
    panel?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, audio[controls], [tabindex]:not([tabindex="-1"])',
      );
      const list = [...focusables].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (prevFocus as HTMLElement | null)?.focus?.();
    };
  }, [open ]);

  if (!open) return null;

  const tabBtn = (tab: UpdatesTab, label: string, count: number) => (
    <button
      key={tab}
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      onClick={() => onTabChange(tab)}
      className={`pressable flex-1 h-12 flex items-center justify-center gap-2 text-base font-bold border-b-2 transition cursor-pointer ${
        activeTab === tab ? 'border-gold text-ink' : 'border-transparent text-ink-faint'
      }`}
    >
      {label}
      {count > 0 && (
        <span className="min-w-5 h-5 px-1 rounded-full bg-gold text-white text-xs font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Updates">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`absolute bg-surface e3 flex flex-col outline-none
          max-sm:inset-x-0 max-sm:bottom-0 max-sm:rounded-t-3xl max-sm:border-t max-sm:border-line
          ${expanded ? 'max-sm:h-[100dvh]' : 'max-sm:h-[85dvh]'}
          sm:top-0 sm:right-0 sm:h-full sm:w-[420px] sm:max-w-full sm:border-l sm:border-line
          motion-safe:transition-transform ${entered ? '' : 'max-sm:translate-y-full sm:translate-x-full'}`}
        style={{ transitionDuration: 'var(--dur-slow)' }}
      >
        {/* Grab handle (phone): toggles full height; also a close affordance */}
        <button
          type="button"
          aria-label={expanded ? 'Shrink panel' : 'Expand panel'}
          onClick={() => setExpanded((e) => !e)}
          className="sm:hidden w-full h-11 flex items-center justify-center cursor-pointer shrink-0"
        >
          <span className="w-10 h-1.5 rounded-full bg-line" />
        </button>

        <div className="flex items-center justify-between px-4 pt-1 pb-0 shrink-0">
          <h2 className="text-xl font-black">Updates</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close updates"
            className="pressable w-11 h-11 flex items-center justify-center rounded-lg hover:bg-sunken transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex px-2 border-b border-line shrink-0" role="tablist" aria-label="Updates tabs">
          {tabBtn('announcements', 'Announcements', unreadAnnouncements)}
          {tabBtn('notes', 'Shift notes', unreadNotes)}
        </div>

        {activeTab === 'announcements' ? announcements : notes}
      </div>
    </div>
  );
}

// canDelete rule shared by App (mirrors the server): admins delete any
// announcement of their agency; a coordinator only their own venue's.
export function announcementCanDelete(
  item: AnnouncementItem,
  role: string,
  venueId: string,
): boolean {
  if (role === 'admin') return true;
  if (role === 'coordinator') return !!item.venueId && item.venueId === venueId;
  return false;
}
