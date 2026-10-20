// 5a — UpdatesCenter: the state owner for the Updates panel.
//
// One instance per signed-in context. App keys it by {userId, agencyId,
// venueId, gen} (plan C5): a venue/agency/user switch, a logout, or the
// kiosk idle sign-out bumps the generation, App closes the sheet, and this
// hook drops every in-flight response whose generation went stale — none of
// context A's titles, counts, banner, audio or drafts can land in context B.
// REST is the authority; WebSocket messages are only a "refetch" signal.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { realtimeSocket } from '../lib/socketClient';
import {
  AnnouncementItem,
  HandoffNoteItem,
  MarkKind,
  UnreadState,
  UpdatesContext,
  fetchAnnouncements,
  fetchNotes,
  fetchUnread,
  seenQueue,
  updatesCtxKey,
} from '../lib/updates';
import {
  AlertItem,
  AlertSeverity,
  Receipts,
  fetchAlertMute,
  fetchAlerts,
  fetchReceipts,
} from '../lib/alerts';

export type UpdatesTab = 'announcements' | 'notes' | 'alerts';

const EMPTY_UNREAD: UnreadState = {
  announcements: 0,
  notes: 0,
  urgent: [],
  unreadAnnouncementIds: [],
  unreadNoteIds: [],
  alerts: 0,
  unreadAlertIds: [],
};

/** 5b (A6): the raise-form draft. Text lives here, under the context key —
 * it survives sheet close, tab switches and failed sends, and dies only on
 * a server-confirmed send, an explicit Discard, or a context change. The
 * photo/voice bytes live here too, IN MEMORY ONLY (never stored anywhere),
 * under the same lifetime. draftGen increments on every clear so async
 * steps in the reporter can tell their result belongs to a dead draft. */
export interface AlertDraft {
  title: string;
  description: string;
  severity: AlertSeverity;
  clientRef: string;
}
const newClientRef = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ref-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
const emptyDraft = (): AlertDraft => ({ title: '', description: '', severity: 'medium', clientRef: newClientRef() });

