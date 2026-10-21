import { User, UserRole } from '../types';

/**
 * Returns human-readable label for a role.
 * Worker is mapped to Mashgiach.
 */
export function getRoleLabel(role: UserRole | string): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'coordinator':
      return 'Coordinator';
    case 'mashgiach':
    case 'worker':
      return 'Mashgiach';
    case 'owner':
      return 'Venue Owner';
    default:
      return role;
  }
}

/**
 * Checks if a user has permission to fill, check off, or write notes on tasks.
 *
 * Rules:
 * - Admin: always true
 * - Coordinator: true by default (or can be configured)
 * - Mashgiach / Worker: true by default, but admin can toggle permissions.canFillTasks
 * - Owner: false by default, but admin can grant permissions.canFillTasks
 */
export function canUserFillTasks(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'coordinator') {
    return user.permissions?.canFillTasks !== false;
  }
  if (user.role === 'mashgiach' || user.role === 'worker') {
    // Mashgiach default is true unless admin explicitly disabled it
    return user.permissions?.canFillTasks !== false;
  }
  if (user.role === 'owner') {
    // Owner default is false unless admin explicitly granted it
    return user.permissions?.canFillTasks === true;
  }
  return false;
}

/**
 * Checks if a user has permission to assign / create new tasks or edit task definitions.
 *
 * Rules:
 * - Admin: always true
 * - Coordinator: true by default (can add & assign tasks)
 * - Mashgiach / Worker: false by default, unless admin grants permissions.canAssignTasks
 * - Owner: false by default, unless admin grants permissions.canAssignTasks
 */
export function canUserAssignTasks(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'coordinator') {
    // Coordinator can assign tasks by default unless explicitly turned off
    return user.permissions?.canAssignTasks !== false;
  }
  if (user.role === 'mashgiach' || user.role === 'worker') {
    // Mashgiach can assign tasks if admin granted it
    return user.permissions?.canAssignTasks === true;
  }
  if (user.role === 'owner') {
    // Owner can assign tasks if admin granted it
    return user.permissions?.canAssignTasks === true;
  }
  return false;
}

/**
 * Whether a user may see a task. Private tasks are visible only to their
 * assignees plus admins and coordinators.
 */
// Server-side mirror: canSeeTaskServer (server.ts). RULE T: venue first.
export function canSeeTask(
  task: { isPrivate?: boolean; assignedTo?: string[]; venueId?: string },
  user: User | null | undefined
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const myVenueIds = (user as User & { myVenueIds?: string[] }).myVenueIds;
  if (Array.isArray(myVenueIds) && myVenueIds.length > 0) {
    if (task.venueId === undefined || !myVenueIds.includes(task.venueId)) return false;
  } else if ((user as any).venueId !== undefined && task.venueId !== undefined &&
      (user as any).venueId !== task.venueId) return false;
  if (!task.isPrivate) return true;
  if (user.role === 'coordinator') return true;
  const email = user.email.toLowerCase();
  return (task.assignedTo || []).some((a) => a.toLowerCase() === email);
}

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, { canFillTasks: boolean; canAssignTasks: boolean }> = {
  admin: { canFillTasks: true, canAssignTasks: true },
  coordinator: { canFillTasks: true, canAssignTasks: true },
  mashgiach: { canFillTasks: true, canAssignTasks: false },
  worker: { canFillTasks: true, canAssignTasks: false },
  owner: { canFillTasks: false, canAssignTasks: false },
};
