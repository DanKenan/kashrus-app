import React, { useState } from 'react';
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
  Award
} from 'lucide-react';
import { Task, TaskStatus, User as UserType } from '../types';
import { formatTimeAgo, formatTaskSchedule } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';

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
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-10 text-center border border-stone-200 dark:border-stone-800 shadow-2xs">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 text-amber-600 flex items-center justify-center mx-auto mb-3">
          <AlertCircle className="w-6 h-6" />
        </div>
        <p className="text-sm font-bold text-stone-900 dark:text-white">No tasks match your active criteria</p>
        <p className="text-xs text-stone-500 dark:text-stone-400 mt-1 mb-4">Try clearing filters or register a new kosher assignment for the team.</p>
        {onOpenTaskModal && (
          <button
            onClick={onOpenTaskModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white shadow-xs transition cursor-pointer"
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
      {tasks.map((task) => {
        const isDescOpen = expandedDesc[task.id];
        const isNotesOpen = expandedNotes[task.id];
        const currentNote = notesState[task.id] !== undefined ? notesState[task.id] : task.notes;
        const canFill = canUserFillTasks(currentUser);
        const canAssign = canUserAssignTasks(currentUser);

        // Determine Status Edge Accent Color
        const statusAccent = task.isCompleted
          ? 'border-l-4 border-l-emerald-600 dark:border-l-emerald-500 bg-gradient-to-r from-emerald-50/20 via-white to-white dark:from-emerald-950/15 dark:via-slate-900 dark:to-slate-900'
          : task.priority === 'high'
          ? 'border-l-4 border-l-rose-500 bg-gradient-to-r from-rose-50/15 via-white to-white dark:from-rose-950/15 dark:via-slate-900 dark:to-slate-900'
          : 'border-l-4 border-l-amber-500 bg-gradient-to-r from-amber-50/15 via-white to-white dark:from-amber-950/15 dark:via-slate-900 dark:to-slate-900';

        return (
          <div
            key={task.id}
            className={`rounded-2xl p-4 sm:p-4.5 border transition-all duration-200 shadow-2xs hover:shadow-md hover:border-amber-300 dark:hover:border-amber-700/60 ${statusAccent} ${
              task.isCompleted
                ? 'border-stone-200/90 dark:border-stone-800'
                : 'border-stone-200/90 dark:border-stone-800'
            }`}
          >
            {/* Top Bar: Category, Priority, Target Time, Admin Actions */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                {task.priority === 'high' && (
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60">
                    High Priority
                  </span>
                )}
                <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-stone-100 dark:bg-slate-800 text-stone-700 dark:text-stone-300 border border-stone-200/60 dark:border-stone-700/50">
                  {task.category}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-stone-500 dark:text-stone-400">
                  <Clock className="w-3 h-3 text-stone-400" />
                  {task.targetTime || 'End of Shift'}
                </span>
              </div>

              {canAssign && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onEditTask(task)}
                    className="p-1.5 text-stone-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-stone-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                    title="Edit task parameters"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteTask(task.id)}
                    className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg transition cursor-pointer"
                    title="Delete task"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Task Title with Verification Seal Badge */}
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm sm:text-base font-bold text-stone-900 dark:text-white leading-snug">
                {task.title}
              </h3>
              {task.isCompleted && (
                <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300/80 dark:border-emerald-800">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Verified</span>
                </span>
              )}
            </div>

            {/* Collapsible Instructions */}
            {task.description && (
              <div className="mt-1">
                {isDescOpen ? (
                  <div className="text-xs text-stone-700 dark:text-stone-300 bg-stone-50/90 dark:bg-slate-800/80 p-3 rounded-xl mt-1.5 border border-stone-200/70 dark:border-stone-700/60 shadow-2xs">
                    <p className="whitespace-pre-line leading-relaxed">{task.description}</p>
                    <button
                      onClick={() => setExpandedDesc((prev) => ({ ...prev, [task.id]: false }))}
                      className="mt-2 text-[11px] font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1 cursor-pointer hover:underline"
                    >
                      <ChevronUp className="w-3 h-3" /> Hide instructions
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setExpandedDesc((prev) => ({ ...prev, [task.id]: true }))}
                    className="text-[11px] font-semibold text-stone-500 hover:text-amber-700 dark:text-stone-400 dark:hover:text-amber-400 flex items-center gap-1 mt-0.5 cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" /> Inspection Instructions & Halachic Notes
                  </button>
                )}
              </div>
            )}

            {/* Human Mashgiach Assignment & Schedule Meta */}
            <div className="flex items-center justify-between text-xs text-stone-500 dark:text-stone-400 mt-3 pt-2.5 border-t border-stone-100 dark:border-stone-800/80">
              <div className="flex items-center gap-2">
                {task.assignedTo.includes('all') ? (
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-stone-700 dark:text-stone-300 font-bold">
                    <div className="w-5 h-5 rounded-full bg-stone-200 dark:bg-slate-700 text-stone-700 dark:text-stone-200 flex items-center justify-center text-[9px] font-black">
                      <Users className="w-3 h-3" />
                    </div>
                    <span>Team Roster (All Mashgichim)</span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-900 dark:text-amber-200 font-bold">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-600 to-amber-700 text-white flex items-center justify-center text-[9px] font-black shadow-2xs">
                      {getInitials(task.assignedTo[0] || 'MK')}
                    </div>
                    <span className="truncate max-w-[160px] sm:max-w-[220px]">
                      {task.assignedTo.join(', ')}
                    </span>
                  </div>
                )}
              </div>

              <span className="text-[11px] flex items-center gap-1 font-medium text-stone-500 dark:text-stone-400">
                {task.scheduleType === 'specific_dates' && (
                  <CalendarDays className="w-3 h-3 text-amber-600 shrink-0" />
                )}
                {formatTaskSchedule(task)}
              </span>
            </div>

            {/* Completion Control Bar or Read-Only Audit Bar */}
            <div className="mt-3 pt-3 border-t border-stone-100 dark:border-stone-800/80">
              {!canFill ? (
                <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800/60 border border-stone-200/80 dark:border-stone-700/60">
                  <div className="flex items-center gap-2.5">
                    {task.isCompleted ? (
                      <div className="w-7 h-7 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-4 h-4" />
                      </div>
                    ) : (
                      <div className="w-7 h-7 rounded-xl bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                    )}
                    <div>
                      <p className={`text-xs font-bold ${
                        task.isCompleted ? 'text-emerald-900 dark:text-emerald-300' : 'text-amber-900 dark:text-amber-300'
                      }`}>
                        {task.isCompleted
                          ? `Inspected & Signed: ${task.currentStatus ? (task.currentStatus.charAt(0).toUpperCase() + task.currentStatus.slice(1)) : 'Done'}`
                          : 'Pending On-Site Inspection'}
                      </p>
                      <p className="text-[10px] text-stone-500 dark:text-stone-400">
                        {task.isCompleted
                          ? (task.updatedByName || task.updatedByEmail ? `By ${task.updatedByName || task.updatedByEmail}` : 'Verified completed')
                          : `Assigned: ${task.assignedTo.includes('all') ? 'Team (All)' : task.assignedTo.join(', ')}`}
                      </p>
                    </div>
                  </div>
                  <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg ${
                    task.isCompleted
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300/80'
                      : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border border-amber-300/80'
                  }`}>
                    {task.isCompleted ? 'VERIFIED' : 'PENDING'}
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  
                  {/* 1. Toggle Switch */}
                  {task.inputType === 'toggle' && (
                    <div className="flex items-center justify-between w-full">
                      <span className="text-xs font-bold text-stone-700 dark:text-stone-300">
                        Inspection Status: {task.isCompleted ? 'Verified Done' : 'Pending'}
                      </span>
                      <button
                        id={`mobile-task-toggle-${task.id}`}
                        onClick={() => onUpdateStatus(task.id, task.isCompleted ? 'pending' : 'completed', !task.isCompleted)}
                        className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          task.isCompleted ? 'bg-emerald-600' : 'bg-stone-300 dark:bg-slate-700'
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
                        className={`min-h-[44px] flex items-center justify-center gap-1.5 py-2 px-4 rounded-xl text-xs font-bold transition active:scale-[0.98] cursor-pointer shadow-2xs ${
                          task.currentStatus === 'yes'
                            ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-xs'
                            : 'bg-stone-100 dark:bg-slate-800 text-stone-700 dark:text-stone-300 hover:bg-emerald-50 hover:text-emerald-800 dark:hover:bg-emerald-950/40 border border-stone-200/80 dark:border-stone-700'
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
                        className={`min-h-[44px] flex items-center justify-center gap-1.5 py-2 px-4 rounded-xl text-xs font-bold transition active:scale-[0.98] cursor-pointer shadow-2xs ${
                          task.currentStatus === 'no'
                            ? 'bg-gradient-to-r from-rose-600 to-rose-700 text-white shadow-xs'
                            : 'bg-stone-100 dark:bg-slate-800 text-stone-700 dark:text-stone-300 hover:bg-rose-50 hover:text-rose-800 dark:hover:bg-rose-950/40 border border-stone-200/80 dark:border-stone-700'
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
                        className={`w-full min-h-[44px] px-3 py-2 text-xs font-bold rounded-xl border transition cursor-pointer ${
                          task.isCompleted
                            ? 'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
                            : 'bg-white dark:bg-slate-800 border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white'
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
                      className={`w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl text-xs font-bold border transition active:scale-[0.98] cursor-pointer shadow-2xs ${
                        task.isCompleted
                          ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 border-emerald-600 text-white'
                          : 'bg-stone-50 dark:bg-slate-800 border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-amber-50/60 dark:hover:bg-amber-950/20'
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
            <div className="flex items-center justify-between mt-2.5 pt-2 text-[11px] text-stone-500 dark:text-stone-400">
              <div>
                {task.isCompleted && (task.updatedByName || task.updatedByEmail) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 inline-block" />
                    <span>
                      Signed by <strong className="text-stone-900 dark:text-stone-100">{task.updatedByName || task.updatedByEmail}</strong> ({formatTimeAgo(task.updatedAt)})
                    </span>
                  </span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-400 font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0 inline-block animate-pulse" />
                    <span>Awaiting on-site verification</span>
                  </span>
                )}
              </div>

              {/* Notes Accordion trigger */}
              {task.notes && (
                <button
                  onClick={() => setExpandedNotes((prev) => ({ ...prev, [task.id]: !isNotesOpen }))}
                  className="flex items-center gap-1 font-bold text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                >
                  <MessageSquare className="w-3 h-3" />
                  <span>Notes ({task.notes ? '1' : '0'})</span>
                </button>
              )}
              {!task.notes && canFill && (
                <button
                  onClick={() => setExpandedNotes((prev) => ({ ...prev, [task.id]: !isNotesOpen }))}
                  className="flex items-center gap-1 font-bold text-stone-500 hover:text-amber-700 dark:text-stone-400 dark:hover:text-amber-400 hover:underline cursor-pointer"
                >
                  <MessageSquare className="w-3 h-3" />
                  <span>+ Log Note</span>
                </button>
              )}
            </div>

            {/* Notes Panel */}
            {isNotesOpen && (
              <div className="mt-2.5 pt-2 border-t border-stone-100 dark:border-stone-800">
                {!canFill ? (
                  <div className="p-3 rounded-xl bg-stone-50 dark:bg-slate-800/80 border border-stone-200/80 dark:border-stone-700 text-xs text-stone-800 dark:text-stone-200 shadow-2xs">
                    <p className="font-bold text-[10px] text-stone-400 uppercase tracking-wider mb-1">Mashgiach Field Note</p>
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
                    className="w-full text-xs p-3 rounded-xl bg-stone-50 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/25 focus:border-amber-500 transition"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

