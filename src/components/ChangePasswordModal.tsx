import React, { useState } from 'react';
import { X, CheckCircle2, AlertCircle, KeyRound, Eye, EyeOff } from 'lucide-react';
import { User as UserType } from '../types';
import { apiFetch, WRONG_CURRENT_PASSWORD_TEXT } from '../lib/api';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserType | null;
  onSuccessToast?: (msg: string) => void;
}

export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onSuccessToast,
}) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen || !currentUser) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('Please fill in all password fields.');
      return;
    }

    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters long.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match. Please verify.');
      return;
    }

    try {
      setIsLoading(true);
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: currentUser.email,
          currentPassword,
          newPassword,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // QA2 Q2: a wrong current password keeps the person signed in.
        if (res.status === 401 && (data.code === 'CURRENT_PASSWORD_WRONG' || data.error === WRONG_CURRENT_PASSWORD_TEXT)) {
          throw new Error('Current password is wrong. Please try again.');
        }
        throw new Error(data.error || 'Failed to update password.');
      }

      setSuccess(true);
      if (onSuccessToast) {
        onSuccessToast('Password changed successfully.');
      }
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Error updating password.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface rounded-2xl w-full max-w-md e3 border border-line overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sunken text-ink-soft">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-ink">Change Password</h2>
              <p className="text-xs text-ink-soft">
                Update credentials for {currentUser.name}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {success ? (
            <div className="py-6 text-center space-y-2">
              <div className="w-12 h-12 rounded-full bg-ok-bg text-ok mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-ink">Password Updated</h3>
              <p className="text-xs text-ink-soft">
                Your password has been changed successfully.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 rounded-2xl bg-bad-bg border border-bad text-bad text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-ink-soft mb-1">
                  Current Password
                </label>
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  className="w-full px-3 py-2 text-base rounded-xl bg-sunken border border-line-control text-ink focus:outline-none focus:border-gold transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-ink-soft mb-1">
                  New Password (min 6 characters)
                </label>
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  className="w-full px-3 py-2 text-base rounded-xl bg-sunken border border-line-control text-ink focus:outline-none focus:border-gold transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-ink-soft mb-1">
                  Confirm New Password
                </label>
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full px-3 py-2 text-base rounded-xl bg-sunken border border-line-control text-ink focus:outline-none focus:border-gold transition-colors"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="text-xs font-semibold flex items-center gap-1 bg-surface border border-line-control text-ink hover:bg-sunken"
                >
                  {showPass ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>{showPass ? 'Hide passwords' : 'Show passwords'}</span>
                </button>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-semibold rounded-xl pressable cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 text-xs font-bold rounded-xl pressable bg-gold-deep text-paper tactile-1 cursor-pointer disabled:opacity-50"
                >
                  {isLoading ? 'Updating...' : 'Save New Password'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
