import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { StatsProgressBar } from './components/StatsProgressBar';
import { OwnerAuditBanner } from './components/OwnerAuditBanner';
import { TaskFilterBar } from './components/TaskFilterBar';
import { TaskTableView } from './components/TaskTableView';
import { TaskCardView } from './components/TaskCardView';
import { TaskModal } from './components/TaskModal';
import { HistoryLogModal } from './components/HistoryLogModal';
import { SupabaseModal } from './components/SupabaseModal';
import { LoginPage } from './components/LoginPage';
import { LandingPage } from './components/LandingPage';
import { ChangePasswordModal } from './components/ChangePasswordModal';
import { TeamModal } from './components/TeamModal';
import { CreateVenueModal } from './components/CreateVenueModal';
import { VenuesDirectoryModal } from './components/VenuesDirectoryModal';
import { EventsModal } from './components/EventsModal';
import { CreateEventModal } from './components/CreateEventModal';
import { ConfirmModal } from './components/ConfirmModal';
import { FactoryAuditHubModal } from './components/FactoryAuditHubModal';
import { Task, TaskStatus, User, UserRole, DailySnapshot, ServerBroadcastMessage, Venue, KosherEvent } from './types';
import { realtimeSocket } from './lib/socketClient';
import { testFirestoreConnection } from './lib/firebaseClient';
import { Building2, MapPin, ShieldCheck, Plus, ExternalLink, Calendar, Sparkles, Factory } from 'lucide-react';
import { canUserFillTasks, canUserAssignTasks, getRoleLabel } from './lib/permissions';
import { refreshCustomCategories } from './lib/categoryStyle';

