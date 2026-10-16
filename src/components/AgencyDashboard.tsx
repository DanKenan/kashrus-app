import React, { useState, useEffect } from 'react';
import { Building2, CheckCircle2, AlertTriangle, MessageSquare, X, Phone, User } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface VenueStat {
  venue: { id: string; name: string; category?: string };
  totalTasks: number;
  completedTasks: number;
  completionRate: number;
  overdueTasks: number;
  overdueTaskList: Array<{ id: string; title: string; targetTime?: string }>;
  recentNotes: Array<{
    id: string;
    authorName: string;
    content: string;
    shift: string;
    createdAt: string;
  }>;
  mashgichim: Array<{ email: string; name: string; phone: string; role: string }>;
  openIncidents: Array<{
    id: string;
    title: string;
    severity: string;
    reporterName: string;
    createdAt: string;
  }>;
}

interface DashboardData {
  venues: VenueStat[];
  totals: {
    venueCount: number;
    totalTasks: number;
    completedTasks: number;
    totalHandoffNotes: number;
  };
}

interface AgencyDashboardProps {
  onClose: () => void;
  onSelectVenue: (venueId: string) => void;
}

export function AgencyDashboard({ onClose, onSelectVenue }: AgencyDashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const res = await apiFetch('/api/admin/dashboard');
      const d = await res.json();
      setData(d);
    } catch (e) {
      console.error('Failed to load dashboard:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-8">
          <div className="text-sm">Loading dashboard...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-zinc-900 border-b border-line p-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Agency Dashboard</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-sunken transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Totals */}
          {data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-sunken text-center">
                <div className="text-2xl font-bold">{data.totals.venueCount}</div>
                <div className="text-[11px] text-ink-faint">Venues</div>
              </div>
              <div className="p-3 rounded-xl bg-sunken text-center">
                <div className="text-2xl font-bold">{data.totals.totalTasks}</div>
                <div className="text-[11px] text-ink-faint">Total Tasks</div>
              </div>
              <div className="p-3 rounded-xl bg-sunken text-center">
                <div className="text-2xl font-bold text-emerald-600">
                  {data.totals.completedTasks}
                </div>
                <div className="text-[11px] text-ink-faint">Completed</div>
              </div>
              <div className="p-3 rounded-xl bg-sunken text-center">
                <div className="text-2xl font-bold text-gold-deep">
                  {data.totals.totalHandoffNotes}
                </div>
                <div className="text-[11px] text-ink-faint">Handoff Notes</div>
              </div>
            </div>
          )}

          {/* Venue cards */}
          <div className="space-y-3">
            {data?.venues.map((vs) => (
              <button
                key={vs.venue.id}
                onClick={() => { onSelectVenue(vs.venue.id); onClose(); }}
                className="w-full text-left p-4 rounded-xl border border-line hover:border-gold/40 hover:shadow-sm transition cursor-pointer bg-white dark:bg-black"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Building2 className="w-5 h-5 text-gold-deep shrink-0" />
                    <div>
                      <div className="font-bold text-sm">{vs.venue.name}</div>
                      {vs.venue.category && (
                        <div className="text-[11px] text-ink-faint">{vs.venue.category}</div>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold">{vs.completionRate}%</div>
                    <div className="text-[10px] text-ink-faint">
                      {vs.completedTasks}/{vs.totalTasks} done
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mt-2 h-1.5 rounded-full bg-sunken overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${vs.completionRate}%` }}
                  />
                </div>

                {/* Alerts */}
                <div className="mt-2 flex items-center gap-3 text-[11px]">
                  {vs.overdueTasks > 0 && (
                    <span className="flex items-center gap-1 text-rose-600 font-semibold">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {vs.overdueTasks} overdue
                    </span>
                  )}
                  {vs.recentNotes.length > 0 && (
                    <span className="flex items-center gap-1 text-ink-faint">
                      <MessageSquare className="w-3.5 h-3.5" />
                      {vs.recentNotes.length} recent note{vs.recentNotes.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {vs.overdueTasks === 0 && vs.recentNotes.length === 0 && (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      All clear
                    </span>
                  )}
                </div>

                {/* Recent notes preview */}
                {vs.recentNotes.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60">
                    <div className="text-[11px] text-ink-faint line-clamp-2">
                      <span className="font-semibold">{vs.recentNotes[0].authorName}:</span>{' '}
                      {vs.recentNotes[0].content}
                    </div>
                  </div>
                )}

                {/* Open incidents */}
                {vs.openIncidents.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60 space-y-1">
                    {vs.openIncidents.slice(0, 2).map((inc) => (
                      <div key={inc.id} className="flex items-center gap-1.5 text-[11px]">
                        <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${inc.severity === 'critical' ? 'text-rose-600' : inc.severity === 'high' ? 'text-orange-500' : 'text-gold-deep'}`} />
                        <span className="font-semibold truncate">{inc.title}</span>
                        <span className="text-ink-faint shrink-0">({inc.severity})</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mashgichim — tap to call */}
                {vs.mashgichim.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {vs.mashgichim.map((m) => (
                      m.phone ? (
                        <a
                          key={m.email}
                          href={`tel:${m.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gold/10 hover:bg-gold/20 text-[11px] font-semibold text-gold-deep transition"
                        >
                          <Phone className="w-3 h-3" />
                          {m.name}
                        </a>
                      ) : (
                        <span key={m.email} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sunken text-[11px] text-ink-faint">
                          <User className="w-3 h-3" />
                          {m.name}
                        </span>
                      )
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>

          {data?.venues.length === 0 && (
            <div className="text-center py-8 text-sm text-ink-faint">
              No venues yet. Create your first venue to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
