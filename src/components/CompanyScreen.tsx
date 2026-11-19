import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Phone, X } from 'lucide-react';
import { FeeChoice } from './FeesSheet';
import { foodInput } from './ChecklistTemplatesScreen';
import { useVisitFocus, visitButton, visitRequest } from './FactoryVisitScreen';
import { setupField, setupPrimary } from './MappingStep';
import { SheetRecordEditor } from './SheetRecordEditor';
import { emptyContact, getCompanyInfo, getPlaceInfo, mapsUrl, saveCompanyInfo, type CompanyInfo, type Contact } from '../lib/companyInfo';
import { amountValue, getFees, leftLine, money, saveFees, type CompanyFee, type FeePlace } from '../lib/fees';
import type { SourceConnection } from '../lib/sources';
import { canEdit, providers, saveCompany } from '../lib/sourcesSetup';

type Company = { id: string; name: string; address?: string; type?: string; companyFee?: number; archived?: boolean };
const contactRoles = ['Owner', 'Manager', 'Kitchen', 'Office'];
const detailFields = [['name', 'Name'], ['address', 'Address'], ['type', 'Type']] as const;
const sectionStyle = 'space-y-4 px-4 py-5 sm:px-6';
const dangerButton = visitButton.replace('border-line-control', 'border-bad').replace('text-ink', 'text-bad');

export function CompanyScreen({ company, role, connection, yearlyCount, onClose, onSourceSaved, onRemove }: {
  key?: string; company: Company; role: string; connection: SourceConnection | null; yearlyCount: number | null;
  onClose(): void; onSourceSaved(): void; onRemove?(name: string): void;
}) {
  const root = useVisitFocus(onClose);
  const [name, setName] = useState(company.name);
  const [sourceRevision, setSourceRevision] = useState(0);
  const isAdmin = role === 'admin';
  const canWrite = isAdmin && !company.archived;
  const sheetEditing = canWrite && connection?.sourceType === 'google_sheets' &&
    (connection.sheetsEditSections?.includes('companies') || connection.sheetsFeeEditing);
  function sourceSaved(nextName?: string) {
    if (nextName) setName(nextName);
    setSourceRevision(value => value + 1);
    onSourceSaved();
  }

  return <div ref={root} role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-50 overflow-y-auto bg-paper text-ink">
    <div className="mx-auto max-w-2xl space-y-4 px-4 pt-4 pb-24">
      <header className="flex items-start gap-3">
        <button type="button" aria-label="Close" onClick={onClose} className={`${visitButton} h-11 w-11 shrink-0 px-0`}>
          <X aria-hidden="true" className="mx-auto h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h2 dir="auto" className="break-words text-2xl font-semibold">{name}</h2>
          <p className="text-ink-soft">Company screen</p>
        </div>
      </header>
      <div className="divide-y divide-line rounded-xl border border-line bg-surface tactile-1">
        {isAdmin && <section className={sectionStyle}>
          <h3 className="text-xl font-semibold">Company details</h3>
          {sheetEditing
            ? <SheetRecordEditor section="companies" row={company} inlineCompany onClose={onClose} onSaved={sourceSaved} />
            : <CompanyDetails company={company} connection={connection} editable={canWrite && canEdit(role, connection)} onSaved={sourceSaved} />}
        </section>}
        {!company.archived && <section className={sectionStyle}>
          <h3 className="text-xl font-semibold">Fees</h3>
          {isAdmin ? <CompanyFees id={company.id} yearlyCount={yearlyCount} sourceRevision={sourceRevision} />
            : <VisitFee id={company.id} />}
        </section>}
        <section className={sectionStyle}>
          <h3 className="text-xl font-semibold">{role === 'mashgiach' ? 'Location' : 'Location & contacts'}</h3>
          <CompanyLocation id={company.id} role={role} editable={canWrite} sourceRevision={sourceRevision} />
        </section>
        {onRemove && isAdmin && <section className={sectionStyle}>
          <h3 className="text-xl font-semibold">Danger zone</h3>
          <p>Permanently remove or archive this company.</p>
          <button type="button" className={dangerButton} onClick={() => onRemove(name)}>Remove company…</button>
        </section>}
      </div>
    </div>
  </div>;
}

