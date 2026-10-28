import React, { useEffect, useState } from 'react';
import { 
  X, 
  Users, 
  Trash2, 
  Mail, 
  Building2, 
  CheckSquare, 
  PlusCircle,
  KeyRound,
  Phone,
  CheckCircle2,
} from 'lucide-react';
import { User as UserType, UserRole, Task, Venue, UserPermissions } from '../types';
import { getRoleLabel, canUserAssignTasks, canUserFillTasks, DEFAULT_ROLE_PERMISSIONS, STAFF_ADD_ROLES, staffMayAddMemberAt } from '../lib/permissions';
import { AddMemberForm, ADMIN_ADD_ROLES, STAFF_ADD_NOTE } from './AddMemberForm';
import { ConfirmModal } from './ConfirmModal';
import { KioskCodeDialog } from './KioskCodeDialog';
import { VenueAccessSheet } from './VenueAccessSheet';
import { PoolPanel, PoolMoveDialog, usePool } from './PoolPanel';
import { POOL_TEXT, isFromPool, poolCount, poolOnlyIds } from '../lib/pool';
import { END_DATE_TEXT, rosterUntilLines } from '../lib/venueEndDates';
import { InviteLinkCard } from './InviteLinkCard';
import { sendMemberInvite, loadMemberForInvite, inviteChip, SEND_CHANGED_TEXT } from '../lib/inviteActions';
import { canMakeResetLink, makeResetLink, loadResetRequests, confirmPausedMember, type ResetRequest } from '../lib/resetLinks';
import { isMyTask } from '../lib/myTasks';

/** Roles the admin's role picker knows (worker shows as Mashgiach). An unknown role gets the plain badge, never a picker (fail closed). */
const TEAM_ROLE_CHOICES: string[] = ['mashgiach', 'worker', 'coordinator', 'manager', 'owner', 'admin'];

