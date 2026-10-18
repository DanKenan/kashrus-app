import React, { useState, useEffect, useRef } from 'react';
import { X, Clock, Calendar, CheckSquare, Users, Plus, Trash2, CalendarDays, CheckCircle2, ListFilter } from 'lucide-react';
import { Task, TaskInputType } from '../types';
import { captureEditBaseline } from '../lib/api';
import { DAYS_MAP } from '../lib/utils';
import {
  categoryVars,
  categoryVarsForHue,
  PRESET_CATEGORIES,
  CATEGORY_PALETTE,
  loadCustomCategories,
  saveCustomCategory,
  deleteCustomCategory,
  refreshCustomCategories,
  type CustomCategory,
} from '../lib/categoryStyle';
import { MonthlyCalendarPicker } from './MonthlyCalendarPicker';

/** Structured time value: 12-hour clock the app can reliably process. */
export interface PickerTime {
  hour: number; // 1-12
  minute: number; // 0-59
  ampm: 'AM' | 'PM';
}

export function parseTimeText(text: string | undefined | null): PickerTime | null {
  if (!text) return null;
  const s = text.trim();
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (m12) {
    const h = parseInt(m12[1], 10);
    const m = parseInt(m12[2], 10);
    if (h >= 1 && h <= 12 && m <= 59) return { hour: h, minute: m, ampm: /^[Pp]/.test(m12[3]) ? 'PM' : 'AM' };
    return null;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const m = parseInt(m24[2], 10);
    if (h <= 23 && m <= 59) {
      const ampm = h >= 12 ? 'PM' : 'AM';
      return { hour: h % 12 === 0 ? 12 : h % 12, minute: m, ampm };
    }
  }
  return null;
}

export function formatPickerTime(t: PickerTime): string {
  return `${t.hour}:${String(t.minute).padStart(2, '0')} ${t.ampm}`;
}

export function pickerTimeToMinutes(t: PickerTime): number {
  let h = t.hour % 12;
  if (t.ampm === 'PM') h += 12;
  return h * 60 + t.minute;
}

const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/** One row: hour : minute + AM/PM toggle. Big enough for fingers. */
function TimePickerRow({
  value,
  onChange,
  onRemove,
}: {
  value: PickerTime;
  onChange: (t: PickerTime) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={value.hour}
        onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })}
        className="text-sm font-bold px-2 py-2 rounded-xl border border-line bg-sunken text-ink focus:border-gold focus:outline-none"
        aria-label="Hour"
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
      <span className="font-black text-ink-soft">:</span>
      <select
        value={value.minute}
        onChange={(e) => onChange({ ...value, minute: Number(e.target.value) })}
        className="text-sm font-bold px-2 py-2 rounded-xl border border-line bg-sunken text-ink focus:border-gold focus:outline-none"
        aria-label="Minute"
      >
        {MINUTE_OPTIONS.map((m) => (
          <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
        ))}
      </select>
      <div className="flex rounded-xl border border-line overflow-hidden">
        {(['AM', 'PM'] as const).map((ap) => (
          <button
            key={ap}
            type="button"
            onClick={() => onChange({ ...value, ampm: ap })}
            className={`px-3 py-2 text-sm font-black transition-colors ${
              value.ampm === ap ? 'bg-gold-deep text-white' : 'bg-sunken text-ink-soft'
            }`}
          >
            {ap}
          </button>
        ))}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-2 rounded-xl text-ink-faint hover:text-red-600"
          aria-label="Remove second time"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (taskData: Partial<Task>, opts?: { baselineVersion?: number }) => Promise<boolean> | void;
  taskToEdit?: Task | null;
  knownWorkers: Array<{ email: string; name: string }>;
  currentUserEmail?: string | null;
}

const PRESET_STATUS_GROUPS = [
  {
    name: 'Standard',
    options: ['Pending', 'In Progress', 'Blocked', 'Completed'],
    completed: ['Completed'],
  },
  {
    name: 'QC & Inspection',
    options: ['Not Checked', 'In Inspection', 'Passed', 'Needs Rework', 'Failed'],
    completed: ['Passed'],
  },
  {
    name: 'Receiving & Dock',
    options: ['Awaiting Delivery', 'Received & Counted', 'Discrepancy / Damaged', 'Rejected'],
    completed: ['Received & Counted'],
  },
  {
    name: 'Simple Workflow',
    options: ['To Do', 'Doing', 'Done'],
    completed: ['Done'],
  },
];

