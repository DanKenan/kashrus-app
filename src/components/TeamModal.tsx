import React, { useEffect, useState } from 'react';
import { 
  X, 
  Users, 
  UserPlus, 
  Trash2, 
  User, 
  Mail, 
  AlertTriangle, 
  Lock, 
  Building2, 
  CheckSquare, 
  PlusCircle,
  KeyRound,
  Phone,
  CheckCircle2,
} from 'lucide-react';
import { User as UserType, UserRole, Task, Venue, UserPermissions } from '../types';
import { getRoleLabel, canUserAssignTasks, canUserFillTasks, DEFAULT_ROLE_PERMISSIONS } from '../lib/permissions';
import { ConfirmModal } from './ConfirmModal';
import { KioskCodeDialog } from './KioskCodeDialog';
import { VenueAccessSheet } from './VenueAccessSheet';
import { normalizePhone } from '../lib/kioskCodeShare';
import { InviteLinkCard } from './InviteLinkCard';
import { enableInvites, sendMemberInvite, loadMemberForInvite, inviteChip, SEND_CHANGED_TEXT } from '../lib/inviteActions';
import type { InviteFlag } from '../lib/invites';

/** Item 10i: what Add member returns when the agency's Phase C is ON (the server made an invite, not a user). */
export interface AddMemberInvite {
  link: string;
  name: string;
  email: string;
}

interface TeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: UserType[];
  tasks: Task[];
  currentUser: UserType | null;
  currentVenue?: Venue | null;
  venues: Venue[];
  onAddUser: (user: { 
    name: string; 
    email: string; 
    role: UserRole; 
    password?: string; 
    venueId?: string;
    permissions?: UserPermissions;
    phoneNumber?: string;
  }) => Promise<void | AddMemberInvite>;
  /** Item 10i: true when the server reports Phase C ON for this agency — the form adds by invite link (no password). */
  inviteMode?: boolean;
  /** INVITES CLIENT: the raw flag (true ON, false OFF, null not known). "Turn on invites" shows only on false. */
  inviteFlag?: InviteFlag;
  agencyName?: string;
  /** INVITES CLIENT: ask the flag again (after turning invites on, or a 404 from Send invite). */
  onInviteFlagStale?: () => void;
  onUpdateUser?: (userId: string, updates: { 
    role?: UserRole; 
    permissions?: UserPermissions;
    kioskPin?: string;
    phoneNumber?: string;
  }) => Promise<void>;
  onDeleteUser: (userId: string) => Promise<void>;
}

