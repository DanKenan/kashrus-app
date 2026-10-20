import React, { useEffect, useRef, useState } from 'react';
import { Megaphone, Plus, X, Trash2, ClipboardList, Bell, AlertTriangle, Info, Check } from 'lucide-react';
import { apiWrite } from '../lib/api';
import { AnnouncementItem, useVisibleMarks } from '../lib/updates';

// 5a — Announcements as the Updates sheet's first tab body (was an
// unrendered modal). Compose sits at the top for admin/coordinator only;
// the coordinator posts to the sheet's current venue, the admin agency-wide
// (today's behaviour). Unread items (not mine, server says unread) carry a
// dot, a "New" pill and bold type — never colour alone — and are marked
// read after a full second at ≥60% visible.

export const ANNOUNCEMENT_CATEGORIES = {
  update: { icon: Info, label: 'Update' },
  notice: { icon: Bell, label: 'Notice' },
  assignment: { icon: ClipboardList, label: 'Assignment' },
  urgent: { icon: AlertTriangle, label: 'Urgent' },
} as const;

export const ROLE_LABELS: Record<string, string> = {
  all: 'Everyone',
  admin: 'Admins',
  coordinator: 'Coordinators',
  owner: 'Owners',
  mashgiach: 'Mashgiach team',
  worker: 'Workers',
};

interface AnnouncementsProps {
  items: AnnouncementItem[];
  loading: boolean;
  readOnly: boolean;
  canPost: boolean;
  canDelete: (item: AnnouncementItem) => boolean;
  unreadIds: Set<string>;
  currentUserEmail: string;
  currentUserName: string;
  currentUserRole: string;
  /** The sheet's venue — a coordinator's post lands here. */
  venueId: string;
  active: boolean;
  highlightId?: string | null;
  onMark: (kind: 'a' | 'n', id: string) => void;
  onPosted: (item: AnnouncementItem) => void;
  onDeleted: (id: string) => void;
}

