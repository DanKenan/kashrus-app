// Item 12b-c (plan v6 7, Don Oct 22 + 23): the Mashgiach Pool on the client.
// Server routes are 12b-s (#143). Rule T, fail closed: admin = whole agency
// (members, contacts, invites, move-to-pool, make-main); owner/coordinator =
// Pool members (name + last venue) and the borrow list, ticked into their OWN
// venues with venue-ops; anyone else never asks (the server answers 403).
import type { User, Venue } from '../types';
import { apiFetch, apiWrite, captureEditBaseline, type ApiWriteResult } from './api';
import { dayWords, lastDayOf, serverNowMs, ymdIn, zoneForVenue } from './venueEndDates';

/** All Pool labels in one block (plan 7: "All new labels live in one text block"). */
export const POOL_TEXT = {
  teamTab: 'Team',
  poolTab: (n: number) => `Pool (${n})`,
  poolTitle: 'Mashgiach Pool',
  poolIntro: 'People with no main venue right now. Tick a venue to bring someone in.',
  poolIntroManager: 'People with no main venue right now. Tick one of your venues to bring someone in.',
  empty: 'Nobody is in the Pool yet.',
  emptyManager: 'Nobody is in the Pool right now.',
  addButton: 'Add to Pool',
  addTitle: 'Add to Pool',
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  note: 'Note',
  noteHint: 'Notes are not kept after they join.',
  oneRequired: 'Enter a phone number or an email.',
  sendInviteNow: 'Send invite now',
  justKeepDetails: 'Just keep details',
  inviteNeedsEmail: 'Add an email to send an invite.',
  phoneShared: (who: string) => `This phone number is already used by ${who}.`,
  addAnyway: 'Add anyway',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  codeSet: 'Code set',
  noCode: 'No code',
  lastAt: (venue: string, day: string | null) => (day ? `Last at ${venue} until ${day}` : `Last at ${venue}`),
  atNow: (venue: string, day: string | null) => (day ? `At ${venue} until ${day}` : `At ${venue}`),
  neverAt: 'Not at a venue yet',
  tickVenue: 'Tick venue',
  setCode: 'Set code',
  resetCode: 'Reset code',
  makeMain: 'Make main venue',
  inviteSent: (day: string) => `Invite sent · expires ${day}`,
  inviteExpired: 'Invite expired',
  sendAgain: 'Send again',
  sendInvite: 'Send invite',
  edit: 'Edit',
  remove: 'Remove',
  detailsOnly: 'Details only',
  removeTitle: (name: string) => `Remove ${name} from the Pool?`,
  removeBody: 'Their details are deleted. An invite that was sent stops working.',
  fromPool: 'From Pool',
  borrowTitle: 'Borrow from another venue',
  borrowIntro: 'Someone from another venue in your agency, for a set time. An end date is required.',
  borrowEmpty: 'Nobody to borrow right now.',
  borrowButton: 'Borrow',
  borrowFrom: (venue: string) => `From ${venue}`,
  tickTitle: (name: string) => `Bring ${name} to a venue`,
  tickIntro: 'Choose one of your venues. They go back on the end date.',
  tickIntroBorrow: (venue: string) => `Their main venue (${venue}) stays as it is. Choose one of your venues and the last day.`,
  endRequired: 'Last day (required)',
  noYourVenues: 'You have no venue to bring someone to.',
  alreadyThere: 'They are already at that venue.',
  added: (name: string) => `${name} was added.`,
  inviteLinkFor: (name: string) => `Invite link for ${name}`,
  moveToPool: 'Move to Pool',
  moveTitle: (name: string) => `Move ${name} to the Pool?`,
  moveBody: 'They leave every venue now. Their records and history stay.',
  makeMainTitle: (name: string) => `Make a main venue for ${name}`,
  makeMainBody: 'This venue becomes their main venue, with no end date.',
  keepOldMain: (venue: string) => `Keep ${venue} as an extra venue`,
  chooseVenue: 'Choose a venue',
  openWorkTitle: 'Still assigned to them there (kept as is):',
  openTasks: (n: number) => (n === 1 ? '1 open task' : `${n} open tasks`),
  openEvents: (n: number) => (n === 1 ? '1 upcoming event' : `${n} upcoming events`),
  noOpenWork: 'No open tasks or upcoming events are affected.',
  confirmMove: 'Move to Pool',
  confirmMakeMain: 'Make main venue',
  checking: 'Checking…',
  changed: 'Someone else just changed this. Close and try again.',
  previewChanged: 'Something changed since this list was shown. Check it again, then confirm.',
  loadFailed: "Couldn't load the Pool. Try again.",
  retry: 'Try again',
} as const;

