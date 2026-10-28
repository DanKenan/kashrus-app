// Manager role (Don 2026-10-27, "same style as the owner"; server #169): the
// venue OWNER's Team sheet. An owner may add a manager for their own home venue
// (a pending invite, like an admin's "Add team member") and switch a mashgiach
// at that venue to manager, or a manager back to mashgiach. Nothing else: no
// owner, admin or coordinator is listed, no other venue, no name, PIN or
// rights. A manager never sees this sheet. Rule T, fail closed: the list and
// the buttons follow ownerRoleSwitchFor / ownerMayAddManager (the client
// mirror of the server's ownerMayChangeRole / ownerAddsManager); the server
// decides and its answer is shown as written.
import React, { useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { User } from '../types';
import { getRoleLabel, ownerMayAddManager, ownerRoleSwitchFor } from '../lib/permissions';
import { normalizePhone } from '../lib/kioskCodeShare';
import { Sheet } from './PoolPanel';
import { InviteLinkCard } from './InviteLinkCard';

/** All labels of this sheet in one block. */
export const OWNER_TEAM_TEXT = {
  menuRow: 'Team',
  title: 'Team',
  intro: (venue: string) => `Mashgichim and managers at ${venue}. A manager runs this venue with you.`,
  thisVenue: 'your venue',
  empty: 'No mashgichim or managers here yet.',
  addManager: 'Add manager',
  addTitle: 'Add a manager',
  addHint: 'They get a link to set their own password. A manager sees and does what you do at this venue.',
  name: 'Name',
  email: 'Email',
  phone: 'Phone (optional)',
  needNameEmail: 'Please enter a name and an email.',
  badPhone: "That phone number doesn't look right. Use digits, with + and the country code outside the US.",
  send: 'Make invite link',
  cancel: 'Cancel',
  makeManager: 'Make manager',
  makeMashgiach: 'Make mashgiach',
  confirmManager: (name: string) => `Make ${name} a manager?`,
  confirmManagerBody: 'They will see and do what you do at this venue.',
  confirmMashgiach: (name: string) => `Make ${name} a mashgiach?`,
  confirmMashgiachBody: 'They will no longer manage this venue.',
  yes: 'Yes, change',
  failed: "Couldn't save. Please try again.",
  linkHint: (name: string) => `Send this link to ${name}.`,
  done: 'Done',
} as const;

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
const input = 'w-full min-h-11 px-3 rounded-lg bg-surface border border-line-control text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold';

interface OwnerTeamSheetProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  roster: User[];
  venueName?: string;
  /** POST /api/users { role: 'manager', venueId: home } — returns the invite link. */
  onAddManager: (input: { name: string; email: string; role: 'manager'; venueId: string; phoneNumber?: string }) => Promise<void | { link: string; name: string; email: string }>;
  /** PUT /api/users/:id with exactly { role }. */
  onSetRole: (userId: string, role: 'manager' | 'mashgiach') => Promise<void>;
}

