import React, { useState } from 'react';
import { ScanFace, CheckCircle2, AlertCircle, Lock } from 'lucide-react';
import { addPasskey, confirmPassword, dismissOffer, PasskeyError, PASSKEY_TEXT as T } from '../lib/passkeys';

/** Item 11b-c (a): the one-time "Add Face ID" offer after a password sign-in. */
export const PasskeyOffer: React.FC<{ userId: string; onClose: () => void; onAdded?: () => void }> = ({ userId, onClose, onAdded }) => {
  const [step, setStep] = useState<'offer' | 'working' | 'password' | 'done' | 'error'>('offer');
  const [error, setError] = useState<PasskeyError | null>(null);
  const [password, setPassword] = useState('');

  const notNow = () => { dismissOffer(userId); onClose(); };
  const add = async () => {
    setError(null); setStep('working');
    try { await addPasskey(); dismissOffer(userId); setStep('done'); onAdded?.(); }
    catch (e: any) {
      const pe = e instanceof PasskeyError ? e : new PasskeyError('failed', T.saveFailed);
      if (pe.kind === 'needPassword') { setStep('password'); return; }
      setError(pe); setStep('error');
    }
  };
  const submitPassword = async (ev: React.FormEvent) => {
    ev.preventDefault(); setError(null);
    try { await confirmPassword(password); setPassword(''); await add(); }
    catch (e: any) { setError(e instanceof PasskeyError ? e : new PasskeyError('failed', T.offline)); }
  };
  const final = error && (error.kind === 'unavailable' || error.kind === 'unsupported' || error.kind === 'limit' || error.kind === 'already');

  return (
    <div data-passkey-offer className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="passkey-offer-title">
      <div className="bg-surface rounded-2xl w-full max-w-sm e3 border border-line overflow-hidden animate-slide-up">
        <div className="px-6 pt-7 pb-6 text-center">
          <div className={`w-14 h-14 rounded-2xl mx-auto flex items-center justify-center ${step === 'done' ? 'bg-ok-bg text-ok' : 'bg-gold-wash text-gold-deep'}`}>
            {step === 'done' ? <CheckCircle2 className="w-7 h-7" /> : <ScanFace className="w-7 h-7" />}
          </div>

          {step === 'done' ? (
            <>
              <h2 id="passkey-offer-title" className="mt-4 text-base font-bold text-ink">{T.doneTitle}</h2>
              <p className="mt-1.5 text-xs text-ink-soft">{T.doneBody}</p>
              <button onClick={onClose} className="mt-6 w-full py-3 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-2 cursor-pointer">{T.done}</button>
            </>
          ) : step === 'password' ? (
            <form onSubmit={submitPassword} className="text-left">
              <h2 id="passkey-offer-title" className="mt-4 text-base font-bold text-ink text-center">{T.passwordTitle}</h2>
              <p className="mt-1.5 text-xs text-ink-soft text-center">{T.needPassword}</p>
              {error && <ErrorBox text={error.message} />}
              <div className="relative mt-4">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint"><Lock className="w-4 h-4" /></div>
                <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder={T.passwordPlaceholder}
                  className="w-full pl-10 pr-3 py-2.5 text-base rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold" />
              </div>
              <button type="submit" className="mt-4 w-full py-3 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-2 cursor-pointer">{T.continue}</button>
              <button type="button" onClick={notNow} className="mt-2 w-full min-h-11 text-sm font-semibold text-ink-soft cursor-pointer">{T.offerNotNow}</button>
            </form>
          ) : (
            <>
              <h2 id="passkey-offer-title" className="mt-4 text-base font-bold text-ink">{T.offerTitle}</h2>
              <p className="mt-1.5 text-xs text-ink-soft leading-relaxed">
                {T.offerBody}
              </p>
              {step === 'error' && error && <ErrorBox text={error.message} />}
              {!final && (
                <button onClick={add} disabled={step === 'working'} className="mt-6 w-full py-3 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-2 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60">
                  {step === 'working'
                    ? (<><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /><span>{T.waiting}</span></>)
                    : (<><ScanFace className="w-4 h-4" /><span>{step === 'error' ? T.tryAgain : T.offerAdd}</span></>)}
                </button>
              )}
              <button onClick={final ? onClose : notNow} className={`${final ? 'mt-6 bg-surface border border-line-control text-ink' : 'mt-2 text-ink-soft'} w-full min-h-11 rounded-xl text-sm font-semibold cursor-pointer`}>
                {final ? T.ok : T.offerNotNow}
              </button>
              {!final && <p className="mt-3 text-[11px] text-ink-faint">{T.offerLater}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const ErrorBox: React.FC<{ text: string }> = ({ text }) => (
  <div role="alert" className="mt-4 p-3 rounded-2xl bg-bad-bg border border-bad text-bad text-xs flex items-start gap-2 text-left">
    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{text}</span>
  </div>
);