export interface PoolMember {
  id: string;
  name: string;
  role: string;
  email?: string;
  phoneNumber?: string;
  hasKioskPin?: boolean;
  venueIds?: string[];
  venueUntil?: Record<string, string>;
  venueRevision?: number;
  lastVenueId?: string;
  lastVenueName?: string | null;
  lastVenueTo?: string;
}

export interface PoolInvite {
  id: string;
  name: string;
  email: string;
  phoneNumber?: string;
  role: string;
  expiresAt: string;
}

export interface PoolContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  note?: string;
  status: 'details' | 'invited';
  inviteExpired?: boolean;
  /** From the matching live Pool invite (same email), when the server listed one. */
  inviteExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PoolData {
  members: PoolMember[];
  invites: PoolInvite[];
  contacts: PoolContact[];
  /** true when the server sent the admin shape (invites + contacts). */
  full: boolean;
}

export interface BorrowPerson {
  id: string;
  name: string;
  homeVenueId: string;
  homeVenueName: string;
  venueRevision?: number;
}

/** Rule T on the client: who may open the Pool at all (the server re-checks). */
export function mayOpenPool(user: Pick<User, 'role'> | null | undefined, isKiosk = false): boolean {
  if (!user || isKiosk) return false;
  return user.role === 'admin' || user.role === 'coordinator' || user.role === 'owner' || user.role === 'manager';
}

