// 5a — Updates panel data layer: unread counts, list fetches, and the
// server-recorded read marks (POST /api/updates/seen).
//
// Read marks are NOT versioned writes: /api/updates/seen never touches the
// app-state document, so it uses plain apiFetch — no expectedVersion, no
// apiWrite. Marks are batched (~2 s) per context. A pending batch keeps its
// ORIGINAL context {userId, agencyId, venueId, gen} (plan C5): it is sent
// with its original venueId, retried on failure, and dropped only when the
// signed-in user has changed (marks belong to the person who saw the items;
// the server derives identity from the session, so sending another user's
// batch under a new session would record the wrong person's reads).
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { apiFetch } from './api';

export interface AnnouncementItem {
  id: string;
  agencyId?: string;
  venueId?: string;
  authorEmail: string;
  authorName: string;
  title: string;
  body: string;
  category: 'assignment' | 'update' | 'notice' | 'urgent';
  targetRoles: string[];
  createdAt: string;
  expiresAt?: string;
}

export interface HandoffNoteItem {
  id: string;
  agencyId?: string;
  venueId: string;
  authorId?: string;
  authorEmail: string;
  authorName: string;
  content: string;
  shift: string;
  voiceNoteData?: string;
  createdAt: string;
  /** TEAMNOTES: tagged people (ids + names), @All, and the private option. */
  mentions?: { id: string; name: string }[];
  mentionAll?: boolean;
  private?: boolean;
  replyTo?: { id: string; authorId?: string; authorName: string; text?: string; deleted?: boolean };
  threadId?: string;
  members?: { id: string; name: string }[];
  deleted?: true;
  deletedAt?: string;
}

/** TEAMNOTES: seen-by for shift notes (any venue team member may look). */
export interface NoteSeenCount { id: string; seen: number; total: number }
export interface NoteSeenList {
  id: string;
  seen: { name: string; role: string; at: string }[];
  notYet: { name: string; role: string }[];
  total: number;
}

export interface UnreadState {
  announcements: number;
  notes: number;
  urgent: { id: string; title: string; createdAt: string }[];
  unreadAnnouncementIds: string[];
  unreadNoteIds: string[];
  // 5b: alerts at this venue that are not mine, not resolved and not marked.
  alerts: number;
  unreadAlertIds: string[];
}

/** 5b: read-mark kinds — announcement, shift note, alert. */
export type MarkKind = 'a' | 'n' | 'i';

export interface UpdatesContext {
  userId: string;
  email: string;
  name: string;
  role: string;
  agencyId: string;
  venueId: string;
  kiosk: boolean;
  gen: number;
}

/** The full context identity — stale checks compare ALL of it, not gen alone. */
export function updatesCtxKey(ctx: UpdatesContext): string {
  return `${ctx.userId}|${ctx.agencyId}|${ctx.venueId}|${ctx.kiosk ? 'kiosk' : 'app'}|${ctx.gen}`;
}

