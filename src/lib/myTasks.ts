import type { Task, User } from '../types';

/**
 * Does this task count as the viewer's own ("Mine" tab, "Assigned to Me" counts)?
 * A task naming the viewer always does. An "All" task belongs to the venue's own
 * team, and the agency admin oversees every venue without being on each venue's
 * team, so for an admin "All" does not count (Don, Oct 27). Only "mine" changes:
 * the admin still sees and controls every task in the venue's list.
 */
export function isMyTask(
  task: Pick<Task, 'assignedTo'>,
  user: Pick<User, 'email' | 'role'> | null | undefined
): boolean {
  if (user && task.assignedTo.includes(user.email)) return true;
  return task.assignedTo.includes('all') && user?.role !== 'admin';
}
