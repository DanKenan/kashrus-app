import React, { useEffect, useRef, useState } from 'react';
import { VisitSheet } from './FactoryVisitScreen';
import { setupField, setupPrimary } from './MappingStep';
import { sourceButton } from './SourceConnectSheet';
import { SheetEditHelpContent } from './SheetEditHelp';
import { isBuiltinFieldKey, type SourceSection, type ValueRule } from '../lib/sourcePreview';
import { parseMoney } from '../lib/sourceAmount';
import { sourceRequest } from '../lib/sources';
import { readAgain } from '../lib/sourcesSetup';

const labels: Record<string, string> = {
  name: 'Name', address: 'Address', type: 'Type', brand: 'Brand', plant: 'Plant',
  companyFee: 'Fee', mashgiachFee: 'Supervision fee', companyLink: 'Associated companies',
  certification: 'Certification', agency: 'Certifying agency', status: 'Kosher status',
  expiresOn: 'Expiration date', code: 'Code / UPC', symbolRequired: 'Symbol required',
};
export const sheetSectionNames = { companies: 'Companies', ingredients: 'Schedule A', products: 'Schedule B' };
const recordNames = { companies: 'company', ingredients: 'ingredient', products: 'product' };
type Value = string | number | boolean | string[];
type Field = { field: string; header: string; rule: ValueRule; value: Value; readOnly?: string; choices?: string[]; revision: string };
type Row = { id: string; name: string };
type Company = Row & { key: string };
type Editor = { fields: Field[]; companies: Company[]; addScope?: string[] };
const addStorageKey = (data: Editor) => 'shutfey-sheet-add:' + JSON.stringify(data.addScope);

