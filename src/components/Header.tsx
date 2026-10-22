import { venueTimeZone } from '../lib/workday';
import { HeaderDateLine } from './HeaderDateLine';
import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmModal } from './ConfirmModal';
import { clearSession } from '../lib/api';
import { 
  CheckCircle2, 
  Wifi, 
  WifiOff, 
  Users, 
  Plus, 
  RotateCcw, 
  History, 
  Sun, 
  Moon, 
  LogOut, 
  ShieldCheck, 
  UserCheck, 
  CalendarDays,
  Menu,
  X,
  KeyRound,
  Download,
  LogIn,
  User as UserIcon,
  Building2,
  ChevronDown,
  Store,
  Calendar,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Factory,
  Tablet,
  Home
} from 'lucide-react';
import { User, Venue } from '../types';
import { ShutfeyLogo } from './ShutfeyLogo';
import { PWAInstallButton } from './PWAInstallButton';
import { PushNotificationToggle } from './PushNotificationToggle';
import { UpdateAppButton } from './UpdateAppButton';
import { getRoleLabel, canUserAssignTasks } from '../lib/permissions';

interface HeaderProps {
  agencyLogoSrc?: string | null;
  isAgencyHome?: boolean;
  onOpenAgencyHome?: () => void;
  currentUser: User | null;
  currentVenue: Venue | null;
  allVenues: Venue[];
  switchableVenues?: Venue[];
  onOpenVenueSwitcher?: () => void;
  onOpenVenuesHub?: () => void;
  onOpenVenuesDirectory?: () => void;
  onOpenCreateVenue: () => void;
  onSelectVenue: (venueId: string) => void;
  onOpenAuth?: () => void;
  onLogout: () => void;
  onOpenChangePassword?: () => void;
  onOpenTaskModal: () => void;
  onOpenHistoryModal: () => void;
  onOpenEventsModal: () => void;
  onOpenCreateEvent: () => void;
  onOpenFactoryAudit?: () => void;
  eventsCount?: number;
  /** 5a: the Updates bell, rendered beside the venue pill (App owns it). */
  updatesBell?: React.ReactNode;
  onOpenTeamModal: () => void;
  onOpenKioskDevices?: () => void;
  onResetDailyBoard: () => void;
  isRealtimeConnected: boolean;
  activeWorkersCount: number;
  totalWorkersCount: number;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  completionRate: number;
  isDemoCleared?: boolean;
  onRestoreDemo?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  agencyLogoSrc,
  isAgencyHome,
  onOpenAgencyHome,
  currentUser,
  currentVenue,
  allVenues,
  switchableVenues = [],
  onOpenVenueSwitcher,
  onOpenVenuesHub,
  onOpenVenuesDirectory,
  onOpenCreateVenue,
  onSelectVenue,
  onOpenAuth,
  onLogout,
  onOpenChangePassword,
  onOpenTaskModal,
  onOpenHistoryModal,
  onOpenEventsModal,
  onOpenCreateEvent,
  onOpenFactoryAudit,
  eventsCount = 0,
  updatesBell,
  onOpenTeamModal,
  onOpenKioskDevices,
  onResetDailyBoard,
  isRealtimeConnected,
  activeWorkersCount,
  totalWorkersCount,
  darkMode,
  onToggleDarkMode,
  completionRate,
  isDemoCleared = false,
  onRestoreDemo,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const openVenuesModal = onOpenVenuesHub || onOpenVenuesDirectory || (() => {});
  const canSwitchVenue = !!currentUser && currentUser.role !== 'admin' && switchableVenues.length >= 2 && !!onOpenVenueSwitcher;
  const venueTz = venueTimeZone(currentVenue, currentUser);

