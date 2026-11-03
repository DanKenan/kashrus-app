import { taskAssigneesOn, type TaskPeople } from './taskAssignees';
import type { Task, User } from '../types';

/**
 * Does this task count as the viewer's own ("Mine" tab, "Assigned to Me" counts)?
 * A task naming the viewer always does. An "All" task belongs to the venue's own
 * team, and the agency admin oversees every venue without being on each venue's
 * team, so for an admin "All" does not count (Don, Oct 27). Only "mine" changes:
 * the admin still sees and controls every task in the venue's list.
 */
export function isMyTask(
  task: TaskPeople,
  user: Pick<User, 'email' | 'role'> | null | undefined,
  occurrenceDay?: string
): boolean {
  // TODAYSORT: emails compare case-insensitively, as on the server (canSeeTaskServer).
  // (Older rows may hold one email as a plain string.)
  const raw: unknown = occurrenceDay ? taskAssigneesOn(task, occurrenceDay) : task.assignedTo;
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((a): a is string => typeof a === 'string');
  const me = (user?.email || '').trim().toLowerCase();
  if (me && list.some((a) => a.trim().toLowerCase() === me)) return true;
  return list.some((a) => a.trim().toLowerCase() === 'all') && user?.role !== 'admin';
}
