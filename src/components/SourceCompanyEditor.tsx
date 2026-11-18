import React, { useState } from 'react';
import { useVisitFocus } from './FactoryVisitScreen';
import { X } from 'lucide-react';
import { saveCompany, saveSheetFee } from '../lib/sourcesSetup';
import { sourceButton } from './SourceConnectSheet';
import { setupField, setupPrimary } from './MappingStep';
export function SourceCompanyEditor({ company, source, feeOnly = false, onClose, onSaved }: { feeOnly?: boolean; company: { companyFee?: number; id?: string; name: string; address?: string; type?: string }; source: string; onClose(): void; onSaved(): void }) {
  const root = useVisitFocus(onClose);
  const [fields, setFields] = useState({ name: company.name, address: company.address || '', type: company.type || '' }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [fee, setFee] = useState(String(company.companyFee ?? ''));
  const amount = Number(fee);
  const valid = feeOnly
    ? !!company.id && !!fee.trim() && Number.isFinite(amount) && amount >= 0 && amount !== company.companyFee
    : !!fields.name.trim();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError('');
    try {
      if (feeOnly && company.id) {
        await saveSheetFee(company.id, amount);
      } else {
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
          company.id ? value !== (company[key as keyof typeof fields] ?? '') : value !== ''));
        if (Object.keys(changed).length) await saveCompany(changed, company.id);
      }
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return <div ref={root} className="fixed inset-0 z-50 flex items-end justify-center bg-scrim"><form role="dialog" aria-modal="true" aria-label={company.id ? 'Edit company' : 'Add company'} className="max-h-[90dvh] w-full min-w-0 max-w-2xl space-y-4 overflow-y-auto rounded-t-2xl bg-surface p-4 text-ink tactile-4" onSubmit={submit}><header className="flex items-center gap-4"><h2 className="flex-1 text-2xl font-semibold">{company.id ? 'Edit company' : 'Add company'}</h2><button type="button" className={`${sourceButton} flex h-11 w-11 items-center justify-center px-0`} aria-label="Close" onClick={onClose}><X className="h-5 w-5" aria-hidden="true" /></button></header>{feeOnly ? <label className="block space-y-2 text-base">Fee · {company.name}<input required type="number" min="0" step="any" className={setupField} value={fee} disabled={busy} onChange={e => setFee(e.target.value)} /></label> : (['name', 'address', 'type'] as const).map(field => <label key={field} className="block space-y-2 text-base">{field === 'name' ? 'Name' : field === 'address' ? 'Address' : 'Type'}<input className={setupField} required={field === 'name'} value={fields[field]} disabled={busy} onChange={e => setFields(prev => ({ ...prev, [field]: e.target.value }))} /></label>)}<p className="text-base text-ink-soft">Changes are saved in your {source}.</p>{error && <p role="alert" className="text-base text-bad">{error}</p>}<button type="submit" className={setupPrimary} disabled={busy || !valid}>{busy ? 'Saving…' : 'Save company'}</button></form></div>;
}