export const TeamModal: React.FC<TeamModalProps> = ({
  isOpen,
  onClose,
  users,
  tasks,
  currentUser,
  currentVenue,
  venues,
  onAddUser,
  inviteMode = false,
  inviteFlag = null,
  agencyName,
  onInviteFlagStale,
  onUpdateUser,
  onDeleteUser,
}) => {
  const [venueTarget, setVenueTarget] = useState<(UserType & { venueIds: string[] }) | null>(null);
  const [venueNotice, setVenueNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPhone, setNewPhone] = useState('');
  // K1: whose kiosk-code sheet is open (looked up fresh from `users`).
  const [codeTargetId, setCodeTargetId] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole>('mashgiach');
  const [canFill, setCanFill] = useState<boolean>(true);
  const [canAssign, setCanAssign] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<UserType | null>(null);
  // QA2 #23: a role change waits for a confirm (one mis-tap must not make someone an Administrator).
  const [roleChange, setRoleChange] = useState<{ user: UserType; newRole: UserRole } | null>(null);
  // Coordinator view: read-only team list; the ONLY control is the kiosk
  // code (+ optional phone) sheet on mashgiach/worker rows (Don's decision
  // 8:50 PM ET Oct 19; phone added in K1, Oct 20).
  const isCoordinatorView = currentUser?.role === 'coordinator';
  const [actionAlert, setActionAlert] = useState<string | null>(null);
  // Item 10i: the invite link just made (shown once, never stored).
  const [inviteResult, setInviteResult] = useState<{ link: string; forWhom: string } | null>(null);
  // INVITES CLIENT C2: "Turn on invites" (admin, flag OFF only).
  const [enableConfirm, setEnableConfirm] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  // INVITES CLIENT C3: Send invite for one member (confirm first; the link is shown once).
  // B1 ([INVC-DS3]): the record the admin reviews and the version of the response it came from.
  const [sendReview, setSendReview] = useState<{ user: UserType; version: number; changed: boolean } | null>(null);
  const sendTarget = sendReview?.user || null;
  // The row whose fresh record is loading (Send invite tap, or a refresh after a version conflict).
  const [sendLoadingId, setSendLoadingId] = useState<string | null>(null);
  const [sendBusyId, setSendBusyId] = useState<string | null>(null);
  const [sentLink, setSentLink] = useState<{ userId: string; link: string; firstName: string } | null>(null);
  const [sentIds, setSentIds] = useState<string[]>([]);
  const [sendError, setSendError] = useState<{ userId: string; message: string; retry?: boolean } | null>(null);
  useEffect(() => {
    if (!isOpen) {
      setInviteResult(null);
      setEnableConfirm(false);
      setEnableError(null);
      setSendReview(null);
      setSentLink(null);
      setSendError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isAdminView = currentUser?.role === 'admin';
  const firstName = (n: string) => (n || '').trim().split(/\s+/)[0] || n;

  const confirmEnableInvites = async () => {
    if (enableBusy) return;
    setEnableBusy(true);
    setEnableError(null);
    const r = await enableInvites();
    setEnableBusy(false);
    setEnableConfirm(false);
    if (r.ok) {
      setInviteNotice('Invites are on. New people get a link and choose their own password.');
      onInviteFlagStale?.();
    } else {
      setEnableError(r.message || "Couldn't turn on invites. Please try again.");
    }
  };

  /** Load the person's fresh record and its version, then open (or re-open) the confirm. */
  const openSendReview = async (userId: string, changed: boolean) => {
    setSendLoadingId(userId);
    const r = await loadMemberForInvite(userId);
    setSendLoadingId(null);
    if (!r.ok || !r.user || r.version === undefined) {
      setSendReview(null);
      // A load that failed can be retried; a person who is gone cannot.
      setSendError({ userId, message: r.message || "Couldn't load their details. Please try again.", retry: !r.gone });
      return;
    }
    setSendReview({ user: r.user, version: r.version, changed });
  };

  const startSendInvite = (user: UserType) => {
    if (sendBusyId || sendLoadingId) return;
    setSendError(null);
    setSentLink(null);
    void openSendReview(user.id, false);
  };

  const confirmSendInvite = async () => {
    const review = sendReview;
    if (!review || sendBusyId || sendLoadingId) return;
    const target = review.user;
    setSendBusyId(target.id);
    setSendError(null);
    const r = await sendMemberInvite(target.id, review.version);
    setSendBusyId(null);
    if (r.conflict) {
      // Keep the admin's intent: nothing is sent until the fresh record and its version are back
      // and the admin confirms again. A failed refresh closes the sheet with a retry in the row.
      setSendReview(null);
      await openSendReview(target.id, true);
      return;
    }
    setSendReview(null);
    if (r.ok) {
      setSentLink({ userId: target.id, link: r.link || '', firstName: firstName(target.name) });
      setSentIds((prev) => (prev.includes(target.id) ? prev : [...prev, target.id]));
    } else {
      setSendError({ userId: target.id, message: r.message || "Couldn't make the invite. Please try again." });
      if (r.flagOff) onInviteFlagStale?.();
    }
  };

  // When role changes in the creation form, sync default permissions
  const handleRoleChange = (newRole: UserRole) => {
    setRole(newRole);
    const defaults = DEFAULT_ROLE_PERMISSIONS[newRole] || { canFillTasks: true, canAssignTasks: false };
    setCanFill(defaults.canFillTasks ?? false);
    setCanAssign(defaults.canAssignTasks ?? false);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (inviteMode) {
      if (!name.trim() || !email.trim()) {
        setError('Please provide a name and an email.');
        return;
      }
    } else {
    if (!name.trim() || !email.trim() || !password.trim()) {
      setError('Please provide name, email, and an initial password.');
      return;
    }

    if (password.trim().length < 6) {
      setError('Initial password must be at least 6 characters.');
      return;
    }
    }

    const phoneClean = normalizePhone(newPhone);
    if (phoneClean === null) {
      setError("That phone number doesn't look right. Use digits, with + and the country code outside the US.");
      return;
    }

    const emailClean = email.trim().toLowerCase();
    if (users.some((u) => (u.email?.toLowerCase() || '') === emailClean)) {
      setError('A team member with this email already exists.');
      return;
    }

    try {
      setIsSubmitting(true);
      const added = await onAddUser({
        name: name.trim(),
        email: emailClean,
        role: inviteMode && role !== 'coordinator' ? 'mashgiach' : role,
        ...(inviteMode ? {} : { password: password.trim() }),
        venueId: currentVenue?.id,
        permissions: {
          canFillTasks: canFill,
          canAssignTasks: canAssign,
        },
        ...(phoneClean ? { phoneNumber: phoneClean } : {}),
      });
      if (added && typeof added.link === 'string') {
        setInviteResult({ link: added.link, forWhom: `${added.name} (${added.email})` });
      }
      setName('');
      setEmail('');
      setPassword('');
      setNewPhone('');
      setRole('mashgiach');
      setCanFill(true);
      setCanAssign(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to add team member.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTogglePermission = async (user: UserType, perm: 'canFillTasks' | 'canAssignTasks', currentVal: boolean) => {
    if (!onUpdateUser) return;
    const isPrimaryAdmin = user.email.toLowerCase() === 'kenan@hartfordkashrut.org';
    if (isPrimaryAdmin && !currentVal) {
      // Primary admin always retains all permissions
      return;
    }

    const newPermissions: UserPermissions = {
      canFillTasks: canUserFillTasks(user),
      canAssignTasks: canUserAssignTasks(user),
      ...user.permissions,
      [perm]: !currentVal,
    };

    try {
      setUpdatingUserId(user.id);
      await onUpdateUser(user.id, { permissions: newPermissions });
    } catch (err: any) {
      alert(err?.message || 'Failed to update permission');
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleChangeUserRole = async (user: UserType, newRole: UserRole) => {
    if (!onUpdateUser) return;
    const isPrimaryAdmin = user.email.toLowerCase() === 'kenan@hartfordkashrut.org';
    if (isPrimaryAdmin && newRole !== 'admin') {
      alert('The primary administrator account role cannot be changed.');
      return;
    }

    if (newRole === user.role) return;
    setRoleChange({ user, newRole });
  };

  const applyRoleChange = async (user: UserType, newRole: UserRole) => {
    if (!onUpdateUser) return;
    // QA2 #23: a new role starts from that role's own permissions (a coordinator can add tasks),
    // so the chips match what the role can really do. They can still be switched afterwards.
    const defaults = DEFAULT_ROLE_PERMISSIONS[newRole] || { canFillTasks: true, canAssignTasks: false };
    const newPermissions: UserPermissions = {
      ...user.permissions,
      canFillTasks: defaults.canFillTasks,
      canAssignTasks: defaults.canAssignTasks,
    };

    try {
      setUpdatingUserId(user.id);
      await onUpdateUser(user.id, { role: newRole, permissions: newPermissions });
    } catch (err: any) {
      setActionAlert(err?.message || 'Failed to change role');
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleDelete = (user: UserType) => {
    if (currentUser && user.email.toLowerCase() === currentUser.email.toLowerCase()) {
      setActionAlert('You cannot delete your own active administrator account.');
      return;
    }
    if (user.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
      setActionAlert('The primary administrator account cannot be removed.');
      return;
    }
    setUserToDelete(user);
  };

  // K1: explicit kiosk-code actions (no save-on-blur). Errors are thrown
  // back to the sheet, which shows them; success shows the code ONCE.
  const saveKioskCode = async (user: UserType, code: string) => {
    if (!onUpdateUser) throw new Error('Not allowed.');
    await onUpdateUser(user.id, { kioskPin: code });
  };
  const removeKioskCode = async (user: UserType) => {
    if (!onUpdateUser) throw new Error('Not allowed.');
    await onUpdateUser(user.id, { kioskPin: '' });
    setActionAlert(`Kiosk code removed for ${user.name}.`);
  };
  const saveKioskPhone = async (user: UserType, phone: string) => {
    if (!onUpdateUser) throw new Error('Not allowed.');
    await onUpdateUser(user.id, { phoneNumber: phone });
  };
  const codeTarget = codeTargetId ? users.find((u) => u.id === codeTargetId) || null : null;

  // Coordinator view: own venue only (same agencyId AND venueId as the
  // coordinator; a venue-less coordinator sees an empty list).
  const venueScopedUsers = isCoordinatorView
    ? users.filter(
        (u) =>
          (u.agencyId || 'agency-hkc') === (currentUser?.agencyId || 'agency-hkc') &&
          !!currentUser?.venueId &&
          (u as any).venueId === currentUser?.venueId
      )
    : users;

  const filteredUsers = venueScopedUsers.filter((u) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const roleLabel = getRoleLabel(u.role).toLowerCase();
    return u.name.toLowerCase().includes(q) || (u.email?.toLowerCase() || '').includes(q) || u.role.includes(q) || roleLabel.includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm overflow-y-auto">
      <div className="bg-surface rounded-2xl w-full max-w-4xl e3 border border-line my-8 overflow-hidden flex flex-col max-h-[90vh] animate-slide-up">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="hidden sm:flex p-2 rounded-xl bg-gold-wash text-gold-ink shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-ink flex flex-wrap items-center gap-2">
                <span className="basis-full sm:basis-auto min-w-0">Mashgiach Team & Access Permissions</span>
                {/* QA2 #22: the list is the whole agency, not one venue: say so (no venue chip). */}
                <span className="text-xs px-2 py-0.5 rounded-full bg-sunken text-ink-soft font-semibold shrink-0">
                  All team · {users.length}
                </span>
              </h2>
              <p className="text-sm text-ink-soft">
                Manage Mashgichim, Coordinators, and Venue Owners. Toggle permissions to fill tasks and/or assign new tasks.
              </p>
            </div>
          </div>
          <button aria-label="Close"
            onClick={onClose}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {isAdminView && inviteNotice && (
            <p role="status" data-invites-on-notice className="p-3 rounded-xl bg-ok-bg border border-ok text-sm text-ink">{inviteNotice}</p>
          )}

          {/* INVITES CLIENT C2: invite links are OFF for this agency (admin only; never on "not known"). */}
          {isAdminView && inviteFlag === false && (
            <div data-invites-off className="p-4 rounded-2xl bg-surface border border-line-control e1 space-y-3">
              <p className="text-sm font-bold text-ink">Invite links are off</p>
              <p className="text-sm text-ink-soft">
                Today you set a first password for each new person. With invites on, you send them a link instead and they choose their own password.
              </p>
              {enableError && (
                <p role="alert" data-invites-error className="p-2.5 rounded-xl bg-bad-bg border border-bad text-sm text-bad">{enableError}</p>
              )}
              <button
                type="button"
                data-invites-turn-on
                disabled={enableBusy}
                onClick={() => { setEnableError(null); setEnableConfirm(true); }}
                className="pressable min-h-11 px-4 rounded-xl font-bold text-sm bg-gold-deep text-paper e1 cursor-pointer disabled:opacity-50"
              >
                Turn on invites
              </button>
            </div>
          )}

          {/* Section 1: Add New Member Form (admin only) */}
          {!isCoordinatorView && (
          <div className="p-4 rounded-2xl bg-sunken border border-line e1">
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
                onDone={() => setInviteResult(null)}
                doneLabel="Add another person"
              />
            ) : (
            <form onSubmit={handleAddSubmit} className="space-y-3 text-xs">
              {inviteMode && (
                <p data-invite-mode-note className="text-sm text-ink-soft">
                  No password needed. You'll get a link to send them, and they choose their own password.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className={inviteMode ? 'sm:col-span-4' : 'sm:col-span-3'}>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Full Name
                  </label>
                  <div className="relative">
                    <User className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-name-input"
                      type="text"
                      required
                      placeholder="Full name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>
                </div>

                <div className={inviteMode ? 'sm:col-span-4' : 'sm:col-span-3'}>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-email-input"
                      type="email"
                      required
                      placeholder="e.g. dcohen@hartfordkashrut.org"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>
                </div>

                {!inviteMode && (
                <div className={inviteMode ? 'sm:col-span-4' : 'sm:col-span-3'}>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-password-input"
                      type="password"
                      required
                      placeholder="Min 6 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 placeholder-ink-faint font-mono focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>
                </div>
                )}

                <div className={inviteMode ? 'sm:col-span-4' : 'sm:col-span-3'}>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Role
                  </label>
                  <select
                    id="new-member-role-select"
                    value={inviteMode && role !== 'coordinator' ? 'mashgiach' : role}
                    onChange={(e) => handleRoleChange(e.target.value as UserRole)}
                    className="w-full py-2 px-3 font-medium focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  >
                    <option value="mashgiach">Mashgiach (Field Inspector)</option>
                    <option value="coordinator">Coordinator (Can Add Tasks)</option>
                    {!inviteMode && <option value="owner">Restaurant / Venue Owner</option>}
                    {!inviteMode && <option value="admin">Administrator (Full Control)</option>}
                  </select>
                </div>
              </div>

              {/* K1: optional phone, so a kiosk code can be sent straight to them */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-4">
                  <label htmlFor="new-member-phone-input" className="block font-semibold text-ink-soft mb-1">
                    Phone (optional)
                  </label>
                  <div className="relative">
                    <Phone className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-phone-input"
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
              <div className="pt-2 border-t border-line flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
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

                <button
                  id="add-member-submit-btn"
                  type="submit"
                  disabled={isSubmitting}
                  className="pressable py-2 px-4 rounded-xl hover:brightness-105 disabled:opacity-50 font-bold flex items-center justify-center gap-1.5 e1 cursor-pointer shrink-0 bg-gold-deep text-paper"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{inviteMode ? (isSubmitting ? 'Creating link…' : 'Create invite link') : (isSubmitting ? 'Adding...' : 'Add Team Member')}</span>
                </button>
              </div>
            </form>
            )}
          </div>

          )} {/* end admin-only Add Member form */}

          {/* Section 2: Team Roster List with Inline Permission Toggles */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft">
                  Active Team Roster & Permissions ({filteredUsers.length})
                </h3>
                <p className="text-sm text-ink-soft">
                  Admins can toggle task filling and task assignment permissions directly for any Mashgiach or Owner.
                </p>
              </div>
              <input
                type="text"
                placeholder="Search by name, email, or role..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="px-3 py-1.5 max-w-xs focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>

            {venueNotice && <p role="status" className="mb-3 text-sm text-ink-soft">{venueNotice}</p>}
            <div className="divide-y divide-line border border-line rounded-2xl overflow-hidden bg-surface">
              {searchQuery && filteredUsers.length === 0 && (
                <div data-empty-state className="p-6 text-center text-ink-soft">
                  <Users className="w-8 h-8 mx-auto mb-2" />
                  <p className="text-sm font-semibold">No team members match your search.</p>
                  <p className="text-sm mt-2">Try a different name, email or role.</p>
                </div>
              )}
              {filteredUsers.map((user) => {
                const isCurrent = currentUser?.id === user.id;
                const isPrimaryAdmin = user.email.toLowerCase() === 'kenan@hartfordkashrut.org';
                const canFillVal = canUserFillTasks(user);
                const canAssignVal = canUserAssignTasks(user);
                const isBusy = updatingUserId === user.id;
                
                // Count tasks assigned specifically to this user
                const assignedCount = tasks.filter(
                  (t) => t.assignedTo.includes('all') || t.assignedTo.includes(user.email)
                ).length;

                const canSendInvite = isAdminView && inviteFlag === true && !isCurrent && !isPrimaryAdmin;
                const wasSent = sentIds.includes(user.id) || user.invitePending === true;
                return (
                  <div key={user.id} data-member-row>
                  <div
                    className={`p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-surface e1 lift hover:bg-sunken/50 transition ${
                      isBusy ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {/* User Info & Role Dropdown */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-paper e1 ring-2 ring-gold/30 shrink-0"
                        style={{ backgroundColor: user.avatarColor || 'var(--gold-deep)' }}
                      >
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-bold text-ink truncate">
                            {user.name}
                          </p>
                          {isCurrent && (
                            <span className="text-xs px-2 py-0.2 rounded-md bg-sunken text-ink-soft font-semibold border border-line">
                              You
                            </span>
                          )}
                          {isAdminView && (() => {
                            const chip = sentIds.includes(user.id) ? 'Invite sent' : inviteChip(user);
                            return chip ? (
                              <span data-invite-chip className={`text-xs px-2 py-0.5 rounded-md font-semibold border ${chip === 'Invite sent' ? 'bg-ok-bg text-ok border-ok/40' : 'bg-warn-bg text-warn border-warn/40'}`}>
                                {chip}
                              </span>
                            ) : null;
                          })()}

                          {/* Role Selector / Badge (coordinators: badge only) */}
                          {onUpdateUser && !isPrimaryAdmin && !isCoordinatorView ? (
                            <select
                              value={user.role}
                              onChange={(e) => handleChangeUserRole(user, e.target.value as UserRole)}
                              className={`text-base font-semibold px-2 py-0.5 rounded-lg uppercase tracking-wider cursor-pointer border border-line-control min-w-0 focus:ring-2 focus:ring-gold/40 focus:border-gold ${
                                user.role === 'admin'
                                  ? 'bg-gold-wash text-gold-ink'
                                  : 'bg-sunken text-ink-soft'
                              }`}
                            >
                              <option value="mashgiach">Mashgiach</option>
                              <option value="coordinator">Coordinator</option>
                              <option value="owner">Owner</option>
                              <option value="admin">Admin</option>
                            </select>
                          ) : (
                            <span
                              className={`text-xs px-2 py-0.5 rounded-md font-semibold uppercase tracking-wider border border-line ${
                                user.role === 'admin'
                                  ? 'bg-gold-wash text-gold-ink'
                                  : 'bg-sunken text-ink-soft'
                              }`}
                            >
                              {getRoleLabel(user.role)}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-ink-soft truncate">
                          {user.email}
                        </p>
                        {user.phoneNumber && (
                          <p className="text-sm text-ink-soft truncate inline-flex items-center gap-1 tnum">
                            <Phone className="w-3 h-3" />
                            {user.phoneNumber}
                          </p>
                        )}
                      </div>
                    </div>

                    {currentUser?.role === 'admin' && user.role !== 'admin' && Array.isArray(user.venueIds) && (
                      <button type="button"
                        onClick={() => {
                          setVenueNotice(null);
                          setVenueTarget({ ...user, venueIds: [...user.venueIds!] });
                        }}
                        className="min-h-11 min-w-0 px-3 py-2 rounded-xl bg-surface border border-line-control text-base text-ink hover:bg-sunken pressable cursor-pointer break-words">
                        {/* QA2 #22: a person with no venue left is flagged, not shown "Venues:" blank. */}
                        {venues.some((venue) => user.venueIds!.includes(venue.id))
                          ? <>Venues: {venues.find((venue) => venue.id === user.venueId)?.name || venues.find((venue) => user.venueIds!.includes(venue.id))?.name}</>
                          : <span style={{ color: 'var(--bad)' }} className="font-semibold">No venue — tap to set</span>}
                        {user.venueIds.filter((id) => id !== user.venueId && venues.some((venue) => venue.id === id)).length > 0 &&
                          ` +${user.venueIds.filter((id) => id !== user.venueId && venues.some((venue) => venue.id === id)).length}`}
                      </button>
                    )}

                    {/* Permissions Toggles for Fill & Assign */}
                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      {/* Can Fill Tasks Toggle (admin only) */}
                      {!isCoordinatorView && (
                      <>
                      <button
                        type="button"
                        onClick={() => handleTogglePermission(user, 'canFillTasks', canFillVal)}
                        disabled={!onUpdateUser || isPrimaryAdmin}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                          canFillVal
                            ? 'bg-ok-bg border-ok text-ok'
                            : 'bg-sunken border-line text-ink-soft line-through'
                        } ${(!onUpdateUser || isPrimaryAdmin) ? 'cursor-default opacity-80' : 'hover:scale-[1.02]'}`}
                        title="Permission to complete checklist items and save notes"
                      >
                        <CheckSquare className={`w-3.5 h-3.5 ${canFillVal ? 'text-ok ' : 'text-ink-soft'}`} />
                        <span>Fill Tasks: {canFillVal ? 'Allowed' : 'Disabled'}</span>
                      </button>

                      {/* Can Assign / Add Tasks Toggle */}
                      <button
                        type="button"
                        onClick={() => handleTogglePermission(user, 'canAssignTasks', canAssignVal)}
                        disabled={!onUpdateUser || isPrimaryAdmin}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                          canAssignVal
                            ? 'bg-gold-wash border-gold/40 text-gold-ink'
                            : 'bg-sunken border-line text-ink-soft line-through'
                        } ${(!onUpdateUser || isPrimaryAdmin) ? 'cursor-default opacity-80' : 'hover:scale-[1.02]'}`}
                        title="Permission to create new assignments and edit task definitions"
                      >
                        <PlusCircle className={`w-3.5 h-3.5 ${canAssignVal ? 'text-gold-deep' : 'text-ink-soft'}`} />
                        <span>Assign Tasks: {canAssignVal ? 'Allowed' : 'Disabled'}</span>
                      </button>

                      </>
                      )} {/* end admin-only permission toggles */}

                      <span className="text-xs text-ink-soft tnum hidden xl:inline" title="Tasks assigned to this user">
                        {assignedCount} tasks
                      </span>

                      {/* K1: kiosk code — explicit Set / Reset (no save-on-blur) and a
                          "Code set ✓" marker from the server's hasKioskPin boolean.
                          Admin view: every mashgiach/worker/coordinator/admin row (an
                          admin's kiosk session is mashgiach-only on the server).
                          Coordinator view: mashgiach/worker rows only. */}
                      {onUpdateUser && (
                        isCoordinatorView
                          ? ['mashgiach', 'worker'].includes(user.role)
                          : ['mashgiach', 'worker', 'coordinator', 'admin'].includes(user.role)
                      ) && (
                        <span className="inline-flex items-center gap-1.5">
                          {user.hasKioskPin && (
                            <span
                              data-testid="kiosk-code-set"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-xl text-xs font-semibold bg-ok-bg border border-ok/40 text-ok"
                              title="This person has a kiosk code. It can't be read back; Reset makes a new one."
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Code set
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setCodeTargetId(user.id)}
                            data-testid={user.hasKioskPin ? 'kiosk-code-reset' : 'kiosk-code-set-btn'}
                            className="pressable inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
                          >
                            <KeyRound className="w-3.5 h-3.5 text-gold-deep" />
                            {user.hasKioskPin ? 'Reset code' : 'Set code'}
                          </button>
                        </span>
                      )}

                      {/* INVITES CLIENT C3: Send invite (confirm first) */}
                      {canSendInvite && (
                        <button
                          type="button"
                          data-send-invite
                          disabled={sendBusyId !== null || sendLoadingId !== null}
                          onClick={() => startSendInvite(user)}
                          className="pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl text-xs font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken disabled:opacity-50"
                        >
                          <Mail className="w-3.5 h-3.5 text-gold-deep" aria-hidden="true" />
                          {sendBusyId === user.id ? 'Making link…' : sendLoadingId === user.id ? 'Loading…' : (sendError && sendError.userId === user.id && sendError.retry) ? 'Try again' : wasSent ? 'Send new invite' : 'Send invite'}
                        </button>
                      )}

                      {/* Delete Member Button (admin only) */}
                      {!isPrimaryAdmin && !isCoordinatorView && (
                        <button
                          onClick={() => handleDelete(user)}
                          className="p-1.5 rounded-lg transition cursor-pointer bg-surface border border-line-control text-bad hover:bg-sunken"
                          title={`Delete ${user.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {sentLink && sentLink.userId === user.id && (
                    <div className="px-4 pb-4">
                      <InviteLinkCard
                        link={sentLink.link}
                        forWhom={`${user.name} (${user.email})`}
                        hint={`Send this link to ${sentLink.firstName}.`}
                        onDone={() => setSentLink(null)}
                        doneLabel="Done"
                      />
                    </div>
                  )}
                  {sendError && sendError.userId === user.id && (
                    <p role="alert" data-send-invite-error className="mx-4 mb-4 p-2.5 rounded-xl bg-bad-bg border border-bad text-sm text-bad">{sendError.message}</p>
                  )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken flex items-center justify-between shrink-0">
          <p className="text-sm text-ink-soft">
            Changes to roles and permissions apply immediately across all live connected sessions.
          </p>
          <button
            onClick={onClose}
            className="pressable px-4 py-1.5 text-xs font-semibold rounded-xl cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
          >
            Close
          </button>
        </div>
      </div>

      {venueTarget && currentUser?.role === 'admin' && (
        <VenueAccessSheet record={venueTarget} venues={venues}
          onClose={() => setVenueTarget(null)}
          onSaved={() => { setVenueNotice('Venues updated'); setVenueTarget(null); }} />
      )}

      {/* K1: kiosk code sheet (set / reset / remove, phone, one-time display) */}
      <KioskCodeDialog
        isOpen={Boolean(codeTarget)}
        personName={codeTarget?.name || ''}
        hasCode={Boolean(codeTarget?.hasKioskPin)}
        phoneNumber={codeTarget?.phoneNumber}
        canEditPhone={Boolean(onUpdateUser)}
        onClose={() => setCodeTargetId(null)}
        onSaveCode={(code) => (codeTarget ? saveKioskCode(codeTarget, code) : Promise.reject(new Error('Not found.')))}
        onRemoveCode={() => (codeTarget ? removeKioskCode(codeTarget) : Promise.reject(new Error('Not found.')))}
        onSavePhone={(phone) => (codeTarget ? saveKioskPhone(codeTarget, phone) : Promise.reject(new Error('Not found.')))}
      />

      {/* Delete User Confirm Modal */}
      <ConfirmModal
        isOpen={Boolean(userToDelete)}
        onClose={() => setUserToDelete(null)}
        onConfirm={async () => {
          if (!userToDelete) return;
          const u = userToDelete;
          setUserToDelete(null);
          try {
            await onDeleteUser(u.id);
          } catch (err: any) {
            setActionAlert(err?.message || 'Failed to remove member.');
          }
        }}
        title={`Remove ${userToDelete?.name}?`}
        message={`Are you sure you want to remove ${userToDelete?.name} (${userToDelete?.email}) from the team roster?`}
        confirmText="Remove Member"
        cancelText="Cancel"
        variant="danger"
        icon="trash"
      />

      {/* QA2 #23: confirm a role change */}
      <ConfirmModal
        isOpen={Boolean(roleChange)}
        onClose={() => setRoleChange(null)}
        onConfirm={() => {
          const rc = roleChange;
          setRoleChange(null);
          if (rc) void applyRoleChange(rc.user, rc.newRole);
        }}
        title={roleChange ? `Make ${roleChange.user.name} ${roleChange.newRole === 'admin' ? 'an Administrator' : `a ${getRoleLabel(roleChange.newRole).replace(/\s*\(.*\)\s*$/, '')}`}?` : ''}
        message={roleChange?.newRole === 'admin'
          ? 'Administrators can see and change everything in your agency: every venue, the team, and the settings.'
          : 'Their role changes right away, and their permissions reset to what this role can do.'}
        confirmText="Change role"
        cancelText="Cancel"
        variant={roleChange?.newRole === 'admin' ? 'danger' : 'warning'}
        icon="shield"
      />

      {/* INVITES CLIENT C2: confirm before turning invites on (one-way). */}
      <ConfirmModal
        isOpen={enableConfirm}
        onClose={() => { if (!enableBusy) setEnableConfirm(false); }}
        onConfirm={confirmEnableInvites}
        title={agencyName ? `Turn on invites for ${agencyName}?` : 'Turn on invites?'}
        message="New people get a link and choose their own password, and you won't set passwords for them anymore. Invites stay on: this can't be turned off from the app."
        confirmText="Turn on"
        cancelText="Not now"
        variant="primary"
        icon="shield"
        isLoading={enableBusy}
      />

      {/* INVITES CLIENT C3: confirm before Send invite (it revokes the current password). */}
      <ConfirmModal
        isOpen={Boolean(sendTarget)}
        onClose={() => { if (!sendBusyId) setSendReview(null); }}
        onConfirm={confirmSendInvite}
        title={`Send ${sendTarget?.name || ''} an invite link?`}
        message={`${sendReview?.changed ? `${SEND_CHANGED_TEXT} ` : ''}${sendTarget ? `${sendTarget.name} (${sendTarget.email}). ` : ''}Their current password stops working right away, and they're signed out on their phones. They choose a new password from the link, which works once, for 7 days. Their kiosk code keeps working.${sendTarget && (sentIds.includes(sendTarget.id) || sendTarget.invitePending === true) ? ' The earlier link stops working.' : ''}`}
        confirmText="Send invite"
        cancelText="Cancel"
        variant="warning"
        icon="alert"
        isLoading={sendBusyId !== null || sendLoadingId !== null}
      />

      {/* Alert Notice Modal */}
      <ConfirmModal
        isOpen={Boolean(actionAlert)}
        onClose={() => setActionAlert(null)}
        onConfirm={() => setActionAlert(null)}
        title="Notice"
        message={actionAlert || ''}
        confirmText="Got It"
        cancelText="Close"
        variant="warning"
        icon="alert"
      />
    </div>
  );
};
