import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch, apiWrite, versionFromResponse } from '../lib/api';
import { resizeForLogo, validRev, type LogoImage } from '../lib/agencyLogo';
import { ConfirmModal } from './ConfirmModal';

interface AgencyLogoSheetProps {
  isOpen: boolean;
  onClose: () => void;
  agencyName: string;
  agencyShortCode: string;
  currentLogoSrc: string | null;
  onLogoChanged: (rev: string | null) => void;
}
// Mount a fresh form for each opening: its response version is captured once.
export function AgencyLogoSheet(props: AgencyLogoSheetProps) {
  return props.isOpen ? <AgencyLogoForm {...props} /> : null;
}
function AgencyLogoForm({ onClose, agencyName, agencyShortCode, currentLogoSrc, onLogoChanged }: AgencyLogoSheetProps) {
  const [baseline, setBaseline] = useState<number | undefined>();
  const [chosen, setChosen] = useState<LogoImage | null>(null);
  const [saving, setSaving] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const selection = useRef(0);
  const buttonClass = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50';
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/agencies/current');
        const version = versionFromResponse(res);
        if (!res.ok || version === undefined) throw new Error("Couldn't load the agency. Close and reopen to try again.");
        if (active) setBaseline(version);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : "Couldn't load the agency."); }
    })();
    return () => { active = false; selection.current += 1; };
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = confirming ? confirmation.current : dialog.current;
    const focusable = (): HTMLElement[] => Array.from<HTMLElement>(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
    ) || []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (confirming) setConfirming(false); else closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          root?.focus();
        } else if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (!root?.contains(event.target as Node)) (focusable()[0] || root)?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      previous?.focus();
    };
  }, [confirming]);

  const choose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const request = ++selection.current;
    setDecoding(true); setChosen(null); setError(null);
    try {
      const image = await resizeForLogo(file);
      if (selection.current === request) setChosen(image);
    } catch (error) { if (selection.current === request) setError(error instanceof Error ? error.message : "Couldn't read that image."); }
    finally { if (selection.current === request) setDecoding(false); }
  };
  const write = async (remove: boolean) => {
    if (saving || baseline === undefined || (!remove && !chosen)) return;
    setSaving(true); setError(null);
    try {
      const result = await apiWrite<{ logoRev?: unknown; error?: string }>('/api/agency/logo', {
        method: remove ? 'DELETE' : 'PUT', expectedVersion: baseline,
        ...(!remove ? { body: JSON.stringify({ data: chosen!.data }) } : {}),
      });
      if (!result.ok) {
        setError(result.status === 409 ? 'Someone else just changed the agency. Close and reopen to see the latest.' : result.status === 400 && typeof result.data?.error === 'string' ? result.data.error : result.error);
        return;
      }
      if (!remove && !validRev(result.data?.logoRev)) { setError("Couldn't save the logo. Try again."); return; }
      onLogoChanged(remove ? null : result.data.logoRev as string);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn't save the logo."); }
    finally { setSaving(false); setConfirming(false); }
  };
  const src = chosen?.dataUrl || currentLogoSrc;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-control bg-surface p-6 text-ink e3">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={titleId} className="text-base font-bold">Agency logo</h2>
        <button type="button" aria-label="Close" onClick={onClose} className={`${buttonClass} w-11 shrink-0 px-0 inline-flex items-center justify-center`}><X className="h-5 w-5" /></button>
      </div>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void write(false); }}>
        {src ? <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line bg-paper dark:bg-ink p-3"><p className="mb-2 text-xs text-ink dark:text-paper">Light</p><img src={src} alt={agencyName} className="h-[32px] max-w-[120px] w-auto object-contain" /></div>
          <div className="dark rounded-lg border border-line bg-paper p-3"><p className="mb-2 text-xs text-ink">Night</p><img src={src} alt={agencyName} className="h-[32px] max-w-[120px] w-auto object-contain" /></div>
        </div> : <p className="text-sm text-ink-soft">No logo yet. The header shows {agencyShortCode}.</p>}
        <div><label htmlFor={inputId} className="mb-1 block text-sm text-ink-soft">Choose image</label>
          <input id={inputId} type="file" accept="image/png,image/jpeg,image/webp" disabled={saving} onChange={choose} className="min-h-11 w-full min-w-0 rounded-lg border border-line-control bg-sunken px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-gold" /></div>
        {error && <p role="alert" className="text-sm text-ink">{error}</p>}
        <button type="submit" disabled={!chosen || saving || decoding || baseline === undefined} className="pressable min-h-11 w-full rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        {currentLogoSrc && <button type="button" disabled={saving || baseline === undefined} className={buttonClass} onClick={() => setConfirming(true)}>Remove logo</button>}
      </form>
      <div ref={confirmation}><ConfirmModal isOpen={confirming} onClose={() => setConfirming(false)} onConfirm={() => { void write(true); }} title="Remove agency logo?" message="The header will show the agency short code." confirmText="Remove logo" isLoading={saving} /></div>
    </div>
  </div>;
}
