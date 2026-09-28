import React, { useState, useRef } from 'react';
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
  const [venueId, setVenueId] = useState(currentVenue?.id || allVenues[0]?.id || '');
  const [location, setLocation] = useState(currentVenue?.address || '');
  const [date, setDate] = useState(() => {
    const tomorrow = new Date(Date.now() + 86400000);
    return tomorrow.toISOString().split('T')[0];
  });
  const [startTime, setStartTime] = useState('11:00 AM');
  const [endTime, setEndTime] = useState('16:00 PM');
  
  // Mashgiach Selection: 'assigned_user' | 'external' | 'unassigned'
  const [mashgiachMode, setMashgiachMode] = useState<'assigned_user' | 'external' | 'unassigned'>('assigned_user');
  const [selectedMashgiachEmail, setSelectedMashgiachEmail] = useState<string>(() => {
    // Default to first mashgiach in list if available
    const mashgiachList = availableMashgichim.filter(m => m.role === 'mashgiach');
    return mashgiachList[0]?.email || '';
  });
  
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

  // Starter tasks builder
  const [customTasks, setCustomTasks] = useState<string[]>([
    'Inspect Tamper-Evident Delivery Seals on Warmers & Cambros',
    'Ballroom Ovens & Warmers Pilot Ignition (Bishul Yisroel Check)',
    'Separate Meat & Dairy Station Buffets and Utensil Carts',
    'Post-Event Kashrut Wrap-up and Tagged Box Inspection',
  ]);
  const [newTaskInput, setNewTaskInput] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  // Filter mashgichim belonging to chosen venue or agency
  const relevantMashgichim = availableMashgichim.filter(
    (u) => u.role === 'mashgiach' && (!u.venueId || u.venueId === venueId)
  );

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

    if (mashgiachMode === 'external' && !extName.trim()) {
      setErrorMsg('Please specify the External Mashgiach Name.');
      return;
    }

    setIsLoading(true);

    try {
      const selectedMashgiachObj = availableMashgichim.find(
        (m) => m.email.toLowerCase() === selectedMashgiachEmail.toLowerCase()
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

      const res = await fetch('/api/events', {
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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/60 backdrop-blur-xs animate-fade-in overflow-y-auto"
    >
      <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-800 overflow-hidden my-6">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-stone-200/90 dark:border-stone-800 bg-stone-50/80 dark:bg-slate-850">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-600 to-amber-700 text-white flex items-center justify-center shadow-md shadow-amber-600/20">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900 dark:text-white tracking-tight">
                Notify & Register Kosher Event
              </h2>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Notify the Kashrut Admin & assign a Mashgiach with inspection tasks & menu.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
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
                <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                  Originating Establishment / Caterer *
                </label>
                <div className="relative">
                  <Building2 className="w-3.5 h-3.5 absolute left-3 top-2.5 text-stone-400" />
                  <select
                    value={venueId}
                    onChange={(e) => {
                      setVenueId(e.target.value);
                      const selected = allVenues.find((v) => v.id === e.target.value);
                      if (selected?.address) setLocation(selected.address);
                    }}
                    disabled={currentUser?.role === 'owner'}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500 disabled:opacity-70"
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
                <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                  Event Title / Occasion *
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Miller Wedding, Community Shabbat Dinner"
                  className="w-full px-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                Event Location / Ballroom Address *
              </label>
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-stone-400" />
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Beth El Synagogue Ballroom, 2626 Albany Ave"
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
                />
              </div>
            </div>

            {/* Date & Times */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                  Event Date *
                </label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 absolute left-3 top-2.5 text-stone-400" />
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                  Start Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-stone-400" />
                  <input
                    type="text"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder="e.g. 11:30 AM"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                  End Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-stone-400" />
                  <input
                    type="text"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder="e.g. 16:30 PM"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Mashgiach Assignment */}
          <div className="pt-3 border-t border-stone-200 dark:border-stone-800 space-y-3">
            <div className="flex items-center justify-between">
              <label className="font-bold text-stone-800 dark:text-stone-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>Mashgiach Assigned to Event</span>
              </label>
              <span className="text-[11px] text-stone-400">
                Supervisors receive real-time notification
              </span>
            </div>

            {/* Mode switcher: Registered vs Other/External vs Unassigned */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setMashgiachMode('assigned_user')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'assigned_user'
                    ? 'border-amber-500 bg-amber-50/90 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-bold ring-1 ring-amber-500'
                    : 'border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-slate-800 font-medium'
                }`}
              >
                Known Mashgiach
              </button>

              <button
                type="button"
                onClick={() => setMashgiachMode('external')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'external'
                    ? 'border-amber-600 bg-amber-100/70 dark:bg-amber-950/50 text-amber-900 dark:text-amber-200 font-bold ring-1 ring-amber-600'
                    : 'border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-slate-800 font-medium'
                }`}
              >
                Other / External
              </button>

              <button
                type="button"
                onClick={() => setMashgiachMode('unassigned')}
                className={`py-2 px-2.5 rounded-xl border text-center transition cursor-pointer ${
                  mashgiachMode === 'unassigned'
                    ? 'border-stone-400 bg-stone-100 dark:bg-slate-800 text-stone-900 dark:text-white font-bold ring-1 ring-stone-400'
                    : 'border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-slate-800 font-medium'
                }`}
              >
                Assign Later
              </button>
            </div>

            {/* If Known Mashgiach selected */}
            {mashgiachMode === 'assigned_user' && (
              <div className="p-3 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/50 rounded-xl space-y-2">
                <label className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                  Select Supervised Mashgiach:
                </label>
                <div className="relative">
                  <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-amber-600" />
                  <select
                    value={selectedMashgiachEmail}
                    onChange={(e) => setSelectedMashgiachEmail(e.target.value)}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800/80 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                  >
                    {relevantMashgichim.length === 0 ? (
                      <option value="">No venue mashgichim found - select Other</option>
                    ) : (
                      relevantMashgichim.map((m) => (
                        <option key={m.id} value={m.email}>
                          {m.name} ({m.email})
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <p className="text-[11px] text-amber-800 dark:text-amber-300 font-medium">
                  ✓ This mashgiach will receive an instant assignment badge and can access event checklists directly.
                </p>
              </div>
            )}

            {/* If Other / External mashgiach */}
            {mashgiachMode === 'external' && (
              <div className="p-3 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-xl space-y-2.5 animate-fade-in">
                <div className="text-xs font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                  <span>External Mashgiach Contact Information</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-semibold text-stone-700 dark:text-stone-300 mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={extName}
                      onChange={(e) => setExtName(e.target.value)}
                      placeholder="Rabbi / Mashgiach Name"
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-stone-700 dark:text-stone-300 mb-1">
                      Phone Number
                    </label>
                    <div className="relative">
                      <Phone className="w-3 h-3 absolute left-2.5 top-2.5 text-stone-400" />
                      <input
                        type="tel"
                        value={extPhone}
                        onChange={(e) => setExtPhone(e.target.value)}
                        placeholder="(860) 555-0192"
                        className="w-full pl-7.5 pr-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-stone-700 dark:text-stone-300 mb-1">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-3 h-3 absolute left-2.5 top-2.5 text-stone-400" />
                      <input
                        type="email"
                        value={extEmail}
                        onChange={(e) => setExtEmail(e.target.value)}
                        placeholder="mashgiach@email.com"
                        className="w-full pl-7.5 pr-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Menu Attachment & Kashrut Notes */}
          <div className="pt-3 border-t border-stone-200 dark:border-stone-800 space-y-3">
            <div>
              <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
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
                  className="px-3 py-2 rounded-xl border border-amber-200/90 dark:border-amber-800/80 bg-amber-50/60 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 hover:bg-amber-100/70 dark:hover:bg-amber-900/40 flex items-center gap-1.5 transition cursor-pointer font-medium shadow-2xs"
                >
                  <Paperclip className="w-3.5 h-3.5 text-amber-600" />
                  <span>{menuFileName ? 'Replace Menu File' : 'Upload Event Menu'}</span>
                </button>
                {menuFileName && (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-medium truncate max-w-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                    {menuFileName}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 dark:text-stone-300 mb-1">
                Kashrut Supervision Notes
              </label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Glatt Meat buffet; all pastries Parve; require unbroken Cambro delivery seals upon arrival."
                className="w-full px-3 py-2 text-xs rounded-xl bg-stone-50/70 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
              />
            </div>
          </div>

          {/* Section 4: Specific Event Tasks Checklist */}
          <div className="pt-3 border-t border-stone-200 dark:border-stone-800 space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-bold text-stone-800 dark:text-stone-200">
                Assigned Event Tasks ({customTasks.length})
              </label>
              <span className="text-[11px] text-stone-400">
                Mashgiach checks these off on-site
              </span>
            </div>

            <div className="space-y-1.5">
              {customTasks.map((t, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 rounded-lg bg-stone-50 dark:bg-slate-800 border border-stone-200/80 dark:border-stone-700/70"
                >
                  <span className="text-xs text-stone-800 dark:text-stone-200 flex items-center gap-2">
                    <FileText className="w-3 h-3 text-amber-600 shrink-0" />
                    {t}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTask(idx)}
                    className="p-1 text-stone-400 hover:text-rose-500 transition"
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
                placeholder="Add custom task (e.g. Verify wine bottle seals)"
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-stone-50 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500"
              />
              <button
                type="button"
                onClick={handleAddTask}
                className="px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold flex items-center gap-1 transition shadow-2xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-stone-200 dark:border-stone-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 font-semibold text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-slate-800 rounded-xl transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-5 py-2 font-bold rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white shadow-md shadow-amber-600/20 flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
