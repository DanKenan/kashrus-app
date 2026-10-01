import React, { useState } from 'react';
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
} from 'lucide-react';
import { User as UserType, UserRole, Task, Venue, UserPermissions } from '../types';
import { getRoleLabel, canUserAssignTasks, canUserFillTasks, DEFAULT_ROLE_PERMISSIONS } from '../lib/permissions';
import { ConfirmModal } from './ConfirmModal';

interface TeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: UserType[];
  tasks: Task[];
  currentUser: UserType | null;
  currentVenue?: Venue | null;
  onAddUser: (user: { 
    name: string; 
    email: string; 
    role: UserRole; 
    password?: string; 
    venueId?: string;
    permissions?: UserPermissions;
  }) => Promise<void>;
  onUpdateUser?: (userId: string, updates: { 
    role?: UserRole; 
    permissions?: UserPermissions;
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
  onAddUser,
  onUpdateUser,
  onDeleteUser,
}) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('mashgiach');
  const [canFill, setCanFill] = useState<boolean>(true);
  const [canAssign, setCanAssign] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<UserType | null>(null);
  const [actionAlert, setActionAlert] = useState<string | null>(null);

  if (!isOpen) return null;

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
    if (!name.trim() || !email.trim() || !password.trim()) {
      setError('Please provide name, email, and an initial password.');
      return;
    }

    if (password.trim().length < 6) {
      setError('Initial password must be at least 6 characters.');
      return;
    }

    const emailClean = email.trim().toLowerCase();
    if (users.some((u) => u.email.toLowerCase() === emailClean)) {
      setError('A team member with this email already exists.');
      return;
    }

    try {
      setIsSubmitting(true);
      await onAddUser({
        name: name.trim(),
        email: emailClean,
        role,
        password: password.trim(),
        venueId: currentVenue?.id,
        permissions: {
          canFillTasks: canFill,
          canAssignTasks: canAssign,
        },
      });
      setName('');
      setEmail('');
      setPassword('');
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

    const defaults = DEFAULT_ROLE_PERMISSIONS[newRole] || { canFillTasks: true, canAssignTasks: false };
    const newPermissions: UserPermissions = {
      ...user.permissions,
      canFillTasks: user.permissions?.canFillTasks !== undefined ? user.permissions.canFillTasks : defaults.canFillTasks,
      canAssignTasks: user.permissions?.canAssignTasks !== undefined ? user.permissions.canAssignTasks : defaults.canAssignTasks,
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

  const filteredUsers = users.filter((u) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const roleLabel = getRoleLabel(u.role).toLowerCase();
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.includes(q) || roleLabel.includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-surface rounded-2xl w-full max-w-4xl tactile-4 border border-line my-8 overflow-hidden flex flex-col max-h-[90vh] animate-slide-up">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gold-wash text-gold-deep">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink flex items-center gap-2">
                <span>Mashgiach Team & Access Permissions</span>
                {currentVenue && (
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-gold-wash text-gold-ink border border-gold/40 font-semibold flex items-center gap-1">
                    <Building2 className="w-3 h-3" />
                    {currentVenue.name}
                  </span>
                )}
                <span className="text-xs px-2 py-0.5 rounded-full bg-sunken text-ink-soft font-semibold">
                  {users.length} members
                </span>
              </h2>
              <p className="text-xs text-ink-soft">
                Manage Mashgichim, Coordinators, and Venue Owners. Toggle permissions to fill tasks and/or assign new tasks.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-faint hover:text-ink cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Section 1: Add New Member Form */}
          <div className="p-4 rounded-2xl bg-sunken border border-line tactile-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-faint mb-3 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5 text-emerald-500" />
              Add New Team Member
            </h3>

            {error && (
              <div className="mb-3 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleAddSubmit} className="space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-3">
                  <label className="block font-semibold text-ink-soft mb-1">
                    Full Name
                  </label>
                  <div className="relative">
                    <User className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-name-input"
                      type="text"
                      required
                      placeholder="e.g. Rabbi David Cohen"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-line bg-sunken text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                    />
                  </div>
                </div>

                <div className="sm:col-span-3">
                  <label className="block font-semibold text-ink-soft mb-1">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-email-input"
                      type="email"
                      required
                      placeholder="e.g. dcohen@hartfordkashrut.org"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-line bg-sunken text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                    />
                  </div>
                </div>

                <div className="sm:col-span-3">
                  <label className="block font-semibold text-ink-soft mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="new-member-password-input"
                      type="password"
                      required
                      placeholder="Min 6 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-line bg-sunken text-ink placeholder-ink-faint font-mono text-xs focus:border-gold focus:outline-none"
                    />
                  </div>
                </div>

                <div className="sm:col-span-3">
                  <label className="block font-semibold text-ink-soft mb-1">
                    Role
                  </label>
                  <select
                    id="new-member-role-select"
                    value={role}
                    onChange={(e) => handleRoleChange(e.target.value as UserRole)}
                    className="w-full py-2 px-3 rounded-xl border border-line bg-sunken text-ink font-medium focus:border-gold focus:outline-none"
                  >
                    <option value="mashgiach">Mashgiach (Field Inspector)</option>
                    <option value="coordinator">Coordinator (Can Add Tasks)</option>
                    <option value="owner">Restaurant / Venue Owner</option>
                    <option value="admin">Administrator (Full Control)</option>
                  </select>
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
                      className="w-4 h-4 accent-gold rounded border-line cursor-pointer"
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
                      className="w-4 h-4 accent-gold rounded border-line cursor-pointer"
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
                  className="pressable py-2 px-4 rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 disabled:opacity-50 text-white font-bold flex items-center justify-center gap-1.5 tactile-1 cursor-pointer shrink-0"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{isSubmitting ? 'Adding...' : 'Add Team Member'}</span>
                </button>
              </div>
            </form>
          </div>

          {/* Section 2: Team Roster List with Inline Permission Toggles */}
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-ink-faint">
                  Active Team Roster & Permissions ({filteredUsers.length})
                </h3>
                <p className="text-[11px] text-ink-soft">
                  Admins can toggle task filling and task assignment permissions directly for any Mashgiach or Owner.
                </p>
              </div>
              <input
                type="text"
                placeholder="Search by name, email, or role..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="text-xs px-3 py-1.5 rounded-xl border border-line bg-sunken text-ink max-w-xs focus:border-gold focus:outline-none"
              />
            </div>

            <div className="divide-y divide-line border border-line rounded-2xl overflow-hidden bg-surface">
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

                return (
                  <div
                    key={user.id}
                    className={`p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-surface tactile-1 lift hover:bg-sunken/50 transition ${
                      isBusy ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {/* User Info & Role Dropdown */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white tactile-1 ring-2 ring-gold/30 shrink-0"
                        style={{ backgroundColor: user.avatarColor || '#3b82f6' }}
                      >
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-xs font-bold text-ink truncate">
                            {user.name}
                          </p>
                          {isCurrent && (
                            <span className="text-[10px] px-2 py-0.2 rounded-md bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-bold">
                              You
                            </span>
                          )}

                          {/* Role Selector / Badge */}
                          {onUpdateUser && !isPrimaryAdmin ? (
                            <select
                              value={user.role}
                              onChange={(e) => handleChangeUserRole(user, e.target.value as UserRole)}
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-lg uppercase tracking-wider cursor-pointer border ${
                                user.role === 'admin'
                                  ? 'bg-gold-wash text-gold-ink border-gold/40'
                                  : user.role === 'coordinator'
                                  ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-300'
                                  : user.role === 'owner'
                                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-300'
                                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300'
                              }`}
                            >
                              <option value="mashgiach">Mashgiach</option>
                              <option value="coordinator">Coordinator</option>
                              <option value="owner">Owner</option>
                              <option value="admin">Admin</option>
                            </select>
                          ) : (
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider ${
                                user.role === 'admin'
                                  ? 'bg-gold-wash text-gold-ink'
                                  : user.role === 'coordinator'
                                  ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                                  : user.role === 'owner'
                                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300'
                                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                              }`}
                            >
                              {getRoleLabel(user.role)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-soft truncate">
                          {user.email}
                        </p>
                      </div>
                    </div>

                    {/* Permissions Toggles for Fill & Assign */}
                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      {/* Can Fill Tasks Toggle */}
                      <button
                        type="button"
                        onClick={() => handleTogglePermission(user, 'canFillTasks', canFillVal)}
                        disabled={!onUpdateUser || isPrimaryAdmin}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                          canFillVal
                            ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                            : 'bg-sunken border-line text-ink-faint line-through'
                        } ${(!onUpdateUser || isPrimaryAdmin) ? 'cursor-default opacity-80' : 'hover:scale-[1.02]'}`}
                        title="Permission to complete checklist items and save notes"
                      >
                        <CheckSquare className={`w-3.5 h-3.5 ${canFillVal ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-faint'}`} />
                        <span>Fill Tasks: {canFillVal ? 'Allowed' : 'Disabled'}</span>
                      </button>

                      {/* Can Assign / Add Tasks Toggle */}
                      <button
                        type="button"
                        onClick={() => handleTogglePermission(user, 'canAssignTasks', canAssignVal)}
                        disabled={!onUpdateUser || isPrimaryAdmin}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                          canAssignVal
                            ? 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-300 dark:border-indigo-800 text-indigo-800 dark:text-indigo-200'
                            : 'bg-sunken border-line text-ink-faint line-through'
                        } ${(!onUpdateUser || isPrimaryAdmin) ? 'cursor-default opacity-80' : 'hover:scale-[1.02]'}`}
                        title="Permission to create new assignments and edit task definitions"
                      >
                        <PlusCircle className={`w-3.5 h-3.5 ${canAssignVal ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink-faint'}`} />
                        <span>Assign Tasks: {canAssignVal ? 'Allowed' : 'Disabled'}</span>
                      </button>

                      <span className="text-xs text-ink-faint tnum hidden xl:inline" title="Tasks assigned to this user">
                        {assignedCount} tasks
                      </span>

                      {/* Delete Member Button */}
                      {!isPrimaryAdmin && (
                        <button
                          onClick={() => handleDelete(user)}
                          className="p-1.5 rounded-lg text-ink-faint hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer"
                          title={`Delete ${user.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken flex items-center justify-between shrink-0">
          <p className="text-xs text-ink-soft">
            Changes to roles and permissions apply immediately across all live connected sessions.
          </p>
          <button
            onClick={onClose}
            className="pressable px-4 py-1.5 text-xs font-semibold rounded-xl border border-line bg-sunken hover:bg-gold-wash/60 text-ink cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>

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