/** Venues an owner/coordinator may bring someone to (same rule as the server's mayManageEventAt). */
export function ownVenuesForPool(
  user: Pick<User, 'role' | 'venueId' | 'venueIds' | 'myVenueIds' | 'myVenueRev'> | null | undefined,
  venues: readonly Venue[],
): Venue[] {
  if (!user) return [];
  if (user.role === 'admin') return [...venues];
  if (user.role === 'owner' || user.role === 'manager') return venues.filter((v) => typeof user.venueId === 'string' && !!user.venueId && v.id === user.venueId);
  if (user.role === 'coordinator') {
    const scope = typeof user.myVenueRev === 'number' && Array.isArray(user.myVenueIds)
      ? user.myVenueIds
      : [user.venueId || '', ...(Array.isArray(user.venueIds) ? user.venueIds : [])];
    const set = new Set(scope.filter(Boolean));
    return venues.filter((v) => set.has(v.id));
  }
  return [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parse GET /api/pool fail closed: anything malformed is dropped, never guessed. */
export function parsePool(data: any): PoolData {
  const d = data && typeof data === 'object' ? data : {};
  const members: PoolMember[] = (Array.isArray(d.members) ? d.members : [])
    .filter((m: any) => m && typeof m.id === 'string' && m.id && typeof m.name === 'string')
    .map((m: any) => ({
      id: m.id, name: m.name, role: str(m.role),
      ...(typeof m.email === 'string' ? { email: m.email } : {}),
      ...(typeof m.phoneNumber === 'string' ? { phoneNumber: m.phoneNumber } : {}),
      ...(typeof m.hasKioskPin === 'boolean' ? { hasKioskPin: m.hasKioskPin } : {}),
      ...(Array.isArray(m.venueIds) ? { venueIds: m.venueIds.filter((x: any) => typeof x === 'string') } : {}),
      ...(m.venueUntil && typeof m.venueUntil === 'object' ? { venueUntil: m.venueUntil } : {}),
      ...(Number.isInteger(m.venueRevision) ? { venueRevision: m.venueRevision } : {}),
      ...(typeof m.lastVenueId === 'string' ? { lastVenueId: m.lastVenueId, lastVenueName: typeof m.lastVenueName === 'string' ? m.lastVenueName : null, lastVenueTo: str(m.lastVenueTo) } : {}),
    }));
  const full = Array.isArray(d.contacts) || Array.isArray(d.invites);
  const contacts: PoolContact[] = (Array.isArray(d.contacts) ? d.contacts : [])
    .filter((c: any) => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c: any) => ({
      id: c.id, name: c.name, status: c.status === 'invited' ? 'invited' : 'details',
      ...(typeof c.email === 'string' && c.email ? { email: c.email } : {}),
      ...(typeof c.phone === 'string' && c.phone ? { phone: c.phone } : {}),
      ...(typeof c.note === 'string' && c.note ? { note: c.note } : {}),
      ...(c.inviteExpired === true ? { inviteExpired: true } : {}),
      createdAt: str(c.createdAt), updatedAt: str(c.updatedAt),
    }));
  // A contact's own live invite is shown on the contact row, not twice.
  const rawInvites: any[] = Array.isArray(d.invites) ? d.invites : [];
  for (const c of contacts) {
    if (c.status !== 'invited' || c.inviteExpired || !c.email) continue;
    const inv = rawInvites.find((i: any) => i && typeof i.email === 'string' && i.email.toLowerCase() === c.email!.toLowerCase());
    if (inv && typeof inv.expiresAt === 'string') c.inviteExpiresAt = inv.expiresAt;
  }
  const contactEmails = new Set(contacts.filter((c) => c.status === 'invited' && c.email).map((c) => c.email!.toLowerCase()));
  const invites: PoolInvite[] = (Array.isArray(d.invites) ? d.invites : [])
    .filter((i: any) => i && typeof i.id === 'string' && typeof i.email === 'string')
    .filter((i: any) => !contactEmails.has(i.email.toLowerCase()))
    .map((i: any) => ({ id: i.id, name: str(i.name) || i.email, email: i.email, role: str(i.role), expiresAt: str(i.expiresAt), ...(typeof i.phoneNumber === 'string' ? { phoneNumber: i.phoneNumber } : {}) }));
  members.sort((a, b) => a.name.localeCompare(b.name));
  contacts.sort((a, b) => a.name.localeCompare(b.name));
  invites.sort((a, b) => a.name.localeCompare(b.name));
  return { members, invites, contacts, full };
}

export function parseBorrow(data: any): BorrowPerson[] {
  const list = data && Array.isArray(data.people) ? data.people : [];
  return list
    .filter((p: any) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.homeVenueId === 'string')
    .map((p: any) => ({ id: p.id, name: p.name, homeVenueId: p.homeVenueId, homeVenueName: str(p.homeVenueName), ...(Number.isInteger(p.venueRevision) ? { venueRevision: p.venueRevision } : {}) }));
}

/** The count on the tab: what the server would count for this caller. */
export function poolCount(p: PoolData | null): number {
  if (!p) return 0;
  return p.members.length + (p.full ? p.contacts.length + p.invites.length : 0);
}

/** "Mon, Oct 25" style short day for an ISO instant in a venue zone. */
export function shortDay(iso: string | undefined, zone: string, nowMs: number = serverNowMs()): string | null {
  if (!iso) return null;
  const day = lastDayOf(iso, zone);
  if (!day) return null;
  return dayWords(day, ymdIn(nowMs, zone)).long;
}

/** The status line of a Pool member: an active tick wins, else the last venue, else nothing yet. */
export function memberWhereLine(m: PoolMember, venues: readonly Venue[], agencyTimeZone?: string, nowMs: number = serverNowMs()): string {
  const ids = new Set(m.venueIds || []);
  const active = venues.filter((v) => ids.has(v.id)); // venue order, like the roster
  if (active.length > 0) {
    const v = active[0];
    const zone = zoneForVenue(v, agencyTimeZone);
    const day = m.venueUntil && typeof m.venueUntil[v.id] === 'string' ? shortDay(m.venueUntil[v.id], zone, nowMs) : null;
    const more = active.length > 1 ? ` +${active.length - 1}` : '';
    return POOL_TEXT.atNow(v.name, day) + more;
  }
  if (m.lastVenueId) {
    const v = venues.find((x) => x.id === m.lastVenueId);
    const name = m.lastVenueName || v?.name;
    if (name) {
      // The history's end is the instant access ended (midnight after the last day): show the last day.
      const zone = zoneForVenue(v, agencyTimeZone);
      const day = m.lastVenueTo ? shortDay(m.lastVenueTo, zone, nowMs) : null;
      return POOL_TEXT.lastAt(name, day);
    }
  }
  return POOL_TEXT.neverAt;
}

/** A contact/invite row's status line. */
export function contactStatusLine(c: PoolContact, agencyTimeZone?: string, nowMs: number = serverNowMs()): string {
  if (c.status === 'invited') {
    if (c.inviteExpired) return POOL_TEXT.inviteExpired;
    return c.inviteExpiresAt ? inviteStatusLine({ id: c.id, name: c.name, email: c.email || '', role: '', expiresAt: c.inviteExpiresAt }, agencyTimeZone, nowMs) : 'Invite sent';
  }
  return POOL_TEXT.detailsOnly;
}

export function inviteStatusLine(i: PoolInvite, agencyTimeZone?: string, nowMs: number = serverNowMs()): string {
  const t = Date.parse(i.expiresAt);
  if (!Number.isFinite(t) || t <= nowMs) return POOL_TEXT.inviteExpired;
  const day = shortDay(new Date(t - 1).toISOString(), zoneForVenue(null, agencyTimeZone), nowMs);
  return day ? POOL_TEXT.inviteSent(day) : 'Invite sent';
}

export interface AddFormInput { name: string; phone: string; email: string; note: string; }

/** Client-side check of the Add to Pool form (the server re-validates). */
export function validateAddForm(f: AddFormInput, sendInvite: boolean): string | null {
  const name = f.name.trim();
  if (!name) return 'Enter a name.';
  if (name.length > 80) return 'Names can be up to 80 characters.';
  if (!f.phone.trim() && !f.email.trim()) return POOL_TEXT.oneRequired;
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return 'Enter a valid email address.';
  if (f.note.length > 140) return 'Notes can be up to 140 characters.';
  if (sendInvite && !f.email.trim()) return POOL_TEXT.inviteNeedsEmail;
  return null;
}

/** The venue-ops body an owner/coordinator sends: additions only, never touching other venues. */
export function tickOps(picks: Array<{ venueId: string; lastDay: string | null }>): Array<{ op: 'add'; venueId: string; until: string | null }> {
  return picks.map((p) => ({ op: 'add' as const, venueId: p.venueId, until: p.lastDay }));
}

/** A failed write's message, with the Pool's own codes in plain words. */
export function poolErrorText(r: ApiWriteResult): string {
  if (r.code === 'ALREADY_TICKED') return POOL_TEXT.alreadyThere;
  if (r.code === 'VENUES_CHANGED' || r.code === 'CONTACT_CHANGED' || r.code === 'VERSION_CONFLICT') return POOL_TEXT.changed;
  return r.error || "Couldn't save. Try again.";
}

// ---- server calls ----------------------------------------------------------

export async function loadPool(): Promise<PoolData | null> {
  try {
    const res = await apiFetch('/api/pool', { cache: 'no-store' });
    if (!res.ok) return null;
    return parsePool(await res.json());
  } catch { return null; }
}

export async function loadBorrow(): Promise<BorrowPerson[] | null> {
  try {
    const res = await apiFetch('/api/pool/borrow', { cache: 'no-store' });
    if (!res.ok) return null;
    return parseBorrow(await res.json());
  } catch { return null; }
}

const json = (b: unknown) => JSON.stringify(b);

export function createContact(f: AddFormInput, confirmSharedPhone: boolean) {
  const body: Record<string, unknown> = { name: f.name.trim() };
  if (f.email.trim()) body.email = f.email.trim();
  if (f.phone.trim()) body.phone = f.phone.trim();
  if (f.note.trim()) body.note = f.note.trim();
  if (confirmSharedPhone) body.confirmSharedPhone = true;
  return apiWrite<{ contact: any }>('/api/pool/contacts', { method: 'POST', expectedVersion: captureEditBaseline(), body: json(body) });
}

export function editContact(c: PoolContact, f: AddFormInput, confirmSharedPhone: boolean) {
  const body: Record<string, unknown> = { name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, note: f.note.trim() || null, expectedUpdatedAt: c.updatedAt };
  if (confirmSharedPhone) body.confirmSharedPhone = true;
  return apiWrite<{ contact: any }>(`/api/pool/contacts/${encodeURIComponent(c.id)}`, { method: 'PATCH', expectedVersion: captureEditBaseline(), body: json(body) });
}

export function deleteContact(c: PoolContact) {
  return apiWrite(`/api/pool/contacts/${encodeURIComponent(c.id)}`, { method: 'DELETE', expectedVersion: captureEditBaseline(), body: json({ expectedUpdatedAt: c.updatedAt }) });
}

export function inviteContact(c: PoolContact) {
  return apiWrite<{ link: string }>(`/api/pool/contacts/${encodeURIComponent(c.id)}/invite`, {
    method: 'POST', expectedVersion: captureEditBaseline(), body: json({ expectedUpdatedAt: c.updatedAt, expectedEmail: c.email || '' }),
  });
}

export function tickIn(personId: string, venueRevision: number, picks: Array<{ venueId: string; lastDay: string | null }>) {
  return apiWrite(`/api/users/${encodeURIComponent(personId)}/venue-ops`, {
    method: 'POST', expectedVersion: captureEditBaseline(), body: json({ ops: tickOps(picks), expectedVenueRev: venueRevision }),
  });
}

export interface OpenWork { tasks: Array<{ id: string; title: string; venueId: string }>; events: Array<{ id: string; title: string; venueId: string; date: string }>; }

export function parseOpenWork(d: any): OpenWork {
  const ow = d && d.openWork && typeof d.openWork === 'object' ? d.openWork : {};
  return {
    tasks: Array.isArray(ow.tasks) ? ow.tasks.filter((t: any) => t && typeof t.id === 'string') : [],
    events: Array.isArray(ow.events) ? ow.events.filter((e: any) => e && typeof e.id === 'string') : [],
  };
}

/**
 * move-to-pool / make-main. A dry run captures the version it was answered at; the confirm
 * sends THAT version (RV1 P2), so a change after the preview (e.g. a task newly assigned)
 * is refused with a conflict instead of being confirmed against an old open-work list.
 */
export function moveToPool(personId: string, venueRevision: number, dryRun: boolean, expectedVersion: number | undefined) {
  return apiWrite(`/api/users/${encodeURIComponent(personId)}/move-to-pool`, {
    method: 'POST', expectedVersion, body: json({ expectedVenueRev: venueRevision, dryRun }),
  });
}

export function makeMain(personId: string, venueRevision: number, venueId: string, keepOldMainAsExtra: boolean, dryRun: boolean, expectedVersion: number | undefined) {
  return apiWrite(`/api/users/${encodeURIComponent(personId)}/make-main`, {
    method: 'POST', expectedVersion, body: json({ expectedVenueRev: venueRevision, venueId, keepOldMainAsExtra, dryRun }),
  });
}

/** The version a dry run is sent at (the confirm reuses it). */
export function previewVersion(): number | undefined {
  return captureEditBaseline();
}

/** The selected venues a tick may send: only those still offered now (RV1 P2: scope can shrink while the sheet is open). */
export function pickedForSubmit(picked: Record<string, string | null>, offered: ReadonlyArray<{ id: string }>): Array<{ venueId: string; lastDay: string | null }> {
  const ok = new Set(offered.map((v) => v.id));
  return Object.keys(picked).filter((id) => ok.has(id)).map((venueId) => ({ venueId, lastDay: picked[venueId] ?? null }));
}

/** Pool member ids (admin view): these rows live in the Pool tab, not the Team tab, unless they hold a venue now. */
export function poolOnlyIds(p: PoolData | null): Set<string> {
  const s = new Set<string>();
  if (!p) return s;
  for (const m of p.members) if (!m.venueIds || m.venueIds.length === 0) s.add(m.id);
  return s;
}

/** A Team row is "From Pool" when the server lists them as a Pool member and they hold a venue now (admin view). */
export function isFromPool(u: Pick<User, 'id' | 'role' | 'venueId' | 'venueIds'>, p: PoolData | null): boolean {
  if (!p || u.role === 'admin' || u.venueId) return false;
  return p.members.some((m) => m.id === u.id) && Array.isArray(u.venueIds) && u.venueIds.length > 0;
}
