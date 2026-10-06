import React, { useState } from 'react';
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
} from 'lucide-react';
import { Venue } from '../types';
import { ConfirmModal } from './ConfirmModal';

interface VenuesDirectoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  venues: Venue[];
  currentVenue: Venue | null;
  onSelectVenue: (venueId: string) => void;
  onOpenCreateVenue: () => void;
  onDeleteVenue?: (venueId: string) => Promise<void>;
  isAdmin: boolean;
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs animate-fade-in"
    >
      <div className="bg-surface w-full max-w-4xl rounded-2xl tactile-4 animate-slide-up border border-line overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink flex items-center gap-2">
                <span>Kosher Venues & Restaurants Platform Hub</span>
                <span className="tnum text-xs font-semibold px-2 py-0.5 rounded-full bg-gold-wash text-gold-ink border border-gold/40">
                  {venues.length} Facilities
                </span>
              </h2>
              <p className="text-xs text-ink-soft">
                Switch between venues or establish a new certified kosher restaurant, bakery, or caterer platform.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                id="directory-create-venue-btn"
                onClick={() => {
                  onClose();
                  onOpenCreateVenue();
                }}
                className="pressable px-3 py-1.5 text-xs font-bold rounded-lg bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white tactile-1 flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Venue</span>
              </button>
            )}
            <button
              id="close-venues-directory-btn"
              onClick={onClose}
              className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="p-4 border-b border-line bg-sunken/60 flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by venue, address, or hashgacha..."
              className="w-full pl-8.5 pr-3 py-1.5 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg capitalize whitespace-nowrap transition cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-gold text-white tactile-1'
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
            <div className="col-span-2 text-center py-12 text-ink-faint">
              <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs font-medium">No venues match your search criteria.</p>
            </div>
          ) : (
            filteredVenues.map((venue) => {
              const isCurrent = currentVenue?.id === venue.id;
              const rate = venue.completionRate ?? 0;
              const totalTasks = venue.totalTasksToday ?? 0;
              const completedTasks = venue.completedTasksToday ?? 0;

              return (
                <div
                  key={venue.id}
                  onClick={() => {
                    onSelectVenue(venue.id);
                    onClose();
                  }}
                  className={`p-4.5 rounded-2xl border transition text-left relative flex flex-col justify-between cursor-pointer group ${
                    isCurrent
                      ? 'border-gold/60 bg-gold-wash/60 ring-1 ring-gold/40 tactile-2'
                      : 'border-line bg-surface tactile-1 lift hover:border-line-strong'
                  }`}
                >
                  {/* Top line: Name, Category, Active badge */}
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-ink group-hover:text-gold-deep transition">
                            {venue.name}
                          </h3>
                          {isCurrent && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-b from-gold to-gold-deep text-white shrink-0">
                              Active Platform
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-medium text-ink-soft mt-0.5">
                          {venue.category}
                        </div>
                      </div>

                      {isAdmin && (
                        <button
                          title="Delete Venue Platform"
                          onClick={(e) => handleDelete(e, venue)}
                          className="pressable flex items-center gap-1 text-xs text-rose-600 dark:text-rose-400 p-1.5 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/80 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="text-[11px] font-semibold hidden sm:inline">Delete</span>
                        </button>
                      )}
                    </div>

                    {/* Address & Certification */}
                    <div className="space-y-1 text-[11px] text-ink-soft mb-3.5">
                      {venue.address && (
                        <div className="flex items-center gap-1.5 text-ink-soft">
                          <MapPin className="w-3 h-3 text-ink-faint shrink-0" />
                          <span className="truncate">{venue.address}</span>
                        </div>
                      )}
                      {venue.certification && (
                        <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                          <ShieldCheck className="w-3 h-3 text-emerald-500 shrink-0" />
                          <span className="truncate">{venue.certification}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Metrics & Action */}
                  <div className="pt-3 border-t border-line">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-[11px] text-ink-soft tnum">
                        Shift Completion: <strong>{completedTasks}/{totalTasks}</strong>
                      </span>
                      <span className="text-xs font-bold text-ink tnum">
                        {rate}%
                      </span>
                    </div>

                    <div className="w-full h-1.5 bg-sunken rounded-full overflow-hidden mb-3">
                      <div
                        className={`h-full transition-all duration-500 ${
                          rate === 100
                            ? 'bg-emerald-500'
                            : rate > 50
                            ? 'bg-gold'
                            : 'bg-gold-deep'
                        }`}
                        style={{ width: `${rate}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[11px] text-ink-faint flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {venue.workerCount ?? 0} staff members
                      </span>

                      <button
                        className={`text-xs font-semibold flex items-center gap-1 px-2.5 py-1 rounded-lg transition ${
                          isCurrent
                            ? 'text-gold-deep bg-gold-wash border border-gold/40'
                            : 'text-ink-soft hover:text-gold-deep bg-sunken hover:bg-gold-wash/60'
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
            className="pressable px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-line bg-sunken hover:bg-gold-wash/60 text-ink transition cursor-pointer"
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
