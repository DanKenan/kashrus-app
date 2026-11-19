import { FeesDialog as VisitSheet } from './FeesDialog';
import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Phone, Plus, Pencil, Trash2 } from 'lucide-react';
import { visitButton } from './FactoryVisitScreen';
import { FeeChoice } from './FeesSheet';
import { foodInput, foodPrimary } from './ChecklistTemplatesScreen';
import { sourceRequest } from '../lib/sources';
import { emptyContact, getCompanyInfo, saveCompanyInfo, initials, mapsUrl, type CompanyInfo, type Contact } from '../lib/companyInfo';
export function CompanyInfoSheet({ placeId, isAdmin, onClose, onRemove }: { placeId: string; isAdmin: boolean; onClose(): void; onRemove?(): void }) {
  const [data, setData] = useState<CompanyInfo | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [contact, setContact] = useState<Contact | null>(null), [index, setIndex] = useState<number | null>(null), [other, setOther] = useState(false), [removing, setRemoving] = useState<number | null>(null); const lock = useRef(false);
  useEffect(() => { let active = true; void getCompanyInfo(placeId).then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [placeId]);
  const save = async (next: Partial<CompanyInfo>) => { if (!isAdmin || lock.current) return; lock.current = true; setBusy(true); setError(''); try { await saveCompanyInfo(placeId, next); const saved = await getCompanyInfo(placeId); setData(current => current ? { ...current, ...next, contacts: saved.contacts } : saved); setContact(null); setRemoving(null); } catch (e) { setError((e as Error).message); } finally { lock.current = false; setBusy(false); } };
  return <VisitSheet title="Company info" onClose={onClose}>{error && <p role="alert" className="text-bad">{error}</p>}<p className="rounded-xl border border-line bg-surface p-4">Who sees this: admins edit; this place's coordinators can see it; mashgichim see only the address and the place phone.</p>{!data ? <p role="status">Loading company info…</p> : <><form className="space-y-4" onSubmit={e => { e.preventDefault(); void save({ address: data.address, phone: data.phone }); }}><fieldset disabled={!isAdmin || busy} className="space-y-4"><label className="block">Address<input maxLength={200} className={foodInput} value={data.address} onChange={e => setData({ ...data, address: e.target.value })} /></label><label className="block">Place phone<input type="tel" maxLength={40} className={foodInput} value={data.phone} onChange={e => setData({ ...data, phone: e.target.value })} /></label></fieldset>{data.address && <a className={`${visitButton} inline-flex items-center gap-2`} href={mapsUrl(data.address)} target="_blank" rel="noreferrer"><MapPin className="h-5 w-5" aria-hidden="true" />Open in Maps</a>}{data.phone && <a className={`${visitButton} inline-flex items-center gap-2`} href={`tel:${data.phone}`}><Phone className="h-5 w-5" aria-hidden="true" />{data.phone}</a>}{isAdmin && <button className={foodPrimary} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}</form><h3 className="text-xl font-semibold">Contacts</h3>{data.contacts.map((c, i) => <section key={c.id || i} className="space-y-2 rounded-xl border border-line p-4"><span aria-hidden="true" className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-sunken">{initials(c.name)}</span><h4 dir="auto" className="break-words text-xl font-semibold">{c.name}</h4><p dir="auto" className="break-words">{c.role}</p>{c.email && <a className="block min-h-11 break-words" href={`mailto:${c.email}`}>{c.email}</a>}{c.phone && <a className="block min-h-11 break-words" href={`tel:${c.phone}`}>{c.phone}</a>}{isAdmin && <div className="flex gap-2"><button type="button" className={visitButton} disabled={busy} onClick={() => { setIndex(i); setContact({ ...c }); setOther(!['Owner', 'Manager', 'Kitchen', 'Office'].includes(c.role)); }}><Pencil className="mr-2 inline h-5 w-5" aria-hidden="true" />Edit</button><button type="button" className={visitButton} disabled={busy} onClick={() => setRemoving(i)}><Trash2 className="mr-2 inline h-5 w-5" aria-hidden="true" />Delete</button></div>}</section>)}{isAdmin && <button type="button" className={visitButton} disabled={busy || data.contacts.length >= 20} onClick={() => { setIndex(null); setContact(emptyContact()); setOther(false); }}><Plus className="mr-2 inline h-5 w-5" aria-hidden="true" />Add contact</button>}{data.contacts.length >= 20 && <p>Maximum 20 contacts.</p>}{contact && isAdmin && <VisitSheet title={index === null ? 'Add contact' : 'Edit contact'} onClose={() => setContact(null)}><form className="space-y-4" onSubmit={e => { e.preventDefault(); const contacts = [...data.contacts]; if (index === null) contacts.push(contact); else contacts[index] = contact; void save({ contacts }); }}>{error && <p role="alert" className="text-bad">{error}</p>}<fieldset disabled={busy} className="space-y-4"><label className="block">Name<input required maxLength={80} className={foodInput} value={contact.name} onChange={e => setContact({ ...contact, name: e.target.value })} /></label><fieldset><legend>Role</legend><div className="flex flex-wrap gap-2">{['Owner', 'Manager', 'Kitchen', 'Office', 'Other'].map(role => <FeeChoice key={role} selected={role === 'Other' ? other : !other && contact.role === role} onClick={() => { setOther(role === 'Other'); setContact({ ...contact, role: role === 'Other' ? '' : role }); }}>{role}</FeeChoice>)}</div>{other && <label className="block">Other role<input required maxLength={40} className={foodInput} value={contact.role} onChange={e => setContact({ ...contact, role: e.target.value })} /></label>}</fieldset><label className="block">Email<input type="email" maxLength={200} className={foodInput} value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} /></label><label className="block">Phone<input type="tel" maxLength={40} className={foodInput} value={contact.phone} onChange={e => setContact({ ...contact, phone: e.target.value })} /></label></fieldset><button className={foodPrimary} disabled={busy || !contact.name.trim() || !contact.role.trim()}>{busy ? 'Saving…' : 'Save contact'}</button></form></VisitSheet>}{removing !== null && <VisitSheet title="Delete contact?" onClose={() => setRemoving(null)}>{error && <p role="alert" className="text-bad">{error}</p>}<p dir="auto" className="break-words">{data.contacts[removing].name}</p><button type="button" className={visitButton} disabled={busy} onClick={() => void save({ contacts: data.contacts.filter((_, i) => i !== removing) })}>Delete contact</button></VisitSheet>}</>} {onRemove && <div className="border-t border-line pt-4"><button type="button" className={dangerButton} disabled={busy} onClick={onRemove}>Remove company…</button></div>}</VisitSheet>;
}

const dangerButton = visitButton.replace('border-line-control', 'border-bad').replace('text-ink', 'text-bad');
const removalPath = (id: string) => `/api/factories/${encodeURIComponent(id)}/removal`;
export function companyRemovalRequest(id: string, source: string, action: string, extra = {}) {
  return sourceRequest(removalPath(id), 'POST', { source, action, ...extra });
}

type RemovalPlan = {
  name: string;
  mode: 'guided' | 'direct' | null;
  pending: 'guided' | 'direct' | null;
  present: boolean;
  blockers: string[];
  recordKey?: string;
  spreadsheetUrl?: string;
  table?: string;
};

export function CompanyRemovalSheet({ company, source, sourceName, onClose, onChanged, onPending }: {
  company: { id: string; name: string; archived?: boolean; removalPending?: boolean };
  source: string; sourceName: string; onClose(): void; onChanged(message: string): void; onPending(): void;
}) {
  const [choice, setChoice] = useState<'archive' | 'delete' | null>(null);
  const [confirm, setConfirm] = useState(!!company.removalPending);
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (!confirm) return;
    let active = true;
    setPlan(null); setError('');
    void sourceRequest(`${removalPath(company.id)}?source=${encodeURIComponent(source)}`)
      .then(value => { if (active) setPlan(value); })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [confirm, company.id, source, reload]);

  const run = async (action: 'archive' | 'delete' | 'refresh' | 'cancel') => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await companyRemovalRequest(company.id, source, action,
        action === 'delete' ? { name: plan?.name, confirmation } : {});
      if (result.status === 'archived') onChanged('Company archived');
      if (result.status === 'deleted') onChanged('Company removed');
      if (result.status === 'cancelled') onChanged('Permanent removal cancelled');
      if (result.status === 'guided') { setAcknowledged(true); onPending(); }
      if (result.status === 'present') setError('This company is still in the source. Refresh company data after removing the row.');
    } catch (cause) {
      setError((cause as Error).message);
      if (action === 'delete') onPending();
    } finally { lock.current = false; setBusy(false); }
  };
  const close = () => { if (!lock.current) onClose(); };
  const cancel = () => {
    if (company.removalPending || acknowledged) close();
    else { setConfirm(false); setConfirmation(''); setError(''); }
  };
  if (!confirm) return <VisitSheet title={`Remove ${company.name}?`} onClose={close}>
    <fieldset disabled={busy} className="space-y-2">
      <legend className="sr-only">Choose how to remove the company</legend>
      <label className="flex min-h-11 items-start gap-2 rounded-lg border border-line-control p-4">
        <input type="radio" name="remove-company" className="mt-1" checked={choice === 'archive'} disabled={company.archived} onChange={() => setChoice('archive')} />
        <span><span className="block font-semibold">Archive company</span>Hide this company from the active list and future visit planning. Its data and past reports stay. You can restore it from Archived companies.</span>
      </label>
      <label className="flex min-h-11 items-start gap-2 rounded-lg border border-line-control p-4">
        <input type="radio" name="remove-company" className="mt-1" checked={choice === 'delete'} onChange={() => setChoice('delete')} />
        <span><span className="block font-semibold">Delete company permanently</span>Permanently remove this company record. You can't undo this in Shutfey. Past visit reports and payment records stay.</span>
      </label>
    </fieldset>
    {error && <p role="alert" className="text-bad">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={visitButton} onClick={close} disabled={busy}>Cancel</button>
      <button type="button" className={choice === 'delete' ? dangerButton : visitButton} disabled={!choice || busy}
        onClick={() => { if (choice === 'archive') void run('archive'); else setConfirm(true); }}>
        {busy ? 'Saving…' : choice === 'archive' ? 'Archive company' : 'Continue'}
      </button>
    </div>
  </VisitSheet>;

  const guided = plan?.mode === 'guided' && (acknowledged || plan.pending === 'guided');
  const checkOnly = plan?.pending && !plan.present;
  return <VisitSheet title={`Delete ${plan?.name || company.name} permanently?`} onClose={close}>
    <p>Source: {sourceName}</p>
    <p>Past visit reports and payment records stay for 3 months and are then removed.</p>
    {error && <p role="alert" className="text-bad">{error}</p>}
    {!plan && (error
      ? <button type="button" className={visitButton} onClick={() => setReload(k => k + 1)}>Try again</button>
      : <div role="status" aria-label="Checking linked records…" className="h-16 rounded-lg bg-sunken" />)}
    {!!plan?.blockers.length && <div role="alert" className="space-y-2 rounded-lg border border-bad p-4">
      {plan.mode && <p>Reassign or clear these linked records before deleting the company.</p>}
      <ul className="list-disc space-y-2 pl-4">{plan.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
    </div>}
    {plan && (!!plan.blockers.length || error) && <button type="button" className={visitButton} disabled={busy} onClick={() => setReload(k => k + 1)}>Check again</button>}
    {sourceName === 'Google Sheets' && <p>Permanent deletion is completed in Google Sheets. If you can't identify the row with certainty, contact support before deleting anything.</p>}
    {guided && plan?.present && plan.spreadsheetUrl && !plan.blockers.length && <div className="space-y-2">
      <p>Find the row in the <strong>{plan.table}</strong> tab by its permanent ID <strong dir="auto" className="break-all">{plan.recordKey}</strong>. Delete that row, then return here and refresh company data.</p>
      <a className={`inline-flex items-center ${visitButton}`} href={plan.spreadsheetUrl} target="_blank" rel="noreferrer">Open Google Sheets</a>
    </div>}
    {!!plan?.mode && plan.present && !guided && !plan.blockers.length && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (confirmation === 'DELETE') void run('delete'); }}>
      <label className="block">Type DELETE to confirm<input className={foodInput} autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
      <button type="submit" className={dangerButton} disabled={confirmation !== 'DELETE' || busy}>{busy ? 'Saving…' : `Delete ${plan.name} permanently`}</button>
    </form>}
    {checkOnly && !plan.blockers.length && <p>Refresh company data to confirm removal.</p>}
    {(guided || checkOnly) && <button type="button" className={visitButton} disabled={busy} onClick={() => void run('refresh')}>{busy ? 'Refreshing…' : 'Refresh company data'}</button>}
    {guided && plan?.present && <button type="button" className={visitButton} disabled={busy} onClick={() => void run('cancel')}>Cancel permanent removal</button>}
    <button type="button" className={visitButton} onClick={cancel} disabled={busy}>Cancel</button>
  </VisitSheet>;
}
