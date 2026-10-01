import React, { useState } from 'react';
import {
  X,
  Calendar,
  MapPin,
  User,
  Paperclip,
  CheckCircle2,
  Circle,
  Plus,
  Phone,
  Mail,
  FileText,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import { KosherEvent, EventTask, User as UserType, Venue } from '../types';

interface EventsModalProps {
  isOpen: boolean;
  onClose: () => void;
  events: KosherEvent[];
  currentUser: UserType | null;
  currentVenue: Venue | null;
  allVenues: Venue[];
  availableMashgichim?: UserType[];
  onOpenCreateEvent: () => void;
  onToggleEventTask: (eventId: string, taskId: string, isCompleted: boolean, notes?: string) => Promise<void>;
  onUpdateEvent: (event: KosherEvent) => Promise<void>;
  onDeleteEvent?: (eventId: string) => Promise<void>;
}

export const EventsModal: React.FC<EventsModalProps> = ({
  isOpen,
  onClose,
  events,
  currentUser,
  currentVenue,
  allVenues,
  availableMashgichim = [],
  onOpenCreateEvent,
  onToggleEventTask,
  onUpdateEvent,
  onDeleteEvent,
}) => {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(() => {
    return events[0]?.id || null;
  });
  const [filterMode, setFilterMode] = useState<'all' | 'my_assigned' | 'upcoming'>('all');
  const [taskNotesInput, setTaskNotesInput] = useState<{ [taskId: string]: string }>({});
  const [newEventTaskTitle, setNewEventTaskTitle] = useState('');

  if (!isOpen) return null;

  // Filter events according to user role and current filter
  const isMashgiach = currentUser?.role === 'mashgiach';
  const isAdmin = currentUser?.role === 'admin';
  const isOwner = currentUser?.role === 'owner';

  const filteredEvents = events.filter((e) => {
    if (filterMode === 'my_assigned') {
      return (
        e.assignedMashgiachEmail &&
        e.assignedMashgiachEmail.toLowerCase() === currentUser?.email.toLowerCase()
      );
    }
    if (filterMode === 'upcoming') {
      const today = new Date().toISOString().split('T')[0];
      return e.date >= today;
    }
    return true;
  });

  const activeEvent =
    filteredEvents.find((e) => e.id === selectedEventId) ||
    filteredEvents[0] ||
    events[0] ||
    null;

  const handleToggleTask = async (taskId: string, currentCompleted: boolean) => {
    if (!activeEvent) return;
    const notes = taskNotesInput[taskId];
    await onToggleEventTask(activeEvent.id, taskId, !currentCompleted, notes);
  };

  const handleAddNewTaskToActiveEvent = async () => {
    if (!activeEvent || !newEventTaskTitle.trim()) return;

    const newTask: EventTask = {
      id: `etask-${Date.now()}`,
      title: newEventTaskTitle.trim(),
      isCompleted: false,
    };

    const updated = {
      ...activeEvent,
      tasks: [...(activeEvent.tasks || []), newTask],
    };

    await onUpdateEvent(updated);
    setNewEventTaskTitle('');
  };

  const handleViewMenu = (e: KosherEvent) => {
    if (!e.menuAttachmentData) return;
    const win = window.open();
    if (win) {
      if (e.menuAttachmentData.startsWith('data:image')) {
        win.document.write(`<img src="${e.menuAttachmentData}" style="max-width:100%;height:auto;margin:20px auto;display:block;" />`);
      } else {
        win.location.href = e.menuAttachmentData;
      }
    }
  };

  return (
    <div
      id="events-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-[#1a120a]/60 backdrop-blur-xs animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-5xl h-[88vh] rounded-2xl tactile-5 border border-line flex flex-col overflow-hidden my-auto animate-slide-up">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-sunken">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold to-gold-deep text-white flex items-center justify-center tactile-2">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-ink">
                  Kosher Events & Banquets Hub
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-gold-wash text-gold-ink border border-gold/40">
                  {filteredEvents.length} {filteredEvents.length === 1 ? 'Event' : 'Events'}
                </span>
              </div>
              <p className="text-xs text-ink-soft">
                Manage banquet schedules, mashgiach assignments, menus, and on-site event checklists.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Action button to schedule / notify new event */}
            <button
              id="open-create-event-btn"
              onClick={onOpenCreateEvent}
              className="px-3 py-1.5 text-xs font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-1 flex items-center gap-1.5 transition cursor-pointer pressable"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Notify New Event</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-ink-faint hover:text-ink-soft hover:bg-sunken transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Main Body (2 Columns on large screens) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          
          {/* Left Panel: Events List with Filter */}
          <div className="w-full md:w-80 lg:w-96 border-b md:border-b-0 md:border-r border-line flex flex-col bg-sunken/50">
            {/* Filter Pills */}
            <div className="p-3 border-b border-line flex gap-1.5 bg-surface">
              <button
                onClick={() => setFilterMode('all')}
                className={`px-2.5 py-1 text-xs rounded-lg font-semibold transition cursor-pointer ${
                  filterMode === 'all'
                    ? 'bg-gold text-white tactile-1 pressable'
                    : 'text-ink-soft hover:bg-sunken pressable'
                }`}
              >
                All Events
              </button>
              {isMashgiach && (
                <button
                  onClick={() => setFilterMode('my_assigned')}
                  className={`px-2.5 py-1 text-xs rounded-lg font-semibold transition cursor-pointer ${
                    filterMode === 'my_assigned'
                      ? 'bg-gold text-white tactile-1 pressable'
                      : 'text-ink-soft hover:bg-sunken pressable'
                  }`}
                >
                  My Assignments
                </button>
              )}
              <button
                onClick={() => setFilterMode('upcoming')}
                className={`px-2.5 py-1 text-xs rounded-lg font-semibold transition cursor-pointer ${
                  filterMode === 'upcoming'
                    ? 'bg-gold text-white tactile-1 pressable'
                    : 'text-ink-soft hover:bg-sunken pressable'
                }`}
              >
                Upcoming
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {filteredEvents.length === 0 ? (
                <div className="text-center py-12 px-4 text-ink-faint">
                  <Calendar className="w-8 h-8 mx-auto mb-2 opacity-30 text-gold-deep" />
                  <p className="text-xs font-medium">No events found in this category.</p>
                  <button
                    onClick={onOpenCreateEvent}
                    className="mt-3 text-xs font-bold text-gold-deep hover:underline cursor-pointer"
                  >
                    + Register the first event
                  </button>
                </div>
              ) : (
                filteredEvents.map((evt) => {
                  const isSelected = activeEvent?.id === evt.id;
                  const completedCount = evt.tasks?.filter((t) => t.isCompleted).length || 0;
                  const totalCount = evt.tasks?.length || 0;
                  const isAssignedToMe =
                    evt.assignedMashgiachEmail &&
                    evt.assignedMashgiachEmail.toLowerCase() === currentUser?.email.toLowerCase();

                  return (
                    <button
                      key={evt.id}
                      onClick={() => setSelectedEventId(evt.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer lift ${
                        isSelected
                          ? 'border-gold bg-gold-wash tactile-1 ring-1 ring-gold/30'
                          : 'border-line bg-surface/70 hover:bg-surface'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1 mb-1">
                        <span className="font-bold text-xs text-ink line-clamp-1">
                          {evt.title}
                        </span>
                        {isAssignedToMe && (
                          <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 shrink-0">
                            Assigned to You
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 text-[11px] text-gold-deep font-semibold mb-1">
                        <Calendar className="w-3 h-3 shrink-0" />
                        <span className="tnum">{evt.date}</span>
                        {evt.startTime && <span>• {evt.startTime}</span>}
                      </div>

                      <div className="flex items-center gap-1.5 text-[11px] text-ink-soft truncate mb-2">
                        <MapPin className="w-3 h-3 shrink-0 text-ink-faint" />
                        <span className="truncate">{evt.location}</span>
                      </div>

                      {/* Progress Bar & Mashgiach Badge */}
                      <div className="flex items-center justify-between text-[10px] pt-2 border-t border-line">
                        <span className="text-ink-soft">
                          Tasks: {completedCount}/{totalCount}
                        </span>
                        <span className="font-semibold text-ink-soft truncate max-w-[120px]">
                          {evt.mashgiachType === 'assigned_user'
                            ? evt.assignedMashgiachName || 'Assigned Mashgiach'
                            : evt.mashgiachType === 'external'
                            ? `Ext: ${evt.externalMashgiach?.name || 'Other'}`
                            : 'Unassigned'}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Selected Event Details & Tasks */}
          <div className="flex-1 flex flex-col overflow-y-auto bg-surface p-6">
            {activeEvent ? (
              <div className="space-y-6">
                {/* Event Top Banner */}
                <div className="p-4.5 rounded-2xl bg-gradient-to-r from-gold/10 via-gold/5 to-transparent border border-gold/40 tactile-1">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gold-deep text-white">
                          Kosher Event
                        </span>
                        <span className="text-xs text-ink-soft font-medium">
                          Origin: <strong>{activeEvent.venueName || 'Supervised Venue'}</strong>
                        </span>
                      </div>
                      <h3 className="text-lg font-black text-ink">
                        {activeEvent.title}
                      </h3>
                    </div>

                    {isAdmin && onDeleteEvent && (
                      <button
                        onClick={() => onDeleteEvent(activeEvent.id)}
                        className="px-2.5 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition self-start sm:self-auto cursor-pointer"
                      >
                        Delete Event
                      </button>
                    )}
                  </div>

                  {/* Metadata Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-3 border-t border-line">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-gold-deep shrink-0" />
                      <div>
                        <div className="text-[10px] text-ink-faint font-semibold uppercase">Date & Time</div>
                        <div className="font-semibold text-ink">
                          {activeEvent.date} {activeEvent.startTime && `(${activeEvent.startTime} - ${activeEvent.endTime || ''})`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-gold-deep shrink-0" />
                      <div>
                        <div className="text-[10px] text-ink-faint font-semibold uppercase">Location</div>
                        <div className="font-semibold text-ink truncate max-w-xs">
                          {activeEvent.location}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-gold-deep shrink-0" />
                      <div>
                        <div className="text-[10px] text-ink-faint font-semibold uppercase">Supervising Mashgiach</div>
                        <div className="font-semibold text-ink">
                          {isAdmin ? (
                            <select
                              value={
                                activeEvent.mashgiachType === 'assigned_user'
                                  ? activeEvent.assignedMashgiachEmail || ''
                                  : activeEvent.mashgiachType === 'external'
                                  ? 'external'
                                  : 'unassigned'
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'unassigned') {
                                  onUpdateEvent({
                                    ...activeEvent,
                                    mashgiachType: 'unassigned',
                                    assignedMashgiachEmail: undefined,
                                    assignedMashgiachName: undefined,
                                  });
                                } else if (val === 'external') {
                                  // keep existing external or default
                                  onUpdateEvent({
                                    ...activeEvent,
                                    mashgiachType: 'external',
                                    assignedMashgiachEmail: undefined,
                                    assignedMashgiachName: undefined,
                                  });
                                } else {
                                  const found = availableMashgichim.find((m) => m.email === val);
                                  onUpdateEvent({
                                    ...activeEvent,
                                    mashgiachType: 'assigned_user',
                                    assignedMashgiachEmail: val,
                                    assignedMashgiachName: found?.name || val,
                                  });
                                }
                              }}
                              className="text-xs font-bold text-gold-ink bg-surface border border-gold/40 rounded-lg px-2 py-1 mt-0.5 cursor-pointer"
                            >
                              <option value="unassigned">-- Unassigned --</option>
                              {availableMashgichim
                                .filter((m) => m.role === 'mashgiach' || m.role === 'admin' || m.role === 'coordinator')
                                .map((m) => (
                                  <option key={m.id} value={m.email}>
                                    {m.name} ({m.email})
                                  </option>
                                ))}
                              <option value="external">External / Other Mashgiach</option>
                            </select>
                          ) : (
                            activeEvent.mashgiachType === 'assigned_user' ? (
                              <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                                {activeEvent.assignedMashgiachName || activeEvent.assignedMashgiachEmail}
                              </span>
                            ) : activeEvent.mashgiachType === 'external' ? (
                              <span className="text-gold-deep font-bold">
                                {activeEvent.externalMashgiach?.name || 'External'} (Other)
                              </span>
                            ) : (
                              <span className="text-ink-faint italic">Unassigned</span>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* If External Mashgiach, show contact card */}
                  {activeEvent.mashgiachType === 'external' && activeEvent.externalMashgiach && (
                    <div className="mt-3 p-3 rounded-xl bg-gold-wash border border-gold/40 text-xs flex flex-wrap items-center gap-4">
                      <span className="font-bold text-gold-ink">
                        External Mashgiach Contact:
                      </span>
                      {activeEvent.externalMashgiach.phone && (
                        <a
                          href={`tel:${activeEvent.externalMashgiach.phone}`}
                          className="flex items-center gap-1 text-ink-soft hover:text-gold-deep font-medium"
                        >
                          <Phone className="w-3 h-3 text-gold-deep" />
                          <span>{activeEvent.externalMashgiach.phone}</span>
                        </a>
                      )}
                      {activeEvent.externalMashgiach.email && (
                        <a
                          href={`mailto:${activeEvent.externalMashgiach.email}`}
                          className="flex items-center gap-1 text-ink-soft hover:text-gold-deep font-medium"
                        >
                          <Mail className="w-3 h-3 text-gold-deep" />
                          <span>{activeEvent.externalMashgiach.email}</span>
                        </a>
                      )}
                    </div>
                  )}

                  {/* Menu Attachment & Notes */}
                  {(activeEvent.menuAttachmentName || activeEvent.notes) && (
                    <div className="mt-3 pt-3 border-t border-line flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between text-xs">
                      {activeEvent.notes && (
                        <p className="text-ink-soft italic text-[11px]">
                          <strong>Guidance:</strong> {activeEvent.notes}
                        </p>
                      )}

                      {activeEvent.menuAttachmentName && (
                        <button
                          type="button"
                          onClick={() => handleViewMenu(activeEvent)}
                          className="px-3 py-1.5 rounded-lg bg-surface border border-gold/40 text-gold-ink font-semibold flex items-center gap-1.5 hover:bg-gold-wash transition cursor-pointer shrink-0 tactile-1 pressable"
                        >
                          <Paperclip className="w-3.5 h-3.5 text-gold-deep" />
                          <span>View Menu ({activeEvent.menuAttachmentName})</span>
                          <ExternalLink className="w-3 h-3 ml-0.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Event Tasks Section */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="text-sm font-bold text-ink flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-600" />
                        <span>Event Kashrut Verification Tasks</span>
                      </h4>
                      <p className="text-xs text-ink-soft">
                        Check off items as they are inspected on-site by the mashgiach.
                      </p>
                    </div>

                    <span className="text-xs font-bold text-gold-ink bg-gold-wash px-2.5 py-1 rounded-lg border border-gold/40">
                      {activeEvent.tasks?.filter((t) => t.isCompleted).length || 0} / {activeEvent.tasks?.length || 0} Completed
                    </span>
                  </div>

                  {/* Tasks list */}
                  <div className="space-y-2">
                    {activeEvent.tasks && activeEvent.tasks.length > 0 ? (
                      activeEvent.tasks.map((task) => (
                        <div
                          key={task.id}
                          className={`p-3 rounded-xl border transition ${
                            task.isCompleted
                              ? 'bg-emerald-50/70 dark:bg-emerald-950/20 border-emerald-300 dark:border-emerald-800/80'
                              : 'bg-surface border-line'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleTask(task.id, task.isCompleted)}
                              className="flex items-start gap-2.5 text-left cursor-pointer flex-1"
                            >
                              {task.isCompleted ? (
                                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                              ) : (
                                <Circle className="w-4 h-4 text-ink-faint mt-0.5 shrink-0" />
                              )}
                              <div>
                                <div
                                  className={`text-xs font-semibold ${
                                    task.isCompleted
                                      ? 'text-emerald-900 dark:text-emerald-200 line-through opacity-85'
                                      : 'text-ink'
                                  }`}
                                >
                                  {task.title}
                                </div>
                                {task.description && (
                                  <p className="text-[11px] text-ink-soft mt-0.5">
                                    {task.description}
                                  </p>
                                )}
                              </div>
                            </button>

                            {task.isCompleted && (
                              <div className="text-right shrink-0">
                                <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 block">
                                  ✓ Verified
                                </span>
                                {task.completedByName && (
                                  <span className="text-[10px] text-ink-faint block">
                                    by {task.completedByName}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Notes field */}
                          <div className="mt-2 pt-2 border-t border-line flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Mashgiach inspection note / seal serial numbers..."
                              value={taskNotesInput[task.id] ?? task.notes ?? ''}
                              onChange={(e) =>
                                setTaskNotesInput({
                                  ...taskNotesInput,
                                  [task.id]: e.target.value,
                                })
                              }
                              onBlur={() => {
                                if (taskNotesInput[task.id] !== undefined) {
                                  onToggleEventTask(activeEvent.id, task.id, task.isCompleted, taskNotesInput[task.id]);
                                }
                              }}
                              className="flex-1 text-[11px] px-2.5 py-1 rounded-lg bg-sunken border border-line text-ink focus:outline-none focus:ring-1 focus:ring-gold"
                            />
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-ink-faint italic">No tasks added to this event yet.</p>
                    )}
                  </div>

                  {/* Add task bar */}
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      value={newEventTaskTitle}
                      onChange={(e) => setNewEventTaskTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddNewTaskToActiveEvent();
                        }
                      }}
                      placeholder="Add an event task (e.g. Verify sealed Cambro temperatures)..."
                      className="flex-1 px-3 py-1.5 text-xs rounded-xl bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
                    />
                    <button
                      type="button"
                      onClick={handleAddNewTaskToActiveEvent}
                      className="px-3.5 py-1.5 text-xs font-bold rounded-xl bg-gold hover:bg-gold-deep text-white flex items-center gap-1 transition cursor-pointer tactile-1 pressable"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Task</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-faint">
                <Calendar className="w-12 h-12 mb-3 text-gold-deep opacity-40" />
                <h4 className="text-sm font-bold text-ink-soft">
                  No Event Selected
                </h4>
                <p className="text-xs text-ink-faint mt-1 max-w-sm">
                  Select an event from the left panel or click "Notify New Event" to register a catered dinner or banquet.
                </p>
                <button
                  onClick={onOpenCreateEvent}
                  className="mt-4 px-4 py-2 text-xs font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 transition cursor-pointer pressable"
                >
                  + Notify New Event
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken flex items-center justify-between text-xs text-ink-soft">
          <span>
            Events and tasks are isolated per kosher agency and synchronized in real-time.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 font-semibold text-xs rounded-xl bg-surface hover:bg-sunken text-ink-soft transition cursor-pointer pressable"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
