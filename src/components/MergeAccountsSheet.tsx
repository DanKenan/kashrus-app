import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Building2, CheckCircle2, Eye, EyeOff, Lock, Mail, X } from 'lucide-react';
import { getSessionToken } from '../lib/api';
import { getRoleLabel } from '../lib/permissions';
import { cleanMemberships, Membership } from '../lib/memberships';
import {
  isMergeSuccess, isMergeUnknown, mergeAccounts, mergeErrorText, mergeRoles, MergeMode, newMergeOperationId, normEmail,
} from '../lib/accountMerge';

// 10M part 2 (Don, Oct 22 2026): merge two Shutfey accounts into one. Two ways
// in; the main account always stays. The confirm step names, before anything
// happens, which email stops working and which one to use from now on.
interface MergeAccountsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  signedInEmail: string;
  /** Merge done: store nothing here; the App stores the token and signs in as the main account. */
  onMerged: (token: string, user: any, memberships: Membership[]) => void;
  /** The answer was lost or the session ended: sign out so the person can sign in with the main email. */
  onSignInAgain: () => void;
}

type Step = 'pick' | 'form' | 'confirm' | 'done' | 'unknown';

export function MergeAccountsSheet({ isOpen, onClose, signedInEmail, onMerged, onSignInAgain }: MergeAccountsSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(false);
  const lockRef = useRef(false); // true while sending or on the "couldn't confirm" screen
  const [step, setStep] = useState<Step>('pick');
  const [mode, setMode] = useState<MergeMode>('merge-into');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneList, setDoneList] = useState<Membership[]>([]);
  const [doneEmail, setDoneEmail] = useState('');
  // Frozen at the moment of the merge: after it, the signed-in email becomes the main one.
  const [doneStops, setDoneStops] = useState('');
  // One operation id per confirmed attempt: a double tap or a resend of the same
  // request replays the same merge instead of starting a second one.
  const opRef = useRef<string>('');

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const controls = (): HTMLElement[] => {
      const dialog = dialogRef.current;
      return dialog ? (Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')) as HTMLElement[]) : [];
    };
    controls()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // Not while the request runs, and not on "couldn't confirm": that screen
        // leaves only "Sign in again" (the old session may already be dead).
        if (!lockRef.current && !busyRef.current) closeRef.current();
      } else if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const list = controls();
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(event.target as Node)) controls()[0]?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    setStep('pick'); setEmail(''); setPassword(''); setCurrentPassword(''); setShowPass(false);
    setBusy(false); setError(null); setDoneList([]); setDoneEmail(''); setDoneStops(''); opRef.current = '';
  }, [isOpen]);

  lockRef.current = busy || step === 'unknown';
  if (!isOpen) return null;

  const me = String(signedInEmail || '').trim();
  const roles = mergeRoles(mode, me, email);
  const choose = (m: MergeMode) => {
    setMode(m); setEmail(''); setPassword(''); setCurrentPassword(''); setError(null); opRef.current = ''; setStep('form');
  };
  const toConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password || (mode === 'merge-into' && !currentPassword)) { setError('Please fill in every field.'); return; }
    if (normEmail(email) === normEmail(me)) { setError("That's the account you're signed in with."); return; }
    opRef.current = newMergeOperationId();
    setStep('confirm');
  };
  const submit = async () => {
    if (busy) return;
    if (!opRef.current) opRef.current = newMergeOperationId();
    setBusy(true); busyRef.current = true;
    setError(null);
    const r = await mergeAccounts(mode, { email, password, currentPassword }, opRef.current, getSessionToken());
    setBusy(false); busyRef.current = false;
    if (isMergeSuccess(r)) {
      const list = cleanMemberships(r.data.memberships);
      setDoneList(list);
      setDoneEmail(typeof r.data.email === 'string' && r.data.email ? r.data.email : roles.keeps);
      setDoneStops(roles.stops);
      setPassword(''); setCurrentPassword('');
      setStep('done');
      onMerged(r.data.token, r.data.user, list);
      return;
    }
    if (isMergeUnknown(r)) { setPassword(''); setCurrentPassword(''); setStep('unknown'); return; }
    // A refusal changed nothing: back to the form with plain words.
    setError(mergeErrorText(mode, r));
    opRef.current = '';
    setStep('form');
  };

  const isA = mode === 'merge-into';
  const inputClass = 'w-full pl-10 pr-3 py-2.5 rounded-xl bg-sunken border border-line text-base text-ink placeholder-ink-faint focus:outline-none focus:border-gold';
  const primaryClass = 'w-full min-h-11 py-3 px-4 rounded-xl pressable bg-gold-deep text-paper e1 text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer';
  const secondaryClass = 'w-full min-h-11 py-3 px-4 rounded-xl bg-surface border border-line text-ink text-sm font-bold flex items-center justify-center gap-2 hover:bg-sunken disabled:opacity-50 cursor-pointer';
  const errorBox = error && (
    <div role="alert" className="p-3 rounded-2xl bg-bad-bg border border-bad text-sm text-bad flex items-start gap-2">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );

  let title = 'Merge two accounts';
  let body: React.ReactNode;
  if (step === 'pick') {
    body = (
      <div data-merge-step="pick" className="space-y-3">
        <p className="text-sm text-ink-soft">Have two Shutfey logins? Merge them into one. The main account keeps its email and password and gets the other account's agencies. The other login stops working.</p>
        <button type="button" data-merge-mode="merge-into" onClick={() => choose('merge-into')}
          className="w-full min-h-11 p-3 rounded-xl bg-surface border border-line-control text-left hover:bg-sunken pressable cursor-pointer">
          <span className="block text-sm font-bold text-ink">Merge into my main account</span>
          <span className="block text-sm text-ink-soft mt-0.5 break-words">{me} is the extra one. You'll type your main account's email and password.</span>
        </button>
        <button type="button" data-merge-mode="bring-in" onClick={() => choose('bring-in')}
          className="w-full min-h-11 p-3 rounded-xl bg-surface border border-line-control text-left hover:bg-sunken pressable cursor-pointer">
          <span className="block text-sm font-bold text-ink">Bring in another account</span>
          <span className="block text-sm text-ink-soft mt-0.5 break-words">{me} is your main account. You'll type the other account's email and password.</span>
        </button>
      </div>
    );
  } else if (step === 'form') {
    title = isA ? 'Merge into my main account' : 'Bring in another account';
    body = (
      <form data-merge-step="form" onSubmit={toConfirm} className="space-y-4">
        {errorBox}
        <div>
          <label className="block text-xs font-bold text-ink-soft mb-1.5">{isA ? 'Main account email' : 'Other account email'}</label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none" aria-hidden="true" />
            <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder={isA ? 'Main account email' : 'Other account email'} className={inputClass} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-bold text-ink-soft mb-1.5">{isA ? 'Main account password' : 'Other account password'}</label>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none" aria-hidden="true" />
            <input type={showPass ? 'text' : 'password'} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={isA ? 'Main account password' : 'Other account password'} className={inputClass} />
          </div>
        </div>
        {isA && (
          <div>
            <label className="block text-xs font-bold text-ink-soft mb-1.5">Your password now</label>
            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint pointer-events-none" aria-hidden="true" />
              <input type={showPass ? 'text' : 'password'} autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={`Password for ${me}`} className={inputClass} />
            </div>
          </div>
        )}
        <button type="button" onClick={() => setShowPass((v) => !v)} className="min-h-11 inline-flex items-center gap-2 text-sm font-semibold text-ink-soft cursor-pointer">
          {showPass ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
          <span>{showPass ? 'Hide passwords' : 'Show passwords'}</span>
        </button>
        <button type="submit" className={primaryClass}>Continue</button>
        <button type="button" onClick={() => { setError(null); setStep('pick'); }} className={secondaryClass}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /><span>Back</span>
        </button>
      </form>
    );
  } else if (step === 'confirm') {
    title = 'Check before you merge';
    body = (
      <div data-merge-step="confirm" className="space-y-3">
        <div data-merge-stops className="p-3 rounded-2xl bg-bad-bg border border-bad text-sm text-bad">
          <span className="font-bold break-words">{roles.stops}</span> will stop working.
        </div>
        <div data-merge-keeps className="p-3 rounded-2xl bg-ok-bg border border-line text-sm text-ok">
          Use <span className="font-bold break-words">{roles.keeps}</span> from now on.
        </div>
        <p className="text-sm text-ink-soft break-words">The agencies of {roles.stops} move to {roles.keeps}. This can't be undone.</p>
        <button type="button" data-merge-submit disabled={busy} onClick={() => { void submit(); }} className={primaryClass}>
          {busy ? 'Merging…' : 'Merge accounts'}
        </button>
        <button type="button" disabled={busy} onClick={() => setStep('form')} className={secondaryClass}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /><span>Back</span>
        </button>
      </div>
    );
  } else if (step === 'done') {
    title = 'Accounts merged';
    body = (
      <div data-merge-step="done" className="space-y-3">
        <div className="flex items-start gap-2 p-3 rounded-2xl bg-ok-bg border border-line text-sm text-ok">
          <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
          <span>Use <span className="font-bold break-words">{doneEmail}</span> from now on. {doneStops} no longer works.</span>
        </div>
        {doneList.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-ink">Your agencies</p>
            {doneList.map((m) => (
              <div key={m.membershipId} data-merged-agency className="min-h-11 flex items-center gap-3 px-3 py-2 rounded-xl border border-line-control">
                <Building2 className="w-5 h-5 shrink-0 text-gold-ink" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-ink break-words">{m.agencyName}</span>
                  {m.role && <span className="block text-sm text-ink-soft">{getRoleLabel(m.role)}</span>}
                </span>
              </div>
            ))}
            <p className="text-sm text-ink-soft">To move between them, open the menu and tap "Switch agency".</p>
          </div>
        )}
        <button type="button" onClick={onClose} className={primaryClass}>Done</button>
      </div>
    );
  } else {
    title = "We couldn't confirm the merge";
    body = (
      <div data-merge-step="unknown" className="space-y-3">
        <p className="text-sm text-ink break-words">If the merge went through, sign in with <span className="font-bold">{roles.keeps}</span>. If it didn't, sign in as before and try again.</p>
        <button type="button" onClick={onSignInAgain} className={primaryClass}>Sign in again</button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-merge-accounts
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-surface border border-line e3 p-4 animate-slide-up"
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">{title}</h2>
          {step !== 'unknown' && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
              className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        {body}
      </div>
    </div>
  );
}