export function Announcements({
  items,
  loading,
  readOnly,
  canPost,
  canDelete,
  unreadIds,
  currentUserEmail,
  currentUserRole,
  venueId,
  active,
  highlightId,
  onMark,
  onPosted,
  onDeleted,
}: AnnouncementsProps) {
  const [showCompose, setShowCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<AnnouncementItem['category']>('update');
  const [targetRoles, setTargetRoles] = useState<string[]>(['all']);
  const [posting, setPosting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const idsKey = items.map((a) => a.id).join(',');
  useVisibleMarks(listRef, active && !readOnly, idsKey, onMark);

  // "View" from the urgent banner: scroll the item into view and flash it.
  useEffect(() => {
    if (!highlightId) return;
    const el = listRef.current?.querySelector(`[data-ann-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setFlashId(highlightId);
    const t = setTimeout(() => setFlashId(null), 2400);
    return () => clearTimeout(t);
  }, [highlightId, idsKey]);

  const toggleRole = (role: string) => {
    if (role === 'all') return setTargetRoles(['all']);
    const without = targetRoles.filter((r) => r !== 'all');
    setTargetRoles(without.includes(role) ? without.filter((r) => r !== role) : [...without, role]);
  };

  const post = async () => {
    if (!title.trim() || posting) return;
    setPosting(true);
    setErrorMsg(null);
    const result = await apiWrite('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        body: body.trim(),
        category,
        targetRoles: targetRoles.length > 0 ? targetRoles : ['all'],
        // RULE T: coordinators post to their own venue (the sheet's venue);
        // the server 403s anything else. Admins post agency-wide.
        ...(currentUserRole === 'coordinator' ? { venueId } : {}),
      }),
    });
    setPosting(false);
    if (!result.ok) {
      setErrorMsg(result.error || 'Could not post the announcement.');
      return;
    }
    if (result.data?.announcement) onPosted(result.data.announcement);
    setTitle(''); setBody(''); setCategory('update'); setTargetRoles(['all']);
    setShowCompose(false);
  };

  const remove = async (id: string) => {
    setErrorMsg(null);
    const result = await apiWrite(`/api/announcements/${id}`, { method: 'DELETE' });
    if (!result.ok) {
      setErrorMsg(result.error || 'Could not delete the announcement.');
      return;
    }
    onDeleted(id);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div ref={listRef} className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
        {canPost && !readOnly && (
          <button
            type="button"
            onClick={() => setShowCompose((s) => !s)}
            className="pressable w-full h-12 rounded-xl bg-gold text-white text-base font-bold flex items-center justify-center gap-2 cursor-pointer"
          >
            {showCompose ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
            {showCompose ? 'Cancel' : 'New announcement'}
          </button>
        )}

        {showCompose && canPost && !readOnly && (
          <div className="p-3 rounded-xl border border-line bg-sunken space-y-3">
            {errorMsg && (
              <p className="p-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }}>
                {errorMsg}
              </p>
            )}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Headline"
              aria-label="Announcement headline"
              className="w-full px-3 h-12 text-base rounded-lg bg-surface border border-line"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Details…"
              aria-label="Announcement details"
              className="w-full px-3 py-2.5 text-base rounded-lg bg-surface border border-line min-h-20"
            />
            <div>
              <div className="text-xs font-bold text-ink-soft mb-1.5">Kind</div>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(ANNOUNCEMENT_CATEGORIES) as Array<keyof typeof ANNOUNCEMENT_CATEGORIES>).map((c) => {
                  const cfg = ANNOUNCEMENT_CATEGORIES[c];
                  const Icon = cfg.icon;
                  const selected = category === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={`pressable flex items-center gap-1.5 px-3 h-11 rounded-full border text-sm font-bold transition cursor-pointer ${
                        selected ? 'bg-ink text-paper border-ink' : 'border-line text-ink-soft'
                      }`}
                      style={selected && c === 'urgent' ? { backgroundColor: 'var(--bad)', borderColor: 'var(--bad)' } : undefined}
                    >
                      <Icon className="w-4 h-4" />
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-xs font-bold text-ink-soft mb-1.5">Send to</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.keys(ROLE_LABELS).map((r) => {
                  const selected = targetRoles.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => toggleRole(r)}
                      className={`pressable flex items-center gap-1 px-3 h-11 rounded-full border text-sm font-semibold transition cursor-pointer ${
                        selected ? 'bg-gold-wash border-gold text-gold-ink' : 'border-line text-ink-soft'
                      }`}
                    >
                      {selected && <Check className="w-4 h-4" />}
                      {ROLE_LABELS[r]}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              onClick={post}
              disabled={!title.trim() || posting}
              className="pressable w-full h-12 rounded-xl bg-ink text-paper text-base font-bold disabled:opacity-50 transition cursor-pointer"
            >
              {posting ? 'Posting…' : 'Post announcement'}
            </button>
          </div>
        )}

        {!showCompose && errorMsg && (
          <p className="p-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }}>
            {errorMsg}
          </p>
        )}

        {loading ? (
          <div className="space-y-3" aria-label="Loading announcements">
            {[0, 1, 2].map((i) => (
              <div key={i} className="p-3 rounded-xl border border-line">
                <div className="h-4 w-1/3 rounded bg-sunken mb-2" />
                <div className="h-4 w-full rounded bg-sunken mb-1.5" />
                <div className="h-4 w-2/3 rounded bg-sunken" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10">
            <Megaphone className="w-8 h-8 text-ink-faint mx-auto mb-2" />
            <p className="text-base text-ink-soft">No announcements yet.</p>
            <p className="text-sm text-ink-faint mt-1">Updates for the whole team will show up here.</p>
          </div>
        ) : (
          items.map((a) => {
            const cfg = ANNOUNCEMENT_CATEGORIES[a.category] || ANNOUNCEMENT_CATEGORIES.update;
            const Icon = cfg.icon;
            const mine = a.authorEmail === currentUserEmail;
            const unread = !mine && unreadIds.has(a.id);
            const urgent = a.category === 'urgent';
            return (
              <article
                key={a.id}
                data-ann-id={a.id}
                {...(unread ? { 'data-mark-kind': 'a', 'data-mark-id': a.id } : {})}
                className={`p-3 rounded-xl border bg-surface ${flashId === a.id ? 'ring-2 ring-gold' : 'border-line'}`}
                style={urgent ? { borderColor: 'var(--bad)' } : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
                      style={
                        urgent
                          ? { backgroundColor: 'var(--bad-bg)', color: 'var(--bad)' }
                          : { backgroundColor: 'var(--gold-wash)', color: 'var(--gold-ink)' }
                      }
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {cfg.label}
                    </span>
                    <span className="text-xs text-ink-faint">
                      for {a.targetRoles.map((r) => ROLE_LABELS[r] || r).join(', ')}
                    </span>
                    {unread && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-gold-deep">
                        <span className="w-2 h-2 rounded-full bg-gold" />
                        New
                      </span>
                    )}
                  </div>
                  {!readOnly && canDelete(a) && (
                    <button
                      type="button"
                      onClick={() => remove(a.id)}
                      aria-label={`Delete announcement: ${a.title}`}
                      className="pressable w-11 h-11 -mt-2 -mr-2 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink transition cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <h3 dir="auto" className={`text-base mt-1.5 ${unread ? 'font-extrabold' : 'font-bold'}`}>{a.title}</h3>
                {a.body && <p dir="auto" className="text-base mt-1 whitespace-pre-wrap text-ink-soft">{a.body}</p>}
                <p className="text-xs text-ink-faint mt-2">
                  {a.authorName} · {new Date(a.createdAt).toLocaleString()}
                </p>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
