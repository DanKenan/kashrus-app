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

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, { canFillTasks: boolean; canAssignTasks: boolean }> = {
  admin: { canFillTasks: true, canAssignTasks: true },
  coordinator: { canFillTasks: true, canAssignTasks: true },
  mashgiach: { canFillTasks: true, canAssignTasks: false },
  worker: { canFillTasks: true, canAssignTasks: false },
  owner: { canFillTasks: false, canAssignTasks: false },
};
