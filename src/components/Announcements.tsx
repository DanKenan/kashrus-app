import React, { useState, useEffect } from 'react';
import { Megaphone, Plus, X, Trash2, ClipboardList, Bell, AlertTriangle, Info } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface Announcement {
  id: string;
  authorName: string;
  title: string;
  body: string;
  category: 'assignment' | 'update' | 'notice' | 'urgent';
  targetRoles: string[];
  createdAt: string;
}

interface AnnouncementsProps {
  currentUserEmail: string;
  currentUserName: string;
  currentUserRole: string;
  onClose: () => void;
}

const CATEGORY_CONFIG = {
  assignment: { icon: ClipboardList, label: 'Assignment', color: 'text-blue-600 bg-blue-50 dark:bg-blue-950/40 border-blue-200' },
  update: { icon: Info, label: 'Update', color: 'text-gold-deep bg-gold/10 border-gold/30' },
  notice: { icon: Bell, label: 'Notice', color: 'text-purple-600 bg-purple-50 dark:bg-purple-950/40 border-purple-200' },
  urgent: { icon: AlertTriangle, label: 'Urgent', color: 'text-rose-600 bg-rose-50 dark:bg-rose-950/40 border-rose-200' },
};

const ROLE_LABELS: Record<string, string> = {
  all: 'Everyone',
  admin: 'Admins',
  coordinator: 'Coordinators',
  owner: 'Owners',
  mashgiach: 'Mashgichim',
  worker: 'Workers',
};

export function Announcements({ currentUserEmail, currentUserName, currentUserRole, onClose }: AnnouncementsProps) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Announcement['category']>('update');
  const [targetRoles, setTargetRoles] = useState<string[]>(['all']);

  const canPost = ['admin', 'coordinator'].includes(currentUserRole);

  useEffect(() => { load(); }, []);

  const load = async () => {
    try {
      const res = await apiFetch(`/api/announcements?userEmail=${encodeURIComponent(currentUserEmail)}`);
      const d = await res.json();
      setAnnouncements(d.announcements || []);
    } catch (e) {
      console.error('Failed to load announcements:', e);
    } finally {
      setLoading(false);
    }
  };

  const post = async () => {
    if (!title.trim()) return;
    try {
      const res = await apiFetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          category,
          targetRoles,
          authorEmail: currentUserEmail,
          authorName: currentUserName,
        }),
      });
      const d = await res.json();
      if (d.announcement) {
        setAnnouncements([d.announcement, ...announcements]);
        setTitle(''); setBody(''); setCategory('update'); setTargetRoles(['all']);
        setShowCompose(false);
      }
    } catch (e) {
      console.error('Failed to post:', e);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/api/announcements/${id}`, { method: 'DELETE' });
      setAnnouncements(announcements.filter((a) => a.id !== id));
    } catch (e) {
      console.error('Failed to delete:', e);
    }
  };

  const toggleRole = (role: string) => {
    if (role === 'all') {
      setTargetRoles(['all']);
    } else {
      const without = targetRoles.filter((r) => r !== 'all');
      setTargetRoles(
        without.includes(role) ? without.filter((r) => r !== role) : [...without, role]
      );
    }
  };

  const filtered = filter === 'all'
    ? announcements
    : announcements.filter((a) => a.category === filter);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-zinc-900 border-b border-line p-4 flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-gold-deep" />
            Team Broadcasts
          </h2>
          <div className="flex items-center gap-2">
            {canPost && (
              <button
                onClick={() => setShowCompose(!showCompose)}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold rounded-lg bg-gold/10 hover:bg-gold/20 text-gold-deep transition cursor-pointer"
              >
                {showCompose ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {showCompose ? 'Cancel' : 'New'}
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-sunken transition cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[11px] text-ink-faint">
            One-way updates for the team — assignments, notices, important info. Not a chat.
          </p>

          {/* Category filter */}
          <div className="flex gap-1.5 flex-wrap">
            {['all', 'assignment', 'update', 'notice', 'urgent'].map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`px-2.5 py-1 text-[11px] font-bold rounded-full border transition cursor-pointer capitalize ${
                  filter === c
                    ? 'bg-ink text-white border-ink'
                    : 'border-line text-ink-faint hover:border-ink/30'
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          {showCompose && canPost && (
            <div className="p-3 rounded-xl border border-line bg-sunken space-y-2.5">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Headline (e.g. New delivery procedure starting Monday)"
                className="w-full px-3 py-2 text-xs rounded-lg bg-white dark:bg-black border border-line"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Details..."
                className="w-full px-3 py-2 text-xs rounded-lg bg-white dark:bg-black border border-line min-h-[70px]"
              />
              <div className="grid grid-cols-4 gap-1.5">
                {(Object.keys(CATEGORY_CONFIG) as Array<keyof typeof CATEGORY_CONFIG>).map((c) => {
                  const cfg = CATEGORY_CONFIG[c];
                  return (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      className={`py-1.5 text-[11px] font-bold rounded-lg border transition cursor-pointer capitalize ${
                        category === c ? cfg.color + ' border-current ring-1' : 'border-line opacity-60'
                      }`}
                    >
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
              <div>
                <div className="text-[11px] font-bold mb-1">Send to:</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(ROLE_LABELS).map((r) => (
                    <button
                      key={r}
                      onClick={() => toggleRole(r)}
                      className={`px-2 py-1 text-[11px] font-semibold rounded-full border transition cursor-pointer ${
                        targetRoles.includes(r)
                          ? 'bg-gold/15 border-gold/50 text-gold-deep'
                          : 'border-line text-ink-faint'
                      }`}
                    >
                      {ROLE_LABELS[r]}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={post}
                disabled={!title.trim()}
                className="w-full py-2 rounded-xl bg-gold text-white text-xs font-bold disabled:opacity-50 transition cursor-pointer"
              >
                Broadcast
              </button>
            </div>
          )}

          {loading ? (
            <div className="text-xs text-ink-faint text-center py-6">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-xs text-ink-faint text-center py-6">
              No broadcasts yet.
            </div>
          ) : (
            <div className="space-y-2.5">
              {filtered.map((a) => {
                const cfg = CATEGORY_CONFIG[a.category];
                const Icon = cfg.icon;
                return (
                  <div key={a.id} className={`p-3 rounded-xl border ${cfg.color}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Icon className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-black uppercase tracking-wide">{cfg.label}</span>
                        <span className="text-[10px] text-ink-faint">
                          → {a.targetRoles.map((r) => ROLE_LABELS[r] || r).join(', ')}
                        </span>
                      </div>
                      {canPost && (
                        <button
                          onClick={() => remove(a.id)}
                          className="p-1 rounded hover:bg-black/5 text-ink-faint transition cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="text-sm font-bold">{a.title}</div>
                    {a.body && <p className="text-xs mt-1 whitespace-pre-wrap opacity-90">{a.body}</p>}
                    <div className="text-[10px] opacity-60 mt-1.5">
                      {a.authorName} · {new Date(a.createdAt).toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
