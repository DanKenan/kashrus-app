import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Users,
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
} from 'lucide-react';
import { Task, TaskStatus, User as UserType } from '../types';
import { formatTimeAgo, formatExactTime, formatTaskSchedule } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';
import { categoryVars, isDirectlyAssigned } from '../lib/categoryStyle';

interface TaskTableViewProps {
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

export const TaskTableView: React.FC<TaskTableViewProps> = ({
  tasks,
  currentUser,
  onUpdateStatus,
  onUpdateNotes,
  onEditTask,
  onDeleteTask,
  onOpenTaskModal,
}) => {
  const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
  const [editingNotes, setEditingNotes] = useState<Record<string, string>>({});
  const [saveIndicator, setSaveIndicator] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedDescriptions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleNoteChange = (taskId: string, value: string) => {
    setEditingNotes((prev) => ({ ...prev, [taskId]: value }));
  };

  const handleNoteBlur = (taskId: string, currentTaskNotes: string) => {
    const val = editingNotes[taskId];
    if (val !== undefined && val !== currentTaskNotes) {
      onUpdateNotes(taskId, val);
      setSaveIndicator((prev) => ({ ...prev, [taskId]: true }));
      setTimeout(() => {
        setSaveIndicator((prev) => ({ ...prev, [taskId]: false }));
      }, 1500);
    }
  };

  if (tasks.length === 0) {
    return (
      <div className="bg-surface rounded-3xl p-12 text-center border border-line tactile-1 animate-fade-in">
        <div className="w-12 h-12 rounded-2xl bg-gold-wash border border-gold/30 text-gold-deep flex items-center justify-center mx-auto mb-3">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-ink">No tasks match your filter</h3>
        <p className="text-xs text-ink-soft mt-1 mb-4">Try clearing search filters or add a new assignment.</p>
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
    <div className="bg-surface rounded-3xl border border-line tactile-2 overflow-hidden transition-colors animate-fade-in">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-sunken/80 border-b border-line text-[11px] font-bold uppercase tracking-wider text-ink-faint">
              <th className="py-3.5 pl-6 pr-4 w-[28%] min-w-[240px]">Task & Directive</th>
              <th className="py-3.5 px-3 w-[15%] min-w-[130px]">Schedule & Target</th>
              <th className="py-3.5 px-3 w-[14%] min-w-[130px]">Assigned Mashgiach</th>
              <th className="py-3.5 px-4 w-[16%] min-w-[150px]">Verification Status</th>
              <th className="py-3.5 px-3 w-[14%] min-w-[140px]">Signed By</th>
              <th className="py-3.5 px-4 w-[13%] min-w-[160px]">Field Notes</th>
              {canUserAssignTasks(currentUser) && (
                <th className="py-3.5 px-3 w-[4%] text-right pr-4">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60 text-xs text-ink-soft">
            {tasks.map((task) => {
              const isExpanded = expandedDescriptions[task.id];
              const noteValue = editingNotes[task.id] !== undefined ? editingNotes[task.id] : task.notes;
              const isSaved = saveIndicator[task.id];
              const canFill = canUserFillTasks(currentUser);
              const canAssign = canUserAssignTasks(currentUser);
              const mine = isDirectlyAssigned(task, currentUser);

              return (
                <tr
                  key={task.id}
                  style={categoryVars(task.category)}
                  className={`transition-colors group hover:bg-sunken/50 ${
                    mine ? 'bg-gold-wash/50 hover:bg-gold-wash/70' : task.isCompleted ? 'bg-emerald-50/30 dark:bg-emerald-950/10' : ''
                  }`}
                >
                  {/* Task Title & Expandable Instruction */}
                  <td className="relative py-3.5 pl-6 pr-4 align-top">
                    <span className="cat-spine absolute left-0 top-2 bottom-2 w-[4px] rounded-full" aria-hidden />
                    <div className="space-y-1">
                      <div className="flex items-start gap-2">
                        {task.priority === 'high' && (
                          <span className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60">
                            High
                          </span>
                        )}
                        <span className="cat-chip shrink-0 mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border">
                          <span className="cat-dot w-1.5 h-1.5 rounded-full" />
                          {task.category}
                        </span>
                        {mine && (
                          <span className="shrink-0 mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-gold-wash text-gold-ink border border-gold/40">
                            <Star className="w-2 h-2 fill-current" />
                            You
                          </span>
                        )}
                        <div className="font-bold text-ink leading-snug">
                          {task.title}
                        </div>
                      </div>

                      {task.description && (
                        <div className="mt-1">
                          {isExpanded ? (
                            <div className="text-xs text-ink-soft bg-sunken p-2.5 rounded-xl border border-line mt-1 tactile-1">
                              <p className="whitespace-pre-line leading-relaxed">{task.description}</p>
                              <button
                                onClick={() => toggleExpand(task.id)}
                                className="mt-1.5 text-[10px] font-bold text-gold-deep hover:underline flex items-center gap-0.5 cursor-pointer"
                              >
                                <ChevronDown className="w-3 h-3" /> Hide instructions
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => toggleExpand(task.id)}
                              className="text-[11px] text-ink-faint hover:text-gold-deep flex items-center gap-1 font-semibold transition cursor-pointer"
                            >
                              <ChevronRight className="w-3 h-3" /> View instructions
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Schedule & Target Time */}
                  <td className="py-3.5 px-3 align-top">
                    <div className="space-y-1">
                      <div className="tnum inline-flex items-center gap-1 font-bold text-ink">
                        <Clock className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        <span>{task.targetTime || 'End of Shift'}</span>
                      </div>
                      <div className="text-[11px] text-ink-faint flex items-center gap-1 font-medium">
                        {task.scheduleType === 'specific_dates' && (
                          <CalendarDays className="w-3 h-3 text-gold-deep shrink-0" />
                        )}
                        <span>{formatTaskSchedule(task)}</span>
                      </div>
                    </div>
                  </td>

                  {/* Assigned To with Avatar Monogram */}
                  <td className="py-3.5 px-3 align-top">
                    {mine ? (
                      <span
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gold-wash text-gold-ink border border-gold/40 tactile-1"
                        title={task.assignedTo.join(', ')}
                      >
                        <span className="w-4 h-4 rounded-full bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center text-[8px] font-black shrink-0">
                          {getInitials(currentUser?.email || 'MK')}
                        </span>
                        <span>You — designated</span>
                      </span>
                    ) : task.assignedTo.includes('all') ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-sunken text-ink-soft border border-line">
                        <Users className="w-3.5 h-3.5 text-ink-faint" />
                        <span>Team Roster</span>
                      </span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {task.assignedTo.map((email) => (
                          <span
                            key={email}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-bold bg-sunken text-ink-soft border border-line truncate max-w-[140px]"
                            title={email}
                          >
                            <span className="w-4 h-4 rounded-full bg-ink-faint text-paper flex items-center justify-center text-[8px] font-black shrink-0">
                              {getInitials(email)}
                            </span>
                            <span className="truncate">{email.split('@')[0]}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* Flexible Completion Input Column */}
                  <td className="py-3.5 px-4 align-top">
                    {!canFill ? (
                      <div className="space-y-1">
                        {task.isCompleted ? (
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 font-bold text-xs tactile-1">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <span className="capitalize">{task.currentStatus || 'Verified'}</span>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gold-wash border border-gold/40 text-gold-ink font-bold text-xs">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>Pending</span>
                          </div>
                        )}
                        <div className="text-[10px] text-ink-faint font-medium">
                          {task.isCompleted ? '✓ Verified on-site' : '⚠ Awaiting signature'}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {/* 1. Toggle Switch */}
                        {task.inputType === 'toggle' && (
                          <button
                            id={`task-toggle-${task.id}`}
                            onClick={() => onUpdateStatus(task.id, task.isCompleted ? 'pending' : 'completed', !task.isCompleted)}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none tactile-1 ${
                              task.isCompleted ? 'bg-emerald-600' : 'bg-sunken border-line'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                task.isCompleted ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        )}

                        {/* 2. Yes / No Buttons */}
                        {task.inputType === 'yes_no' && (
                          <div className="inline-flex rounded-xl p-0.5 bg-sunken border border-line">
                            <button
                              id={`task-yes-${task.id}`}
                              onClick={() => {
                                if (task.currentStatus === 'yes' && task.isCompleted) {
                                  onUpdateStatus(task.id, 'pending', false);
                                } else {
                                  onUpdateStatus(task.id, 'yes', true);
                                }
                              }}
                              className={`pressable px-3 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
                                task.currentStatus === 'yes'
                                  ? 'bg-emerald-600 text-white tactile-1'
                                  : 'text-ink-soft hover:text-emerald-700 dark:hover:text-emerald-400'
                              }`}
                              title={task.currentStatus === 'yes' ? 'Click to cancel verification' : 'Mark as Yes (Verified)'}
                            >
                              Yes
                            </button>
                            <button
                              id={`task-no-${task.id}`}
                              onClick={() => {
                                if (task.currentStatus === 'no') {
                                  onUpdateStatus(task.id, 'pending', false);
                                } else {
                                  onUpdateStatus(task.id, 'no', false);
                                }
                              }}
                              className={`pressable px-3 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
                                task.currentStatus === 'no'
                                  ? 'bg-rose-600 text-white tactile-1'
                                  : 'text-ink-soft hover:text-rose-700 dark:hover:text-rose-400'
                              }`}
                              title={task.currentStatus === 'no' ? 'Click to cancel choice' : 'Mark as No (Pending)'}
                            >
                              No
                            </button>
                          </div>
                        )}

                        {/* 3. Status Select Dropdown */}
                        {task.inputType === 'status_select' && (
                          <select
                            id={`task-select-${task.id}`}
                            value={task.currentStatus}
                            onChange={(e) => {
                              const newStatus = e.target.value;
                              const isDone = task.completedStatusValues && task.completedStatusValues.length > 0
                                ? task.completedStatusValues.includes(newStatus)
                                : ['completed', 'done', 'passed', 'approved', 'yes'].includes(newStatus.toLowerCase());
                              onUpdateStatus(task.id, newStatus, isDone);
                            }}
                            className={`text-xs font-bold px-2.5 py-1 rounded-xl border focus:outline-none transition cursor-pointer bg-surface tactile-1 ${
                              task.isCompleted
                                ? 'text-emerald-900 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800'
                                : task.currentStatus?.toLowerCase().includes('progress')
                                ? 'text-gold-ink border-gold/50'
                                : task.currentStatus?.toLowerCase().includes('block') || task.currentStatus?.toLowerCase().includes('fail')
                                ? 'text-rose-900 border-rose-300 dark:text-rose-300 dark:border-rose-800'
                                : 'text-ink-soft border-line'
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
                        )}

                        {/* 4. Checkbox */}
                        {task.inputType === 'checkbox' && (
                          <button
                            id={`task-check-${task.id}`}
                            onClick={() => onUpdateStatus(task.id, task.isCompleted ? 'pending' : 'completed', !task.isCompleted)}
                            className={`pressable w-5 h-5 rounded-md flex items-center justify-center border transition cursor-pointer ${
                              task.isCompleted
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'bg-surface border-line-strong hover:border-gold'
                            }`}
                            title={task.isCompleted ? 'Click to cancel verification' : 'Sign and mark as complete'}
                          >
                            {task.isCompleted && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                          </button>
                        )}

                        <div className="text-[10px] font-bold text-ink-faint">
                          {task.isCompleted ? (
                            <span className="text-emerald-700 dark:text-emerald-400 font-bold flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Signed
                            </span>
                          ) : (
                            <span>Pending inspection</span>
                          )}
                        </div>
                      </div>
                    )}
                  </td>

                  {/* Automated "Signed By" Attribution Column */}
                  <td className="py-3.5 px-3 align-top">
                    {task.isCompleted && (task.updatedByName || task.updatedByEmail) ? (
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-emerald-600 text-white text-[9px] font-black flex items-center justify-center shrink-0 tactile-1">
                            {getInitials(task.updatedByName || task.updatedByEmail || 'MK')}
                          </div>
                          <span className="font-bold text-ink truncate max-w-[110px]" title={task.updatedByName || task.updatedByEmail || ''}>
                            {task.updatedByName || task.updatedByEmail?.split('@')[0]}
                          </span>
                        </div>
                        <div className="text-[10px] text-ink-faint pl-6 font-medium" title={formatExactTime(task.updatedAt)}>
                          {formatTimeAgo(task.updatedAt)}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        <span className="text-gold-deep font-bold text-[11px] flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Incomplete
                        </span>
                        <span className="text-ink-faint text-[10px] block font-medium">
                          Awaiting signature
                        </span>
                      </div>
                    )}
                  </td>

                  {/* Inline Multi-Line Notes Column */}
                  <td className="py-3.5 px-4 align-top">
                    {!canFill ? (
                      <div>
                        {task.notes ? (
                          <div className="p-2.5 rounded-xl bg-sunken border border-line text-xs text-ink whitespace-pre-wrap max-h-24 overflow-y-auto tactile-1">
                            {task.notes}
                          </div>
                        ) : (
                          <span className="text-ink-faint italic text-xs">
                            No notes logged
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="relative">
                        <textarea
                          rows={2}
                          value={noteValue || ''}
                          onChange={(e) => handleNoteChange(task.id, e.target.value)}
                          onBlur={() => handleNoteBlur(task.id, task.notes || '')}
                          placeholder="Log notes or seal IDs..."
                          className="w-full text-xs p-2 rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition resize-none tactile-1"
                        />
                        {isSaved && (
                          <span className="absolute right-2 bottom-2 text-[9px] font-bold text-emerald-600 bg-surface px-1 rounded tactile-1">
                            Saved
                          </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Actions (Admin / Coordinator / Assign Permission) */}
                  {canAssign && (
                    <td className="py-3.5 px-3 align-top text-right pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onEditTask(task)}
                          className="pressable p-1.5 rounded-lg text-ink-faint hover:text-gold-deep hover:bg-sunken transition cursor-pointer"
                          title="Edit Task Definition"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteTask(task.id)}
                          className="pressable p-1.5 rounded-lg text-ink-faint hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                          title="Delete Task"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