  // Enter kiosk mode: this device becomes a shared wall tablet.
  // K1: explain the pairing step FIRST (Don, Oct 20: it opened as himself and
  // only showed "Pair this tablet" after End shift). Continue goes through the
  // existing clean-slate entry (/?kiosk=1 in App.tsx), which signs this device
  // out, so no admin session is ever left on a wall tablet; the pairing
  // screen (or the PIN screen, once paired) takes over.
  const [kioskExplainOpen, setKioskExplainOpen] = useState(false);
  const enterKioskMode = () => {
    setUserMenuOpen(false);
    setMobileMenuOpen(false);
    setKioskExplainOpen(true);
  };
  const confirmEnterKioskMode = () => {
    setKioskExplainOpen(false);
    if (typeof window !== 'undefined') {
      // Sign this device out first with the app's own clearSession() (ChatGPT
      // plan review): the restored-session key current_user is not cleared by
      // /?kiosk=1. Kiosk pairing
      // credentials and offline data are left alone.
      clearSession();
      try { localStorage.removeItem('shutfey_user'); } catch {}
      window.location.assign('/?kiosk=1');
    }
  };
  const canEnterKiosk = currentUser?.role === 'admin' || currentUser?.role === 'coordinator';

  // Item 12: with an agency logo the phone header has no room for the venue name;
  // hide it fully below sm (icon + chevron only, as on main) instead of a one-glyph sliver.
  const venueNameHide = agencyLogoSrc ? ' max-sm:hidden' : '';

