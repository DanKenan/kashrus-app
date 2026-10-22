import React, { useEffect, useState } from 'react';
import { AlertCircle, Building2, KeyRound, Lock, LogIn, Moon, Sun, UserPlus } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import { User as UserType } from '../types';
import { setSessionToken } from '../lib/api';
import { getRoleLabel } from '../lib/permissions';

// Item 10i: the invite page (/invite#t=…), server contract = PR #108.
// One screen, two ways in. The page never tells the link holder whether the
// email already has a Shutfey account (design v3): the person picks.
// Calls are plain fetch with no session header, so a signed-in browser's
// session is never sent with the invite and never cleared by its answers.

type Preview = { agencyName: string; role: string; name: string };
type Membership = { membershipId: string; agencyId: string; agencyName: string; role: string };
type View =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'choose' }
  | { kind: 'new' }
  | { kind: 'existing' }
  | { kind: 'not-linkable'; message: string }
  | { kind: 'memberships'; token: string; memberships: Membership[] };

export const INVITE_INVALID_TITLE = 'This invite link is not valid anymore.';
const INVALID_HELP = 'It may have been used already, or it expired. Ask the person who sent it for a new link.';
const GENERIC_ERROR = 'Something went wrong. Please try again.';
const NETWORK_ERROR = "Couldn't reach Shutfey. Check your connection and try again.";

interface InvitePageProps {
  token: string | null;
  onLoginSuccess: (user: UserType) => void;
  /** Leave the invite page for the normal sign-in screen. */
  onLeave: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return {}; }
}

