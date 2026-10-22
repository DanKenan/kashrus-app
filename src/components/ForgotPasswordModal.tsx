import React, { useState } from 'react';
import { X, Mail, KeyRound, Lock, AlertTriangle } from 'lucide-react';

interface ForgotPasswordModalProps {
  onClose: () => void;
  onSuccess: (user: any, token: string) => void;
}

export function ForgotPasswordModal({ onClose, onSuccess }: ForgotPasswordModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const requestCode = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await res.json();
      if (res.ok) {
        setStep(2);
      } else {
        setError(d.error || 'Something went wrong.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/verify-reset-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const d = await res.json();
      if (res.ok && d.resetToken) {
        setResetToken(d.resetToken);
        setStep(3);
      } else {
        setError(d.error || 'Invalid code.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const setPassword = async () => {
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), resetToken, newPassword }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        onSuccess(d.user, d.token);
        onClose();
      } else {
        setError(d.error || 'Something went wrong.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm p-4">
      <div className="bg-surface border border-line e3 rounded-2xl max-w-sm w-full">
        <div className="p-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-ink-soft" />
            Reset Password
          </h2>
          <button onClick={onClose} className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {step === 1 && (
            <>
              <p className="text-xs text-ink-soft">
                Enter your email. Your agency admin will see that you asked and can send you a reset link.
              </p>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-3 py-2.5 text-base rounded-xl border border-line-control bg-sunken"
                  onKeyDown={(e) => e.key === 'Enter' && requestCode()}
                />
              </div>
              <button
                onClick={requestCode}
                disabled={!email.trim() || busy}
                className="w-full py-2.5 rounded-xl bg-gold-deep text-paper text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Sending...' : 'Send Reset Code'}
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs text-ink-soft">
                Enter the 6-digit code your admin gave you. It expires in 15 minutes.
              </p>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                className="w-full px-3 py-2.5 text-center text-2xl font-bold tracking-[0.3em] rounded-xl border border-line-control bg-sunken"
                onKeyDown={(e) => e.key === 'Enter' && verifyCode()}
              />
              <button
                onClick={verifyCode}
                disabled={code.length !== 6 || busy}
                className="w-full py-2.5 rounded-xl bg-gold-deep text-paper text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Verifying...' : 'Verify Code'}
              </button>
              <button
                onClick={() => setStep(1)}
                className="w-full min-h-11 rounded-xl text-center text-sm font-semibold transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
              >
                ← Back
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-xs text-ink-soft">
                Code verified. Set your new password.
              </p>
              <p className="text-xs text-ink-soft" data-testid="reset-signout-note">
                Setting a new password signs you out on your other devices.
              </p>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 characters)"
                  className="w-full pl-10 pr-3 py-2.5 text-base rounded-xl border border-line-control bg-sunken"
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full pl-10 pr-3 py-2.5 text-base rounded-xl border border-line-control bg-sunken"
                  onKeyDown={(e) => e.key === 'Enter' && setPassword()}
                />
              </div>
              <button
                onClick={setPassword}
                disabled={busy}
                className="w-full py-2.5 rounded-xl bg-gold-deep text-paper text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Setting...' : 'Set New Password'}
              </button>
            </>
          )}

          {error && (
            <div className="p-2.5 rounded-xl bg-bad-bg border border-bad text-bad text-xs font-semibold flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
