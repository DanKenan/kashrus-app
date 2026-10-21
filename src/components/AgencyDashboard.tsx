import React, { useState, useEffect, useRef } from 'react';
import { Building2, CheckCircle2, AlertTriangle, MessageSquare, Phone, User } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { rosterKey } from '../lib/rosterDisplay';

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
  logo?: { agencyName: string; agencyShortCode: string; logoSrc: string | null; onOpen: () => void };
  reloadKey?: number;
  onSelectVenue: (venueId: string) => void;
}

export function AgencyDashboard({ onSelectVenue, reloadKey, logo }: AgencyDashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    const load = async () => {
      try {
        const res = await apiFetch('/api/admin/dashboard');
        if (!res.ok) throw new Error('Failed to load dashboard');
        const raw = await res.json();
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
        const array = <T,>(value: T[] | undefined): T[] => Array.isArray(value) ? value : [];
        const next: DashboardData = {
          totals: {
            venueCount: number(raw?.totals?.venueCount),
            totalTasks: number(raw?.totals?.totalTasks),
            completedTasks: number(raw?.totals?.completedTasks),
            totalHandoffNotes: number(raw?.totals?.totalHandoffNotes),
          },
          venues: array<VenueStat>(raw?.venues).map((vs) => ({
            ...vs,
            venue: vs.venue ?? { id: '', name: '' },
            totalTasks: number(vs.totalTasks),
            completedTasks: number(vs.completedTasks),
            completionRate: Math.min(100, Math.max(0, number(vs.completionRate))),
            overdueTasks: number(vs.overdueTasks),
            overdueTaskList: array(vs.overdueTaskList),
            recentNotes: array(vs.recentNotes),
            mashgichim: array(vs.mashgichim),
            openIncidents: array(vs.openIncidents),
          })),
        };
        if (generation.current === request) setData(next);
      } catch {
        if (generation.current === request) setFailed(true);
      } finally {
        if (generation.current === request) setLoading(false);
      }
    };
    void load();
    return () => { generation.current += 1; };
  }, [reloadKey, retryKey]);

  return (
    <section className="space-y-4 text-ink">
      <h2 className="text-2xl font-semibold">Agency Dashboard</h2>
      {logo && <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
        {logo.logoSrc ? <img src={logo.logoSrc} alt={logo.agencyName} className="h-[32px] max-w-[120px] w-auto object-contain" /> : <span className="rounded-lg border border-line bg-sunken px-2 text-xs text-ink">{logo.agencyShortCode}</span>}
        <span className="flex-1 text-sm font-semibold">Agency logo</span>
        <button type="button" onClick={logo.onOpen} className="min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold pressable">Change</button>
      </div>}
      {loading ? <p className="text-base text-ink-soft">Loading dashboard...</p> : failed ? (
        <div className="space-y-4">
          <p role="alert" className="text-base text-bad">Couldn't load the dashboard.</p>
          <button type="button" onClick={() => setRetryKey((key) => key + 1)} className="min-h-11 px-4 rounded-xl bg-gold-deep text-surface dark:text-paper text-base font-semibold pressable cursor-pointer">Retry</button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Totals */}
          {data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-surface border border-line e1 text-center">
                <div className="text-2xl font-semibold">{data.totals.venueCount}</div>
                <div className="text-xs text-ink-soft">Venues</div>
              </div>
              <div className="p-4 rounded-xl bg-surface border border-line e1 text-center">
                <div className="text-2xl font-semibold">{data.totals.totalTasks}</div>
                <div className="text-xs text-ink-soft">Total Tasks</div>
              </div>
              <div className="p-4 rounded-xl bg-surface border border-line e1 text-center">
                <div className="text-2xl font-semibold text-ok">
                  {data.totals.completedTasks}
                </div>
                <div className="text-xs text-ink-soft">Completed</div>
              </div>
              <div className="p-4 rounded-xl bg-surface border border-line e1 text-center">
                <div className="text-2xl font-semibold text-ink">
                  {data.totals.totalHandoffNotes}
                </div>
                <div className="text-xs text-ink-soft">Handoff Notes</div>
              </div>
            </div>
          )}

          {/* Venue cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data?.venues.map((vs) => (
              <article key={vs.venue.id} className="min-w-0 p-4 sm:p-6 rounded-xl border border-line e1 bg-surface">
                <button
                  type="button"
                  aria-label={`Open ${vs.venue.name} board`}
                  onClick={() => onSelectVenue(vs.venue.id)}
                  className="w-full min-h-11 text-left rounded-lg hover:bg-sunken pressable cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 className="w-5 h-5 text-ink-soft shrink-0" />
                      <div className="min-w-0 break-words">
                        <div className="font-semibold text-base">{vs.venue.name}</div>
                        {vs.venue.category && (
                          <div className="text-xs text-ink-soft">{vs.venue.category}</div>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xl font-semibold">{vs.completionRate}%</div>
                      <div className="text-xs text-ink-soft">
                        {vs.completedTasks}/{vs.totalTasks} done
                      </div>
                    </div>
                  </div>

                </button>

                {/* Progress bar */}
                <div role="progressbar" aria-valuenow={vs.completionRate} aria-valuemin={0} aria-valuemax={100} aria-label={`${vs.venue.name} progress`} className="mt-2 h-2 rounded-full bg-sunken overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gold"
                    style={{ width: `${vs.completionRate}%` }}
                  />
                </div>

                {/* Alerts */}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  {vs.overdueTasks > 0 && (
                    <span className="flex items-center gap-1 text-bad font-semibold">
                      <AlertTriangle className="w-4 h-4" />
                      {vs.overdueTasks} overdue
                    </span>
                  )}
                  {vs.recentNotes.length > 0 && (
                    <span className="flex items-center gap-1 text-ink-soft">
                      <MessageSquare className="w-4 h-4" />
                      {vs.recentNotes.length} recent note{vs.recentNotes.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {vs.overdueTasks === 0 && vs.recentNotes.length === 0 && (
                    <span className="flex items-center gap-1 text-ok">
                      <CheckCircle2 className="w-4 h-4" />
                      All clear
                    </span>
                  )}
                </div>

                {/* Recent notes preview */}
                {vs.recentNotes.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60">
                    <div className="text-xs text-ink-soft line-clamp-2">
                      <span className="font-semibold">{vs.recentNotes[0].authorName}:</span>{' '}
                      {vs.recentNotes[0].content}
                    </div>
                  </div>
                )}

                {/* Open incidents */}
                {vs.openIncidents.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60 space-y-1">
                    {vs.openIncidents.slice(0, 2).map((inc) => (
                      <div key={inc.id} className="flex items-center gap-1.5 text-xs">
                        <AlertTriangle className={`w-4 h-4 shrink-0 ${inc.severity === 'critical' ? 'text-bad' : 'text-warn'}`} />
                        <span className="font-semibold truncate">{inc.title}</span>
                        <span className="text-ink-soft shrink-0">({inc.severity})</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mashgichim — tap to call */}
                {vs.mashgichim.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-line/60 flex flex-wrap gap-1.5">
                    {vs.mashgichim.map((m) => (
                      m.phone?.trim() ? (
                        <a
                          key={rosterKey(m)}
                          href={`tel:${m.phone}`}

                          className="flex items-center gap-1 px-2 py-1 rounded-lg min-h-11 bg-sunken hover:bg-line/40 text-xs font-medium text-ink pressable"
                        >
                          <Phone className="w-4 h-4" />
                          {m.name}
                        </a>
                      ) : (
                        <span key={rosterKey(m)} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sunken text-xs text-ink-soft">
                          <User className="w-4 h-4" />
                          {m.name}
                        </span>
                      )
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>

          {data?.venues.length === 0 && (
            <div className="text-center py-8 text-sm text-ink-soft">
              No venues yet. Create your first venue to get started.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
