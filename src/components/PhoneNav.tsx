import { Building2, CalendarDays, History, ListChecks, Plus, StickyNote, Users } from 'lucide-react';
import { canUserAssignTasks } from '../lib/permissions';
import type { User } from '../types';

interface PhoneNavProps {
  user: User;
  hasVenues: boolean;
  onOpenTaskModal: () => void;
  onOpenShiftNote: () => void;
  onOpenVenues: () => void;
  onOpenTeam: () => void;
  onOpenEvents: () => void;
  onOpenHistory: () => void;
}

const press = 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-surface transition-transform duration-(--dur-fast) ease-shutfey active:scale-[0.97] motion-reduce:transition-none motion-reduce:transform-none';
// The existing header menu covers the phone canvas; keep its actions unobstructed.
const menuHidden = '[[data-phone-layout]:has(header>div.border-t)_&]:invisible';

export function getPhoneNavState(user: User | null | undefined, hasVenues: boolean): { showBar: boolean; showGold: boolean } {
  if (!user || !['admin', 'coordinator', 'mashgiach', 'worker', 'owner'].includes(user.role)) {
    return { showBar: false, showGold: false };
  }
  return {
    showBar: user.role !== 'owner',
    showGold: hasVenues && (canUserAssignTasks(user) || ['coordinator', 'mashgiach', 'worker'].includes(user.role)),
  };
}

export function PhoneNav({ user, hasVenues, onOpenTaskModal, onOpenShiftNote, onOpenVenues, onOpenTeam, onOpenEvents, onOpenHistory }: PhoneNavProps) {
  const { role } = user;
  const { showBar, showGold } = getPhoneNavState(user, hasVenues);
  const canAssign = canUserAssignTasks(user);
  if (!showBar && !showGold) return null;

  const items = [
    { label: 'Tasks', icon: ListChecks, action: () => window.scrollTo({ top: 0 }), active: true },
    ...(role === 'admin'
      ? [{ label: 'Venues', icon: Building2, action: onOpenVenues }]
      : [{ label: 'Events', icon: CalendarDays, action: onOpenEvents }]),
    ...(['admin', 'coordinator'].includes(role) ? [{ label: 'Team', icon: Users, action: onOpenTeam }] : []),
    { label: 'History', icon: History, action: onOpenHistory },
  ];

  return (
    <>
      {showBar && (
        <nav aria-label="Main" className={`sm:hidden fixed inset-x-0 bottom-0 z-20 bg-surface border-t border-line tactile-2 pb-[env(safe-area-inset-bottom)] ${menuHidden}`}>
          <div className="min-h-[63px] flex items-stretch">
            {items.map(({ label, icon: Icon, action, ...item }) => {
              const active = 'active' in item && item.active;
              return (
                <button key={label} type="button" onClick={action} aria-current={active ? 'page' : undefined}
                  className={`relative flex-1 min-w-11 min-h-11 flex flex-col items-center justify-center gap-1 px-1 py-2 text-xs ${active ? 'text-ink font-semibold' : 'text-ink-soft'} ${press}`}>
                  {active && <span aria-hidden="true" className="absolute top-0 h-0.5 w-6 bg-ink" />}
                  <Icon aria-hidden="true" className="w-6 h-6" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
      {showGold && (
        <button type="button" aria-label={canAssign ? 'New task' : 'Shift note'} onClick={canAssign ? onOpenTaskModal : onOpenShiftNote}
          className={`sm:hidden fixed right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] z-20 w-14 h-14 rounded-full bg-gold-deep text-paper tactile-2 flex items-center justify-center ${press} ${menuHidden}`}>
          {canAssign ? <Plus aria-hidden="true" className="w-6 h-6" /> : <StickyNote aria-hidden="true" className="w-6 h-6" />}
        </button>
      )}
    </>
  );
}
