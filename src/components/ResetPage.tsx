import React, { useEffect, useState } from 'react';
import { AlertCircle, KeyRound, Lock, Moon, Sun } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import { User as UserType } from '../types';
import { setSessionToken } from '../lib/api';
import { acceptResetLink, previewResetLink } from '../lib/resetLinks';

// 10L client: the reset page (/reset#t=…), server contract = PR #118.
// The person chooses a new password. Calls are plain fetch with the token in
// the X-Reset-Token header and no session header; the token never goes into a
// URL query. On success the server ends every older session of the person and
// signs them in here.

type View =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'form' }
  | { kind: 'changed'; message: string };

export const RESET_INVALID_TITLE = 'This reset link is not valid anymore.';
const INVALID_HELP = 'It may have been used already, or it expired (links last 24 hours). Ask your agency admin for a new link.';

interface ResetPageProps {
  token: string | null;
  onLoginSuccess: (user: UserType) => void;
  /** Leave the reset page for the normal sign-in screen. */
  onLeave: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export const ResetPage: React.FC<ResetPageProps> = ({ token, onLoginSuccess, onLeave, darkMode, onToggleDarkMode }) => {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [who, setWho] = useState<{ firstName: string; agencyName: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!token) { setView({ kind: 'invalid' }); return; }
    setView({ kind: 'loading' });
    void previewResetLink(token).then((p) => {
      if (!active) return;
      if (p.state === 'invalid') { setView({ kind: 'invalid' }); return; }
      if (p.state === 'error') { setView({ kind: 'unavailable', message: p.message }); return; }
      setWho({ firstName: p.firstName, agencyName: p.agencyName });
      setView({ kind: 'form' });
    });
    return () => { active = false; };
  }, [token, loadKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !token) return;
    setError(null);
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    const r = await acceptResetLink(token, password);
    setBusy(false);
    if (r.state === 'ok') {
      setPassword('');
      setConfirm('');
      setSessionToken(r.token);
      onLoginSuccess(r.user as UserType);
      return;
    }
    if (r.state === 'invalid') { setView({ kind: 'invalid' }); return; }
    if (r.state === 'changed-no-session') { setPassword(''); setConfirm(''); setView({ kind: 'changed', message: r.message }); return; }
    setError(r.message);
  };

  const errorBox = error && (
    <div role="alert" className="p-3 rounded-2xl bg-bad-bg border border-bad text-sm text-bad flex items-start gap-2">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );
  const inputClass = 'w-full pl-10 pr-3 py-2.5 rounded-xl bg-sunken border border-line text-base text-ink placeholder-ink-faint focus:outline-none focus:border-gold';
  const primaryClass = 'w-full min-h-11 py-3 px-4 rounded-xl pressable bg-gold-deep text-paper e1 text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer';
  const secondaryClass = 'w-full min-h-11 py-3 px-4 rounded-xl bg-surface border border-line text-ink text-sm font-bold flex items-center justify-center gap-2 hover:bg-sunken cursor-pointer';

  const passwordField = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div>
      <label htmlFor={id} className="block text-sm font-bold text-ink-soft mb-1.5">{label}</label>
      <div className="relative">
        <Lock className="w-4 h-4 text-ink-faint absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input id={id} type="password" value={value} onChange={(e) => set(e.target.value)} autoComplete="new-password" className={inputClass} />
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (view.kind === 'loading') {
    body = <p role="status" className="text-center text-sm text-ink-soft py-6">Opening your reset link…</p>;
  } else if (view.kind === 'invalid') {
    body = (
      <div data-reset-state="invalid" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">{RESET_INVALID_TITLE}</h1>
        <p className="text-sm text-ink-soft">{INVALID_HELP}</p>
        <button type="button" onClick={onLeave} className={secondaryClass}>Go to sign in</button>
      </div>
    );
  } else if (view.kind === 'unavailable') {
    body = (
      <div data-reset-state="unavailable" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">Couldn't open the reset link</h1>
        <p className="text-sm text-ink-soft">{view.message}</p>
        <button type="button" onClick={() => setLoadKey((k) => k + 1)} className={primaryClass}>Try again</button>
      </div>
    );
  } else if (view.kind === 'changed') {
    body = (
      <div data-reset-state="changed" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">Password changed</h1>
        <p className="text-sm text-ink">{view.message}</p>
        <button type="button" onClick={onLeave} className={secondaryClass}>Go to sign in</button>
      </div>
    );
  } else {
    body = (
      <form data-reset-state="form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="text-center">
          <p className="text-sm font-semibold text-ink-soft">{who?.agencyName || 'Shutfey'}</p>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-ink break-words">
            {who?.firstName ? `Choose a new password, ${who.firstName}` : 'Choose a new password'}
          </h1>
        </div>
        <p className="text-sm text-ink-soft">After this, your other phones are signed out. You'll stay signed in here.</p>
        {errorBox}
        {passwordField('reset-new-password', 'New password (at least 8 characters)', password, setPassword)}
        {passwordField('reset-new-confirm', 'Type it again', confirm, setConfirm)}
        <button type="submit" disabled={busy} className={primaryClass}>
          <KeyRound className="w-4 h-4" aria-hidden="true" />
          <span>{busy ? 'Saving…' : 'Save new password'}</span>
        </button>
      </form>
    );
  }

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <header className="w-full px-4 sm:px-6 py-4 flex items-center justify-between max-w-7xl mx-auto">
        <ShutfeyLogo size="sm" showSubtitle={true} />
        <button
          type="button"
          onClick={onToggleDarkMode}
          className="w-11 h-11 inline-flex items-center justify-center rounded-xl bg-surface border border-line text-ink-soft hover:text-ink cursor-pointer"
          aria-label="Toggle dark mode"
        >
          {darkMode ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
        </button>
      </header>
      <main className="flex-1 flex items-start sm:items-center justify-center px-4 py-6">
        <div data-reset-page className="w-full max-w-md bg-surface rounded-3xl p-6 sm:p-8 e3 border border-line">
          {body}
        </div>
      </main>
    </div>
  );
};