export const TaskModal: React.FC<TaskModalProps> = ({
  isOpen,
  onClose,
  onSave,
  taskToEdit,
  knownWorkers,
  currentUserEmail,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([PRESET_CATEGORIES[0]]);
  const [inputType, setInputType] = useState<TaskInputType>('yes_no');
  // Structured times — the app can reliably sort and process these.
  const [time1, setTime1] = useState<PickerTime>({ hour: 9, minute: 0, ampm: 'AM' });
  const [time2, setTime2] = useState<PickerTime | null>(null);
  // Free-text fallback for non-clock times like "End of Shift".
  const [customTimeText, setCustomTimeText] = useState<string | null>(null);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [enableOverdueAlert, setEnableOverdueAlert] = useState(false);
  const [assignType, setAssignType] = useState<'all' | 'specific'>('all');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [customWorkerEmail, setCustomWorkerEmail] = useState('');
  const [visibleToTeam, setVisibleToTeam] = useState(true);

  // Category picker state — presets + the user's own saved customs.
  const [customCats, setCustomCats] = useState<CustomCategory[]>([]);
  const [showOtherForm, setShowOtherForm] = useState(false);
  const [otherName, setOtherName] = useState('');
  const [otherHue, setOtherHue] = useState<number>(CATEGORY_PALETTE[0]);
  const [confirmDeleteCat, setConfirmDeleteCat] = useState<string | null>(null);

  // All pickable categories: presets, the user's saved customs, and — when
  // editing an older task — its current values so nothing silently changes.
  const categoryOptions: string[] = [...PRESET_CATEGORIES];
  for (const c of customCats) {
    if (!categoryOptions.some((o) => o.toLowerCase() === c.name.toLowerCase())) {
      categoryOptions.push(c.name);
    }
  }
  const legacyCategories: string[] = [];
  for (const lc of selectedCategories) {
    const t = lc.trim();
    if (t.length > 0 && !categoryOptions.some((o) => o.toLowerCase() === t.toLowerCase())) {
      legacyCategories.push(t);
    }
  }
  for (const lc of legacyCategories) categoryOptions.push(lc);

  const isCustomCat = (name: string) =>
    customCats.some((c) => c.name.toLowerCase() === name.toLowerCase());

  const isSelectedCat = (name: string) =>
    selectedCategories.some((s) => s.toLowerCase() === name.toLowerCase());

  const toggleCategory = (name: string) => {
    setSelectedCategories((prev) =>
      prev.some((s) => s.toLowerCase() === name.toLowerCase())
        ? prev.filter((s) => s.toLowerCase() !== name.toLowerCase())
        : [...prev, name]
    );
    setShowOtherForm(false);
    setConfirmDeleteCat(null);
  };

  const addCustomCategory = () => {
    const name = otherName.trim();
    if (!name || !currentUserEmail) return;
    const updated = saveCustomCategory(currentUserEmail, { name, hue: otherHue });
    setCustomCats(updated);
    setSelectedCategories((prev) =>
      prev.some((s) => s.toLowerCase() === name.toLowerCase()) ? prev : [...prev, name]
    );
    setShowOtherForm(false);
    setOtherName('');
    setOtherHue(CATEGORY_PALETTE[0]);
  };

  const removeCustomCategory = (name: string) => {
    if (confirmDeleteCat !== name) {
      setConfirmDeleteCat(name); // first tap arms, second tap deletes
      return;
    }
    if (currentUserEmail) {
      setCustomCats(deleteCustomCategory(currentUserEmail, name));
    }
    setConfirmDeleteCat(null);
    setSelectedCategories((prev) => prev.filter((s) => s.toLowerCase() !== name.toLowerCase()));
  };

  // Custom Status Select State
  const [customStatusOptions, setCustomStatusOptions] = useState<string[]>([
    'Pending',
    'In Progress',
    'Blocked',
    'Completed',
  ]);
  const [completedStatusValues, setCompletedStatusValues] = useState<string[]>(['Completed']);
  const [newOptionInput, setNewOptionInput] = useState('');

  // Schedule State: Recurring Days vs Specific Calendar Dates
  const [scheduleType, setScheduleType] = useState<'recurring' | 'specific_dates'>('recurring');
  const [selectedDays, setSelectedDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);

  // Synchronous guard against double-submit (double-click / Enter+click firing
  // handleSubmit twice before the modal unmounts).
  const submitGuard = useRef(false);
  // ROUND 5 — write baseline for this edit form. Captured when the modal
  // loads taskToEdit (what the user sees), NOT at save time (by then a
  // WebSocket update may have bumped the tracked version past the form).
  const baselineRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    submitGuard.current = false;
    const todayStr = new Date().toISOString().split('T')[0];

    // Load this user's saved custom categories ("Other" entries).
    setCustomCats(loadCustomCategories(currentUserEmail));
    refreshCustomCategories(currentUserEmail);
    setShowOtherForm(false);
    setOtherName('');
    setOtherHue(CATEGORY_PALETTE[0]);
    setConfirmDeleteCat(null);

    if (taskToEdit) {
      // Capture the write baseline NOW — the form renders taskToEdit's data,
      // so the baseline is the version the user is looking at.
      baselineRef.current = captureEditBaseline();
      setTitle(taskToEdit.title);
      setDescription(taskToEdit.description || '');
      setSelectedCategories(
        taskToEdit.categories && taskToEdit.categories.length > 0
          ? [...taskToEdit.categories]
          : [taskToEdit.category || 'General']
      );
      setInputType(taskToEdit.inputType || 'yes_no');
      // Load times: structured when parseable, free-text otherwise.
      const t1 = parseTimeText(taskToEdit.targetTime);
      if (t1) {
        setTime1(t1);
        setCustomTimeText(null);
      } else {
        setTime1({ hour: 9, minute: 0, ampm: 'AM' });
        setCustomTimeText(taskToEdit.targetTime || null);
      }
      const t2 = parseTimeText(taskToEdit.targetTime2);
      setTime2(t2);
      setPriority(taskToEdit.priority || 'medium');
      setEnableOverdueAlert(taskToEdit.enableOverdueAlert === true);
      if (taskToEdit.assignedTo.includes('all')) {
        setAssignType('all');
        setSelectedWorkers([]);
      } else {
        setAssignType('specific');
        setSelectedWorkers(taskToEdit.assignedTo);
      }
      setVisibleToTeam(!taskToEdit.isPrivate);

      // Schedule
      setScheduleType(taskToEdit.scheduleType || 'recurring');
      setSelectedDays(taskToEdit.daysOfWeek || [0, 1, 2, 3, 4, 5, 6]);
      setSelectedDates(
        taskToEdit.specificDates && taskToEdit.specificDates.length > 0
          ? taskToEdit.specificDates
          : [todayStr]
      );

      // Custom Status Options
      if (taskToEdit.customStatusOptions && taskToEdit.customStatusOptions.length > 0) {
        setCustomStatusOptions(taskToEdit.customStatusOptions);
      } else {
        setCustomStatusOptions(['Pending', 'In Progress', 'Blocked', 'Completed']);
      }

      if (taskToEdit.completedStatusValues && taskToEdit.completedStatusValues.length > 0) {
        setCompletedStatusValues(taskToEdit.completedStatusValues);
      } else {
        setCompletedStatusValues(['Completed']);
      }
    } else {
      baselineRef.current = undefined; // create — no baseline needed
      setTitle('');
      setDescription('');
      setSelectedCategories([PRESET_CATEGORIES[0]]);
      setInputType('yes_no');
      setTime1({ hour: 9, minute: 0, ampm: 'AM' });
      setTime2(null);
      setCustomTimeText(null);
      setPriority('medium');
      setEnableOverdueAlert(false);
      setAssignType('all');
      setSelectedWorkers([]);
      setVisibleToTeam(true);
      setScheduleType('recurring');
      setSelectedDays([0, 1, 2, 3, 4, 5, 6]);
      setSelectedDates([todayStr]);
      setCustomStatusOptions(['Pending', 'In Progress', 'Blocked', 'Completed']);
      setCompletedStatusValues(['Completed']);
      setNewOptionInput('');
    }
  }, [taskToEdit, isOpen]);

  if (!isOpen) return null;

  const toggleDay = (dayIndex: number) => {
    if (selectedDays.includes(dayIndex)) {
      if (selectedDays.length === 1) return; // Keep at least one day
      setSelectedDays(selectedDays.filter((d) => d !== dayIndex));
    } else {
      setSelectedDays([...selectedDays, dayIndex].sort());
    }
  };

  const toggleWorker = (email: string) => {
    if (selectedWorkers.includes(email)) {
      setSelectedWorkers(selectedWorkers.filter((w) => w !== email));
    } else {
      setSelectedWorkers([...selectedWorkers, email]);
    }
  };

  const handleAddCustomWorker = () => {
    if (customWorkerEmail && customWorkerEmail.includes('@') && !selectedWorkers.includes(customWorkerEmail)) {
      setSelectedWorkers([...selectedWorkers, customWorkerEmail.trim()]);
      setCustomWorkerEmail('');
    }
  };

  // Custom Status Option Handlers
  const handleAddStatusOption = () => {
    const trimmed = newOptionInput.trim();
    if (!trimmed) return;
    if (!customStatusOptions.some((opt) => opt.toLowerCase() === trimmed.toLowerCase())) {
      const updated = [...customStatusOptions, trimmed];
      setCustomStatusOptions(updated);
      setNewOptionInput('');
    }
  };

  const handleRemoveStatusOption = (optionToRemove: string) => {
    if (customStatusOptions.length <= 1) return; // keep at least one
    const updated = customStatusOptions.filter((opt) => opt !== optionToRemove);
    setCustomStatusOptions(updated);
    setCompletedStatusValues(completedStatusValues.filter((v) => v !== optionToRemove));
  };

  const toggleOptionCompleted = (option: string) => {
    if (completedStatusValues.includes(option)) {
      // Don't deselect if it's the only completed option
      if (completedStatusValues.length > 1) {
        setCompletedStatusValues(completedStatusValues.filter((v) => v !== option));
      }
    } else {
      setCompletedStatusValues([...completedStatusValues, option]);
    }
  };

  const applyStatusPreset = (preset: typeof PRESET_STATUS_GROUPS[0]) => {
    setCustomStatusOptions(preset.options);
    setCompletedStatusValues(preset.completed);
  };

  // Monthly Calendar Handlers
  const handleToggleDate = (dateStr: string) => {
    if (selectedDates.includes(dateStr)) {
      setSelectedDates(selectedDates.filter((d) => d !== dateStr));
    } else {
      setSelectedDates([...selectedDates, dateStr].sort());
    }
  };

  const handleSelectToday = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    if (!selectedDates.includes(todayStr)) {
      setSelectedDates([...selectedDates, todayStr].sort());
    }
  };

  const handleSelectTomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const tomorrowStr = d.toISOString().split('T')[0];
    if (!selectedDates.includes(tomorrowStr)) {
      setSelectedDates([...selectedDates, tomorrowStr].sort());
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (submitGuard.current) return;
    submitGuard.current = true;

    const assignedTo = assignType === 'all' || selectedWorkers.length === 0 ? ['all'] : selectedWorkers;

    // Validate dates if specific_dates is chosen
    let finalDates = selectedDates;
    if (scheduleType === 'specific_dates' && finalDates.length === 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      finalDates = [todayStr];
    }

    const saved = await onSave({
      ...(taskToEdit ? { id: taskToEdit.id } : {}),
      title: title.trim(),
      description: description.trim(),
      category: (selectedCategories[0] || 'General').trim(),
      categories: selectedCategories.length > 0 ? selectedCategories.map((c) => c.trim()) : ['General'],
      isPrivate: assignType === 'specific' && selectedWorkers.length > 0 && !visibleToTeam,
      inputType,
      customStatusOptions: inputType === 'status_select' ? customStatusOptions : undefined,
      completedStatusValues: inputType === 'status_select' ? completedStatusValues : undefined,
      // Structured times when set via picker; custom text clears the minutes.
      targetTime: customTimeText !== null ? customTimeText.trim() : formatPickerTime(time1),
      targetTimeMinutes: customTimeText !== null ? null : pickerTimeToMinutes(time1),
      targetTime2: time2 ? formatPickerTime(time2) : '',
      targetTime2Minutes: time2 ? pickerTimeToMinutes(time2) : null,
      priority,
      enableOverdueAlert,
      assignedTo,
      scheduleType,
      daysOfWeek: selectedDays,
      specificDates: scheduleType === 'specific_dates' ? finalDates : undefined,
    }, { baselineVersion: baselineRef.current });

    // Only close on a confirmed save — on failure the modal stays open with
    // the user's input intact so they can review and retry.
    if (saved === false) {
      submitGuard.current = false;
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm overflow-y-auto">
      <div className="bg-surface rounded-3xl w-full max-w-xl tactile-5 animate-pop-in border border-line my-8 overflow-hidden transition-colors max-h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line/70 shrink-0">
          <div>
            <h2 className="text-base font-bold text-ink">
              {taskToEdit ? 'Edit Task Assignment' : 'Create New Task Assignment'}
            </h2>
            <p className="text-xs text-ink-faint">
              Configure fields, completion input options, visibility, and schedule.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body - Scrollable */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
          
          {/* Task Title */}
          <div>
            <label className="block font-semibold text-ink-soft mb-1">
              Task Title <span className="text-rose-500">*</span>
            </label>
            <input
              id="task-title-input"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Check temperature logs in refrigeration unit"
              className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border border-line bg-sunken text-ink focus:outline-none focus:border-gold"
            />
          </div>

          {/* Description / Instructions */}
          <div>
            <label className="block font-semibold text-ink-soft mb-1">
              Instructions / Description
            </label>
            <textarea
              id="task-desc-input"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Step-by-step guidance for mashgichim when completing this daily assignment..."
              className="w-full text-xs px-3.5 py-2 rounded-xl border border-line bg-sunken text-ink focus:outline-none focus:border-gold"
            />
          </div>

          {/* 2-Column: Category & Input Type */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Categories <span className="text-[10px] font-normal text-ink-faint">(tap to add / remove — pick as many as fit)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {categoryOptions.map((c) => {
                  const selected = isSelectedCat(c);
                  const custom = isCustomCat(c);
                  return (
                    <span
                      key={c}
                      style={categoryVars(c)}
                      className={`inline-flex items-center gap-1 pl-2 ${
                        custom ? 'pr-1' : 'pr-2.5'
                      } py-1 rounded-full text-[11px] font-bold border transition tactile-1 pressable ${
                        selected
                          ? 'cat-chip-selected ring-2 ring-offset-1 cat-ring scale-[1.03]'
                          : 'cat-chip hover:border-line-strong'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleCategory(c)}
                        className="inline-flex items-center gap-1.5 cursor-pointer"
                        title={selected ? 'Tap to remove' : 'Tap to add'}
                        aria-pressed={selected}
                      >
                        {selected ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <span className="cat-dot w-2 h-2 rounded-full shrink-0" />
                        )}
                        {c}
                      </button>
                      {custom && (
                        <button
                          type="button"
                          onClick={() => removeCustomCategory(c)}
                          title={confirmDeleteCat === c ? 'Tap again to delete' : 'Delete this category'}
                          className={`shrink-0 w-4.5 h-4.5 p-0.5 rounded-full inline-flex items-center justify-center transition cursor-pointer ${
                            confirmDeleteCat === c
                              ? 'bg-red-500 text-white'
                              : 'text-ink-faint hover:text-red-600 hover:bg-red-500/10'
                          }`}
                        >
                          {confirmDeleteCat === c ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <X className="w-3 h-3" />
                          )}
                        </button>
                      )}
                    </span>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setShowOtherForm((v) => !v);
                    setConfirmDeleteCat(null);
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border border-dashed transition cursor-pointer tactile-1 ${
                    showOtherForm
                      ? 'border-gold bg-gold-wash text-gold-ink'
                      : 'border-line-strong text-ink-soft hover:border-gold hover:text-gold-ink'
                  }`}
                >
                  <Plus className="w-3 h-3" />
                  Other…
                </button>
              </div>

              {showOtherForm && (
                <div className="mt-2 p-3 rounded-2xl bg-sunken border border-line tactile-1 animate-fade-in">
                  <label className="block text-[11px] font-bold text-ink-soft mb-1">
                    Name your category
                  </label>
                  <input
                    type="text"
                    value={otherName}
                    onChange={(e) => setOtherName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustomCategory();
                      }
                    }}
                    placeholder="e.g. Pesach Prep"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
                  />
                  <label className="block text-[11px] font-bold text-ink-soft mt-2.5 mb-1.5">
                    Pick its color
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {CATEGORY_PALETTE.map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setOtherHue(h)}
                        style={categoryVarsForHue(h)}
                        title={`Color ${h}°`}
                        className={`cat-dot w-7 h-7 rounded-full transition cursor-pointer pressable ${
                          otherHue === h ? 'ring-2 ring-offset-2 ring-gold cat-ring' : 'hover:scale-110'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <span
                      className="cat-chip inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border"
                      style={categoryVarsForHue(otherHue)}
                    >
                      <span className="cat-dot w-2 h-2 rounded-full" />
                      <span className="cat-text">{otherName.trim() || 'Preview'}</span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowOtherForm(false)}
                        className="px-3 py-1.5 rounded-xl text-[11px] font-bold text-ink-soft hover:text-ink transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={addCustomCategory}
                        disabled={!otherName.trim()}
                        className="px-3.5 py-1.5 rounded-xl text-[11px] font-black bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 pressable transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save category
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <p className="text-[10px] text-ink-faint mt-1.5 leading-snug">
                Your <em>Other</em> categories are saved for next time — tap the × on one to remove it.
              </p>
            </div>

            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Completion Input Type
              </label>
              <select
                id="task-input-type-select"
                value={inputType}
                onChange={(e) => setInputType(e.target.value as TaskInputType)}
                className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink"
              >
                <option value="yes_no">Yes / No Button Pair</option>
                <option value="toggle">On / Off Toggle Switch</option>
                <option value="status_select">Status Select (Customizable Values)</option>
                <option value="checkbox">Standard Checkbox</option>
                <option value="check_in">Repeatable Check-in — log who + when on every tap</option>
              </select>
            </div>
          </div>

          {/* CUSTOM STATUS VALUES BUILDER (When inputType === 'status_select') */}
          {inputType === 'status_select' && (
            <div className="p-3.5 bg-sunken rounded-2xl border border-gold/30 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ListFilter className="w-4 h-4 text-gold-deep" />
                  <span className="font-bold text-ink text-xs">
                    Custom Status Values
                  </span>
                </div>
                <span className="text-[11px] text-ink-faint">
                  Staff choose from these values
                </span>
              </div>

              {/* Preset Quick Select */}
              <div>
                <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">
                  Quick Presets:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_STATUS_GROUPS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => applyStatusPreset(preset)}
                      className="px-2 py-0.5 text-[11px] font-medium rounded-lg bg-surface text-ink-soft border border-line hover:border-gold hover:text-gold-deep transition"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Current Status Options List */}
              <div className="space-y-1.5">
                <div className="text-[10px] font-semibold text-ink-faint flex items-center justify-between">
                  <span>Current Options (Click checkmark to toggle &quot;Counts as Done&quot;):</span>
                  <span>{customStatusOptions.length} values</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {customStatusOptions.map((opt) => {
                    const isCompleted = completedStatusValues.includes(opt);
                    return (
                      <div
                        key={opt}
                        className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-xl text-xs font-semibold border transition ${
                          isCompleted
                            ? 'bg-emerald-50 dark:bg-emerald-950/70 border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200'
                            : 'bg-surface border-line text-ink-soft'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleOptionCompleted(opt)}
                          className="flex items-center gap-1 hover:opacity-80"
                          title={isCompleted ? 'Marked as completed status (click to toggle)' : 'Not completed (click to mark as completed)'}
                        >
                          <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] ${
                            isCompleted ? 'bg-emerald-600 text-white' : 'border border-line-strong'
                          }`}>
                            {isCompleted ? '✓' : ''}
                          </span>
                          <span>{opt}</span>
                          {isCompleted && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-200 dark:bg-emerald-800 text-emerald-900 dark:text-emerald-100 font-bold uppercase">
                              Done
                            </span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleRemoveStatusOption(opt)}
                          disabled={customStatusOptions.length <= 1}
                          className="p-1 text-ink-faint hover:text-rose-500 rounded hover:bg-sunken disabled:opacity-30"
                          title="Delete status option"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Add New Status Option Input */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  value={newOptionInput}
                  onChange={(e) => setNewOptionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddStatusOption();
                    }
                  }}
                  placeholder="Type new status value (e.g. Needs Manager Sign-off)..."
                  className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-line bg-sunken text-ink"
                />
                <button
                  type="button"
                  onClick={handleAddStatusOption}
                  className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white transition tactile-1 flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Value</span>
                </button>
              </div>
            </div>
          )}

          {/* 2-Column: Target Time & Priority */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-ink-soft mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-ink-faint" /> Target Time
              </label>
              {customTimeText !== null ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customTimeText}
                    onChange={(e) => setCustomTimeText(e.target.value)}
                    placeholder="e.g. End of Shift"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomTimeText(null)}
                    className="text-xs font-bold text-gold-deep whitespace-nowrap"
                  >
                    Use clock
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <TimePickerRow value={time1} onChange={setTime1} />
                  {time2 ? (
                    <TimePickerRow value={time2} onChange={setTime2} onRemove={() => setTime2(null)} />
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setTime1({ hour: 9, minute: 0, ampm: 'AM' })}
                        className="text-xs font-bold px-2.5 py-1.5 rounded-xl border border-line bg-sunken text-ink hover:border-gold"
                      >
                        ☀️ Morning
                      </button>
                      <button
                        type="button"
                        onClick={() => setTime1({ hour: 3, minute: 0, ampm: 'PM' })}
                        className="text-xs font-bold px-2.5 py-1.5 rounded-xl border border-line bg-sunken text-ink hover:border-gold"
                      >
                        🌤️ Afternoon
                      </button>
                      <button
                        type="button"
                        onClick={() => setTime2({ hour: 3, minute: 0, ampm: 'PM' })}
                        className="text-xs font-bold px-2.5 py-1.5 rounded-xl border border-dashed border-gold/60 text-gold-deep"
                      >
                        + Second time
                      </button>
                      <button
                        type="button"
                        onClick={() => setCustomTimeText('')}
                        className="text-xs text-ink-faint underline"
                      >
                        Custom text
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Priority
              </label>
              <select
                id="task-priority-select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as any)}
                className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink"
              >
                <option value="low">Low Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="high">High (Urgent)</option>
              </select>
            </div>
          </div>

          {/* Overdue Alert Toggle */}
          <label className="flex items-center gap-2.5 p-3 rounded-xl border border-line bg-sunken cursor-pointer">
            <input
              type="checkbox"
              checked={enableOverdueAlert}
              onChange={(e) => setEnableOverdueAlert(e.target.checked)}
              className="w-4 h-4 rounded accent-gold"
            />
            <div>
              <div className="text-xs font-bold">Overdue push alert</div>
              <div className="text-[11px] text-ink-faint">
                Notify assigned mashgichim if this task passes its target time
              </div>
            </div>
          </label>

          {/* SCHEDULE SECTION: Recurring Days vs One-Time / Monthly Calendar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block font-semibold text-ink-soft flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-ink-faint" /> Schedule Mode
              </label>
            </div>

            {/* Switcher Tabs */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-sunken rounded-xl border border-line">
              <button
                type="button"
                onClick={() => setScheduleType('recurring')}
                className={`py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                  scheduleType === 'recurring'
                    ? 'bg-surface text-ink tactile-1'
                    : 'text-ink-faint hover:text-ink'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                <span>Weekly Recurrence</span>
              </button>

              <button
                type="button"
                onClick={() => setScheduleType('specific_dates')}
                className={`py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                  scheduleType === 'specific_dates'
                    ? 'bg-surface text-emerald-600 dark:text-emerald-400 tactile-1'
                    : 'text-ink-faint hover:text-ink'
                }`}
              >
                <CalendarDays className="w-3.5 h-3.5" />
                <span>One-Time / Calendar Dates</span>
              </button>
            </div>

            {/* Mode 1: Days of Week Recurrence */}
            {scheduleType === 'recurring' && (
              <div className="pt-1">
                <div className="flex items-center justify-between text-[11px] text-ink-faint mb-1.5">
                  <span>Repeats on every selected day of week:</span>
                  <button
                    type="button"
                    onClick={() => setSelectedDays([0, 1, 2, 3, 4, 5, 6])}
                    className="text-emerald-600 dark:text-emerald-400 hover:underline font-semibold"
                  >
                    Select All (Daily)
                  </button>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {DAYS_MAP.map((dayName, idx) => {
                    const isSelected = selectedDays.includes(idx);
                    return (
                      <button
                        key={dayName}
                        type="button"
                        onClick={() => toggleDay(idx)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                          isSelected
                            ? 'bg-emerald-600 text-white shadow-xs'
                            : 'bg-sunken text-ink-soft hover:text-ink border border-transparent hover:border-line-strong'
                        }`}
                      >
                        {dayName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Mode 2: Monthly Calendar Date Picker */}
            {scheduleType === 'specific_dates' && (
              <div className="pt-1 animate-fade-in">
                <MonthlyCalendarPicker
                  selectedDates={selectedDates}
                  onToggleDate={handleToggleDate}
                  onClearAll={() => setSelectedDates([])}
                  onSelectToday={handleSelectToday}
                  onSelectTomorrow={handleSelectTomorrow}
                />
              </div>
            )}
          </div>

          {/* Mashgiach & Staff Assignment */}
          <div>
            <label className="block font-semibold text-ink-soft mb-1 flex items-center gap-1">
              <Users className="w-3.5 h-3.5 text-ink-faint" /> Assigned Mashgiach / Staff Visibility
            </label>
            <div className="flex items-center gap-3 mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="assignType"
                  checked={assignType === 'all'}
                  onChange={() => setAssignType('all')}
                  className="text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-ink-soft">All Mashgichim & Team (Global Task)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="assignType"
                  checked={assignType === 'specific'}
                  onChange={() => setAssignType('specific')}
                  className="text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-ink-soft">Specific Mashgiach Only</span>
              </label>
            </div>

            {assignType === 'specific' && (
              <div className="p-3 bg-sunken rounded-xl border border-line/70 space-y-2">
                <p className="text-[11px] text-ink-faint">
                  Select Mashgiach / staff members who should see and execute this assignment:
                </p>
                <div className="flex flex-wrap gap-2">
                  {knownWorkers.map((w) => {
                    const isChecked = selectedWorkers.includes(w.email);
                    return (
                      <button
                        key={w.email}
                        type="button"
                        onClick={() => toggleWorker(w.email)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                          isChecked
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-800 dark:bg-emerald-950/70 dark:border-emerald-700 dark:text-emerald-300'
                            : 'bg-surface border-line text-ink-soft'
                        }`}
                      >
                        {isChecked ? '✓ ' : '+ '}
                        {w.name} ({w.email.split('@')[0]})
                      </button>
                    );
                  })}
                </div>

                {/* Custom email add */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="email"
                    value={customWorkerEmail}
                    onChange={(e) => setCustomWorkerEmail(e.target.value)}
                    placeholder="Or type Mashgiach email (e.g. mashgiach@company.com)..."
                    className="flex-1 px-2.5 py-1 text-xs rounded-lg border border-line bg-sunken text-ink"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomWorker}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-sunken border border-line hover:border-line-strong text-ink-soft"
                  >
                    Add
                  </button>
                </div>

                {/* Visibility: who else can see this assignment */}
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleToTeam}
                    onChange={(e) => setVisibleToTeam(e.target.checked)}
                    className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-[11px] text-ink-soft leading-snug">
                    <span className="font-bold">Visible to the rest of the team.</span>{' '}
                    Uncheck to keep it private — only the selected mashgichim (plus admins
                    and coordinators) will see this assignment.
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-line/70 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl text-ink-soft hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              id="save-task-submit-btn"
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white tactile-2"
            >
              {taskToEdit ? 'Save Changes' : 'Create Assignment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
