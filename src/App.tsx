import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { StatsProgressBar } from './components/StatsProgressBar';
import { OwnerAuditBanner } from './components/OwnerAuditBanner';
import { TaskFilterBar } from './components/TaskFilterBar';
import { TaskTableView } from './components/TaskTableView';
import { TaskCardView } from './components/TaskCardView';
import { TaskModal } from './components/TaskModal';
import { HistoryLogModal } from './components/HistoryLogModal';
import { LoginPage } from './components/LoginPage';
import { KioskLogin } from './components/KioskLogin';
import { KioskTaskPanel } from './components/KioskTaskPanel';
import { UpdatesBell } from './components/UpdatesBell';
import { UpdatesSheet, announcementCanDelete } from './components/UpdatesSheet';
import { UrgentBanner } from './components/UrgentBanner';
import { Announcements } from './components/Announcements';
import { HandoffNotes } from './components/HandoffNotes';
import { useUpdatesCenter } from './components/UpdatesCenter';
import { AlertsTab } from './components/AlertsTab';
import { ReadersPanel } from './components/Receipts';
import type { UpdatesContext } from './lib/updates';
import { KioskPairing } from './components/KioskPairing';
import { KioskDevicesModal } from './components/KioskDevicesModal';
import { LandingPage } from './components/LandingPage';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { TeamModal } from './components/TeamModal';
import { CreateVenueModal } from './components/CreateVenueModal';
import { VenuesDirectoryModal } from './components/VenuesDirectoryModal';
import { EventsModal } from './components/EventsModal';
import { CreateEventModal } from './components/CreateEventModal';
import { ConfirmModal } from './components/ConfirmModal';
import { taskCategories, sortTasksForBoard, boardTier } from './lib/utils';
import { FactoryAuditHubModal } from './components/FactoryAuditHubModal';
import { Task, TaskStatus, User, UserRole, DailySnapshot, ServerBroadcastMessage, Venue, KosherEvent } from './types';
import { realtimeSocket } from './lib/socketClient';
import { testFirestoreConnection } from './lib/firebaseClient';
import { Building2, MapPin, ShieldCheck, Plus, ExternalLink, Calendar, Sparkles, Factory } from 'lucide-react';
import { canUserFillTasks, canUserAssignTasks, canSeeTask, getRoleLabel } from './lib/permissions';
import { refreshCustomCategories } from './lib/categoryStyle';
import { apiFetch, apiWrite, clearSession, getSessionToken, observeVersion, loadStaleDrafts, discardStaleDraft, StaleDraft, getKioskDevice, clearKioskDevice } from './lib/api';

