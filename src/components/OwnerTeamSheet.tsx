// Manager role (Don 2026-10-27, "same style as the owner"; server #169): the
// venue OWNER's Team sheet. An owner may add a team member — a Mashgiach or a
// Manager — for their own home venue with the SAME "Add New Team Member" form
// the admin uses (Don 11:01 PM: "Keep the same style as until now. Just add
// another option of manager."; 11:30 PM: owners and coordinators may add, the
// admins are notified and it shows in Announcements), and switch a mashgiach
// at that venue to manager, or a manager back to mashgiach, with the same role
// dropdown the admin's Team screen uses (Don 2026-10-27 10:15 PM: "one of the
// options as you toggle", not a button per person); for an owner it offers
// only Mashgiach and Manager. Like the admin's picker, a change asks to
// confirm first; a failed save puts the dropdown back. Nothing else: no
// owner, admin or coordinator is listed, no other venue, no name, PIN or
// rights. A manager never sees this sheet. Rule T, fail closed: the list and
// the buttons follow ownerRoleSwitchFor / staffMayAddMemberAt (the client
// mirror of the server's ownerMayChangeRole / staffAddsMember); the server
// decides and its answer is shown as written.
import React, { useEffect, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { User } from '../types';
import { ownerMayAddManager, ownerRoleSwitchFor, staffMayAddMemberAt, STAFF_ADD_ROLES } from '../lib/permissions';
import { Sheet } from './PoolPanel';
import { AddMemberForm, STAFF_ADD_NOTE, type AddMemberInput, type AddMemberInvite } from './AddMemberForm';

/** All labels of this sheet in one block. */
export const OWNER_TEAM_TEXT = {
  menuRow: 'Team',
  title: 'Team',
  intro: (venue: string) => `Mashgichim and managers at ${venue}. A manager runs this venue with you.`,
  thisVenue: 'your venue',
  empty: 'No mashgichim or managers here yet.',
  addMember: 'Add team member',
  cancel: 'Cancel',
  roleLabel: (name: string) => `Role for ${name}`,
  optMashgiach: 'Mashgiach',
  optManager: 'Manager',
  confirmManager: (name: string) => `Make ${name} a manager?`,
  confirmManagerBody: 'They will see and do what you do at this venue.',
  confirmMashgiach: (name: string) => `Make ${name} a mashgiach?`,
  confirmMashgiachBody: 'They will no longer manage this venue.',
  yes: 'Yes, change',
  failed: "Couldn't save. Please try again.",
  done: 'Done',
} as const;

/** The only roles an owner's dropdown ever offers (server: ownerMayChangeRole). Never owner, admin or coordinator. */
export const OWNER_ROLE_OPTIONS = ['mashgiach', 'manager'] as const;
export type OwnerRoleOption = typeof OWNER_ROLE_OPTIONS[number];

/** What the owner's dropdown shows for this person now: a worker shows as Mashgiach (like the admin screen). */
export function ownerRoleValue(user: { role?: string }): OwnerRoleOption {
  return user.role === 'manager' ? 'manager' : 'mashgiach';
}

/**
 * The change a dropdown pick asks for, or null when it is no change or not
 * allowed (fail closed): only the one switch ownerRoleSwitchFor allows.
 */
export function ownerRolePick(switchTo: 'manager' | 'mashgiach', user: { role?: string }, picked: string): 'manager' | 'mashgiach' | null {
  if (picked !== 'mashgiach' && picked !== 'manager') return null;
  if (picked === ownerRoleValue(user)) return null;
  return picked === switchTo ? picked : null;
}

/** The people an owner sees here, each with the one role they may switch to (never empty-handed rows). */
export function ownerTeamRows(owner: User | null | undefined, roster: readonly User[] | null | undefined): { user: User; switchTo: 'manager' | 'mashgiach' }[] {
  if (!ownerMayAddManager(owner)) return [];
  const out: { user: User; switchTo: 'manager' | 'mashgiach' }[] = [];
  for (const u of Array.isArray(roster) ? roster : []) {
    const switchTo = ownerRoleSwitchFor(owner, u);
    if (switchTo) out.push({ user: u, switchTo });
  }
  return out.sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
}

const btn = 'min-h-11 px-3 rounded-xl bg-surface border border-line-control text-sm text-ink font-semibold hover:bg-sunken pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const btnGold = 'min-h-11 px-4 rounded-xl bg-gold-deep text-paper text-sm font-semibold pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
// Same look as the admin Team screen's role picker (TeamModal).
const roleSelect = 'text-base font-semibold px-2 py-0.5 rounded-lg uppercase tracking-wider cursor-pointer border border-line-control min-w-0 bg-sunken text-ink-soft focus:ring-2 focus:ring-gold/40 focus:border-gold disabled:opacity-50 disabled:cursor-not-allowed';

interface OwnerTeamSheetProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  roster: User[];
  venueName?: string;
  /** POST /api/users { role: 'mashgiach' | 'manager', venueId: home } — returns the invite link. */
  onAddMember: (input: AddMemberInput) => Promise<void | AddMemberInvite>;
  /** PUT /api/users/:id with exactly { role }. */
  onSetRole: (userId: string, role: 'manager' | 'mashgiach') => Promise<void>;
}

