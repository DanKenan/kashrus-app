import React, { useEffect, useRef, useState } from 'react';
import { visitButton, VisitSheet, visitRequest } from './FactoryVisitScreen';
import { setupField } from './MappingStep';
import { CertificatePanel } from './CertificatePanel';
import type { SourceAttachment } from '../lib/sources';
type Value = string | boolean | null;
type EditorData = { fields: Record<string, Value>; typeOptions: Record<string, string[]>; fieldTypes: Record<string,string>;
  addScope?: string[]; pending?: {name?:string; recordId?:string};
  baseId: string; updatedAt: string; companyIds: string[]; warnings: string[]; linked?: {id:string;name:string}[]; existing?: {id:string; name:string; brand?:string; plant?:string}[] };
const labels: Record<string,string> = { name:'Name', status:'Status', certification:'Certification / certifying agency', agency:'Certifying kosher agency',
  code:'Code / UPC', symbolRequired:'Symbol required', expiresOn:'Expiration date', brand:'Brand', plant:'Plant' };
// Keep the operation token across dialog closes, including when tab storage is unavailable.
const pendingAdds = new Map<string, string>();
function rememberAdd(key:string, token:string) {
  if (token) pendingAdds.set(key, token);
  else pendingAdds.delete(key);
  try {
    if (token) sessionStorage.setItem(key, token);
    else sessionStorage.removeItem(key);
  } catch {}
}
export function CompanyItemEditor({path, id, ingredient, files, writable = true, recovery = false, onClose, onSaved}: {
  path:string; id?:string; writable?:boolean; recovery?:boolean; ingredient:boolean; files?:SourceAttachment[]; onClose():void; onSaved(message:string):void;
}) {
  const [baseline,setBaseline] = useState<EditorData | null>(null);
  const [draft,setDraft] = useState<Record<string,Value>>({});
  const [mode,setMode] = useState<'create'|'existing'|'remove'>('create');
  const [selected,setSelected] = useState(''), [relation,setRelation] = useState<EditorData | null>(null);
  const [busy,setBusy] = useState(false), [review,setReview] = useState(false), [error,setError] = useState('');
  const [requested,setRequested] = useState<Record<string,Value> | null>(null);
  const [conflicts,setConflicts] = useState<string[]>([]);
  const [duplicatesAcknowledged,setDuplicatesAcknowledged] = useState(false);
  const [uncertainAdd,setUncertainAdd] = useState(false);
  const lock = useRef(false), operation = useRef(crypto.randomUUID());
  const label = ingredient ? 'ingredient' : 'product';
  const row = path + '/' + encodeURIComponent(id || selected);
  const endpoint = id ? row + '/edit' : path + '/add';
  const storageKey = (data:EditorData) => JSON.stringify(['company-item-add', path, ...(data.addScope ?? [])]);
  async function load() {
    setBusy(true);
    try {
      let next: EditorData = await visitRequest(endpoint);
      if (!id) {
        const key = storageKey(next);
        let token = pendingAdds.get(key);
        try { token ||= sessionStorage.getItem(key) || undefined; } catch {}
        if (token) {
          next = await visitRequest(endpoint + '?operationId=' + encodeURIComponent(token));
          if (next.pending) operation.current = token;
          else rememberAdd(key, '');
        }
        setUncertainAdd(!!next.pending);
      }
      if (baseline && (baseline.baseId !== next.baseId || baseline.updatedAt !== next.updatedAt)) throw Error('The source connection changed. Reopen the record.');
      setBaseline(next); setRelation(null); setSelected(''); setError(''); setReview(false);
      setDuplicatesAcknowledged(false);
      if (requested) {
        const divergent = Object.keys(requested).filter(key => next.fields[key] !== requested[key]);
        setConflicts(divergent);
        setDraft({});
      }
      if (!next.pending) operation.current = crypto.randomUUID();
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
  const changed = requested ?? Object.fromEntries(Object.entries(draft).filter(([key,value]) => value !== baseline?.fields[key]));
  const matches = baseline?.linked?.filter(item => baseline.pending?.recordId
    ? item.id === baseline.pending.recordId : item.name === baseline.pending?.name) ?? [];
  const needsDuplicateReview = !!baseline?.pending && !baseline.pending.recordId;
  const editBlocked = !writable || busy || review || conflicts.length > 0;
  async function save() {
    if (!baseline || editBlocked || lock.current || uncertainAdd || (mode === 'create' && !Object.keys(changed).length)) return;
    lock.current = true; setBusy(true); setError('');
    const linking = mode === 'existing' || mode === 'remove';
    try {
      const b = mode === 'existing' ? relation : baseline;
      if (!b) return;
      const request = { baseId: b.baseId, updatedAt: b.updatedAt, ...(linking ? {companyIds:b.companyIds}
        : { fields: changed, originals: Object.fromEntries(Object.keys(changed).map(k => [k,b.fields[k]])), operationId: operation.current }) };
      const dest = linking ? row + (mode === 'remove' ? '/unlink' : '/restore') : id ? row : path;
      if (!id && !linking) rememberAdd(storageKey(b), operation.current);
      const result = await visitRequest(dest, {method: id && !linking ? 'PATCH' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request)});
      if (!result.saved) throw Error('Save could not be confirmed.');
      if (!id && !linking) rememberAdd(storageKey(b), '');
      if (id && !linking && result.refreshRequired) {
        setRequested(changed); setReview(true); setError(result.warning); onSaved(result.warning);
        return;
      }
      onSaved(result.warning || (mode === 'remove' ? 'Item removed from this company. Its Airtable record was kept.' : mode === 'existing' ? 'Item restored to this company.' : id ? 'Changes saved in Airtable.' : 'Item added to Airtable.'));
      onClose();
    } catch (cause: any) {
      if (id && !linking && (!cause.status || cause.message.includes('may have saved'))) setRequested(changed);
      if (!id && !linking) {
        if (!cause.status || cause.status >= 500 || cause.message.includes('may have created')) setUncertainAdd(true);
        else rememberAdd(storageKey(baseline), '');
      }
      setReview(!cause.status || cause.status === 409 || cause.status >= 500);
      setError(cause.status ? cause.message : !id && !linking ? 'Airtable may have created this item. Reload and review before trying again.' : 'Airtable may have saved these changes. Reload and review before retrying.');
    } finally { lock.current = false; setBusy(false); }
  }
  async function reconcile(decision:'accept'|'abandon', recordId?:string) {
    if (!baseline || !writable || lock.current) return;
    if (decision === 'accept' && needsDuplicateReview && !duplicatesAcknowledged) return;
    lock.current = true; setBusy(true);
    try {
      const result = await visitRequest(path + '/reconcile', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({decision, recordId, ...(decision === 'accept' && needsDuplicateReview && {
          duplicatesAcknowledged, reviewedIds:matches.map(item => item.id)
        }), operationId:operation.current, baseId:baseline.baseId, updatedAt:baseline.updatedAt})});
      if (!(decision === 'accept' ? result.saved : result.abandoned)) throw Error('Reload and review the record.');
      rememberAdd(storageKey(baseline), '');
      if (result.saved) onSaved(result.warning || 'Item added to Airtable.');
      onClose();
    } catch (cause:any) { setError(cause.message); setReview(true); }
    finally { lock.current = false; setBusy(false); }
  }
  return <VisitSheet title={(id ? 'Edit ' : 'Add ') + label} onClose={() => { if (!busy) onClose(); }}>
    {!baseline && busy && <p role="status">Loading record…</p>}
    {baseline && <>
      {uncertainAdd && !review && <section><h3 className="font-semibold">Review linked records in Airtable</h3>
        {needsDuplicateReview && <label className="block"><input type="checkbox" checked={duplicatesAcknowledged} disabled={busy || !writable}
          onChange={e => setDuplicatesAcknowledged(e.target.checked)} /> I reviewed all matching linked records and understand that duplicates may exist.</label>}
        <ul>{matches.map(i =>
          <li key={i.id}>{i.name} · {i.id} <button className={visitButton} disabled={busy || !writable || needsDuplicateReview && !duplicatesAcknowledged} onClick={() => reconcile('accept',i.id)}>Accept linked record</button></li>)}</ul>
        <button className={visitButton} disabled={busy || !writable} onClick={() => reconcile('abandon')}>Abandon Add</button></section>}
      {!id && !uncertainAdd && <div className="flex flex-wrap gap-2">{(['create','existing'] as const).map(option =>
        <button className={visitButton} disabled={editBlocked} key={option} aria-pressed={mode === option} onClick={() => setMode(option)}>
          {option === 'create' ? 'Create new ' + label : 'Add existing'}</button>)}</div>}
      {mode === 'existing' ? <label className="block">Add existing {label}<select className={setupField} disabled={editBlocked} value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Choose an existing {label}</option>{baseline.existing?.map(item => <option key={item.id} value={item.id}>{[item.name,item.brand,item.plant,item.id].filter(Boolean).join(' · ')}</option>)}
      </select></label> : mode === 'remove' ? <p>Remove this {label} from this company? Its Airtable record, documents and other company links will be kept.</p> :
        <fieldset className="space-y-3" disabled={editBlocked || uncertainAdd}>
          {baseline.companyIds.length > 1 && <p>This record is shared. Changes are visible to every linked company.</p>}
          {baseline.warnings?.map(w => <p key={w}>{w}</p>)}
          {Object.keys(baseline.fields).map(key => {
            const change = (v:Value) => { setRequested(null); setDraft(prev => ({...prev,[key]:v})); };
            const value = String(fields[key] ?? '');
            const common = {className:setupField, required:key === 'name', value, onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>) => change(e.target.value || null)};
            return <label key={key} className="block">{labels[key] || key}
              {baseline.fieldTypes[key] === 'checkbox' ? <input className="ml-3 min-h-11" type="checkbox" checked={fields[key] === true} onChange={e => change(e.target.checked)} />
              : baseline.typeOptions[key] ? <select {...common}><option value=""></option>{baseline.typeOptions[key].map(v => <option key={v}>{v}</option>)}</select>
              : baseline.fieldTypes[key] === 'multilineText' ? <textarea {...common} maxLength={2000} />
              : <input {...common} type={key === 'expiresOn' ? 'date' : 'text'} maxLength={2000} />}
              {id && !conflicts.length && key in changed && <span className="text-sm text-ink-soft">Original: {String(baseline.fields[key] ?? '—')}</span>}
            </label>;
          })}
        </fieldset>}
      {!!conflicts.length && <section role="alert">
        <p>This field changed again in Airtable after your save. Review the new value before making another change.</p>
        <ul>{conflicts.map(key => <li key={key}>{labels[key] || key} · Requested: {String(requested?.[key] ?? '—')} · Current: {String(baseline.fields[key] ?? '—')}</li>)}</ul>
        <button className={visitButton} onClick={() => { setRequested(null); setConflicts([]); }}>Use current Airtable values</button>
      </section>}
      {id && !recovery && ingredient && mode === 'create' && <CertificatePanel path={row+'/documents'} files={files} writable={writable} onSaved={() => onSaved('PDF saved in Airtable.')} />}
      {id && !recovery && mode === 'create' && <details><summary className="min-h-11">More actions</summary><button className={visitButton} disabled={editBlocked} onClick={() => setMode('remove')}>Remove from this company</button></details>}
      {!uncertainAdd && <button className={visitButton} disabled={editBlocked || (mode === 'existing' ? !relation : mode === 'create' && (!String(fields.name ?? '').trim() || !Object.keys(changed).length))} onClick={save}>
        {busy ? 'Saving…' : mode === 'existing' ? 'Restore to this company' : mode === 'remove' ? 'Remove from this company' : 'Save changes'}</button>}
    </>}
    {error && <p role="alert">{error}</p>}
    {(review || !baseline && error) && <button className={visitButton} disabled={busy} onClick={load}>Reload and review</button>}
  </VisitSheet>;
}
