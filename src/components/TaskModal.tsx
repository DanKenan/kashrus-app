import { personAvatar } from '../lib/personAvatar';
import { TaskFormProgress } from './TaskFormProgress';
import { ShiftHoursBar } from './ShiftHoursBar';
import { detectTimeShift, detectTimeShiftDay, differingDays, nextWeekday, peopleFields } from '../lib/taskForm';
import { nextFullHour } from '../lib/nextFullHour';
import { ShiftsPanel } from './ShiftsPanel';
import type { Shift } from '../types';
import { shiftWeekdays, shiftIsUpcoming, sortShiftsByStart, venueShifts, shiftUserIds, formatShiftHours } from '../lib/shifts';
import { ANY_TIME_LABEL, isAnyTimeTask, isAnyTimeText } from '../lib/anyTime';
import React, { useState, useEffect, useRef } from 'react';
import { X, Pencil, Clock, Plus, CirclePlus, List, Layers, Sun, Sunset, Moon, Circle, Info, Repeat2, Minus, Users, ChevronDown, Trash2, CheckCircle2, ListFilter, Check, ToggleRight } from 'lucide-react';
import { Task, TaskInputType } from '../types';
import { captureEditBaseline, newActionId } from '../lib/api';
import { DAYS_MAP } from '../lib/utils';
import { DEFAULT_TIME_ZONE, addDays, workDateIn, minutesIn } from '../lib/workday';
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
import { rosterKey } from '../lib/rosterDisplay';

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

/** Compact presentation only; task and shift time values stay unchanged. */
function compactShiftHours(shift: Shift): string {
  const clock = (minutes: number) => `${Math.floor(minutes / 60) % 12 || 12}${minutes % 60 ? `:${String(minutes % 60).padStart(2, '0')}` : ''}`;
  const startPeriod = shift.startMinutes < 720 ? 'AM' : 'PM';
  const endPeriod = shift.endMinutes < 720 ? 'AM' : 'PM';
  return `${clock(shift.startMinutes)}${startPeriod === endPeriod ? '' : ` ${startPeriod}`}–${clock(shift.endMinutes)} ${endPeriod}`;
}