  return (
    <header className="sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-line tactile-1 transition-colors">
      {/* Click-outside transparent overlay for open dropdowns */}
      {(toolsMenuOpen || userMenuOpen) && (
        <div 
          className="fixed inset-0 z-40 bg-transparent" 
          onClick={() => { setToolsMenuOpen(false); setUserMenuOpen(false); }} 
        />
      )}

      <div className="@container max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between min-h-[56px] sm:min-h-[64px] py-1 sm:py-0 gap-3 [[data-phone-layout]_&]:max-sm:min-h-[55px] [[data-phone-layout]_&]:max-sm:py-0 [[data-phone-layout]_&]:max-sm:box-border">
          
          {/* Brand, Venue Switcher & Status */}
          {/* Rem-based container query wraps with large text; 20rem = 320px at 100%, so 360px+ phones at normal size are unchanged. */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 @max-[20rem]:flex-wrap @max-[20rem]:flex-1 @max-[20rem]:basis-0 @max-[20rem]:py-1">
            {/* The agency tag beside "Shutfey" must never be covered: the logo
                never shrinks; the venue button gives up width first (its name
                truncates with …). Below 360 px the word "Shutfey" steps aside
                (mark + agency tag stay) so the venue button keeps a usable size. */}
            <ShutfeyLogo 
              size="sm" 
              showSubtitle={false}
              agencyLogoSrc={agencyLogoSrc}
              agencyName={currentUser?.agencyName}
              agencyShortCode={currentUser?.agencyShortCode}
              compactBelow360
              className="shrink-0"
            />

            {/* Active Venue Selector Button */}
            {currentUser?.role === 'admin' ? (
              // H1: fixed px so large text does not grow the target
              <button
                id="admin-venue-switcher-btn"
                onClick={openVenuesModal}
                className="group flex items-center gap-1.5 px-[10px] py-[6px] rounded-xl bg-sunken hover:bg-line/40 border border-line transition cursor-pointer tactile-1 min-w-[44px] min-h-[44px]"
                title="Switch to another kosher venue"
              >
                {/* H1: fixed px so large text does not grow the target */}
                <Building2 className="w-[14px] h-[14px] text-gold-deep shrink-0" />
                <span className={`text-xs font-bold text-ink truncate min-w-0 max-w-[130px] sm:max-w-[170px]${venueNameHide}`}>
                  {currentVenue?.name || 'Select Venue'}
                </span>
                {/* H1: fixed px so large text does not grow the target */}
                <ChevronDown className="w-[12px] h-[12px] text-ink-faint group-hover:text-ink-soft transition shrink-0" />
              </button>
            ) : currentVenue && canSwitchVenue ? (
              <button
                type="button"
                onClick={onOpenVenueSwitcher}
                aria-haspopup="dialog"
                aria-label={`Switch venue, current: ${currentVenue.name}`}
                className="flex items-center gap-2 px-3 py-1 rounded-xl bg-ok-bg border border-line-control text-ok tactile-1 min-w-11 min-h-11 pressable cursor-pointer"
              >
                <Building2 className="w-4 h-4 shrink-0" />
                <span className={`text-xs font-bold truncate min-w-0 max-w-[130px] sm:max-w-[170px]${venueNameHide}`}>{currentVenue.name}</span>
                <ChevronDown className="w-4 h-4 shrink-0" />
              </button>
            ) : currentVenue ? (
              // H1: fixed px so large text does not grow the target
              <div className="flex items-center gap-1.5 px-[10px] py-[4px] rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/40 text-emerald-900 dark:text-emerald-200 tactile-1 min-w-[36px]">
                {/* H1: fixed px so large text does not grow the target */}
                <Building2 className="w-[14px] h-[14px] text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className={`text-xs font-bold truncate min-w-0 max-w-[130px] sm:max-w-[170px]${venueNameHide}`}>
                  {currentVenue.name}
                </span>
              </div>
            ) : null}

            {/* 5a: Updates bell — always-visible row, beside the venue pill */}
            {updatesBell}
            {currentUser?.role === 'admin' && onOpenAgencyHome && (
              // H1: fixed px so large text does not grow the target
              <button
                type="button"
                onClick={onOpenAgencyHome}
                aria-label="Agency dashboard"
                aria-current={isAgencyHome ? 'page' : undefined}
                className="min-w-[44px] min-h-[44px] shrink-0 inline-flex items-center justify-center gap-[8px] px-[8px] rounded-xl bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer"
              >
                <Home aria-hidden="true" className="w-[20px] h-[20px]" />
                <span className="hidden sm:inline text-sm font-semibold">Dashboard</span>
              </button>
            )}

            {/* Compact Live indicator */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-ink-faint pl-1">
              <span className="relative flex h-2 w-2">
                {isRealtimeConnected && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-emerald-400" />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isRealtimeConnected ? 'bg-emerald-500' : 'bg-gold'}`} />
              </span>
              <span className="font-semibold text-[11px]">
                {isRealtimeConnected ? 'Live' : 'Offline'}
              </span>
            </div>
          </div>

          {/* Desktop Actions Bar (Clean, Un-crowded) */}
          <div className="hidden lg:flex items-center gap-2">
            
            {/* Factory & Airtable Ingredients Audit Shortcut */}
            {onOpenFactoryAudit && (
              <button
                id="header-factory-audit-btn"
                onClick={onOpenFactoryAudit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-gold-ink bg-gold-wash hover:bg-gold/15 border border-gold/40 transition cursor-pointer tactile-1 shrink-0"
                title="Factory Floor & Airtable Ingredients Audit"
              >
                <Factory className="w-3.5 h-3.5 text-gold-deep" />
                <span>Factory Ingredients Audit</span>
              </button>
            )}

            {/* Events Badge Shortcut (if events active) */}
            {eventsCount > 0 && (
              <button
                id="header-events-btn"
                onClick={onOpenEventsModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-gold-ink bg-gold-wash hover:bg-gold-wash border border-gold/40 transition cursor-pointer tactile-1 shrink-0"
                title="Kosher Events & Banquets Hub"
              >
                <Calendar className="w-3.5 h-3.5 text-gold-deep" />
                <span>Events ({eventsCount})</span>
              </button>
            )}

            {/* Consolidated Agency Operations Dropdown */}
            <div className="relative">
              <button
                id="header-operations-menu-btn"
                onClick={() => { setToolsMenuOpen(!toolsMenuOpen); setUserMenuOpen(false); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-ink-soft bg-sunken hover:bg-line/40 border border-line transition cursor-pointer tactile-1 shrink-0"
                title="Access Agency Operations, Rosters, and Audits"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-ink-faint" />
                <span>Operations</span>
                <ChevronDown className={`w-3 h-3 text-ink-faint transition-transform ${toolsMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {toolsMenuOpen && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-surface border border-line tactile-4 py-2 z-50 text-ink-soft">
                  <div className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-ink-faint border-b border-line/70">
                    Kashrus Operations Hub
                  </div>

                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); openVenuesModal(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Store className="w-4 h-4 text-gold-deep" />
                        <span>Venues Directory</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sunken text-ink-faint font-bold">
                        {allVenues.length}
                      </span>
                    </button>
                  )}

                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenCreateVenue(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                    >
                      <Plus className="w-4 h-4 text-gold-deep" />
                      <span>Establish New Venue</span>
                    </button>
                  )}

                  {(currentUser?.role === 'admin' || currentUser?.role === 'coordinator') && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenTeamModal(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-gold-deep" />
                        <span>Mashgichim & Team</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sunken text-ink-faint font-bold">
                        {totalWorkersCount}
                      </span>
                    </button>
                  )}

                  {onOpenFactoryAudit && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenFactoryAudit(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Factory className="w-4 h-4 text-gold-deep" />
                        <span>Factory Ingredients Audit</span>
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gold/15 text-gold-deep border border-gold/30 font-bold uppercase">
                        Airtable
                      </span>
                    </button>
                  )}

                  <button
                    onClick={() => { setToolsMenuOpen(false); onOpenEventsModal(); }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-gold-deep" />
                      <span>Events & Banquets</span>
                    </span>
                    {eventsCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gold-wash text-gold-ink font-black">
                        {eventsCount}
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => { setToolsMenuOpen(false); onOpenHistoryModal(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-sunken transition text-left cursor-pointer"
                  >
                    <History className="w-4 h-4 text-gold-deep" />
                    <span>Inspection Audit History</span>
                  </button>

                  {currentUser?.role === 'admin' && (
                    <div className="pt-1 mt-1 border-t border-line/70">
                      <button
                        onClick={() => { setToolsMenuOpen(false); onResetDailyBoard(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-gold-wash text-gold-deep transition text-left cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4 text-gold-deep" />
                        <span>Reset Daily Venue Board</span>
                      </button>

                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Primary Action Button: New Assignment */}
            {canUserAssignTasks(currentUser) && (
              <button
                id="header-add-task-btn"
                onClick={onOpenTaskModal}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-black rounded-xl bg-gradient-to-r from-gold via-gold to-gold-deep hover:from-gold-deep hover:to-gold-ink active:scale-95 text-white tactile-1 transition cursor-pointer shrink-0"
                title="Create a new daily assignment"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>New Assignment</span>
              </button>
            )}

            {/* Install / Download App Button (auto-hides when installed) */}
            <PWAInstallButton />

            {/* User Profile & Settings Menu */}
            {currentUser ? (
              <div className="relative pl-1 border-l border-line">
                {/* H1: fixed px so large text does not grow the target */}
                <button
                  id="header-user-menu-btn"
                  onClick={() => { setUserMenuOpen(!userMenuOpen); setToolsMenuOpen(false); }}
                  className="flex items-center gap-1.5 p-1 rounded-full hover:bg-sunken transition cursor-pointer min-w-[44px] min-h-[44px]"
                  title={`${currentUser.name} (${getRoleLabel(currentUser.role)})`}
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black text-white tactile-1 ring-2 ring-gold/30"
                    style={{ backgroundColor: currentUser.avatarColor || '#d97706' }}
                  >
                    {currentUser.name.charAt(0).toUpperCase()}
                  </div>
                  <ChevronDown className={`w-3 h-3 text-ink-faint transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-surface border border-line tactile-4 p-3 z-50 text-ink-soft">
                    <div className="pb-2.5 mb-2 border-b border-line/70">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-xs text-ink truncate max-w-[150px]">
                          {currentUser.name}
                        </div>
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase ${
                          currentUser.role === 'admin'
                            ? 'bg-gold-wash text-gold-ink'
                            : currentUser.role === 'coordinator'
                            ? 'bg-sunken text-ink-soft border border-line'
                            : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                        }`}>
                          {getRoleLabel(currentUser.role)}
                        </span>
                      </div>
                      <div className="text-[11px] text-ink-faint truncate mt-0.5">
                        {currentUser.email}
                      </div>
                      {currentUser.agencyName && (
                        <div className="text-[10px] text-gold-deep font-semibold mt-1">
                          {currentUser.agencyName}
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      {/* Theme Toggle in Menu */}
                      <button
                        onClick={onToggleDarkMode}
                        className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer"
                      >
                        <span className="flex items-center gap-2 text-ink-soft">
                          {darkMode ? <Sun className="w-4 h-4 text-gold" /> : <Moon className="w-4 h-4 text-ink-faint" />}
                          <span>Appearance</span>
                        </span>
                        <span className="text-[11px] text-ink-faint font-normal">
                          {darkMode ? 'Dark' : 'Light'}
                        </span>
                      </button>

                      {/* Install PWA Option */}
                      <div className="px-1 py-1">
                        <PWAInstallButton variant="banner" />
                      </div>

                      {/* Phone push notifications */}
                      <div className="px-1 py-0.5 border-t border-line/60 mt-1 pt-1">
                        <PushNotificationToggle userEmail={currentUser.email} />
                      </div>

                      {/* Force-update: clear caches and load the newest version */}
                      <div className="px-1 py-0.5">
                        <UpdateAppButton />
                      </div>

                      {/* Kiosk mode: turn this device into a shared wall tablet */}
                      {canEnterKiosk && (
                        <div className="px-1 py-0.5 border-t border-line/60 mt-1 pt-1">
                          <button
                            onClick={enterKioskMode}
                            className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer text-ink-soft"
                            title="Lock this device to the staff sign-in screen"
                          >
                            <Tablet className="w-4 h-4 text-gold-deep" />
                            <span>Enter kiosk mode</span>
                          </button>
                          {onOpenKioskDevices && (
                            <button
                              onClick={() => { setUserMenuOpen(false); onOpenKioskDevices(); }}
                              className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer text-ink-soft"
                              title="Pair or unpair kiosk tablets"
                            >
                              <Tablet className="w-4 h-4 text-gold-deep" />
                              <span>Kiosk tablets</span>
                            </button>
                          )}
                        </div>
                      )}

                      {/* Change Password */}
                      {onOpenChangePassword && (
                        <button
                          onClick={() => { setUserMenuOpen(false); onOpenChangePassword(); }}
                          className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer text-ink-soft"
                        >
                          <KeyRound className="w-4 h-4 text-ink-faint" />
                          <span>Change Password</span>
                        </button>
                      )}

                      {/* Download Backup */}
                      <button
                        onClick={async () => {
                          setUserMenuOpen(false);
                          try {
                            const res = await fetch('/api/admin/export', {
                              headers: { 'Authorization': `Bearer ${localStorage.getItem('shutfey_session_token')}` }
                            });
                            if (!res.ok) throw new Error('Export failed');
                            const blob = await res.blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `shutfey-backup-${new Date().toISOString().slice(0, 10)}.json`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                          } catch (e) {
                            console.error('Backup failed:', e);
                          }
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-sunken transition cursor-pointer text-ink-soft"
                      >
                        <Download className="w-4 h-4 text-ink-faint" />
                        <span>Download Backup</span>
                      </button>

                      {/* Sign Out */}
                      <button
                        onClick={() => { setUserMenuOpen(false); onLogout(); }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-bold rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                id="header-login-btn"
                onClick={onOpenAuth}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gold hover:bg-gold-deep active:scale-95 text-white text-xs font-bold shadow-xs transition cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign In</span>
              </button>
            )}

          </div>

          {/* Mobile Right Bar: New Assignment + Menu Trigger */}
          <div className="flex lg:hidden items-center gap-1.5 shrink-0">
            {canUserAssignTasks(currentUser) && (
              <button
                id="mobile-header-new-task-btn"
                onClick={onOpenTaskModal}
                className="[[data-phone-layout]_&]:max-sm:hidden inline-flex items-center justify-center gap-1 px-2.5 py-1.5 min-w-11 min-h-11 rounded-xl bg-gradient-to-r from-gold to-gold-deep active:scale-95 text-white text-xs font-bold shadow-xs cursor-pointer shrink-0"
                title="Add New Assignment"
                aria-label="Add new assignment"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                {/* Narrow phones: icon only, so the venue name has room */}
                <span className="text-xs font-bold hidden min-[400px]:inline">New</span>
              </button>
            )}

            {/* H1: fixed px so large text does not grow the target */}
            <button
              id="mobile-header-menu-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xl text-ink-soft hover:bg-sunken cursor-pointer shrink-0"
              aria-label="Toggle mobile menu"
            >
              {/* H1: fixed px so large text does not grow the target */}
              {mobileMenuOpen ? <X className="w-[20px] h-[20px]" /> : (
                // H1: fixed px so large text does not grow the target
                <Menu className="w-[20px] h-[20px]" />
              )}
            </button>
          </div>
        </div>
        {/* D5: living header, a slim line under the top row */}
        {currentUser && <HeaderDateLine timeZone={venueTz} className="pb-1.5" />}
      </div>

      {/* Mobile Menu Dropdown */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-line bg-surface px-4 py-3 space-y-2 max-h-[85vh] overflow-y-auto">
          {/* Mobile Install App Banner */}
          <PWAInstallButton variant="banner" />

          {currentUser ? (
            <div className="py-2 border-b border-line/70 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: currentUser.avatarColor || '#d97706' }}
                  >
                    {currentUser.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-ink">{currentUser.name}</p>
                    <p className="text-[11px] text-ink-faint">{currentUser.email}</p>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  currentUser.role === 'admin'
                    ? 'bg-gold-wash text-gold-ink'
                    : 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                }`}>
                  {getRoleLabel(currentUser.role)}
                </span>
              </div>
              {currentUser.agencyName && (
                <div className="flex items-center gap-1.5 text-[11px] text-gold-deep pt-0.5 font-medium">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Agency: <strong>{currentUser.agencyName}</strong></span>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenAuth?.(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-lg text-white bg-gold hover:bg-gold-deep shadow-xs cursor-pointer"
            >
              <UserIcon className="w-4 h-4" />
              <span>Sign In to Your Account</span>
            </button>
          )}

          {canSwitchVenue && currentVenue && (
            <button
              type="button"
              onClick={() => { setMobileMenuOpen(false); onOpenVenueSwitcher?.(); }}
              aria-haspopup="dialog"
              aria-label={`Switch venue, current: ${currentVenue.name}`}
              className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl bg-ok-bg border border-line-control text-ok pressable cursor-pointer"
            >
              <Building2 className="w-4 h-4 shrink-0" />
              <span>Switch venue</span>
              <span className="truncate min-w-0 ml-auto">{currentVenue.name}</span>
              <ChevronDown className="w-4 h-4 shrink-0" />
            </button>
          )}

          {/* Mobile Admin Venue Switcher */}
          {currentUser?.role === 'admin' && (
            <div className="p-2.5 rounded-2xl bg-sunken border border-line space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setMobileMenuOpen(false); openVenuesModal(); }}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-xl bg-gold-wash text-gold-ink border border-gold/40 text-center cursor-pointer"
                >
                  Venues Hub ({allVenues.length})
                </button>
                <button
                  onClick={() => { setMobileMenuOpen(false); onOpenCreateVenue(); }}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-xl bg-gold text-white text-center cursor-pointer flex items-center justify-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>New Venue</span>
                </button>
              </div>
              {onOpenAgencyHome && (
                <button
                  type="button"
                  onClick={() => { setMobileMenuOpen(false); onOpenAgencyHome(); }}
                  aria-label="Agency dashboard"
                  aria-current={isAgencyHome ? 'page' : undefined}
                  className="w-full min-w-11 min-h-11 flex items-center gap-2 px-3 rounded-xl bg-surface border border-line-control text-ink hover:bg-sunken text-sm font-semibold pressable cursor-pointer"
                >
                  <Home aria-hidden="true" className="w-5 h-5" />
                  <span>Agency dashboard</span>
                </button>
              )}
            </div>
          )}

          {canUserAssignTasks(currentUser) && (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenTaskModal(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-xl text-white bg-gradient-to-r from-gold to-gold-deep shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>Create New Assignment</span>
            </button>
          )}

          {/* Factory Ingredients Audit on Mobile */}
          {onOpenFactoryAudit && (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenFactoryAudit(); }}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold rounded-xl text-gold-ink bg-gold-wash border border-gold/40 cursor-pointer tactile-1"
            >
              <span className="flex items-center gap-2">
                <Factory className="w-4 h-4 text-gold-deep" />
                <span>Factory Ingredients Audit (Airtable)</span>
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-gradient-to-b from-gold to-gold-deep text-white">
                Live
              </span>
            </button>
          )}

          {/* Events Hub on Mobile */}
          <button
            onClick={() => { setMobileMenuOpen(false); onOpenEventsModal(); }}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold rounded-xl text-gold-ink bg-gold-wash border border-gold/40 cursor-pointer tactile-1"
          >
            <span className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gold-deep" />
              <span>Kosher Events & Banquets</span>
            </span>
            {eventsCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-gold text-white">
                {eventsCount} active
              </span>
            )}
          </button>

          <div className="grid grid-cols-2 gap-2 pt-1">
            {(currentUser?.role === 'admin' || currentUser?.role === 'coordinator') && (
              <button
                onClick={() => { setMobileMenuOpen(false); onOpenTeamModal(); }}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-ink-soft bg-sunken cursor-pointer"
              >
                <Users className="w-4 h-4 text-gold-deep" />
                <span>Mashgichim ({totalWorkersCount})</span>
              </button>
            )}
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenHistoryModal(); }}
              className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-ink-soft bg-sunken cursor-pointer ${
                currentUser?.role === 'admin' ? '' : 'col-span-2'
              }`}
            >
              <History className="w-4 h-4 text-gold-deep" />
              <span>History Log</span>
            </button>
          </div>

          {currentUser?.role === 'admin' && (
            <div className="space-y-1.5">
              <button
                onClick={() => { setMobileMenuOpen(false); onResetDailyBoard(); }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-gold-deep bg-gold-wash border border-gold/40 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Reset Daily Board Now</span>
              </button>

            </div>
          )}

          {/* Theme Switcher on Mobile */}
          <button
            onClick={onToggleDarkMode}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold rounded-xl bg-sunken text-ink-soft cursor-pointer"
          >
            <span className="flex items-center gap-2">
              {darkMode ? <Sun className="w-4 h-4 text-gold" /> : <Moon className="w-4 h-4 text-ink-faint" />}
              <span>Toggle Appearance</span>
            </span>
            <span className="text-xs text-ink-faint">{darkMode ? 'Dark' : 'Light'}</span>
          </button>

          {/* App updates & phone notifications on Mobile */}
          {currentUser && (
            <div className="rounded-xl bg-sunken px-1 py-1">
              <PushNotificationToggle userEmail={currentUser.email} />
              <UpdateAppButton />
              {canEnterKiosk && (
                <>
                  <button
                    onClick={enterKioskMode}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-surface transition cursor-pointer text-ink-soft"
                    title="Lock this device to the staff sign-in screen"
                  >
                    <Tablet className="w-4 h-4 text-gold-deep" />
                    <span>Enter kiosk mode</span>
                  </button>
                  {onOpenKioskDevices && (
                    <button
                      onClick={() => { setMobileMenuOpen(false); onOpenKioskDevices(); }}
                      className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-surface transition cursor-pointer text-ink-soft"
                      title="Pair or unpair kiosk tablets"
                    >
                      <Tablet className="w-4 h-4 text-gold-deep" />
                      <span>Kiosk tablets</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <div className="pt-2 border-t border-line/70 flex justify-between items-center">
            {currentUser ? (
              <>
                {onOpenChangePassword && (
                  <button
                    onClick={() => { setMobileMenuOpen(false); onOpenChangePassword(); }}
                    className="text-xs font-semibold text-ink-soft flex items-center gap-1 cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-ink-faint" />
                    <span>Change Password</span>
                  </button>
                )}
                <button
                  onClick={() => { setMobileMenuOpen(false); onLogout(); }}
                  className="text-xs font-bold text-rose-600 hover:text-rose-700 dark:text-rose-400 flex items-center gap-1 ml-auto cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign Out
                </button>
              </>
            ) : (
              <button
                onClick={() => { setMobileMenuOpen(false); onOpenAuth?.(); }}
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-gold hover:bg-gold-deep text-white text-xs font-bold shadow-xs transition cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" /> Sign In to Account
              </button>
            )}
          </div>
        </div>
      )}
      {/* K1: what "Enter kiosk mode" will do, before it does it. Portalled to
          <body>: the header's backdrop blur would otherwise trap a fixed modal. */}
      {kioskExplainOpen && typeof document !== 'undefined' && createPortal(
        <ConfirmModal
          isOpen={kioskExplainOpen}
          onClose={() => setKioskExplainOpen(false)}
          onConfirm={confirmEnterKioskMode}
          title="Turn this device into a kiosk?"
          message={
            <ol className="list-decimal pl-5 space-y-1.5" data-testid="kiosk-explain-steps">
              <li>You'll be signed out on this device, and it will show a pairing code.</li>
              <li>On another phone or computer, an admin or coordinator opens Menu → Kiosk tablets and types that code.</li>
              <li>Staff then tap their name on this screen and enter their kiosk code.</li>
            </ol>
          }
          confirmText="Continue"
          cancelText="Cancel"
          variant="primary"
          icon="shield"
        />,
        document.body
      )}
    </header>
  );
};


