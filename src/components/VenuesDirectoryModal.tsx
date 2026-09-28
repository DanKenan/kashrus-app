import React, { useState } from 'react';
import { 
  X, 
  Building2, 
  Plus, 
  ShieldCheck, 
  MapPin, 
  Users, 
  CheckCircle2, 
  ArrowRight, 
  Search, 
  Trash2, 
  Clock, 
  ExternalLink 
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-fade-in"
    >
      <div className="bg-white dark:bg-slate-900 w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-500/20">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>Kosher Venues & Restaurants Platform Hub</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">
                  {venues.length} Facilities
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
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
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-xs flex items-center gap-1.5 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Venue</span>
              </button>
            )}
            <button
              id="close-venues-directory-btn"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/40 dark:bg-slate-900/40 flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by venue, address, or hashgacha..."
              className="w-full pl-8.5 pr-3 py-1.5 text-xs rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg capitalize whitespace-nowrap transition cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
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
            <div className="col-span-2 text-center py-12 text-slate-400">
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
                      ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30 ring-1 ring-blue-500 shadow-md'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/90 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-md'
                  }`}
                >
                  {/* Top line: Name, Category, Active badge */}
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition">
                            {venue.name}
                          </h3>
                          {isCurrent && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-600 text-white shrink-0">
                              Active Platform
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mt-0.5">
                          {venue.category}
                        </div>
                      </div>

                      {isAdmin && (
                        <button
                          title="Delete Venue Platform"
                          onClick={(e) => handleDelete(e, venue)}
                          className="text-slate-300 hover:text-rose-500 p-1 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 transition opacity-0 group-hover:opacity-100 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Address & Certification */}
                    <div className="space-y-1 text-[11px] text-slate-600 dark:text-slate-300 mb-3.5">
                      {venue.address && (
                        <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                          <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
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
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        Shift Completion: <strong>{completedTasks}/{totalTasks}</strong>
                      </span>
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                        {rate}%
                      </span>
                    </div>

                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-3">
                      <div
                        className={`h-full transition-all duration-500 ${
                          rate === 100
                            ? 'bg-emerald-500'
                            : rate > 50
                            ? 'bg-blue-500'
                            : 'bg-amber-500'
                        }`}
                        style={{ width: `${rate}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[11px] text-slate-400 flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {venue.workerCount ?? 0} staff members
                      </span>

                      <button
                        className={`text-xs font-semibold flex items-center gap-1 px-2.5 py-1 rounded-lg transition ${
                          isCurrent
                            ? 'text-blue-600 dark:text-blue-400 bg-blue-100/70 dark:bg-blue-900/40'
                            : 'text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/50'
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
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {isAdmin ? 'All establishments are isolated with dedicated tasks, mashgichim, and history.' : 'You have access to this certified venue platform.'}
          </span>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer"
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
