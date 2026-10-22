import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Building2, Check, X } from 'lucide-react';
import { getRoleLabel } from '../lib/permissions';
import { getSessionToken } from '../lib/api';
import { activateMembership, Membership } from '../lib/memberships';

// 10g client: "Switch agency" for a person with more than one agency under one
// login. Same look as the venue switcher. Tapping another agency opens it with
// the same login (POST /api/auth/activate); the current one just closes.
interface AgencySwitcherSheetProps {
  isOpen: boolean;
  onClose: () => void;
  memberships: Membership[];
  currentMembershipId: string | null;
  onActivated: (token: string, user: any) => void;
}

export function AgencySwitcherSheet({
  isOpen, onClose, memberships, currentMembershipId, onActivated,
}: AgencySwitcherSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const buttons = (): HTMLButtonElement[] => Array.from(dialog.querySelectorAll('button:not(:disabled)')) as HTMLButtonElement[];
    buttons()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const controls = buttons();
        const first = controls[0];
        const last = controls[controls.length - 1];
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
      if (!dialog.contains(event.target as Node)) buttons()[0]?.focus();
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
    if (!isOpen) { setBusyId(null); setError(null); }
  }, [isOpen]);

  if (!isOpen) return null;

  const pick = async (m: Membership) => {
    if (busyId) return;
    if (m.membershipId === currentMembershipId) { onClose(); return; }
    setBusyId(m.membershipId);
    setError(null);
    const r = await activateMembership(getSessionToken(), m.membershipId);
    setBusyId(null);
    if (r.ok && r.token && r.user) { onActivated(r.token, r.user); onClose(); return; }
    setError(r.error || "That agency can't be opened right now.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-agency-switcher
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-surface border border-line e3 p-4 animate-slide-up"
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">Switch agency</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {error && (
          <div role="alert" className="mb-3 p-3 rounded-2xl bg-bad-bg border border-bad text-sm text-bad flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        <div className="space-y-2">
          {memberships.map((m) => {
            const current = m.membershipId === currentMembershipId;
            return (
              <button
                key={m.membershipId}
                type="button"
                data-membership={m.membershipId}
                aria-current={current ? 'true' : undefined}
                disabled={!!busyId}
                onClick={() => { void pick(m); }}
                className="w-full min-h-11 flex items-center gap-3 px-3 py-2 text-left rounded-xl bg-surface border border-line-control text-ink hover:bg-sunken pressable disabled:opacity-50 cursor-pointer"
              >
                <Building2 className="w-5 h-5 shrink-0 text-gold-ink" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-base break-words">{m.agencyName}</span>
                  {m.role && <span className="block text-sm text-ink-soft">{getRoleLabel(m.role)}</span>}
                </span>
                {busyId === m.membershipId && <span className="shrink-0 text-sm text-ink-soft">Opening…</span>}
                {current && <Check aria-hidden="true" className="w-5 h-5 shrink-0 ml-auto text-ink" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
