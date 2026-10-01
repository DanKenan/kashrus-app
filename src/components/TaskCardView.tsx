import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  Clock,
  User,
  Users,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Edit3,
  Trash2,
  CheckCircle2,
  AlertCircle,
  CalendarDays,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { Task, TaskStatus, User as UserType } from '../types';
import { formatTimeAgo, formatTaskSchedule } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';
import { categoryVars, isDirectlyAssigned } from '../lib/categoryStyle';

interface TaskCardViewProps {
  tasks: Task[];
  currentUser: UserType | null;
  onUpdateStatus: (taskId: string, status: TaskStatus, isCompleted: boolean) => void;
  onUpdateNotes: (taskId: string, notes: string) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenTaskModal?: () => void;
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
  tasks,
  currentUser,
  onUpdateStatus,
  onUpdateNotes,
  onEditTask,
  onDeleteTask,
  onOpenTaskModal,
}) => {
  const [expandedDesc, setExpandedDesc] = useState<Record<string, boolean>>({});
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  const [notesState, setNotesState] = useState<Record<string, string>>({});

  if (tasks.length === 0) {
    return (
      <div className="bg-surface rounded-3xl p-10 text-center border border-line tactile-1 animate-fade-in">
        <div className="w-12 h-12 rounded-2xl bg-gold-wash border border-gold/30 text-gold-deep flex items-center justify-center mx-auto mb-3">
          <AlertCircle className="w-6 h-6" />
        </div>
        <p className="text-sm font-bold text-ink">No tasks match your active criteria</p>
        <p className="text-xs text-ink-soft mt-1 mb-4">Try clearing filters or register a new kosher assignment for the team.</p>
        {onOpenTaskModal && (
          <button
            onClick={onOpenTaskModal}
            className="pressable inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 transition cursor-pointer"
          >
            <span className="text-base font-bold leading-none">+</span>
            <span>Create New Assignment</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {tasks.map((task, i) => {
        const isDescOpen = expandedDesc[task.id];
        const isNotesOpen = expandedNotes[task.id];
        const currentNote = notesState[task.id] !== undefined ? notesState[task.id] : task.notes;
        const canFill = canUserFillTasks(currentUser);
        const canAssign = canUserAssignTasks(currentUser);
        const mine = isDirectlyAssigned(task, currentUser);

        return (
          <motion.div
            key={task.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3), ease: [0.22, 1, 0.36, 1] }}
            style={categoryVars(task.category)}
            className={`relative rounded-2xl bg-surface border border-line tactile-2 lift overflow-hidden ${
              task.isCompleted ? 'opacity-[0.92]' : ''
            } ${mine ? 'mine-glow' : ''}`}
          >
            {/* Category spine — every category carries its own color */}
            <div className="cat-spine absolute left-0 top-0 bottom-0 w-[5px]" aria-hidden />

            <div className="p-4 sm:p-5 pl-5 sm:pl-6">
              {/* Top Bar: Category, Assignment, Priority, Target Time, Admin Actions */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {task.priority === 'high' && (
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60">
                      High Priority
                    </span>
                  )}
                  <span className="cat-chip inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold border">
                    <span className="cat-dot w-2 h-2 rounded-full shrink-0" />
                    {task.category}
                  </span>
                  {mine && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-gold-wash text-gold-ink border border-gold/40">
                      <Star className="w-2.5 h-2.5 fill-current" />
                      For you
                    </span>
                  )}
                  <span className="tnum inline-flex items-center gap-1 text-[11px] font-semibold text-ink-faint">
                    <Clock className="w-3 h-3" />
                    {task.targetTime || 'End of Shift'}
                  </span>
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
                <h3 className="text-sm sm:text-base font-bold text-ink leading-snug">
                  {task.title}
                </h3>
                {task.isCompleted && (
                  <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300/80 dark:border-emerald-800">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Verified</span>
                  </span>
                )}
              </div>

              {/* Collapsible Instructions */}
              {task.description && (
                <div className="mt-1">
                  {isDescOpen ? (
                    <div className="text-xs text-ink-soft bg-sunken p-3 rounded-xl mt-1.5 border border-line tactile-1">
                      <p className="whitespace-pre-line leading-relaxed">{task.description}</p>
                      <button
                        onClick={() => setExpandedDesc((prev) => ({ ...prev, [task.id]: false }))}
                        className="mt-2 text-[11px] font-bold text-gold-deep flex items-center gap-1 cursor-pointer hover:underline"
                      >
                        <ChevronUp className="w-3 h-3" /> Hide instructions
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setExpandedDesc((prev) => ({ ...prev, [task.id]: true }))}
                      className="text-[11px] font-semibold text-ink-faint hover:text-gold-deep flex items-center gap-1 mt-0.5 cursor-pointer"
                    >
                      <ChevronDown className="w-3 h-3" /> Inspection Instructions & Halachic Notes
                    </button>
                  )}
                </div>
              )}

              {/* Mashgiach Assignment & Schedule Meta */}
              <div className="flex items-center justify-between text-xs text-ink-soft mt-3 pt-2.5 border-t border-line/70">
                <div className="flex items-center gap-2">
                  {mine ? (
                    <div
                      className="inline-flex items-center gap-1.5 text-[11px] text-gold-ink font-bold bg-gold-wash border border-gold/40 rounded-full pl-1 pr-2.5 py-0.5"
                      title={task.assignedTo.join(', ')}
                    >
                      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center text-[9px] font-black tactile-1">
                        {getInitials(currentUser?.email || 'MK')}
                      </div>
                      <span className="truncate max-w-[180px] sm:max-w-[240px]">
                        You{task.assignedTo.length > 1 ? ` + ${task.assignedTo.length - 1} other${task.assignedTo.length > 2 ? 's' : ''}` : ''} — designated
                      </span>
                    </div>
                  ) : task.assignedTo.includes('all') ? (
                    <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-soft font-bold">
                      <div className="w-5 h-5 rounded-full bg-sunken border border-line text-ink-faint flex items-center justify-center text-[9px] font-black">
                        <Users className="w-3 h-3" />
                      </div>
                      <span>Team Roster (All Mashgichim)</span>
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-soft font-bold">
                      <div className="w-5 h-5 rounded-full bg-sunken border border-line text-ink-soft flex items-center justify-center text-[9px] font-black">
                        {getInitials(task.assignedTo[0] || 'MK')}
                      </div>
                      <span className="truncate max-w-[160px] sm:max-w-[220px]">
                        {task.assignedTo.join(', ')}
                      </span>
                    </div>
                  )}
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
                            ? `Inspected & Signed: ${task.currentStatus ? (task.currentStatus.charAt(0).toUpperCase() + task.currentStatus.slice(1)) : 'Done'}`
                            : 'Pending On-Site Inspection'}
                        </p>
                        <p className="text-[10px] text-ink-faint">
                          {task.isCompleted
                            ? (task.updatedByName || task.updatedByEmail ? `By ${task.updatedByName || task.updatedByEmail}` : 'Verified completed')
                            : `Assigned: ${task.assignedTo.includes('all') ? 'Team (All)' : task.assignedTo.join(', ')}`}
                        </p>
                      </div>
                    </div>
                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg border ${
                      task.isCompleted
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300/80'
                        : 'bg-gold-wash text-gold-ink border-gold/40'
                    }`}>
                      {task.isCompleted ? 'VERIFIED' : 'PENDING'}
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
                          title={task.currentStatus === 'yes' ? 'Click to cancel verification' : 'Mark as Yes (Verified)'}
                        >
                          <Check className="w-4 h-4" /> Yes (Verified)
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
                          title={task.currentStatus === 'no' ? 'Click to cancel choice' : 'Mark as No (Pending)'}
                        >
                          <X className="w-4 h-4" /> No (Pending)
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
                        title={task.isCompleted ? 'Click to cancel verification' : 'Sign and mark as complete'}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{task.isCompleted ? '✓ Signed & Verified (Click to cancel)' : 'Sign & Complete Inspection'}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Attribution & Signature Banner */}
              <div className="flex items-center justify-between mt-2.5 pt-2 text-[11px] text-ink-faint">
                <div>
                  {task.isCompleted && (task.updatedByName || task.updatedByEmail) ? (
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
                    onClick={() => setExpandedNotes((prev) => ({ ...prev, [task.id]: !isNotesOpen }))}
                    className="flex items-center gap-1 font-bold text-gold-deep hover:underline cursor-pointer"
                  >
                    <MessageSquare className="w-3 h-3" />
                    <span>Notes</span>
                  </button>
                ) : (
                  canFill && (
                    <button
                      onClick={() => setExpandedNotes((prev) => ({ ...prev, [task.id]: !isNotesOpen }))}
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
                          onUpdateNotes(task.id, currentNote);
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
        );
      })}
    </div>
  );
};
