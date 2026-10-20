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
  UnreadState,
  UpdatesContext,
  fetchAnnouncements,
  fetchNotes,
  fetchUnread,
  seenQueue,
} from '../lib/updates';

export type UpdatesTab = 'announcements' | 'notes';

const EMPTY_UNREAD: UnreadState = {
  announcements: 0,
  notes: 0,
  urgent: [],
  unreadAnnouncementIds: [],
  unreadNoteIds: [],
};

export function useUpdatesCenter(ctx: UpdatesContext | null) {
  const [unread, setUnread] = useState<UnreadState>(EMPTY_UNREAD);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [notes, setNotes] = useState<HandoffNoteItem[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [sheetOpen, setSheetOpenState] = useState(false);
  const [activeTab, setActiveTab] = useState<UpdatesTab>('announcements');
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const abortRef = useRef<AbortController | null>(null);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheetOpen;

  // The seen queue attributes marks by session identity — tell it who is
  // signed in right now so a stale batch is dropped, never re-attributed.
  useEffect(() => {
    seenQueue.setIdentityProvider(() => ctxRef.current?.userId ?? null);
  }, []);

  const isStale = useCallback((gen: number) => ctxRef.current?.gen !== gen, []);

  const refreshUnread = useCallback(async () => {
    const c = ctxRef.current;
    if (!c || c.kiosk) return; // the kiosk shows no count and never fetches one
    const ctrl = new AbortController();
    try {
      const u = await fetchUnread(c.venueId, ctrl.signal);
      if (!u || isStale(c.gen)) return;
      setUnread(u);
    } catch {
      /* a failed count refresh keeps the last honest numbers */
    }
  }, [isStale]);

  const loadLists = useCallback(async () => {
    const c = ctxRef.current;
    if (!c) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setListsLoading(true);
    try {
      const [anns, nts] = await Promise.all([
        fetchAnnouncements(ctrl.signal),
        fetchNotes(c.venueId, ctrl.signal),
      ]);
      if (isStale(c.gen)) return;
      // The sheet is for THIS venue: agency-wide items plus this venue's.
      setAnnouncements(anns.filter((a) => !a.venueId || a.venueId === c.venueId));
      setNotes(nts);
    } catch {
      /* keep whatever is already on screen */
    } finally {
      if (!isStale(c.gen)) setListsLoading(false);
    }
  }, [isStale]);

  // Context generation changed (or first mount): clear everything from the
  // previous context, close the sheet, and count fresh for the new one.
  useEffect(() => {
    setUnread(EMPTY_UNREAD);
    setAnnouncements([]);
    setNotes([]);
    setSheetOpenState(false);
    setHighlightId(null);
    abortRef.current?.abort();
    if (ctx && !ctx.kiosk) void refreshUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.gen]);

  // WebSocket = refetch signal only, and only for this context's venue.
  useEffect(() => {
    if (!ctx) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsub = realtimeSocket.onMessage((msg: any) => {
      const t = msg?.type;
      if (
        t !== 'ANNOUNCEMENT' && t !== 'ANNOUNCEMENT_DELETED' &&
        t !== 'HANDOFF_NOTE' && t !== 'HANDOFF_NOTE_DELETED'
      ) return;
      const p = msg.payload || {};
      const item = p.announcement || p.note || p;
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
    (kind: 'a' | 'n', id: string) => {
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
        if (!u.unreadNoteIds.includes(id)) return u;
        const ids = u.unreadNoteIds.filter((x) => x !== id);
        return { ...u, notes: ids.length, unreadNoteIds: ids };
      });
    },
    [],
  );

  const dismissUrgent = useCallback(
    (id: string) => markVisible('a', id),
    [markVisible],
  );

  const bellCount = useMemo(
    () => (ctx?.kiosk ? null : unread.announcements + unread.notes),
    [ctx?.kiosk, unread],
  );
  const topUrgent = !ctx?.kiosk && unread.urgent.length > 0 ? unread.urgent[0] : null;

  return {
    unread,
    bellCount,
    topUrgent,
    announcements,
    notes,
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
  };
}

export type UpdatesCenter = ReturnType<typeof useUpdatesCenter>;
