import { taskOccursToday } from '../lib/taskOccurrences';
import { TaskEmptyState } from './TaskEmptyState';
import { whoSeesLabel } from '../lib/whoSees';
import { WhoSeesTag } from './WhoSeesTag';
import { shiftDisplayWeekday } from '../lib/shiftTaskDay';
import type { Shift } from '../types';
import { shiftLabel, shiftTaskAppliesAt, shiftTaskOverdueAt } from '../lib/shifts';
import { isNoTimeTask, taskAppliesOn, type TaskDaySection } from '../lib/taskDay';
import { seesOnlyOwnTasks } from '../lib/taskDay';
import { ANY_TIME_LABEL } from '../lib/anyTime';
import { checkInCoversDue, isTaskOverdue, OVERDUE_CHIP_CLASS } from '../lib/overdue';
import { minutesIn, workDateIn, weekdayIn } from '../lib/workday';
import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  Clock,
  Check,
  X,
  MessageSquare,
  Edit3,
  Trash2,
  CheckCircle2,
  AlertCircle,
  CalendarDays,
  ShieldCheck,
  Star,
  Camera,
} from 'lucide-react';
import { Task, TaskStatus, TaskCheckIn, User as UserType } from '../types';
import { formatTimeAgo, formatExactTime, formatTaskSchedule, formatTaskTimes, taskCategories } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';
import { captureEditBaseline } from '../lib/api';
import { categoryVars, isDirectlyAssigned } from '../lib/categoryStyle';
import { TaskInstructions } from './TaskInstructions';
import { TaskAnswerPhoto, compressPhoto } from './TaskAnswerPhoto';
import { CheckInPhoto } from './CheckInPhoto';

interface TaskCardViewProps {
  shiftsById?: Map<string, Shift>;
  isKiosk?: boolean;
  roster?: ReadonlyArray<{ id?: string; email?: string; name: string }>;
  /** QA2 #25: the venue's time zone, for the Overdue chip. */
  timeZone?: string;
  tasks: Task[];
  sections?: TaskDaySection<Task>[];
  currentUser: UserType | null;
  onUpdateStatus: (taskId: string, status: TaskStatus, isCompleted: boolean) => void;
  onUpdateNotes: (taskId: string, notes: string, baselineVersion?: number) => void;
  onCheckIn: (taskId: string, photoData?: string, photoCaption?: string) => void;
  onRemoveCheckIn?: (taskId: string, checkInId: string) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTaskModal?: () => void;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
}

