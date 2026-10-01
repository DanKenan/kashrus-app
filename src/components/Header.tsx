import React, { useState, useRef, useEffect } from 'react';
import { 
  CheckCircle2, 
  Wifi, 
  WifiOff, 
  Users, 
  Plus, 
  RotateCcw, 
  History, 
  Database, 
  Sun, 
  Moon, 
  LogOut, 
  ShieldCheck, 
  UserCheck, 
  CalendarDays,
  Menu,
  X,
  KeyRound,
  LogIn,
  User as UserIcon,
  Building2,
  ChevronDown,
  Store,
  Calendar,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Factory
} from 'lucide-react';
import { User, Venue } from '../types';
import { KeepingKosherLogo } from './KeepingKosherLogo';
import { PWAInstallButton } from './PWAInstallButton';
import { getRoleLabel, canUserAssignTasks } from '../lib/permissions';

interface HeaderProps {
  currentUser: User | null;
  currentVenue: Venue | null;
  allVenues: Venue[];
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
  onOpenSupabaseModal: () => void;
  onOpenTeamModal: () => void;
  onResetDailyBoard: () => void;
  isRealtimeConnected: boolean;
  activeWorkersCount: number;
  totalWorkersCount: number;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  completionRate: number;
  isDemoCleared?: boolean;
  onCleanSlate?: () => void;
  onRestoreDemo?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentUser,
  currentVenue,
  allVenues,
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
  onOpenSupabaseModal,
  onOpenTeamModal,
  onResetDailyBoard,
  isRealtimeConnected,
  activeWorkersCount,
  totalWorkersCount,
  darkMode,
  onToggleDarkMode,
  completionRate,
  isDemoCleared = false,
  onCleanSlate,
  onRestoreDemo,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const openVenuesModal = onOpenVenuesHub || onOpenVenuesDirectory || (() => {});
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-stone-200/90 dark:border-stone-800 shadow-2xs transition-colors">
      {/* Click-outside transparent overlay for open dropdowns */}
      {(toolsMenuOpen || userMenuOpen) && (
        <div 
          className="fixed inset-0 z-40 bg-transparent" 
          onClick={() => { setToolsMenuOpen(false); setUserMenuOpen(false); }} 
        />
      )}

      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between min-h-[56px] sm:min-h-[64px] py-1 sm:py-0 gap-3">
          
          {/* Brand, Venue Switcher & Status */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <KeepingKosherLogo 
              size="sm" 
              showSubtitle={false}
              agencyName={currentUser?.agencyName}
              agencyShortCode={currentUser?.agencyShortCode}
            />

            {/* Active Venue Selector Button */}
            {currentUser?.role === 'admin' ? (
              <button
                id="admin-venue-switcher-btn"
                onClick={openVenuesModal}
                className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-stone-100 hover:bg-stone-200/80 dark:bg-slate-800 dark:hover:bg-slate-700/80 border border-stone-200/90 dark:border-stone-700 transition cursor-pointer shadow-2xs shrink-0"
                title="Switch to another kosher venue"
              >
                <Building2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-xs font-bold text-stone-800 dark:text-stone-100 truncate max-w-[130px] sm:max-w-[170px]">
                  {currentVenue?.name || 'Select Venue'}
                </span>
                <ChevronDown className="w-3 h-3 text-stone-400 group-hover:text-stone-600 dark:group-hover:text-stone-300 transition" />
              </button>
            ) : currentVenue ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/40 text-emerald-900 dark:text-emerald-200 shadow-2xs shrink-0">
                <Building2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className="text-xs font-bold truncate max-w-[130px] sm:max-w-[170px]">
                  {currentVenue.name}
                </span>
              </div>
            ) : null}

            {/* Compact Live indicator */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400 pl-1">
              <span className="relative flex h-2 w-2">
                {isRealtimeConnected && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-emerald-400" />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isRealtimeConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-indigo-900 dark:text-indigo-200 bg-indigo-50/90 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 border border-indigo-200/90 dark:border-indigo-800/60 transition cursor-pointer shadow-2xs shrink-0"
                title="Factory Floor & Airtable Ingredients Audit"
              >
                <Factory className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>Factory Ingredients Audit</span>
              </button>
            )}