const DEFAULT_USERS: User[] = [
  { id: 'usr_admin', agencyId: 'agency-hkc', agencyName: 'Hartford Kashrut Commission (HKC)', agencyShortCode: 'HKC', agencySeal: 'Glatt Kosher & Mehadrin Kashrut', email: 'kenan@hartfordkashrut.org', name: 'Kenan (Admin)', role: 'admin', avatarColor: '#3b82f6', permissions: { canFillTasks: true, canAssignTasks: true } },
];

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme_mode');
      if (saved) return saved === 'dark';
      return true; // default to the dark theme
    }
    return true;
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
  // "Continue as ..." rather than auto-entering the account.
  const [currentUser, setCurrentUser] = useState<User | null>(null);

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
  const [showOnlyTodaySchedule, setShowOnlyTodaySchedule] = useState(false);

  // Modals
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isSupabaseModalOpen, setIsSupabaseModalOpen] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [isTeamModalOpen, setIsTeamModalOpen] = useState(false);
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
    fetch(url)
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

    fetch(`/api/tasks${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.tasks)) {
          setTasks(data.tasks);
        }
      })
      .catch((err) => console.warn('Could not fetch /api/tasks:', err));

    fetch(`/api/history${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.historyLogs)) {
          setHistoryLogs(data.historyLogs);
        }
      })
      .catch((err) => console.warn('Could not fetch /api/history:', err));

    fetch(`/api/users${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.users)) {
          setKnownUsers(data.users);
        }
      })
      .catch(() => {});

    fetch(`/api/events${qs}`)
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
      // Filter out messages for other venues if venueId is present
      const msgVenueId = (msg.payload as any)?.venueId;
      if (msgVenueId && currentVenue?.id && msgVenueId !== currentVenue.id) {
        return;
      }

      if (msg.type === 'INITIAL_STATE' && msg.payload) {
        if (Array.isArray(msg.payload.tasks)) setTasks(msg.payload.tasks);
        if (Array.isArray(msg.payload.historyLogs)) setHistoryLogs(msg.payload.historyLogs);
        if (Array.isArray(msg.payload.events)) setEvents(msg.payload.events);
        if (Array.isArray(msg.payload.users)) setKnownUsers(msg.payload.users);
        if (msg.payload.activeWorkersCount !== undefined) {
          setActiveWorkersCount(msg.payload.activeWorkersCount);
        }
      } else if (msg.type === 'TASK_UPDATED' && msg.payload) {
        const updated = msg.payload as Task;
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        if (msg.senderEmail && currentUser && msg.senderEmail !== currentUser.email) {
          showToast(`${updated.updatedByName || msg.senderEmail} updated "${updated.title}"`);
        }
      } else if (msg.type === 'TASK_CREATED' && msg.payload) {
        const created = msg.payload as Task;
        setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [...prev, created]));
        if (msg.senderEmail && currentUser && msg.senderEmail !== currentUser.email) {
          showToast(`New assignment added: "${created.title}"`);
        }
      } else if (msg.type === 'TASK_DELETED' && msg.payload) {
        setTasks((prev) => prev.filter((t) => t.id !== msg.payload.id));
      } else if (msg.type === 'DAILY_RESET' && msg.payload) {
        if (Array.isArray(msg.payload.tasks)) setTasks(msg.payload.tasks);
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

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentStatus: status,
          isCompleted,
          userEmail: currentUser.email,
          userName: currentUser.name,
        }),
      });
      const data = await res.json();
      // Ensure sync
      setTasks((prev) => prev.map((t) => (t.id === taskId ? data : t)));
    } catch (err) {
      console.error('Failed to update task status:', err);
    }
  };

  // Update Task Notes
  const handleUpdateNotes = async (taskId: string, notes: string) => {
    if (!currentUser) {
      showToast('Please sign in to update task notes.');
      return;
    }
    if (!canUserFillTasks(currentUser)) {
      showToast('You do not have permission to update task notes.');
      return;
    }
    const now = new Date().toISOString();

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

    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          userEmail: currentUser.email,
          userName: currentUser.name,
        }),
      });
    } catch (err) {
      console.error('Failed to update notes:', err);
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
    setVenues((prev) => [...prev, newVenue]);
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
      const res = await fetch(`/api/venues/${venueId}?userEmail=${encodeURIComponent(currentUser.email)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete venue platform');
      }
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

  // Save Task (Create or Edit)
  const handleSaveTask = async (taskData: Partial<Task>) => {
    if (!currentUser || !canUserAssignTasks(currentUser)) {
      showToast('You do not have permission to create or edit assignments.');
      return;
    }

    if (taskData.id) {
      // Edit
      try {
        const res = await fetch(`/api/tasks/${taskData.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...taskData,
            venueId: currentVenue?.id,
            userEmail: currentUser.email,
          }),
        });
        const updated = await res.json();
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        showToast(`Updated assignment: "${updated.title}"`);
      } catch (err) {
        console.error('Failed to edit task:', err);
      }
    } else {
      // Create
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...taskData,
            venueId: currentVenue?.id,
            createdByEmail: currentUser.email,
            userEmail: currentUser.email,
          }),
        });
        const created = await res.json();
        // Dedupe by id: the TASK_CREATED broadcast can arrive before the
        // POST resolves, in which case the task is already in state.
        setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [...prev, created]));
        showToast(`Created assignment: "${created.title}"`);
      } catch (err) {
        console.error('Failed to create task:', err);
      }
    }
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
        try {
          await fetch(`/api/tasks/${taskId}?userEmail=${encodeURIComponent(currentUser.email)}`, { method: 'DELETE' });
          setTasks((prev) => prev.filter((t) => t.id !== taskId));
          showToast('Assignment removed');
        } catch (err) {
          console.error('Failed to delete task:', err);
        }
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
        try {
          const res = await fetch('/api/reset-daily', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              resetBy: currentUser.name,
              userEmail: currentUser.email,
              venueId: currentVenue?.id 
            }),
          });
          const data = await res.json();
          if (data.tasks) setTasks(data.tasks);
          if (data.snapshot) setHistoryLogs((prev) => [data.snapshot, ...prev]);
          showToast(`Daily board for "${venueName}" has been reset and archived!`);
        } catch (err) {
          console.error('Failed to reset daily board:', err);
        }
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
        try {
          const res = await fetch('/api/admin/clean-slate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userEmail: currentUser.email }),
          });
          const data = await res.json();
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
        } catch (err) {
          console.error('Failed to clean slate:', err);
          showToast('Failed to connect to server.');
        }
      },
    });
  };

  // Restore Demonstration Facilities and Checklists (Admin Only)
  const handleRestoreDemo = async () => {
    if (!currentUser || currentUser.role !== 'admin') return;
    try {
      const res = await fetch('/api/admin/restore-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: currentUser.email }),
      });
      const data = await res.json();
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
    } catch (err) {
      console.error('Failed to restore demo data:', err);
      showToast('Failed to connect to server.');
    }
  };

  // Add new user to team roster
  const handleAddUser = async (userData: { name: string; email: string; role: UserRole; password?: string; venueId?: string; permissions?: { canFillTasks?: boolean; canAssignTasks?: boolean } }) => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...userData,
        adminEmail: currentUser.email,
        venueId: userData.venueId || currentVenue?.id,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to add team member');
    }
    const data = await res.json();
    setKnownUsers((prev) => [...prev, data.user]);
    showToast(`Added new team member: ${data.user.name} (${data.user.email})`);
  };

  // Update existing user (role, permissions)
  const handleUpdateUser = async (userId: string, updates: { role?: UserRole; permissions?: { canFillTasks?: boolean; canAssignTasks?: boolean } }) => {
    const res = await fetch(`/api/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updates,
        adminEmail: currentUser.email,
      }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to update user');
    }
    const data = await res.json();
    setKnownUsers((prev) => prev.map((u) => (u.id === userId ? data.user : u)));
    if (currentUser && currentUser.id === userId) {
      setCurrentUser(data.user);
    }
    showToast(`Updated permissions for ${data.user.name}`);
  };

  // Delete/Remove user from team roster
  const handleDeleteUser = async (userId: string) => {
    const res = await fetch(`/api/users/${userId}?adminEmail=${encodeURIComponent(currentUser.email)}`, { method: 'DELETE' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to delete user');
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
      const res = await fetch(`/api/events/${eventId}/tasks/${taskId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isCompleted,
          notes,
          userEmail: currentUser?.email,
          userName: currentUser?.name,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to update event task status');
      }

      const data = await res.json();
      if (data.event) {
        setEvents((prev) => prev.map((e) => (e.id === data.event.id ? data.event : e)));
      }
    } catch (err: any) {
      showToast(err.message || 'Error updating event task');
    }
  };

  const handleUpdateEvent = async (updatedEvent: KosherEvent) => {
    try {
      const res = await fetch(`/api/events/${updatedEvent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedEvent,
          userEmail: currentUser?.email,
          userName: currentUser?.name,
        }),
      });
      if (!res.ok) throw new Error('Failed to update event');
      const data = await res.json();
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
          const res = await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete event');
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
      if (t.category) set.add(t.category);
    });
    return Array.from(set);
  }, [tasks]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    tasks.forEach((t) => {
      if (t.category) counts[t.category] = (counts[t.category] || 0) + 1;
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
        const matchesCategory = task.category.toLowerCase().includes(q);
        const matchesWorker = (task.updatedByName || task.updatedByEmail || '').toLowerCase().includes(q);
        if (!matchesTitle && !matchesDesc && !matchesNotes && !matchesCategory && !matchesWorker) {
          return false;
        }
      }

      // Category filter
      if (selectedCategory !== 'all' && task.category !== selectedCategory) {
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
    setSavedSession(null);
    setAuthView('landing');
    showToast('Signed out successfully.');
  };

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    setSavedSession(user);
    setCurrentVenueId(null);
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
    showToast(`Welcome to ${user.agencyName || 'KeepingKosher'}, ${user.name}!`);
  };

  // Public screens: the landing home page opens first; auth form on demand.
  // Require authentication to view tasks and shift operations
  if (!currentUser) {
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

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors">
      
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-ink text-paper text-xs font-semibold px-4 py-3 rounded-2xl tactile-4 border border-line-strong flex items-center gap-2 animate-slide-up">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span>{toastMessage}</span>
        </div>
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
        onOpenSupabaseModal={() => setIsSupabaseModalOpen(true)}
        onOpenTeamModal={() => setIsTeamModalOpen(true)}
        onResetDailyBoard={handleResetDailyBoard}
        isRealtimeConnected={isRealtimeConnected}
        activeWorkersCount={activeWorkersCount}
        totalWorkersCount={knownUsers.length}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode(!darkMode)}
        completionRate={completionRate}
        currentVenue={currentVenue}
        allVenues={venues}
        onSelectVenue={handleSelectVenue}
        onOpenVenuesDirectory={() => setIsVenuesDirectoryOpen(true)}
        onOpenCreateVenue={() => setIsCreateVenueOpen(true)}
        isDemoCleared={isDemoCleared}
        onCleanSlate={handleCleanSlate}
        onRestoreDemo={handleRestoreDemo}
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
            {/* Live Progress Header / Owner Audit Banner */}
            {currentUser?.role === 'owner' ? (
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
                onDeleteVenue={
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
                    : undefined
                }
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
        {viewMode === 'table' ? (
          <TaskTableView
            tasks={filteredTasks}
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
          />
        ) : (
          <TaskCardView
            tasks={filteredTasks}
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
          />
        )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-line py-4 px-6 text-center text-xs text-ink-faint">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>KeepingKosher Operations & Audit Engine</span>
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
                <button onClick={() => setIsSupabaseModalOpen(true)} className="hover:underline text-emerald-600 dark:text-emerald-400">
                  Supabase SQL & RLS
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

      <SupabaseModal
        isOpen={isSupabaseModalOpen}
        onClose={() => setIsSupabaseModalOpen(false)}
      />

      <ChangePasswordModal
        isOpen={isChangePasswordOpen}
        onClose={() => setIsChangePasswordOpen(false)}
        currentUser={currentUser}
        onSuccessToast={(msg) => showToast(msg)}
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
