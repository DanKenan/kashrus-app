import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Seal } from './Seal';
import { primeChime, playChime } from '../lib/kioskChime';
import {
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Camera,
  Edit3,
  Trash2,
  Plus,
  Star,
  Clock,
  Search,
  Layers,
  List as ListIcon,
  LayoutGrid,
  Table as TableIcon,
} from 'lucide-react';
import { Task, TaskStatus, TaskCheckIn, User as UserType } from '../types';
import { formatExactTime, formatTaskSchedule, formatTaskTimes, taskCategories, boardTier } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';
import { captureEditBaseline } from '../lib/api';
import { categoryVars, isDirectlyAssigned } from '../lib/categoryStyle';

/**
 * KioskTaskPanel — the signed-in wall-tablet view (D3a, design only).
 *
 * Replaces the stats card and filter bar on the kiosk ONLY, with the same
 * controls at kiosk sizes (search, shift-day filter, categories, the tab
 * filter, New Assignment, and the view switch — List is the kiosk default,
 * Table and Cards render the existing views unchanged).
 * Every control calls the SAME App handler with the SAME arguments as
 * TaskCardView/TaskTableView; nothing here fetches, writes or reorders.
 * The list is App's own sortedTasks (same filters, same board order).
 * Expand/collapse is local presentation state.
 */

type TabFilter = 'all' | 'mine' | 'pending' | 'completed';

interface KioskTaskPanelProps {
  tasks: Task[];
  currentUser: UserType;
  venueName?: string;
  activeFilter: TabFilter;
  onSelectFilter: (f: TabFilter) => void;
  totalTasks: number;
  completedTasks: number;
  myTotal: number;
  myCompleted: number;
  onUpdateStatus: (taskId: string, status: TaskStatus, isCompleted: boolean) => Promise<boolean>;
  onUpdateNotes: (taskId: string, notes: string, baselineVersion?: number) => void;
  onCheckIn: (taskId: string, photoData?: string, photoCaption?: string) => void;
  onRemoveCheckIn?: (taskId: string, checkInId: string) => void;
  onMoveTask?: (taskId: string, direction: 'up' | 'down') => void;
  canReorder?: boolean;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTaskModal?: () => void;
  isAdmin: boolean;
  onDeleteVenue?: () => void;
  onEndShift: () => void;
  // The filter bar's controls, kept on the kiosk (restyled to kiosk sizes).
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  categories: string[];
  categoryCounts?: Record<string, number>;
  showOnlyTodaySchedule: boolean;
  onToggleScheduleFilter: () => void;
  view: 'list' | 'table' | 'cards';
  onViewChange: (v: 'list' | 'table' | 'cards') => void;
  /** The existing table or cards view, rendered when that view is chosen. */
  children?: React.ReactNode;
}

// Same yes_no / status_select completion rules as TaskCardView.
const statusSelectIsDone = (task: Task, value: string) =>
  task.completedStatusValues && task.completedStatusValues.length > 0
    ? task.completedStatusValues.includes(value)
    : ['completed', 'done', 'passed', 'approved', 'yes'].includes(value.toLowerCase());

const statusOptions = (task: Task) =>
  task.customStatusOptions && task.customStatusOptions.length > 0
    ? task.customStatusOptions
    : ['Pending', 'In Progress', 'Blocked', 'Completed'];

const isUnset = (s?: string) => !s || s.toLowerCase() === 'pending';

type Tone = 'ok' | 'bad' | 'warn' | 'ink' | 'open';