            {/* Events Badge Shortcut (if events active) */}
            {eventsCount > 0 && (
              <button
                id="header-events-btn"
                onClick={onOpenEventsModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-amber-900 dark:text-amber-200 bg-amber-50/90 dark:bg-amber-950/50 hover:bg-amber-100 dark:hover:bg-amber-900/50 border border-amber-200/90 dark:border-amber-800/60 transition cursor-pointer shadow-2xs shrink-0"
                title="Kosher Events & Banquets Hub"
              >
                <Calendar className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                <span>Events ({eventsCount})</span>
              </button>
            )}

            {/* Consolidated Agency Operations Dropdown */}
            <div className="relative">
              <button
                id="header-operations-menu-btn"
                onClick={() => { setToolsMenuOpen(!toolsMenuOpen); setUserMenuOpen(false); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-stone-700 dark:text-stone-200 bg-stone-100 hover:bg-stone-200/80 dark:bg-slate-800 dark:hover:bg-slate-700 border border-stone-200/90 dark:border-stone-700 transition cursor-pointer shadow-2xs shrink-0"
                title="Access Agency Operations, Rosters, and Audits"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-stone-500 dark:text-stone-400" />
                <span>Operations</span>
                <ChevronDown className={`w-3 h-3 text-stone-400 transition-transform ${toolsMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {toolsMenuOpen && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white dark:bg-slate-900 border border-stone-200 dark:border-stone-800 shadow-xl py-2 z-50 text-stone-800 dark:text-stone-200">
                  <div className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-stone-400 dark:text-stone-500 border-b border-stone-100 dark:border-stone-800/80">
                    Kashrus Operations Hub
                  </div>

                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); openVenuesModal(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Store className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                        <span>Venues Directory</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-slate-800 text-stone-500 font-bold">
                        {allVenues.length}
                      </span>
                    </button>
                  )}

                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenCreateVenue(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                    >
                      <Plus className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      <span>Establish New Venue</span>
                    </button>
                  )}

                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenTeamModal(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-indigo-500" />
                        <span>Mashgichim & Team</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-slate-800 text-stone-500 font-bold">
                        {totalWorkersCount}
                      </span>
                    </button>
                  )}

                  {onOpenFactoryAudit && (
                    <button
                      onClick={() => { setToolsMenuOpen(false); onOpenFactoryAudit(); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Factory className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        <span>Factory Ingredients Audit</span>
                      </span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-bold uppercase">
                        Airtable
                      </span>
                    </button>
                  )}

                  <button
                    onClick={() => { setToolsMenuOpen(false); onOpenEventsModal(); }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      <span>Events & Banquets</span>
                    </span>
                    {eventsCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 font-black">
                        {eventsCount}
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => { setToolsMenuOpen(false); onOpenHistoryModal(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer"
                  >
                    <History className="w-4 h-4 text-blue-500" />
                    <span>Inspection Audit History</span>
                  </button>

                  {currentUser?.role === 'admin' && (
                    <div className="pt-1 mt-1 border-t border-stone-100 dark:border-stone-800/80">
                      <button
                        onClick={() => { setToolsMenuOpen(false); onOpenSupabaseModal(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-stone-50 dark:hover:bg-slate-800 transition text-left cursor-pointer text-stone-600 dark:text-stone-300"
                      >
                        <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        <span>Database & Security (RLS)</span>
                      </button>

                      <button
                        onClick={() => { setToolsMenuOpen(false); onResetDailyBoard(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-amber-50 dark:hover:bg-amber-950/40 text-amber-700 dark:text-amber-300 transition text-left cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                        <span>Reset Daily Venue Board</span>
                      </button>

                      {onCleanSlate && (
                        <button
                          onClick={() => { setToolsMenuOpen(false); onCleanSlate(); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-700 dark:text-rose-400 transition text-left cursor-pointer"
                          title="Wipe demo examples to start completely from scratch"
                        >
                          <Trash2 className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                          <span>Start From Scratch (Clear Demo Data)</span>
                        </button>
                      )}

                      {onRestoreDemo && isDemoCleared && (
                        <button
                          onClick={() => { setToolsMenuOpen(false); onRestoreDemo(); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 transition text-left cursor-pointer"
                          title="Restore sample facilities, mashgichim and tasks"
                        >
                          <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                          <span>Restore Demo Examples</span>
                        </button>
                      )}
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
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-black rounded-xl bg-gradient-to-r from-amber-600 via-amber-700 to-amber-800 hover:from-amber-700 hover:to-amber-900 active:scale-95 text-white shadow-sm shadow-amber-700/20 transition cursor-pointer shrink-0"
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
              <div className="relative pl-1 border-l border-stone-200 dark:border-stone-800">
                <button
                  id="header-user-menu-btn"
                  onClick={() => { setUserMenuOpen(!userMenuOpen); setToolsMenuOpen(false); }}
                  className="flex items-center gap-1.5 p-1 rounded-full hover:bg-stone-100 dark:hover:bg-slate-800 transition cursor-pointer"
                  title={`${currentUser.name} (${getRoleLabel(currentUser.role)})`}
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-black text-white shadow-2xs ring-2 ring-amber-500/30"
                    style={{ backgroundColor: currentUser.avatarColor || '#d97706' }}
                  >
                    {currentUser.name.charAt(0).toUpperCase()}
                  </div>
                  <ChevronDown className={`w-3 h-3 text-stone-400 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-64 rounded-2xl bg-white dark:bg-slate-900 border border-stone-200 dark:border-stone-800 shadow-xl p-3 z-50 text-stone-800 dark:text-stone-200">
                    <div className="pb-2.5 mb-2 border-b border-stone-100 dark:border-stone-800">
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-xs text-stone-900 dark:text-white truncate max-w-[150px]">
                          {currentUser.name}
                        </div>
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase ${
                          currentUser.role === 'admin'
                            ? 'bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300'
                            : currentUser.role === 'coordinator'
                            ? 'bg-sky-100 dark:bg-sky-950/80 text-sky-800 dark:text-sky-300'
                            : 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300'
                        }`}>
                          {getRoleLabel(currentUser.role)}
                        </span>
                      </div>
                      <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate mt-0.5">
                        {currentUser.email}
                      </div>
                      {currentUser.agencyName && (
                        <div className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold mt-1">
                          {currentUser.agencyName}
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      {/* Theme Toggle in Menu */}
                      <button
                        onClick={onToggleDarkMode}
                        className="w-full flex items-center justify-between px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-stone-50 dark:hover:bg-slate-800 transition cursor-pointer"
                      >
                        <span className="flex items-center gap-2 text-stone-700 dark:text-stone-300">
                          {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-stone-500" />}
                          <span>Appearance</span>
                        </span>
                        <span className="text-[11px] text-stone-400 font-normal">
                          {darkMode ? 'Dark' : 'Light'}
                        </span>
                      </button>

                      {/* Install PWA Option */}
                      <div className="px-1 py-1">
                        <PWAInstallButton variant="banner" />
                      </div>

                      {/* Change Password */}
                      {onOpenChangePassword && (
                        <button
                          onClick={() => { setUserMenuOpen(false); onOpenChangePassword(); }}
                          className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-semibold rounded-xl hover:bg-stone-50 dark:hover:bg-slate-800 transition cursor-pointer text-stone-700 dark:text-stone-300"
                        >
                          <KeyRound className="w-4 h-4 text-stone-400" />
                          <span>Change Password</span>
                        </button>
                      )}

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
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-95 text-white text-xs font-bold shadow-xs transition cursor-pointer"
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
                className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 active:scale-95 text-white text-xs font-bold shadow-xs cursor-pointer shrink-0"
                title="Add New Assignment"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                <span className="text-xs font-bold">New</span>
              </button>
            )}

            <button
              id="mobile-header-menu-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-1.5 rounded-xl text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-slate-800 cursor-pointer shrink-0"
              aria-label="Toggle mobile menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu Dropdown */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-stone-200 dark:border-stone-800 bg-white dark:bg-slate-900 px-4 py-3 space-y-2 max-h-[85vh] overflow-y-auto">
          {/* Mobile Install App Banner */}
          <PWAInstallButton variant="banner" />

          {currentUser ? (
            <div className="py-2 border-b border-stone-100 dark:border-stone-800 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: currentUser.avatarColor || '#d97706' }}
                  >
                    {currentUser.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-stone-900 dark:text-white">{currentUser.name}</p>
                    <p className="text-[11px] text-stone-500 dark:text-stone-400">{currentUser.email}</p>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  currentUser.role === 'admin'
                    ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                    : 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                }`}>
                  {getRoleLabel(currentUser.role)}
                </span>
              </div>
              {currentUser.agencyName && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 pt-0.5 font-medium">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Agency: <strong>{currentUser.agencyName}</strong></span>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenAuth?.(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-lg text-white bg-amber-600 hover:bg-amber-700 shadow-xs cursor-pointer"
            >
              <UserIcon className="w-4 h-4" />
              <span>Sign In to Your Account</span>
            </button>
          )}

          {/* Mobile Admin Venue Switcher */}
          {currentUser?.role === 'admin' && (
            <div className="p-2.5 rounded-2xl bg-stone-50 dark:bg-slate-800/60 border border-stone-200 dark:border-stone-700 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-stone-700 dark:text-stone-300 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-amber-600" />
                  Active Venue:
                </span>
                <span className="font-bold text-amber-700 dark:text-amber-400">
                  {currentVenue?.name}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setMobileMenuOpen(false); openVenuesModal(); }}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border border-amber-200/80 dark:border-amber-800/60 text-center cursor-pointer"
                >
                  Venues Hub ({allVenues.length})
                </button>
                <button
                  onClick={() => { setMobileMenuOpen(false); onOpenCreateVenue(); }}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-xl bg-amber-600 text-white text-center cursor-pointer flex items-center justify-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>New Venue</span>
                </button>
              </div>
            </div>
          )}