const DEFAULT_USERS: User[] = [
  { id: 'usr_admin', agencyId: 'agency-hkc', agencyName: 'Hartford Kashrut Commission (HKC)', agencyShortCode: 'HKC', agencySeal: 'Glatt Kosher & Mehadrin Kashrut', email: 'kenan@hartfordkashrut.org', name: 'Kenan (Admin)', role: 'admin', avatarColor: '#3b82f6', permissions: { canFillTasks: true, canAssignTasks: true } },
];

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme_mode');
      if (saved) return saved === 'dark';
      return false; // default to the day theme (Don, Oct 20 2026)
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme_mode', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme_mode', 'light');
    }
  }, [darkMode]);

  // Current User state (supports sign out to null). The app always opens on
  // the public landing page first — a saved session is offered as
  // Session: restore the logged-in user on refresh so the dashboard opens
  // directly instead of dropping back to the landing page.
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('current_user');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {}
      }
    }
    return null;
  });

  // Saved session from a previous visit (offered on the landing page).
  const [savedSession, setSavedSession] = useState<User | null>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('current_user');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {}
      }
    }
    return null;
  });

  // Which public screen is showing: the landing home page or the auth form.
  const [authView, setAuthView] = useState<'landing' | 'auth'>('landing');

  // ---- Kiosk mode: shared wall tablet ----
  // Activated via ?kiosk=1 (persisted in localStorage so it survives reloads).
  // A tablet is paired to ONE venue: with no stored device credential it
  // shows the pairing screen; once paired it shows that venue's PIN screen.
  // There is no venue picker and no ?venue= parameter any more.
  const [kioskMode, setKioskMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('kiosk') === '0') {
        // Best-effort self-unpair BEFORE the stored credential is cleared.
        if (getKioskDevice()) {
          void apiFetch('/api/kiosk/device/unpair', { method: 'POST' }).catch(() => {});
        }
        localStorage.removeItem('kiosk_mode');
        localStorage.removeItem('kiosk_venue_id');
        clearKioskDevice();
        return false;
      }
      if (params.get('kiosk') === '1') {
        localStorage.setItem('kiosk_mode', '1');
        localStorage.removeItem('kiosk_venue_id');
        // Kiosk is a clean slate — clear any existing user session so the
        // tablet doesn't leak the previous user's agency context.
        try {
          localStorage.removeItem('shutfey_session_token');
          localStorage.removeItem('shutfey_user');
        } catch {}
        return true;
      }
      localStorage.removeItem('kiosk_venue_id');
      return localStorage.getItem('kiosk_mode') === '1';
    } catch {
      return false;
    }
  });
  const [kioskDevice, setKioskDeviceState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('kiosk') === '0') return null;
      return getKioskDevice();
    } catch {
      return null;
    }
  });
  const isKiosk = kioskMode;

  // If the server ever answers KIOSK_UNPAIRED, api.ts clears the stored
  // device and dispatches this event — drop back to the pairing screen.
  useEffect(() => {
    const onUnpaired = () => setKioskDeviceState(null);
    window.addEventListener('shutfey:kiosk-unpaired', onUnpaired);
    return () => window.removeEventListener('shutfey:kiosk-unpaired', onUnpaired);
  }, []);

  const exitKioskMode = async () => {
    // Best-effort self-unpair while the device credential is still stored
    // (apiFetch attaches it as the X-Kiosk-Device header).
    if (getKioskDevice()) {
      try {
        await apiFetch('/api/kiosk/device/unpair', { method: 'POST' });
      } catch {
        // ignore — leaving kiosk mode must not be blocked by the network
      }
    }
    clearKioskDevice();
    setKioskDeviceState(null);
    setKioskMode(false);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('kiosk_mode');
      localStorage.removeItem('kiosk_venue_id');
    }
    setAuthView('landing');
  };
  const [authInitialMode, setAuthInitialMode] = useState<'login' | 'signup'>('login');

  // Keep the render-path category colors in sync with this user's saved
  // custom categories ("Other" entries) — on login, logout, and switch.
  useEffect(() => {
    refreshCustomCategories(currentUser?.email);
  }, [currentUser?.email]);

  // Persist the session only while authenticated. The public landing page
  // intentionally starts with currentUser === null, so this must NOT clear
  // the saved session — logout and "Use a different account" remove it
  // explicitly in their own handlers.

  // Expired/revoked token: any API 401 drops back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => {
      if (currentUser) {
        handleLogout();
        showToast('Your session expired. Please sign in again.');
      }
    };
    window.addEventListener('shutfey:unauthorized', onUnauthorized);
    return () => window.removeEventListener('shutfey:unauthorized', onUnauthorized);
  }, [currentUser]);

  // Kiosk auto-logout: 5 minutes of no touches returns the tablet to the PIN screen.
  useEffect(() => {
    if (!isKiosk || !currentUser) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        handleLogout();
        showToast('Signed out for inactivity.');
      }, 5 * 60 * 1000);
    };
    arm();
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, arm));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKiosk, currentUser?.id]);

  useEffect(() => {
    if (typeof window !== 'undefined' && currentUser) {
      localStorage.setItem('current_user', JSON.stringify(currentUser));
      realtimeSocket.sendPresence(currentUser.email, currentUser.name);
    }
  }, [currentUser]);

  // Main tasks & history states
  const [tasks, setTasks] = useState<Task[]>([]);
  const [historyLogs, setHistoryLogs] = useState<DailySnapshot[]>([]);
  const [knownUsers, setKnownUsers] = useState<User[]>(DEFAULT_USERS);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [activeWorkersCount, setActiveWorkersCount] = useState<number>(1);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Stale-client drafts: writes rejected with 428 STALE_CLIENT are preserved
  // here (see src/lib/api.ts). After the required refresh, the banner below
  // offers to re-apply each draft with a fresh version — never silently lost.
  const [staleDrafts, setStaleDrafts] = useState<StaleDraft[]>(() => loadStaleDrafts());
  useEffect(() => {
    const refresh = () => setStaleDrafts(loadStaleDrafts());
    window.addEventListener('shutfey:stale-draft', refresh);
    return () => window.removeEventListener('shutfey:stale-draft', refresh);
  }, []);

  const handleReapplyDraft = async (draft: StaleDraft) => {
    const result = await apiWrite(draft.endpoint, {
      method: draft.method as any,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft.body),
    });
    if (result.ok) {
      discardStaleDraft(draft.key);
      setStaleDrafts(loadStaleDrafts());
      showToast('Change re-applied successfully.');
      // Reload so the freshly saved change renders from server state.
      window.location.reload();
    } else {
      showToast(result.error || 'Could not re-apply the change.');
    }
  };

  const handleDiscardDraft = (draft: StaleDraft) => {
    discardStaleDraft(draft.key);
    setStaleDrafts(loadStaleDrafts());
  };

  // Venues state
  const [venues, setVenues] = useState<Venue[]>([]);
  const [currentVenueId, setCurrentVenueId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('selected_venue_id');
    }
    return null;
  });
  const [isVenuesDirectoryOpen, setIsVenuesDirectoryOpen] = useState(false);
  const [isCreateVenueOpen, setIsCreateVenueOpen] = useState(false);
  const [isDemoCleared, setIsDemoCleared] = useState(false);

  // Filters & View modes
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [activeTabFilter, setActiveTabFilter] = useState<'all' | 'mine' | 'pending' | 'completed'>(() => {
    // Mashgichim open straight onto the tasks designated for them
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('current_user') : null;
      if (saved) {
        const u = JSON.parse(saved);
        if (u && (u.role === 'mashgiach' || u.role === 'worker')) return 'mine';
      }
    } catch {}
    return 'all';
  });
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  // Kiosk only (D3a): the kiosk list is the default; table and cards stay one tap away.
  const [kioskView, setKioskView] = useState<'list' | 'table' | 'cards'>('list');
  const [showOnlyTodaySchedule, setShowOnlyTodaySchedule] = useState(false);

  // Modals
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [isTeamModalOpen, setIsTeamModalOpen] = useState(false);
  const [isKioskDevicesOpen, setIsKioskDevicesOpen] = useState(false);
  const [isEventsModalOpen, setIsEventsModalOpen] = useState(false);
  const [isCreateEventModalOpen, setIsCreateEventModalOpen] = useState(false);
  const [events, setEvents] = useState<KosherEvent[]>([]);
  const [isFactoryAuditOpen, setIsFactoryAuditOpen] = useState(false);

  // In-App Confirm Dialog State (replaces window.confirm)
  const [confirmModalConfig, setConfirmModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string | React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'primary';
    icon?: 'trash' | 'alert' | 'rotate' | 'shield';
    isLoading?: boolean;
    onConfirm: () => void | Promise<void>;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  // Compute active venue
  const currentVenue = useMemo<Venue | null>(() => {
    if (venues.length === 0) return null;
    if (currentUser?.role !== 'admin' && currentUser?.venueId) {
      return venues.find((v) => v.id === currentUser.venueId) || venues[0] || null;
    }
    if (currentVenueId) {
      const match = venues.find((v) => v.id === currentVenueId);
      if (match) return match;
    }
    return venues[0] || null;
  }, [venues, currentVenueId, currentUser]);

  // 5a — Updates panel context. The generation bumps whenever the signed-in
  // context changes (user, agency, venue, kiosk session): the Updates center
  // then drops everything from the old context — lists, counts, banner,
  // drafts, recordings (plan C5). The kiosk idle sign-out reaches here as a
  // logout, so its sheet and state clear the same way (plan C4).
  const updatesCtxKey = currentUser
    ? `${currentUser.id}|${currentUser.agencyId || 'agency-hkc'}|${currentVenue?.id || ''}|${isKiosk ? 'kiosk' : 'app'}`
    : '';
  // The generation is derived synchronously during render (React's
  // adjust-state-during-render pattern): the context object below is never
  // observed with a new venue and a stale generation, not even for one frame.
  const [updatesGenState, setUpdatesGenState] = useState({ key: '', gen: 0 });
  if (updatesGenState.key !== updatesCtxKey) {
    setUpdatesGenState({ key: updatesCtxKey, gen: updatesGenState.gen + 1 });
  }
  const updatesGen = updatesGenState.gen;
  const updatesCtx: UpdatesContext | null = useMemo(
    () =>
      currentUser && currentVenue
        ? {
            userId: currentUser.id,
            email: currentUser.email,
            name: currentUser.name,
            role: currentUser.role,
            agencyId: currentUser.agencyId || 'agency-hkc',
            venueId: currentVenue.id,
            kiosk: isKiosk,
            gen: updatesGen,
          }
        : null,
    [currentUser, currentVenue, isKiosk, updatesGen],
  );
  const updates = useUpdatesCenter(updatesCtx);

  // 5b: the ✓✓ reader list opens over the sheet's body (admin/coordinator
  // only — the server refuses anyone else).
  const [readersFor, setReadersFor] = useState<{ kind: 'announcement' | 'alert'; id: string; title: string } | null>(null);
  useEffect(() => { if (!updates.sheetOpen) setReadersFor(null); }, [updates.sheetOpen]);

  // 5b: a tapped alert notification opens the Alerts tab on that alert —
  // from a cold start (?updates=alerts&alert=<id>) or, with the app already
  // open, from the service worker's OPEN_URL message (A5/A10: only the two
  // params are read, from a same-origin URL; nothing navigates or reloads,
  // and an unsent draft is never cleared by it). Never on the kiosk.
  const [pendingAlertLink, setPendingAlertLink] = useState<string | null>(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return q.get('updates') === 'alerts' ? q.get('alert') || '' : null;
    } catch { return null; }
  });
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | undefined;
      if (d?.type !== 'OPEN_URL' || typeof d.url !== 'string') return;
      try {
        const u = new URL(d.url, window.location.origin);
        if (u.origin !== window.location.origin) return;
        if (u.searchParams.get('updates') === 'alerts') setPendingAlertLink(u.searchParams.get('alert') || '');
      } catch { /* ignore */ }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => {
    if (pendingAlertLink === null || !updatesCtx) return;
    if (!isKiosk) updates.setSheetOpen(true, 'alerts', pendingAlertLink || null);
    setPendingAlertLink(null);
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('updates');
      u.searchParams.delete('alert');
      window.history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAlertLink, updatesCtx]);

  // If user signs in with a non-admin role, lock active venue to their assigned venueId
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin' && currentUser.venueId) {
      setCurrentVenueId(currentUser.venueId);
      if (typeof window !== 'undefined') {
        localStorage.setItem('selected_venue_id', currentUser.venueId);
      }
    }
  }, [currentUser]);

  // Auto detect mobile view
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setViewMode('cards');
    }
  }, []);

  // Show temporary toast notification
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // 1. Fetch Venues whenever user changes
  useEffect(() => {
    if (!currentUser) return;
    const url = `/api/venues?userEmail=${encodeURIComponent(currentUser.email)}`;
    apiFetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data.isDemoCleared !== undefined) {
          setIsDemoCleared(Boolean(data.isDemoCleared));
        }
        if (Array.isArray(data.venues)) {
          setVenues(data.venues);
          if (currentUser.role !== 'admin' && currentUser.venueId) {
            setCurrentVenueId(currentUser.venueId);
          } else if (!currentVenueId && data.venues.length > 0) {
            setCurrentVenueId(data.venues[0].id);
          } else if (data.venues.length === 0) {
            setCurrentVenueId(null);
          }
        }
      })
      .catch((err) => console.warn('Could not fetch /api/venues:', err));
  }, [currentUser?.email, currentUser?.role]);

  // 2. Fetch Tasks, History, and Users scoped to the active venue
  useEffect(() => {
    if (!currentUser) return;
    const activeVenueId = currentVenue?.id || (currentUser.role !== 'admin' ? currentUser.venueId : currentVenueId);
    const qs = activeVenueId
      ? `?venueId=${encodeURIComponent(activeVenueId)}&userEmail=${encodeURIComponent(currentUser.email)}`
      : `?userEmail=${encodeURIComponent(currentUser.email)}`;

    apiFetch(`/api/tasks${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.tasks)) {
          setTasks(data.tasks.filter((t: Task) => canSeeTask(t, currentUser)));
        }
      })
      .catch((err) => console.warn('Could not fetch /api/tasks:', err));

    apiFetch(`/api/history${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.historyLogs)) {
          setHistoryLogs(data.historyLogs);
        }
      })
      .catch((err) => console.warn('Could not fetch /api/history:', err));

    apiFetch(`/api/users${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.users)) {
          setKnownUsers(data.users);
        }
      })
      .catch(() => {});

    apiFetch(`/api/events${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.events)) {
          setEvents(data.events);
        }
      })
      .catch((err) => console.warn('Could not fetch /api/events:', err));
  }, [currentVenue?.id, currentUser?.email, currentUser?.role]);

  // 3. Connect Real-time WebSocket with venue filtering
  useEffect(() => {
    realtimeSocket.connect(currentUser?.email, currentUser?.name);

    const unsubStatus = realtimeSocket.onStatusChange((status) => {
      setIsRealtimeConnected(status);
    });

    const unsubMsg = realtimeSocket.onMessage((msg: ServerBroadcastMessage) => {
      // Stage 2 version contract: every broadcast carries the document
      // version that produced it — keep the client's last-known version fresh
      // so the next update sends a current expectedVersion.
      if (msg.version !== undefined) observeVersion(msg.version);
      // Filter out messages for other venues if venueId is present
      const msgVenueId = (msg.payload as any)?.venueId;
      if (msgVenueId && currentVenue?.id && msgVenueId !== currentVenue.id) {
        return;
      }

      if (msg.type === 'INITIAL_STATE' && msg.payload) {
        if (Array.isArray(msg.payload.tasks))
          setTasks(msg.payload.tasks.filter((t: Task) => canSeeTask(t, currentUser)));
        if (Array.isArray(msg.payload.historyLogs)) setHistoryLogs(msg.payload.historyLogs);
        if (Array.isArray(msg.payload.events)) setEvents(msg.payload.events);
        if (Array.isArray(msg.payload.users)) setKnownUsers(msg.payload.users);
        if (msg.payload.activeWorkersCount !== undefined) {
          setActiveWorkersCount(msg.payload.activeWorkersCount);
        }
      } else if (msg.type === 'TASK_UPDATED' && msg.payload) {
        const updated = msg.payload as Task;
        setTasks((prev) =>
          canSeeTask(updated, currentUser)
            ? prev.map((t) => (t.id === updated.id ? updated : t))
            : prev.filter((t) => t.id !== updated.id)
        );
        if (msg.senderEmail && currentUser && msg.senderEmail !== currentUser.email) {
          showToast(`${updated.updatedByName || msg.senderEmail} updated "${updated.title}"`);
        }
      } else if (msg.type === 'TASK_CREATED' && msg.payload) {
        const created = msg.payload as Task;
        if (!canSeeTask(created, currentUser)) return;
        setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [...prev, created]));
        if (msg.senderEmail && currentUser && msg.senderEmail !== currentUser.email) {
          showToast(`New assignment added: "${created.title}"`);
        }
      } else if (msg.type === 'TASK_DELETED' && msg.payload) {
        setTasks((prev) => prev.filter((t) => t.id !== msg.payload.id));
      } else if (msg.type === 'DAILY_RESET' && msg.payload) {
        if (Array.isArray(msg.payload.tasks))
          setTasks(msg.payload.tasks.filter((t: Task) => canSeeTask(t, currentUser)));
        if (Array.isArray(msg.payload.historyLogs)) setHistoryLogs(msg.payload.historyLogs);
        showToast('Daily board has refreshed for the day! Previous records archived.');
      } else if (msg.type === 'USER_PRESENCE' && msg.payload) {
        if (msg.payload.activeWorkersCount !== undefined) {
          setActiveWorkersCount(msg.payload.activeWorkersCount);
        }
      } else if (msg.type === 'USERS_UPDATED' && msg.payload) {
        if (Array.isArray(msg.payload.users)) {
          setKnownUsers(msg.payload.users);
        }
      } else if (msg.type === 'EVENT_CREATED' && msg.payload?.event) {
        const newEvt = msg.payload.event as KosherEvent;
        setEvents((prev) => {
          if (prev.some((e) => e.id === newEvt.id)) return prev;
          return [...prev, newEvt];
        });
        if (msg.senderEmail && currentUser && msg.senderEmail !== currentUser.email) {
          const isAssignedToMe =
            newEvt.assignedMashgiachEmail &&
            newEvt.assignedMashgiachEmail.toLowerCase() === currentUser.email.toLowerCase();
          if (isAssignedToMe) {
            showToast(`⭐ You have been assigned as Mashgiach for: "${newEvt.title}"!`);
          } else {
            showToast(`New Kosher Event registered: "${newEvt.title}"`);
          }
        }
      } else if (msg.type === 'EVENT_UPDATED' && msg.payload?.event) {
        const updatedEvt = msg.payload.event as KosherEvent;
        setEvents((prev) => prev.map((e) => (e.id === updatedEvt.id ? updatedEvt : e)));
      } else if (msg.type === 'EVENT_DELETED' && msg.payload?.id) {
        setEvents((prev) => prev.filter((e) => e.id !== msg.payload.id));
      } else if (msg.type === 'CLEAN_SLATE_RESET') {
        setVenues([]);
        setCurrentVenueId(null);
        setTasks([]);
        setEvents([]);
        setHistoryLogs([]);
        setIsDemoCleared(true);
        if (Array.isArray(msg.payload?.users)) {
          setKnownUsers(msg.payload.users);
        }
        showToast('All demo examples have been cleared. Platform is ready to start from scratch!');
      } else if (msg.type === 'DEMO_RESTORED') {
        if (Array.isArray(msg.payload?.venues)) {
          setVenues(msg.payload.venues);
          if (msg.payload.venues.length > 0) {
            setCurrentVenueId(msg.payload.venues[0].id);
          }
        }
        if (Array.isArray(msg.payload?.tasks)) setTasks(msg.payload.tasks);
        if (Array.isArray(msg.payload?.events)) setEvents(msg.payload.events);
        if (Array.isArray(msg.payload?.users)) setKnownUsers(msg.payload.users);
        setIsDemoCleared(false);
        showToast('Demo facilities and checklists have been restored.');
      }
    });

    return () => {
      unsubStatus();
      unsubMsg();
    };
  }, [currentUser?.email, currentUser?.name, currentVenue?.id]);

  // Update Task Status (Optimistic + REST + WebSocket broadcast)
  const handleUpdateStatus = async (taskId: string, status: TaskStatus, isCompleted: boolean) => {
    if (!currentUser) {
      showToast('Please sign in to update task statuses.');
      return;
    }
    if (!canUserFillTasks(currentUser)) {
      showToast('You do not have permission to complete tasks.');
      return;
    }
    const now = new Date().toISOString();
    // Snapshot for rollback: if the write fails we restore this instead of
    // leaving the optimistic state (or, worse, replacing the task with an error body).
    const previousTask = tasks.find((t) => t.id === taskId);

    // Optimistic local update: if completed, log user attribution; if cancelled/incomplete, delete the log
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              currentStatus: status,
              isCompleted,
              updatedByEmail: isCompleted ? currentUser.email : null,
              updatedByName: isCompleted ? currentUser.name : null,
              updatedAt: isCompleted ? now : null,
            }
          : t
      )
    );

    const result = await apiWrite(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentStatus: status,
        isCompleted,
        userEmail: currentUser.email,
        userName: currentUser.name,
      }),
    });
    if (result.ok) {
      // Ensure sync
      setTasks((prev) => prev.map((t) => (t.id === taskId ? result.data : t)));
    } else {
      if (previousTask) {
        setTasks((prev) => prev.map((t) => (t.id === taskId ? previousTask : t)));
      }
      console.error('Failed to update task status:', result.error);
      showToast(result.error || 'Could not update the task status.');
    }
  };

  // Update Task Notes
  // ROUND 5: baselineVersion is the version the notes editor rendered from
  // (captured when the editor opened). It travels as expectedVersion — never
  // the latest version heard over WebSocket after the editor rendered.
  const handleUpdateNotes = async (taskId: string, notes: string, baselineVersion?: number) => {
    if (!currentUser) {
      showToast('Please sign in to update task notes.');
      return;
    }
    if (!canUserFillTasks(currentUser)) {
      showToast('You do not have permission to update task notes.');
      return;
    }
    const now = new Date().toISOString();
    // Snapshot for rollback if the write fails.
    const previousTask = tasks.find((t) => t.id === taskId);

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              notes,
              updatedByEmail: currentUser.email,
              updatedByName: currentUser.name,
              updatedAt: now,
            }
          : t
      )
    );

    const result = await apiWrite(`/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes,
        userEmail: currentUser.email,
        userName: currentUser.name,
      }),
      // Write baseline = what the notes editor showed, captured at open.
      ...(baselineVersion !== undefined ? { expectedVersion: baselineVersion } : {}),
      // Preserve the notes if the client is stale (428) — the required
      // refresh must not silently discard them.
      draft: {
        key: `task-notes:${taskId}`,
        label: `Task notes for "${previousTask?.title || taskId}"`,
        data: () => ({ notes, userEmail: currentUser.email, userName: currentUser.name }),
      },
    });
    if (!result.ok) {
      if (previousTask) {
        setTasks((prev) => prev.map((t) => (t.id === taskId ? previousTask : t)));
      }
      console.error('Failed to update notes:', result.error);
      showToast(result.error || 'Could not save the notes.');
    }
  };

  // Log one repeatable check-in on a task (inputType 'check_in')
  const handleCheckIn = async (taskId: string, photoData?: string, photoCaption?: string) => {
    if (!currentUser) {
      showToast('Please sign in to log checks.');
      return;
    }
    if (!canUserFillTasks(currentUser)) {
      showToast('You do not have permission to log checks.');
      return;
    }
    const now = new Date().toISOString();
    const optimistic = {
      id: `checkin-local-${Date.now()}`,
      byName: currentUser.name,
      byEmail: currentUser.email,
      at: now,
      photoData,
      photoCaption,
    };

    // Optimistic local update
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              checkIns: [...(t.checkIns || []), optimistic],
              updatedByEmail: currentUser.email,
              updatedByName: currentUser.name,
              updatedAt: now,
            }
          : t
      )
    );

    const result = await apiWrite(`/api/tasks/${taskId}/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userEmail: currentUser.email,
        userName: currentUser.name,
        photoData,
        photoCaption,
      }),
    });
    if (result.ok) {
      // Ensure sync (server is the source of truth for the check-in list)
      setTasks((prev) => prev.map((t) => (t.id === taskId ? result.data : t)));
    } else {
      // Roll back the optimistic check-in so it doesn't linger as if logged.
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, checkIns: (t.checkIns || []).filter((c) => c.id !== optimistic.id) }
            : t
        )
      );
      console.error('Failed to log check-in:', result.error);
      showToast(result.error || 'Could not log the check.');
    }
  };

  // Remove one check-in entry (tapped by mistake).
  const handleRemoveCheckIn = async (taskId: string, checkInId: string) => {
    if (!currentUser) return;
    // Snapshot the removed entry so we can restore it if the delete fails.
    const removedCheckIn = tasks
      .find((t) => t.id === taskId)
      ?.checkIns?.find((c) => c.id === checkInId);
    // Optimistic local update
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, checkIns: (t.checkIns || []).filter((c) => c.id !== checkInId) }
          : t
      )
    );
    const result = await apiWrite(`/api/tasks/${taskId}/check-in/${checkInId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail: currentUser.email }),
    });
    if (result.ok) {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? result.data : t)));
    } else {
      if (removedCheckIn) {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, checkIns: [...(t.checkIns || []), removedCheckIn] } : t
          )
        );
      }
      console.error('Failed to remove check-in:', result.error);
      showToast(result.error || 'Could not remove that check.');
    }
  };

  // Venue Management Handlers
  const handleSelectVenue = (venueId: string) => {
    const target = venues.find((v) => v.id === venueId);
    if (!target) return;
    setCurrentVenueId(venueId);
    if (typeof window !== 'undefined') {
      localStorage.setItem('selected_venue_id', venueId);
    }
    showToast(`Switched to platform: ${target.name}`);
  };

  const handleVenueCreated = (newVenue: Venue) => {
    // Dedupe by id: guards against a VENUE_CREATED broadcast (or double
    // submit) landing before/after this local append.
    setVenues((prev) => (prev.some((v) => v.id === newVenue.id) ? prev : [...prev, newVenue]));
    setCurrentVenueId(newVenue.id);
    if (typeof window !== 'undefined') {
      localStorage.setItem('selected_venue_id', newVenue.id);
    }
    showToast(`Platform for "${newVenue.name}" successfully provisioned!`);
  };

  const handleDeleteVenue = async (venueId: string) => {
    if (!currentUser || currentUser.role !== 'admin') {
      showToast('Only administrators can remove kosher venues.');
      return;
    }
    try {
      const result = await apiWrite(`/api/venues/${venueId}?userEmail=${encodeURIComponent(currentUser.email)}`, {
        method: 'DELETE',
      });
      if (!result.ok) throw new Error(result.error || 'Failed to delete venue platform');
      setVenues((prev) => prev.filter((v) => v.id !== venueId));
      if (currentVenueId === venueId) {
        const remaining = venues.filter((v) => v.id !== venueId);
        if (remaining.length > 0) {
          setCurrentVenueId(remaining[0].id);
          localStorage.setItem('selected_venue_id', remaining[0].id);
        }
      }
      showToast('Kosher venue platform removed.');
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete venue');
    }
  };

  // Save Task (Create or Edit). Returns true only when the server confirmed the
  // write — the TaskModal stays open on failure so the user's input is preserved.
  // ROUND 5: opts.baselineVersion is the version the edit form rendered from
  // (captured when the modal opened). It travels as expectedVersion — never
  // the latest version heard over WebSocket after the form rendered.
  const handleSaveTask = async (taskData: Partial<Task>, opts?: { baselineVersion?: number }): Promise<boolean> => {
    if (!currentUser || !canUserAssignTasks(currentUser)) {
      showToast('You do not have permission to create or edit assignments.');
      return false;
    }

    if (taskData.id) {
      // Edit
      const result = await apiWrite(`/api/tasks/${taskData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...taskData,
          venueId: currentVenue?.id,
          userEmail: currentUser.email,
        }),
        // Write baseline = what the form showed, captured at modal open.
        ...(opts?.baselineVersion !== undefined ? { expectedVersion: opts.baselineVersion } : {}),
        // Preserve the edit if the client is stale (428) — the modal stays
        // open on failure, and the draft survives the required refresh.
        draft: {
          key: `task-edit:${taskData.id}`,
          label: `Task edit for "${taskData.title || taskData.id}"`,
          data: () => ({ ...taskData, venueId: currentVenue?.id, userEmail: currentUser.email }),
        },
      });
      if (!result.ok) {
        console.error('Failed to edit task:', result.error);
        showToast(result.error || 'Could not update the assignment.');
        return false;
      }
      const updated = result.data;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      showToast(`Updated assignment: "${updated.title}"`);
      return true;
    }
    // Create
    const result = await apiWrite('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...taskData,
        venueId: currentVenue?.id,
        createdByEmail: currentUser.email,
        userEmail: currentUser.email,
      }),
    });
    if (!result.ok) {
      console.error('Failed to create task:', result.error);
      showToast(result.error || 'Could not create the assignment.');
      return false;
    }
    const created = result.data;
    // Dedupe by id: the TASK_CREATED broadcast can arrive before the
    // POST resolves, in which case the task is already in state.
    setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [...prev, created]));
    showToast(`Created assignment: "${created.title}"`);
    return true;
  };

  // Delete Task
  const handleDeleteTask = async (taskId: string) => {
    if (!currentUser || !canUserAssignTasks(currentUser)) {
      showToast('You do not have permission to delete assignments.');
      return;
    }
    setConfirmModalConfig({
      isOpen: true,
      title: 'Delete Assignment?',
      message: 'Are you sure you want to delete this daily inspection assignment? This action cannot be undone.',
      confirmText: 'Delete Assignment',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
      onConfirm: async () => {
        setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }));
        const result = await apiWrite(`/api/tasks/${taskId}?userEmail=${encodeURIComponent(currentUser.email)}`, { method: 'DELETE' });
        if (!result.ok) {
          console.error('Failed to delete task:', result.error);
          showToast(result.error || 'Could not delete the assignment.');
          return;
        }
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        showToast('Assignment removed');
      },
    });
  };

  // Manual Reset Daily Board (Admin Only)
  const handleResetDailyBoard = async () => {
    if (!currentUser || currentUser.role !== 'admin') {
      showToast('Only administrators can reset the daily board.');
      return;
    }
    const venueName = currentVenue ? currentVenue.name : 'Current Venue';
    setConfirmModalConfig({
      isOpen: true,
      title: `Reset Daily Board for "${venueName}"?`,
      message: `Current shift completion marks and inspection notes will be archived into the History Log and cleared for a fresh shift.`,
      confirmText: 'Reset Board Now',
      cancelText: 'Keep Current Shift',
      variant: 'warning',
      icon: 'rotate',
      onConfirm: async () => {
        setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }));
        const result = await apiWrite('/api/reset-daily', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            resetBy: currentUser.name,
            userEmail: currentUser.email,
            venueId: currentVenue?.id 
          }),
        });
        if (!result.ok) {
          console.error('Failed to reset daily board:', result.error);
          showToast(result.error || 'Could not reset the daily board.');
          return;
        }
        const data = result.data;
        if (data.tasks) setTasks(data.tasks);
        if (data.snapshot) setHistoryLogs((prev) => [data.snapshot, ...prev]);
        showToast(`Daily board for "${venueName}" has been reset and archived!`);
      },
    });
  };

  // Start From Scratch: Wipe all demo facilities and sample data (Admin Only)
  const handleCleanSlate = async () => {
    if (!currentUser || currentUser.role !== 'admin') {
      showToast('Only administrators can clear demo data.');
      return;
    }
    setConfirmModalConfig({
      isOpen: true,
      title: 'Start From Scratch (Clear Demo Data)?',
      message:
        'This will remove the demonstration facilities (Crown Market, Shalom Bakery, Simcha Caterers), example mashgichim, tasks, and shift logs.\n\n' +
        'Your administrator account (kenan@hartfordkashrut.org) will remain active, providing you with a fresh platform to configure your real Hartford Kashrut Commission certified venues and mashgichim.\n\n' +
        '(You can restore the demonstration templates at any time if needed.)',
      confirmText: 'Yes, Clear Demo Data',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
      onConfirm: async () => {
        setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }));
        const result = await apiWrite('/api/admin/clean-slate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userEmail: currentUser.email }),
        });
        if (!result.ok) {
          console.error('Failed to clean slate:', result.error);
          showToast(result.error || 'Failed to clear demo data.');
          return;
        }
        const data = result.data;
        if (data.success) {
          setVenues([]);
          setCurrentVenueId(null);
          setTasks([]);
          setEvents([]);
          setHistoryLogs([]);
          setIsDemoCleared(true);
          if (Array.isArray(data.users)) setKnownUsers(data.users);
          showToast('All demo examples cleared! Platform is ready to start from scratch.');
        } else {
          showToast(data.error || 'Failed to clear demo data.');
        }
      },
    });
  };

  // Restore Demonstration Facilities and Checklists (Admin Only)
  const handleRestoreDemo = async () => {
    if (!currentUser || currentUser.role !== 'admin') return;
    const result = await apiWrite('/api/admin/restore-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail: currentUser.email }),
    });
    if (!result.ok) {
      console.error('Failed to restore demo data:', result.error);
      showToast(result.error || 'Failed to restore demo data.');
      return;
    }
    const data = result.data;
    if (data.success) {
      if (Array.isArray(data.venues)) {
        setVenues(data.venues);
        if (data.venues.length > 0) setCurrentVenueId(data.venues[0].id);
      }
      if (Array.isArray(data.tasks)) setTasks(data.tasks);
      if (Array.isArray(data.events)) setEvents(data.events);
      if (Array.isArray(data.users)) setKnownUsers(data.users);
      setIsDemoCleared(false);
      showToast('Demonstration data restored!');
    } else {
      showToast(data.error || 'Failed to restore demo data.');
    }
  };

  // Add new user to team roster
  const handleAddUser = async (userData: { name: string; email: string; role: UserRole; password?: string; venueId?: string; permissions?: { canFillTasks?: boolean; canAssignTasks?: boolean } }) => {
    const result = await apiWrite('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...userData,
        adminEmail: currentUser.email,
        venueId: userData.venueId || currentVenue?.id,
      }),
    });
    if (!result.ok) {
      throw new Error(result.error || 'Failed to add team member');
    }
    const data = result.data;
    // Dedupe by id: the USERS_UPDATED broadcast can arrive before the
    // POST resolves, in which case the member is already in state.
    setKnownUsers((prev) => (prev.some((u) => u.id === data.user.id) ? prev : [...prev, data.user]));
    showToast(`Added new team member: ${data.user.name} (${data.user.email})`);
  };

  // Update existing user (role, permissions)
  const handleUpdateUser = async (userId: string, updates: { role?: UserRole; permissions?: { canFillTasks?: boolean; canAssignTasks?: boolean }; kioskPin?: string }) => {
    const result = await apiWrite(`/api/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updates,
        adminEmail: currentUser.email,
      }),
    });
    if (!result.ok) {
      throw new Error(result.error || 'Failed to update user');
    }
    const data = result.data;
    setKnownUsers((prev) => prev.map((u) => (u.id === userId ? data.user : u)));
    if (currentUser && currentUser.id === userId) {
      setCurrentUser(data.user);
    }
    showToast(`Updated permissions for ${data.user.name}`);
  };

  // Delete/Remove user from team roster
  const handleDeleteUser = async (userId: string) => {
    const result = await apiWrite(`/api/users/${userId}?adminEmail=${encodeURIComponent(currentUser.email)}`, { method: 'DELETE' });
    if (!result.ok) {
      throw new Error(result.error || 'Failed to delete user');
    }
    setKnownUsers((prev) => prev.filter((u) => u.id !== userId));
    showToast('Member removed from team roster');
  };

  // Event handlers
  const handleEventCreated = (newEvent: KosherEvent) => {
    setEvents((prev) => [newEvent, ...prev.filter((e) => e.id !== newEvent.id)]);
    showToast(`Kosher Event registered: "${newEvent.title}"`);
    setIsEventsModalOpen(true);
  };

  const handleToggleEventTask = async (
    eventId: string,
    taskId: string,
    isCompleted: boolean,
    notes?: string
  ) => {
    try {
      const result = await apiWrite(`/api/events/${eventId}/tasks/${taskId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isCompleted,
          notes,
          userEmail: currentUser?.email,
          userName: currentUser?.name,
        }),
      });

      if (!result.ok) {
        throw new Error(result.error || 'Failed to update event task status');
      }

      const data = result.data;
      if (data.event) {
        setEvents((prev) => prev.map((e) => (e.id === data.event.id ? data.event : e)));
      }
    } catch (err: any) {
      showToast(err.message || 'Error updating event task');
    }
  };

  const handleUpdateEvent = async (updatedEvent: KosherEvent) => {
    try {
      const result = await apiWrite(`/api/events/${updatedEvent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedEvent,
          userEmail: currentUser?.email,
          userName: currentUser?.name,
        }),
      });
      if (!result.ok) throw new Error(result.error || 'Failed to update event');
      const data = result.data;
      setEvents((prev) => prev.map((e) => (e.id === data.event.id ? data.event : e)));
      showToast('Event updated successfully');
    } catch (err: any) {
      showToast(err.message || 'Error updating event');
    }
  };

  const handleDeleteEvent = async (eventId: string) => {
    setConfirmModalConfig({
      isOpen: true,
      title: 'Delete Kosher Event?',
      message: 'Are you sure you want to remove this event schedule? This will delete the event assignment and checklist.',
      confirmText: 'Delete Event',
      cancelText: 'Cancel',
      variant: 'danger',
      icon: 'trash',
      onConfirm: async () => {
        setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }));
        try {
          const result = await apiWrite(`/api/events/${eventId}`, { method: 'DELETE' });
          if (!result.ok) throw new Error(result.error || 'Failed to delete event');
          setEvents((prev) => prev.filter((e) => e.id !== eventId));
          showToast('Event notification deleted');
        } catch (err: any) {
          showToast(err.message || 'Error deleting event');
        }
      },
    });
  };

  // Statistics calculation
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.isCompleted).length;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const myTasks = tasks.filter(
    (t) => t.assignedTo.includes('all') || (currentUser && t.assignedTo.includes(currentUser.email))
  );
  const myTotal = myTasks.length;
  const myCompleted = myTasks.filter((t) => t.isCompleted).length;

  const categories = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((t) => {
      for (const c of taskCategories(t)) set.add(c);
    });
    return Array.from(set);
  }, [tasks]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    tasks.forEach((t) => {
      for (const c of taskCategories(t)) counts[c] = (counts[c] || 0) + 1;
    });
    return counts;
  }, [tasks]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    const todayIndex = new Date().getDay();

    return tasks.filter((task) => {
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = task.title.toLowerCase().includes(q);
        const matchesDesc = (task.description || '').toLowerCase().includes(q);
        const matchesNotes = (task.notes || '').toLowerCase().includes(q);
        const matchesCategory = taskCategories(task).some((c) => c.toLowerCase().includes(q));
        const matchesWorker = (task.updatedByName || task.updatedByEmail || '').toLowerCase().includes(q);
        if (!matchesTitle && !matchesDesc && !matchesNotes && !matchesCategory && !matchesWorker) {
          return false;
        }
      }

      // Category filter — a task shows under any of its categories
      if (selectedCategory !== 'all' && !taskCategories(task).includes(selectedCategory)) {
        return false;
      }

      // Schedule filter (today only)
      if (showOnlyTodaySchedule) {
        if (task.scheduleType === 'specific_dates') {
          const todayIso = new Date().toISOString().split('T')[0];
          if (!task.specificDates || !task.specificDates.includes(todayIso)) {
            return false;
          }
        } else if (!task.daysOfWeek || !task.daysOfWeek.includes(todayIndex)) {
          return false;
        }
      }

      // Tab filter
      if (activeTabFilter === 'mine') {
        const isAssigned = task.assignedTo.includes('all') || (currentUser && task.assignedTo.includes(currentUser.email));
        if (!isAssigned) return false;
      } else if (activeTabFilter === 'pending') {
        if (task.isCompleted) return false;
      } else if (activeTabFilter === 'completed') {
        if (!task.isCompleted) return false;
      }

      return true;
    });
  }, [tasks, searchQuery, selectedCategory, showOnlyTodaySchedule, activeTabFilter, currentUser?.email]);

  // Smart board order: urgent first, then the viewer's own assignments,
  // then the manual order (up/down arrows; initialized from target time).
  const sortedTasks = useMemo(
    () => sortTasksForBoard(filteredTasks, currentUser?.email),
    [filteredTasks, currentUser?.email]
  );

  // Manual reorder (up/down arrows, assigners only): swap the two tasks'
  // positions within their board section. Pinned sections (urgent / mine)
  // keep their order rules — the arrows fine-tune inside each group.
  const handleMoveTask = async (taskId: string, direction: 'up' | 'down') => {
    if (!currentUser || !canUserAssignTasks(currentUser)) {
      showToast('Only admins and coordinators can reorder tasks.');
      return;
    }
    const list = sortTasksForBoard(filteredTasks, currentUser.email);
    const idx = list.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    const nIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (nIdx < 0 || nIdx >= list.length) return;
    if (boardTier(list[idx], currentUser.email) !== boardTier(list[nIdx], currentUser.email)) {
      showToast('Pinned tasks stay in their section — reorder inside the group.');
      return;
    }
    const a = list[idx];
    const b = list[nIdx];
    const aOrder = a.sortOrder ?? 0;
    const bOrder = b.sortOrder ?? 0;
    // Optimistic swap
    setTasks((prev) =>
      prev.map((t) =>
        t.id === a.id ? { ...t, sortOrder: bOrder } : t.id === b.id ? { ...t, sortOrder: aOrder } : t
      )
    );
    const headers = { 'Content-Type': 'application/json' };
    const payload = (sortOrder: number) =>
      JSON.stringify({ userEmail: currentUser.email, sortOrder });
    const ra = await apiWrite(`/api/tasks/${a.id}`, { method: 'PUT', headers, body: payload(bOrder) });
    if (!ra.ok) {
      // Nothing persisted — roll the whole swap back.
      setTasks((prev) =>
        prev.map((t) =>
          t.id === a.id ? { ...t, sortOrder: aOrder } : t.id === b.id ? { ...t, sortOrder: bOrder } : t
        )
      );
      console.warn('Could not persist task order:', ra.error);
      showToast(ra.error || 'Could not save the new order — please try again.');
      return;
    }
    const rb = await apiWrite(`/api/tasks/${b.id}`, { method: 'PUT', headers, body: payload(aOrder) });
    if (!rb.ok) {
      // The first write committed but the second did not: keep `a` at its new
      // order (matches the server) and roll back only `b`.
      setTasks((prev) =>
        prev.map((t) => (t.id === b.id ? { ...t, sortOrder: bOrder } : t))
      );
      console.warn('Could not persist task order:', rb.error);
      showToast(rb.error || 'Could not save the new order — please try again.');
    }
  };

  // Open Task Modal
  const handleOpenCreateTask = () => {
    if (!currentUser) {
      showToast('Please sign in first.');
      return;
    }
    if (!canUserAssignTasks(currentUser)) {
      showToast('Permission required. You do not have permission to assign or create new tasks.');
      return;
    }
    setTaskToEdit(null);
    setIsTaskModalOpen(true);
  };

  // Sign Out Handler
  const handleLogout = () => {
    setCurrentUser(null);
    setCurrentVenueId(null);
    setVenues([]);
    setTasks([]);
    setHistoryLogs([]);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('current_user');
      localStorage.removeItem('selected_venue_id');
    }
    clearSession();
    realtimeSocket.disconnect();
    setSavedSession(null);
    // In kiosk mode the tablet returns to the PIN screen, not the landing page.
    if (!kioskMode) setAuthView('landing');
    showToast('Signed out successfully.');
  };

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    setSavedSession(user);
    setCurrentVenueId(null);
    // Reconnect real-time socket with the new session token.
    realtimeSocket.reconnect();
    // Mashgichim land straight on their own assignments
    if (user && (user.role === 'mashgiach' || user.role === 'worker')) {
      setActiveTabFilter('mine');
    } else {
      setActiveTabFilter('all');
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem('current_user', JSON.stringify(user));
      localStorage.removeItem('selected_venue_id');
    }
    showToast(`Welcome to ${user.agencyName || 'Shutfey'}, ${user.name}!`);
  };

  // Public screens: the landing home page opens first; auth form on demand.
  // Require authentication to view tasks and shift operations
  if (!currentUser) {
    // Kiosk tablets pair once, then go straight to their venue's PIN screen.
    if (isKiosk) {
      return (
        <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors">
          {toastMessage && (
            <div className="fixed bottom-5 right-5 z-50 bg-ink text-paper text-xs font-semibold px-4 py-3 rounded-2xl tactile-4 border border-line-strong flex items-center gap-2 animate-slide-up">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>{toastMessage}</span>
            </div>
          )}
          {!kioskDevice ? (
            <KioskPairing
              onPaired={(device) => setKioskDeviceState(device)}
              onExitKiosk={exitKioskMode}
              darkMode={darkMode}
            />
          ) : (
            <KioskLogin
              onLoginSuccess={handleLoginSuccess}
              onExitKiosk={exitKioskMode}
              onUnpaired={() => setKioskDeviceState(null)}
              darkMode={darkMode}
            />
          )}
        </div>
      );
    }
    if (authView === 'landing') {
      return (
        <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors">
          {toastMessage && (
            <div className="fixed bottom-5 right-5 z-50 bg-ink text-paper text-xs font-semibold px-4 py-3 rounded-2xl tactile-4 border border-line-strong flex items-center gap-2 animate-slide-up">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>{toastMessage}</span>
            </div>
          )}
          <LandingPage
            savedUser={savedSession}
            onContinueAs={() => {
              if (savedSession) handleLoginSuccess(savedSession);
            }}
            onUseDifferentAccount={() => {
              setSavedSession(null);
              if (typeof window !== 'undefined') localStorage.removeItem('current_user');
              setAuthInitialMode('login');
              setAuthView('auth');
            }}
            onSignIn={() => {
              setAuthInitialMode('login');
              setAuthView('auth');
            }}
            onRegister={() => {
              setAuthInitialMode('signup');
              setAuthView('auth');
            }}
            darkMode={darkMode}
            onToggleDarkMode={() => setDarkMode(!darkMode)}
          />
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors">
        {toastMessage && (
          <div className="fixed bottom-5 right-5 z-50 bg-ink text-paper text-xs font-semibold px-4 py-3 rounded-2xl tactile-4 border border-line-strong flex items-center gap-2 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span>{toastMessage}</span>
          </div>
        )}
        <LoginPage
          onLoginSuccess={handleLoginSuccess}
          initialMode={authInitialMode}
          onBack={() => setAuthView('landing')}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode(!darkMode)}
        />
      </div>
    );
  }

  const taskTableView = (
    <TaskTableView
      tasks={sortedTasks}
      currentUser={currentUser}
      onUpdateStatus={handleUpdateStatus}
      onUpdateNotes={handleUpdateNotes}
      onEditTask={(task) => {
        if (!canUserAssignTasks(currentUser)) {
          showToast('You do not have permission to edit task definitions.');
          return;
        }
        setTaskToEdit(task);
        setIsTaskModalOpen(true);
      }}
      onDeleteTask={handleDeleteTask}
      onOpenTaskModal={handleOpenCreateTask}
      onCheckIn={handleCheckIn}
      onRemoveCheckIn={handleRemoveCheckIn}
      onMoveTask={handleMoveTask}
      canReorder={canUserAssignTasks(currentUser)}
    />
  );
  const taskCardView = (
    <TaskCardView
      tasks={sortedTasks}
      currentUser={currentUser}
      onUpdateStatus={handleUpdateStatus}
      onUpdateNotes={handleUpdateNotes}
      onCheckIn={handleCheckIn}
      onRemoveCheckIn={handleRemoveCheckIn}
      onMoveTask={handleMoveTask}
      canReorder={canUserAssignTasks(currentUser)}
      onEditTask={(task) => {
        if (!canUserAssignTasks(currentUser)) {
          showToast('You do not have permission to edit task definitions.');
          return;
        }
        setTaskToEdit(task);
        setIsTaskModalOpen(true);
      }}
      onDeleteTask={handleDeleteTask}
      onOpenTaskModal={handleOpenCreateTask}
    />
  );

  // Admin "Delete venue" (same confirm on the stats card and the kiosk panel).
  const deleteVenueAction =
    currentUser?.role === 'admin' && currentVenue
      ? () => {
          const targetVenue = currentVenue;
          setConfirmModalConfig({
            isOpen: true,
            title: `Delete "${targetVenue.name}"?`,
            message: `Are you sure you want to delete "${targetVenue.name}" and all its shift assignments and logs? This action cannot be undone.`,
            confirmText: 'Delete Venue',
            cancelText: 'Cancel',
            variant: 'danger',
            icon: 'trash',
            onConfirm: async () => {
              setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }));
              await handleDeleteVenue(targetVenue.id);
            },
          });
        }
      : undefined;

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors">
      {/* Stale-draft banner: changes preserved across the refresh that a
          428 STALE_CLIENT required. Re-apply sends them with a fresh version. */}
      {staleDrafts.length > 0 && (
        <div className="sticky top-0 z-40 bg-amber-100 dark:bg-amber-900 border-b border-amber-300 px-4 py-3">
          {staleDrafts.map((d) => (
            <div key={d.key} className="flex items-center gap-3 text-sm mb-2 last:mb-0">
              <span className="flex-1">
                <strong>Unsaved change preserved:</strong> {d.label}{' '}
                <span className="opacity-70">(saved {new Date(d.savedAt).toLocaleTimeString()})</span>
              </span>
              <button
                onClick={() => handleReapplyDraft(d)}
                className="px-3 py-1 rounded-lg bg-amber-600 text-white text-xs font-semibold"
              >
                Re-apply
              </button>
              <button
                onClick={() => handleDiscardDraft(d)}
                className="px-3 py-1 rounded-lg border border-amber-400 text-xs"
              >
                Discard
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-ink text-paper text-xs font-semibold px-4 py-3 rounded-2xl tactile-4 border border-line-strong flex items-center gap-2 animate-slide-up">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Kiosk: always-visible End shift button for the wall tablet. With a
          venue, the kiosk panel carries it in its sticky strip instead (D3a). */}
      {isKiosk && venues.length === 0 && (
        <button
          onClick={handleLogout}
          className="fixed bottom-5 left-5 z-50 tactile-4 bg-red-700 text-white text-base font-extrabold font-sans px-6 py-4 rounded-2xl shadow-lg active:scale-95 transition-transform"
        >
          End shift — {currentUser.name.split(' ')[0]}
        </button>
      )}

      {/* Navigation Header */}
      <Header
        currentUser={currentUser}
        onLogout={handleLogout}
        onOpenChangePassword={() => setIsChangePasswordOpen(true)}
        onOpenTaskModal={handleOpenCreateTask}
        onOpenHistoryModal={() => setIsHistoryModalOpen(true)}
        onOpenEventsModal={() => setIsEventsModalOpen(true)}
        onOpenCreateEvent={() => setIsCreateEventModalOpen(true)}
        onOpenFactoryAudit={() => setIsFactoryAuditOpen(true)}
        eventsCount={events.length}
        onOpenTeamModal={() => setIsTeamModalOpen(true)}
        onOpenKioskDevices={() => setIsKioskDevicesOpen(true)}
        onResetDailyBoard={handleResetDailyBoard}
        isRealtimeConnected={isRealtimeConnected}
        activeWorkersCount={activeWorkersCount}
        totalWorkersCount={knownUsers.length}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        completionRate={completionRate}
        currentVenue={currentVenue}
        updatesBell={
          currentUser ? (
            <UpdatesBell count={updates.bellCount} onClick={() => updates.setSheetOpen(true)} />
          ) : undefined
        }
        allVenues={venues}
        onSelectVenue={handleSelectVenue}
        onOpenVenuesDirectory={() => setIsVenuesDirectoryOpen(true)}
        onOpenCreateVenue={() => setIsCreateVenueOpen(true)}
        isDemoCleared={isDemoCleared}
        onCleanSlate={handleCleanSlate}
        onRestoreDemo={handleRestoreDemo}
      />

      {/* 5a: newest unread urgent announcement for this venue */}
      {updates.topUrgent && (
        <UrgentBanner
          item={updates.topUrgent}
          onView={(id) => updates.setSheetOpen(true, 'announcements', id)}
          onDismiss={(id) => updates.dismissUrgent(id)}
        />
      )}

      {/* 5b: newest open High/Critical alert routed to me, until seen */}
      {!updates.topUrgent && updates.topAlert && (
        <UrgentBanner
          item={updates.topAlert}
          kicker="Alert"
          onView={(id) => updates.setSheetOpen(true, 'alerts', id)}
          onDismiss={(id) => updates.dismissAlertBanner(id)}
        />
      )}

      {/* Updates sheet (Announcements | Shift notes | Alerts) */}
      <UpdatesSheet
        open={updates.sheetOpen}
        onClose={() => updates.setSheetOpen(false)}
        activeTab={updates.activeTab}
        onTabChange={updates.setActiveTab}
        unreadAnnouncements={updates.unread.announcements}
        unreadNotes={updates.unread.notes}
        unreadAlerts={isKiosk ? null : updates.unread.alerts}
        overlay={
          readersFor && currentVenue ? (
            <ReadersPanel
              kind={readersFor.kind}
              id={readersFor.id}
              venueId={currentVenue.id}
              title={readersFor.title}
              onClose={() => setReadersFor(null)}
            />
          ) : null
        }
        alerts={
          <AlertsTab
            items={updates.alerts}
            loading={updates.listsLoading}
            unreadIds={new Set(updates.unread.unreadAlertIds)}
            role={currentUser?.role || ''}
            viewerVenueIds={venues.map((v) => v.id)}
            canFillTasks={canUserFillTasks(currentUser)}
            venueId={currentVenue?.id || ''}
            active={updates.sheetOpen && updates.activeTab === 'alerts'}
            highlightId={updates.highlightId}
            receipts={updates.seesReceipts ? (updates.receipts?.alerts ?? {}) : null}
            mutedUntil={updates.mutedUntil}
            onMuteChange={updates.setMutedUntil}
            onMark={updates.markVisible}
            onChanged={() => { void updates.loadLists(); void updates.refreshUnread(); }}
            onOpenReaders={(id, title) => setReadersFor({ kind: 'alert', id, title })}
            draft={updates.alertDraft}
            media={updates.alertMedia}
            draftGen={updates.draftGen}
            onDraftChange={updates.setAlertDraft}
            onMediaChange={updates.setAlertMedia}
            onDiscardDraft={updates.clearAlertDraft}
            onDraftSent={updates.clearAlertDraft}
          />
        }
        announcements={
          <Announcements
            items={updates.announcements}
            loading={updates.listsLoading}
            readOnly={isKiosk}
            canPost={!!currentUser && ['admin', 'coordinator'].includes(currentUser.role)}
            canDelete={(item) =>
              !!currentUser &&
              !!currentVenue &&
              announcementCanDelete(item, currentUser.role, currentVenue.id)
            }
            unreadIds={new Set(updates.unread.unreadAnnouncementIds)}
            currentUserEmail={currentUser?.email || ''}
            currentUserName={currentUser?.name || ''}
            currentUserRole={currentUser?.role || ''}
            venueId={currentVenue?.id || ''}
            active={updates.sheetOpen && updates.activeTab === 'announcements'}
            highlightId={updates.highlightId}
            onMark={updates.markVisible}
            onPosted={() => { void updates.loadLists(); void updates.refreshUnread(); }}
            onDeleted={() => { void updates.loadLists(); void updates.refreshUnread(); }}
            receipts={updates.seesReceipts ? (updates.receipts?.announcements ?? {}) : null}
            onOpenReaders={(id, title) => setReadersFor({ kind: 'announcement', id, title })}
          />
        }
        notes={
          <HandoffNotes
            items={updates.notes}
            loading={updates.listsLoading}
            readOnly={isKiosk}
            unreadIds={new Set(updates.unread.unreadNoteIds)}
            venueId={currentVenue?.id || ''}
            currentUserEmail={currentUser?.email || ''}
            currentUserName={currentUser?.name || ''}
            active={updates.sheetOpen && updates.activeTab === 'notes'}
            canDelete={(note) =>
              !!currentUser &&
              (note.authorEmail === currentUser.email ||
                currentUser.role === 'admin' ||
                (currentUser.role === 'coordinator' && note.venueId === currentVenue?.id))
            }
            onMark={updates.markVisible}
            onPosted={() => { void updates.loadLists(); void updates.refreshUnread(); }}
            onDeleted={() => { void updates.loadLists(); void updates.refreshUnread(); }}
          />
        }
      />

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 pt-4 sm:pt-6 pb-12">
        
        {/* Welcome Empty State for newly registered Kosher Agencies or when starting from scratch */}
        {venues.length === 0 ? (
          <div className="my-10 p-8 sm:p-10 rounded-3xl bg-surface border border-gold/40 tactile-3 text-center max-w-2xl mx-auto animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-gold-wash text-gold-deep mx-auto flex items-center justify-center mb-4 ring-8 ring-gold/15 border border-gold/30">
              <Building2 className="w-8 h-8" />
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gold-wash text-gold-ink text-[11px] font-bold uppercase tracking-wider mb-2 border border-gold/30">
              <ShieldCheck className="w-3.5 h-3.5 text-gold-deep" />
              <span>{currentUser?.agencyShortCode || 'HKC'} Kashrut Portal</span>
            </div>
            <h3 className="text-xl sm:text-2xl font-black text-ink">
              {currentUser?.agencyName || 'Hartford Kashrut Commission (HKC)'}
            </h3>
            <p className="text-xs sm:text-sm text-ink-soft mt-2 max-w-md mx-auto leading-relaxed">
              Your platform is a clean slate ready for production. Add your first certified restaurant, bakery, meat market, or catering facility to start managing real checklists, temperature logs, and mashgichim shifts.
            </p>
            <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setIsCreateVenueOpen(true)}
                className="pressable w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white font-bold text-xs sm:text-sm tactile-2 transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>Establish First Kosher Venue</span>
              </button>

              <button
                type="button"
                onClick={handleRestoreDemo}
                className="pressable w-full sm:w-auto px-5 py-2.5 rounded-xl bg-sunken hover:border-line-strong text-ink-soft font-semibold text-xs sm:text-sm border border-line tactile-1 transition flex items-center justify-center gap-2 cursor-pointer"
                title="Restore example venues, mashgichim, and tasks to explore features"
              >
                <Sparkles className="w-4 h-4 text-gold-deep" />
                <span>Load Example Templates</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Live Progress Header / Owner Audit Banner (the kiosk shows its own progress ring) */}
            {isKiosk ? null : currentUser?.role === 'owner' ? (
              <OwnerAuditBanner
                totalTasks={totalTasks}
                completedTasks={completedTasks}
                completionRate={completionRate}
                activeFilter={activeTabFilter}
                onSelectFilter={(f: any) => setActiveTabFilter(f)}
                onOpenHistoryModal={() => setIsHistoryModalOpen(true)}
                ownerName={currentUser.name}
              />
            ) : (
              <StatsProgressBar
                totalTasks={totalTasks}
                completedTasks={completedTasks}
                completionRate={completionRate}
                myTotal={myTotal}
                myCompleted={myCompleted}
                activeFilter={activeTabFilter}
                onSelectFilter={(f: any) => setActiveTabFilter(f)}
                agencyName={currentUser?.agencyName || 'Hartford Kashrut Commission'}
                venueName={currentVenue?.name}
                venueCategory={currentVenue?.category}
                venueCertification={currentVenue?.certification}
                isRealtimeConnected={isRealtimeConnected}
                activeWorkersCount={activeWorkersCount}
                isAdmin={currentUser?.role === 'admin'}
                onDeleteVenue={deleteVenueAction}
              />
            )}

        {/* Factory & Airtable Ingredients Audit Quick Banner (Shown for Industrial Plant facilities) */}
        {(currentVenue?.category?.toLowerCase().includes('industrial') || currentVenue?.category?.toLowerCase().includes('plant') || currentVenue?.category?.toLowerCase().includes('factory')) && (
          <div className="mb-4 px-4 py-3 rounded-[20px] bg-gold-wash border border-gold/30 tactile-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2 shrink-0">
                <Factory className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-gold-ink">
                    Industrial Facility: Approved Ingredients & Floor Audit Active
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase bg-gold/15 text-gold-deep border border-gold/30">
                    Airtable
                  </span>
                </div>
                <p className="text-[11px] text-ink-soft mt-0.5">
                  Mashgichim must cross-check factory floor bulk bags and drums against agency-approved raw materials and file inspection logs.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
              <button
                type="button"
                onClick={() => setIsFactoryAuditOpen(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 active:scale-[.98] text-white text-xs font-bold tactile-2 transition cursor-pointer"
              >
                <span>Launch Ingredients Audit</span>
              </button>
            </div>
          </div>
        )}

        {/* Compact Kosher Events Alert (Only shown when active events exist) */}
        {events.length > 0 && (
          <div className="mb-4 px-4 py-2.5 rounded-2xl bg-gold-wash border border-gold/40 tactile-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 animate-fade-in">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-1.5 rounded-lg bg-gold/15 text-gold-deep shrink-0 border border-gold/30">
                <Calendar className="w-4 h-4" />
              </div>
              <span className="text-xs text-gold-ink font-semibold truncate">
                <strong>{events.length} active kosher event {events.length === 1 ? 'schedule' : 'schedules'}</strong> registered for this facility.
              </span>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
              <button
                type="button"
                onClick={() => setIsEventsModalOpen(true)}
                className="pressable px-3 py-1 rounded-xl bg-surface hover:border-gold text-gold-ink border border-gold/40 text-xs font-bold transition cursor-pointer tactile-1"
              >
                View Events ({events.length})
              </button>
            </div>
          </div>
        )}

        {isKiosk ? (
          <KioskTaskPanel
            tasks={sortedTasks}
            currentUser={currentUser}
            venueName={currentVenue?.name}
            activeFilter={activeTabFilter}
            onSelectFilter={setActiveTabFilter}
            totalTasks={totalTasks}
            completedTasks={completedTasks}
            myTotal={myTotal}
            myCompleted={myCompleted}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            categories={categories}
            categoryCounts={categoryCounts}
            showOnlyTodaySchedule={showOnlyTodaySchedule}
            onToggleScheduleFilter={() => setShowOnlyTodaySchedule(!showOnlyTodaySchedule)}
            view={kioskView}
            onViewChange={setKioskView}
            onUpdateStatus={handleUpdateStatus}
            onUpdateNotes={handleUpdateNotes}
            onCheckIn={handleCheckIn}
            onRemoveCheckIn={handleRemoveCheckIn}
            onMoveTask={handleMoveTask}
            canReorder={canUserAssignTasks(currentUser)}
            onEditTask={(task) => {
              if (!canUserAssignTasks(currentUser)) {
                showToast('You do not have permission to edit task definitions.');
                return;
              }
              setTaskToEdit(task);
              setIsTaskModalOpen(true);
            }}
            onDeleteTask={handleDeleteTask}
            onOpenTaskModal={handleOpenCreateTask}
            isAdmin={canUserAssignTasks(currentUser)}
            onDeleteVenue={deleteVenueAction}
            onEndShift={handleLogout}
          >
            {kioskView === 'table' ? taskTableView : kioskView === 'cards' ? taskCardView : null}
          </KioskTaskPanel>
        ) : (
          <>
          {/* Search, Categories, Layout Switcher & New Assignment Button */}
          <TaskFilterBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            categories={categories}
            categoryCounts={categoryCounts}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            showOnlyTodaySchedule={showOnlyTodaySchedule}
            onToggleScheduleFilter={() => setShowOnlyTodaySchedule(!showOnlyTodaySchedule)}
            onOpenTaskModal={handleOpenCreateTask}
            isAdmin={canUserAssignTasks(currentUser)}
          />

            {/* Dynamic View Mode: Excel-like Table View vs Responsive Card View */}
            {viewMode === 'table' ? taskTableView : taskCardView}
          </>
        )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-line py-4 px-6 text-center text-xs text-ink-faint">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Shutfey Operations & Audit Engine</span>
          <div className="flex items-center gap-3">
            {currentUser?.role === 'admin' && (
              <>
                <button onClick={() => setIsVenuesDirectoryOpen(true)} className="hover:underline text-gold-deep">
                  Venues Hub ({venues.length})
                </button>
                <span>•</span>
                <button onClick={() => setIsTeamModalOpen(true)} className="hover:underline text-gold-deep">
                  Team Roster ({knownUsers.length})
                </button>
                <span>•</span>
              </>
            )}
            <button onClick={() => setIsHistoryModalOpen(true)} className="hover:underline text-ink-soft">
              Shift History Archives
            </button>
          </div>
        </div>
      </footer>

      {/* Modals */}
      <TaskModal
        isOpen={isTaskModalOpen}
        onClose={() => {
          setIsTaskModalOpen(false);
          setTaskToEdit(null);
        }}
        onSave={handleSaveTask}
        taskToEdit={taskToEdit}
        knownWorkers={knownUsers}
        currentUserEmail={currentUser?.email}
      />

      <HistoryLogModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        historyLogs={historyLogs}
      />

      <ChangePasswordModal
        isOpen={isChangePasswordOpen}
        onClose={() => setIsChangePasswordOpen(false)}
        currentUser={currentUser}
        onSuccessToast={(msg) => showToast(msg)}
      />

      <KioskDevicesModal
        isOpen={isKioskDevicesOpen}
        onClose={() => setIsKioskDevicesOpen(false)}
        currentUser={currentUser}
        venues={venues}
      />

      <TeamModal
        isOpen={isTeamModalOpen}
        onClose={() => setIsTeamModalOpen(false)}
        users={knownUsers}
        tasks={tasks}
        currentUser={currentUser}
        currentVenue={currentVenue}
        onAddUser={handleAddUser}
        onUpdateUser={handleUpdateUser}
        onDeleteUser={handleDeleteUser}
      />

      <CreateVenueModal
        isOpen={isCreateVenueOpen}
        onClose={() => setIsCreateVenueOpen(false)}
        onVenueCreated={handleVenueCreated}
        adminEmail={currentUser.email}
        agencyName={currentUser.agencyName}
        agencySeal={currentUser.agencySeal}
      />

      <VenuesDirectoryModal
        isOpen={isVenuesDirectoryOpen}
        onClose={() => setIsVenuesDirectoryOpen(false)}
        venues={venues}
        currentVenue={currentVenue}
        onSelectVenue={handleSelectVenue}
        onOpenCreateVenue={() => {
          setIsVenuesDirectoryOpen(false);
          setIsCreateVenueOpen(true);
        }}
        onDeleteVenue={handleDeleteVenue}
        isAdmin={currentUser.role === 'admin'}
      />

      {/* Kosher Events & Banquets Hub Modal */}
      <EventsModal
        isOpen={isEventsModalOpen}
        onClose={() => setIsEventsModalOpen(false)}
        events={events}
        currentUser={currentUser}
        currentVenue={currentVenue}
        allVenues={venues}
        availableMashgichim={knownUsers}
        onOpenCreateEvent={() => {
          setIsEventsModalOpen(false);
          setIsCreateEventModalOpen(true);
        }}
        onToggleEventTask={handleToggleEventTask}
        onUpdateEvent={handleUpdateEvent}
        onDeleteEvent={handleDeleteEvent}
      />

      {/* Create / Notify Event Modal */}
      <CreateEventModal
        isOpen={isCreateEventModalOpen}
        onClose={() => setIsCreateEventModalOpen(false)}
        onEventCreated={handleEventCreated}
        currentUser={currentUser}
        currentVenue={currentVenue}
        allVenues={venues}
        availableMashgichim={knownUsers}
      />

      {/* Factory & Airtable Ingredients Audit Hub Modal */}
      <FactoryAuditHubModal
        isOpen={isFactoryAuditOpen}
        onClose={() => setIsFactoryAuditOpen(false)}
        currentVenue={currentVenue}
        currentUser={currentUser}
        isAdmin={currentUser?.role === 'admin' || currentUser?.role === 'coordinator'}
      />

      {/* Reusable In-App Confirmation Modal */}
      <ConfirmModal
        isOpen={confirmModalConfig.isOpen}
        onClose={() => setConfirmModalConfig((prev) => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModalConfig.onConfirm}
        title={confirmModalConfig.title}
        message={confirmModalConfig.message}
        confirmText={confirmModalConfig.confirmText}
        cancelText={confirmModalConfig.cancelText}
        variant={confirmModalConfig.variant}
        icon={confirmModalConfig.icon}
        isLoading={confirmModalConfig.isLoading}
      />
    </div>
  );
}