export function SheetRecordList({ section, onChoose, onAdd, onClose }: {
  section: SourceSection; onChoose(row: Row): void; onAdd(): void; onClose(): void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void sourceRequest('/api/sources/sheet-editor/' + section).then(result => {
      if (active) setRows(result.rows.sort((a: Row, b: Row) => a.name.localeCompare(b.name)));
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [section]);
  const matching = rows?.filter(row => row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <VisitSheet title={sheetSectionNames[section]} onClose={onClose}>
    <button type="button" className={sourceButton} onClick={onAdd}>Add {recordNames[section]}</button>
    <label className="block space-y-2">Search {sheetSectionNames[section]}<input type="search" className={setupField} value={search} onChange={e => setSearch(e.target.value)} /></label>
    {error && <p role="alert" className="text-bad">{error}</p>}
    {!rows && !error && <p role="status">Loading records…</p>}
    {matching?.length === 0 && <p>No matching records.</p>}
    {!!matching?.length && <ul className="space-y-2">{matching.map(row => <li key={row.id}>
      <button type="button" dir="auto" className={`${sourceButton} w-full break-words text-start`} onClick={() => onChoose(row)}>{row.name || row.id}</button>
    </li>)}</ul>}
  </VisitSheet>;
}

function CompanySelector({ label, companies, selected, onChange }: {
  label: string; companies: Company[]; selected: string[]; onChange(value: string[]): void;
}) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  return <fieldset className="space-y-2 rounded-lg border border-line p-3">
    <legend className="px-1">{label}</legend>
    <label className="block space-y-2">Search companies<input className={setupField} value={search} onChange={e => setSearch(e.target.value)} /></label>
    <p className="text-sm text-ink-soft" aria-live="polite">{selected.length} selected</p>
    <div className="max-h-56 overflow-y-auto">
      {companies.filter(company => selected.includes(company.id) || [company.name, company.key].some(value => value?.toLocaleLowerCase().includes(query))).map(company => (
        <label key={company.id} className="flex min-h-11 items-center gap-2 break-all">
          <input type="checkbox" checked={selected.includes(company.id)} onChange={e => onChange(e.target.checked ?
            [...selected, company.id] : selected.filter(id => id !== company.id))} />
          <span dir="auto">{company.name} <span className="text-sm text-ink-soft">({company.key})</span></span>
        </label>
      ))}
    </div>
  </fieldset>;
}

function FieldInput({ section, field, value, companies, onChange }: {
  section: SourceSection; field: Field; value: Value; companies: Company[]; onChange(value: Value): void;
}) {
  const builtIn = isBuiltinFieldKey(section, field.field) ||
    (section === 'companies' && ['address', 'companyFee', 'mashgiachFee'].includes(field.field));
  const label = builtIn ? labels[field.field] : field.field;
  if (field.readOnly) return <p className="break-words">{label} · <span className="text-ink-soft">{field.readOnly}</span></p>;
  if (field.choices) return <label className="block space-y-2">
    {label}
    <select className={setupField} value={String(value)} onChange={e => onChange(e.target.value)}>
      {!field.choices.includes(String(value)) && <option value={String(value)} disabled>{String(value) || 'Choose a type'}</option>}
      {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
    </select>
  </label>;
  if (field.rule === 'companyLink') return <CompanySelector label={label} companies={companies} selected={value as string[]} onChange={onChange} />;
  if (field.rule === 'boolean') return <label className="flex min-h-11 items-center gap-2">
    <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />{label}
  </label>;
  return <label className="block space-y-2">
    {label}
    {field.rule === 'text' && !(section === 'products' && field.field === 'code')
      ? <textarea rows={1} dir="auto" className={setupField} value={String(value)} maxLength={2000}
          required={field.field === 'name'} onChange={e => onChange(e.target.value)} />
      : <input className={setupField} type={field.rule === 'date' ? 'date' : 'text'}
          inputMode={field.rule === 'money' ? 'decimal' : undefined} value={String(value)} onChange={e => onChange(e.target.value)} />}
  </label>;
}

export function SheetRecordEditor({ section, row, onClose, onSaved }: {
  section: SourceSection; row?: Row; onClose(): void; onSaved(): void;
}) {
  const adding = !row;
  const path = `/${section}/${row ? encodeURIComponent(row.id) : 'new'}`;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [busy, setBusy] = useState(false);
  const [pendingToken, setPendingToken] = useState('');
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const fetchEditor = (): Promise<Editor> => sourceRequest('/api/sources/sheet-editor' + path);
  useEffect(() => {
    let active = true;
    void fetchEditor().then(data => {
      if (!active) return;
      setEditor(data);
      if (data.addScope) {
        try { setPendingToken(sessionStorage.getItem(addStorageKey(data)) ?? ''); } catch { /* Storage may be unavailable. */ }
      }
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [path]);

  const changed = editor?.fields.filter(({ field, readOnly, value }) =>
    !readOnly && Object.hasOwn(draft, field) && (Array.isArray(value)
      ? JSON.stringify([...value].sort()) !== JSON.stringify([...(draft[field] as string[])].sort())
      : String(draft[field]) !== String(value))) ?? [];

  function rememberAdd(token: string) {
    setPendingToken(token);
    if (!editor?.addScope) return;
    try {
      if (token) sessionStorage.setItem(addStorageKey(editor), token);
      else sessionStorage.removeItem(addStorageKey(editor));
    } catch { /* The open editor still retains the token. */ }
  }

  async function saveAdd() {
    if (lock.current || notice || !editor) return;
    if (!pendingToken && (typeof draft.name !== 'string' || !draft.name.trim())) {
      setError('Enter a name.');
      return;
    }
    const entries = editor.fields.filter(({ field }) => Object.hasOwn(draft, field))
      .map(({ field, rule }) => [field, rule === 'money' ? parseMoney(draft[field]) : draft[field]] as const);
    if (!pendingToken && entries.some(([, value]) => value === undefined)) { setError('Enter a valid amount.'); return; }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const token = pendingToken || crypto.randomUUID();
      if (!pendingToken) rememberAdd(token);
      const result = await sourceRequest('/api/sources/rows/' + section, 'POST', {
        token, ...(pendingToken ? {} : { fields: Object.fromEntries(entries) }),
      });
      if (result.saved !== true) throw Error();
      rememberAdd('');
      onSaved();
      if (result.warning) setNotice(result.warning);
      else onClose();
    } catch (cause) {
      const status = (cause as { status?: number } | null)?.status;
      if (status === 400) rememberAdd('');
      setError(!status || status >= 500
        ? 'The new record could not be confirmed. It may already be in Google Sheets. Check again or review the sheet.'
        : cause instanceof Error ? cause.message : "Couldn't save. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (adding) return saveAdd();
    if (lock.current || review || notice || !changed.length) return;
    const entries = changed.map(({ field, rule }) => [field, rule === 'money' ? parseMoney(draft[field]) : draft[field]] as const);
    if (entries.some(([, value]) => value === undefined)) { setError('Enter a valid amount.'); return; }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await sourceRequest('/api/sources/rows' + path, 'PATCH', {
        fields: Object.fromEntries(entries),
        expected: Object.fromEntries(changed.map(({ field, revision }) => [field, revision])),
      });
      if (result.saved !== true) throw Error();
      onSaved();
      if (result.warning) {
        if (result.refreshRequired) {
          setReview(true);
          setError(result.warning);
        } else setNotice(result.warning);
      } else onClose();
    } catch (cause) {
      const status = (cause as { status?: number } | null)?.status;
      const uncertain = !status || status >= 500;
      setReview(uncertain || status === 409);
      setError(uncertain ? 'The change could not be confirmed. The sheet may already have changed. Refresh and review.'
        : cause instanceof Error ? cause.message : "Couldn't save. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function refreshForReview() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (!(await readAgain()).ok) throw Error('Refresh failed. Review the connected sheet before editing.');
      setEditor(await fetchEditor());
      setDraft({});
      setReview(false);
      setError('');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Refresh failed.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <VisitSheet title={`${adding ? 'Add' : 'Edit'} ${recordNames[section]}`} onClose={() => { if (!lock.current) onClose(); }}>
    {row && <p dir="auto" className="break-words">{row.name}</p>}
    <details className="rounded-lg border border-line bg-sunken p-3">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold focus-visible:ring-2 focus-visible:ring-gold">? About Google Sheets editing</summary>
      <SheetEditHelpContent />
    </details>
    {error && <p role="alert" className="break-words text-bad">{error}</p>}
    {notice && <p role="status" className="break-words text-warn">{notice}</p>}
    {adding && pendingToken && !error && <p role="status">Check whether Google Sheets saved the new record.</p>}
    {!editor && !error && <p role="status">Loading fields…</p>}
    {editor && <form onSubmit={save} className="space-y-4">
      <fieldset disabled={busy || review || !!notice || !!pendingToken} className="space-y-4">
        {editor.fields.map(field => <div key={field.field}>
          <FieldInput section={section} field={field} value={Object.hasOwn(draft, field.field) ? draft[field.field] : field.value}
            companies={editor.companies} onChange={value => setDraft(previous => ({ ...previous, [field.field]: value }))} />
        </div>)}
      </fieldset>
      {adding ? !notice && <button type="submit" className={setupPrimary} disabled={busy}>{busy
        ? (pendingToken ? 'Checking…' : 'Saving…') : pendingToken ? 'Check again' : `Add ${recordNames[section]}`}</button>
        : review ? <button type="button" className={setupPrimary} disabled={busy} onClick={() => void refreshForReview()}>{busy ? 'Refreshing…' : 'Refresh for review'}</button>
        : !notice && <button type="submit" className={setupPrimary} disabled={busy || !changed.length}>{busy ? 'Saving…' : `Save ${recordNames[section]}`}</button>}
    </form>}
  </VisitSheet>;
}
