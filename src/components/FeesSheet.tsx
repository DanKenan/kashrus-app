import { FeesDialog as VisitSheet } from './FeesDialog';
import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { visitButton } from './FactoryVisitScreen';
import { foodInput, foodPrimary } from './ChecklistTemplatesScreen';
import { amountValue, getFees, leftLine, saveFees, type CompanyFee, type FeesData, type FeePlace } from '../lib/fees';
export function FeeChoice({ selected, children, onClick, disabled }: { key?: string | number; selected: boolean; children: React.ReactNode; onClick(): void; disabled?: boolean }) { return <button type="button" disabled={disabled} aria-pressed={selected} className={selected ? visitButton.replace('bg-surface', 'bg-ink').replace('text-ink', 'text-paper') : visitButton} onClick={onClick}>{selected && <Check aria-hidden="true" className="mr-2 inline h-5 w-5" />}{children}</button>; }
export function FeesSheet({ placeId, yearlyCount = null, isAdmin = false, prefill, saveVisitRate, onSaved, onClose }: { placeId: string; yearlyCount?: number | null; isAdmin?: boolean; prefill?: number; saveVisitRate?(amount: number): Promise<void>; onSaved?(amount: number | null): void | Promise<void>; onClose(): void }) {
  const [data, setData] = useState<FeesData | null>(null), [place, setPlace] = useState<FeePlace | null>(null);
  const [company, setCompany] = useState(''), [mashgiach, setMashgiach] = useState(''), [per, setPer] = useState<CompanyFee['per']>('visit');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false); const lock = useRef(false);
  useEffect(() => { let active = true; void getFees().then(d => { if (!active) return; const p = d.places.find(p => p.id === placeId); if (!p) throw Error('This place is unavailable.'); setData(d); setPlace(p); const effectiveCompany = p.company ?? p.importedCompany, effectiveVisit = p.mashgiach ?? p.dataFee; setCompany(effectiveCompany ? String(effectiveCompany.amount) : ''); setMashgiach(prefill !== undefined ? String(prefill) : effectiveVisit ? String(effectiveVisit.amount) : ''); setPer(effectiveCompany?.per || 'visit'); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [placeId, prefill]);
  let line: string | null = null; try { const c = amountValue(company), m = amountValue(mashgiach); line = leftLine(c === null || (!place.company && c === place.importedCompany?.amount && per === place.importedCompany.per) ? null : { amount: c, per }, m === null || (!place.mashgiach && prefill === undefined && m === place.dataFee?.amount) ? null : { amount: m }, yearlyCount); } catch { /* Validation is shown on save. */ }
  const canEdit = data?.canEdit && (!!saveVisitRate || isAdmin || place?.kind !== 'factory');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !place || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const m = amountValue(mashgiach);
      if (saveVisitRate) {
        if (m === null) throw Error('Choose a per visit fee.');
        await saveVisitRate(m);
      } else {
        const c = amountValue(company);
        await saveFees(placeId, c === null || (!place.company && c === place.importedCompany?.amount && per === place.importedCompany.per) ? null : { amount: c, per }, m === null || (!place.mashgiach && prefill === undefined && m === place.dataFee?.amount) ? null : { amount: m });
        await onSaved?.(m);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return <VisitSheet title="Fees" onClose={onClose}>{error && <p role="alert" className="text-bad">{error}</p>}{!data || !place ? <p role="status">Loading fees…</p> : <form className="space-y-4" onSubmit={save}><h3 dir="auto" className="break-words text-xl font-semibold">{place.name}</h3><fieldset disabled={busy || !canEdit} className="space-y-4"><fieldset disabled={!!saveVisitRate} className="space-y-2 rounded-xl border border-line bg-surface p-4"><h3 className="text-xl font-semibold">What the company pays</h3><label className="block">Amount<input type="number" min="0" max="100000" step="0.01" className={foodInput} value={company} onChange={e => setCompany(e.target.value)} /></label><div className="flex flex-wrap gap-2">{(['visit', 'month', 'year'] as const).map(value => <FeeChoice key={value} selected={per === value} onClick={() => setPer(value)}>Per {value}</FeeChoice>)}</div></fieldset><section className="space-y-2 rounded-xl border border-line bg-surface p-4"><h3 className="text-xl font-semibold">What the mashgiach is paid</h3><label className="block">Amount per visit<input type="number" min="0" max="100000" step="0.01" className={foodInput} required={prefill !== undefined} value={mashgiach} onChange={e => setMashgiach(e.target.value)} /></label><p dir="auto" className="break-words">{place.mashgiachNames.join(', ')}</p></section></fieldset>{line && <p>{line}</p>}<p>Mashgichim never see what the company pays or what is left.</p>{canEdit ? <button className={foodPrimary} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button> : <p>{data.canEdit ? 'Only an admin can change a factory fee directly. To change it, use the fee check on a visit report, which notifies the admin.' : 'Only admins can change fees.'}</p>}</form>}</VisitSheet>;
}
