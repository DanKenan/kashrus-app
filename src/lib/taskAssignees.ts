/** Task-owned people: assignmentMode=task, or either day field present.
 * Unmarked shift tasks retain the legacy shift roster rule.
 * occurrenceDay is always the venue date of the occurrence START (Night included).
 */
export interface TaskPeople {
  assignedTo?: unknown;
  assignmentMode?: 'task';
  dayAssignees?: Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', string[]>>;
  assigneeSwaps?: { date: string; assignedTo: string[] }[];
}
export function taskOwnsPeople(task: TaskPeople): boolean {
  return task.assignmentMode === 'task' || task.dayAssignees !== undefined || task.assigneeSwaps !== undefined;
}
export function assigneeEmails(raw: unknown): string[] {
  return [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .filter((a): a is string => typeof a === 'string').map((a) => a.trim().toLowerCase()).filter(Boolean))];
}
export function taskAssigneesOn(task: TaskPeople, occurrenceDay: string): string[] {
  const swap = task.assigneeSwaps?.find((s) => s.date === occurrenceDay);
  const weekday = String(new Date(`${occurrenceDay}T12:00:00Z`).getUTCDay()) as keyof NonNullable<TaskPeople['dayAssignees']>;
  return assigneeEmails(swap?.assignedTo ?? task.dayAssignees?.[weekday] ?? task.assignedTo);
}
/** Visibility includes all recurring people and upcoming one-time replacements. */
export function taskPotentialAssignees(task: TaskPeople, today: string): string[] {
  return [...new Set([...assigneeEmails(task.assignedTo), ...Object.values(task.dayAssignees || {}).flatMap(assigneeEmails),
    ...(task.assigneeSwaps || []).filter((s) => s.date >= today).flatMap((s) => assigneeEmails(s.assignedTo))])];
}
