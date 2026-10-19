/**
 * Null-safe roster display helpers.
 *
 * Roster payloads from the server omit `email` for recipients who cannot assign
 * tasks (privacy: contact emails are only sent to admins, coordinators, and
 * users with the canAssignTasks permission). Every place the client renders a
 * roster entry must tolerate a missing email — these helpers centralize the
 * fallbacks so a trimmed roster can never crash a render.
 */

/** Short display handle: email prefix when available, otherwise the name. */
export function rosterDisplayHandle(u: { email?: string | null; name: string }): string {
  return u.email?.split('@')[0] || u.name;
}

/** Stable React key for a roster entry: email when available, id/name fallback. */
export function rosterKey(u: { email?: string | null; id?: string; name: string }): string {
  return u.email || u.id || u.name;
}

/** Lowercased email for matching, or '' when the roster entry carries no email. */
export function rosterEmailLower(u: { email?: string | null }): string {
  return u.email?.toLowerCase() || '';
}