/** The words and dot colour shown on a row. Words always carry the meaning. */
function rowStatus(task: Task): { word: string; tone: Tone } {
  const by = task.updatedByName || task.updatedByEmail || '';
  const at = formatExactTime(task.updatedAt);
  const who = [by, at].filter(Boolean).join(' · ');
  const withWho = (w: string) => (who ? `${w} · ${who}` : w);

  if (task.inputType === 'check_in') {
    const n = task.checkIns?.length || 0;
    if (task.isCompleted) return { word: withWho('Done'), tone: 'ok' };
    return n > 0 ? { word: `${n} ${n === 1 ? 'check' : 'checks'}`, tone: 'ink' } : { word: 'Open', tone: 'open' };
  }
  if (task.inputType === 'yes_no') {
    if (task.currentStatus === 'yes') return { word: withWho('Yes'), tone: task.isCompleted ? 'ok' : 'ink' };
    if (task.currentStatus === 'no') return { word: withWho('No'), tone: 'bad' };
    return { word: task.isCompleted ? withWho('Done') : 'Open', tone: task.isCompleted ? 'ok' : 'open' };
  }
  if (task.inputType === 'status_select') {
    if (task.isCompleted) return { word: withWho(isUnset(task.currentStatus) ? 'Done' : task.currentStatus), tone: 'ok' };
    if (!isUnset(task.currentStatus)) return { word: withWho(task.currentStatus), tone: 'warn' };
    return { word: 'Open', tone: 'open' };
  }
  return task.isCompleted ? { word: withWho('Done'), tone: 'ok' } : { word: 'Open', tone: 'open' };
}

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  bad: 'bg-bad',
  warn: 'bg-warn',
  ink: 'bg-ink-soft',
  open: 'border-2 border-line-control',
};

/** Keep the sticky strip just under the shared (sticky) Header. */
function useHeaderHeight() {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = document.querySelector('header');
    if (!el) return;
    const read = () => setH(Math.round(el.getBoundingClientRect().height));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return h;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div
      data-kiosk-progress
      role="img"
      aria-label={`${done} of ${total} done`}
      className="flex items-center gap-3 shrink-0"
    >
      <svg viewBox="0 0 64 64" className="w-12 h-12 sm:w-16 sm:h-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="var(--gold-deep)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
        />
      </svg>
      <span className="flex items-baseline gap-2 whitespace-nowrap" aria-hidden>
        <span className="tnum text-k-display lg:text-k-hero font-bold">{done}</span>
        <span className="tnum text-k-body text-ink-soft">of {total} done</span>
      </span>
    </div>
  );
}

type Saving = Record<string, { op: number; toDone: boolean }>;
type Confirmation = { taskId: string; title: string; firstName: string; op: number; phase: 'confirmed' | 'undoing' };
const sealEase = [0.22, 1, 0.36, 1] as const;

const btn64 = 'min-h-11 min-w-11 sm:min-h-16 sm:min-w-16';