          {canUserAssignTasks(currentUser) && (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenTaskModal(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-xl text-white bg-gradient-to-r from-amber-600 to-amber-700 shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4 stroke-[2.5]" />
              <span>Create New Assignment</span>
            </button>
          )}

          {/* Factory Ingredients Audit on Mobile */}
          {onOpenFactoryAudit && (
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenFactoryAudit(); }}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold rounded-xl text-indigo-900 dark:text-indigo-200 bg-indigo-50/90 dark:bg-indigo-950/50 border border-indigo-200/90 dark:border-indigo-800/60 cursor-pointer shadow-2xs"
            >
              <span className="flex items-center gap-2">
                <Factory className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Factory Ingredients Audit (Airtable)</span>
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-indigo-600 text-white">
                Live
              </span>
            </button>
          )}

          {/* Events Hub on Mobile */}
          <button
            onClick={() => { setMobileMenuOpen(false); onOpenEventsModal(); }}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold rounded-xl text-amber-900 dark:text-amber-200 bg-amber-50/90 dark:bg-amber-950/50 border border-amber-200/90 dark:border-amber-800/60 cursor-pointer shadow-2xs"
          >
            <span className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <span>Kosher Events & Banquets</span>
            </span>
            {eventsCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-600 text-white">
                {eventsCount} active
              </span>
            )}
          </button>

          <div className="grid grid-cols-2 gap-2 pt-1">
            {currentUser?.role === 'admin' && (
              <button
                onClick={() => { setMobileMenuOpen(false); onOpenTeamModal(); }}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-stone-700 dark:text-stone-200 bg-stone-100 dark:bg-slate-800 cursor-pointer"
              >
                <Users className="w-4 h-4 text-indigo-500" />
                <span>Mashgichim ({totalWorkersCount})</span>
              </button>
            )}
            <button
              onClick={() => { setMobileMenuOpen(false); onOpenHistoryModal(); }}
              className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-stone-700 dark:text-stone-200 bg-stone-100 dark:bg-slate-800 cursor-pointer ${
                currentUser?.role === 'admin' ? '' : 'col-span-2'
              }`}
            >
              <History className="w-4 h-4 text-blue-500" />
              <span>History Log</span>
            </button>
            {currentUser?.role === 'admin' && (
              <button
                onClick={() => { setMobileMenuOpen(false); onOpenSupabaseModal(); }}
                className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-stone-700 dark:text-stone-200 bg-stone-100 dark:bg-slate-800 col-span-2 cursor-pointer"
              >
                <Database className="w-4 h-4 text-emerald-500" />
                <span>Supabase / RLS</span>
              </button>
            )}
          </div>

          {currentUser?.role === 'admin' && (
            <div className="space-y-1.5">
              <button
                onClick={() => { setMobileMenuOpen(false); onResetDailyBoard(); }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Reset Daily Board Now</span>
              </button>

              {onCleanSlate && (
                <button
                  onClick={() => { setMobileMenuOpen(false); onCleanSlate(); }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Start From Scratch (Clear Demo Data)</span>
                </button>
              )}

              {onRestoreDemo && isDemoCleared && (
                <button
                  onClick={() => { setMobileMenuOpen(false); onRestoreDemo(); }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-xl text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Restore Demo Examples</span>
                </button>
              )}
            </div>
          )}

          {/* Theme Switcher on Mobile */}
          <button
            onClick={onToggleDarkMode}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold rounded-xl bg-stone-100 dark:bg-slate-800 text-stone-700 dark:text-stone-200 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-stone-500" />}
              <span>Toggle Appearance</span>
            </span>
            <span className="text-xs text-stone-400">{darkMode ? 'Dark' : 'Light'}</span>
          </button>

          <div className="pt-2 border-t border-stone-100 dark:border-stone-800 flex justify-between items-center">
            {currentUser ? (
              <>
                {onOpenChangePassword && (
                  <button
                    onClick={() => { setMobileMenuOpen(false); onOpenChangePassword(); }}
                    className="text-xs font-semibold text-stone-700 dark:text-stone-200 flex items-center gap-1 cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-stone-500" />
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
                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" /> Sign In to Account
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
};