function CompanyDetails({ company, connection, editable, onSaved }: {
  company: Company; connection: SourceConnection | null; editable: boolean; onSaved(name?: string): void;
}) {
  const [initial, setInitial] = useState({ name: company.name, address: company.address || '', type: company.type || '' });
  const [fields, setFields] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const mapping = connection?.mapping?.companies;
  const source = providers.find(provider => provider.id === connection?.sourceType)?.name;
  const changed = Object.fromEntries(detailFields.filter(([field]) => mapping?.[field] && fields[field] !== initial[field])
    .map(([field]) => [field, fields[field]]));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editable || lock.current || !fields.name.trim() || !Object.keys(changed).length) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await saveCompany(changed, company.id);
      if (result.saved !== true) throw Error("Couldn't save. Try again.");
      setInitial(fields);
      setSaved(true);
      if (result.warning) setError(result.warning);
      onSaved(fields.name);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <form className="space-y-4" onSubmit={submit}>
    {editable ? <fieldset className="space-y-4" disabled={busy}>
      {detailFields.map(([field, label]) => mapping?.[field] && <label key={field} className="block space-y-2">
        {label}<input className={setupField} dir="auto" maxLength={2000} required={field === 'name'} value={fields[field]}
          onChange={event => { setSaved(false); setFields({ ...fields, [field]: event.target.value }); }} />
      </label>)}
    </fieldset> : <dl className="space-y-2">
      {detailFields.map(([field, label]) => <div key={field}><dt className="text-sm text-ink-soft">{label}</dt><dd dir="auto" className="break-words">{fields[field] || '—'}</dd></div>)}
    </dl>}
    {(company.companyFee !== undefined || mapping?.companyFee) && <div>
      <p className="text-sm text-ink-soft">Fee</p><p>{company.companyFee === undefined ? '—' : money(company.companyFee)}</p>
    </div>}
    {editable && source && <p className="text-ink-soft">Changes are saved in your {source}.</p>}
    {!editable && !company.archived && <p className="text-ink-soft">This source is read only in Shutfey.</p>}
    {saved && <p role="status" className="text-good">Company details saved.</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
    {editable && <button type="submit" className={setupPrimary} disabled={busy || !fields.name.trim() || !Object.keys(changed).length}>
      {busy ? 'Saving…' : 'Save company details'}
    </button>}
  </form>;
}

function VisitFee({ id }: { id: string }) {
  const [fee, setFee] = useState<{ amount: number; currency: string } | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void visitRequest(`/api/visits/factories/${encodeURIComponent(id)}`)
      .then(data => { if (active) setFee(data.fee ?? null); })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id]);
  return <>
    <h4 className="font-semibold">What the mashgiach is paid</h4>
    {error ? <p role="alert" className="text-bad">{error}</p> : fee === undefined ? <p role="status">Loading fees…</p>
      : <p>{fee ? `${new Intl.NumberFormat('en-US', { style: 'currency', currency: fee.currency }).format(fee.amount)} per visit` : 'No fee set'}</p>}
  </>;
}

