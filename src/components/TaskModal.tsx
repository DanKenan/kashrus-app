import React, { useState, useEffect, useRef } from 'react';
import { X, Clock, Calendar, CheckSquare, Users, Plus, Trash2, CalendarDays, CheckCircle2, ListFilter } from 'lucide-react';
import { Task, TaskInputType } from '../types';
import { DAYS_MAP } from '../lib/utils';
import { MonthlyCalendarPicker } from './MonthlyCalendarPicker';

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (taskData: Partial<Task>) => void;
  taskToEdit?: Task | null;
  knownWorkers: Array<{ email: string; name: string }>;
}

const CATEGORY_SUGGESTIONS = [
  'Logistics',
  'Food Safety',
  'Sanitation',
  'Inventory',
  'Operations',
  'Security',
  'Maintenance',
  'Customer Service',
];

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
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Logistics');
  const [inputType, setInputType] = useState<TaskInputType>('yes_no');
  const [targetTime, setTargetTime] = useState('09:00 AM');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [assignType, setAssignType] = useState<'all' | 'specific'>('all');
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [customWorkerEmail, setCustomWorkerEmail] = useState('');

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

  useEffect(() => {
    submitGuard.current = false;
    const todayStr = new Date().toISOString().split('T')[0];

    if (taskToEdit) {
      setTitle(taskToEdit.title);
      setDescription(taskToEdit.description || '');
      setCategory(taskToEdit.category || 'General');
      setInputType(taskToEdit.inputType || 'yes_no');
      setTargetTime(taskToEdit.targetTime || '09:00 AM');
      setPriority(taskToEdit.priority || 'medium');
      if (taskToEdit.assignedTo.includes('all')) {
        setAssignType('all');
        setSelectedWorkers([]);
      } else {
        setAssignType('specific');
        setSelectedWorkers(taskToEdit.assignedTo);
      }

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
      setTitle('');
      setDescription('');
      setCategory('Logistics');
      setInputType('yes_no');
      setTargetTime('09:00 AM');
      setPriority('medium');
      setAssignType('all');
      setSelectedWorkers([]);
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

  const handleSubmit = (e: React.FormEvent) => {
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

    onSave({
      ...(taskToEdit ? { id: taskToEdit.id } : {}),
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      inputType,
      customStatusOptions: inputType === 'status_select' ? customStatusOptions : undefined,
      completedStatusValues: inputType === 'status_select' ? completedStatusValues : undefined,
      targetTime: targetTime.trim(),
      priority,
      assignedTo,
      scheduleType,
      daysOfWeek: selectedDays,
      specificDates: scheduleType === 'specific_dates' ? finalDates : undefined,
    });

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-xl shadow-2xl border border-slate-200 dark:border-slate-800 my-8 overflow-hidden transition-colors max-h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              {taskToEdit ? 'Edit Task Assignment' : 'Create New Task Assignment'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Configure fields, completion input options, visibility, and schedule.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body - Scrollable */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
          
          {/* Task Title */}
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Task Title <span className="text-rose-500">*</span>
            </label>
            <input
              id="task-title-input"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Check temperature logs in refrigeration unit"
              className="w-full text-xs sm:text-sm px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>

          {/* Description / Instructions */}
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Instructions / Description
            </label>
            <textarea
              id="task-desc-input"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Step-by-step guidance for mashgichim when completing this daily assignment..."
              className="w-full text-xs px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>

          {/* 2-Column: Category & Input Type */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Category
              </label>
              <input
                id="task-category-input"
                type="text"
                list="category-options"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <datalist id="category-options">
                {CATEGORY_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Completion Input Type
              </label>
              <select
                id="task-input-type-select"
                value={inputType}
                onChange={(e) => setInputType(e.target.value as TaskInputType)}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              >
                <option value="yes_no">Yes / No Button Pair</option>
                <option value="toggle">On / Off Toggle Switch</option>
                <option value="status_select">Status Select (Customizable Values)</option>
                <option value="checkbox">Standard Checkbox</option>
              </select>
            </div>
          </div>

          {/* CUSTOM STATUS VALUES BUILDER (When inputType === 'status_select') */}
          {inputType === 'status_select' && (
            <div className="p-3.5 bg-slate-50 dark:bg-slate-800/70 rounded-2xl border border-indigo-200 dark:border-indigo-900/50 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <ListFilter className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="font-bold text-slate-800 dark:text-white text-xs">
                    Custom Status Values
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Staff choose from these values
                </span>
              </div>

              {/* Preset Quick Select */}
              <div>
                <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
                  Quick Presets:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_STATUS_GROUPS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => applyStatusPreset(preset)}
                      className="px-2 py-0.5 text-[11px] font-medium rounded-lg bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 hover:border-indigo-500 hover:text-indigo-600 transition"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Current Status Options List */}
              <div className="space-y-1.5">
                <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
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
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleOptionCompleted(opt)}
                          className="flex items-center gap-1 hover:opacity-80"
                          title={isCompleted ? 'Marked as completed status (click to toggle)' : 'Not completed (click to mark as completed)'}
                        >
                          <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] ${
                            isCompleted ? 'bg-emerald-600 text-white' : 'border border-slate-400'
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
                          className="p-1 text-slate-400 hover:text-rose-500 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30"
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
                  className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={handleAddStatusOption}
                  className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white transition flex items-center gap-1"
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
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" /> Target Completion Time
              </label>
              <input
                id="task-target-time-input"
                type="text"
                value={targetTime}
                onChange={(e) => setTargetTime(e.target.value)}
                placeholder="e.g. 09:00 AM or End of Shift"
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Priority
              </label>
              <select
                id="task-priority-select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as any)}
                className="w-full text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              >
                <option value="low">Low Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="high">High (Urgent)</option>
              </select>
            </div>
          </div>

          {/* SCHEDULE SECTION: Recurring Days vs One-Time / Monthly Calendar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" /> Schedule Mode
              </label>
            </div>

            {/* Switcher Tabs */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setScheduleType('recurring')}
                className={`py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                  scheduleType === 'recurring'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
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
                    ? 'bg-white dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                <CalendarDays className="w-3.5 h-3.5" />
                <span>One-Time / Calendar Dates</span>
              </button>
            </div>

            {/* Mode 1: Days of Week Recurrence */}
            {scheduleType === 'recurring' && (
              <div className="pt-1">
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
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
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
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
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1">
              <Users className="w-3.5 h-3.5 text-slate-400" /> Assigned Mashgiach / Staff Visibility
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
                <span className="font-medium text-slate-700 dark:text-slate-300">All Mashgichim & Team (Global Task)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="assignType"
                  checked={assignType === 'specific'}
                  onChange={() => setAssignType('specific')}
                  className="text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium text-slate-700 dark:text-slate-300">Specific Mashgiach Only</span>
              </label>
            </div>

            {assignType === 'specific' && (
              <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800 space-y-2">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
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
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
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
                    className="flex-1 px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomWorker}
                    className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-800 dark:text-white"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              id="save-task-submit-btn"
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs"
            >
              {taskToEdit ? 'Save Changes' : 'Create Assignment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