function shortTaskName(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length > 1 && /^(kasher|check|inspect|clean)$/i.test(words[0])) words.shift();
  if (words.length > 1 && /^(the|a|an)$/i.test(words[0])) words.shift();
  return words[0] ? words[0][0].toUpperCase() + words[0].slice(1) : '';
}

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
      <input type="number" min={0} max={59} step={1}
        value={value.minute}
        onChange={(e) => {
          const text = e.target.value.trim();
          const minute = Number(text);
          if (text && Number.isInteger(minute) && minute >= 0 && minute <= 59) onChange({ ...value, minute });
          else e.target.value = String(value.minute);
        }}
        className="task-minute-input text-sm font-bold px-2 py-2 rounded-xl border border-line bg-sunken text-ink"
        aria-label="Minute"
      />
      <div className="flex rounded-xl border border-line overflow-hidden">
        {(['AM', 'PM'] as const).map((ap) => (
          <button
            key={ap}
            type="button"
            onClick={() => onChange({ ...value, ampm: ap })}
            className={`px-3 py-2 text-sm font-black transition-colors ${
              value.ampm === ap ? 'bg-gold-deep text-paper' : 'bg-sunken text-ink-soft'
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
          className="p-2 rounded-xl text-ink-faint hover:text-bad"
          aria-label="Remove second time"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

interface TaskModalProps {
  shifts?: Shift[];
  tasks?: Task[];
  venueId?: string;
  venueName?: string;
  onShiftCreated?: (shift: Shift, deleted?: boolean) => void;
  agencyId?: string;
  onSaveMany?: (tasks: Partial<Task>[], operationId?: string) => Promise<boolean>;
  isOpen: boolean;
  onClose: () => void;
  onSave: (taskData: Partial<Task>, opts?: { baselineVersion?: number }) => Promise<boolean> | void;
  taskToEdit?: Task | null;
  knownWorkers: Array<{ email?: string; name: string; id?: string; venueId?: string; myVenueIds?: string[] }>;
  currentUserEmail?: string | null;
  /** Item 6: the task's venue zone — Today/Tomorrow are that venue's local dates. */
  timeZone?: string;
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
  shifts = [],
  tasks = [],
  venueId = '',
  venueName = '',
  onShiftCreated,
  onSaveMany,
  agencyId = 'agency-hkc',
  currentUserEmail,
  timeZone = DEFAULT_TIME_ZONE,
}) => {
  const [step, setStep] = useState(0);
  const [extras, setExtras] = useState<Array<{ name: string; note: string }>>([]);
  const [peopleTouched, setPeopleTouched] = useState(false);
  const [dayPeople, setDayPeople] = useState<NonNullable<Task['dayAssignees']>>({});
  const [swaps, setSwaps] = useState<NonNullable<Task['assigneeSwaps']>>([]);
  const [peopleDay, setPeopleDay] = useState<number | null>(null);
  const [justOnce, setJustOnce] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [peopleSearch, setPeopleSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [repeat, setRepeat] = useState('Every day');
  const [editingShift, setEditingShift] = useState<Shift | undefined>();
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [showEditTime, setShowEditTime] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([PRESET_CATEGORIES[0]]);
  const [checklistItems, setChecklistItems] = useState<string[]>([]);
  const [checklistDraft, setChecklistDraft] = useState('');
  const addChecklistItem = () => {
    if (!checklistDraft.trim()) return;
    setChecklistItems((items) => [...items, checklistDraft.trim()]);
    setChecklistDraft('');
  };
  const [inputType, setInputType] = useState<TaskInputType>('yes_no');
  // Structured times — the app can reliably sort and process these.
  const [time1, setTime1] = useState<PickerTime>(() => nextFullHour(minutesIn(timeZone, new Date())));
  const [anyTime, setAnyTime] = useState(false);
  const [time2, setTime2] = useState<PickerTime | null>(null);
  // Free-text fallback for non-clock times like "End of Shift".
  const [customTimeText, setCustomTimeText] = useState<string | null>(null);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [enableOverdueAlert, setEnableOverdueAlert] = useState(false);
  const [assignType, setAssignType] = useState<'all' | 'specific'>('specific');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
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
  const [doneDisclosureOpen, setDoneDisclosureOpen] = useState<boolean | undefined>(undefined);

  // Schedule State: Recurring Days vs Specific Calendar Dates
  const [creatingShift, setCreatingShift] = useState(false);
  const [createdShifts, setCreatedShifts] = useState<Shift[]>([]);
  const [removedShifts, setRemovedShifts] = useState<Shift[]>([]);
  // Preserve deletion markers through the nested editor's own resolution.
  const shiftRecords = [...shifts.filter((s) => !createdShifts.some((v) => v.id === s.id)), ...createdShifts]
    .filter((s) => !removedShifts.some((removed) => removed.id === s.id))
    .concat(removedShifts.map((s) => ({ ...s, deleted: true as const })));
  const pickerShifts = venueShifts(shiftRecords, venueId, agencyId).filter((s) => shiftIsUpcoming(s, workDateIn(timeZone)));
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [shiftMode, setShiftMode] = useState(false);
  const [deletedShiftName, setDeletedShiftName] = useState<string | null>(null);
  const [shiftTime, setShiftTime] = useState(false);
  const [scheduleType, setScheduleType] = useState<'recurring' | 'specific_dates'>('recurring');
  const [selectedDays, setSelectedDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);

  // Synchronous guard against double-submit (double-click / Enter+click firing
  // handleSubmit twice before the modal unmounts).
  const pickedShiftRef = useRef<HTMLButtonElement | null>(null);
  const submitGuard = useRef(false);
  const batchAttempt = useRef<{ payload: string; operationId: string } | null>(null);
  // ROUND 5 — write baseline for this edit form. Captured when the modal
  // loads taskToEdit (what the user sees), NOT at save time (by then a
  // WebSocket update may have bumped the tracked version past the form).
  const baselineRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    submitGuard.current = false; batchAttempt.current = null;
    if (isOpen) setSavedNotice(null);
    setShowEditTime(false);
    setDoneDisclosureOpen(undefined);
    setStep(0); setExtras([]); setPeopleTouched(false); setDayPeople(taskToEdit?.dayAssignees || {});
    setSwaps(taskToEdit?.assigneeSwaps || []); setPeopleDay(null); setJustOnce(false);
    setShowPeople(false); setPeopleSearch(''); setSaving(false); setSaveError(''); setRemovedShifts([]); setDeletedShiftName(null);
    setRepeat(taskToEdit?.scheduleType === 'specific_dates' ? 'One time' : taskToEdit?.daysOfWeek?.length === 1 ? 'Every week' : taskToEdit?.daysOfWeek?.length && taskToEdit.daysOfWeek.length < 7 ? 'Some days' : 'Every day');
    setCreatingShift(false); setCreatedShifts([]);
    setShiftId(taskToEdit?.shiftId || null);
    setShiftMode(!!taskToEdit?.shiftId);
    setShiftTime(!!taskToEdit?.shiftTime);
    const todayStr = workDateIn(timeZone, new Date());

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
      setChecklistItems(taskToEdit.checklistItems || []);
      setChecklistDraft('');
      setInputType(taskToEdit.inputType || 'yes_no');
      // Load times: structured when parseable, free-text otherwise.
      const editingAnyTime = isAnyTimeTask(taskToEdit);
      setAnyTime(editingAnyTime);
      const t1 = editingAnyTime ? null : parseTimeText(taskToEdit.targetTime);
      if (t1) {
        setTime1(t1);
        setCustomTimeText(null);
      } else {
        setTime1({ hour: 9, minute: 0, ampm: 'AM' });
        setCustomTimeText(editingAnyTime ? null : taskToEdit.targetTime || null);
      }
      const t2 = parseTimeText(taskToEdit.targetTime2);
      setTime2(editingAnyTime || (taskToEdit.shiftId && !taskToEdit.shiftTime) ? null : t2);
      setPriority(taskToEdit.priority || 'medium');
      setEnableOverdueAlert(!editingAnyTime && taskToEdit.enableOverdueAlert === true);
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
      setAnyTime(false);
      baselineRef.current = undefined; // create — no baseline needed
      setTitle('');
      setDescription('');
      setSelectedCategories([PRESET_CATEGORIES[0]]);
      setChecklistItems([]);
      setChecklistDraft('');
      setInputType('yes_no');
      setTime1(nextFullHour(minutesIn(timeZone, new Date())));
      setTime2(null);
      setCustomTimeText(null);
      setPriority('medium');
      setEnableOverdueAlert(false);
      setAssignType('specific');
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

  const displayShifts = sortShiftsByStart(pickerShifts);
  const chosenShift = shiftMode ? pickerShifts.find((s) => s.id === shiftId) : undefined;
  const usingShift = !!chosenShift;
  const isAny = !usingShift && (anyTime || (customTimeText !== null && isAnyTimeText(customTimeText)));
  useEffect(() => {
    if (isAny) setEnableOverdueAlert(false);
  }, [isAny]);

  useEffect(() => {
    if (!isOpen || step !== 1 || !shiftMode) return;
    const chip = pickedShiftRef.current?.parentElement;
    const scroller = chip?.parentElement;
    if (!chip || !scroller) return;
    // Align the whole card (including its pencil) inside this scroller only.
    scroller.scrollLeft += chip.getBoundingClientRect().left - scroller.getBoundingClientRect().left - scroller.clientLeft;
  }, [isOpen, step, shiftMode, shiftId]);

  const chooseShift = (shift: Shift) => {
    setShiftId(shift.id); setShiftMode(true); setDeletedShiftName(null);
    if (!taskToEdit && !peopleTouched) {
      const emails = knownWorkers.filter((w) => w.id && shiftUserIds(shift).includes(w.id) && w.email).map((w) => w.email!);
      setSelectedWorkers(emails); setAssignType('specific');
    }
  };
  const mainPeople = assignType === 'all' ? ['all'] : selectedWorkers;
  const today = workDateIn(timeZone);
  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const detectionDay = selectedDays.includes(todayWeekday) ? todayWeekday : selectedDays[0] ?? todayWeekday;
  const detectedShift = detectTimeShift(pickerShifts, pickerTimeToMinutes(time1), detectionDay);
  const detectedDay = detectedShift ? detectTimeShiftDay(detectedShift, pickerTimeToMinutes(time1), detectionDay)! : detectionDay;
  const dayDate = peopleDay === null ? today : nextWeekday(today, peopleDay);
  const dayKey = String(peopleDay) as keyof NonNullable<Task['dayAssignees']>;
  const dayValue = peopleDay === null ? mainPeople : justOnce ? swaps.find((s) => s.date === dayDate)?.assignedTo ?? dayPeople[dayKey] ?? mainPeople : dayPeople[dayKey] ?? mainPeople;
  const pickPeople = (emails: string[]) => {
    setPeopleTouched(true);
    if (peopleDay !== null) {
      if (justOnce) setSwaps((old) => [...old.filter((s) => s.date !== dayDate), { date: dayDate, assignedTo: emails }]);
      else setDayPeople((old) => ({ ...old, [dayKey]: emails }));
    } else { setAssignType(emails.includes('all') ? 'all' : 'specific'); setSelectedWorkers(emails.filter((e) => e !== 'all')); }
  };
  const namesFor = (emails: string[]) => emails.includes('all') ? 'Everyone at the venue' : emails.map((email) => knownWorkers.find((w) => w.email === email)?.name || email).join(', ');
  const firstNames = (emails: string[]) => emails.includes('all') ? namesFor(emails) : emails.map((email) => namesFor([email]).split(' ')[0]).join(', ');
  const swapDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const usualEmails = chosenShift ? knownWorkers.filter((person) => person.id && shiftUserIds(chosenShift).includes(person.id) && person.email).map((person) => person.email!) : [];
  const venuePeople = knownWorkers.filter((person) => person.myVenueIds?.length ? person.myVenueIds.includes(venueId) : !person.venueId || person.venueId === venueId);
  const peopleDayName = new Date(`${dayDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const upcomingSwaps = swaps.filter((swap) => swap.date >= today);
  const dayDifferences = differingDays(dayPeople, mainPeople);
  const daySummary = selectedDays.flatMap((day) => {
    const usual = dayPeople[String(day) as keyof typeof dayPeople] ?? mainPeople;
    const swap = swaps.find((entry) => entry.date === nextWeekday(today, day));
    if (swap) return [`${DAYS_MAP[day]} ${swapDate(swap.date)}: ${firstNames(swap.assignedTo)}, just this once (usually ${firstNames(usual)})`];
    return dayDifferences[String(day) as keyof typeof dayDifferences] ? [`${DAYS_MAP[day]}: ${firstNames(usual)}`] : [];
  }).join(' · ');
  const peopleReady = mainPeople.length > 0 && (scheduleType !== 'recurring' || selectedDays.every((day) => (dayPeople[String(day) as keyof typeof dayPeople] ?? mainPeople).length > 0)) && swaps.every((swap) => swap.date < today || swap.assignedTo.length > 0);
  const choice = (on: boolean) => `min-h-11 px-3 rounded-lg border pressable ${on ? 'bg-gold-deep text-paper border-gold-deep' : 'border-line-control bg-surface text-ink'}`;
  const shiftChanged = (shift: Shift, deleted = false) => {
    if (deleted) { setRemovedShifts((old) => [...old, shift]); if (shiftId === shift.id) { setShiftId(null); setDeletedShiftName(shift.name); } }
    else { setCreatedShifts((old) => [...old.filter((s) => s.id !== shift.id), shift]); chooseShift(shift); }
    onShiftCreated?.(shift, deleted); setCreatingShift(false);
  };
  const firstDoneOption = customStatusOptions.findIndex((option) => completedStatusValues.includes(option));
  const previewStatusOptions = customStatusOptions.filter((_, index) => index < (firstDoneOption > 2 ? 2 : 3) || index === firstDoneOption);
  const count = extras.length + 1;
  const stepName = ['What', 'When', 'Who'][step];
  const whatSummary = `${count > 1 ? `${count} tasks · ` : ''}${[title, ...extras.map((t) => t.name)].filter(Boolean).join(', ')}`;
  const whenSummary = `${shiftMode && chosenShift ? `${chosenShift.name} ${compactShiftHours(chosenShift)}` : isAny ? ANY_TIME_LABEL : customTimeText ?? formatPickerTime(time1)} · ${repeat.toLowerCase()}`;
  const notice = savedNotice && <div role="status" className="task-form-saved-notice"><span aria-hidden="true">✓</span><span>{savedNotice}</span><button type="button" aria-label="Dismiss saved notification" onClick={() => setSavedNotice(null)} className="min-h-11 min-w-11 rounded-full pressable"><X className="w-4 h-4 mx-auto" /></button></div>;
  const statusHasDone = customStatusOptions.some((option) => completedStatusValues.includes(option));
  const checklistInvalid = inputType === 'checklist' && checklistItems.length < 2;
  const statusOptionsInvalid = inputType === 'status_select' && (!customStatusOptions.length || !statusHasDone);
  useEffect(() => {
    if (statusOptionsInvalid) setDoneDisclosureOpen(true);
  }, [statusOptionsInvalid]);

  if (!isOpen) return notice;


  const toggleDay = (dayIndex: number) => {
    if (selectedDays.includes(dayIndex)) {
      if (selectedDays.length === 1) return; // Keep at least one day
      setSelectedDays(selectedDays.filter((d) => d !== dayIndex));
    } else {
      setSelectedDays([...selectedDays, dayIndex].sort());
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
    const updated = customStatusOptions.filter((opt) => opt !== optionToRemove);
    setCustomStatusOptions(updated);
    setCompletedStatusValues(completedStatusValues.filter((v) => v !== optionToRemove));
  };

  const setOptionCompleted = (option: string, done: boolean) => {
    setCompletedStatusValues((values) => done
      ? values.includes(option) ? values : [...values, option]
      : values.filter((value) => value !== option));
  };
  const statusPreviewName = !mainPeople.length || mainPeople.includes('all')
    ? 'The mashgiach' : knownWorkers.find((person) => person.email === mainPeople[0])?.name?.trim().split(/\s+/)[0] || 'The mashgiach';

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
    const todayStr = workDateIn(timeZone, new Date());
    if (!selectedDates.includes(todayStr)) {
      setSelectedDates([...selectedDates, todayStr].sort());
    }
  };

  const handleSelectTomorrow = () => {
    const tomorrowStr = addDays(workDateIn(timeZone, new Date()), 1);
    if (!selectedDates.includes(tomorrowStr)) {
      setSelectedDates([...selectedDates, tomorrowStr].sort());
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (statusOptionsInvalid || checklistInvalid) {
      setStep(0);
      setDoneDisclosureOpen(true);
      return;
    }
    if (step === 1 && shiftMode && !chosenShift) return;
    if (!taskToEdit && step !== 2) {
      if (title.trim() && extras.every((t) => t.name.trim())) {
        if (step === 1 && !taskToEdit && !peopleTouched) {
          const shift = chosenShift || (!shiftMode && !isAny && customTimeText === null ? detectedShift : undefined);
          const emails = shift ? knownWorkers.filter((w) => w.id && shiftUserIds(shift).includes(w.id) && w.email).map((w) => w.email!) : [];
          setSelectedWorkers(emails); setAssignType('specific');
        }
        setStep(step + 1);
      }
      return;
    }
    if (!peopleReady || !title.trim() || extras.some((t) => !t.name.trim()) || (shiftMode && !chosenShift)) return;
    if (submitGuard.current) return;
    submitGuard.current = true;

    if (extras.length && !onSaveMany) { submitGuard.current = false; setSaveError("Couldn't save these tasks. Please try again."); return; }
    const assignedTo = assignType === 'all' ? ['all'] : selectedWorkers;

    // Validate dates if specific_dates is chosen
    let finalDates = selectedDates;
    if (scheduleType === 'specific_dates' && finalDates.length === 0) {
      const todayStr = workDateIn(timeZone, new Date());
      finalDates = [todayStr];
    }

    const noOwnShiftTime = usingShift && !shiftTime;
    const payload: Partial<Task> = {
      ...(taskToEdit ? { id: taskToEdit.id } : {}),
      title: title.trim(),
      description: description.trim(),
      category: (selectedCategories[0] || 'General').trim(),
      categories: selectedCategories.length > 0 ? selectedCategories.map((c) => c.trim()) : ['General'],
      shiftId: usingShift ? chosenShift.id : null,
      shiftTime: usingShift && shiftTime,
      isPrivate: taskToEdit && !peopleTouched ? taskToEdit.isPrivate : (!usingShift || !taskToEdit || peopleTouched || !!taskToEdit.assignmentMode) && assignType === 'specific' && selectedWorkers.length > 0 && !visibleToTeam,
      inputType,
      ...(inputType === 'checklist' ? { checklistItems } : {}),
      customStatusOptions: inputType === 'status_select' ? customStatusOptions : undefined,
      completedStatusValues: inputType === 'status_select' ? completedStatusValues : undefined,
      // Structured times when set via picker; custom text clears the minutes.
      targetTime: noOwnShiftTime ? '' : isAny ? ANY_TIME_LABEL : customTimeText !== null ? customTimeText.trim() : formatPickerTime(time1),
      targetTimeMinutes: noOwnShiftTime || isAny || customTimeText !== null ? null : pickerTimeToMinutes(time1),
      targetTime2: !noOwnShiftTime && !isAny && time2 ? formatPickerTime(time2) : '',
      targetTime2Minutes: !noOwnShiftTime && !isAny && time2 ? pickerTimeToMinutes(time2) : null,
      priority,
      enableOverdueAlert: isAny ? false : enableOverdueAlert,
      assignedTo: taskToEdit && !peopleTouched && usingShift && !taskToEdit.assignmentMode && !taskToEdit.dayAssignees && !taskToEdit.assigneeSwaps ? ['all'] : assignedTo,
      ...peopleFields(taskToEdit, peopleTouched, differingDays(dayPeople, assignedTo), swaps),
      scheduleType: usingShift && chosenShift.oneTimeDate ? 'specific_dates' : scheduleType,
      daysOfWeek: taskToEdit && !peopleTouched && usingShift && !taskToEdit.assignmentMode && !taskToEdit.dayAssignees && !taskToEdit.assigneeSwaps ? shiftWeekdays(chosenShift) : selectedDays,
      specificDates: usingShift && chosenShift.oneTimeDate ? [chosenShift.oneTimeDate] : scheduleType === 'specific_dates' ? finalDates : undefined,
    };
    setSaving(true); setSaveError('');
    let saved: boolean | void;
    try {
      const tasks = [payload, ...extras.map((t) => ({ ...payload, title: t.name.trim(), description: t.note.trim() }))];
      const fingerprint = JSON.stringify(tasks);
      if (!batchAttempt.current || batchAttempt.current.payload !== fingerprint) batchAttempt.current = { payload: fingerprint, operationId: newActionId() };
      saved = extras.length && onSaveMany
        ? await onSaveMany(tasks, batchAttempt.current.operationId)
        : await onSave(payload, { baselineVersion: baselineRef.current });
    } catch { saved = false; }
    setSaving(false);
    if (saved === false) setSaveError("Couldn't save. Check the connection and try again.");

    // Only close on a confirmed save — on failure the modal stays open with
    // the user's input intact so they can review and retry.
    if (saved === false) {
      submitGuard.current = false;
      return;
    }
    setSavedNotice(extras.length ? `${extras.length + 1} tasks saved` : 'Task saved');
    onClose();
  };

  return (
    <div className={`task-form-overlay fixed inset-0 z-50 flex items-center justify-center bg-scrim ${taskToEdit ? 'task-edit-overlay' : ''}`}>
      <div style={creatingShift ? { display: 'none' } : undefined} role="dialog" aria-modal="true" aria-label={taskToEdit ? 'Edit task' : 'New task'} className={`task-form-shell bg-paper rounded-2xl w-full max-w-xl tactile-4 border border-line overflow-hidden max-h-[90dvh] min-h-0 flex flex-col ${taskToEdit ? 'task-edit-sheet' : ''}`}>
        
        {taskToEdit && <span aria-hidden="true" className="task-edit-grabber" />}
        <div className="task-form-nav shrink-0">
          <button type="button" onClick={onClose} aria-label="Close" className="task-form-close pressable"><span className="task-form-close-face tactile-1"><X className="w-5 h-5" /></span></button>
          <div className="min-w-0 text-center">
            <h2 className="task-form-nav-title truncate">{taskToEdit ? title || taskToEdit.title : count > 1 ? 'New tasks' : 'New task'}</h2>
            {venueName && <p className="task-form-venue truncate">{venueName}</p>}
          </div>
          <span aria-hidden="true" />
        </div>

        {/* Form Body - Scrollable */}
        <form onSubmit={handleSubmit} className="task-form flex min-h-0 flex-1 flex-col text-base">
          <div className="task-form-body min-h-0 flex-1 overflow-y-auto space-y-4" data-task-form-body>
          
          {taskToEdit ? <nav aria-label="Task steps" className="task-edit-tabs">{['What', 'When', 'Who'].map((name, index) => <button key={name} type="button" aria-label={`Go to ${name}`} aria-current={step === index ? 'step' : undefined} aria-pressed={step === index} onClick={() => setStep(index)} className="pressable">{index + 1} {name}</button>)}</nav> : <TaskFormProgress step={step} count={count} summaries={[whatSummary, whenSummary]} onEdit={setStep} />}
          {taskToEdit && <div className="task-edit-note"><Info aria-hidden="true" className="w-4 h-4 shrink-0" /><p><strong>Only this task changes.</strong> Other tasks stay as they are.</p></div>}
          <div className="task-form-current-card" data-task-step={stepName}>
            <div className="task-form-card-header">
              <span aria-hidden="true" className="task-form-heading-number">{step + 1}</span>
              <div className="min-w-0 flex-1"><h3 data-task-form-current-step={stepName}>{step === 2 ? 'Who does it?' : stepName}</h3>{step === 0 && <p>{count > 1 ? 'Name the tasks' : 'Name the task'}</p>}{step === 1 && <p>Pick a shift, or a set time</p>}{step === 2 && <p>{chosenShift && usualEmails.length ? `Pre-filled from the ${chosenShift.name} shift` : 'Pick who does it'}</p>}</div>
              {step === 0 && count > 1 && <span className="task-form-count" data-task-count><List aria-hidden="true" className="w-4 h-4" />{count} tasks</span>}
            </div>
          {step > 0 && extras.length > 0 && <div className="task-when-banner"><Layers aria-hidden="true" className="w-4 h-4 shrink-0" /><span>Applies to all {count} tasks</span><span className="task-when-short-names">{[title, ...extras.map((t) => t.name)].map(shortTaskName).join(' · ')}</span></div>}
          <div hidden={step !== 0} className="task-form-what space-y-4">
          {/* Task Title */}
          <div>
            <label className="block font-semibold text-ink-soft mb-1">
              <span className="inline-flex items-center gap-2">{count > 1 && <span className="task-form-mini-number">1</span>}Name <span className="text-bad">*</span></span>
            </label>
            <input
              id="task-title-input"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-xs sm:text-sm px-3 py-3 rounded-xl border border-line bg-sunken text-ink focus:outline-none focus:border-gold"
            />
          </div>

          {/* Description / Instructions */}
          <div>
            <label className="block font-semibold text-ink-soft mb-1">
              Notes <span className="task-form-optional">optional</span>
            </label>
            <textarea
              data-has-notes={!!description}
              id="task-desc-input"
              rows={1}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything the mashgiach should know"
              className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink focus:outline-none focus:border-gold"
            />
          </div>

          {!taskToEdit && <div className="space-y-2">
            {extras.map((extra, i) => <div key={i} className="task-form-extra">
              <span className="task-form-mini-number">{i + 2}</span>
              <div className="flex-1 min-w-0 space-y-2">
                <label className="block"><span className="sr-only">Name</span><input aria-label={`Task ${i + 2} name`} required value={extra.name} onChange={(e) => setExtras((old) => old.map((t, n) => n === i ? { ...t, name: e.target.value } : t))} className="task-form-extra-name w-full" /></label>
                <details className="task-form-extra-note"><summary className="min-h-11 flex items-center cursor-pointer">+ Add a note · optional</summary><label className="block"><span className="sr-only">Optional note</span><input value={extra.note} onChange={(e) => setExtras((old) => old.map((t, n) => n === i ? { ...t, note: e.target.value } : t))} className="w-full" /></label></details>
              </div>
              <button type="button" aria-label={`Remove task ${i + 2}`} onClick={() => setExtras((old) => old.filter((_, n) => n !== i))} className="task-form-remove pressable"><span>×</span></button>
            </div>)}
            <button type="button" onClick={() => setExtras((old) => [...old, { name: '', note: '' }])} className="task-form-add pressable"><CirclePlus aria-hidden="true" className="w-5 h-5 shrink-0" /><span>Add another task</span></button>
          </div>}
          <details className="task-what-more"><summary>More: type of check, photo, alert if late<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary>
          {/* 2-Column: Category & Input Type */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-ink-soft mb-1">
                Type of check (pick any)
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
                      } py-1 rounded-full text-xs font-bold border transition tactile-1 pressable ${
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
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
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
                          className={`shrink-0 min-w-11 min-h-11 rounded-full inline-flex items-center justify-center transition cursor-pointer ${
                            confirmDeleteCat === c
                              ? 'bg-bad text-paper'
                              : 'text-ink-faint hover:text-bad hover:bg-bad/10'
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
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border border-dashed transition cursor-pointer tactile-1 ${
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
                  <label className="block text-xs font-bold text-ink-soft mb-1">
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
                    placeholder="Category name"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-surface text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
                  />
                  <label className="block text-xs font-bold text-ink-soft mt-2.5 mb-1.5">
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
                      className="cat-chip inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border"
                      style={categoryVarsForHue(otherHue)}
                    >
                      <span className="cat-dot w-2 h-2 rounded-full" />
                      <span className="cat-text">{otherName.trim() || 'Preview'}</span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowOtherForm(false)}
                        className="px-3 py-1.5 rounded-xl text-xs font-bold text-ink-soft hover:text-ink transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={addCustomCategory}
                        disabled={!otherName.trim()}
                        className="px-3 py-1.5 rounded-xl text-xs font-black bg-gold-deep text-paper tactile-2 pressable transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save category
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <p className="text-xs text-ink-faint mt-1.5 leading-snug">
                Your <em>Other</em> categories are saved for next time — tap the × on one to remove it.
              </p>
            </div>

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

          {/* Overdue Alert Toggle */}
          <label className={`flex items-center gap-2.5 p-3 rounded-xl border border-line bg-sunken ${isAny ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={!isAny && enableOverdueAlert}
              disabled={isAny}
              onChange={(e) => setEnableOverdueAlert(e.target.checked)}
              className="w-4 h-4 rounded accent-gold"
            />
            <div>
              <div className="text-xs font-bold">Alert if it's late</div>
              <div className="text-xs text-ink-soft">
                {!isAny && enableOverdueAlert ? "On: a push alert when it's late" : "Off: no alert if it's late"}
              </div>
            </div>
          </label>
          </details>
          <details className="task-done-disclosure" open={doneDisclosureOpen}
            onToggle={(e) => setDoneDisclosureOpen(e.currentTarget.open)}>
            <summary><span className="task-done-icon"><CheckCircle2 aria-hidden="true" className="w-5 h-5" /></span><span className="task-done-copy"><span>How is it marked done?</span><strong>{({ yes_no: 'Yes or No', toggle: 'On / Off switch', status_select: 'Your own options', checkbox: 'One big check', check_in: 'Check many times', checklist: 'Checklist' })[inputType]}{count > 1 ? ` · all ${count}` : ''}</strong></span><ChevronDown aria-hidden="true" className="w-4 h-4 shrink-0" /></summary>
            <div id="task-input-type-select" role="radiogroup" aria-label="How is it marked done?" className="task-done-cards">
              {([
                { value: 'checkbox', title: 'One big check', line: "One tap and it's done" },
                { value: 'check_in', title: 'Check many times', line: 'Tap every time you check · logs who and when' },
                { value: 'yes_no', title: 'Yes or No', line: 'Answer a question' },
                { value: 'status_select', title: 'Your own options', line: 'You write the choices' },
                { value: 'checklist', title: 'Checklist', line: 'Tick each item · done when all are ticked' },
                ...(taskToEdit?.inputType === 'toggle' ? [{ value: 'toggle', title: 'On / Off switch', line: 'Tap to turn on or off' }] : []),
              ] as { value: TaskInputType; title: string; line: string }[]).map((card) => <label key={card.value} className={`task-done-card${card.value === 'toggle' ? ' task-done-card-legacy' : ''}`}>
                <input type="radio" name="task-done-type" value={card.value} checked={inputType === card.value} onChange={() => setInputType(card.value)} aria-label={card.title} />
                <span className="task-done-preview" aria-hidden="true">
                  {card.value === 'checkbox' && <span className="task-done-preview-check"><Check className="w-6 h-6" /></span>}
                  {card.value === 'check_in' && <span className="task-done-preview-count"><span>3×</span><span className="task-done-preview-dots"><i /><i /><i /></span></span>}
                  {card.value === 'yes_no' && <><span className="task-done-preview-pill is-yes">Yes</span><span className="task-done-preview-pill is-no">No</span></>}
                  {card.value === 'status_select' && <span className="task-done-preview-options">{previewStatusOptions.map((option, index) => <span key={index} className={completedStatusValues.includes(option) ? 'is-done' : undefined}>{completedStatusValues.includes(option) && <Check className="w-4 h-4" />}<span>{option}</span></span>)}</span>}
                  {card.value === 'checklist' && <span className="checklist-mini">{['First item', 'Second item', 'Third item'].map((item, i) => <span key={item}><span className="checklist-mini-box">{i < 2 && <Check className="w-4 h-4" />}</span>{item}</span>)}</span>}
                  {card.value === 'toggle' && <ToggleRight className="w-6 h-6" />}
                </span>
                <span className="task-done-card-copy"><strong>{card.title}</strong><span>{card.line}</span></span>
                {inputType === card.value && <span className="task-done-card-check" aria-hidden="true"><Check className="w-4 h-4" /></span>}
              </label>)}
            </div>

          {inputType === 'checklist' && <div className="checklist-builder">
            <label htmlFor="task-checklist-item">Checklist items</label>
            <div className="checklist-add"><input id="task-checklist-item" value={checklistDraft} onChange={(e) => setChecklistDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }} /><button type="button" onClick={addChecklistItem} className="pressable">Add</button></div>
            <ul>{checklistItems.map((item, index) => <li key={index}><span dir="auto">{item}</span><button type="button" aria-label={`Remove ${item}`} onClick={() => setChecklistItems((items) => items.filter((_, i) => i !== index))} className="pressable"><X className="w-5 h-5" aria-hidden="true" /></button></li>)}</ul>
            {checklistInvalid && <p role="status">Add at least 2 items</p>}
            <p><bdi>{statusPreviewName}</bdi> will see:</p>
            <ul>{checklistItems.map((item, index) => <li key={index}><span className="checklist-box" aria-hidden="true" /><span dir="auto">{item}</span></li>)}</ul>
          </div>}

          {/* CUSTOM STATUS VALUES BUILDER (When inputType === 'status_select') */}
          {inputType === 'status_select' && (
            <div className="own-options-builder">
              <strong>Your own options</strong>
              <p>Each option either finishes the task or leaves it open.</p>
              <label htmlFor="task-status-option" className="sr-only">Add an option</label>
              <div className="own-options-add">
                <input id="task-status-option" type="text" placeholder="Add an option, e.g. Kashered" value={newOptionInput}
                  onChange={(e) => setNewOptionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAddStatusOption(); }
                  }} />
                <button type="button" className="pressable" onClick={handleAddStatusOption}><Plus aria-hidden="true" className="w-4 h-4" />Add</button>
              </div>
              <span className="own-options-presets-label">Or start from:</span>
              <div className="own-options-presets" aria-label="Or start from:">
                {PRESET_STATUS_GROUPS.map((preset) => <button key={preset.name} type="button"
                  className="pressable" onClick={() => applyStatusPreset(preset)}>{preset.name}</button>)}
              </div>
              <div className="own-options-rows">
                {customStatusOptions.map((option) => {
                  const done = completedStatusValues.includes(option);
                  return <div key={option} className="own-options-row">
                    <span dir="auto">{option}</span>
                    <div className="own-options-choice" role="group" aria-label={option}>
                      <button type="button" className="pressable" aria-pressed={done}
                        onClick={() => setOptionCompleted(option, true)}>{done && <Check aria-hidden="true" className="w-4 h-4" />}Counts as done</button>
                      <button type="button" className="pressable" aria-pressed={!done}
                        onClick={() => setOptionCompleted(option, false)}>Stays open</button>
                    </div>
                    <button type="button" className="own-options-remove pressable" aria-label={`Remove ${option}`}
                      onClick={() => handleRemoveStatusOption(option)}><X aria-hidden="true" className="w-5 h-5" /></button>
                  </div>;
                })}
              </div>
              {!customStatusOptions.length && <p role="alert">Add at least one option.</p>}
              {!statusHasDone && <p role="alert">Pick at least one option that counts as done.</p>}
              <div className="own-options-preview">
                <p><bdi>{statusPreviewName}</bdi> will see:</p>
                <div>
                  {customStatusOptions.map((option) => <span key={option}
                    className={completedStatusValues.includes(option) ? 'is-done' : ''}>
                    <bdi>{option}</bdi>{completedStatusValues.includes(option) && <><Check aria-hidden="true" className="w-4 h-4" /><span>Done</span></>}
                  </span>)}
                </div>
              </div>
            </div>
          )}

          </details>


          </div>
          <section hidden={step !== 1} aria-label="When" className="task-when space-y-4">
            <details className="task-mode-switch" open={!taskToEdit}><summary>Change time or shift<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary><div role="group" aria-label="Time or Shift" className="task-when-segment">
              <button type="button" aria-label="A shift" aria-pressed={shiftMode} onClick={() => { if (deletedShiftName) { setShiftMode(true); return; } const shift = pickerShifts.find((s) => s.id === shiftId) || detectedShift || pickerShifts[0]; if (shift) chooseShift(shift); }} className="pressable"><Layers aria-hidden="true" className="w-4 h-4" />A shift</button>
              <button type="button" aria-label="A time" aria-pressed={!shiftMode} onClick={() => { setShiftMode(false); setDeletedShiftName(null); }} className="pressable"><Clock aria-hidden="true" className="w-4 h-4" />A time</button>
            </div></details>
            {deletedShiftName && <p aria-live="polite" className="task-when-note"><Info aria-hidden="true" className="w-4 h-4 shrink-0" /><span>{deletedShiftName} was deleted. Choose another shift or switch to a set time.</span></p>}
            {shiftMode && <div className="task-shift-mode space-y-3">
              <details className="task-change-shift" open={!taskToEdit}><summary>Change shift<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary>
              <div className="task-when-label">Which shift?<span>tap one</span></div>
              <div className="flex gap-2 min-w-0">
                <div className="task-shift-scroll flex flex-1 gap-2 overflow-x-auto min-w-0" role="group" aria-label="Shift list">
                  {displayShifts.map((shift) => {
                    const Icon = shift.name.toLowerCase() === 'morning' ? Sun : shift.name.toLowerCase() === 'afternoon' ? Sunset : shift.name.toLowerCase() === 'night' ? Moon : Circle;
                    return <div key={shift.id} className={`task-when-shift ${shift.id === shiftId ? 'is-picked' : ''}`}>
                      <button ref={shift.id === shiftId ? pickedShiftRef : undefined} type="button" aria-pressed={shift.id === shiftId} onClick={() => chooseShift(shift)} className="task-when-shift-pick pressable"><span className="task-when-shift-name"><Icon aria-hidden="true" className={`w-4 h-4 task-shift-icon task-shift-${shift.name.toLowerCase()}`} />{shift.id === shiftId ? '✓ ' : ''}{shift.name}</span><span className="task-when-shift-hours">{compactShiftHours(shift)}</span></button>
                      {shift.id === shiftId && <button type="button" aria-label={`Edit ${shift.name} shift`} onClick={() => { setEditingShift(shift); setCreatingShift(true); }} className="task-when-pencil pressable"><span><Pencil aria-hidden="true" className="w-4 h-4" /></span></button>}
                    </div>;
                  })}
                </div>
                <div className="task-when-new-wrap"><button type="button" onClick={() => { setEditingShift(undefined); setCreatingShift(true); }} className="task-when-new pressable"><Plus aria-hidden="true" className="w-4 h-4" /><span>+ New</span></button></div>
              </div>
              {!chosenShift && !deletedShiftName && <p className="task-when-note"><Info aria-hidden="true" className="w-4 h-4" />Tap a shift. Morning, Afternoon and Night come built in.</p>}
              {chosenShift && <ShiftHoursBar shift={chosenShift} pinMinutes={shiftTime ? pickerTimeToMinutes(time1) : undefined} onSaved={(shift) => { setCreatedShifts((old) => [...old.filter((s) => s.id !== shift.id), shift]); onShiftCreated?.(shift); }} />}
              </details>
              <div className="task-during-shift space-y-2"><p className="task-when-label">{taskToEdit && chosenShift ? `When during the ${chosenShift.name} shift?` : 'When during the shift?'}{taskToEdit && chosenShift && <span>{compactShiftHours(chosenShift)}</span>}</p>
              <div role="group" aria-label="Shift target time" className="task-when-deadline space-y-2">
                <button type="button" aria-label="Any time during the shift" aria-pressed={!shiftTime} onClick={() => setShiftTime(false)} className="task-when-radio pressable"><span aria-hidden="true" className="task-when-radio-ring" /><span>Any time during the shift<small>Done any time {chosenShift ? compactShiftHours(chosenShift) : ''}</small></span></button>
                <div className="task-deadline-choice"><button type="button" aria-label="By a set time" aria-pressed={shiftTime} onClick={() => { setShiftTime(true); setAnyTime(false); setCustomTimeText(null); }} className="task-when-radio pressable"><span aria-hidden="true" className="task-when-radio-ring" /><span>By a set time<small>A deadline inside the shift</small></span></button><button type="button" aria-label="Change time" onClick={() => { setShiftTime(true); setAnyTime(false); setCustomTimeText(null); setShowEditTime(true); }} className="task-when-time-pill pressable"><Clock aria-hidden="true" className="w-4 h-4" />{formatPickerTime(time1)}</button></div>
              </div></div>
            </div>}
            {(!shiftMode || (shiftTime && showEditTime)) && <div className="task-time-main space-y-2">
              <label className="task-when-label">{shiftMode ? 'Target Time' : 'At what time?'}</label>
              {anyTime ? <div className="text-base text-ink-soft">Any time · no target time <button type="button" onClick={() => setAnyTime(false)} className="min-h-11 px-3 underline pressable">Set a time</button></div>
                : customTimeText !== null ? <div className="flex gap-2"><input aria-label="Custom time" value={customTimeText} onChange={(e) => setCustomTimeText(e.target.value)} className="min-h-11 min-w-0 flex-1 px-3 rounded-lg border border-line-control bg-sunken text-base text-ink" /><button type="button" onClick={() => setCustomTimeText(null)} className="min-h-11 px-3 text-ink underline pressable">Use clock</button></div>
                : <div className="task-when-clock"><button type="button" aria-label="Earlier time" onClick={() => { const m = (pickerTimeToMinutes(time1) + 1410) % 1440; setTime1({ hour: Math.floor(m / 60) % 12 || 12, minute: m % 60, ampm: m < 720 ? 'AM' : 'PM' }); }} className="pressable"><Minus className="w-5 h-5" /></button><output className="task-time-readout" aria-label="Selected task time" aria-live="polite">{formatPickerTime(time1)}</output><button type="button" aria-label="Later time" onClick={() => { const m = (pickerTimeToMinutes(time1) + 30) % 1440; setTime1({ hour: Math.floor(m / 60) % 12 || 12, minute: m % 60, ampm: m < 720 ? 'AM' : 'PM' }); }} className="pressable"><Plus className="w-5 h-5" /></button></div>}
              {!shiftMode && !anyTime && customTimeText === null && <p aria-label={detectedShift ? `During the ${detectedShift.name} shift on ${DAYS_MAP[detectedDay]} (${formatShiftHours(detectedShift, detectedDay)})` : 'Not during a shift'} className={`task-when-detected task-detected-${detectedShift?.name.toLowerCase()}`}><Clock aria-hidden="true" className="w-4 h-4 shrink-0" /><span>{detectedShift ? `During the ${detectedShift.name} shift (${compactShiftHours(detectedShift)})` : 'Not during a shift'}</span><span className="ml-auto">auto</span></p>}
              {!shiftMode && !anyTime && customTimeText === null && detectedShift && <><ShiftHoursBar shift={detectedShift} pinMinutes={pickerTimeToMinutes(time1)} readOnly onSaved={() => {}} /><p className="task-when-note">Due at {formatPickerTime(time1)}, inside the {detectedShift.name} shift.</p></>}

            </div>}
            <div role="group" aria-label="Repeat" className="task-when-repeat space-y-2">
              <p className="task-when-label">Repeat</p>
              <div className="task-when-repeat-pills">{['One time', 'Every day', 'Some days', 'Every week'].map((label) => <button key={label} type="button" aria-pressed={repeat === label} onClick={() => { setRepeat(label); setScheduleType(label === 'One time' ? 'specific_dates' : 'recurring'); if (label === 'Every day') setSelectedDays([0, 1, 2, 3, 4, 5, 6]); if (label === 'Every week') setSelectedDays([new Date(`${today}T12:00:00Z`).getUTCDay()]); }} className="pressable">{repeat === label ? '✓ ' : ''}{label}</button>)}</div>
              {(repeat === 'Some days' || repeat === 'Every week') && <div className="flex flex-wrap gap-2">{DAYS_MAP.map((name, day) => <button key={day} type="button" aria-pressed={selectedDays.includes(day)} onClick={() => repeat === 'Every week' ? setSelectedDays([day]) : toggleDay(day)} className="task-when-weekday pressable">{selectedDays.includes(day) ? '✓ ' : ''}{name}</button>)}</div>}
              <p className="task-when-note"><Repeat2 aria-hidden="true" className="w-4 h-4 shrink-0" /><span>{repeat === 'One time' ? `Once: ${selectedDates.length ? selectedDates.map((date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })).join(', ') : 'Pick a date'}` : repeat === 'Every week' ? `Every ${new Date(`${nextWeekday(today, selectedDays[0] ?? todayWeekday)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}` : `${repeat}, ${selectedDays.map((d) => DAYS_MAP[d]).join(' · ')}`}</span></p>
              {scheduleType === 'specific_dates' && <MonthlyCalendarPicker selectedDates={selectedDates} onToggleDate={handleToggleDate} onClearAll={() => setSelectedDates([])} onSelectToday={handleSelectToday} onSelectTomorrow={handleSelectTomorrow} timeZone={timeZone} />}
            </div>
              <details className="task-time-options"><summary>More time options<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary>
              {!anyTime && customTimeText === null && (!taskToEdit || !shiftMode || showEditTime) && <TimePickerRow value={time1} onChange={setTime1} />}
              {time2 && !anyTime && <TimePickerRow value={time2} onChange={setTime2} onRemove={() => setTime2(null)} />}
              {!usingShift && assignType === 'all' && !isAny && (customTimeText === null || parseTimeText(customTimeText) !== null) && <p className="text-xs text-ink-soft mt-2">People with a shift today (including an overnight shift still running) see it only if this time is inside their shift. People with no shift see it too.</p>}
              <div className="flex flex-wrap gap-2">
                {!shiftMode && <button type="button" aria-label="Any time" aria-pressed={anyTime} onClick={() => { setAnyTime(true); setTime2(null); setCustomTimeText(null); }} className={choice(anyTime)}>{anyTime ? '✓ ' : ''}Any time</button>}
                {!anyTime && !time2 && <button type="button" onClick={() => setTime2({ hour: 3, minute: 0, ampm: 'PM' })} className="min-h-11 px-3 rounded-lg border border-line-control text-ink pressable">+ Second time</button>}
              </div>
              </details>
          </section>

          <section hidden={step !== 2} aria-label="Who" className="task-who space-y-4">
            <div className="space-y-2">{selectedWorkers.map((email) => {
              const differentDays = selectedDays.filter((day) => !(dayPeople[String(day) as keyof typeof dayPeople] ?? mainPeople).includes(email));
              return <button key={email} type="button" onClick={() => { setPeopleTouched(true); const next = selectedWorkers.filter((e) => e !== email); setSelectedWorkers(next); setAssignType('specific'); }} className="task-who-person pressable">
                <span className="task-who-avatar" style={personAvatar(email)} aria-hidden="true">{namesFor([email]).slice(0, 1)}</span>
                <span className="task-who-person-name"><strong>{namesFor([email])}</strong>{chosenShift && usualEmails.includes(email) && <small className="task-who-usual">usual for {chosenShift.name}</small>}{differentDays.length > 0 && <small>every day but {differentDays.map((day) => DAYS_MAP[day]).join(', ')}</small>}</span>
                <span className="task-who-remove-hint">tap to remove</span><span className="task-who-check" aria-hidden="true">✓</span>
              </button>;
            })}</div>
            <button type="button" onClick={() => { setPeopleDay(null); setShowPeople(!showPeople); }} className="task-who-add pressable"><CirclePlus aria-hidden="true" className="w-5 h-5 shrink-0" /><span>+ Add people</span><span className="task-who-avatar-stack" aria-hidden="true">{venuePeople.filter((person) => !selectedWorkers.includes(person.email || '')).slice(0, 3).map((person) => <span key={rosterKey(person)} style={personAvatar(person.email || person.name)}>{person.name.slice(0, 1)}</span>)}</span></button>
            <button type="button" aria-label="Everyone at the venue" aria-pressed={assignType === 'all'} onClick={() => { setPeopleTouched(true); setAssignType('all'); setSelectedWorkers([]); }} className="task-who-everyone pressable"><Users aria-hidden="true" className="w-5 h-5 shrink-0" /><span>Everyone at the venue<small>All {venuePeople.length}{venueName ? ` at ${venueName}` : ' at the venue'}</small></span><span aria-hidden="true" className="task-who-toggle"><span>{assignType === 'all' ? '✓' : ''}</span></span></button>
            {assignType === 'specific' && selectedWorkers.length > 0 && scheduleType === 'recurring' && (repeat === 'Every day' || repeat === 'Some days') && <div role="group" aria-label="People by day" className="task-who-days space-y-2">
              <p className="task-who-day-label">Who does each day?<span>{repeat} · tap a day to change it</span></p>
              <div className="task-who-day-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, selectedDays.length)}, minmax(44px, 1fr))` }}>
              {selectedDays.map((day) => {
                const usual = dayPeople[String(day) as keyof typeof dayPeople] ?? mainPeople;
                const swap = swaps.find((s) => s.date === nextWeekday(today, day));
                const shown = swap?.assignedTo ?? usual;
                return <button key={day} type="button" onClick={() => { setPeopleDay(day); setJustOnce(!!swap); setShowPeople(true); }} aria-label={`${DAYS_MAP[day]}: ${namesFor(shown)}${swap ? `, just ${swapDate(swap.date)}, usually ${namesFor(usual)}` : ''}`} aria-pressed={showPeople && peopleDay === day} className={`task-who-day pressable ${dayDifferences[String(day) as keyof typeof dayDifferences] || swap ? 'is-different' : ''} ${swap ? 'has-swap' : ''}`}>
                  <span className="w-10 shrink-0">{DAYS_MAP[day]}</span>
                  <span className="rounded-full bg-sunken w-8 h-8 shrink-0 flex items-center justify-center" style={personAvatar(shown[0] || 'all')} aria-hidden="true">{namesFor(shown).slice(0, 1)}</span>
                  <span className="min-w-0 py-2"><span className="block truncate" title={namesFor(shown)}>{firstNames(shown)}</span></span>
                  {swap && <span aria-hidden="true" className="task-day-swap-badge">1×</span>}
                </button>;
              })}
              </div>
              {daySummary && <p className="task-day-short-summary">{daySummary}</p>}
            </div>}
            {upcomingSwaps.length > 0 && <div aria-label="Single-date swaps" className="space-y-2 text-sm text-ink-soft">
              <p>Swaps for single dates stay:</p>
              {upcomingSwaps.map((swap) => <div key={swap.date} className="flex items-center justify-between gap-2"><span>{new Date(`${swap.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} {swapDate(swap.date)} {namesFor(swap.assignedTo)}</span><button type="button" aria-label={`Remove swap for ${swap.date}`} onClick={() => { setPeopleTouched(true); setSwaps((old) => old.filter((s) => s.date !== swap.date)); }} className="min-h-11 min-w-11 rounded-lg border border-line-control text-ink pressable">×</button></div>)}
            </div>}
            {showPeople && <div className="task-people-scrim" onClick={() => { setShowPeople(false); setPeopleDay(null); }}>
              <div role="dialog" aria-modal="true" aria-label="Choose people" className="task-people-sheet" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setShowPeople(false); setPeopleDay(null); }
                if (e.key === 'Tab') {
                  const controls = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
                  const edge = e.shiftKey ? controls[0] : controls[controls.length - 1];
                  if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? controls[controls.length - 1] : controls[0])?.focus(); }
                }
              }}>
              <span aria-hidden="true" className="task-people-grabber" />
              <div className="task-people-heading"><div><h4>{peopleDay !== null ? `${peopleDayName} · who does it?` : 'Add people'}</h4>{peopleDay !== null && <p>{justOnce ? `Just ${peopleDayName}, ${swapDate(dayDate)}.` : `Every ${peopleDayName}.`} The other {justOnce ? `${peopleDayName}s` : 'days'} stay with {namesFor(justOnce ? dayPeople[dayKey] ?? mainPeople : mainPeople)}.</p>}</div><button type="button" aria-label="Close people picker" onClick={() => { setShowPeople(false); setPeopleDay(null); }} className="task-people-close pressable"><X className="w-5 h-5" /></button></div>
              {peopleDay !== null && <div className="space-y-2">
                {taskToEdit && <div className="task-people-date-choice">
                  <button type="button" aria-pressed={!justOnce} onClick={() => setJustOnce(false)} className="pressable">{!justOnce ? '✓ ' : ''}Every {new Date(`${dayDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}</button>
                  <button type="button" aria-pressed={justOnce} onClick={() => setJustOnce(true)} className="pressable">{justOnce ? '✓ ' : ''}Just this {new Date(`${dayDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}</button>
                </div>}
              </div>}
              <div className="task-people-body space-y-3"><label className="block text-sm text-ink-soft">Search people<input autoFocus value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} className="block w-full min-h-11 px-3 rounded-lg border border-line-control bg-surface text-base text-ink" /></label>
              {Object.keys(dayDifferences).length > 0 && <div className="space-y-2 text-sm text-ink-soft">
                <p>{Object.entries(dayDifferences).map(([day, emails]) => {
                  const swap = swaps.find((s) => s.date === nextWeekday(today, Number(day)));
                  return swap ? `${DAYS_MAP[Number(day)]}: ${namesFor(swap.assignedTo)} · just ${swapDate(swap.date)} (usually ${namesFor(emails)})` : `${DAYS_MAP[Number(day)]}: ${namesFor(emails)}`;
                }).join(' · ')}</p>
                <button type="button" onClick={() => { setPeopleTouched(true); setDayPeople({}); }} className={choice(false)}>Use {namesFor(mainPeople) || 'these people'} every day</button>
              </div>}
              <p className="task-who-later"><Pencil aria-hidden="true" className="w-4 h-4 shrink-0" />You can change this later from the task.</p>
              <div className="task-people-list space-y-2">
                <button type="button" aria-pressed={dayValue.includes('all')} onClick={() => pickPeople(['all'])} className="task-people-choice pressable">{dayValue.includes('all') ? '✓ ' : ''}Everyone at the venue</button>
                {knownWorkers.filter((w) => `${w.name} ${w.email || ''}`.toLowerCase().includes(peopleSearch.toLowerCase())).map((w) => <button key={rosterKey(w)} type="button" aria-label={`Pick ${w.name}`} disabled={!w.email} aria-pressed={!!w.email && dayValue.includes(w.email)} onClick={() => { const email = w.email!; const next = dayValue.includes(email) ? dayValue.filter((e) => e !== email) : [...dayValue.filter((e) => e !== 'all'), email]; pickPeople(next); }} className="task-people-choice disabled:opacity-50 pressable"><span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${w.email && dayValue.includes(w.email) ? 'bg-paper text-gold-deep' : 'bg-sunken text-ink'}`} style={personAvatar(w.email || w.name)} aria-hidden="true">{w.name.slice(0, 1)}</span><span className="task-people-name">{w.name}{chosenShift && w.email && usualEmails.includes(w.email) && <small>usual for {chosenShift.name}</small>}</span><span aria-hidden="true" className="task-people-check">{w.email && dayValue.includes(w.email) ? '✓' : ''}</span></button>)}
              </div>
              </div><button type="button" onClick={() => { setShowPeople(false); setPeopleDay(null); }} className="task-people-done pressable">Done</button>
              </div>
            </div>}
            <details className="task-who-visibility"><summary>Who can see it<ChevronDown aria-hidden="true" className="w-4 h-4" /></summary><label className="flex items-center gap-2 min-h-11 text-sm text-ink-soft"><input id="task-team-visibility" type="checkbox" checked={visibleToTeam} disabled={assignType === 'all' || selectedWorkers.length === 0} onChange={(e) => { setPeopleTouched(true); setVisibleToTeam(e.target.checked); }} /><span>Owner and managers can see it too<span className="block">{assignType === 'all' || selectedWorkers.length === 0 ? 'Pick at least one person first.' : 'Off: only the people you picked, admins and coordinators see it.'}</span></span></label></details>
          </section>

          </div>
          </div>
          {/* Footer Actions */}
          <div className="task-form-footer shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="sr-only focus:not-sr-only min-h-12 px-4 py-2 text-base font-semibold rounded-xl text-ink-soft hover:bg-sunken"
            >
              Cancel
            </button>
            {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className="sr-only focus:not-sr-only min-h-12 px-4 rounded-lg border border-line-control text-base text-ink pressable">Back</button>}
            <button disabled={saving || checklistInvalid || (step === 0 && statusOptionsInvalid) || !title.trim() || extras.some((t) => !t.name.trim()) || (step === 1 && shiftMode && !usingShift) || ((step === 2 || !!taskToEdit) && (!peopleReady || (shiftMode && !usingShift)))} id="save-task-submit-btn" type="submit" className="task-form-primary pressable disabled:opacity-50">
              {saving ? 'Saving…' : taskToEdit ? '✓ Save changes' : step === 0 ? 'Next: When →' : step === 1 ? 'Next: Who does it →' : extras.length ? `✓ Save ${extras.length + 1} tasks` : '✓ Save task'}
            </button>
            {(step === 2 || !!taskToEdit) && !peopleReady && <p className="w-full text-sm text-ink-soft" role="status">Pick who does it</p>}
            {saveError && <p role="alert" className="text-base text-bad">{saveError}</p>}
          </div>
        </form>
      </div>
      {creatingShift && <div role="dialog" aria-modal="true" aria-label={editingShift ? 'Edit shift' : 'New shift'} className="contents" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setCreatingShift(false); } }}>
        <div className="contents">
          <ShiftsPanel tasks={tasks} createOnly initialShift={editingShift} agencyId={agencyId} shifts={shiftRecords} venueId={venueId} timeZone={timeZone} people={knownWorkers} onCancel={() => setCreatingShift(false)} onChange={shiftChanged} />
        </div>
      </div>}
    </div>
  );
};
