import React from 'react';
import { CalendarDays, Factory, History, LayoutList, Plus, RotateCcw, Users } from 'lucide-react';
import type { User } from '../types';
import { canUserAssignTasks } from '../lib/permissions';
import { SHOW_FACTORY_AUDIT } from '../lib/features';

/**
 * Don 2026-10-22 (menu cleanup): the venue's own things live on the venue's
 * screen, not in the top menu. A tab row "Board · Events · Team · History"
 * (Factory Audit is hidden for now: SHOW_FACTORY_AUDIT). Board is today's board; the other tabs open that venue's
 * sheet (the tab shows as current while its sheet is open). A tab a role
 * cannot use is not shown. Same roles as the old menu items:
 * Events, History (and Factory Audit when shown): everyone; Team: admin + coordinator.
 * The Board tab carries "+ New assignment" (assigners) and "Reset board" (admin).
 */
export type VenueTab = 'board' | 'events' | 'factory' | 'team' | 'history';

export function venueTabsFor(user: Pick<User, 'role'> | null): VenueTab[] {
  if (!user) return [];
  const tabs: VenueTab[] = ['board', 'events'];
  if (SHOW_FACTORY_AUDIT) tabs.push('factory');
  if (user.role === 'admin' || user.role === 'coordinator') tabs.push('team');
  tabs.push('history');
  return tabs;
}

const META: Record<VenueTab, { label: string; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = {
  board: { label: 'Board', icon: LayoutList },
  events: { label: 'Events', icon: CalendarDays },
  factory: { label: 'Factory Audit', icon: Factory },
  team: { label: 'Team', icon: Users },
  history: { label: 'History', icon: History },
};

interface VenueTabsProps {
  currentUser: User | null;
  active: VenueTab;
  eventsCount?: number;
  onOpen: (tab: Exclude<VenueTab, 'board'>) => void;
  onBoard: () => void;
  onNewAssignment: () => void;
  onResetBoard: () => void;
}

export const VenueTabs: React.FC<VenueTabsProps> = ({ currentUser, active, eventsCount = 0, onOpen, onBoard, onNewAssignment, onResetBoard }) => {
  const tabs = venueTabsFor(currentUser);
  if (tabs.length === 0) return null;
  const canAssign = canUserAssignTasks(currentUser);
  const isAdmin = currentUser?.role === 'admin';
  return (
    <div className="space-y-2" data-venue-tabs>
      <nav aria-label="Venue" className="-mx-1 px-1 overflow-x-auto [scrollbar-width:none]">
        <div className="flex items-center gap-1 min-w-max border-b border-line">
          {tabs.map((tab) => {
            const { label, icon: Icon } = META[tab];
            const current = tab === active;
            return (
              <button
                key={tab}
                type="button"
                data-venue-tab={tab}
                aria-current={current ? 'page' : undefined}
                onClick={() => (tab === 'board' ? onBoard() : onOpen(tab))}
                className={`pressable min-h-11 inline-flex items-center gap-1.5 px-2.5 -mb-px border-b-2 text-sm font-semibold whitespace-nowrap cursor-pointer transition ${
                  current ? 'border-gold text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                <Icon aria-hidden className="w-4 h-4 shrink-0" />
                <span>{label}</span>
                {tab === 'events' && eventsCount > 0 && (
                  <span className="tnum text-[11px] font-bold px-1.5 rounded-full bg-gold-wash text-gold-ink">{eventsCount}</span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
      {active === 'board' && (canAssign || isAdmin) && (
        <div className="flex flex-wrap items-center gap-2" data-board-actions>
          {canAssign && (
            <button
              type="button"
              onClick={onNewAssignment}
              className="sm:hidden pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-1 cursor-pointer"
            >
              <Plus aria-hidden="true" className="w-4 h-4 stroke-[2.5]" />
              <span>New assignment</span>
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={onResetBoard}
              className="pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl bg-surface border border-line-control text-ink text-sm font-semibold hover:bg-sunken cursor-pointer"
            >
              <RotateCcw aria-hidden="true" className="w-4 h-4" />
              <span>Reset board</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