type FeeDraft = { company: string; mashgiach: string; per: CompanyFee['per'] };
function CompanyFees({ id, yearlyCount, sourceRevision }: { id: string; yearlyCount: number | null; sourceRevision: number }) {
  const [place, setPlace] = useState<FeePlace | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [draft, setDraft] = useState<Partial<FeeDraft>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const savedRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const revision = savedRevision.current;
    void getFees().then(data => {
      if (!active) return;
      const found = data.places.find(item => item.id === id);
      if (!found) throw Error('This place is unavailable.');
      setPlace(current => current && revision !== savedRevision.current
        ? { ...found, company: current.company, mashgiach: current.mashgiach }
        : found);
      setCanSave(data.canEdit);
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [id, sourceRevision]);
  if (!place) return error ? <p role="alert" className="text-bad">{error}</p> : <p role="status">Loading fees…</p>;

  const currentCompany = place.company ?? place.importedCompany;
  const currentMashgiach = place.mashgiach ?? place.dataFee;
  const initial: FeeDraft = { company: String(currentCompany?.amount ?? ''), mashgiach: String(currentMashgiach?.amount ?? ''), per: currentCompany?.per ?? 'visit' };
  const { company, mashgiach, per } = { ...initial, ...draft };
  const dirty = company !== initial.company || mashgiach !== initial.mashgiach || per !== initial.per;
  function feesToSave(place: FeePlace) {
    const c = amountValue(company), m = amountValue(mashgiach);
    return {
      company: c === null || (!place.company && c === place.importedCompany?.amount && per === place.importedCompany.per) ? null : { amount: c, per },
      mashgiach: m === null || (!place.mashgiach && m === place.dataFee?.amount) ? null : { amount: m },
    };
  }
  let line: string | null = null;
  try {
    const fees = feesToSave(place);
    line = leftLine(fees.company, fees.mashgiach, yearlyCount);
  } catch { /* Validation is shown on save. */ }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !canSave || !place || !dirty) return;
    lock.current = true;
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const next = feesToSave(place);
      const changes = {
        company: company === initial.company && per === initial.per ? place.company : next.company,
        mashgiach: mashgiach === initial.mashgiach ? place.mashgiach : next.mashgiach,
      };
      await saveFees(id, changes.company, changes.mashgiach);
      savedRevision.current += 1;
      setPlace(current => current && ({ ...current, ...changes }));
      setDraft({});
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function change(next: Partial<FeeDraft>) {
    setSaved(false);
    setDraft(current => ({ ...current, ...next }));
  }

  return <form className="space-y-4" onSubmit={submit}>
    <fieldset disabled={busy || !canSave} className="space-y-4">
      <div className="space-y-2">
        <h4 className="font-semibold">What the company pays</h4>
        <label className="block">Amount<input type="number" min="0" max="100000" step="0.01" className={foodInput} value={company} onChange={event => change({ company: event.target.value })} /></label>
        <div className="flex flex-wrap gap-2">{(['visit', 'month', 'year'] as const).map(value =>
          <FeeChoice key={value} selected={per === value} onClick={() => change({ per: value })}>Per {value}</FeeChoice>)}</div>
      </div>
      <div className="space-y-2">
        <h4 className="font-semibold">What the mashgiach is paid</h4>
        <label className="block">Amount per visit<input type="number" min="0" max="100000" step="0.01" className={foodInput} value={mashgiach} onChange={event => change({ mashgiach: event.target.value })} /></label>
        {!!place.mashgiachNames.length && <p dir="auto" className="break-words">{place.mashgiachNames.join(', ')}</p>}
      </div>
    </fieldset>
    {line && <p>{line}</p>}
    {saved && <p role="status" className="text-good">Fees saved.</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
    {canSave && <button type="submit" className={visitButton} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save fees'}</button>}
  </form>;
}

function CompanyLocation({ id, role, editable, sourceRevision }: { id: string; role: string; editable: boolean; sourceRevision: number }) {
  const [info, setInfo] = useState<CompanyInfo | null>(null);
  const [draft, setDraft] = useState<Partial<CompanyInfo>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const readSequence = useRef(0);
  const showContacts = role === 'admin' || role === 'coordinator';
  useEffect(() => {
    const read = ++readSequence.current;
    const request = showContacts ? getCompanyInfo(id) : getPlaceInfo(id).then(location => ({ ...location, contacts: [] }));
    void request.then(data => { if (read === readSequence.current) setInfo(data); })
      .catch(cause => { if (read === readSequence.current) setError(cause.message); });
    return () => { readSequence.current += 1; };
  }, [id, showContacts, sourceRevision]);
  if (!info) return error ? <p role="alert" className="text-bad">{error}</p> : <p role="status">Loading company info…</p>;

  const { address, phone, contacts } = { ...info, ...draft };
  const patch = {
    ...(address !== info.address && { address }),
    ...(phone !== info.phone && { phone }),
    ...(JSON.stringify(contacts) !== JSON.stringify(info.contacts) && { contacts }),
  };
  const valid = contacts.every(contact => contact.name.trim() && contact.role.trim());
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editable || lock.current || !valid || !Object.keys(patch).length) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await saveCompanyInfo(id, patch);
      readSequence.current += 1;
      setInfo(result);
      setDraft({});
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function change(next: Partial<CompanyInfo>) {
    setSaved(false);
    setDraft(current => ({ ...current, ...next }));
  }
  function changeContact(index: number, next: Partial<Contact>) {
    change({ contacts: contacts.map((contact, i) => i === index ? { ...contact, ...next } : contact) });
  }

  return <form className="space-y-4" onSubmit={submit}>
    {editable ? <fieldset disabled={busy} className="space-y-4">
      <label className="block">Address<input dir="auto" maxLength={200} className={foodInput} value={address} onChange={event => change({ address: event.target.value })} /></label>
      <label className="block">Place phone<input type="tel" maxLength={40} className={foodInput} value={phone} onChange={event => change({ phone: event.target.value })} /></label>
    </fieldset> : <dl className="space-y-2">
      <div><dt className="text-sm text-ink-soft">Address</dt><dd dir="auto" className="break-words">{address || '—'}</dd></div>
      <div><dt className="text-sm text-ink-soft">Place phone</dt><dd className="break-words">{phone || '—'}</dd></div>
    </dl>}
    {(address || phone) && <div className="flex flex-wrap gap-2">
      {address && <a className={`${visitButton} inline-flex items-center gap-2`} href={mapsUrl(address)} target="_blank" rel="noreferrer">
        <MapPin aria-hidden="true" className="h-5 w-5 shrink-0" />Open in Maps
      </a>}
      {phone && <a className={`${visitButton} inline-flex min-w-0 items-center gap-2 break-all`} href={`tel:${phone}`}>
        <Phone aria-hidden="true" className="h-5 w-5 shrink-0" />{phone}
      </a>}
    </div>}
    {showContacts && <>
      <h4 className="font-semibold">Contacts</h4>
      {!contacts.length && <p className="text-ink-soft">No contacts yet</p>}
      {contacts.map((contact, index) => editable ?
        <fieldset key={contact.id ?? index} disabled={busy} className="min-w-0 space-y-2 rounded-lg border border-line p-4">
          <legend dir="auto" className="max-w-full break-words px-1">{contact.name || 'Contact'}</legend>
          <label className="block">Name<input dir="auto" required maxLength={80} className={foodInput} value={contact.name} onChange={event => changeContact(index, { name: event.target.value })} /></label>
          <label className="block">Role<select className={foodInput}
            value={contactRoles.includes(contact.role) ? contact.role : 'Other'}
            onChange={event => changeContact(index, { role: event.target.value === 'Other' ? '' : event.target.value })}>
            {contactRoles.map(value => <option key={value}>{value}</option>)}<option>Other</option>
          </select></label>
          {!contactRoles.includes(contact.role) && <label className="block">Other role<input dir="auto" required maxLength={40} className={foodInput}
            value={contact.role} onChange={event => changeContact(index, { role: event.target.value })} /></label>}
          <label className="block">Email<input type="email" maxLength={200} className={foodInput} value={contact.email} onChange={event => changeContact(index, { email: event.target.value })} /></label>
          <label className="block">Phone<input type="tel" maxLength={40} className={foodInput} value={contact.phone} onChange={event => changeContact(index, { phone: event.target.value })} /></label>
          <button type="button" className={visitButton} onClick={() => change({ contacts: contacts.filter((_, i) => i !== index) })}>Delete contact</button>
        </fieldset> :
        <div key={contact.id ?? index} className="space-y-2 rounded-lg border border-line p-4">
          <p dir="auto" className="break-words font-semibold">{contact.name}</p>
          <p dir="auto" className="break-words">{contact.role}</p>
          {contact.email && <a className="block min-h-11 break-words" href={`mailto:${contact.email}`}>{contact.email}</a>}
          {contact.phone && <a className="block min-h-11 break-words" href={`tel:${contact.phone}`}>{contact.phone}</a>}
        </div>)}
      {editable && <button type="button" className={visitButton} disabled={busy || contacts.length >= 20}
        onClick={() => change({ contacts: [...contacts, emptyContact()] })}>Add contact</button>}
      {contacts.length >= 20 && <p>Maximum 20 contacts.</p>}
    </>}
    {saved && <p role="status" className="text-good">Contacts saved.</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
    {editable && <button type="submit" className={visitButton} disabled={busy || !valid || !Object.keys(patch).length}>{busy ? 'Saving…' : 'Save contacts'}</button>}
  </form>;
}
