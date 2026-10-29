import React, { useEffect, useState } from 'react';
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
  Copy,
  Trash2,
  Bell,
  ChevronLeft,
  Pencil,
} from 'lucide-react';
import { KosherEvent, EventTask, User as UserType, Venue } from '../types';
import { venueTimeZone, workDateIn } from '../lib/workday';
import { formatClockTime, formatTimeRange } from '../lib/clockTime';
import { formatWorkDate } from '../lib/dateText';
import { mayCreateEvents, mayManageEventAt, mayEditEventTaskWording } from '../lib/eventPermissions';
import { editEventTask, EVENT_TASK_TITLE_MAX, EVENT_TASK_DESCRIPTION_MAX } from '../lib/eventTaskEdit';
import { notifyEventAssignee } from '../lib/eventNotify';

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
  /** Item 7: open the copy dialog for this event (admin / venue coordinator). */
  onCopyEvent?: (event: KosherEvent) => void;
  /** Item 7: select this event (for example, the copy just created). */
  focusEventId?: string | null;
  /** EVENTEDIT: an event task's wording was saved; the server's saved event. */
  onEventTaskSaved?: (event: KosherEvent) => void;
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
  onCopyEvent,
  focusEventId,
  onEventTaskSaved,
}) => {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(() => {
    return events[0]?.id || null;
  });
  const [filterMode, setFilterMode] = useState<'all' | 'my_assigned' | 'upcoming'>('all');
  const [taskNotesInput, setTaskNotesInput] = useState<{ [taskId: string]: string }>({});
  const [newEventTaskTitle, setNewEventTaskTitle] = useState('');
  // EVENTEDIT: one event task's wording is edited at a time, in place.
  const [taskEdit, setTaskEdit] = useState<{ eventId: string; taskId: string; title: string; description: string } | null>(null);
  const [taskEditBusy, setTaskEditBusy] = useState(false);
  const [taskEditError, setTaskEditError] = useState<string | null>(null);

  // QA2 Q1: on a phone (below md) the sheet shows the list OR one event's
  // details (the two side-by-side panels did not fit: the list could not
  // scroll and details had no room). Tapping an event opens its details;
  // "All events" goes back. From md up, both panels show as before.
  const [phoneDetail, setPhoneDetail] = useState(false);
  // QA2 #31: Notify again (one at a time; the note belongs to the event it was sent for).
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyNote, setNotifyNote] = useState<{ eventId: string; ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!focusEventId) return;
    setSelectedEventId(focusEventId);
    setFilterMode('all');
    setPhoneDetail(true);
  }, [focusEventId]);

  useEffect(() => {
    if (!isOpen) setPhoneDetail(false);
  }, [isOpen]);

  if (!isOpen) return null;

  // Filter events according to user role and current filter
  const isMashgiach = currentUser?.role === 'mashgiach';

  const filteredEvents = events.filter((e) => {
    if (filterMode === 'my_assigned') {
      return (
        e.assignedMashgiachEmail &&
        e.assignedMashgiachEmail.toLowerCase() === currentUser?.email.toLowerCase()
      );
    }
    if (filterMode === 'upcoming') {
      // Item 6: "today" is the event venue's local date, not UTC.
      const evVenue = allVenues.find((v) => v.id === e.venueId) || null;
      const today = workDateIn(venueTimeZone(evVenue, currentUser), new Date());
      return e.date >= today;
    }
    return true;
  });

  const activeEvent =
    filteredEvents.find((e) => e.id === selectedEventId) ||
    filteredEvents[0] ||
    events[0] ||
    null;

  // QA2 #9: create / edit / copy / delete only for admin, coordinator (own venues)
  // and owner (own venue) — the client mirror of the server's rule; the server decides.
  const canCreate = mayCreateEvents(currentUser, allVenues);
  const canManageActive = !!activeEvent && mayManageEventAt(currentUser, activeEvent.venueId, allVenues);
  const canCopyActive = !!onCopyEvent && canManageActive;
  const canDeleteActive = !!onDeleteEvent && canManageActive;
  // EVENTEDIT: who may change an event task's wording (the people who may edit
  // an ordinary task at that venue); the server decides.
  const canEditTaskWording = !!activeEvent && mayEditEventTaskWording(currentUser, activeEvent, allVenues);

  const startTaskEdit = (task: EventTask) => {
    if (!activeEvent) return;
    setTaskEditError(null);
    setTaskEdit({ eventId: activeEvent.id, taskId: task.id, title: task.title || '', description: task.description || '' });
  };
  const cancelTaskEdit = () => {
    setTaskEdit(null);
    setTaskEditError(null);
  };
  const saveTaskEdit = async () => {
    if (!taskEdit || taskEditBusy) return;
    if (!taskEdit.title.trim()) {
      setTaskEditError('Give the task a name.');
      return;
    }
    setTaskEditBusy(true);
    setTaskEditError(null);
    const r = await editEventTask(taskEdit.eventId, taskEdit.taskId, { title: taskEdit.title, description: taskEdit.description });
    setTaskEditBusy(false);
    if (!r.ok || !r.event) {
      setTaskEditError(r.message || "Couldn't save the task. Please try again.");
      return;
    }
    setTaskEdit(null);
    onEventTaskSaved?.(r.event);
  };

  const handleNotifyAgain = async () => {
    if (!activeEvent || notifyBusy) return;
    const eventId = activeEvent.id;
    setNotifyBusy(true);
    setNotifyNote(null);
    const r = await notifyEventAssignee(eventId, activeEvent.assignedMashgiachName || activeEvent.assignedMashgiachEmail);
    setNotifyBusy(false);
    setNotifyNote({ eventId, ok: r.ok, text: r.message });
  };

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
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-scrim backdrop-blur-sm animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-5xl h-[88vh] rounded-2xl e3 border border-line flex flex-col overflow-hidden my-auto animate-slide-up">
        
        {/* Header */}
        {/* QA1: on a narrow sheet (rem-based, so large text counts) the title keeps the row with
            Close, and "Create event" moves to its own line instead of running off the edge. */}
        <div className="@container">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-sunken @max-[36rem]:flex-wrap @max-[36rem]:gap-x-3 @max-[36rem]:gap-y-3">
          <div className="flex items-center gap-3 @max-[36rem]:flex-1 @max-[36rem]:min-w-[50%]">
            <div className="w-10 h-10 rounded-xl text-ink flex items-center justify-center e2 @max-[36rem]:hidden">
              <Calendar className="w-5 h-5" />
            </div>
            <div className="@max-[36rem]:min-w-0">
              <div className="flex items-center gap-2 @max-[36rem]:flex-wrap">
                <h2 className="text-base font-bold text-ink">
                  Kosher Events & Banquets Hub
                </h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-sunken text-ink-soft border border-line-control">
                  {filteredEvents.length} {filteredEvents.length === 1 ? 'Event' : 'Events'}
                </span>
              </div>
              <p className="text-sm text-ink-soft">
                Manage banquet schedules, mashgiach assignments, menus, and on-site event checklists.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 @max-[36rem]:contents">
            {/* Action button to schedule / notify new event */}
            {canCreate && (
            <button
              id="open-create-event-btn"
              onClick={onOpenCreateEvent}
              className="px-3 py-1.5 text-xs font-bold rounded-xl e1 flex items-center gap-1.5 transition cursor-pointer pressable bg-surface border border-line-control text-ink hover:bg-sunken whitespace-nowrap shrink-0 @max-[36rem]:order-last"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create event</span>
            </button>
            )}

            <button aria-label="Close"
              onClick={onClose}
              className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        </div>

        {/* Modal Main Body (2 Columns on large screens) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          
          {/* Left Panel: Events List with Filter */}
          <div className={`w-full md:w-80 lg:w-96 border-b md:border-b-0 md:border-r border-line flex flex-col bg-sunken/50 min-h-0 flex-1 md:flex-initial ${phoneDetail ? 'max-md:hidden' : ''}`}>
            {/* Filter Pills */}
            <div className="p-3 border-b border-line flex flex-wrap gap-1.5 bg-sunken">
              <button
                onClick={() => setFilterMode('all')}
                className={`px-2.5 py-1 text-xs rounded-lg font-semibold transition cursor-pointer ${
                  filterMode === 'all'
                    ? 'bg-surface text-ink e1 pressable'
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
                      ? 'bg-surface text-ink e1 pressable'
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
                    ? 'bg-surface text-ink e1 pressable'
                    : 'text-ink-soft hover:bg-sunken pressable'
                }`}
              >
                Upcoming
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {filteredEvents.length === 0 ? (
                <div data-empty-state className="text-center py-12 px-4 text-ink-soft">
                  <Calendar className="w-8 h-8 mx-auto mb-2 opacity-30 text-ink-soft" />
                  <p className="text-sm font-medium">No events found in this category.</p>
                  <p className="text-sm text-ink-soft mt-2">Create an event to plan its tasks and team.</p>
                  {canCreate && (
                  <button
                    onClick={onOpenCreateEvent}
                    className="mt-3 inline-flex items-center px-4 py-2 min-h-11 rounded-xl text-sm font-semibold bg-surface border border-line-control text-ink hover:bg-sunken cursor-pointer"
                  >
                    + Register the first event
                  </button>
                  )}
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
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => {
                        setSelectedEventId(evt.id);
                        setPhoneDetail(true);
                      }}
                      className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer lift ${
                        isSelected
                          ? 'border-ink-soft bg-sunken e1 ring-1 ring-ink-soft'
                          : 'border-line bg-surface/70 hover:bg-surface'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1 mb-1">
                        <span className="font-bold text-xs text-ink line-clamp-1">
                          {evt.title}
                        </span>
                        {isAssignedToMe && (
                          <span className="text-xs font-bold px-1.5 py-0.2 rounded bg-ok-bg text-ok shrink-0">
                            Assigned to You
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-ink-soft font-semibold mb-1">
                        <Calendar className="w-3 h-3 shrink-0" />
                        <span className="tnum">{formatWorkDate(evt.date)}</span>
                        {formatClockTime(evt.startTime) && <span>• {formatClockTime(evt.startTime)}</span>}
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-ink-soft truncate mb-2">
                        <MapPin className="w-3 h-3 shrink-0 text-ink-soft" />
                        <span className="truncate">{evt.location}</span>
                      </div>

                      {/* Progress Bar & Mashgiach Badge */}
                      <div className="flex items-center justify-between text-xs pt-2 border-t border-line">
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
          <div className={`min-w-0 flex-1 min-h-0 flex flex-col overflow-y-auto bg-surface p-6 max-md:p-4 ${phoneDetail ? '' : 'max-md:hidden'}`}>
            <button
              type="button"
              onClick={() => setPhoneDetail(false)}
              className="md:hidden self-start mb-3 min-h-11 px-3 -ml-1 inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-ink hover:bg-sunken cursor-pointer pressable"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              All events
            </button>
            {activeEvent ? (
              <div className="space-y-6">
                {/* Event Top Banner */}
                <div className="p-4.5 rounded-2xl border border-line-control e1">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-sunken text-ink">
                          Kosher Event
                        </span>
                        <span className="text-xs text-ink-soft font-medium">
                          Origin: <strong>{activeEvent.venueName || 'Supervised Venue'}</strong>
                        </span>
                      </div>
                      <h3 className="text-lg font-bold text-ink">
                        {activeEvent.title}
                      </h3>
                    </div>

                    {(canCopyActive || canDeleteActive) && (
                      <div className="flex items-center gap-1.5 self-start sm:self-auto">
                        {canCopyActive && (
                          <button
                            id="copy-event-btn"
                            onClick={() => onCopyEvent!(activeEvent)}
                            className="min-h-[44px] px-3 text-xs font-semibold rounded-lg transition cursor-pointer pressable flex items-center gap-1.5 bg-surface border border-line-control text-ink hover:bg-sunken"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            Copy event
                          </button>
                        )}
                        {canDeleteActive && (
                          <button
                            onClick={() => onDeleteEvent!(activeEvent.id)}
                            className="px-2.5 py-1 text-xs font-semibold rounded-lg transition cursor-pointer bg-surface border border-line-control text-bad hover:bg-sunken"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-bad" />
                            Delete Event
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Metadata Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-3 border-t border-line">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-ink-soft shrink-0" />
                      <div>
                        <div className="text-xs text-ink-soft font-semibold uppercase">Date & Time</div>
                        <div className="font-semibold text-ink">
                          {formatWorkDate(activeEvent.date)} {formatTimeRange(activeEvent.startTime, activeEvent.endTime) && `(${formatTimeRange(activeEvent.startTime, activeEvent.endTime)})`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-ink-soft shrink-0" />
                      <div>
                        <div className="text-xs text-ink-soft font-semibold uppercase">Location</div>
                        <div className="font-semibold text-ink truncate max-w-xs">
                          {activeEvent.location}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-ink-soft shrink-0" />
                      <div>
                        <div className="text-xs text-ink-soft font-semibold uppercase">Supervising Mashgiach</div>
                        <div className="font-semibold text-ink">
                          {canManageActive ? (
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
                              className="w-full font-bold px-2 py-1 mt-0.5 cursor-pointer min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
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
                              <span className="text-ok font-bold">
                                {activeEvent.assignedMashgiachName || activeEvent.assignedMashgiachEmail}
                              </span>
                            ) : activeEvent.mashgiachType === 'external' ? (
                              <span className="text-ink-soft font-bold">
                                {activeEvent.externalMashgiach?.name || 'External'} (Other)
                              </span>
                            ) : (
                              <span className="text-ink-soft italic">Unassigned</span>
                            )
                          )}
                        </div>
                        {/* QA2 #31: Notify again — the assignee only; same people as editing the event. */}
                        {canManageActive && activeEvent.mashgiachType === 'assigned_user' && !!activeEvent.assignedMashgiachEmail && (
                          <div className="mt-2 space-y-1.5">
                            <button
                              type="button"
                              data-notify-again
                              disabled={notifyBusy}
                              onClick={() => void handleNotifyAgain()}
                              className="min-h-11 px-3 text-xs font-semibold rounded-lg transition cursor-pointer pressable flex items-center gap-1.5 bg-surface border border-line-control text-ink hover:bg-sunken disabled:opacity-50"
                            >
                              <Bell className="w-3.5 h-3.5" />
                              {notifyBusy ? 'Sending…' : 'Notify again'}
                            </button>
                            {notifyNote && notifyNote.eventId === activeEvent.id && (
                              <p
                                role={notifyNote.ok ? 'status' : 'alert'}
                                data-notify-note
                                className={notifyNote.ok ? 'text-sm text-ink-soft font-normal' : 'text-sm text-bad font-normal'}
                              >
                                {notifyNote.text}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* If External Mashgiach, show contact card */}
                  {activeEvent.mashgiachType === 'external' && activeEvent.externalMashgiach && (
                    <div className="mt-3 p-3 rounded-xl bg-sunken border border-line-control text-xs flex flex-wrap items-center gap-4">
                      <span className="font-bold text-ink-soft">
                        External Mashgiach Contact:
                      </span>
                      {activeEvent.externalMashgiach.phone && (
                        <a
                          href={`tel:${activeEvent.externalMashgiach.phone}`}
                          className="flex items-center gap-1 text-ink-soft hover:text-gold-deep font-medium"
                        >
                          <Phone className="w-3 h-3 text-ink-soft" />
                          <span>{activeEvent.externalMashgiach.phone}</span>
                        </a>
                      )}
                      {activeEvent.externalMashgiach.email && (
                        <a
                          href={`mailto:${activeEvent.externalMashgiach.email}`}
                          className="flex items-center gap-1 text-ink-soft hover:text-gold-deep font-medium"
                        >
                          <Mail className="w-3 h-3 text-ink-soft" />
                          <span>{activeEvent.externalMashgiach.email}</span>
                        </a>
                      )}
                    </div>
                  )}

                  {/* Menu Attachment & Notes */}
                  {(activeEvent.menuAttachmentName || activeEvent.notes) && (
                    <div className="mt-3 pt-3 border-t border-line flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between text-xs">
                      {activeEvent.notes && (
                        <p className="text-ink-soft italic text-sm">
                          <strong>Guidance:</strong> {activeEvent.notes}
                        </p>
                      )}

                      {activeEvent.menuAttachmentName && (
                        <button
                          type="button"
                          onClick={() => handleViewMenu(activeEvent)}
                          className="px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0 e1 pressable bg-surface border border-line-control text-ink hover:bg-sunken"
                        >
                          <Paperclip className="w-3.5 h-3.5 text-ink-soft" />
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
                        <ShieldCheck className="w-4 h-4 text-ok" />
                        <span>Event Kashrut Verification Tasks</span>
                      </h4>
                      <p className="text-sm text-ink-soft">
                        Check off items as they are inspected on-site by the mashgiach.
                      </p>
                    </div>

                    <span className="text-xs font-bold text-ink-soft bg-sunken px-2.5 py-1 rounded-lg border border-line-control">
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
                              ? 'bg-ok-bg border-ok '
                              : 'bg-surface border-line'
                          }`}
                        >
                          {taskEdit && taskEdit.eventId === activeEvent.id && taskEdit.taskId === task.id ? (
                            <form
                              data-event-task-edit
                              className="flex flex-col gap-2"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void saveTaskEdit();
                              }}
                            >
                              <label htmlFor={`etask-title-${task.id}`} className="text-xs font-semibold text-ink-soft">
                                Task name
                              </label>
                              <input
                                id={`etask-title-${task.id}`}
                                type="text"
                                value={taskEdit.title}
                                maxLength={EVENT_TASK_TITLE_MAX}
                                autoFocus
                                onChange={(e) => setTaskEdit({ ...taskEdit, title: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') cancelTaskEdit();
                                }}
                                className="w-full min-h-11 px-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                              />
                              <label htmlFor={`etask-desc-${task.id}`} className="text-xs font-semibold text-ink-soft">
                                Details (optional)
                              </label>
                              <textarea
                                id={`etask-desc-${task.id}`}
                                rows={2}
                                value={taskEdit.description}
                                maxLength={EVENT_TASK_DESCRIPTION_MAX}
                                onChange={(e) => setTaskEdit({ ...taskEdit, description: e.target.value })}
                                className="w-full px-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                              />
                              {taskEditError && (
                                <p role="alert" className="text-sm text-bad">
                                  {taskEditError}
                                </p>
                              )}
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={cancelTaskEdit}
                                  disabled={taskEditBusy}
                                  className="min-h-11 px-4 text-sm font-semibold rounded-xl transition cursor-pointer pressable bg-surface border border-line-control text-ink hover:bg-sunken disabled:opacity-60"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="submit"
                                  disabled={taskEditBusy}
                                  className="min-h-11 px-4 text-sm font-bold rounded-xl transition cursor-pointer e1 pressable bg-gold-deep text-paper disabled:opacity-60"
                                >
                                  {taskEditBusy ? 'Saving…' : 'Save'}
                                </button>
                              </div>
                            </form>
                          ) : (
                          <>
                          <div className="flex items-start justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => handleToggleTask(task.id, task.isCompleted)}
                              className="flex items-start gap-2.5 text-left cursor-pointer flex-1"
                            >
                              {task.isCompleted ? (
                                <CheckCircle2 className="w-4 h-4 text-ok mt-0.5 shrink-0" />
                              ) : (
                                <Circle className="w-4 h-4 text-ink-soft mt-0.5 shrink-0" />
                              )}
                              <div>
                                <div
                                  className={`text-sm font-semibold ${
                                    task.isCompleted
                                      ? 'text-ok line-through opacity-85'
                                      : 'text-ink'
                                  }`}
                                >
                                  {task.title}
                                </div>
                                {task.description && (
                                  <p className="text-sm text-ink-soft mt-0.5">
                                    {task.description}
                                  </p>
                                )}
                              </div>
                            </button>

                            {task.isCompleted && (
                              <div className="text-right shrink-0">
                                <span className="text-xs font-bold text-ok block">
                                  ✓ Verified
                                </span>
                                {task.completedByName && (
                                  <span className="text-xs text-ink-soft block">
                                    by {task.completedByName}
                                  </span>
                                )}
                              </div>
                            )}

                            {canEditTaskWording && (
                              <button
                                type="button"
                                data-event-task-edit-button
                                onClick={() => startTaskEdit(task)}
                                aria-label={`Edit task: ${task.title}`}
                                title="Edit task"
                                className="shrink-0 -my-2 -mr-2 w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:text-ink hover:bg-sunken cursor-pointer pressable"
                              >
                                <Pencil className="w-4 h-4" aria-hidden="true" />
                              </button>
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
                              className="flex-1 px-2.5 py-1 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                            />
                          </div>
                          </>
                          )}
                        </div>
                      ))
                    ) : (
                      <div data-empty-state className="text-sm text-ink-soft">
                        <FileText className="w-6 h-6 mb-2" />
                        <p className="italic">No tasks added to this event yet.</p>
                        <p className="mt-2">Add the first task below.</p>
                      </div>
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
                      placeholder="Add an event task"
                      className="flex-1 px-3 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                    <button
                      type="button"
                      onClick={handleAddNewTaskToActiveEvent}
                      className="px-3.5 py-1.5 text-xs font-bold rounded-xl flex items-center gap-1 transition cursor-pointer e1 pressable bg-gold-deep text-paper"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Task</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-ink-soft">
                <Calendar className="w-12 h-12 mb-3 text-ink-soft opacity-40" />
                <h4 className="text-sm font-bold text-ink-soft">
                  No Event Selected
                </h4>
                <p className="text-sm text-ink-soft mt-1 max-w-sm">
                  Select an event from the left panel or tap "Create event" to add a catered dinner or banquet.
                </p>
                {canCreate && (
                <button
                  onClick={onOpenCreateEvent}
                  className="mt-4 px-4 py-2 text-xs font-bold rounded-xl e2 transition cursor-pointer pressable bg-surface border border-line-control text-ink hover:bg-sunken"
                >
                  + Create event
                </button>
                )}
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
            className="px-4 py-1.5 font-semibold text-xs rounded-xl transition cursor-pointer pressable bg-surface border border-line-control text-ink hover:bg-sunken"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