const getInitials = (nameOrEmail: string) => {
  if (!nameOrEmail) return 'MK';
  const clean = nameOrEmail.split('@')[0].trim();
  const parts = clean.split(/[ ._-]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
};

export const TaskCardView: React.FC<TaskCardViewProps> = ({
  shiftsById = new Map(),
  isKiosk = false,
  roster = [],
  tasks,
  sections,
  currentUser,
  onUpdateStatus,
  onUpdateNotes,
  onCheckIn,
  onRemoveCheckIn,
  onEditTask,
  onDeleteTask,
  onOpenTaskModal,
  hasActiveFilters = false,
  onClearFilters,
  timeZone,
}) => {
  // QA2 #25: the same overdue rule as the dashboard, in the venue's zone.
  const now = new Date();
  const nowMinutes = timeZone ? minutesIn(timeZone, now) : null;
  // Overdue only means something on a task that is due today ("All days" lists other days too).
  const todayYmd = timeZone ? workDateIn(timeZone, now) : null;
  const todayWeekday = timeZone ? weekdayIn(timeZone, now) : null;
  const dueToday = (t: Task) => {
    if (todayYmd === null || todayWeekday === null || nowMinutes === null) return true;
    const shift = t.shiftId ? shiftsById.get(t.shiftId) : undefined;
    return shift ? taskOccursToday(t, shiftsById, todayYmd, todayWeekday, nowMinutes)
      : taskAppliesOn(t, todayYmd, todayWeekday);
  };
  const isOverdue = (task: Task) => {
    const shift = task.shiftId ? shiftsById.get(task.shiftId) : undefined;
    if (shift) return !task.isCompleted && todayYmd !== null && todayWeekday !== null && nowMinutes !== null &&
      shiftTaskOverdueAt(shift, todayYmd, todayWeekday, nowMinutes, task, timeZone);
    if (todayYmd && nowMinutes !== null && checkInCoversDue(task, todayYmd, nowMinutes, timeZone)) return false;
    return isTaskOverdue(task, nowMinutes) && dueToday(task);
  };
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  const [notesState, setNotesState] = useState<Record<string, string>>({});
  // ROUND 5 — write baseline per task, captured when the notes editor OPENS
  // (what the user sees), not at save time. Passed to onUpdateNotes so the
  // save carries the version the notes were rendered from.
  const [notesBaseline, setNotesBaseline] = useState<Record<string, number | undefined>>({});

  const toggleNotes = (taskId: string, isOpen: boolean) => {
    if (!isOpen) {
      // Opening the editor: freeze the baseline at what the user is about to see.
      setNotesBaseline((prev) => ({ ...prev, [taskId]: captureEditBaseline() }));
    } else {
      // Closing: editing session over, drop the baseline.
      setNotesBaseline((prev) => {
        if (prev[taskId] === undefined) return prev;
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
    setExpandedNotes((prev) => ({ ...prev, [taskId]: !isOpen }));
  };

  if (tasks.length === 0) {
    return <TaskEmptyState hasActiveFilters={hasActiveFilters} onClearFilters={onClearFilters} canCreate={!!onOpenTaskModal && canUserAssignTasks(currentUser)} onCreate={onOpenTaskModal} kiosk={isKiosk} />;
  }

  return (
    <div className="space-y-3.5">
      {(sections ?? [{ key: 'list', label: '', tasks }]).map((section) => (
        <div key={section.key} data-day-section={sections ? section.key : undefined} className="space-y-3.5">
          {section.label && <h3 className="pt-4 text-xs font-semibold text-ink-soft">{section.label}</h3>}
          {section.tasks.map((task, i) => {
        const isNotesOpen = expandedNotes[task.id];
        const currentNote = notesState[task.id] !== undefined ? notesState[task.id] : task.notes;
        const canFill = canUserFillTasks(currentUser);
        const canAssign = canUserAssignTasks(currentUser);
        const mine = isDirectlyAssigned(task, currentUser);
        const audience = whoSeesLabel(task, { viewer: currentUser, mode: isKiosk ? 'kiosk' : seesOnlyOwnTasks(currentUser, canAssign) ? 'own' : 'editor', shiftsById, roster, todayYmd, todayWeekday, nowMinutes });
        const done = task.isCompleted;

        return (
          <React.Fragment key={task.id}>
          {isNoTimeTask(task) && (i === 0 || !isNoTimeTask(section.tasks[i - 1])) && <p className="pt-2 text-xs font-semibold text-ink-soft">{ANY_TIME_LABEL}</p>}
          <motion.div
            data-task-id={task.id}
            key={task.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3), ease: [0.22, 1, 0.36, 1] }}
            style={categoryVars(task.category)}
            className={`relative rounded-2xl bg-surface border border-line tactile-2 lift overflow-hidden ${
              done ? 'opacity-55' : ''
            } ${mine ? 'mine-glow' : ''}`}
          >
            {/* Category spine — every category carries its own color */}
            <div className="cat-spine absolute left-0 top-0 bottom-0 w-[5px]" aria-hidden />

            <div className={done ? 'p-2.5 sm:p-3 pl-4 sm:pl-4' : 'p-4 sm:p-5 pl-5 sm:pl-6'}>
              {/* Top Bar: Category, Assignment, Priority, Target Time, Admin Actions */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {task.priority === 'high' && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60">
                      High Priority
                    </span>
                  )}
                  {taskCategories(task).map((cat) => (
                    <span
                      key={cat}
                      style={categoryVars(cat)}
                      className="cat-chip inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold border"
                    >
                      <span className="cat-dot w-2 h-2 rounded-full shrink-0" />
                      {cat}
                    </span>
                  ))}
                  {mine && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-gold-wash text-gold-ink border border-gold/40">
                      <Star className="w-2.5 h-2.5 fill-current" />
                      For you
                    </span>
                  )}
                  <span className="tnum inline-flex items-center gap-1 text-xs font-semibold text-ink-soft">
                    <Clock className="w-3 h-3" />
                    {(task.shiftId && shiftsById.has(task.shiftId) ? shiftLabel(shiftsById.get(task.shiftId)!, shiftDisplayWeekday(shiftsById.get(task.shiftId)!, todayYmd, todayWeekday, nowMinutes, sections ? section.key : undefined), task) : formatTaskTimes(task))}
                  </span>
                  {isOverdue(task) && (
                    <span data-overdue className={OVERDUE_CHIP_CLASS} style={{ color: 'var(--bad)', backgroundColor: 'var(--bad-bg)', borderColor: 'var(--bad)' }}>
                      Overdue
                    </span>
                  )}
                </div>

                {canAssign && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => onEditTask(task)}
                      className="pressable p-1.5 text-ink-faint hover:text-gold-deep hover:bg-sunken rounded-lg transition cursor-pointer"
                      title="Edit task parameters"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteTask(task.id)}
                      className="pressable p-1.5 text-ink-faint hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition cursor-pointer"
                      title="Delete task"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Task Title with Verification Seal Badge */}
              <div className="flex items-start justify-between gap-2">
                <h3 className={`font-bold text-ink leading-snug ${done ? 'text-xs sm:text-sm' : 'text-sm sm:text-base'}`}>
                  {task.title}
                </h3>
                {task.isCompleted && (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300/80 dark:border-emerald-800">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Verified</span>
                  </span>
                )}
              </div>

              {/* Instructions: always shown, in a box that stands out (INSTRBOLD) */}
              <TaskInstructions text={task.description} />

              {/* Mashgiach Assignment & Schedule Meta */}
              <div className="flex items-center justify-between text-xs text-ink-soft mt-3 pt-2.5 border-t border-line/70">
                <div className="flex items-center gap-2">
                  <WhoSeesTag label={audience} kiosk={isKiosk} />
                </div>

                <span className="text-[11px] flex items-center gap-1 font-medium text-ink-faint">
                  {task.scheduleType === 'specific_dates' && (
                    <CalendarDays className="w-3 h-3 text-gold-deep shrink-0" />
                  )}
                  {formatTaskSchedule(task)}
                </span>
              </div>

              {/* Completion Control Bar or Read-Only Audit Bar */}
              <div className="mt-3 pt-3 border-t border-line/70">
                {/* PHOTOALL: optional photo with the answer (toggle / yes-no / status / checkbox); the camera sits beside the answer */}
                <TaskAnswerPhoto task={task} canAttach={canFill}>
                {!canFill ? (
                  <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-sunken border border-line tactile-1">
                    <div className="flex items-center gap-2.5">
                      {task.isCompleted ? (
                        <div className="w-7 h-7 rounded-xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                          <CheckCircle2 className="w-4 h-4" />
                        </div>
                      ) : (
                        <div className="w-7 h-7 rounded-xl bg-gold-wash text-gold-deep flex items-center justify-center shrink-0">
                          <AlertCircle className="w-4 h-4" />
                        </div>
                      )}
                      <div>
                        <p className={`text-xs font-bold ${
                          task.isCompleted ? 'text-emerald-900 dark:text-emerald-300' : 'text-gold-ink'
                        }`}>
                          {task.isCompleted
                            ? `Done: ${task.currentStatus ? (task.currentStatus.charAt(0).toUpperCase() + task.currentStatus.slice(1)) : 'Done'}`
                            : 'Not done yet'}
                        </p>
                        <p className="text-[10px] text-ink-faint">
                          {task.isCompleted
                            ? (task.updatedByName || task.updatedByEmail ? `By ${task.updatedByName || task.updatedByEmail}` : 'Verified completed')
                            : `Assigned: ${audience.text}`}
                        </p>
                      </div>
                    </div>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg border ${
                      task.isCompleted
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300/80'
                        : 'bg-gold-wash text-gold-ink border-gold/40'
                    }`}>
                      {task.isCompleted ? 'Done' : 'Not done'}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">

                    {/* 1. Toggle Switch */}
                    {task.inputType === 'toggle' && (
                      <div className="flex items-center justify-between w-full">
                        <span className="text-xs font-bold text-ink-soft">
                          Inspection Status: {task.isCompleted ? 'Verified Done' : 'Pending'}
                        </span>
                        <button
                          id={`mobile-task-toggle-${task.id}`}
                          onClick={() => onUpdateStatus(task.id, task.isCompleted ? 'pending' : 'completed', !task.isCompleted)}
                          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none tactile-1 ${
                            task.isCompleted ? 'bg-emerald-600' : 'bg-sunken border-line'
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              task.isCompleted ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    )}

                    {/* 2. Yes / No Buttons */}
                    {task.inputType === 'yes_no' && (
                      <div className="grid grid-cols-2 gap-2.5 w-full">
                        <button
                          id={`mobile-task-yes-${task.id}`}
                          onClick={() => {
                            if (task.currentStatus === 'yes' && task.isCompleted) {
                              onUpdateStatus(task.id, 'pending', false);
                            } else {
                              onUpdateStatus(task.id, 'yes', true);
                            }
                          }}
                          className={`pressable min-h-[44px] flex items-center justify-center gap-1.5 py-2 px-4 rounded-xl text-xs font-bold transition cursor-pointer tactile-1 ${
                            task.currentStatus === 'yes'
                              ? 'bg-gradient-to-b from-emerald-600 to-emerald-700 text-white'
                              : 'bg-sunken text-ink-soft hover:text-emerald-800 dark:hover:text-emerald-300 border border-line'
                          }`}
                          title={task.currentStatus === 'yes' ? 'Tap to undo the sign-off' : 'Mark Yes'}
                        >
                          <Check className="w-4 h-4" /> Yes
                        </button>
                        <button
                          id={`mobile-task-no-${task.id}`}
                          onClick={() => {
                            if (task.currentStatus === 'no') {
                              onUpdateStatus(task.id, 'pending', false);
                            } else {
                              onUpdateStatus(task.id, 'no', false);
                            }
                          }}
                          className={`pressable min-h-[44px] flex items-center justify-center gap-1.5 py-2 px-4 rounded-xl text-xs font-bold transition cursor-pointer tactile-1 ${
                            task.currentStatus === 'no'
                              ? 'bg-gradient-to-b from-rose-600 to-rose-700 text-white'
                              : 'bg-sunken text-ink-soft hover:text-rose-800 dark:hover:text-rose-300 border border-line'
                          }`}
                          title={task.currentStatus === 'no' ? 'Tap to clear the answer' : 'Mark No'}
                        >
                          <X className="w-4 h-4" /> No
                        </button>
                      </div>
                    )}

                    {/* 3. Status Select Dropdown with Admin Custom Values */}
                    {task.inputType === 'status_select' && (
                      <div className="w-full">
                        <select
                          id={`mobile-task-select-${task.id}`}
                          value={task.currentStatus}
                          onChange={(e) => {
                            const newStatus = e.target.value;
                            const isDone = task.completedStatusValues && task.completedStatusValues.length > 0
                              ? task.completedStatusValues.includes(newStatus)
                              : ['completed', 'done', 'passed', 'approved', 'yes'].includes(newStatus.toLowerCase());
                            onUpdateStatus(task.id, newStatus, isDone);
                          }}
                          className={`w-full min-h-[44px] px-3 py-2 text-xs font-bold rounded-xl border transition cursor-pointer bg-surface tactile-1 ${
                            task.isCompleted
                              ? 'text-emerald-900 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800'
                              : 'border-line text-ink'
                          }`}
                        >
                          {(task.customStatusOptions && task.customStatusOptions.length > 0
                            ? task.customStatusOptions
                            : ['Pending', 'In Progress', 'Blocked', 'Completed']
                          ).map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* 4. Checkbox */}
                    {task.inputType === 'checkbox' && (
                      <button
                        id={`mobile-task-check-${task.id}`}
                        onClick={() => onUpdateStatus(task.id, task.isCompleted ? 'pending' : 'completed', !task.isCompleted)}
                        className={`pressable w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl text-xs font-bold border transition cursor-pointer tactile-1 ${
                          task.isCompleted
                            ? 'bg-gradient-to-b from-emerald-600 to-emerald-700 border-emerald-600 text-white'
                            : 'bg-sunken border-line text-ink-soft hover:border-gold/60'
                        }`}
                        title={task.isCompleted ? 'Tap to undo the sign-off' : 'Sign and mark as complete'}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{task.isCompleted ? '✓ Signed & Verified (tap to undo)' : 'Sign & Complete Inspection'}</span>
                      </button>
                    )}

                    {/* 5. Repeatable check-in — every tap logs who + when under the task */}
                    {task.inputType === 'check_in' && (
                      <div className="w-full">
                        <div className="flex gap-2">
                          <button
                            id={`mobile-task-checkin-${task.id}`}
                            onClick={() => onCheckIn(task.id)}
                            className="pressable flex-1 min-h-[44px] flex items-center justify-center gap-2 rounded-xl text-xs font-bold border transition cursor-pointer tactile-1 bg-gradient-to-b from-gold to-gold-deep border-gold-deep text-white"
                            title="Log that you did this check right now"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            <span>Log check</span>
                          {(task.checkIns?.length || 0) > 0 && (
                            <span className="ml-1 px-2 py-0.5 rounded-full bg-white/25 text-[11px] font-black">
                              {task.checkIns!.length}
                            </span>
                          )}
                        </button>
                          <label
                            className="pressable min-h-[44px] px-3 flex items-center justify-center rounded-xl text-xs font-bold border transition cursor-pointer tactile-1 bg-sunken border-line text-ink-soft hover:bg-line/30"
                            title="Log check with photo evidence"
                          >
                            <Camera className="w-4 h-4" /><span className="ml-2">Photo</span>
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                // Max 800 px JPEG 0.7 (stepping down only if still over the photo cap).
                                compressPhoto(file).then((dataUrl) => onCheckIn(task.id, dataUrl)).catch(() => { /* unreadable file: nothing logged */ });
                                e.target.value = '';
                              }}
                            />
                          </label>
                        </div>
                        {(task.checkIns?.length || 0) > 0 && (
                          <ul className="mt-2 space-y-1">
                            {task.checkIns!.map((c: TaskCheckIn) => (
                              <li
                                key={c.id}
                                className="px-2.5 py-1.5 rounded-lg bg-sunken border border-line text-[11px] animate-fade-in"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="w-5 h-5 rounded-full bg-gold-wash border border-gold/40 text-gold-ink flex items-center justify-center text-[9px] font-black shrink-0">
                                    {getInitials(c.byName || c.byEmail || 'MK')}
                                  </span>
                                  <span className="font-bold text-ink truncate">
                                    {c.byName || c.byEmail || 'Someone'}
                                  </span>
                                  <span className="text-ink-faint ml-auto shrink-0 font-semibold">
                                    {formatExactTime(c.at)}
                                  </span>
                                  {onRemoveCheckIn && (
                                    <button
                                      onClick={() => onRemoveCheckIn(task.id, c.id)}
                                      className="shrink-0 p-1 rounded-md text-ink-faint hover:text-red-600 hover:bg-red-500/10"
                                      title="Remove this check"
                                      aria-label="Remove check"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                                <CheckInPhoto
                                  taskId={task.id}
                                  checkIn={c}
                                  className="mt-1.5 w-full rounded-lg border border-line object-cover max-h-40 cursor-pointer"
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
                </TaskAnswerPhoto>
              </div>

              {/* Attribution & Signature Banner */}
              <div className="flex items-center justify-between mt-2.5 pt-2 text-[11px] text-ink-faint">
                <div>
                  {task.inputType === 'check_in' && (task.checkIns?.length || 0) > 0 ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-gold shrink-0 inline-block" />
                      <span>
                        <strong className="text-ink">{task.checkIns!.length} check{task.checkIns!.length === 1 ? '' : 's'} logged</strong>
                        {' '}· last by {task.checkIns![task.checkIns!.length - 1].byName || task.checkIns![task.checkIns!.length - 1].byEmail || 'someone'} ({formatTimeAgo(task.checkIns![task.checkIns!.length - 1].at)})
                      </span>
                    </span>
                  ) : task.isCompleted && (task.updatedByName || task.updatedByEmail) ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 inline-block" />
                      <span>
                        Signed by <strong className="text-ink">{task.updatedByName || task.updatedByEmail}</strong> ({formatTimeAgo(task.updatedAt)})
                      </span>
                    </span>
                  ) : (
                    <span className="text-gold-deep font-semibold flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-gold shrink-0 inline-block animate-pulse" />
                      <span>Awaiting on-site verification</span>
                    </span>
                  )}
                </div>

                {/* Notes Accordion trigger */}
                {task.notes ? (
                  <button
                    onClick={() => toggleNotes(task.id, isNotesOpen)}
                    className="flex items-center gap-1 font-bold text-gold-deep hover:underline cursor-pointer"
                  >
                    <MessageSquare className="w-3 h-3" />
                    <span>Notes</span>
                  </button>
                ) : (
                  canFill && (
                    <button
                      onClick={() => toggleNotes(task.id, isNotesOpen)}
                      className="flex items-center gap-1 font-bold text-ink-faint hover:text-gold-deep hover:underline cursor-pointer"
                    >
                      <MessageSquare className="w-3 h-3" />
                      <span>+ Log Note</span>
                    </button>
                  )
                )}
              </div>

              {/* Notes Panel */}
              {isNotesOpen && (
                <div className="mt-2.5 pt-2 border-t border-line/70 animate-fade-in">
                  {!canFill ? (
                    <div className="p-3 rounded-xl bg-sunken border border-line text-xs text-ink tactile-1">
                      <p className="font-bold text-[10px] text-ink-faint uppercase tracking-wider mb-1">Mashgiach Field Note</p>
                      <p className="whitespace-pre-wrap">{task.notes || 'No notes logged.'}</p>
                    </div>
                  ) : (
                    <textarea
                      rows={2}
                      value={currentNote}
                      onChange={(e) => setNotesState((prev) => ({ ...prev, [task.id]: e.target.value }))}
                      onBlur={() => {
                        if (currentNote !== task.notes) {
                          onUpdateNotes(task.id, currentNote, notesBaseline[task.id]);
                        }
                      }}
                      placeholder="Log details, seal serial numbers, or supplier lot numbers..."
                      className="w-full text-xs p-3 rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition"
                    />
                  )}
                </div>
              )}
            </div>
          </motion.div>
          </React.Fragment>
        );
      })}
        </div>
      ))}
    </div>
  );
};
