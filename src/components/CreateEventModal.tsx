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
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1a120a]/60 backdrop-blur-xs animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-2xl rounded-2xl tactile-5 border border-line overflow-hidden my-6 animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold to-gold-deep text-white flex items-center justify-center tactile-2">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink tracking-tight">
                Notify & Register Kosher Event
              </h2>
              <p className="text-xs text-ink-soft">
                Notify the Kashrut Admin & assign a Mashgiach with inspection tasks & menu.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink-soft hover:bg-sunken transition cursor-pointer"
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
                <label className="block font-semibold text-ink-soft mb-1">
                  Originating Establishment / Caterer *
                </label>
                <div className="relative">
                  <Building2 className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                  <select
                    value={venueId}
                    onChange={(e) => {
                      setVenueId(e.target.value);
                      const selected = allVenues.find((v) => v.id === e.target.value);
                      if (selected?.address) setLocation(selected.address);
                    }}
                    disabled={currentUser?.role === 'owner'}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold disabled:opacity-70"
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
                  placeholder="e.g. Miller Wedding, Community Shabbat Dinner"
                  className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Event Location / Ballroom Address *
              </label>
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Beth El Synagogue Ballroom, 2626 Albany Ave"
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
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
                  <Calendar className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  Start Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                  <input
                    type="text"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder="e.g. 11:30 AM"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-ink-soft mb-1">
                  End Time
                </label>
                <div className="relative">
                  <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                  <input
                    type="text"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder="e.g. 16:30 PM"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Mashgiach Assignment */}
          <div className="pt-3 border-t border-line space-y-3">
            <div className="flex items-center justify-between">
              <label className="font-bold text-ink flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-gold-deep" />
                <span>Mashgiach Assigned to Event</span>
              </label>
              <span className="text-[11px] text-ink-faint">
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
                    ? 'border-gold bg-gold-wash text-gold-ink font-bold ring-1 ring-gold/30 pressable'
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
                    ? 'border-gold bg-gold-wash text-gold-ink font-bold ring-1 ring-gold/30 pressable'
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
                    ? 'border-line-strong bg-sunken text-ink font-bold ring-1 ring-line-strong pressable'
                    : 'border-line text-ink-soft hover:bg-sunken font-medium pressable'
                }`}
              >
                Assign Later
              </button>
            </div>

            {/* If Known Mashgiach selected */}
            {mashgiachMode === 'assigned_user' && (
              <div className="p-3 bg-gold-wash border border-gold/40 rounded-xl space-y-2">
                <label className="block text-xs font-semibold text-ink-soft">
                  Select Supervised Mashgiach:
                </label>
                <div className="relative">
                  <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-gold-deep" />
                  <select
                    value={selectedMashgiachEmail}
                    onChange={(e) => setSelectedMashgiachEmail(e.target.value)}
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-lg bg-surface border border-gold/40 text-ink focus:outline-none focus:ring-2 focus:ring-gold/30"
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
                <p className="text-[11px] text-gold-ink font-medium">
                  ✓ This mashgiach will receive an instant assignment badge and can access event checklists directly.
                </p>
              </div>
            )}

            {/* If Other / External mashgiach */}
            {mashgiachMode === 'external' && (
              <div className="p-3 bg-gold-wash border border-gold/40 rounded-xl space-y-2.5 animate-fade-in">
                <div className="text-xs font-bold text-gold-ink flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-gold-deep" />
                  <span>External Mashgiach Contact Information</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-soft mb-1">
                      Full Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={extName}
                      onChange={(e) => setExtName(e.target.value)}
                      placeholder="Rabbi / Mashgiach Name"
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-gold/40 text-ink focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-soft mb-1">
                      Phone Number
                    </label>
                    <div className="relative">
                      <Phone className="w-3 h-3 absolute left-2.5 top-2.5 text-ink-faint" />
                      <input
                        type="tel"
                        value={extPhone}
                        onChange={(e) => setExtPhone(e.target.value)}
                        placeholder="(860) 555-0192"
                        className="w-full pl-7.5 pr-2.5 py-1.5 text-xs rounded-lg bg-surface border border-gold/40 text-ink focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-ink-soft mb-1">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-3 h-3 absolute left-2.5 top-2.5 text-ink-faint" />
                      <input
                        type="email"
                        value={extEmail}
                        onChange={(e) => setExtEmail(e.target.value)}
                        placeholder="mashgiach@email.com"
                        className="w-full pl-7.5 pr-2.5 py-1.5 text-xs rounded-lg bg-surface border border-gold/40 text-ink focus:outline-none focus:ring-2 focus:ring-gold"
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
                  className="px-3 py-2 rounded-xl border border-gold/40 bg-gold-wash text-gold-ink hover:bg-gold/20 flex items-center gap-1.5 transition cursor-pointer font-medium tactile-1 pressable"
                >
                  <Paperclip className="w-3.5 h-3.5 text-gold-deep" />
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
              <label className="block font-semibold text-ink-soft mb-1">
                Kashrut Supervision Notes
              </label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Glatt Meat buffet; all pastries Parve; require unbroken Cambro delivery seals upon arrival."
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
              />
            </div>
          </div>

          {/* Section 4: Specific Event Tasks Checklist */}
          <div className="pt-3 border-t border-line space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-bold text-ink">
                Assigned Event Tasks ({customTasks.length})
              </label>
              <span className="text-[11px] text-ink-faint">
                Mashgiach checks these off on-site
              </span>
            </div>

            <div className="space-y-1.5">
              {customTasks.map((t, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 rounded-lg bg-sunken border border-line/70"
                >
                  <span className="text-xs text-ink flex items-center gap-2">
                    <FileText className="w-3 h-3 text-gold-deep shrink-0" />
                    {t}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTask(idx)}
                    className="p-1 text-ink-faint hover:text-rose-500 transition"
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
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-sunken border border-line text-ink focus:outline-none focus:ring-2 focus:ring-gold/30 focus:border-gold"
              />
              <button
                type="button"
                onClick={handleAddTask}
                className="px-3.5 py-1.5 rounded-lg bg-gold hover:bg-gold-deep text-white font-semibold flex items-center gap-1 transition tactile-1 pressable"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-line flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 font-semibold text-ink-soft hover:bg-sunken rounded-xl transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-5 py-2 font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 flex items-center gap-1.5 transition disabled:opacity-50 cursor-pointer pressable"
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
