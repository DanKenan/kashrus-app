/**
 * Item 8k: agency-scoped Clean Slate — the pure planner ("8k plan v2").
 *
 * Decides, on the FRESH monolith doc and before anything is filtered, what
 * one agency's Clean Slate removes. Ownership rules (A = caller agency):
 *  VA = ids of venues with (agencyId||'agency-hkc') === A
 *  DU = users removed (non-admin rows of A; the caller is always kept)
 *  DE = their normalised emails
 *  - venues, tasks, historyLogs, events, airtableConfigs, approvedIngredients,
 *    factoryReports: (x.agencyId||'agency-hkc') === A (unchanged rule)
 *  - handoffNotes: agencyId === A, or no agencyId and venueId ∈ VA
 *  - taskTemplates, incidents, announcements, eventTaskTemplates:
 *    agencyId === A; no agencyId → KEPT and counted
 *  - kioskDevices: agencyId === A (RD = their ids)
 *  - kioskPairings (keyed): venueId ∈ VA or deviceId ∈ RD; otherwise KEPT
 *    (an unattributable pending pairing is counted, it expires by TTL)
 *  - kioskPinLockouts.users: keys ∈ DU; .tablets ('venueId|ip'): venueId ∈ VA
 *  - kioskPairingLimits: 'caller|<id>' with id ∈ DU (IP buckets KEPT)
 *  - pushSubscriptions: userId ∈ DU, or legacy (no userId) with email ∈ DE
 *  - passwordResets: email ∈ DE; passwordResetRateLimits.emailRequests: DE
 *  - venueWorkDates: keys ∈ VA
 * Anything of another agency is never removed. The global isDemoCleared is
 * never written here; agencies[A].cleanSlateAt is set instead.
 */

const DEFAULT_AGENCY_ID = 'agency-hkc';
const agencyOf = (x: any) => (x && typeof x.agencyId === 'string' && x.agencyId ? x.agencyId : DEFAULT_AGENCY_ID);
const normEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const obj = (x: unknown): Record<string, any> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as any) : {});

export interface CleanSlatePlan {
  patch: Record<string, any>;
  removedUserIds: string[];
  removed: Record<string, number>;
  keptUnattributed: Record<string, number>;
}