export async function fetchUnread(venueId: string, signal?: AbortSignal): Promise<UnreadState | null> {
  const res = await apiFetch(`/api/updates/unread?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return null;
  const d = await res.json();
  return {
    announcements: d.announcements || 0,
    notes: d.notes || 0,
    urgent: Array.isArray(d.urgent) ? d.urgent : [],
    unreadAnnouncementIds: Array.isArray(d.unreadAnnouncementIds) ? d.unreadAnnouncementIds : [],
    unreadNoteIds: Array.isArray(d.unreadNoteIds) ? d.unreadNoteIds : [],
    alerts: d.alerts || 0,
    unreadAlertIds: Array.isArray(d.unreadAlertIds) ? d.unreadAlertIds : [],
  };
}

export async function fetchAnnouncements(signal?: AbortSignal): Promise<AnnouncementItem[]> {
  const res = await apiFetch('/api/announcements', { signal });
  if (!res.ok) return [];
  const d = await res.json();
  return Array.isArray(d.announcements) ? d.announcements : [];
}

export async function fetchNotes(venueId: string, signal?: AbortSignal): Promise<HandoffNoteItem[]> {
  return (await fetchNotesWithMeta(venueId, signal)).notes;
}

/** TEAMNOTES2: the notes plus, on a kiosk only, how many private notes are
 * tagged to the person signed in on the tablet and still unread (a number
 * only; null = not a kiosk answer, or the server could not count). */
export async function fetchNotesWithMeta(venueId: string, signal?: AbortSignal): Promise<{ notes: HandoffNoteItem[]; privateForYou: number | null }> {
  const res = await apiFetch(`/api/handoff-notes?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return { notes: [], privateForYou: null };
  const d = await res.json();
  return {
    notes: Array.isArray(d.notes) ? d.notes : [],
    privateForYou: Number.isInteger(d.privateForYou) && d.privateForYou >= 0 ? d.privateForYou : null,
  };
}

/** TEAMNOTES: the people the caller can tag at this venue (names + roles). */
/** null = could not load (the picker offers a retry). */
export async function fetchNoteTeam(venueId: string, signal?: AbortSignal): Promise<{ id: string; name: string; role: string }[] | null> {
  const res = await apiFetch(`/api/handoff-notes/team?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return null;
  const d = await res.json();
  return Array.isArray(d.team) ? d.team : [];
}

export async function fetchNoteSeenCounts(venueId: string, signal?: AbortSignal): Promise<NoteSeenCount[] | null> {
  const res = await apiFetch(`/api/handoff-notes/seen?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return null;
  const d = await res.json();
  return Array.isArray(d.counts) ? d.counts : [];
}

export async function fetchNoteSeen(venueId: string, id: string, signal?: AbortSignal): Promise<NoteSeenList | null> {
  const res = await apiFetch(`/api/handoff-notes/${encodeURIComponent(id)}/seen?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return null;
  const d = await res.json();
  return { id: d.id, seen: Array.isArray(d.seen) ? d.seen : [], notYet: Array.isArray(d.notYet) ? d.notYet : [], total: d.total || 0 };
}

// ---------------------------------------------------------------------------
// Seen queue — one pending batch per context, flushed ~2 s after the first
// mark, retried (5 s) while the send keeps failing.
// ---------------------------------------------------------------------------
interface PendingBatch {
  ctx: UpdatesContext;
  ann: Set<string>;
  notes: Set<string>;
  alerts: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  failures: number;
  firstAt: number;
  reconciledAt: number;
}

class SeenQueue {
  private batches = new Map<string, PendingBatch>();
  private currentUserId: () => string | null = () => null;
  private reconcileHandler: ((ctxKey: string) => void) | null = null;

  setIdentityProvider(fn: () => string | null) {
    this.currentUserId = fn;
  }

  /** Called when a batch's marks may not have landed (see flush): the owner
   * refetches the server's unread numbers for that context if it is current. */
  setReconcileHandler(fn: (ctxKey: string) => void) {
    this.reconcileHandler = fn;
  }

  private key(ctx: UpdatesContext) {
    return updatesCtxKey(ctx);
  }

  enqueue(ctx: UpdatesContext, kind: MarkKind, id: string) {
    if (ctx.kiosk) return; // the kiosk never marks (read-only, server refuses too)
    const key = this.key(ctx);
    let b = this.batches.get(key);
    if (!b) {
      b = { ctx, ann: new Set(), notes: new Set(), alerts: new Set(), timer: null, sending: false, failures: 0, firstAt: Date.now(), reconciledAt: 0 };
      this.batches.set(key, b);
    }
    (kind === 'a' ? b.ann : kind === 'n' ? b.notes : b.alerts).add(id);
    this.schedule(b, 2000);
  }

  private schedule(b: PendingBatch, delay: number) {
    if (b.timer || b.sending) return;
    b.timer = setTimeout(() => {
      b.timer = null;
      void this.flush(b);
    }, delay);
  }

  private async flush(b: PendingBatch) {
    // Identity moved on (logout / user switch): these marks belong to a
    // person who is no longer signed in — drop them, never re-attribute.
    const me = this.currentUserId();
    if (!me || me !== b.ctx.userId) {
      this.batches.delete(this.key(b.ctx));
      return;
    }
    if (b.ann.size === 0 && b.notes.size === 0 && b.alerts.size === 0) {
      this.batches.delete(this.key(b.ctx));
      return;
    }
    b.sending = true;
    // Alerts first: they matter most if a batch ever hits the 200 cap.
    const alerts = [...b.alerts].slice(0, 200);
    const ann = [...b.ann].slice(0, Math.max(0, 200 - alerts.length));
    const notes = [...b.notes].slice(0, Math.max(0, 200 - alerts.length - ann.length));
    try {
      const res = await apiFetch('/api/updates/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueId: b.ctx.venueId, announcementIds: ann, noteIds: notes, alertIds: alerts }),
      });
      if (!res.ok) throw new Error(`seen ${res.status}`);
      ann.forEach((id) => b.ann.delete(id));
      notes.forEach((id) => b.notes.delete(id));
      alerts.forEach((id) => b.alerts.delete(id));
      b.failures = 0;
    } catch {
      // Stay pending in the same context and retry (plan C6).
      b.failures += 1;
    } finally {
      b.sending = false;
      if (b.ann.size > 0 || b.notes.size > 0 || b.alerts.size > 0) {
        // The badge went optimistic the moment the item was seen. If the
        // marks are not landing — two failed sends in a row, or anything
        // still pending ~10 s after it was marked — the owner refetches the
        // server's numbers so a locally-invented count never sticks.
        const stuck = b.failures >= 2 || Date.now() - b.firstAt > 10000;
        if (stuck && Date.now() - b.reconciledAt > 10000) {
          b.reconciledAt = Date.now();
          this.reconcileHandler?.(this.key(b.ctx));
        }
        this.schedule(b, 5000);
      } else {
        this.batches.delete(this.key(b.ctx));
      }
    }
  }
}

export const seenQueue = new SeenQueue();

// ---------------------------------------------------------------------------
// useVisibleMarks — IntersectionObserver read-marking for one list container.
// An item is marked after it has been ≥60% visible for one continuous second
// while the tab is active and the document is visible (plan C6). Elements opt
// in with data-mark-kind="a"|"n" and data-mark-id.
// ---------------------------------------------------------------------------
export function useVisibleMarks(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  depsKey: string,
  onMark: (kind: MarkKind, id: string) => void,
) {
  const markedRef = useRef(new Set<string>());
  const onMarkRef = useRef(onMark);
  onMarkRef.current = onMark;

  useEffect(() => {
    if (!active || !containerRef.current) return;
    const root = containerRef.current;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const clear = (key: string) => {
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.delete(key);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const kind = el.dataset.markKind as MarkKind | undefined;
          const id = el.dataset.markId;
          if (!kind || !id) continue;
          const key = `${kind}:${id}`;
          if (e.intersectionRatio >= 0.6) {
            if (markedRef.current.has(key) || timers.has(key)) continue;
            timers.set(
              key,
              setTimeout(() => {
                timers.delete(key);
                if (document.visibilityState !== 'visible') return;
                markedRef.current.add(key);
                onMarkRef.current(kind, id);
                observer.unobserve(el);
              }, 1000),
            );
          } else {
            clear(key);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    root.querySelectorAll('[data-mark-id]').forEach((el) => observer.observe(el));
    const onVis = () => {
      if (document.visibilityState !== 'visible') timers.forEach((_, k) => clear(k));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      observer.disconnect();
      timers.forEach((t) => clearTimeout(t));
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, depsKey]);
}

// Small helper for components: stable "mark this item" that also updates the
// caller's local unread set immediately (the badge refresh confirms it).
export function useMarkOnce() {
  const ref = useRef(new Set<string>());
  return useCallback((key: string) => {
    if (ref.current.has(key)) return false;
    ref.current.add(key);
    return true;
  }, []);
}
