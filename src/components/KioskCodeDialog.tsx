import React, { useEffect, useRef, useState } from 'react';
import { X, KeyRound, Shuffle, MessageCircle, MessageSquare, Share2, Copy, Check, Phone, Trash2, AlertTriangle } from 'lucide-react';
import {
  KIOSK_CODE_PATTERN,
  canWebShare,
  copyText,
  generateKioskCode,
  kioskCodeMessage,
  normalizePhone,
  smsHref,
  whatsappHref,
} from '../lib/kioskCodeShare';

/**
 * K1 — "Kiosk code for <name>" sheet.
 * Step 1 (edit): type 4–6 digits or Generate, then an explicit Save code.
 *   Optional phone number with its own Save phone (managers only).
 * Step 2 (show): the code big, ONCE, with WhatsApp / SMS (phone saved) or
 *   Share, plus Copy. The digits live only in this component's state and are
 *   dropped on Done / close; the server stores only a bcrypt hash and never
 *   returns digits.
 */
export interface KioskCodeDialogProps {
  isOpen: boolean;
  personName: string;
  hasCode: boolean;
  phoneNumber?: string;
  canEditPhone: boolean;
  onClose: () => void;
  onSaveCode: (code: string) => Promise<void>;
  onRemoveCode: () => Promise<void>;
  onSavePhone: (phone: string) => Promise<void>;
}

