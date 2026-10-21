/**
 * 8h — the admin export, built by explicit projection (never a spread of the
 * monolith) and ALWAYS scoped to the caller's own agency (rule T: Admin =
 * whole OWN agency). There is no cross-agency HTTP export for anyone, Don
 * included: whole-database disaster recovery is the separate Tier-1 backup
 * job (src/server/backup.ts → private bucket; restore-backup.ts), not a
 * normal user session.
 *
 * Ownership is VERIFIED, fail closed: a record is kept only when it carries an
 * explicit agencyId equal to the caller's agency and, if it names a venue,
 * that venue exists and explicitly belongs to the same agency; a record with
 * no agencyId is kept only when its venue explicitly belongs to the agency.
 * No owner, an unknown venue or an agency/venue mismatch → omitted.
 *
 * The file is marked exportScope 'agency', exportAgencyId, restorable: false,
 * and carries NO _v, currentWorkDate or isDemoCleared, so it can never pass
 * for a whole app-state/main backup (BACKUP_RESTORE.md's restore script
 * refuses it).
 *
 * Secret-free, three layers:
 *  1. top-level allowlist: only the collections named in EXPORT_COLLECTIONS
 *     (jwtSecret, vapidKeys, resetPepper, passwordResets(+RateLimits),
 *     pushSubscriptions, kioskPinLockouts, kioskPairings(+Limits) and any
 *     future top-level field are never copied);
 *  2. explicit field projections for the credential-bearing record types
 *     (users, airtableConfigs, kioskDevices);
 *  3. a recursive scrub of EVERY record (nested objects and arrays included)
 *     with the Tier-1 backup's secret-key rule (password, pin, pepper, secret,
 *     token, apiKey, privateKey, reset/pairing/verification codes, … and
 *     their …Hash forms), so a secret-looking field added later cannot
 *     silently enter an export.
 */

export const EXPORT_COLLECTIONS = [
  'agencies', 'venues', 'tasks', 'historyLogs', 'handoffNotes', 'taskTemplates',
  'incidents', 'announcements', 'users', 'events', 'eventTaskTemplates',
  'airtableConfigs', 'approvedIngredients', 'factoryReports', 'kioskDevices',
] as const;

const USER_FIELDS = [
  'id', 'agencyId', 'email', 'name', 'role', 'avatarColor', 'venueId',
  'permissions', 'phoneNumber', 'kioskPinSetAt', 'kioskPinRev', 'createdAt', 'updatedAt',
];

const AIRTABLE_FIELDS = [
  'id', 'agencyId', 'venueId', 'baseId', 'tableName', 'viewName',
  'fieldNameMapping', 'lastSyncedAt', 'autoSyncEnabled', 'createdAt', 'updatedAt',
];

const KIOSK_DEVICE_FIELDS = [
  'id', 'agencyId', 'venueId', 'name', 'createdAt', 'pairedByUserId', 'pairedByName',
  'lastSeenAt', 'lastSeenVersion',
];

const SECRET_WORDS = [
  'password', 'kioskpin', 'pin', 'pairingcode', 'devicesecret', 'jwtsecret', 'vapid', 'vapidkeys',
  'pepper', 'apikey', 'accesstoken', 'refreshtoken', 'privatekey', 'secret', 'token',
  'resetcode', 'verificationcode', 'kioskcode', 'otp', 'credential', 'credentials',
];

/**
 * The Tier-1 backup rule (src/server/backup.ts isSecretKey), extended with
 * reset/pairing/verification/kiosk code, otp and credential words for the export: exact word (ignoring _ and -), a camelCase
 * suffix (userPassword, accessToken, domainVerificationToken), or a …Hash
 * form of a secret word (passwordHash, kioskPinHash, secretHash).
 */
export function isExportSecretKey(key: string): boolean {
  if (typeof key !== 'string' || !key) return false;
  // Boolean presence flags (hasApiKey) carry no secret.
  if (/^has[A-Z]/.test(key)) return false;
  if (/hash$/i.test(key) && key.length > 4) {
    const stem = key.slice(0, -4);
    if (isExportSecretKey(stem) || /(pin|code|secret|password|token|key)$/i.test(stem)) return true;
  }
  const lower = key.toLowerCase();
  const normalized = lower.replace(/[_-]/g, '');
  if (SECRET_WORDS.includes(normalized)) return true;
  for (const word of SECRET_WORDS) {
    if (word.length < 4) continue; // short words ('pin', 'otp') only as exact keys
    if (lower.endsWith(word) && lower.length > word.length) {
      const c = key[key.length - word.length];
      if (c && c === c.toUpperCase() && c !== c.toLowerCase()) return true;
    }
  }
  return false;
}

export function scrubSecrets(value: any, depth = 0): any {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isExportSecretKey(k)) continue;
      out[k] = scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

function pick(src: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (src && src[k] !== undefined) out[k] = src[k];
  return out;
}

function projectRecord(collection: string, rec: any): any {
  if (collection === 'users') return pick(rec, USER_FIELDS);
  if (collection === 'airtableConfigs') {
    return { ...pick(rec, AIRTABLE_FIELDS), hasApiKey: typeof rec?.apiKey === 'string' && rec.apiKey.length > 0 };
  }
  if (collection === 'kioskDevices') return pick(rec, KIOSK_DEVICE_FIELDS);
  return rec;
}

/** Verified ownership of a record by `agencyId` (fail closed). */
export function ownedByAgency(rec: any, agencyId: string, venueAgency: Map<string, string>): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const aid = typeof rec.agencyId === 'string' && rec.agencyId ? rec.agencyId : null;
  const vid = typeof rec.venueId === 'string' && rec.venueId && rec.venueId !== 'all' ? rec.venueId : null;
  if (aid) {
    if (aid !== agencyId) return false;
    if (vid) return venueAgency.get(vid) === agencyId; // venue must exist and match
    return true;
  }
  if (vid) return venueAgency.get(vid) === agencyId;
  return false;
}

export interface ExportCaller { id?: string; role?: string; agencyId?: string; email?: string }

export function buildAdminExport(snapshot: any, caller: ExportCaller): any {
  const agencyId = caller.agencyId || '';
  const venueAgency = new Map<string, string>();
  for (const v of Array.isArray(snapshot?.venues) ? snapshot.venues : []) {
    if (v && typeof v.id === 'string' && typeof v.agencyId === 'string' && v.agencyId) venueAgency.set(v.id, v.agencyId);
  }
  const out: Record<string, any> = {};
  for (const coll of EXPORT_COLLECTIONS) {
    const arr: any[] = Array.isArray(snapshot?.[coll]) ? snapshot[coll] : [];
    const kept = !agencyId
      ? []
      : coll === 'agencies'
        ? arr.filter((a) => a && a.id === agencyId)
        : coll === 'venues'
          ? arr.filter((v) => v && v.agencyId === agencyId)
          : coll === 'users'
            ? arr.filter((u) => u && u.agencyId === agencyId)
            : arr.filter((r) => ownedByAgency(r, agencyId, venueAgency));
    out[coll] = kept.map((r) => scrubSecrets(projectRecord(coll, r)));
  }
  const ownVenues = new Set((out.venues as any[]).map((v) => v.id));
  const venueWorkDates: Record<string, any> = {};
  for (const [vid, d] of Object.entries(snapshot?.venueWorkDates || {})) {
    if (ownVenues.has(vid)) venueWorkDates[vid] = d;
  }
  return {
    exportScope: 'agency',
    exportAgencyId: agencyId,
    restorable: false,
    exportedFromVersion: snapshot?._v,
    venueWorkDates,
    ...out,
  };
}
