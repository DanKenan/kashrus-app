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
    case 'manager':
      return 'Manager';
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
 * - Owner / Manager: false by default, but admin can grant permissions.canFillTasks
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
  if (isVenueOwnerLike(user)) {
    // Owner (and manager, same style) default is false unless admin explicitly granted it
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
 * - Owner / Manager: false by default, unless admin grants permissions.canAssignTasks
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
  if (isVenueOwnerLike(user)) {
    // Owner (and manager) can assign tasks if admin granted it
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
  manager: { canFillTasks: false, canAssignTasks: false },
};

/**
 * Manager role (Don 2026-10-27, "same style as the owner"; server #169): a
 * manager sees and does what an owner sees and does, at their own home venue
 * only. Use this wherever the client asks "is this an owner?".
 */
export function isVenueOwnerLike(user: { role?: string } | null | undefined): boolean {
  return !!user && (user.role === 'owner' || user.role === 'manager');
}

type RoleMember = { id?: string; role?: string; venueId?: string; agencyId?: string; noHomeVenue?: boolean; myVenueIds?: string[] };
const homeOf = (u: RoleMember): string => (typeof u.venueId === 'string' ? u.venueId : '');

/**
 * May this OWNER add team members (a mashgiach or a manager) and open the
 * owner's Team sheet? Only an owner (never a manager, coordinator or anyone
 * else) with a real home venue; an invite is for that venue only. Mirror of
 * the server's staffAddsMember (owner branch); the server decides.
 */
export function ownerMayAddManager(caller: RoleMember | null | undefined): boolean {
  return !!caller && caller.role === 'owner' && !!homeOf(caller) && caller.noHomeVenue !== true;
}

/**
 * The roles an OWNER may switch `target` to (mirror of the server's
 * ownerMayChangeRole, fail closed): only a mashgiach / worker / manager whose
 * home venue is the owner's own home venue, never the owner themselves, never
 * an owner, admin or coordinator, never someone in another agency. A
 * mashgiach (or worker) may become a manager; a manager may become a
 * mashgiach. Anything else: no choice at all.
 */
export function ownerRoleSwitchFor(caller: RoleMember | null | undefined, target: RoleMember | null | undefined): 'manager' | 'mashgiach' | null {
  if (!ownerMayAddManager(caller) || !caller || !target || !target.id || target.id === caller.id) return null;
  if ((target.agencyId || 'agency-hkc') !== (caller.agencyId || 'agency-hkc')) return null;
  if (target.noHomeVenue === true || !homeOf(target) || homeOf(target) !== homeOf(caller)) return null;
  if (target.role === 'mashgiach' || target.role === 'worker') return 'manager';
  if (target.role === 'manager') return 'mashgiach';
  return null;
}

/**
 * Team adds (Don 2026-10-27 11:30 PM: "make the owner and coordinators able to
 * add"): the only roles an owner or a coordinator may add. Never owner,
 * admin, coordinator or worker (server: STAFF_ADD_ROLES).
 */
export const STAFF_ADD_ROLES = ['mashgiach', 'manager'] as const;

/**
 * May this OWNER or COORDINATOR add a team member at `venueId`? Mirror of the
 * server's staffMayAddMemberAt (fail closed): an owner at their own home
 * venue; a coordinator at a venue of their own scope (the server's
 * myVenueIds when it sent them, else their home venue). Admins use the
 * admin form; everyone else: no.
 */
export function staffMayAddMemberAt(caller: RoleMember | null | undefined, venueId: string | null | undefined): boolean {
  if (!caller || typeof venueId !== 'string' || !venueId) return false;
  if (caller.role === 'owner') return ownerMayAddManager(caller) && homeOf(caller) === venueId;
  if (caller.role === 'coordinator') {
    const scope = Array.isArray(caller.myVenueIds)
      ? caller.myVenueIds.filter((x) => typeof x === 'string' && !!x)
      : (homeOf(caller) && caller.noHomeVenue !== true ? [homeOf(caller)] : []);
    return scope.includes(venueId);
  }
  return false;
}