export function planCleanSlate(
  fresh: any,
  agencyId: string,
  caller: { id: string; email?: string },
  nowIso: string
): CleanSlatePlan {
  const removed: Record<string, number> = {};
  const keptUnattributed: Record<string, number> = {};
  const count = (k: string, n: number) => { if (n) removed[k] = (removed[k] || 0) + n; };
  const unattributed = (k: string, n: number) => { if (n) keptUnattributed[k] = (keptUnattributed[k] || 0) + n; };

  const VA = new Set(arr(fresh.venues).filter((v) => v && agencyOf(v) === agencyId).map((v) => String(v.id)));
  const callerEmail = normEmail(caller.email);
  const users = arr(fresh.users);
  const isRemovedUser = (u: any) =>
    !!u && agencyOf(u) === agencyId && u.role !== 'admin' && u.id !== caller.id && normEmail(u.email) !== callerEmail;
  const DUrows = users.filter(isRemovedUser);
  const DU = new Set(DUrows.map((u) => String(u.id)));
  const DE = new Set(DUrows.map((u) => normEmail(u.email)).filter(Boolean));

  const patch: Record<string, any> = {};
  const byAgency = (key: string) => {
    const a = arr(fresh[key]);
    const kept = a.filter((x) => agencyOf(x) !== agencyId);
    count(key, a.length - kept.length);
    patch[key] = kept;
  };
  for (const k of ['venues', 'tasks', 'historyLogs', 'events', 'airtableConfigs', 'approvedIngredients', 'factoryReports']) byAgency(k);

  // handoffNotes: agencyId === A, or no agencyId and venueId ∈ VA
  {
    const a = arr(fresh.handoffNotes);
    const kept = a.filter((n) => {
      if (n && typeof n.agencyId === 'string' && n.agencyId) return n.agencyId !== agencyId;
      return !(n && VA.has(String(n.venueId)));
    });
    count('handoffNotes', a.length - kept.length);
    patch.handoffNotes = kept;
  }
  // Strictly tagged collections: untagged items are kept and counted.
  for (const k of ['taskTemplates', 'incidents', 'announcements', 'eventTaskTemplates']) {
    const a = arr(fresh[k]);
    let untagged = 0;
    const kept = a.filter((x) => {
      if (!x || typeof x.agencyId !== 'string' || !x.agencyId) { untagged++; return true; }
      return x.agencyId !== agencyId;
    });
    count(k, a.length - kept.length);
    unattributed(k, untagged);
    patch[k] = kept;
  }
  // Kiosk devices and pairings.
  const devices = arr(fresh.kioskDevices);
  const RD = new Set(devices.filter((d) => d && d.agencyId === agencyId).map((d) => String(d.id)));
  patch.kioskDevices = devices.filter((d) => !(d && d.agencyId === agencyId));
  count('kioskDevices', devices.length - patch.kioskDevices.length);
  {
    const pairings = obj(fresh.kioskPairings);
    const kept: Record<string, any> = {};
    let n = 0;
    for (const [id, p] of Object.entries(pairings)) {
      const mine = (p && p.venueId && VA.has(String(p.venueId))) || (p && p.deviceId && RD.has(String(p.deviceId)));
      if (mine) { n++; continue; }
      if (!p || (!p.venueId && !p.deviceId)) unattributed('kioskPairings', 1);
      kept[id] = p;
    }
    count('kioskPairings', n);
    patch.kioskPairings = kept;
  }
  {
    const lo = obj(fresh.kioskPinLockouts);
    const lu = obj(lo.users), lt = obj(lo.tablets);
    const users2: Record<string, any> = {}, tablets2: Record<string, any> = {};
    let n = 0;
    for (const [k, v] of Object.entries(lu)) { if (DU.has(k)) n++; else users2[k] = v; }
    for (const [k, v] of Object.entries(lt)) {
      const i = k.indexOf('|');
      if (i <= 0) { unattributed('kioskPinLockouts.tablets', 1); tablets2[k] = v; continue; }
      if (VA.has(k.slice(0, i))) n++; else tablets2[k] = v;
    }
    count('kioskPinLockouts', n);
    patch.kioskPinLockouts = { ...lo, users: users2, tablets: tablets2 };
  }
  {
    const lim = obj(fresh.kioskPairingLimits);
    const kept: Record<string, any> = {};
    let n = 0;
    for (const [k, v] of Object.entries(lim)) {
      if (k.startsWith('caller|') && DU.has(k.slice(7))) { n++; continue; }
      kept[k] = v;
    }
    count('kioskPairingLimits', n);
    patch.kioskPairingLimits = kept;
  }
  {
    const subs = arr(fresh.pushSubscriptions);
    const kept = subs.filter((s) => {
      if (!s) return true;
      if (typeof s.userId === 'string' && s.userId) return !DU.has(s.userId);
      return !DE.has(normEmail(s.userEmail));
    });
    count('pushSubscriptions', subs.length - kept.length);
    patch.pushSubscriptions = kept;
  }
  {
    const pr = arr(fresh.passwordResets);
    const kept = pr.filter((r) => !(r && DE.has(normEmail(r.email))));
    count('passwordResets', pr.length - kept.length);
    patch.passwordResets = kept;
    const rl = obj(fresh.passwordResetRateLimits);
    const er = obj(rl.emailRequests);
    const er2: Record<string, any> = {};
    let n = 0;
    for (const [k, v] of Object.entries(er)) { if (DE.has(normEmail(k))) n++; else er2[k] = v; }
    count('passwordResetRateLimits', n);
    patch.passwordResetRateLimits = { ...rl, emailRequests: er2 };
  }
  {
    const wd = obj(fresh.venueWorkDates);
    const kept: Record<string, any> = {};
    let n = 0;
    for (const [k, v] of Object.entries(wd)) { if (VA.has(k)) n++; else kept[k] = v; }
    count('venueWorkDates', n);
    patch.venueWorkDates = kept;
  }
  patch.users = users.filter((u) => !isRemovedUser(u));
  count('users', users.length - patch.users.length);
  patch.agencies = arr(fresh.agencies).map((a) => (a && a.id === agencyId ? { ...a, cleanSlateAt: nowIso } : a));
  return { patch, removedUserIds: [...DU], removed, keptUnattributed };
}

/** The per-agency cleared state the client sees (never the legacy global). */
export function agencyIsCleared(agencies: any[], agencyId: string): boolean {
  const a = arr(agencies).find((x) => x && x.id === agencyId);
  return !!(a && typeof a.cleanSlateAt === 'string' && a.cleanSlateAt);
}