export const InvitePage: React.FC<InvitePageProps> = ({ token, onLoginSuccess, onLeave, darkMode, onToggleDarkMode }) => {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!token) { setView({ kind: 'invalid' }); return; }
    setView({ kind: 'loading' });
    (async () => {
      try {
        const res = await fetch('/api/invites/preview', { headers: { 'X-Invite-Token': token }, cache: 'no-store' });
        const data = await readJson(res);
        if (!active) return;
        if (res.status === 404) { setView({ kind: 'invalid' }); return; }
        if (!res.ok) { setView({ kind: 'unavailable', message: res.status === 429 && data.error ? String(data.error) : GENERIC_ERROR }); return; }
        setPreview({ agencyName: String(data.agencyName || ''), role: String(data.role || ''), name: String(data.name || '') });
        setView({ kind: 'choose' });
      } catch {
        if (active) setView({ kind: 'unavailable', message: NETWORK_ERROR });
      }
    })();
    return () => { active = false; };
  }, [token, loadKey]);

  const pick = (kind: 'new' | 'existing' | 'choose') => {
    setPassword('');
    setConfirm('');
    setError(null);
    setView({ kind });
  };

  const finish = (data: any) => {
    if (data && data.chooseMembership === true && typeof data.token === 'string' && Array.isArray(data.memberships)) {
      setView({ kind: 'memberships', token: data.token, memberships: data.memberships });
      return;
    }
    if (data && typeof data.token === 'string' && data.user) {
      setSessionToken(data.token);
      onLoginSuccess(data.user);
      return;
    }
    setError('You joined. Please sign in to continue.');
  };

  const submit = async (e: React.FormEvent, mode: 'new' | 'existing') => {
    e.preventDefault();
    if (busy || !token) return;
    setError(null);
    if (mode === 'new') {
      if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
      if (password !== confirm) { setError('The two passwords do not match.'); return; }
    } else if (!password) {
      setError('Please enter your password.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token, mode, password }),
      });
      const data = await readJson(res);
      if (res.ok) { finish(data); return; }
      if (res.status === 404) { setView({ kind: 'invalid' }); return; }
      if (res.status === 403 && data.code === 'INVITE_ACCOUNT_NOT_LINKABLE') {
        setView({ kind: 'not-linkable', message: String(data.error || "This account can't be connected to another agency yet.") });
        return;
      }
      setError(typeof data.error === 'string' && data.error ? data.error : GENERIC_ERROR);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const openMembership = async (chooseToken: string, membershipId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chooseToken}` },
        cache: 'no-store',
        body: JSON.stringify({ membershipId }),
      });
      const data = await readJson(res);
      if (res.ok && typeof data.token === 'string' && data.user) {
        setSessionToken(data.token);
        onLoginSuccess(data.user);
        return;
      }
      setError(typeof data.error === 'string' && data.error ? data.error : 'Please sign in to continue.');
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
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
  const linkClass = 'min-h-11 px-2 text-sm font-semibold text-gold-ink hover:underline cursor-pointer';
  const roleLabel = preview?.role ? getRoleLabel(preview.role) : '';

  const passwordField = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <div>
      <label htmlFor={id} className="block text-sm font-bold text-ink-soft mb-1.5">{label}</label>
      <div className="relative">
        <Lock className="w-4 h-4 text-ink-faint absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input id={id} type="password" value={value} onChange={(e) => set(e.target.value)} autoComplete={autoComplete} className={inputClass} />
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (view.kind === 'loading') {
    body = <p role="status" className="text-center text-sm text-ink-soft py-6">Opening your invite…</p>;
  } else if (view.kind === 'invalid') {
    body = (
      <div data-invite-state="invalid" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">{INVITE_INVALID_TITLE}</h1>
        <p className="text-sm text-ink-soft">{INVALID_HELP}</p>
        <button type="button" onClick={onLeave} className={secondaryClass}>Go to sign in</button>
      </div>
    );
  } else if (view.kind === 'unavailable') {
    body = (
      <div data-invite-state="unavailable" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">Couldn't open the invite</h1>
        <p className="text-sm text-ink-soft">{view.message}</p>
        <button type="button" onClick={() => setLoadKey((k) => k + 1)} className={primaryClass}>Try again</button>
      </div>
    );
  } else if (view.kind === 'not-linkable') {
    body = (
      <div data-invite-state="not-linkable" className="space-y-4 text-center">
        <h1 className="text-xl font-black text-ink">Can't connect yet</h1>
        <p className="text-sm text-ink">{view.message}</p>
        <p className="text-sm text-ink-soft">Nothing changed in your account. Please tell the person who sent you the link.</p>
        <button type="button" onClick={onLeave} className={secondaryClass}>Go to sign in</button>
      </div>
    );
  } else if (view.kind === 'memberships') {
    body = (
      <div data-invite-state="memberships" className="space-y-4">
        <div className="text-center">
          <h1 className="text-xl font-black text-ink">You're in</h1>
          <p className="text-sm text-ink-soft mt-1">Which agency do you want to open now?</p>
        </div>
        {errorBox}
        <div className="space-y-2">
          {view.memberships.map((m) => (
            <button key={m.membershipId} type="button" disabled={busy} onClick={() => openMembership(view.token, m.membershipId)}
              className="w-full min-h-11 py-3 px-4 rounded-xl bg-surface border border-line text-left flex items-center gap-3 hover:bg-sunken disabled:opacity-50 cursor-pointer">
              <Building2 className="w-5 h-5 shrink-0 text-gold-ink" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-ink break-words">{m.agencyName || 'Agency'}</span>
                <span className="block text-sm text-ink-soft">{getRoleLabel(m.role)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        <div className="text-center">
          <p className="text-sm font-semibold text-ink-soft">You're invited to join</p>
          <h1 data-invite-agency className="text-xl sm:text-2xl font-black tracking-tight text-ink break-words">{preview?.agencyName || 'an agency on Shutfey'}</h1>
          {(preview?.name || roleLabel) && (
            <p className="text-sm text-ink-soft mt-1 break-words">
              {preview?.name}{preview?.name && roleLabel ? ' · ' : ''}{roleLabel}
            </p>
          )}
        </div>
        {view.kind === 'choose' && (
          <div data-invite-state="choose" className="space-y-3">
            <button type="button" data-invite-pick="new" onClick={() => pick('new')} className={primaryClass}>
              <UserPlus className="w-4 h-4" aria-hidden="true" />
              <span>New to Shutfey? Choose a password</span>
            </button>
            <button type="button" data-invite-pick="existing" onClick={() => pick('existing')} className={secondaryClass}>
              <LogIn className="w-4 h-4" aria-hidden="true" />
              <span>Already use Shutfey? Sign in</span>
            </button>
          </div>
        )}
        {view.kind === 'new' && (
          <form data-invite-state="new" onSubmit={(e) => submit(e, 'new')} className="space-y-4" noValidate>
            <h2 className="text-base font-bold text-ink">Choose a password</h2>
            {errorBox}
            {passwordField('invite-new-password', 'Password (at least 8 characters)', password, setPassword, 'new-password')}
            {passwordField('invite-new-confirm', 'Type it again', confirm, setConfirm, 'new-password')}
            <button type="submit" disabled={busy} className={primaryClass}>
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              <span>{busy ? 'Joining…' : 'Join'}</span>
            </button>
            <div className="text-center"><button type="button" onClick={() => pick('choose')} className={linkClass}>Back</button></div>
          </form>
        )}
        {view.kind === 'existing' && (
          <form data-invite-state="existing" onSubmit={(e) => submit(e, 'existing')} className="space-y-4" noValidate>
            <h2 className="text-base font-bold text-ink">Sign in with your Shutfey password</h2>
            <p className="text-sm text-ink-soft">Use the password you already use for Shutfey with this email.</p>
            {errorBox}
            {passwordField('invite-existing-password', 'Password', password, setPassword, 'current-password')}
            <button type="submit" disabled={busy} className={primaryClass}>
              <LogIn className="w-4 h-4" aria-hidden="true" />
              <span>{busy ? 'Signing in…' : 'Sign in and join'}</span>
            </button>
            <div className="text-center"><button type="button" onClick={() => pick('choose')} className={linkClass}>Back</button></div>
          </form>
        )}
      </div>
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
        <div data-invite-page className="w-full max-w-md bg-surface rounded-3xl p-6 sm:p-8 e3 border border-line">
          {body}
        </div>
      </main>
    </div>
  );
};
