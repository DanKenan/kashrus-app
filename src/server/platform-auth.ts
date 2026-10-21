/**
 * 8i — the platform-operator boundary.
 *
 * A handful of routes act on the WHOLE platform rather than one agency
 * (migration copy / status, the consistency check, the media sweeper and its
 * index check, the alert test). An "admin" in this app is an admin of ONE
 * agency, and agency registration is public, so requireAdmin is not enough
 * for them. Until a proper operator workflow exists, exactly ONE pinned
 * account may run them: the home agency's original admin record.
 *
 * isPlatformOperator decides on the CURRENT stored record (never on token
 * claims or a cached identity), and refuses kiosk sessions outright, even
 * when the acting account is the pinned one. Callers re-check immediately
 * before executing a long platform operation, so a role, agency or password
 * change between request start and execution is honoured.
 */

export const PLATFORM_OPERATOR_USER_ID = 'usr_admin';
export const PLATFORM_OPERATOR_AGENCY_ID = 'agency-hkc';
export const PLATFORM_OPERATOR_FORBIDDEN = 'Only the platform operator can perform this action.';

const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

export interface OperatorRecord {
  id?: string;
  agencyId?: string;
  role?: string;
  password?: string;
}

/**
 * @param sessionUserId the verified session's user id
 * @param isKiosk       true for a kiosk (PIN) session
 * @param users         the CURRENT stored user records
 */
export function isPlatformOperator(sessionUserId: string | undefined | null, isKiosk: boolean, users: OperatorRecord[]): boolean {
  if (isKiosk) return false;
  if (sessionUserId !== PLATFORM_OPERATOR_USER_ID) return false;
  const rec = (Array.isArray(users) ? users : []).find((u) => u && u.id === sessionUserId);
  if (!rec) return false;
  if (rec.agencyId !== PLATFORM_OPERATOR_AGENCY_ID) return false;
  if (rec.role !== 'admin') return false;
  if (typeof rec.password !== 'string' || !BCRYPT_HASH.test(rec.password)) return false;
  return true;
}