export function useUpdatesCenter(ctx: UpdatesContext | null) {
  const [unread, setUnread] = useState<UnreadState>(EMPTY_UNREAD);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [notes, setNotes] = useState<HandoffNoteItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [receipts, setReceipts] = useState<Receipts | null>(null);
  const [mutedUntil, setMutedUntilState] = useState<string | null>(null);
  const [alertDraft, setAlertDraftState] = useState<AlertDraft>(emptyDraft);
  const [alertMedia, setAlertMediaState] = useState<{ photoData?: string; voiceNoteData?: string }>({});
  const [draftGen, setDraftGen] = useState(0);
  const [listsLoading, setListsLoading] = useState(false);
  const [sheetOpen, setSheetOpenState] = useState(false);
  const [activeTab, setActiveTab] = useState<UpdatesTab>('announcements');
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  // Stale checks compare the FULL context (user, agency, venue, kiosk, gen)
  // — a response, socket signal or queued mark from any other context is
  // dropped, even one that shares the generation number.
  const ctxKey = ctx ? updatesCtxKey(ctx) : '';
  const keyRef = useRef('');
  keyRef.current = ctxKey;
  const abortRef = useRef<AbortController | null>(null);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  // The seen queue attributes marks by session identity — tell it who is
  // signed in right now so a stale batch is dropped, never re-attributed.
  useEffect(() => {
    seenQueue.setIdentityProvider(() => ctxRef.current?.userId ?? null);
  }, []);

  const isStale = useCallback((key: string) => keyRef.current !== key, []);

  const refreshUnread = useCallback(async () => {
    const c = ctxRef.current;
    if (!c || c.kiosk) return; // the kiosk shows no count and never fetches one
    const k = updatesCtxKey(c);
    const ctrl = new AbortController();
    try {
      const u = await fetchUnread(c.venueId, ctrl.signal);
      if (!u || isStale(k)) return;
      setUnread(u);
    } catch {
      /* a failed count refresh keeps the last honest numbers */
    }
  }, [isStale]);
  const refreshUnreadRef = useRef(refreshUnread);
  refreshUnreadRef.current = refreshUnread;

  // If a seen batch is not landing (two failed sends, or ~10 s pending), the
  // queue asks for a reconcile: show the server's numbers for the CURRENT
  // context instead of the optimistic local ones. Batches from an old
  // context keep retrying there and never touch this one's badge.
  useEffect(() => {
    seenQueue.setReconcileHandler((batchKey) => {
      if (batchKey === keyRef.current) void refreshUnreadRef.current();
    });
  }, []);

  const seesReceipts = !!ctx && !ctx.kiosk && (ctx.role === 'admin' || ctx.role === 'coordinator');

  const loadLists = useCallback(async () => {
    const c = ctxRef.current;
    if (!c) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const k = updatesCtxKey(c);
    setListsLoading(true);
    try {
      const [anns, nts, alts, recs] = await Promise.all([
        fetchAnnouncements(ctrl.signal),
        fetchNotes(c.venueId, ctrl.signal),
        c.kiosk ? Promise.resolve([] as AlertItem[]) : fetchAlerts(c.venueId, ctrl.signal),
        // Receipts are supplementary: a failed or thrown receipts read never
        // blocks the alerts, announcements or notes from showing.
        seesReceipts ? fetchReceipts(c.venueId, ctrl.signal).catch(() => null) : Promise.resolve(null),
      ]);
      if (isStale(k)) return;
      // The sheet is for THIS venue: agency-wide items plus this venue's.
      setAnnouncements(anns.filter((a) => !a.venueId || a.venueId === c.venueId));
      setNotes(nts);
      setAlerts(alts);
      if (recs) setReceipts(recs);
    } catch {
      /* keep whatever is already on screen */
    } finally {
      if (!isStale(k)) setListsLoading(false);
    }
  }, [isStale, seesReceipts]);

  // Context generation changed (or first mount): clear everything from the
  // previous context, close the sheet, and count fresh for the new one. The
  // alert draft and its in-memory media die here too (A6: context change is
  // one of only three ways a draft ends).
  useEffect(() => {
    setUnread(EMPTY_UNREAD);
    setAnnouncements([]);
    setNotes([]);
    setAlerts([]);
    setReceipts(null);
    setMutedUntilState(null);
    setAlertDraftState(emptyDraft());
    setAlertMediaState({});
    setDraftGen((g) => g + 1);
    setSheetOpenState(false);
    setHighlightId(null);
    abortRef.current?.abort();
    if (ctx && !ctx.kiosk) {
      void refreshUnread();
      // Warm the lists: the alert banner needs the open alerts, and the
      // sheet opens instantly. The kiosk never loads alerts.
      void loadLists();
      void fetchAlertMute().then((u) => {
        if (u !== undefined && keyRef.current === ctxKey) setMutedUntilState(u);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  // WebSocket = refetch signal only, and only for this context's venue.
  useEffect(() => {
    if (!ctx) return;
    const subscribedKey = updatesCtxKey(ctx);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsub = realtimeSocket.onMessage((msg: any) => {
      if (keyRef.current !== subscribedKey) return;
      const t = msg?.type;
      if (
        t !== 'ANNOUNCEMENT' && t !== 'ANNOUNCEMENT_DELETED' &&
        t !== 'HANDOFF_NOTE' && t !== 'HANDOFF_NOTE_DELETED' &&
        t !== 'INCIDENT_CREATED' && t !== 'INCIDENT_UPDATED'
      ) return;
      const p = msg.payload || {};
      const item = p.announcement || p.note || p.incident || p;
      const vId = item?.venueId;
      const agency = item?.agencyId;
      if (agency && agency !== ctx.agencyId) return;
      if (vId && vId !== ctx.venueId) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void refreshUnread();
        if (sheetOpenRef.current) void loadLists();
      }, 400);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      unsub();
    };
  }, [ctx, refreshUnread, loadLists]);

  const setSheetOpen = useCallback(
    (open: boolean, tab?: UpdatesTab, highlight?: string | null) => {
      if (tab) setActiveTab(tab);
      if (highlight !== undefined) setHighlightId(highlight);
      setSheetOpenState(open);
      if (open) {
        void loadLists();
        void refreshUnread();
      }
    },
    [loadLists, refreshUnread],
  );

  // An item became visible on screen: record the mark (queued with its
  // original context) and drop it from the local unread sets at once; the
  // next unread refresh confirms the server's numbers.
  const markVisible = useCallback(
    (kind: MarkKind, id: string) => {
      const c = ctxRef.current;
      if (!c || c.kiosk) return;
      seenQueue.enqueue(c, kind, id);
      setUnread((u) => {
        if (kind === 'a') {
          if (!u.unreadAnnouncementIds.includes(id)) return u;
          const ids = u.unreadAnnouncementIds.filter((x) => x !== id);
          return {
            ...u,
            announcements: ids.length,
            unreadAnnouncementIds: ids,
            urgent: u.urgent.filter((x) => x.id !== id),
          };
        }
        if (kind === 'i') {
          if (!u.unreadAlertIds.includes(id)) return u;
          const ids = u.unreadAlertIds.filter((x) => x !== id);
          return { ...u, alerts: ids.length, unreadAlertIds: ids };
        }
        if (!u.unreadNoteIds.includes(id)) return u;
        const ids = u.unreadNoteIds.filter((x) => x !== id);
        return { ...u, notes: ids.length, unreadNoteIds: ids };
      });
    },
    [],
  );

  // Draft controls (A6). A confirmed send and an explicit Discard are the
  // only in-context ways a draft ends; both bump the generation so a late
  // async result (photo processing, a recording) is dropped, never attached.
  const setAlertDraft = useCallback((patch: Partial<AlertDraft>) => {
    setAlertDraftState((d) => ({ ...d, ...patch }));
  }, []);
  // Accepts a value or an updater: async steps (recorder, photo shrink) merge
  // into the CURRENT media, so a photo picked during a recording is kept.
  const setAlertMedia = useCallback((m: { photoData?: string; voiceNoteData?: string } | ((prev: { photoData?: string; voiceNoteData?: string }) => { photoData?: string; voiceNoteData?: string })) => {
    setAlertMediaState(m);
  }, []);
  const clearAlertDraft = useCallback(() => {
    setAlertDraftState(emptyDraft());
    setAlertMediaState({});
    setDraftGen((g) => g + 1);
  }, []);

  const setMutedUntil = useCallback((u: string | null) => setMutedUntilState(u), []);

  const dismissUrgent = useCallback(
    (id: string) => markVisible('a', id),
    [markVisible],
  );

  const bellCount = useMemo(
    () => (ctx?.kiosk ? null : unread.announcements + unread.notes + unread.alerts),
    [ctx?.kiosk, unread],
  );
  const topUrgent = !ctx?.kiosk && unread.urgent.length > 0 ? unread.urgent[0] : null;
  // 5b (C4): the newest open High/Critical alert routed to me that I have
  // not seen yet gets the red banner until it is seen. The unread id set is
  // recipient-only (server A2), so a banner here is always mine to see.
  const topAlert = useMemo(() => {
    if (!ctx || ctx.kiosk) return null;
    const unreadSet = new Set(unread.unreadAlertIds);
    const hit = alerts.find(
      (a) => a.status === 'open' && (a.severity === 'high' || a.severity === 'critical') && unreadSet.has(a.id),
    );
    return hit ? { id: hit.id, title: hit.title, createdAt: hit.createdAt } : null;
  }, [ctx, alerts, unread]);

  const dismissAlertBanner = useCallback((id: string) => markVisible('i', id), [markVisible]);

  return {
    unread,
    bellCount,
    topUrgent,
    topAlert,
    announcements,
    notes,
    alerts,
    receipts,
    seesReceipts,
    mutedUntil,
    setMutedUntil,
    alertDraft,
    alertMedia,
    draftGen,
    setAlertDraft,
    setAlertMedia,
    clearAlertDraft,
    listsLoading,
    sheetOpen,
    setSheetOpen,
    activeTab,
    setActiveTab,
    highlightId,
    refreshUnread,
    loadLists,
    markVisible,
    dismissUrgent,
    dismissAlertBanner,
  };
}

export type UpdatesCenter = ReturnType<typeof useUpdatesCenter>;
