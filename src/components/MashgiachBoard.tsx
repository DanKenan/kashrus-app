import React, { useState } from 'react';
import { Check, Clock, List, ListChecks, ToggleRight, CircleHelp, AlertCircle, ChevronDown } from 'lucide-react';
import { TaskCardView, type TaskCardViewProps } from './TaskCardView';
import { mashgiachHeader, mashgiachProgress, mashgiachCheckInCovered, mashgiachCheckInSummary, mashgiachTaskTimeKey } from '../lib/mashgiachBoard';
import { TaskEmptyState } from './TaskEmptyState';
import type { Shift } from '../types';
import { minutesIn, weekdayIn, workDateIn } from '../lib/workday';
import { checkInCoversDue, isTaskOverdue } from '../lib/overdue';
import { shiftLabel, shiftTaskOverdueAt } from '../lib/shifts';
import { formatTaskTimes } from '../lib/utils';

export function MashgiachBoard(props: TaskCardViewProps & { headerShifts?: Shift[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const { tasks, currentUser, timeZone, shiftsById = new Map() } = props;
  const now = new Date();
  const day = workDateIn(timeZone, now), weekday = weekdayIn(timeZone, now), minutes = minutesIn(timeZone, now);
  // Tasks have already been scoped to today by App. Match TaskCardView's overdue rules.
  const overdue = (task: typeof tasks[number]) => {
    const shift = task.shiftId ? shiftsById.get(task.shiftId) : undefined;
    if (shift) return !task.isCompleted && !!timeZone && shiftTaskOverdueAt(shift, day, weekday, minutes, task, timeZone);
    if (timeZone && checkInCoversDue(task, day, minutes, timeZone)) return false;
    return isTaskOverdue(task, timeZone ? minutes : null);
  };
  const taskShift = (task: typeof tasks[number]) => task.shiftId ? shiftsById.get(task.shiftId) : undefined;
  const board = mashgiachProgress(tasks, overdue, (task) => mashgiachCheckInCovered(task, taskShift(task), day, weekday, minutes, timeZone),
    (task) => mashgiachTaskTimeKey(task, taskShift(task), day, weekday, minutes));
  const header = mashgiachHeader(props.headerShifts ?? [...shiftsById.values()], currentUser?.id || '', day, weekday, minutes);
  const card = (task: typeof tasks[number], focused = false) => <TaskCardView {...props} tasks={[task]} sections={undefined} focused={focused} />;
  const time = (task: typeof tasks[number]) => task.shiftId && shiftsById.has(task.shiftId)
    ? shiftLabel(shiftsById.get(task.shiftId)!, weekday, task) : formatTaskTimes(task);
  const icons = { checkbox: Check, check_in: Clock, status_select: List, yes_no: CircleHelp, checklist: ListChecks, toggle: ToggleRight };
  return <div className="mboard space-y-6">
    <section className="mboard-header rounded-xl border border-line p-4 tactile-1" aria-label="Shift progress">
      <h2 className="text-2xl font-semibold">{header.title}</h2>
      {header.hours && <p className="mt-2 text-sm tnum">{header.hours}</p>}
      <div className="mt-4 flex gap-1" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={board.total || 1} aria-valuenow={board.completed} aria-valuetext={`${board.completed} of ${board.total} done`}>
        {tasks.map((_, i) => <span key={i} className={`h-2 min-w-0 flex-1 rounded-full ${i < board.completed ? 'mboard-segment-done' : 'mboard-segment'}`} />)}
      </div>
      <p className="mt-2 text-sm" aria-live="polite">{board.completed} of {board.total} done</p>
    </section>
    {!tasks.length ? (props.hasActiveFilters
      ? <TaskEmptyState hasActiveFilters onClearFilters={props.onClearFilters} canCreate={false} />
      : <p className="text-base text-ink-soft">Nothing for you today</p>) : <>
    {board.next ? <section aria-label="Do this next"><h2 className="mb-2 text-xl font-semibold text-ink">Do this next</h2>{card(board.next, true)}</section>
      : <section className="rounded-xl border border-line bg-ok-bg p-4 text-ok"><Check className="inline w-5 h-5 me-2" />{board.completed === board.total ? 'All done for today' : 'All done for now'}</section>}
    {board.later.length > 0 && <section aria-label="Later in your shift">
      <h2 className="mb-2 text-xl font-semibold text-ink">Later in your shift</h2>
      <div className="space-y-2">{board.later.map((task) => {
        const Icon = icons[task.inputType] || Check;
        return <div key={task.id}><button className="mboard-row pressable" aria-expanded={expanded === task.id} onClick={() => setExpanded(expanded === task.id ? null : task.id)}>
          <Icon className="w-5 h-5 shrink-0 text-ink-soft" /><span className="min-w-0 flex-1 text-start"><span className="line-clamp-2 break-words" dir="auto">{task.title}</span><span className="block break-words text-xs text-ink-soft tnum">{time(task)}{task.inputType === 'check_in' && ` · ${mashgiachCheckInSummary(task, now, timeZone, false, taskShift(task))}`}</span></span>{overdue(task) && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bad-bg px-2 text-xs text-bad"><AlertCircle className="h-4 w-4 shrink-0" />Late</span>}
        </button>{expanded === task.id && card(task)}</div>;
      })}</div>
    </section>}
    <section><button className="mboard-row pressable" aria-expanded={doneOpen} aria-controls="mboard-done" onClick={() => setDoneOpen(!doneOpen)}>Done today · {board.completed}<ChevronDown aria-hidden="true" className={`ms-auto h-5 w-5 shrink-0 ${doneOpen ? 'rotate-180' : ''}`} /></button>
      <div id="mboard-done" hidden={!doneOpen} className="mt-2 space-y-2">{board.done.map((task) => <div key={task.id} className="mboard-row bg-ok-bg text-ok">
        <Check className="w-5 h-5 shrink-0" /><span className="min-w-0 flex-1 truncate" dir="auto">{task.title}</span>
        <span className="shrink-0 text-xs tnum">{task.updatedByName?.trim().split(/\s+/)[0] || task.updatedByEmail}{task.updatedAt && ` · ${new Date(task.updatedAt).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })}`}</span>
      </div>)}</div>
    </section>
    </>}
  </div>;
}