export const KioskTaskPanel: React.FC<KioskTaskPanelProps> = ({
  tasks,
  currentUser,
  venueName,
  activeFilter,
  onSelectFilter,
  totalTasks,
  completedTasks,
  myTotal,
  myCompleted,
  onUpdateStatus,
  onUpdateNotes,
  onCheckIn,
  onRemoveCheckIn,
  onMoveTask,
  canReorder,
  onEditTask,
  onDeleteTask,
  onOpenTaskModal,
  isAdmin,
  onDeleteVenue,
  onEndShift,
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  categories,
  categoryCounts,
  showOnlyTodaySchedule,
  onToggleScheduleFilter,
  view,
  onViewChange,
  children,
}) => {
  const headerH = useHeaderHeight();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [notesState, setNotesState] = useState<Record<string, string>>({});
  // Same baseline rule as TaskCardView: frozen when the notes editor opens.
  const [notesBaseline, setNotesBaseline] = useState<Record<string, number | undefined>>({});

  const [saving, setSaving] = useState<Saving>({});
  // The ref makes the duplicate-tap and operation guards synchronous, before React renders.
  const savingRef = useRef<Saving>({});
  const savingMine = useRef<Record<string, boolean>>({});
  const [bar, setBar] = useState<Confirmation | null>(null);
  const opSeq = useRef(0);
  const barOp = useRef<number | null>(null);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = useReducedMotion();

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimer(); };
  }, []);

  const updateToggle = async (taskId: string, title: string, toDone: boolean, undoBarOp?: number) => {
    if (savingRef.current[taskId]) return;
    // A tap during the expired bar’s exit remains the normal row toggle.
    const isBarUndo = undoBarOp !== undefined && barOp.current === undoBarOp;
    const op = ++opSeq.current;
    const firstName = currentUser.name.split(' ')[0];
    savingRef.current = { ...savingRef.current, [taskId]: { op, toDone } };
    const task = tasks.find((t) => t.id === taskId);
    savingMine.current[taskId] = !!task && (task.assignedTo.includes('all') || task.assignedTo.includes(currentUser.email));
    setSaving(savingRef.current);
    if (toDone) primeChime();
    if (isBarUndo) {
      clearTimer();
      setBar((current) => current?.op === undoBarOp ? { ...current, phase: 'undoing' } : current);
    }
    let confirmed = false;
    try {
      confirmed = await onUpdateStatus(taskId, toDone ? 'completed' : 'pending', toDone);
    } catch { /* App owns rollback and the error toast; no second error surface here. */ }
    if (!mounted.current || savingRef.current[taskId]?.op !== op) return;
    const next = { ...savingRef.current };
    delete next[taskId];
    delete savingMine.current[taskId];
    savingRef.current = next;
    setSaving(next);
    if (confirmed && toDone) {
      // Do not check the filtered tasks: Pending hides the optimistic row before this response.
      clearTimer();
      barOp.current = op;
      setBar({ taskId, title, firstName, op, phase: 'confirmed' });
      playChime();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (barOp.current === op) barOp.current = null;
        if (mounted.current) setBar((current) => current?.op === op ? null : current);
      }, 5000);
    } else if (isBarUndo) {
      // An older undo must not dismiss a newer row's confirmation.
      if (barOp.current === undoBarOp) barOp.current = null;
      setBar((current) => current?.op === undoBarOp ? null : current);
    }
  };

  const canFill = canUserFillTasks(currentUser);
  const canAssign = canUserAssignTasks(currentUser);
  const savingCompletions = Object.entries<{ op: number; toDone: boolean }>(saving).filter(([, entry]) => entry.toDone);
  const displayedCompleted = Math.max(0, completedTasks - savingCompletions.length);
  const displayedMyCompleted = Math.max(0, myCompleted - savingCompletions.filter(([id]) => savingMine.current[id]).length);
  const remaining = Math.max(0, totalTasks - displayedCompleted);
  const ringDone = activeFilter === 'mine' ? displayedMyCompleted : displayedCompleted;
  const ringTotal = activeFilter === 'mine' ? myTotal : totalTasks;

  const toggleRow = (id: string) => {
    const isOpen = !!open[id];
    if (!isOpen && canFill) {
      setNotesBaseline((prev) => ({ ...prev, [id]: captureEditBaseline() }));
    } else if (isOpen) {
      setNotesBaseline((prev) => {
        if (prev[id] === undefined) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setOpen((prev) => ({ ...prev, [id]: !isOpen }));
  };

  const readPhoto = (taskId: string, file: File) => {
    // Same capture path as TaskCardView: resize to max 800 px, JPEG 0.7.
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 800 / Math.max(img.width, img.height));
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        onCheckIn(taskId, dataUrl);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const counts: Record<string, number> = categoryCounts ?? {};
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  const filters: { key: TabFilter; label: string }[] = [
    { key: 'all', label: `All Tasks (${totalTasks})` },
    { key: 'mine', label: `Assigned to Me (${displayedMyCompleted}/${myTotal})` },
    { key: 'pending', label: `Pending (${remaining})` },
  ];

  /** The control at the row's end (start in RTL): one 64 px target. */
  const rowControl = (task: Task) => {
    if (!canFill) return null;
    if (task.inputType === 'toggle' || task.inputType === 'checkbox') {
      const busy = !!saving[task.id];
      const done = !busy && task.isCompleted;
      return (
        <button
          data-kiosk-check
          onClick={() => updateToggle(task.id, task.title, !task.isCompleted, task.isCompleted && bar?.taskId === task.id ? bar.op : undefined)}
          disabled={busy}
          aria-busy={busy}
          aria-pressed={done}
          aria-label={busy ? `Saving: ${task.title}` : done ? `Undo: ${task.title}` : `Mark done: ${task.title}`}
          title={busy ? 'Saving…' : done ? 'Click to cancel verification' : 'Sign and mark as complete'}
          className={`pressable relative shrink-0 w-11 h-11 sm:w-16 sm:h-16 rounded-xl flex items-center justify-center border-2 ${
            done ? 'bg-gold-deep border-gold-deep text-paper e2' : 'bg-surface border-line-control text-ink-faint'
          }`}
          style={{ transition: 'background-color 120ms cubic-bezier(0.22,1,0.36,1), border-color 120ms cubic-bezier(0.22,1,0.36,1), transform 120ms cubic-bezier(0.22,1,0.36,1)' }}
        >
          <span
            aria-hidden
            className="absolute w-6 h-6 sm:w-8 sm:h-8 rounded-full border border-line-strong dark:border-ink-faint"
            style={{ opacity: done ? 0 : 1, transition: 'opacity 120ms cubic-bezier(0.22,1,0.36,1)' }}
          />
          <Check
            className="w-6 h-6 sm:w-8 sm:h-8"
            style={{ opacity: done ? 1 : 0, transition: 'opacity 120ms cubic-bezier(0.22,1,0.36,1)' }}
            strokeWidth={3}
            aria-hidden
          />
        </button>
      );
    }
    if (task.inputType === 'check_in') {
      const n = task.checkIns?.length || 0;
      return (
        <button
          data-kiosk-check
          onClick={() => onCheckIn(task.id)}
          title="Log that you did this check right now"
          className={`pressable shrink-0 ${btn64} px-3 sm:px-4 rounded-xl flex items-center justify-center gap-2 bg-gold-deep text-paper e2 text-base sm:text-k-body font-semibold`}
        >
          <Check className="w-6 h-6" strokeWidth={3} aria-hidden />
          <span className="hidden sm:inline">Log check</span>
          <span className="sm:hidden">Log</span>
          {n > 0 && <span className="tnum">{n}</span>}
        </button>
      );
    }
    // yes_no and status_select: the choices live in the expanded row.
    return null;
  };

  const choiceBtn = (selected: boolean, tone: 'ok' | 'bad' | 'ink') =>
    `pressable ${btn64} px-4 rounded-xl flex items-center justify-center gap-2 text-base sm:text-k-body font-semibold border-2 ${
      selected
        ? tone === 'ok'
          ? 'bg-ok-bg border-ok text-ok'
          : tone === 'bad'
          ? 'bg-bad-bg border-bad text-bad'
          : 'bg-sunken border-ink text-ink'
        : 'bg-surface border-line-control text-ink'
    }`;

  return (
    <section data-kiosk="tasks" className="relative">
      {/* Sticky strip: venue, progress, End shift (never over a row). */}
      <div
        className="sticky z-20 -mx-3 sm:-mx-6 lg:-mx-8 px-3 sm:px-6 lg:px-8 py-2 sm:py-3 bg-paper/95 backdrop-blur-md border-b border-line"
        style={{ top: headerH }}
      >
        <div className="flex items-center gap-3 sm:gap-6">
          <ProgressRing done={ringDone} total={ringTotal} />
          <p dir="auto" className="min-w-0 flex-1 text-base sm:text-k-body font-semibold text-ink-soft truncate">
            {venueName || ''}
          </p>
          <button
            onClick={onEndShift}
            className={`pressable shrink-0 max-w-[50%] ${btn64} px-4 sm:px-6 rounded-xl bg-red-700 text-white text-base sm:text-k-body font-semibold e2`}
          >
            <span dir="auto" className="block truncate">End shift — {currentUser.name.split(' ')[0]}</span>
          </button>
        </div>
      </div>

      {/* Search + shift days + view switch + New Assignment (the filter bar, kiosk sizes) */}
      <div className="flex flex-col gap-3 mt-3 sm:mt-4 mb-3 sm:mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full lg:w-auto lg:flex-1 lg:min-w-[20rem] lg:max-w-xl">
            <Search className="absolute start-4 top-1/2 -translate-y-1/2 w-6 h-6 text-ink-faint pointer-events-none" aria-hidden />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search tasks, names, notes…"
              aria-label="Search tasks"
              className="w-full min-h-11 sm:min-h-16 ps-14 pe-16 text-base sm:text-k-body rounded-xl bg-surface border border-line-control text-ink placeholder-ink-faint focus:outline-none focus:border-gold"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                aria-label="Clear search"
                className={`absolute end-0 top-1/2 -translate-y-1/2 ${btn64} flex items-center justify-center text-ink-soft`}
              >
                <X className="w-6 h-6" aria-hidden />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              onClick={onToggleScheduleFilter}
              aria-pressed={showOnlyTodaySchedule}
              title="Filter tasks scheduled for today's active shift"
              className={`pressable ${btn64} px-4 rounded-xl text-base font-semibold border ${
                showOnlyTodaySchedule ? 'bg-gold-wash text-gold-ink border-gold' : 'bg-surface text-ink-soft border-line'
              }`}
            >
              {showOnlyTodaySchedule ? '✓ Active Today' : 'All Shift Days'}
            </button>
            <div className="flex items-center gap-1 p-1 rounded-xl bg-sunken border border-line" role="group" aria-label="View">
              {([
                ['list', 'List', ListIcon],
                ['cards', 'Cards', LayoutGrid],
                ['table', 'Table', TableIcon],
              ] as const).map(([key, label, Icon]) => (
                <button
                  key={key}
                  onClick={() => onViewChange(key)}
                  aria-pressed={view === key}
                  className={`pressable ${btn64} px-3 rounded-lg text-base font-semibold flex items-center gap-2 ${
                    view === key ? 'bg-surface text-ink e1' : 'text-ink-soft'
                  }`}
                >
                  <Icon className="w-5 h-5" aria-hidden />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {isAdmin && onOpenTaskModal && (
              <button
                onClick={onOpenTaskModal}
                title="Register a new daily task assignment"
                className={`pressable ${btn64} px-4 rounded-xl text-base font-semibold border border-line-control bg-surface text-ink flex items-center gap-2`}
              >
                <Plus className="w-5 h-5" aria-hidden />
                <span>New Assignment</span>
              </button>
            )}
          </div>
        </div>

        {/* The stats card's tab filter */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => onSelectFilter(f.key)}
              aria-pressed={activeFilter === f.key}
              className={`pressable ${btn64} px-4 sm:px-5 rounded-xl text-base font-semibold tnum border ${
                activeFilter === f.key ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink-soft border-line'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Category pills (one tap, each in its own colour) */}
        {categories.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by category">
            <button
              onClick={() => onCategoryChange('all')}
              aria-pressed={selectedCategory === 'all'}
              className={`pressable shrink-0 ${btn64} px-4 rounded-full text-base font-semibold border flex items-center gap-2 ${
                selectedCategory === 'all' ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink-soft border-line'
              }`}
            >
              <Layers className="w-5 h-5" aria-hidden />
              <span>All</span>
              {categoryCounts && <span className="tnum">{totalCount}</span>}
            </button>
            {categories.map((c) => {
              const active = selectedCategory === c;
              const count = categoryCounts?.[c];
              return (
                <button
                  key={c}
                  onClick={() => onCategoryChange(active ? 'all' : c)}
                  aria-pressed={active}
                  style={categoryVars(c)}
                  title={active ? 'Show all categories' : `Show only ${c}`}
                  className={`pressable shrink-0 ${btn64} px-4 rounded-full text-base font-semibold border flex items-center gap-2 ${
                    active ? 'cat-chip cat-ring cat-text ring-2' : 'bg-surface text-ink-soft border-line'
                  }`}
                >
                  <span className="cat-dot w-3 h-3 rounded-full shrink-0" aria-hidden />
                  <span dir="auto" className="max-w-[220px] truncate">{c}</span>
                  {typeof count === 'number' && <span className="tnum">{count}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {view !== 'list' ? (
        children
      ) : tasks.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-line p-8 text-center">
          <p className="text-k-body text-ink-soft">No tasks to show here.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((task, i) => {
            const phase = saving[task.id];
            const st = phase ? { word: 'Saving…', tone: 'open' as const } : rowStatus(task);
            const isOpen = !!open[task.id];
            const mine = isDirectlyAssigned(task, currentUser);
            const tier = boardTier(task, currentUser?.email);
            const upBlocked = i === 0 || boardTier(tasks[i - 1], currentUser?.email) !== tier;
            const downBlocked = i === tasks.length - 1 || boardTier(tasks[i + 1], currentUser?.email) !== tier;
            const currentNote = notesState[task.id] !== undefined ? notesState[task.id] : task.notes;
            const control = rowControl(task);
            const rowId = `kiosk-row-${task.id}`;

            return (
              <li
                key={task.id}
                data-kiosk-row
                data-kiosk-phase={phase ? phase.toDone ? 'saving' : 'undoing' : undefined}
                data-task-id={task.id}
                aria-expanded={isOpen}
                style={categoryVars(task.category)}
                className={`relative rounded-2xl border overflow-hidden ${task.inputType === 'toggle' || task.inputType === 'checkbox' ? 'transition-colors duration-[120ms] ease-[cubic-bezier(0.22,1,0.36,1)]' : ''} ${
                  !phase && task.isCompleted ? 'bg-done-tint border-line' : 'bg-surface border-line e1'
                }`}
              >
                <div className="cat-spine absolute start-0 top-0 bottom-0 w-[5px]" aria-hidden />
                <div className="flex items-center gap-2 sm:gap-4 ps-3 sm:ps-5 pe-2 sm:pe-3">
                  <button
                    onClick={() => toggleRow(task.id)}
                    aria-expanded={isOpen}
                    aria-controls={rowId}
                    className="min-w-0 flex-1 min-h-11 sm:min-h-16 py-2 flex items-center gap-3 text-start"
                  >
                    <span className={`w-3 h-3 sm:w-4 sm:h-4 rounded-full shrink-0 ${DOT[st.tone]}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span
                        data-kiosk-row-title
                        dir="auto"
                        className={`text-base sm:text-k-title font-semibold break-words ${isOpen ? 'block' : 'line-clamp-2'}`}
                      >
                        {task.title}
                      </span>
                      <span data-kiosk-status dir="auto" className="block text-base text-ink-soft truncate">
                        {st.word}
                      </span>
                    </span>
                    {task.inputType === 'yes_no' || task.inputType === 'status_select' || !control ? (
                      <ChevronDown
                        className={`w-6 h-6 sm:w-8 sm:h-8 shrink-0 text-ink-soft transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                  {control}
                </div>

                {isOpen && (
                  <div id={rowId} className="ps-4 sm:ps-6 pe-3 sm:pe-5 pb-4 pt-1 flex flex-col gap-3 border-t border-line/70">
                    <div className="flex flex-wrap items-center gap-2 pt-3 text-base text-ink-soft">
                      {task.priority === 'high' && <span className="font-semibold text-bad">High priority</span>}
                      {taskCategories(task).map((cat) => (
                        <span key={cat} style={categoryVars(cat)} className="cat-chip inline-flex items-center gap-2 px-2 py-0.5 rounded-md border">
                          <span className="cat-dot w-2.5 h-2.5 rounded-full shrink-0" aria-hidden />
                          {cat}
                        </span>
                      ))}
                      {mine && (
                        <span className="inline-flex items-center gap-1 text-gold-ink font-semibold">
                          <Star className="w-4 h-4 fill-current" aria-hidden /> For you
                        </span>
                      )}
                      <span className="tnum inline-flex items-center gap-1">
                        <Clock className="w-4 h-4" aria-hidden /> {formatTaskTimes(task)}
                      </span>
                      <span>{formatTaskSchedule(task)}</span>
                    </div>

                    {task.description && (
                      <p dir="auto" className="text-k-body text-ink whitespace-pre-wrap break-words">{task.description}</p>
                    )}

                    {canFill && task.inputType === 'yes_no' && (
                      <div className="grid grid-cols-2 gap-3 max-w-xl">
                        <button
                          onClick={() => {
                            if (task.currentStatus === 'yes' && task.isCompleted) onUpdateStatus(task.id, 'pending', false);
                            else onUpdateStatus(task.id, 'yes', true);
                          }}
                          aria-pressed={task.currentStatus === 'yes'}
                          title={task.currentStatus === 'yes' ? 'Click to cancel verification' : 'Mark as Yes (Verified)'}
                          className={choiceBtn(task.currentStatus === 'yes', 'ok')}
                        >
                          <Check className="w-6 h-6" aria-hidden /> Yes
                        </button>
                        <button
                          onClick={() => {
                            if (task.currentStatus === 'no') onUpdateStatus(task.id, 'pending', false);
                            else onUpdateStatus(task.id, 'no', false);
                          }}
                          aria-pressed={task.currentStatus === 'no'}
                          title={task.currentStatus === 'no' ? 'Click to cancel choice' : 'Mark as No (Pending)'}
                          className={choiceBtn(task.currentStatus === 'no', 'bad')}
                        >
                          <X className="w-6 h-6" aria-hidden /> No
                        </button>
                      </div>
                    )}

                    {canFill && task.inputType === 'status_select' && (
                      <div className="flex flex-wrap gap-3" role="group" aria-label="Status">
                        {statusOptions(task).map((opt) => {
                          const sel = task.currentStatus === opt;
                          const done = statusSelectIsDone(task, opt);
                          return (
                            <button
                              key={opt}
                              onClick={() => {
                                // Same as the dropdown: choosing the shown value again changes nothing.
                                if (sel) return;
                                onUpdateStatus(task.id, opt, statusSelectIsDone(task, opt));
                              }}
                              aria-pressed={sel}
                              className={choiceBtn(sel, done ? 'ok' : 'ink')}
                            >
                              {sel && <Check className="w-5 h-5" aria-hidden />}
                              <span dir="auto">{opt}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {canFill && task.inputType === 'check_in' && (
                      <label
                        className={`pressable self-start ${btn64} px-4 rounded-xl flex items-center gap-2 border-2 border-line-control bg-surface text-ink text-base sm:text-k-body font-semibold cursor-pointer`}
                        title="Log check with photo evidence"
                      >
                        <Camera className="w-6 h-6" aria-hidden />
                        <span>Log check with photo</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            readPhoto(task.id, file);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}

                    {task.inputType === 'check_in' && (task.checkIns?.length || 0) > 0 && (
                      <ul className="flex flex-col gap-2">
                        {task.checkIns!.map((c: TaskCheckIn) => (
                          <li key={c.id} className="rounded-xl bg-sunken border border-line px-3 py-2">
                            <div className="flex items-center gap-3 text-base">
                              <span dir="auto" className="font-semibold text-ink truncate">{c.byName || c.byEmail || 'Someone'}</span>
                              <span className="tnum text-ink-soft ms-auto shrink-0">{formatExactTime(c.at)}</span>
                              {canFill && onRemoveCheckIn && (
                                <button
                                  onClick={() => onRemoveCheckIn(task.id, c.id)}
                                  title="Remove this check"
                                  aria-label="Remove check"
                                  className={`pressable shrink-0 ${btn64} rounded-xl flex items-center justify-center text-ink-soft hover:text-bad`}
                                >
                                  <X className="w-6 h-6" aria-hidden />
                                </button>
                              )}
                            </div>
                            {c.photoData && (
                              <img
                                src={c.photoData}
                                alt={c.photoCaption || 'Check-in photo'}
                                className="mt-2 w-full max-w-md rounded-lg border border-line object-cover max-h-60 cursor-pointer"
                                onClick={() => {
                                  // Same tap-to-enlarge as TaskCardView.
                                  const w = window.open();
                                  if (w) {
                                    w.document.write(`<img src="${c.photoData}" style="max-width:100%"/>`);
                                  }
                                }}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Notes: same editor rule as TaskCardView (save on blur, baseline from open). */}
                    {canFill ? (
                      <label className="flex flex-col gap-1">
                        <span className="text-base font-medium text-ink-soft">Notes</span>
                        <textarea
                          rows={2}
                          dir="auto"
                          value={currentNote}
                          onChange={(e) => setNotesState((prev) => ({ ...prev, [task.id]: e.target.value }))}
                          onBlur={() => {
                            if (currentNote !== task.notes) {
                              onUpdateNotes(task.id, currentNote, notesBaseline[task.id]);
                            }
                          }}
                          placeholder="Log details, seal serial numbers, or supplier lot numbers..."
                          className="w-full text-k-body p-3 rounded-xl bg-sunken border border-line-control text-ink placeholder-ink-faint focus:outline-none focus:border-gold"
                        />
                      </label>
                    ) : (
                      task.notes && (
                        <div className="rounded-xl bg-sunken border border-line p-3">
                          <p className="text-base font-medium text-ink-soft">Notes</p>
                          <p dir="auto" className="text-k-body whitespace-pre-wrap break-words">{task.notes}</p>
                        </div>
                      )
                    )}

                    {canAssign && (
                      <div className="flex flex-wrap items-center gap-3">
                        {canReorder && onMoveTask && (
                          <>
                            <button
                              onClick={() => onMoveTask(task.id, 'up')}
                              disabled={upBlocked}
                              title={upBlocked ? 'Top of its section' : 'Move up'}
                              aria-label="Move up"
                              className={`pressable ${btn64} rounded-xl border border-line bg-surface flex items-center justify-center disabled:opacity-30`}
                            >
                              <ChevronUp className="w-6 h-6" aria-hidden />
                            </button>
                            <button
                              onClick={() => onMoveTask(task.id, 'down')}
                              disabled={downBlocked}
                              title={downBlocked ? 'Bottom of its section' : 'Move down'}
                              aria-label="Move down"
                              className={`pressable ${btn64} rounded-xl border border-line bg-surface flex items-center justify-center disabled:opacity-30`}
                            >
                              <ChevronDown className="w-6 h-6" aria-hidden />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => onEditTask(task)}
                          className={`pressable ${btn64} px-4 rounded-xl border border-line bg-surface text-base font-semibold flex items-center gap-2`}
                        >
                          <Edit3 className="w-5 h-5" aria-hidden /> Edit
                        </button>
                        <button
                          onClick={() => onDeleteTask(task.id)}
                          className={`pressable ${btn64} px-4 rounded-xl border border-bad text-bad bg-surface text-base font-semibold flex items-center gap-2`}
                        >
                          <Trash2 className="w-5 h-5" aria-hidden /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AnimatePresence>
        {bar && (
          <motion.div
            key="confirmation"
            data-kiosk-confirm
            role="status"
            aria-live="polite"
            initial={{ y: reducedMotion ? 0 : 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reducedMotion ? 0.00001 : 0.2, ease: sealEase } }}
            transition={{ duration: reducedMotion ? 0.00001 : 0.32, ease: sealEase }}
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-line bg-surface px-3 sm:px-6 pt-3"
            style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
          >
            {bar.phase === 'confirmed' ? (
              <motion.div
                key={bar.op}
                data-kiosk-seal
                className="shrink-0"
                initial={{ scale: reducedMotion ? 1 : 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: reducedMotion ? 0.00001 : 0.2, delay: reducedMotion ? 0 : 0.08, ease: sealEase }}
              >
                <Seal size={40} label="Recorded" />
              </motion.div>
            ) : (
              <span aria-hidden className="shrink-0 w-10 h-10 rounded-full border border-line-strong dark:border-ink-faint" />
            )}
            <p dir="auto" className="min-w-0 flex-1 truncate text-k-body font-semibold text-ink">
              {bar.phase === 'undoing' ? 'Undoing…' : bar.firstName ? `Recorded. Thank you, ${bar.firstName}.` : 'Recorded. Thank you.'}
            </p>
            <button
              data-kiosk-undo
              aria-label={`Undo: ${bar.title}`}
              disabled={bar.phase === 'undoing'}
              onClick={() => {
                // An expired bar (5 s passed, exit animation running) must not undo.
                if (barOp.current !== bar.op) return;
                updateToggle(bar.taskId, bar.title, false, bar.op);
              }}
              className="pressable shrink-0 h-16 min-w-16 px-4 rounded-xl border-2 border-line-control bg-surface text-ink text-k-body font-semibold"
            >
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {onDeleteVenue && (
        <div className="mt-8 flex justify-center">
          <button
            onClick={onDeleteVenue}
            className={`${btn64} px-4 text-base text-bad underline underline-offset-4`}
          >
            Delete venue
          </button>
        </div>
      )}
    </section>
  );
};
