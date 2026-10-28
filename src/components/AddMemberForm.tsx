// The ONE "Add New Team Member" card (Don 2026-10-27 11:01 PM: "Keep the same
// style as until now. Just add another option of manager."). The admin Team
// screen, a coordinator's Team screen and a venue owner's Team sheet all use
// it; only the role list, the rights checkboxes (admin only) and a venue note
// differ. Owners and coordinators may add a Mashgiach or a Manager (server:
// staffAddsMember); the server decides and its answer is shown as written.
import React, { useEffect, useRef, useState } from 'react';
import { UserPlus, User, Mail, AlertTriangle, Phone } from 'lucide-react';
import { DEFAULT_ROLE_PERMISSIONS } from '../lib/permissions';
import { normalizePhone } from '../lib/kioskCodeShare';
import { InviteLinkCard } from './InviteLinkCard';
import type { UserPermissions, UserRole } from '../types';

/** Item 10i: what Add member returns when the agency's Phase C is ON (the server made an invite, not a user). */
export interface AddMemberInvite {
  link: string;
  name: string;
  email: string;
}

export type AddMemberRole = 'mashgiach' | 'coordinator' | 'manager';
/** The role picker's labels, the same everywhere. */
export const ADD_MEMBER_ROLE_LABEL: Record<AddMemberRole, string> = {
  mashgiach: 'Mashgiach (Field Inspector)',
  coordinator: 'Coordinator (Can Add Tasks)',
  manager: 'Manager (Runs this venue)',
};
/** What an owner or coordinator is told under the form: where the person joins, and that the admins hear about it. */
export const STAFF_ADD_NOTE = (venue?: string) => `They join ${venue || 'this venue'}. Your agency admins are notified, and it shows in Announcements.`;
/** The admin's roles; an owner or coordinator gets STAFF_ADD_ROLES (lib/permissions). */
export const ADMIN_ADD_ROLES: readonly AddMemberRole[] = ['mashgiach', 'coordinator', 'manager'];

export interface AddMemberInput {
  name: string;
  email: string;
  role: UserRole;
  venueId?: string;
  permissions?: UserPermissions;
  phoneNumber?: string;
}

interface AddMemberFormProps {
  /** The roles offered, first = default. Anything else is never sent (fail closed). */
  roles: readonly AddMemberRole[];
  /** Admin only: the rights checkboxes. Owners/coordinators get role-default rights (the server sets them). */
  showPermissions: boolean;
  venueId?: string;
  venueNote?: string;
  existingEmails: readonly string[];
  onAddUser: (input: AddMemberInput) => Promise<void | AddMemberInvite>;
  onCancel?: () => void;
  onInviteDone?: () => void;
  doneLabel?: string;
  /** Keeps element ids unique when two forms could exist. */
  idPrefix?: string;
}