export const KioskCodeDialog: React.FC<KioskCodeDialogProps> = ({
  isOpen,
  personName,
  hasCode,
  phoneNumber,
  canEditPhone,
  onClose,
  onSaveCode,
  onRemoveCode,
  onSavePhone,
}) => {
  const [code, setCode] = useState('');
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [phone, setPhone] = useState(phoneNumber || '');
  const [busy, setBusy] = useState<null | 'code' | 'phone' | 'remove'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fresh state every time the sheet opens; the digits never outlive it.
  useEffect(() => {
    if (isOpen) {
      setCode('');
      setShownCode(null);
      setPhone(phoneNumber || '');
      setError(null);
      setNote(null);
      setCopied(false);
      setConfirmRemove(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setCode('');
      setShownCode(null);
    }
    // phoneNumber is read on open only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const firstName = (personName || '').trim().split(/\s+/)[0] || personName;
  const valid = KIOSK_CODE_PATTERN.test(code);
  const savedPhone = phoneNumber || '';
  const phoneNorm = normalizePhone(phone);
  const phoneChanged = (phoneNorm ?? phone) !== savedPhone;

  const close = () => {
    setCode('');
    setShownCode(null);
    onClose();
  };

  const saveCode = async () => {
    if (!valid || busy) return;
    setError(null);
    setBusy('code');
    try {
      await onSaveCode(code);
      setShownCode(code);
      setCode('');
    } catch (e: any) {
      setError(e?.message || 'Could not save the code. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const savePhone = async () => {
    if (busy) return;
    if (phoneNorm === null) {
      setError("That phone number doesn't look right. Use digits, with + and the country code outside the US.");
      return;
    }
    setError(null);
    setBusy('phone');
    try {
      await onSavePhone(phoneNorm);
      setPhone(phoneNorm);
      setNote(phoneNorm ? 'Phone saved.' : 'Phone removed.');
    } catch (e: any) {
      setError(e?.message || 'Could not save the phone number.');
    } finally {
      setBusy(null);
    }
  };

  const removeCode = async () => {
    if (busy) return;
    setError(null);
    setBusy('remove');
    try {
      await onRemoveCode();
      close();
    } catch (e: any) {
      setError(e?.message || 'Could not remove the code.');
      setBusy(null);
    }
  };

  const message = shownCode ? kioskCodeMessage(shownCode) : '';
  const sendPhone = savedPhone || (phoneNorm ? phoneNorm : '');

  const share = async () => {
    try {
      await (navigator as any).share({ text: message });
    } catch {
      // the person closed the share sheet — nothing to do
    }
  };
  const copy = async () => {
    const ok = await copyText(message);
    setCopied(ok);
    if (!ok) setError('Copy did not work here. Write the code down from the screen.');
  };

  const btn = 'pressable inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold cursor-pointer disabled:opacity-50';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Kiosk code for ${personName}`}
      data-testid="kiosk-code-dialog"
    >
      <div className="w-full max-w-md rounded-2xl bg-surface border border-line e3 overflow-hidden p-6 animate-slide-up">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-3 rounded-xl shrink-0 bg-sunken">
              <KeyRound className="w-6 h-6 text-ink-soft" />
            </div>
            <div>
              <h3 className="text-base font-bold text-ink leading-tight">
                {shownCode ? `${firstName}'s kiosk code` : `Kiosk code for ${personName}`}
              </h3>
              <p className="mt-1 text-xs text-ink-soft">
                {shownCode
                  ? 'Shown only now. Send it, then tap Done.'
                  : hasCode
                  ? 'A code is set. Saving a new one replaces it, and the old one stops working.'
                  : 'Staff tap their name on the kiosk tablet and enter this code.'}
              </p>
            </div>
          </div>
          <button onClick={close} className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-4 p-2.5 rounded-xl bg-bad-bg border border-bad text-xs text-bad flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{error}</span>
          </p>
        )}

        {shownCode ? (
          <div className="mt-5">
            <div
              data-testid="kiosk-code-once"
              className="text-center font-bold text-6xl tracking-[0.25em] tnum text-ink py-4 rounded-2xl bg-sunken border border-line select-all"
            >
              {shownCode}
            </div>
            <p className="mt-2 text-center text-xs text-ink-soft">
              If it's forgotten later, tap Reset code to make a new one.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              {sendPhone ? (
                <>
                  <a
                    href={whatsappHref(sendPhone, message)}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="kiosk-code-whatsapp"
                    className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}
                  >
                    <MessageCircle className="w-4 h-4" /> WhatsApp
                  </a>
                  <a href={smsHref(sendPhone, message)} data-testid="kiosk-code-sms" className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}>
                    <MessageSquare className="w-4 h-4" /> SMS
                  </a>
                </>
              ) : canWebShare() ? (
                <button type="button" onClick={share} data-testid="kiosk-code-share" className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}>
                  <Share2 className="w-4 h-4" /> Share
                </button>
              ) : null}
              <button
                type="button"
                onClick={copy}
                data-testid="kiosk-code-copy"
                className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken ${!sendPhone && canWebShare() ? '' : 'col-span-2'}`}
              >
                {copied ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button type="button" onClick={close} data-testid="kiosk-code-done" className={`${btn} mt-4 w-full bg-gold-deep text-paper`}>
              Done
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveCode();
              }}
            >
              <label htmlFor="kiosk-code-input" className="block text-xs font-semibold text-ink-soft mb-1.5">
                Code (4–6 digits)
              </label>
              <div className="flex gap-2">
                <input
                  id="kiosk-code-input"
                  ref={inputRef}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6));
                    setError(null);
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="••••"
                  className="flex-1 min-w-0 text-2xl font-bold tnum tracking-[0.3em] text-center px-3 py-2 rounded-xl border border-line-control bg-sunken text-ink focus:border-gold focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    // D3c: generation can fail (no fixed fallback code); say so, save nothing.
                    try {
                      setCode(generateKioskCode());
                      setError(null);
                    } catch (e) {
                      setCode('');
                      setError(e instanceof Error && e.message ? e.message : "Couldn't make a code. Try again, or type one.");
                    }
                  }}
                  className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}
                  title="Make up a random code"
                >
                  <Shuffle className="w-4 h-4" /> Generate
                </button>
              </div>
              <button
                type="submit"
                disabled={!valid || busy !== null}
                data-testid="kiosk-code-save"
                className={`${btn} mt-3 w-full bg-gold-deep text-paper`}
              >
                {busy === 'code' ? 'Saving…' : 'Save code'}
              </button>
            </form>

            {canEditPhone && (
              <div className="pt-4 border-t border-line">
                <label htmlFor="kiosk-phone-input" className="block text-xs font-semibold text-ink-soft mb-1.5">
                  Phone (optional, for sending the code)
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1 min-w-0">
                    <Phone className="w-3.5 h-3.5 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="kiosk-phone-input"
                      type="tel"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        setNote(null);
                        setError(null);
                      }}
                      autoComplete="off"
                      placeholder="(860) 555-0123"
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-line-control bg-sunken text-ink text-base focus:border-gold focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={savePhone}
                    disabled={busy !== null || !phoneChanged}
                    data-testid="kiosk-phone-save"
                    className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}
                  >
                    {busy === 'phone' ? 'Saving…' : 'Save phone'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {note || "Outside the US, start with + and the country code. Only admins and the venue's coordinator see it."}
                </p>
              </div>
            )}

            {hasCode && (
              <div className="pt-4 border-t border-line">
                {confirmRemove ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-soft">Remove the code? {firstName} can't use the kiosk until a new one is set.</span>
                    <div className="flex gap-2 shrink-0">
                      <button type="button" onClick={() => setConfirmRemove(false)} className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}>
                        Keep
                      </button>
                      <button type="button" onClick={removeCode} disabled={busy !== null} className={`${btn} bg-surface border border-line-control text-ink hover:bg-sunken`}>
                        {busy === 'remove' ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove code
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
