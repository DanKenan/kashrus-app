import React, { useEffect, useRef, useState } from 'react';
import { visitButton, VisitSheet, visitRequest } from './FactoryVisitScreen';
import { setupField } from './MappingStep';
import { CertificatePanel } from './CertificatePanel';
import type { SourceAttachment } from '../lib/sources';
type Value = string | boolean | null;
type EditorData = { fields: Record<string, Value>; typeOptions: Record<string, string[]>; fieldTypes: Record<string,string>;
  baseId: string; updatedAt: string; companyIds: string[]; warnings: string[]; linked?: {id:string;name:string}[]; existing?: {id:string; name:string; brand?:string; plant?:string}[] };
const labels: Record<string,string> = { name:'Name', status:'Status', certification:'Certification / certifying agency', agency:'Certifying kosher agency',
  code:'Code / UPC', symbolRequired:'Symbol required', expiresOn:'Expiration date', brand:'Brand', plant:'Plant' };
export function CompanyItemEditor({path, id, ingredient, files, writable = true, onClose, onSaved}: {
  path:string; id?:string; writable?:boolean; ingredient:boolean; files?:SourceAttachment[]; onClose():void; onSaved(message:string):void;
}) {
  const [baseline,setBaseline] = useState<EditorData | null>(null);
  const [draft,setDraft] = useState<Record<string,Value>>({});
  const [mode,setMode] = useState<'create'|'existing'|'remove'>('create');
  const [selected,setSelected] = useState(''), [relation,setRelation] = useState<EditorData | null>(null);
  const [busy,setBusy] = useState(false), [review,setReview] = useState(false), [error,setError] = useState('');
  const [verifyDraft,setVerifyDraft] = useState(false);
  const [uncertainAdd,setUncertainAdd] = useState(false);
  const lock = useRef(false), operation = useRef(crypto.randomUUID());
  const label = ingredient ? 'ingredient' : 'product';
  const row = path + '/' + encodeURIComponent(id || selected);
  const endpoint = id ? row + '/edit' : path + '/add';
  async function load() {
    setBusy(true);
    try {
      const next = await visitRequest(endpoint);
      if (baseline && (baseline.baseId !== next.baseId || baseline.updatedAt !== next.updatedAt)) throw Error('The source connection changed. Reopen the record.');
      setBaseline(next); setRelation(null); setSelected(''); setError(''); setReview(false);
      if (!uncertainAdd) operation.current = crypto.randomUUID();
    } catch (cause: any) { setError(cause.status && cause.status < 500 ? cause.message : "Couldn't load the latest record from Airtable. Editing is unavailable until the connection works."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [endpoint]);
  useEffect(() => {
    let active = true;
    setRelation(null);
    if (selected) visitRequest(row + '/relationship').then(data => { if (active) setRelation(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [selected, row]);
  const fields = {...baseline?.fields, ...draft};
  const changed = Object.fromEntries(Object.entries(draft).filter(([key,value]) => verifyDraft || value !== baseline?.fields[key]));
  async function save() {
    if (!writable || !baseline || lock.current || review) return;
    lock.current = true; setBusy(true); setError('');
    const linking = mode === 'existing' || mode === 'remove';
    try {
      const b = mode === 'existing' ? relation : baseline;
      if (!b) return;
      const request = { baseId: b.baseId, updatedAt: b.updatedAt, ...(linking ? {companyIds:b.companyIds}
        : { fields: changed, originals: Object.fromEntries(Object.keys(changed).map(k => [k,b.fields[k]])), operationId: operation.current }) };
      const dest = linking ? row + (mode === 'remove' ? '/unlink' : '/restore') : id ? row : path;
      const result = await visitRequest(dest, {method: id && !linking ? 'PATCH' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request)});
      if (!result.saved) throw Error('Save could not be confirmed.');
      onSaved(result.warning || (mode === 'remove' ? 'Item removed from this company. Its Airtable record was kept.' : mode === 'existing' ? 'Item restored to this company.' : id ? 'Changes saved in Airtable.' : 'Item added to Airtable.'));
      onClose();
    } catch (cause: any) {
      if (id && !linking && (!cause.status || cause.message.includes('may have saved'))) setVerifyDraft(true);
      if (!id && !linking && (!cause.status || cause.message.includes('may have created'))) setUncertainAdd(true);
      setReview(!cause.status || cause.status === 409 || cause.status >= 500);
      setError(cause.status ? cause.message : !id && !linking ? 'Airtable may have created this item. Reload and review before trying again.' : 'Airtable may have saved these changes. Reload and review before retrying.');
    } finally { lock.current = false; setBusy(false); }
  }
  return <VisitSheet title={(id ? 'Edit ' : 'Add ') + label} onClose={() => { if (!busy) onClose(); }}>
    {!baseline && busy && <p role="status">Loading record…</p>}
    {baseline && <>
      {uncertainAdd && !review && <section><h3 className="font-semibold">Review linked records in Airtable</h3>
        <ul>{baseline.linked?.filter(i => i.name === draft.name).map(i => <li key={i.id}>{i.name} · {i.id}</li>)}</ul>
        <p>The original operation ID will be used to check this Add.</p></section>}
      {!id && <div className="flex flex-wrap gap-2">{(['create','existing'] as const).map(option =>
        <button className={visitButton} disabled={!writable || busy || review} key={option} aria-pressed={mode === option} onClick={() => setMode(option)}>
          {option === 'create' ? 'Create new ' + label : 'Add existing'}</button>)}</div>}
      {mode === 'existing' ? <label className="block">Add existing {label}<select className={setupField} disabled={!writable || busy || review} value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Choose an existing {label}</option>{baseline.existing?.map(item => <option key={item.id} value={item.id}>{[item.name,item.brand,item.plant,item.id].filter(Boolean).join(' · ')}</option>)}
      </select></label> : mode === 'remove' ? <p>Remove this {label} from this company? Its Airtable record, documents and other company links will be kept.</p> :
        <fieldset className="space-y-3" disabled={!writable || busy || review || uncertainAdd}>
          {baseline.companyIds.length > 1 && <p>This record is shared. Changes are visible to every linked company.</p>}
          {baseline.warnings?.map(w => <p key={w}>{w}</p>)}
          {Object.keys(baseline.fields).map(key => {
            const change = (v:Value) => { setVerifyDraft(false); setDraft(prev => ({...prev,[key]:v})); };
            const value = String(fields[key] ?? '');
            const common = {className:setupField, required:key === 'name', value, onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>) => change(e.target.value || null)};
            return <label key={key} className="block">{labels[key] || key}
              {baseline.fieldTypes[key] === 'checkbox' ? <input className="ml-3 min-h-11" type="checkbox" checked={fields[key] === true} onChange={e => change(e.target.checked)} />
              : baseline.typeOptions[key] ? <select {...common}><option value=""></option>{baseline.typeOptions[key].map(v => <option key={v}>{v}</option>)}</select>
              : baseline.fieldTypes[key] === 'multilineText' ? <textarea {...common} maxLength={2000} />
              : <input {...common} type={key === 'expiresOn' ? 'date' : 'text'} maxLength={2000} />}
              {id && key in changed && <span className="text-sm text-ink-soft">Original: {String(baseline.fields[key] ?? '—')}</span>}
            </label>;
          })}
        </fieldset>}
      {id && ingredient && mode === 'create' && <CertificatePanel path={row+'/documents'} files={files} writable={writable} onSaved={() => onSaved('PDF saved in Airtable.')} />}
      {id && mode === 'create' && <details><summary className="min-h-11">More actions</summary><button className={visitButton} disabled={!writable || busy || review} onClick={() => setMode('remove')}>Remove from this company</button></details>}
      <button className={visitButton} disabled={!writable || busy || review || (mode === 'existing' ? !relation : mode === 'create' && (!String(fields.name ?? '').trim() || !Object.keys(changed).length))} onClick={save}>
        {busy ? 'Saving…' : uncertainAdd ? 'Check Add outcome' : mode === 'existing' ? 'Restore to this company' : mode === 'remove' ? 'Remove from this company' : 'Save changes'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {(review || !baseline && error) && <button className={visitButton} disabled={busy} onClick={load}>Reload and review</button>}
  </VisitSheet>;
}