export function OwnerTeamSheet({ isOpen, onClose, currentUser, roster, venueName, onAddManager, onSetRole }: OwnerTeamSheetProps) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [asking, setAsking] = useState<{ id: string; to: 'manager' | 'mashgiach' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; name: string } | null>(null);
  if (!isOpen || !ownerMayAddManager(currentUser)) return null;
  const home = String(currentUser.venueId || '');
  const rows = ownerTeamRows(currentUser, roster);
  const close = () => { setAdding(false); setAsking(null); setError(null); setLink(null); onClose(); };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name || !email) { setError(OWNER_TEAM_TEXT.needNameEmail); return; }
    const phone = normalizePhone(form.phone);
    if (phone === null) { setError(OWNER_TEAM_TEXT.badPhone); return; }
    setBusy(true); setError(null);
    try {
      const made = await onAddManager({ name, email, role: 'manager', venueId: home, ...(phone ? { phoneNumber: phone } : {}) });
      if (made && typeof made.link === 'string') setLink({ link: made.link, name: made.name || name });
      setForm({ name: '', email: '', phone: '' });
      setAdding(false);
    } catch (err: any) {
      setError(err?.message || OWNER_TEAM_TEXT.failed);
    } finally { setBusy(false); }
  };

  const confirmSwitch = async () => {
    if (!asking) return;
    // Re-check on the current roster: the row must still allow exactly this switch.
    const row = rows.find((r) => r.user.id === asking.id);
    if (!row || row.switchTo !== asking.to) { setAsking(null); return; }
    setBusy(true); setError(null);
    try {
      await onSetRole(asking.id, asking.to);
      setAsking(null);
    } catch (err: any) {
      setError(err?.message || OWNER_TEAM_TEXT.failed);
    } finally { setBusy(false); }
  };

  return (
    <Sheet title={OWNER_TEAM_TEXT.title} onClose={close} testId="owner-team">
      <div data-owner-team className="space-y-3">
        <p className="text-sm text-ink-soft">{OWNER_TEAM_TEXT.intro(venueName || OWNER_TEAM_TEXT.thisVenue)}</p>
        {link && (
          <InviteLinkCard link={link.link} forWhom={link.name} hint={OWNER_TEAM_TEXT.linkHint(link.name)}
            onDone={() => setLink(null)} doneLabel={OWNER_TEAM_TEXT.done} />
        )}
        {!link && !adding && (
          <button type="button" data-owner-add-manager className={`${btnGold} w-full inline-flex items-center justify-center gap-2`}
            onClick={() => { setAdding(true); setAsking(null); setError(null); }}>
            <UserPlus aria-hidden="true" className="w-4 h-4" />{OWNER_TEAM_TEXT.addManager}
          </button>
        )}
        {adding && (
          <form data-owner-add-form onSubmit={submitAdd} className="p-3 rounded-xl bg-sunken border border-line space-y-3">
            <h3 className="text-sm font-semibold text-ink">{OWNER_TEAM_TEXT.addTitle}</h3>
            <p className="text-sm text-ink-soft">{OWNER_TEAM_TEXT.addHint}</p>
            <label className="block text-sm font-semibold text-ink-soft">{OWNER_TEAM_TEXT.name}
              <input data-owner-add-name className={`${input} mt-1`} value={form.name} maxLength={80} autoComplete="off"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="block text-sm font-semibold text-ink-soft">{OWNER_TEAM_TEXT.email}
              <input data-owner-add-email className={`${input} mt-1`} type="email" value={form.email} autoComplete="off"
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </label>
            <label className="block text-sm font-semibold text-ink-soft">{OWNER_TEAM_TEXT.phone}
              <input data-owner-add-phone className={`${input} mt-1`} inputMode="tel" value={form.phone} autoComplete="off"
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={btn} disabled={busy} onClick={() => { setAdding(false); setError(null); }}>{OWNER_TEAM_TEXT.cancel}</button>
              <button type="submit" data-owner-add-submit className={btnGold} disabled={busy}>{OWNER_TEAM_TEXT.send}</button>
            </div>
          </form>
        )}
        {error && <p role="alert" data-owner-team-error className="text-base text-ink">{error}</p>}
        {rows.length === 0 ? (
          <p className="text-sm text-ink-soft">{OWNER_TEAM_TEXT.empty}</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded-xl">
            {rows.map(({ user, switchTo }) => {
              const open = asking?.id === user.id;
              return (
                <li key={user.id} data-owner-team-row={user.id} className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-ink truncate">{user.name}</p>
                      <span data-owner-team-role className="text-sm text-ink-soft">{getRoleLabel(user.role)}</span>
                    </div>
                    {!open && (
                      <button type="button" data-owner-switch={switchTo} className={`${btn} shrink-0`} disabled={busy}
                        onClick={() => { setAsking({ id: user.id, to: switchTo }); setError(null); }}>
                        {switchTo === 'manager' ? OWNER_TEAM_TEXT.makeManager : OWNER_TEAM_TEXT.makeMashgiach}
                      </button>
                    )}
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