/** Item 10i: what Add member returns (now defined with the shared add form). */
export type { AddMemberInvite } from './AddMemberForm';
import type { AddMemberInvite } from './AddMemberForm';

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
  agencyName?: string;
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
  agencyName,
  onUpdateUser,
  onDeleteUser,
}) => {
  const [venueTarget, setVenueTarget] = useState<(UserType & { venueIds: string[] }) | null>(null);
  const [venueNotice, setVenueNotice] = useState<string | null>(null);
  // K1: whose kiosk-code sheet is open (looked up fresh from `users`).
  const [codeTargetId, setCodeTargetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<UserType | null>(null);
  // QA2 #23: a role change waits for a confirm (one mis-tap must not make someone an Administrator).
  const [roleChange, setRoleChange] = useState<{ user: UserType; newRole: UserRole } | null>(null);
  // Coordinator view: read-only team list; the ONLY control is the kiosk
  // code (+ optional phone) sheet on mashgiach/worker rows (Don's decision
  // 8:50 PM ET Oct 19; phone added in K1, Oct 20).
  const isCoordinatorView = currentUser?.role === 'coordinator';
  // Team adds (Don 2026-10-27 11:30 PM): a coordinator adds a Mashgiach or Manager
  // at the venue they are on, only when it is one of their own venues.
  const coordinatorAddVenue = isCoordinatorView && currentVenue && staffMayAddMemberAt(currentUser, currentVenue.id) ? currentVenue : null;
  const [actionAlert, setActionAlert] = useState<string | null>(null);
  // Item 10i: the invite link just made (shown once, never stored).
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
  // 10L: reset-password links (admin; coordinator for people at their venues). Making one changes
  // nothing on the person's account, so there is no confirm; the link is shown once.
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ userId: string; link: string; firstName: string } | null>(null);
  const [resetError, setResetError] = useState<{ userId: string; message: string } | null>(null);
  const [resetRequests, setResetRequests] = useState<ResetRequest[]>([]);
  // 10L: an admin confirms a membership paused by another agency's reset link.
  const [confirmTarget, setConfirmTarget] = useState<UserType | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<{ userId: string; message: string } | null>(null);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const mayAskResetRequests = !!currentUser && (currentUser.role === 'admin' || currentUser.role === 'coordinator');
  useEffect(() => {
    if (!isOpen || !mayAskResetRequests) { setResetRequests([]); return; }
    let active = true;
    void loadResetRequests().then((list) => { if (active) setResetRequests(list); });
    return () => { active = false; };
  }, [isOpen, mayAskResetRequests, currentUser?.id]);
  // 12b-c: the Pool tab (admins and coordinators; owners open the Pool from their menu).
  const showPoolTab = currentUser?.role === 'admin' || currentUser?.role === 'coordinator';
  const [tab, setTab] = useState<'team' | 'pool'>('team');
  const [moveTarget, setMoveTarget] = useState<UserType | null>(null);
  const pool = usePool(isOpen && showPoolTab, currentUser?.role !== 'admin', users);
  useEffect(() => {
    if (!isOpen) {
      setTab('team');
      setMoveTarget(null);
      setSendReview(null);
      setSentLink(null);
      setSendError(null);
      setResetLink(null);
      setResetError(null);
      setConfirmTarget(null);
      setConfirmError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isAdminView = currentUser?.role === 'admin';
  const firstName = (n: string) => (n || '').trim().split(/\s+/)[0] || n;

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
    }
  };

  /** 10L: make a reset-password link for one person (shown once in their row). */
  const startResetLink = async (user: UserType) => {
    if (resetBusyId) return;
    setResetBusyId(user.id);
    setResetError(null);
    setResetLink(null);
    const r = await makeResetLink(user.id);
    setResetBusyId(null);
    if (r.ok && r.link) {
      setResetLink({ userId: user.id, link: r.link, firstName: firstName(user.name) });
      setResetRequests((prev) => prev.map((q) => (q.memberId === user.id ? { ...q, linkLive: true } : q)));
    } else {
      setResetError({ userId: user.id, message: r.message || "Couldn't make the reset link. Please try again." });
    }
  };

  const confirmPaused = async () => {
    const target = confirmTarget;
    if (!target || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    const r = await confirmPausedMember(target.id);
    setConfirmBusy(false);
    setConfirmTarget(null);
    if (r.ok) setConfirmedIds((prev) => (prev.includes(target.id) ? prev : [...prev, target.id]));
    else setConfirmError({ userId: target.id, message: r.message || "Couldn't confirm. Please try again." });
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
    : (() => {
        // 12b-c: Pool members with no venue right now live in the Pool tab (admin view).
        const poolOnly = currentUser?.role === 'admin' ? poolOnlyIds(pool.data) : new Set<string>();
        return poolOnly.size ? users.filter((u) => !poolOnly.has(u.id)) : users;
      })();

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
          {showPoolTab && (
            <div role="tablist" aria-label="Team or Pool" className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-sunken border border-line">
              {(['team', 'pool'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} data-team-tab={t}
                  onClick={() => setTab(t)}
                  className={`min-h-11 rounded-lg text-base font-semibold cursor-pointer pressable ${tab === t ? 'bg-surface text-ink e1 border border-line' : 'text-ink-soft'}`}>
                  {t === 'team' ? POOL_TEXT.teamTab : POOL_TEXT.poolTab(poolCount(pool.data))}
                </button>
              ))}
            </div>
          )}
          {showPoolTab && tab === 'pool' && venueNotice && <p role="status" data-venue-notice className="text-sm text-ink-soft">{venueNotice}</p>}
          {/* Section 1: Add New Member Form. Admin: every role it may add, with rights.
              Coordinator (Don 2026-10-27 11:30 PM): Mashgiach or Manager at the
              venue they are on, if it is in their scope; the admins are notified.
              Kept mounted (hidden) while the Pool tab shows, so a shown invite link
              or an add still in flight survives a tab switch (review RV1 P2). */}
          <div data-add-member-slot className={showPoolTab && tab === 'pool' ? 'hidden' : undefined} hidden={showPoolTab && tab === 'pool'}>
            {!isCoordinatorView ? (
              <AddMemberForm roles={ADMIN_ADD_ROLES} showPermissions venueId={currentVenue?.id}
                existingEmails={users.map((u) => u.email || '')} onAddUser={onAddUser} />
            ) : coordinatorAddVenue ? (
              <AddMemberForm roles={STAFF_ADD_ROLES} showPermissions={false} venueId={coordinatorAddVenue.id}
                venueNote={STAFF_ADD_NOTE(coordinatorAddVenue.name)}
                existingEmails={users.map((u) => u.email || '')} onAddUser={onAddUser} />
            ) : null}
          </div>
          {showPoolTab && tab === 'pool' && currentUser ? (
            <PoolPanel currentUser={currentUser} venues={venues} pool={pool}
              onAdminTick={currentUser.role === 'admin' ? (m) => {
                // The roster row when this person is in it, else the Pool's own admin view of them
                // (no main venue: the sheet shows no locked main row).
                const u = users.find((x) => x.id === m.id);
                const record = u && Array.isArray(u.venueIds)
                  ? { ...u, venueIds: [...u.venueIds] }
                  : { id: m.id, name: m.name, email: m.email || '', role: m.role, venueId: '', venueIds: [...(m.venueIds || [])], ...(m.venueUntil ? { venueUntil: m.venueUntil } : {}), ...(Number.isInteger(m.venueRevision) ? { venueRevision: m.venueRevision } : {}) } as unknown as UserType & { venueIds: string[] };
                setVenueNotice(null); setVenueTarget(record);
              } : undefined}
              onCode={currentUser.role === 'admin' && onUpdateUser ? (id) => setCodeTargetId(id) : undefined} />
          ) : (<>



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
            {/* 10L: people who asked for a password reset in the last 24 hours (Forgot password). */}
            {(() => {
              const asked = resetRequests.filter((q) => venueScopedUsers.some((u) => u.id === q.memberId));
              if (asked.length === 0) return null;
              return (
                <div data-reset-requests className="mb-3 p-3 rounded-2xl bg-warn-bg border border-warn/40 space-y-2">
                  <p className="text-sm font-bold text-ink">Asked for a password reset</p>
                  <p className="text-sm text-ink-soft">Make a reset link in their row below and send it to them.</p>
                  <ul className="space-y-1">
                    {asked.map((q) => {
                      const u = venueScopedUsers.find((x) => x.id === q.memberId);
                      const when = new Date(q.requestedAt);
                      const whenText = Number.isFinite(when.getTime()) ? when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
                      return (
                        <li key={q.memberId} data-reset-request className="text-sm text-ink break-words">
                          <span className="font-semibold">{u?.name || q.name}</span>
                          {whenText ? <span className="text-ink-soft"> · {whenText}</span> : null}
                          {q.linkLive ? <span className="text-ink-soft"> · link made</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })()}
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
                
                // Tasks that count as this user's own (an admin's: only those naming them)
                const assignedCount = tasks.filter((t) => isMyTask(t, user)).length;

                const canSendInvite = isAdminView && !isCurrent && !isPrimaryAdmin;
                const wasSent = sentIds.includes(user.id) || user.invitePending === true;
                const canResetLink = canMakeResetLink(currentUser as any, { ...(user as any), isPrimaryAdmin }) && user.needsInvite !== true && user.invitePending !== true;
                const isPaused = (user as any).resetConfirmNeeded === true && !confirmedIds.includes(user.id);
                const askedReset = resetRequests.some((q) => q.memberId === user.id);
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
                          {isAdminView && isFromPool(user, pool.data) && (
                            <span data-from-pool className="text-xs px-2 py-0.5 rounded-md bg-gold-wash text-gold-ink font-semibold border border-gold/30">
                              {POOL_TEXT.fromPool}
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
                          {isPaused && (
                            <span data-reset-paused className="text-xs px-2 py-0.5 rounded-md font-semibold border bg-warn-bg text-warn border-warn/40">
                              Paused
                            </span>
                          )}
                          {askedReset && !isPaused && (
                            <span data-reset-asked className="text-xs px-2 py-0.5 rounded-md font-semibold border bg-warn-bg text-warn border-warn/40">
                              Asked for reset
                            </span>
                          )}

                          {/* Role Selector / Badge (coordinators: badge only) */}
                          {onUpdateUser && !isPrimaryAdmin && !isCoordinatorView && TEAM_ROLE_CHOICES.includes(user.role) ? (
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
                              <option value="manager">Manager</option>
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
                        {/* 12a-c: dated extra venues read "Hill Deli until Sun" (only when the server sends dates). */}
                        {(() => {
                          const dated = rosterUntilLines(user, venues, currentUser?.agencyTimeZone);
                          if (dated.length === 0) return null;
                          return (
                            <span data-roster-until className="block text-sm text-ink-soft">
                              {dated.slice(0, 3).map((line) => <span key={line.venueId} className="block break-words">{line.text}</span>)}
                              {dated.length > 3 && <span className="block">{END_DATE_TEXT.moreVenues(dated.length - 3)}</span>}
                            </span>
                          );
                        })()}
                      </button>
                    )}
                    {/* 12b-c: admin moves a mashgiach / worker to the Pool (open work shown first). */}
                    {currentUser?.role === 'admin' && (user.role === 'mashgiach' || user.role === 'worker') && !isCurrent
                      && Array.isArray(user.venueIds) && user.venueIds.length > 0 && Number.isInteger(user.venueRevision) && (
                      <button type="button" data-move-to-pool
                        onClick={() => setMoveTarget(user)}
                        className="min-h-11 px-3 py-2 rounded-xl bg-surface border border-line-control text-sm text-ink hover:bg-sunken pressable cursor-pointer">
                        {POOL_TEXT.moveToPool}
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

                      {/* 10L: reset-password link (no confirm: it changes nothing until the person uses it) */}
                      {canResetLink && (
                        <button
                          type="button"
                          data-reset-link
                          disabled={resetBusyId !== null}
                          onClick={() => startResetLink(user)}
                          className="pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl text-xs font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken disabled:opacity-50"
                        >
                          <KeyRound className="w-3.5 h-3.5 text-gold-deep" aria-hidden="true" />
                          {resetBusyId === user.id ? 'Making link…' : 'Reset password link'}
                        </button>
                      )}
                      {/* 10L: confirm a membership paused after another agency's reset (admin only) */}
                      {isPaused && isAdminView && (
                        <button
                          type="button"
                          data-reset-confirm
                          disabled={confirmBusy}
                          onClick={() => { setConfirmError(null); setConfirmTarget(user); }}
                          className="pressable min-h-11 inline-flex items-center gap-1.5 px-3 rounded-xl text-xs font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-ok" aria-hidden="true" />
                          Confirm
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
                  {isPaused && (
                    <p data-reset-paused-note className="mx-4 mb-4 text-sm text-ink-soft">
                      {firstName(user.name)} used a reset link from another agency, so access here is paused.{isAdminView ? ' Check it was really them, then tap Confirm.' : ' An admin needs to confirm it.'}
                    </p>
                  )}
                  {resetLink && resetLink.userId === user.id && (
                    <div className="px-4 pb-4">
                      <InviteLinkCard
                        title="Reset link ready"
                        link={resetLink.link}
                        forWhom={`${user.name} (${user.email})`}
                        hint={`Send this link to ${resetLink.firstName}.`}
                        note="They open it and choose a new password. Until then, nothing changes."
                        expiryText="The link works once, for 24 hours."
                        onDone={() => setResetLink(null)}
                        doneLabel="Done"
                      />
                    </div>
                  )}
                  {resetError && resetError.userId === user.id && (
                    <p role="alert" data-reset-link-error className="mx-4 mb-4 p-2.5 rounded-xl bg-bad-bg border border-bad text-sm text-bad">{resetError.message}</p>
                  )}
                  {confirmError && confirmError.userId === user.id && (
                    <p role="alert" data-reset-confirm-error className="mx-4 mb-4 p-2.5 rounded-xl bg-bad-bg border border-bad text-sm text-bad">{confirmError.message}</p>
                  )}
                  {sendError && sendError.userId === user.id && (
                    <p role="alert" data-send-invite-error className="mx-4 mb-4 p-2.5 rounded-xl bg-bad-bg border border-bad text-sm text-bad">{sendError.message}</p>
                  )}
                  </div>
                );
              })}
            </div>
          </div>
          </>)}

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
          agencyTimeZone={currentUser?.agencyTimeZone}
          latest={(() => { const u = users.find((x) => x.id === venueTarget.id); return u && Array.isArray(u.venueIds) ? { ...u, venueIds: [...u.venueIds] } : null; })()}
          onClose={() => setVenueTarget(null)}
          onSaved={() => { setVenueNotice('Venues updated'); setVenueTarget(null); void pool.reload(); }} />
      )}

      {moveTarget && currentUser?.role === 'admin' && (
        <PoolMoveDialog mode="move" person={moveTarget} venues={venues}
          onClose={() => setMoveTarget(null)}
          onDone={(msg) => { setVenueNotice(msg); setMoveTarget(null); void pool.reload(); }} />
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

      {/* 10L: confirm a membership paused after another agency's reset link. */}
      <ConfirmModal
        isOpen={Boolean(confirmTarget)}
        onClose={() => { if (!confirmBusy) setConfirmTarget(null); }}
        onConfirm={confirmPaused}
        title={`Confirm ${confirmTarget?.name || ''}?`}
        message={`${confirmTarget ? `${confirmTarget.name} (${confirmTarget.email}) ` : 'This person '}changed their password with a reset link from another agency. Check with them that it was really them. After you confirm, they can use this agency again.`}
        confirmText="Confirm"
        cancelText="Cancel"
        variant="warning"
        icon="alert"
        isLoading={confirmBusy}
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
