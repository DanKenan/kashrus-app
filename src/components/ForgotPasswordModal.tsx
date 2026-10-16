import React, { useState } from 'react';
import { X, Mail, KeyRound, Lock } from 'lucide-react';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-sm w-full">
        <div className="p-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-bold flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-gold-deep" />
            Reset Password
          </h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-sunken transition cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {step === 1 && (
            <>
              <p className="text-xs text-ink-faint">
                Enter your email. Your agency admin will receive a reset code and pass it to you.
              </p>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-3 py-2.5 text-sm rounded-xl border border-line bg-sunken"
                  onKeyDown={(e) => e.key === 'Enter' && requestCode()}
                />
              </div>
              <button
                onClick={requestCode}
                disabled={!email.trim() || busy}
                className="w-full py-2.5 rounded-xl bg-gold text-white text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Sending...' : 'Send Reset Code'}
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs text-ink-faint">
                Enter the 6-digit code your admin gave you. It expires in 15 minutes.
              </p>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                className="w-full px-3 py-2.5 text-center text-2xl font-black tracking-[0.3em] rounded-xl border border-line bg-sunken"
                onKeyDown={(e) => e.key === 'Enter' && verifyCode()}
              />
              <button
                onClick={verifyCode}
                disabled={code.length !== 6 || busy}
                className="w-full py-2.5 rounded-xl bg-gold text-white text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Verifying...' : 'Verify Code'}
              </button>
              <button
                onClick={() => setStep(1)}
                className="w-full text-center text-xs text-ink-faint hover:text-ink transition cursor-pointer"
              >
                ← Back
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-xs text-ink-faint">
                Code verified. Set your new password.
              </p>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 characters)"
                  className="w-full pl-10 pr-3 py-2.5 text-sm rounded-xl border border-line bg-sunken"
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full pl-10 pr-3 py-2.5 text-sm rounded-xl border border-line bg-sunken"
                  onKeyDown={(e) => e.key === 'Enter' && setPassword()}
                />
              </div>
              <button
                onClick={setPassword}
                disabled={busy}
                className="w-full py-2.5 rounded-xl bg-gold text-white text-sm font-bold disabled:opacity-50 transition cursor-pointer"
              >
                {busy ? 'Setting...' : 'Set New Password'}
              </button>
            </>
          )}

          {error && (
            <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 text-xs font-semibold">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