export function OwnerTeamSheet({ isOpen, onClose, currentUser, roster, venueName, onAddMember, onSetRole }: OwnerTeamSheetProps) {
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<{ id: string; to: 'manager' | 'mashgiach' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every close: an answer that lands after the sheet was closed (and
  // maybe reopened with a new draft) is dropped, never applied to the new draft.
  const generation = useRef(0);
  // A roster refresh (e.g. another session changed this person) that no longer
  // allows the pending pick clears it: no stale confirm, the dropdown shows the saved role (RV P3).
  const pendingStillAllowed = !asking || ownerTeamRows(currentUser, roster).some((r) => r.user.id === asking.id && r.switchTo === asking.to);
  useEffect(() => { if (!pendingStillAllowed) setAsking(null); }, [pendingStillAllowed]);
  if (!isOpen || !ownerMayAddManager(currentUser)) return null;
  const home = String(currentUser.venueId || '');
  const rows = ownerTeamRows(currentUser, roster);
  const close = () => { generation.current += 1; setAdding(false); setAsking(null); setError(null); setBusy(false); onClose(); };
  const mayAdd = staffMayAddMemberAt(currentUser, home);

  const confirmSwitch = async () => {
    if (!asking) return;
    // Re-check on the current roster: the row must still allow exactly this switch.
    const row = rows.find((r) => r.user.id === asking.id);
    if (!row || row.switchTo !== asking.to) { setAsking(null); return; }
    const gen = generation.current;
    setBusy(true); setError(null);
    try {
      await onSetRole(asking.id, asking.to);
      if (gen === generation.current) setAsking(null);
    } catch (err: any) {
      // A failed save puts the dropdown back to the saved role and says why.
      if (gen === generation.current) { setAsking(null); setError(err?.message || OWNER_TEAM_TEXT.failed); }
    } finally { if (gen === generation.current) setBusy(false); }
  };

  return (
    <Sheet title={OWNER_TEAM_TEXT.title} onClose={close} testId="owner-team">
      <div data-owner-team className="space-y-3">
        <p className="text-sm text-ink-soft">{OWNER_TEAM_TEXT.intro(venueName || OWNER_TEAM_TEXT.thisVenue)}</p>
        {mayAdd && !adding && (
          <button type="button" data-owner-add-member className={`${btnGold} w-full inline-flex items-center justify-center gap-2`}
            onClick={() => { setAdding(true); setAsking(null); setError(null); }}>
            <UserPlus aria-hidden="true" className="w-4 h-4" />{OWNER_TEAM_TEXT.addMember}
          </button>
        )}
        {mayAdd && adding && (
          <div data-owner-add-form>
            <AddMemberForm roles={STAFF_ADD_ROLES} showPermissions={false} venueId={home}
              venueNote={STAFF_ADD_NOTE(venueName)} idPrefix="owner-"
              existingEmails={(Array.isArray(roster) ? roster : []).map((u) => u.email || '')}
              onAddUser={onAddMember} onCancel={() => setAdding(false)}
              onInviteDone={() => setAdding(false)} doneLabel={OWNER_TEAM_TEXT.done} />
          </div>
        )}
        {error && <p role="alert" data-owner-team-error className="text-base text-ink">{error}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-ink-soft">{OWNER_TEAM_TEXT.empty}</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded-xl">
            {rows.map(({ user, switchTo }) => {
              const open = asking?.id === user.id && asking.to === switchTo;
              return (
                <li key={user.id} data-owner-team-row={user.id} className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 text-base font-semibold text-ink truncate">{user.name}</p>
                    <select
                      data-owner-role-select={user.id}
                      aria-label={OWNER_TEAM_TEXT.roleLabel(user.name)}
                      value={open ? asking!.to : ownerRoleValue(user)}
                      disabled={busy}
                      onChange={(e) => {
                        const to = ownerRolePick(switchTo, user, e.target.value);
                        setError(null);
                        setAsking(to ? { id: user.id, to } : null);
                      }}
                      className={`${roleSelect} shrink-0`}
                    >
                      <option value="mashgiach">{OWNER_TEAM_TEXT.optMashgiach}</option>
                      <option value="manager">{OWNER_TEAM_TEXT.optManager}</option>
                    </select>
                  </div>
                  {open && (
                    <div data-owner-switch-confirm className="p-3 rounded-xl bg-sunken border border-line space-y-2">
                      <p className="text-base font-semibold text-ink">{switchTo === 'manager' ? OWNER_TEAM_TEXT.confirmManager(user.name) : OWNER_TEAM_TEXT.confirmMashgiach(user.name)}</p>
                      <p className="text-sm text-ink-soft">{switchTo === 'manager' ? OWNER_TEAM_TEXT.confirmManagerBody : OWNER_TEAM_TEXT.confirmMashgiachBody}</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" className={btn} disabled={busy} onClick={() => setAsking(null)}>{OWNER_TEAM_TEXT.cancel}</button>
                        <button type="button" data-owner-switch-yes className={btnGold} disabled={busy} onClick={() => void confirmSwitch()}>{OWNER_TEAM_TEXT.yes}</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
