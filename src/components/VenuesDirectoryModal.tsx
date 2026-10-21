import React, { useState } from 'react';
import { ProgressRing } from './ProgressRing';
import { 
  X, 
  Building2, 
  Plus, 
  ShieldCheck, 
  MapPin, 
  Users, 
  ArrowRight, 
  Search, 
  Trash2, 
  Clock,
} from 'lucide-react';
import { Venue } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { apiWrite } from '../lib/api';
import {
  COMMON_TIME_ZONES,
  effectiveTimeZone,
  isValidTimeZone,
  timeZoneLabel,
  venueTimeZone,
  zoneCityLabel,
} from '../lib/workday';

/**
 * Item 6 — a venue's time zone in the directory: read-only for everyone who
 * can open it (with "agency default" when inherited); admins get a select.
 * The new zone shows only after the server confirms (never optimistic); on
 * failure the old value stays and the reason is shown.
 */
const VenueTimeZoneRow: React.FC<{
  venue: Venue;
  agencyTimeZone?: string;
  isAdmin: boolean;
  onVenueUpdated?: (venue: Venue) => void;
}> = ({ venue, agencyTimeZone, isAdmin, onVenueUpdated }) => {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inherited = !isValidTimeZone(venue.timeZone);
  const eff = venueTimeZone(venue, { agencyTimeZone });
  const agencyTz = effectiveTimeZone(undefined, agencyTimeZone);
  const known = COMMON_TIME_ZONES.some((z) => z.tz === venue.timeZone);

  const save = async (value: string) => {
    setSaving(true);
    setNote(null);
    setError(null);
    const result = await apiWrite(`/api/venues/${encodeURIComponent(venue.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeZone: value }),
    });
    setSaving(false);
    if (!result.ok || !result.data?.venue) {
      setError(result.error || 'Could not save the time zone.');
      return;
    }
    onVenueUpdated?.(result.data.venue as Venue);
    const tz = result.data.effectiveTimeZone || eff;
    const next = result.data.nextResetDate as string | undefined;
    setNote(next ? `Saved. Next daily reset: ${next}, 12:00 AM (${zoneCityLabel(tz)}).` : 'Saved.');
  };

  return (
    <div className="text-xs text-ink-soft" onClick={(e) => e.stopPropagation()} data-venue-timezone-row>
      <div className="flex items-center gap-1.5">
        <Clock className="w-3 h-3 text-ink-soft shrink-0" />
        {isAdmin && onVenueUpdated ? (
          <select
            aria-label={`Time zone for ${venue.name}`}
            data-venue-timezone-select
            disabled={saving}
            value={inherited ? '' : (venue.timeZone as string)}
            onChange={(e) => save(e.target.value)}
            className="min-w-0 flex-1 px-2 py-1 focus:outline-none disabled:opacity-60 min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
          >
            <option value="">Agency default ({timeZoneLabel(agencyTz)})</option>
            {!inherited && !known && <option value={venue.timeZone}>{venue.timeZone}</option>}
            {COMMON_TIME_ZONES.map((z) => (
              <option key={z.tz} value={z.tz}>
                {timeZoneLabel(z.tz)}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate" data-venue-timezone-label>
            {timeZoneLabel(eff)}
            {inherited ? ' · agency default' : ''}
          </span>
        )}
        {saving && <span className="text-ink-soft">Saving…</span>}
      </div>
      {note && <p className="mt-1 text-ok">{note}</p>}
      {error && (
        <p role="alert" className="mt-1 text-bad">
          {error}
        </p>
      )}
    </div>
  );
};

interface VenuesDirectoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  venues: Venue[];
  currentVenue: Venue | null;
  onSelectVenue: (venueId: string) => void;
  onOpenCreateVenue: () => void;
  onDeleteVenue?: (venueId: string) => Promise<void>;
  isAdmin: boolean;
  /** Item 6: the agency's zone (absent = America/New_York). */
  agencyTimeZone?: string;
  /** Item 6: called with the server-confirmed venue after a zone save. */
  onVenueUpdated?: (venue: Venue) => void;
}

export const VenuesDirectoryModal: React.FC<VenuesDirectoryModalProps> = ({
  isOpen,
  onClose,
  venues,
  currentVenue,
  onSelectVenue,
  onOpenCreateVenue,
  onDeleteVenue,
  isAdmin,
  agencyTimeZone,
  onVenueUpdated,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [venueToDelete, setVenueToDelete] = useState<Venue | null>(null);

  if (!isOpen) return null;

  const categories = ['all', ...Array.from(new Set(venues.map((v) => v.category)))];

  const filteredVenues = venues.filter((v) => {
    const matchesSearch =
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (v.address && v.address.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (v.certification && v.certification.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesCategory = categoryFilter === 'all' || v.category === categoryFilter;

    return matchesSearch && matchesCategory;
  });

  const handleDelete = (e: React.MouseEvent, venue: Venue) => {
    e.stopPropagation();
    if (!onDeleteVenue) return;
    setVenueToDelete(venue);
  };

  return (
    <div
      id="venues-directory-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in"
    >
      <div className="bg-surface w-full max-w-4xl rounded-2xl e3 animate-slide-up border border-line overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3 w-full sm:w-auto flex-1 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gold-wash text-gold-ink hidden sm:flex items-center justify-center e2 shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-ink flex flex-col items-start sm:flex-row sm:flex-wrap sm:items-center gap-2">
                <span className="min-w-0">Kosher Venues & Restaurants Platform Hub</span>
                <span className="tnum text-xs font-semibold px-2 py-0.5 rounded-full bg-gold-wash text-gold-ink border border-gold/40 shrink-0">
                  {venues.length} Facilities
                </span>
              </h2>
              <p className="text-sm text-ink-soft">
                Switch between venues or establish a new certified kosher restaurant, bakery, or caterer platform.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 w-full sm:w-auto shrink-0">
            {isAdmin && (
              <button
                id="directory-create-venue-btn"
                onClick={() => {
                  onClose();
                  onOpenCreateVenue();
                }}
                className="pressable px-3 py-1.5 text-xs font-bold rounded-lg hover:brightness-105 e1 flex items-center gap-1.5 cursor-pointer bg-gold-deep text-paper shrink-0 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Venue</span>
              </button>
            )}
            <button aria-label="Close"
              id="close-venues-directory-btn"
              onClick={onClose}
              className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="p-4 border-b border-line bg-sunken/60 flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by venue, address, or hashgacha..."
              className="w-full pl-8.5 pr-3 py-1.5 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg capitalize whitespace-nowrap transition cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-sunken text-ink e1 ring-1 ring-ink-soft'
                    : 'bg-sunken text-ink-soft hover:text-ink border border-line'
                }`}
              >
                {cat === 'all' ? 'All Establishments' : cat}
              </button>
            ))}
          </div>
        </div>

        {/* Venues Grid */}
        <div className="p-6 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredVenues.length === 0 ? (
            <div data-empty-state className="col-span-full text-center py-12 text-ink-soft">
              <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm font-medium">No venues match your search criteria.</p>
              <p className="text-sm mt-2">Try a different name, address or hashgacha.</p>
            </div>
          ) : (
            filteredVenues.map((venue) => {
              const isCurrent = currentVenue?.id === venue.id;
              const rate = venue.completionRate ?? 0;
              const totalTasks = venue.totalTasksToday ?? 0;
              const completedTasks = venue.completedTasksToday ?? 0;

              return (
                <div
                  data-desk-venue-card
                  key={venue.id}
                  onClick={() => {
                    onSelectVenue(venue.id);
                    onClose();
                  }}
                  className={`p-4 sm:p-6 min-w-0 rounded-2xl border transition text-left relative flex flex-col justify-between cursor-pointer group ${
                    isCurrent
                      ? 'border-gold/60 bg-gold-wash/60 ring-1 ring-gold/40 e1'
                      : 'border-line bg-surface e1 lift hover:border-line-strong'
                  }`}
                >
                  {/* Top line: Name, Category, Active badge */}
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 dir="auto" className="min-w-0 break-words text-sm font-bold text-ink group-hover:text-gold-deep transition">
                            {venue.name}
                          </h3>
                          {isCurrent && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gold-wash text-gold-ink shrink-0">
                              Active Platform
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-medium text-ink-soft mt-0.5">
                          {venue.category}
                        </div>
                      </div>

                      {isAdmin && (
                        <button
                          title="Delete Venue Platform"
                          onClick={(e) => handleDelete(e, venue)}
                          className="pressable flex items-center gap-1 text-xs p-1.5 rounded-lg transition cursor-pointer shrink-0 bg-surface border border-line-control text-bad hover:bg-sunken"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="text-xs font-semibold hidden sm:inline">Delete</span>
                        </button>
                      )}
                    </div>

                    {/* Address & Certification */}
                    <div className="space-y-1 text-xs text-ink-soft mb-3.5">
                      {venue.address && (
                        <div className="flex items-start gap-1.5 text-ink-soft">
                          <MapPin className="w-3 h-3 mt-0.5 text-ink-soft shrink-0" />
                          <span dir="auto" className="min-w-0 break-words">{venue.address}</span>
                        </div>
                      )}
                      {venue.certification && (
                        <div className="flex items-start gap-1.5 text-ok">
                          <ShieldCheck className="w-3 h-3 mt-0.5 text-ok shrink-0" />
                          <span dir="auto" className="min-w-0 break-words">{venue.certification}</span>
                        </div>
                      )}
                      <VenueTimeZoneRow
                        venue={venue}
                        agencyTimeZone={agencyTimeZone}
                        isAdmin={isAdmin}
                        onVenueUpdated={onVenueUpdated}
                      />
                    </div>
                  </div>

                  {/* Metrics & Action */}
                  <div className="pt-3 border-t border-line">
                    <div className="flex items-center gap-3 text-xs mb-3">
                      <span data-desk-ring className="shrink-0"><ProgressRing done={completedTasks} total={totalTasks} size={40} /></span>
                      <span className="min-w-0 flex-1 text-xs text-ink-soft tnum">
                        Shift Completion: <strong>{completedTasks}/{totalTasks}</strong>
                      </span>
                      <span className="text-xs font-bold text-ink tnum">
                        {rate}%
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <span className="text-xs text-ink-soft flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {venue.workerCount ?? 0} staff members
                      </span>

                      <button
                        className={`text-xs font-semibold flex items-center gap-1 px-2.5 py-1 rounded-lg transition ${
                          isCurrent
                            ? 'bg-sunken text-ink border border-line-control ring-1 ring-ink-soft'
                            : 'bg-surface border border-line-control text-ink hover:bg-sunken'
                        }`}
                      >
                        <span>{isCurrent ? 'Viewing Now' : 'Switch to Platform'}</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken flex items-center justify-between text-xs text-ink-soft">
          <span>
            {isAdmin ? 'All establishments are isolated with dedicated tasks, mashgichim, and history.' : 'You have access to this certified venue platform.'}
          </span>
          <button
            onClick={onClose}
            className="pressable px-3.5 py-1.5 text-xs font-semibold rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
          >
            Close Hub
          </button>
        </div>

      </div>

      {/* Delete Venue Confirmation Modal */}
      <ConfirmModal
        isOpen={Boolean(venueToDelete)}
        onClose={() => setVenueToDelete(null)}
        onConfirm={async () => {
          if (!venueToDelete || !onDeleteVenue) return;
          const v = venueToDelete;
          setVenueToDelete(null);
          await onDeleteVenue(v.id);
        }}
        title={`Delete "${venueToDelete?.name}"?`}
        message={`Are you sure you want to delete "${venueToDelete?.name}" and all its shift assignments and logs? This action cannot be undone.`}
        confirmText="Delete Venue"
        cancelText="Cancel"
        variant="danger"
        icon="trash"
      />
    </div>
  );
};
