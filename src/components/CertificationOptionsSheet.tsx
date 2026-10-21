import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiWrite } from '../lib/api';
import { normalizeOption, validateOptions } from '../lib/certOptions';

interface CertificationOptionsSheetProps {
  options: string[];
  versionAtOpen: number | undefined;
  onClose: () => void;
  onSaved: (options: string[]) => void;
}

export const CertificationOptionsSheet: React.FC<CertificationOptionsSheetProps> = ({
  options, versionAtOpen, onClose, onSaved,
}) => {
  const [listAtOpen] = useState(() => [...options]);
  const [baseline] = useState(versionAtOpen);
  const [edits, setEdits] = useState(() => [...options]);
  const [addition, setAddition] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const addId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const inputClass = 'min-h-11 w-full min-w-0 rounded-lg border border-line-control bg-sunken px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-gold';
  const buttonClass = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm font-semibold text-ink hover:bg-sunken focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const focusable = (): HTMLElement[] => Array.from<HTMLElement>(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
    ) || []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
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
  }, []);

  const proposed = addition ? [...edits, addition] : edits;
  const changed = JSON.stringify(proposed) !== JSON.stringify(listAtOpen);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !changed) return;
    const validation = validateOptions(proposed);
    if (validation) { setError(validation); return; }
    if (baseline === undefined) {
      setError('The choices version is missing. Close and reopen to try again.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiWrite<{ certificationOptions: string[] }>('/api/agency/certification-options', {
        method: 'PUT',
        expectedVersion: baseline,
        body: JSON.stringify({ options: proposed.map(normalizeOption), expectedOptions: listAtOpen }),
      });
      if (!result.ok) {
        setError(result.status === 409
          ? 'Someone else just changed the choices. Close and reopen to see the latest.'
          : result.error);
        return;
      }
      onSaved(result.data.certificationOptions);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't save the choices.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line-control bg-surface p-6 text-ink e3">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-base font-bold">Certification choices</h2>
          <button type="button" aria-label="Close" onClick={onClose} className={`${buttonClass} w-11 shrink-0 px-0 inline-flex items-center justify-center`}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={save} className="space-y-4">
          {edits.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input aria-label={`Choice ${index + 1}`} value={option} disabled={saving} className={inputClass}
                onChange={(event) => setEdits(edits.map((item, i) => i === index ? event.target.value : item))} />
              <button type="button" disabled={saving} className={buttonClass}
                aria-label={`Remove choice ${index + 1}`} onClick={() => setEdits(edits.filter((_, i) => i !== index))}>Remove</button>
            </div>
          ))}
          <div>
            <label htmlFor={addId} className="mb-1 block text-sm text-ink-soft">Add choice</label>
            <div className="flex gap-2">
              <input id={addId} value={addition} disabled={saving} onChange={(event) => setAddition(event.target.value)} className={inputClass} />
              <button type="button" disabled={saving || !addition} className={buttonClass}
                onClick={() => { setEdits([...edits, addition]); setAddition(''); }}>Add choice</button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-ink">{error}</p>}
          <button type="submit" disabled={!changed || saving}
            className="pressable min-h-11 w-full rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  );
};