export function AddMemberForm({ roles, showPermissions, venueId, venueNote, existingEmails, onAddUser, onCancel, onInviteDone, doneLabel = 'Add another person', idPrefix = '' }: AddMemberFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [role, setRole] = useState<AddMemberRole>(roles[0] || 'mashgiach');
  const [canFill, setCanFill] = useState<boolean>(true);
  const [canAssign, setCanAssign] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{ link: string; forWhom: string } | null>(null);
  // An answer that lands after the form is gone (sheet closed) is dropped.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pickRole = (r: string): AddMemberRole => ((roles as readonly string[]).includes(r) ? (r as AddMemberRole) : (roles[0] || 'mashgiach'));

  const handleRoleChange = (next: string) => {
    const r = pickRole(next);
    setRole(r);
    // QA2 #23: a new role starts from that role's own permissions (a coordinator can add tasks).
    const defaults = DEFAULT_ROLE_PERMISSIONS[r] || { canFillTasks: true, canAssignTasks: false };
    setCanFill(defaults.canFillTasks ?? false);
    setCanAssign(defaults.canAssignTasks ?? false);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Invites are always on (Don 2026-10-22): a new person gets a link and chooses their own password.
    if (!name.trim() || !email.trim()) {
      setError('Please provide a name and an email.');
      return;
    }
    const phoneClean = normalizePhone(newPhone);
    if (phoneClean === null) {
      setError("That phone number doesn't look right. Use digits, with + and the country code outside the US.");
      return;
    }
    const emailClean = email.trim().toLowerCase();
    if (existingEmails.some((x) => (x || '').toLowerCase() === emailClean)) {
      setError('A team member with this email already exists.');
      return;
    }
    try {
      setIsSubmitting(true);
      const added = await onAddUser({
        name: name.trim(),
        email: emailClean,
        role: pickRole(role),
        venueId,
        ...(showPermissions ? { permissions: { canFillTasks: canFill, canAssignTasks: canAssign } } : {}),
        ...(phoneClean ? { phoneNumber: phoneClean } : {}),
      });
      if (!alive.current) return;
      if (added && typeof added.link === 'string') {
        setInviteResult({ link: added.link, forWhom: `${added.name} (${added.email})` });
      }
      setName('');
      setEmail('');
      setNewPhone('');
      handleRoleChange(roles[0] || 'mashgiach');
    } catch (err: any) {
      if (alive.current) setError(err?.message || 'Failed to add team member.');
    } finally {
      if (alive.current) setIsSubmitting(false);
    }
  };

  return (
    <div data-add-member-card className="p-4 rounded-2xl bg-sunken border border-line e1">
      <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft mb-3 flex items-center gap-1.5">
        <UserPlus className="w-3.5 h-3.5 text-ok" />
        Add New Team Member
      </h3>

      {error && (
        <div className="mb-3 p-2.5 rounded-xl bg-bad-bg border border-bad text-xs text-bad flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {inviteResult ? (
        <InviteLinkCard
          link={inviteResult.link}
          forWhom={inviteResult.forWhom}
          onDone={() => { setInviteResult(null); onInviteDone?.(); }}
          doneLabel={doneLabel}
        />
      ) : (
      <form data-add-member-form onSubmit={handleAddSubmit} className="space-y-3 text-xs">
        <p data-invite-mode-note className="text-sm text-ink-soft">
          No password needed. You'll get a link to send them, and they choose their own password.
        </p>
        {venueNote && <p data-add-member-venue-note className="text-sm text-ink-soft">{venueNote}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-4">
            <label className="block font-semibold text-ink-soft mb-1">
              Full Name
            </label>
            <div className="relative">
              <User className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id={`${idPrefix}new-member-name-input`}
                type="text"
                required
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full pl-8 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>

          <div className="sm:col-span-4">
            <label className="block font-semibold text-ink-soft mb-1">
              Email
            </label>
            <div className="relative">
              <Mail className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id={`${idPrefix}new-member-email-input`}
                type="email"
                required
                placeholder="e.g. dcohen@hartfordkashrut.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-8 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>


          <div className="sm:col-span-4">
            <label className="block font-semibold text-ink-soft mb-1">
              Role
            </label>
            <select
              id={`${idPrefix}new-member-role-select`}
              data-add-member-role
              value={pickRole(role)}
              onChange={(e) => handleRoleChange(e.target.value)}
              className="w-full py-2 px-3 font-medium focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
            >
              {roles.map((r) => <option key={r} value={r}>{ADD_MEMBER_ROLE_LABEL[r]}</option>)}
            </select>
          </div>
        </div>

        {/* K1: optional phone, so a kiosk code can be sent straight to them */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-4">
            <label htmlFor={`${idPrefix}new-member-phone-input`} className="block font-semibold text-ink-soft mb-1">
              Phone (optional)
            </label>
            <div className="relative">
              <Phone className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id={`${idPrefix}new-member-phone-input`}
                type="tel"
                placeholder="For sending the kiosk code"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="w-full pl-8 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>
        </div>

        {/* Permission checkboxes for the new user */}
        <div className={`pt-2 border-t border-line flex flex-col sm:flex-row items-start sm:items-center ${showPermissions ? 'justify-between' : 'justify-end'} gap-3`}>
          {showPermissions && (
          <div className="flex items-center gap-5">
            <span className="font-semibold text-ink-soft">
              Permissions:
            </span>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={canFill}
                onChange={(e) => setCanFill(e.target.checked)}
                className="w-4 h-4 accent-gold rounded border-line-control cursor-pointer"
              />
              <span className="text-ink-soft">
                Can Fill Up Tasks & Notes
              </span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={canAssign}
                onChange={(e) => setCanAssign(e.target.checked)}
                className="w-4 h-4 accent-gold rounded border-line-control cursor-pointer"
              />
              <span className="text-ink-soft">
                Can Assign / Add New Tasks
              </span>
            </label>
          </div>
          )}

          <button
            id={`${idPrefix}add-member-submit-btn`}
            type="submit"
            disabled={isSubmitting}
            className="pressable py-2 px-4 rounded-xl hover:brightness-105 disabled:opacity-50 font-bold flex items-center justify-center gap-1.5 e1 cursor-pointer shrink-0 bg-gold-deep text-paper"
          >
            <UserPlus className="w-4 h-4" />
            <span>{isSubmitting ? 'Creating link…' : 'Create invite link'}</span>
          </button>
          {onCancel && (
            <button type="button" data-add-member-cancel disabled={isSubmitting} onClick={onCancel}
              className="pressable py-2 px-4 rounded-xl border border-line-control bg-surface text-ink font-semibold cursor-pointer shrink-0 disabled:opacity-50">
              Cancel
            </button>
          )}
        </div>
      </form>
      )}
    </div>
  );
}
