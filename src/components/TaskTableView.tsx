import React, { useState } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Clock, 
  User, 
  Users, 
  Check, 
  X, 
  MessageSquare, 
  MoreVertical, 
  Edit3, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  CalendarDays,
  ShieldCheck
} from 'lucide-react';
import { Task, TaskStatus, User as UserType } from '../types';
import { formatTimeAgo, formatExactTime, formatTaskSchedule } from '../lib/utils';
import { canUserFillTasks, canUserAssignTasks } from '../lib/permissions';

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
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-12 text-center border border-stone-200 dark:border-stone-800 shadow-2xs">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 text-amber-600 flex items-center justify-center mx-auto mb-3">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-stone-900 dark:text-white">No tasks match your filter</h3>
        <p className="text-xs text-stone-500 dark:text-stone-400 mt-1 mb-4">Try clearing search filters or add a new assignment.</p>
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
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/90 dark:border-stone-800 shadow-2xs overflow-hidden transition-colors">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-stone-50/90 dark:bg-slate-800/80 border-b border-stone-200/90 dark:border-stone-800 text-[11px] font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              <th className="py-3.5 px-4 w-[28%] min-w-[240px]">Task & Directive</th>
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
          <tbody className="divide-y divide-stone-100 dark:divide-slate-800/80 text-xs text-stone-700 dark:text-stone-300">
            {tasks.map((task) => {
              const isExpanded = expandedDescriptions[task.id];
              const noteValue = editingNotes[task.id] !== undefined ? editingNotes[task.id] : task.notes;
              const isSaved = saveIndicator[task.id];
              const canFill = canUserFillTasks(currentUser);
              const canAssign = canUserAssignTasks(currentUser);

              return (
                <tr 
                  key={task.id}
                  className={`transition-colors group hover:bg-stone-50/80 dark:hover:bg-slate-800/40 ${
                    task.isCompleted ? 'bg-emerald-50/20 dark:bg-emerald-950/10' : ''
                  }`}
                >
                  {/* Task Title & Expandable Instruction */}
                  <td className="py-3.5 px-4 align-top">
                    <div className="space-y-1">
                      <div className="flex items-start gap-2">
                        {task.priority === 'high' && (
                          <span className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-200 dark:border-rose-900/60">
                            High
                          </span>
                        )}
                        <span className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-stone-100 dark:bg-slate-800 text-stone-600 dark:text-stone-400 border border-stone-200/60 dark:border-stone-700/50">
                          {task.category}
                        </span>
                        <div className="font-bold text-stone-900 dark:text-white leading-snug">
                          {task.title}
                        </div>
                      </div>

                      {task.description && (
                        <div className="mt-1">
                          {isExpanded ? (
                            <div className="text-xs text-stone-700 dark:text-stone-300 bg-stone-50 dark:bg-slate-800/60 p-2.5 rounded-xl border border-stone-200/80 dark:border-stone-700 mt-1 shadow-2xs">
                              <p className="whitespace-pre-line leading-relaxed">{task.description}</p>
                              <button
                                onClick={() => toggleExpand(task.id)}
                                className="mt-1.5 text-[10px] font-bold text-amber-700 dark:text-amber-400 hover:underline flex items-center gap-0.5 cursor-pointer"
                              >
                                <ChevronDown className="w-3 h-3" /> Hide instructions
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => toggleExpand(task.id)}
                              className="text-[11px] text-stone-500 dark:text-stone-400 hover:text-amber-700 dark:hover:text-amber-400 flex items-center gap-1 font-semibold transition cursor-pointer"
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
                      <div className="inline-flex items-center gap-1 font-bold text-stone-800 dark:text-stone-200">
                        <Clock className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                        <span>{task.targetTime || 'End of Shift'}</span>
                      </div>
                      <div className="text-[11px] text-stone-500 dark:text-stone-400 flex items-center gap-1 font-medium">
                        {task.scheduleType === 'specific_dates' && (
                          <CalendarDays className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        <span>{formatTaskSchedule(task)}</span>
                      </div>
                    </div>
                  </td>

                  {/* Assigned To with Avatar Monogram */}
                  <td className="py-3.5 px-3 align-top">
                    {task.assignedTo.includes('all') ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-stone-100 dark:bg-slate-800 text-stone-700 dark:text-stone-300 border border-stone-200/60 dark:border-stone-700/50">
                        <Users className="w-3.5 h-3.5 text-stone-500" />
                        <span>Team Roster</span>
                      </span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {task.assignedTo.map((email) => (
                          <span
                            key={email}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border border-amber-200/60 dark:border-amber-800/50 truncate max-w-[140px]"
                            title={email}
                          >
                            <span className="w-4 h-4 rounded-full bg-amber-600 text-white flex items-center justify-center text-[8px] font-black shrink-0">
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
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 font-bold text-xs shadow-2xs">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <span className="capitalize">{task.currentStatus || 'Verified'}</span>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800/80 text-amber-900 dark:text-amber-300 font-bold text-xs">
                            <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                            <span>Pending</span>
                          </div>
                        )}
                        <div className="text-[10px] text-stone-500 dark:text-stone-400 font-medium">
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
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                              task.isCompleted ? 'bg-emerald-600' : 'bg-stone-200 dark:bg-slate-700'
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
                          <div className="inline-flex rounded-xl p-0.5 bg-stone-100 dark:bg-slate-800 border border-stone-200 dark:border-stone-700">
                            <button
                              id={`task-yes-${task.id}`}
                              onClick={() => {
                                if (task.currentStatus === 'yes' && task.isCompleted) {
                                  onUpdateStatus(task.id, 'pending', false);
                                } else {
                                  onUpdateStatus(task.id, 'yes', true);
                                }
                              }}
                              className={`px-3 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
                                task.currentStatus === 'yes'
                                  ? 'bg-emerald-600 text-white shadow-2xs'
                                  : 'text-stone-600 dark:text-stone-400 hover:text-emerald-700'
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
                              className={`px-3 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
                                task.currentStatus === 'no'
                                  ? 'bg-rose-600 text-white shadow-2xs'
                                  : 'text-stone-600 dark:text-stone-400 hover:text-rose-700'
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
                            className={`text-xs font-bold px-2.5 py-1 rounded-xl border focus:outline-none transition cursor-pointer ${
                              task.isCompleted
                                ? 'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
                                : task.currentStatus?.toLowerCase().includes('progress')
                                ? 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                                : task.currentStatus?.toLowerCase().includes('block') || task.currentStatus?.toLowerCase().includes('fail')
                                ? 'bg-rose-50 text-rose-900 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800'
                                : 'bg-stone-50 text-stone-700 border-stone-300 dark:bg-slate-800 dark:text-stone-300 dark:border-stone-700'
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
                            className={`w-5 h-5 rounded-md flex items-center justify-center border transition cursor-pointer ${
                              task.isCompleted
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'bg-white dark:bg-slate-800 border-stone-300 dark:border-slate-600 hover:border-amber-500'
                            }`}
                            title={task.isCompleted ? 'Click to cancel verification' : 'Sign and mark as complete'}
                          >
                            {task.isCompleted && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                          </button>
                        )}

                        <div className="text-[10px] font-bold text-stone-500 dark:text-stone-400">
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
                          <div className="w-5 h-5 rounded-full bg-emerald-600 text-white text-[9px] font-black flex items-center justify-center shrink-0 shadow-2xs">
                            {getInitials(task.updatedByName || task.updatedByEmail || 'MK')}
                          </div>
                          <span className="font-bold text-stone-900 dark:text-white truncate max-w-[110px]" title={task.updatedByName || task.updatedByEmail || ''}>
                            {task.updatedByName || task.updatedByEmail?.split('@')[0]}
                          </span>
                        </div>
                        <div className="text-[10px] text-stone-500 dark:text-stone-400 pl-6 font-medium" title={formatExactTime(task.updatedAt)}>
                          {formatTimeAgo(task.updatedAt)}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        <span className="text-amber-700 dark:text-amber-400 font-bold text-[11px] flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Incomplete
                        </span>
                        <span className="text-stone-400 dark:text-stone-500 text-[10px] block font-medium">
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
                          <div className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800/80 border border-stone-200 dark:border-stone-700 text-xs text-stone-800 dark:text-stone-200 whitespace-pre-wrap max-h-24 overflow-y-auto shadow-2xs">
                            {task.notes}
                          </div>
                        ) : (
                          <span className="text-stone-400 dark:text-stone-500 italic text-xs">
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
                          className="w-full text-xs p-2 rounded-xl bg-stone-50 dark:bg-slate-800 border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-white placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition resize-none shadow-2xs"
                        />
                        {isSaved && (
                          <span className="absolute right-2 bottom-2 text-[9px] font-bold text-emerald-600 bg-white dark:bg-slate-900 px-1 rounded shadow-2xs">
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
                          className="p-1.5 rounded-lg text-stone-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-stone-100 dark:hover:bg-slate-800 transition cursor-pointer"
                          title="Edit Task Definition"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteTask(task.id)}
                          className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
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
