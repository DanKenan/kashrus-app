import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Calendar,
  Clock,
  MapPin,
  User,
  Paperclip,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
  FileText,
  Phone,
  Mail,
  ShieldCheck,
  Building2,
} from 'lucide-react';
import { KosherEvent, User as UserType, Venue } from '../types';
import { addDays, venueTimeZone, workDateIn } from '../lib/workday';
import { getRoleLabel } from '../lib/permissions';
import { apiFetch, apiWrite } from '../lib/api';
import { rosterDisplayHandle, rosterEmailLower } from '../lib/rosterDisplay';

// Staff roles that can be assigned to supervise an event — everyone on the
// team except venue owners. ('worker' is the app's Mashgiach role.)
const ASSIGNABLE_ROLES = ['admin', 'coordinator', 'mashgiach', 'worker'];

const normAgency = (a?: string | null) => a || 'agency-hkc';

export interface MashgiachGroups {
  thisVenue: UserType[];
  agencyWide: UserType[];
  otherVenues: UserType[];
}

/**
 * E1 (Don, 12:39 AM Oct 21): the Known Mashgiach list shows every assignable
 * person of the agency, the chosen venue's people first. Rule T, fail closed:
 * - no signed-in user -> nobody;
 * - same agency only (the roster payload is already agency-scoped by the
 *   server; this is defence in depth);
 * - admin -> the whole agency; anyone else (coordinator) -> own venue people
 *   plus the agency's admins, exactly what the server sends them
 *   (getSafeUsersForAgency); a non-admin with no venue -> nobody;
 * - venue owners are never assignable.
 */
export function groupAssignableMashgichim(
  users: UserType[] | null | undefined,
  currentUser: UserType | null | undefined,
  venueId: string
): MashgiachGroups {
  const groups: MashgiachGroups = { thisVenue: [], agencyWide: [], otherVenues: [] };
  if (!currentUser || typeof currentUser.role !== 'string') return groups;
  const isAdmin = currentUser.role === 'admin';
  const ownVenue = currentUser.venueId || '';
  if (!isAdmin && !ownVenue) return groups;
  const agency = normAgency(currentUser.agencyId);
  const byName = (a: UserType, b: UserType) => (a.name || '').localeCompare(b.name || '');
  const pool = (users || [])
    .filter((u) => !!u && normAgency(u.agencyId) === agency && ASSIGNABLE_ROLES.includes(u.role))
    .filter((u) => isAdmin || u.role === 'admin' || u.venueId === ownVenue)
    .sort(byName);
  for (const u of pool) {
    if (venueId && u.venueId === venueId) groups.thisVenue.push(u);
    else if (!u.venueId) groups.agencyWide.push(u);
    else groups.otherVenues.push(u);
  }
  return groups;
}

/** The ordered dropdown list: this venue, then agency-wide, then other venues. */
export function orderedMashgichim(groups: MashgiachGroups): UserType[] {
  return [...groups.thisVenue, ...groups.agencyWide, ...groups.otherVenues];
}

/**
 * The venue the dialog is really working on. A deliberate pick wins while it
 * is a real venue; otherwise the current venue, else the first venue, else ''
 * (venues still loading). Never a stale/empty id that the list cannot show.
 */
export function resolveEventVenueId(
  picked: string,
  currentVenueId: string | null | undefined,
  allVenues: { id: string }[]
): string {
  const has = (id?: string | null) => !!id && allVenues.some((v) => v.id === id);
  if (has(picked)) return picked;
  if (has(currentVenueId)) return currentVenueId as string;
  return allVenues[0]?.id || '';
}

/**
 * The mashgiach the dialog will submit: the manual pick while it is still in
 * the list (by email, case-insensitive); otherwise the first listed person
 * with an email; otherwise ''. Never an email that is not in the dropdown.
 */
export function resolveMashgiachEmail(picked: string, ordered: UserType[]): string {
  const p = (picked || '').toLowerCase();
  if (p) {
    const hit = ordered.find((m) => rosterEmailLower(m) === p);
    if (hit) return hit.email as string;
  }
  return ordered.find((m) => !!rosterEmailLower(m))?.email || '';
}

interface CreateEventModalProps {
  isOpen: boolean;
  onClose: () => void;
  onEventCreated: (event: KosherEvent) => void;
  currentUser: UserType | null;
  currentVenue: Venue | null;
  allVenues: Venue[];
  availableMashgichim: UserType[];
}

export const CreateEventModal: React.FC<CreateEventModalProps> = ({
  isOpen,
  onClose,
  onEventCreated,
  currentUser,
  currentVenue,
  allVenues,
  availableMashgichim,
}) => {
  const [title, setTitle] = useState('');
  // E1: the dialog stays mounted while closed, so nothing here may be
  // computed once at mount (App's venues/roster arrive after sign-in).
  // pickedVenueId is only the person's deliberate pick; the venue actually
  // used is derived on every render (resolveEventVenueId).
  const [pickedVenueId, setPickedVenueId] = useState('');
  const venueId = resolveEventVenueId(pickedVenueId, currentVenue?.id, allVenues);
  const venueReady = !!venueId && allVenues.some((v) => v.id === venueId);
  const [location, setLocation] = useState('');
  const locationTouched = useRef(false);
  // Item 6: default date = tomorrow in the selected venue's zone (calendar
  // arithmetic, so DST days are right); follows the venue field until the
  // date is edited by hand.
  const tomorrowAt = (vid: string) =>
    addDays(workDateIn(venueTimeZone(allVenues.find((v) => v.id === vid) || null, currentUser), new Date()), 1);
  const [date, setDate] = useState(() => tomorrowAt(venueId));
  const dateTouched = useRef(false);
  const [startTime, setStartTime] = useState('11:00 AM');
  const [endTime, setEndTime] = useState('16:00 PM');
  
  // Mashgiach Selection: 'assigned_user' | 'external' | 'unassigned'
  const [mashgiachMode, setMashgiachMode] = useState<'assigned_user' | 'external' | 'unassigned'>('assigned_user');
  // The manual pick only ('' = none); the submitted email is derived below.
  const [pickedMashgiachEmail, setPickedMashgiachEmail] = useState('');
  
  // External mashgiach fields if "Other"
  const [extName, setExtName] = useState('');
  const [extPhone, setExtPhone] = useState('');
  const [extEmail, setExtEmail] = useState('');
  
  // Menu attachment
  const [menuFileName, setMenuFileName] = useState('');
  const [menuDataUrl, setMenuDataUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notes
  const [notes, setNotes] = useState('');

  // Event tasks: pre-filled from the admin's default template set.
  // The creator deletes any that don't apply and adds event-specific ones.
  const [customTasks, setCustomTasks] = useState<string[]>([]);
  const [newTaskInput, setNewTaskInput] = useState('');

  // Default task templates (admin-managed, shared across events).
  const [templates, setTemplates] = useState<{ id: string; title: string }[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [newTemplateInput, setNewTemplateInput] = useState('');
  // Client mirror of server canManageTemplates (server.ts): default event
  // tasks are agency-wide config — ADMIN ONLY. A coordinator who had this
  // power loses it (rule T: agency-wide defaults are not a venue-level power).
  const canManageTemplates = currentUser?.role === 'admin';

  // Load the default task set each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setShowTemplateManager(false);
    setNewTemplateInput('');
    const agencyParam = currentUser?.agencyId ? `?agencyId=${encodeURIComponent(currentUser.agencyId)}` : '';
    apiFetch(`/api/event-task-templates${agencyParam}`)
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d.templates) ? d.templates : [];
        setTemplates(list);
        setCustomTasks(list.map((t: any) => t.title));
      })
      .catch(() => {
        setTemplates([]);
        setCustomTasks([]);
      });
  }, [isOpen]);

  // E1: every time the dialog opens, venue, address, date and the default
  // mashgiach start fresh from the current data (drafts of title, notes and
  // tasks are kept).
  useEffect(() => {
    if (!isOpen) return;
    setPickedVenueId('');
    setPickedMashgiachEmail('');
    locationTouched.current = false;
    dateTouched.current = false;
  }, [isOpen]);

  // Fill the address and the default date for the venue in use — when the
  // dialog opens, when the venue list arrives, or when the venue changes —
  // unless the person typed them by hand.
  const venueAddress = allVenues.find((v) => v.id === venueId)?.address || '';
  useEffect(() => {
    if (!isOpen) return;
    if (!locationTouched.current) setLocation(venueAddress);
    if (!dateTouched.current) setDate(tomorrowAt(venueId));
  }, [isOpen, venueId, venueAddress]);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  // E1: every assignable person of the agency (rule T), this venue first.
  const mashgiachGroups = groupAssignableMashgichim(availableMashgichim, currentUser, venueId);
  const relevantMashgichim = orderedMashgichim(mashgiachGroups);
  const seenMashgiachNames = new Set<string>();
  const duplicateMashgiachNames = new Set<string>();
  for (const person of relevantMashgichim) {
    const displayName = person.name.trim().toLowerCase();
    if (seenMashgiachNames.has(displayName)) duplicateMashgiachNames.add(displayName);
    seenMashgiachNames.add(displayName);
  }
  const selectedMashgiachEmail = resolveMashgiachEmail(pickedMashgiachEmail, relevantMashgichim);
  const venueNameOf = (id?: string) => allVenues.find((v) => v.id === id)?.name || '';

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setMenuFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setMenuDataUrl((event.target?.result as string) || '');
    };
    reader.readAsDataURL(file);
  };

  const handleAddTask = () => {
    if (newTaskInput.trim()) {
      setCustomTasks([...customTasks, newTaskInput.trim()]);
      setNewTaskInput('');
    }
  };

  const handleRemoveTask = (index: number) => {
    setCustomTasks(customTasks.filter((_, i) => i !== index));
  };

  const handleAddTemplate = async () => {
    const title = newTemplateInput.trim();
    if (!title) return;
    try {
      const result = await apiWrite('/api/event-task-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          agencyId: currentUser?.agencyId,
          userEmail: currentUser?.email,
        }),
      });
      if (!result.ok) throw new Error(result.error || 'Failed');
      // The endpoint returns the created template object directly (201).
      const template = result.data?.template ?? result.data;
      if (!template || !template.id) throw new Error('Could not save default task.');
      setTemplates([...templates, template]);
      setNewTemplateInput('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not save default task.');
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      const result = await apiWrite(`/api/event-task-templates/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: currentUser?.email }),
      });
      if (!result.ok) throw new Error(result.error || 'Failed');
      setTemplates(templates.filter((t) => t.id !== id));
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not delete default task.');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!title.trim()) {
      setErrorMsg('Event Title is required.');
      return;
    }
    if (!location.trim()) {
      setErrorMsg('Event Location address is required.');
      return;
    }
    if (!date) {
      setErrorMsg('Event Date is required.');
      return;
    }

    // E1: the venue shown must be the venue submitted.
    if (!venueReady) {
      setErrorMsg('Venues are still loading. Try again in a moment.');
      return;
    }

    if (mashgiachMode === 'assigned_user' && !selectedMashgiachEmail) {
      setErrorMsg('Choose a mashgiach from the list, or choose Other.');
      return;
    }

    if (mashgiachMode === 'external' && !extName.trim()) {
      setErrorMsg('Please specify the External Mashgiach Name.');
      return;
    }

    setIsLoading(true);

    try {
      const selectedMashgiachObj = availableMashgichim.find(
        (m) => rosterEmailLower(m) === selectedMashgiachEmail.toLowerCase()
      );

      const payload = {
        venueId,
        title: title.trim(),
        location: location.trim(),
        date,
        startTime,
        endTime,
        mashgiachType: mashgiachMode,
        assignedMashgiachEmail: mashgiachMode === 'assigned_user' ? selectedMashgiachEmail : undefined,
        assignedMashgiachName: mashgiachMode === 'assigned_user' ? selectedMashgiachObj?.name : undefined,
        externalMashgiach:
          mashgiachMode === 'external'
            ? {
                name: extName.trim(),
                phone: extPhone.trim(),
                email: extEmail.trim(),
              }
            : undefined,
        menuAttachmentName: menuFileName || undefined,
        menuAttachmentData: menuDataUrl || undefined,
        notes: notes.trim(),
        tasks: customTasks.map((t) => ({
          title: t,
          isCompleted: false,
        })),
        userEmail: currentUser?.email,
        userName: currentUser?.name,
      };

      const res = await apiFetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to submit event notification.');
      }

      const data = await res.json();
      onEventCreated(data.event);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred while saving the event.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      id="create-event-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-scrim backdrop-blur-sm animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-2xl rounded-2xl e3 border border-line overflow-hidden my-6 animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl text-ink flex items-center justify-center e2">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink tracking-tight">
                Notify & Register Kosher Event
              </h2>
              <p className="text-sm text-ink-soft">
                Notify the Kashrut Admin & assign a Mashgiach with inspection tasks & menu.
              </p>
            </div>
          </div>
          <button aria-label="Close"
            onClick={onClose}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-bad-bg border border-bad text-xs text-bad flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4.5 max-h-[75vh] overflow-y-auto text-xs">
          {/* Section 1: Event & Venue Identification */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  Originating Establishment / Caterer *
                </label>
                <div className="relative">
                  <Building2 className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <select
                    value={venueId}
                    onChange={(e) => {
                      setPickedVenueId(e.target.value);
                      // A deliberate venue change brings that venue's default mashgiach.
                      setPickedMashgiachEmail('');
                      if (!dateTouched.current) setDate(tomorrowAt(e.target.value));
                      const selected = allVenues.find((v) => v.id === e.target.value);
                      if (selected?.address) {
                        setLocation(selected.address);
                        locationTouched.current = false;
                      }
                    }}
                    disabled={currentUser?.role === 'owner'}
                    className="w-full pl-8.5 pr-3 py-2 focus:outline-none disabled:opacity-70 min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  >
                    {allVenues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.category})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  Event Title / Occasion *
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Event name"
                  className="w-full px-3 py-2 placeholder:text-ink-soft focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Event Location / Ballroom Address *
              </label>
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => {
                    locationTouched.current = true;
                    setLocation(e.target.value);
                  }}
                  placeholder="Venue or address"
                  className="w-full pl-8.5 pr-3 py-2 placeholder:text-ink-soft focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>

            {/* Date & Times */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  Event Date *
                </label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => {
                      dateTouched.current = true;
                      setDate(e.target.value);
                    }}
                    className="w-full pl-8.5 pr-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  Start Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <input
                    type="text"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder="Start time"
                    className="w-full pl-8.5 pr-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  End Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <input
                    type="text"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder="End time"
                    className="w-full pl-8.5 pr-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Mashgiach Assignment */}
          <div className="pt-3 border-t border-line space-y-3">
            <div className="flex items-center justify-between">
              <label className="font-bold text-ink flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-ink-soft" />
                <span>Mashgiach Assigned to Event</span>
              </label>
              <span className="text-xs text-ink-soft">
                Supervisors receive real-time notification
              </span>
            </div>

            {/* Mode switcher: Registered vs Other/External vs Unassigned */}
            <div className="grid grid-cols-3 gap-2 bg-sunken p-1 rounded-xl">
              <button
                type="button"
                onClick={() => setMashgiachMode('assigned_user')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'assigned_user'
                    ? 'border-line-control bg-surface text-ink font-semibold e1 pressable'
                    : 'border-line text-ink-soft hover:bg-sunken font-medium pressable'
                }`}
              >
                Known Mashgiach
              </button>

              <button
                type="button"
                onClick={() => setMashgiachMode('external')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'external'
                    ? 'border-line-control bg-surface text-ink font-semibold e1 pressable'
                    : 'border-line text-ink-soft hover:bg-sunken font-medium pressable'
                }`}
              >
                Other / External
              </button>

              <button
                type="button"
                onClick={() => setMashgiachMode('unassigned')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'unassigned'
                    ? 'border-line-control bg-surface text-ink font-semibold e1 pressable'
                    : 'border-line text-ink-soft hover:bg-sunken font-medium pressable'
                }`}
              >
                Assign Later
              </button>
            </div>

            {/* If Known Mashgiach selected */}
            {mashgiachMode === 'assigned_user' && (
              <div className="p-3 bg-sunken border border-line-control rounded-xl space-y-2">
                <label className="block text-xs font-semibold text-ink-soft">
                  Select Supervised Mashgiach:
                </label>
                <div className="relative">
                  <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <select
                    value={selectedMashgiachEmail}
                    onChange={(e) => setPickedMashgiachEmail(e.target.value)}
                    className="w-full pl-8.5 pr-3 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  >
                    {relevantMashgichim.length === 0 ? (
                      <option value="">No team members found - choose Other</option>
                    ) : (
                      ([
                        ['This venue', mashgiachGroups.thisVenue, false],
                        ['Agency-wide', mashgiachGroups.agencyWide, false],
                        ['Other venues', mashgiachGroups.otherVenues, true],
                      ] as [string, UserType[], boolean][])
                        .filter(([, list]) => list.length > 0)
                        .map(([label, list, showVenue]) => (
                          <optgroup key={label} label={label}>
                            {list.map((m) => (
                              <option key={m.id} value={m.email || ''}>
                                {m.name} — {getRoleLabel(m.role)}{m.email && duplicateMashgiachNames.has(m.name.trim().toLowerCase()) ? ` (${rosterDisplayHandle(m)})` : ''}
                                {showVenue && venueNameOf(m.venueId) ? ` · ${venueNameOf(m.venueId)}` : ''}
                              </option>
                            ))}
                          </optgroup>
                        ))
                    )}
                  </select>
                </div>
                <p className="text-sm text-ink-soft font-medium">
                  ✓ This mashgiach will receive an instant assignment badge and can access event checklists directly.
                </p>
              </div>
            )}

            {/* If Other / External mashgiach */}
            {mashgiachMode === 'external' && (
              <div className="p-3 bg-sunken border border-line-control rounded-xl space-y-2.5 animate-fade-in">
                <div className="text-xs font-bold text-ink-soft flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-ink-soft" />
                  <span>External Mashgiach Contact Information</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-semibold text-ink-soft mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={extName}
                      onChange={(e) => setExtName(e.target.value)}
                      placeholder="Rabbi / Mashgiach Name"
                      className="w-full px-2.5 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-ink-soft mb-1">
                      Phone Number
                    </label>
                    <div className="relative">
                      <Phone className="w-3 h-3 absolute left-2.5 top-2.5 text-ink-soft" />
                      <input
                        type="tel"
                        value={extPhone}
                        onChange={(e) => setExtPhone(e.target.value)}
                        placeholder="(860) 555-0192"
                        className="w-full pl-7.5 pr-2.5 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-ink-soft mb-1">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-3 h-3 absolute left-2.5 top-2.5 text-ink-soft" />
                      <input
                        type="email"
                        value={extEmail}
                        onChange={(e) => setExtEmail(e.target.value)}
                        placeholder="mashgiach@email.com"
                        className="w-full pl-7.5 pr-2.5 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Menu Attachment & Kashrut Notes */}
          <div className="pt-3 border-t border-line space-y-3">
            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Event Menu Attachment (PDF or Image)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-2 rounded-xl flex items-center gap-1.5 transition cursor-pointer font-medium e1 pressable bg-surface border border-line-control text-ink hover:bg-sunken"
                >
                  <Paperclip className="w-3.5 h-3.5 text-ink-soft" />
                  <span>{menuFileName ? 'Replace Menu File' : 'Upload Event Menu'}</span>
                </button>
                {menuFileName && (
                  <span className="text-xs text-ok flex items-center gap-1 font-medium truncate max-w-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-ok" />
                    {menuFileName}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Kashrut Supervision Notes
              </label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes for the mashgiach (optional)"
                className="w-full px-3 py-2 placeholder:text-ink-soft focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>

          {/* Section 4: Specific Event Tasks Checklist */}
          <div className="pt-3 border-t border-line space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-bold text-ink">
                Event Tasks ({customTasks.length})
              </label>
              <span className="text-xs text-ink-soft">
                Defaults loaded — delete any that don't apply
              </span>
            </div>

            <div className="space-y-1.5">
              {customTasks.map((t, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 rounded-lg bg-sunken border border-line/70"
                >
                  <span className="text-xs text-ink flex items-center gap-2">
                    <FileText className="w-3 h-3 text-ink-soft shrink-0" />
                    {t}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTask(idx)}
                    className="p-1 transition bg-surface border border-line-control text-bad hover:bg-sunken"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2 pt-1">
              <input
                type="text"
                value={newTaskInput}
                onChange={(e) => setNewTaskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTask();
                  }
                }}
                placeholder="Add a task for this event only"
                className="flex-1 px-3 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
              <button
                type="button"
                onClick={handleAddTask}
                className="px-3.5 py-1.5 rounded-lg font-semibold flex items-center gap-1 transition e1 pressable bg-surface border border-line-control text-ink hover:bg-sunken"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>

            {/* Default task templates — admin-managed, pre-fill every new event */}
            {canManageTemplates && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowTemplateManager(!showTemplateManager)}
                  className="text-xs font-bold hover:underline bg-surface border border-line-control text-ink hover:bg-sunken"
                >
                  {showTemplateManager ? '▾ Hide default tasks' : '▸ Edit default tasks for all events'}
                </button>
                {showTemplateManager && (
                  <div className="mt-2 p-3 rounded-xl bg-sunken border border-line-control space-y-1.5">
                    <p className="text-sm text-ink-soft">
                      These load automatically into every new event. Delete any that don't apply per event.
                    </p>
                    {templates.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center justify-between p-1.5 rounded-lg bg-sunken border border-line/70"
                      >
                        <span className="text-xs text-ink">{t.title}</span>
                        <button
                          type="button"
                          onClick={() => handleDeleteTemplate(t.id)}
                          className="p-1 transition bg-surface border border-line-control text-bad hover:bg-sunken"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <input
                        type="text"
                        value={newTemplateInput}
                        onChange={(e) => setNewTemplateInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTemplate();
                          }
                        }}
                        placeholder="New default task"
                        className="flex-1 px-3 py-1.5 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                      />
                      <button
                        type="button"
                        onClick={handleAddTemplate}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold transition bg-surface border border-line-control text-ink hover:bg-sunken"
                      >
                        Save as default
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-line flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 font-semibold rounded-xl transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !venueReady}
              className="px-5 py-2 font-bold rounded-xl e2 flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer pressable bg-gold-deep text-paper"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-paper border-t-transparent rounded-full animate-spin" />
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Notify & Create Event</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
