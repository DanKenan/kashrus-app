import React, { useEffect, useRef, useState } from 'react';
import { mappingReady, type SourceAttachment, type SourceConnection } from '../lib/sources';
import { airtableMappingCopy } from '../lib/sourcePreview';
import { CertificatePanel } from './CertificatePanel';
import { CompanyItemEditor } from './CompanyItemEditor';
import { VisitSheet, visitButton, visitRequest } from './FactoryVisitScreen';
import { setupField } from './MappingStep';

export type CompanyItemList = 'ingredients' | 'products';
type List = CompanyItemList;
type Row = { id:string; name:string; brand?:string; plant?:string; certifyingAgency?:string; statusRaw?:string; expiresOn?:string;
  dpm?:string; code?:string; symbolRequired?:boolean; symbolRaw?:string; attachments?:SourceAttachment[] };
type Lists = Record<List,Row[]> & { flexibleMapping?: boolean; connectedLists?: Record<List | 'contacts', boolean>;
  mappingWrites?: Record<List, boolean>; mappingIssues?: {entity:string;field?:string;message:string}[] } & { company?: {name:string; address?:string; type?:string}; attachments?:SourceAttachment[]; access:string; sourceType:string; status:string; recovery?:boolean; savedAt?:string };
const titles = { ingredients:'Ingredients', products:'Products' };
const noun = { ingredients:'ingredient', products:'product' };
const writableItems = (source: { sourceType: string | null; access?: string; status?: string }) =>
  source.sourceType === 'airtable' && source.access === 'readwrite' && source.status === 'ok';

export function itemListEditor(role: string, connection: SourceConnection | null, list: List) {
  if (role !== 'admin' || !connection) return undefined;
  if (connection.sheetsEditSections?.includes(list)) return 'sheet';
  if (connection.mapping?.version === 2 && !connection.mapping.entities?.some(entity => entity.kind === noun[list])) return undefined;
  if (writableItems(connection) && connection.mapping && mappingReady(connection.mapping)) return 'company';
}

export function ItemAgency({ agency }: { agency?:string }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Certifying kosher agency</p>
    <p className="break-words text-base" dir="auto">{agency?.trim() || 'No certification on file'}</p></div>;
}
export function CompanyItemLists({ companyId, role, revision, timeZone, onSaved, initialList, onListClose }: {
  companyId:string; role:string; revision:number; timeZone?:string; onSaved():void;
  initialList?: List; onListClose?():void;
}) {
  const path = '/api/sources/companies/' + encodeURIComponent(companyId);
  const [data,setData] = useState<Lists | null>(null), [error,setError] = useState('');
  const [list,setList] = useState<List | null>(initialList ?? null), [search,setSearch] = useState('');
  const [editor,setEditor] = useState<{list:List; id?:string} | null>(null);
  const [message,setMessage] = useState('');
  const [relationship,setRelationship] = useState<{list:List; operation:RelationshipAction; id?:string} | null>(null);
  useEffect(() => {
    let active = true;
    visitRequest(path + '/items').then(next => { if (active) {setData(next); setError('');} }).catch(e => {if (active) setError(e.message);});
    return () => { active = false; };
  }, [path,revision]);
  if (!data) return <p className="p-4" role="status">{error || 'Loading ingredients and products…'}</p>;
  const flexible = data.flexibleMapping === true;
  const airtable = data.sourceType === 'airtable', docs = airtable && ['admin','coordinator'].includes(role);
  const live = data.status === 'ok', writable = writableItems(data);
  const admin = role === 'admin' && writable;
  const canEdit = admin || !flexible && (role === 'admin' && airtable && data.access === 'readwrite' && !!data.recovery);
  const saved = (text:string) => {setMessage(text); onSaved();};
  const certificates = (files?: SourceAttachment[]) => !!files?.length && <ul className="space-y-1">{files.map(file =>
    <li key={file.id} className="break-words text-sm">{file.filename}</li>)}</ul>;
  const filenamePanel = (item:Row) => flexible ? certificates(item.attachments) : <CertificatePanel path={path + '/items/ingredients/' + encodeURIComponent(item.id) + '/documents'}
    files={item.attachments} writable={writable} onSaved={onSaved} />;
  const warning = airtable && !live ? (data.savedAt ? "Couldn't reach Airtable. Showing the last saved list from " +
      new Intl.DateTimeFormat('en-US',{timeZone,month:'short',day:'numeric'}).format(new Date(data.savedAt)) + ', ' +
      new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit'}).format(new Date(data.savedAt)) + '.' : "Couldn't reach Airtable.") : '';
  const missing = (kind: List) => data.connectedLists?.[kind] === false;
  const actions = (kind: List) => admin && !missing(kind) && (flexible ? data.mappingWrites?.[kind] &&
    <button className={visitButton} onClick={() => setRelationship({list:kind, operation:'assign'})}>Assign to company</button>
    : <button className={visitButton} onClick={() => setEditor({list:kind})}>Add {noun[kind]}</button>);
  const section = 'min-w-0 space-y-3 px-4 py-5 sm:px-6';
  return <>
    {role !== 'admin' && airtable && data.company && <section className={section}>
      <h3 className="text-xl font-semibold">Company details</h3>
      <dl className="space-y-2">{[['Name',data.company.name],['Address',data.company.address],['Type',data.company.type]].map(([label,value]) =>
        <div key={label}><dt className="text-sm text-ink-soft">{label}</dt><dd className="break-words">{value || '—'}</dd></div>)}</dl>
    </section>}
    {docs && data.access === 'read' && <p className={section}>This Airtable connection is read only. Contact an administrator.</p>}
    {error && <p role="alert" className={section}>{error}</p>}
    {warning && <p role="status" className={section}>{warning}</p>}
    {docs && (!flexible || !!data.attachments?.length) && <section className={section}><h3 className="text-xl font-semibold">Letter of Certification (LOC)</h3>
      {flexible ? certificates(data.attachments) : <CertificatePanel path={path+'/documents'} company files={data.attachments} writable={writable} onSaved={onSaved} />}</section>}
    {(['ingredients','products'] as const).map(kind => <section key={kind} className={section}>
      <h3 className="text-xl font-semibold">{titles[kind]}{!missing(kind) && ` (${data[kind].length})`}</h3>
      {missing(kind) ? <p>{airtableMappingCopy.missing(titles[kind])}</p> : <>
      {!data[kind].length && <p>No {kind} listed for this company.</p>}
      <div className="flex flex-wrap gap-2"><button className={visitButton} onClick={() => {setList(kind);setSearch('');}}>View {kind}</button>
        {actions(kind)}</div></>}
    </section>)}
    {docs && data.connectedLists?.contacts === false && <p className={section}>{airtableMappingCopy.missing('Contacts')}</p>}
    {data.mappingIssues?.filter(issue => issue.field === 'relationship').map(issue =>
      <p className={section} key={issue.entity + issue.message} role="status">{issue.message}</p>)}
    {message && !list && <p className={section} role="status">{message}</p>}
    {list && <VisitSheet title={missing(list) ? titles[list] : titles[list]+' ('+data[list].length+')'} onClose={() => initialList && onListClose ? onListClose() : setList(null)}>
      {warning && <p role="status">{warning}</p>}
      {missing(list) ? <p>{airtableMappingCopy.missing(titles[list])}</p> : <>
      <label className="block">Search by {noun[list]} name<input type="search" className={setupField} value={search} onChange={e => setSearch(e.target.value)} /></label>
      {actions(list)}
      {message && <p role="status">{message}</p>}
      <ul className="divide-y divide-line">{data[list].filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase())).map(item =>
        <li key={item.id} className="min-w-0 space-y-2 py-4"><h4 dir="auto" className="break-words text-base font-semibold">{item.name}</h4>
          {(item.brand || item.plant) && <p className="break-words text-sm text-ink-soft">{[item.brand,item.plant].filter(Boolean).join(' · ')}</p>}
          {(item.statusRaw || item.dpm) && <p className="w-fit max-w-full break-words rounded-md bg-sunken px-2 py-1 text-sm">{item.statusRaw || item.dpm}</p>}
          <ItemAgency agency={item.certifyingAgency} />
          {item.expiresOn && <p>Expires {item.expiresOn}</p>}
          {item.code && <p className="break-all">Code / UPC · {item.code}</p>}
          {(item.symbolRequired !== undefined || item.symbolRaw) && <p>Symbol required · {item.symbolRaw || (item.symbolRequired ? 'Yes' : 'No')}</p>}
          {docs && list === 'ingredients' && filenamePanel(item)}
          <div className="flex flex-wrap gap-2">
            {canEdit && <button className={visitButton} onClick={() => setEditor({list,id:item.id})}>Edit</button>}
            {admin && data.mappingWrites?.[list] && <>
              <button className={visitButton} onClick={() => setRelationship({list, id:item.id, operation:'move'})}>Move to another company</button>
              <button className={visitButton} onClick={() => setRelationship({list, id:item.id, operation:'unlink'})}>Remove from company</button>
            </>}
          </div>
        </li>)}</ul>
      {!data[list].length && <p>No {list} listed for this company.</p>}
      {!!search && !data[list].some(item => item.name.toLowerCase().includes(search.trim().toLowerCase())) && <p>No matching {list}.</p>}</>}
    </VisitSheet>}
    {relationship && <RelationshipEditor path={path + '/mapping-items/' + relationship.list} companyId={companyId}
      operation={relationship.operation} id={relationship.id} onClose={() => setRelationship(null)} onSaved={saved} />}
    {editor && <CompanyItemEditor flexible={flexible} path={path + (flexible ? '/mapping-items/' : '/items/') + editor.list} writable={editor.id ? canEdit : admin} recovery={!live} ingredient={editor.list === 'ingredients'} id={editor.id}
      files={data[editor.list].find(i => i.id === editor.id)?.attachments} onClose={() => setEditor(null)} onSaved={saved} />}
  </>;
}

type RelationshipAction = 'assign' | 'move' | 'unlink';
type Choice = { id:string; name:string; assigned?:boolean };
type RelationshipBaseline = { baseId:string; updatedAt:string; baseline:string; companyIds:string[] };
const labels = { assign: 'Assign to company', move: 'Move to another company', unlink: 'Remove from company' };
const confirmations = { assign: 'Item assigned to this company.', move: 'Item moved to another company.', unlink: 'Item removed from this company.' };

export function RelationshipEditor({ path, companyId, id, operation, onClose, onSaved }: {
  path:string; companyId:string; id?:string; operation:RelationshipAction; onClose():void; onSaved(message:string):void;
}) {
  const [choices, setChoices] = useState<{items:Choice[]; companies:Choice[]; writable:boolean}>();
  const [selected, setSelected] = useState(id ?? ''), [destination, setDestination] = useState('');
  const [baseline,setBaseline] = useState<RelationshipBaseline>();
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [review,setReview] = useState(false);
  const [revision,setRevision] = useState(0);
  const lock = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const endpoint = selected && path + '/' + encodeURIComponent(selected) + '/relationship';
  useEffect(() => {
    let active = true;
    visitRequest(path).then(next => {if (active) setChoices(next);})
      .catch(cause => {if (active) setError(cause.message);});
    return () => { active = false; };
  }, [path,revision]);
  useEffect(() => {
    let active = true;
    setBaseline(undefined);
    if (endpoint) visitRequest(endpoint).then(next => {if (active) setBaseline(next);})
      .catch(cause => {if (active) setError(cause.message);});
    return () => { active = false; };
  }, [endpoint,revision]);
  const selectableCompanies = choices?.companies.filter(company => company.id !== companyId && !baseline?.companyIds.includes(company.id)) ?? [];
  const allowed = choices?.writable && !!baseline && !busy && !review &&
    (operation === 'assign' ? !baseline.companyIds.includes(companyId) : baseline.companyIds.includes(companyId)) &&
    (operation !== 'move' || selectableCompanies.some(company => company.id === destination));
  async function submit() {
    if (!baseline || !allowed || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await visitRequest(endpoint, {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...baseline, operation, destination, operationId: operationId.current })});
      if (!result.saved) throw Error(airtableMappingCopy.uncertain);
      onSaved(result.warning || confirmations[operation]);
      onClose();
    } catch (cause: any) {
      setError(cause.status ? cause.message : airtableMappingCopy.uncertain);
      setReview(true);
    } finally { lock.current = false; setBusy(false); }
  }
  function reload() {
    setDestination(''); setBaseline(undefined); setChoices(undefined); setError(''); setReview(false);
    operationId.current = crypto.randomUUID();
    setRevision(value => value + 1);
  }
  return <VisitSheet title={labels[operation]} onClose={() => {if (!busy) onClose();}}>
    {operation === 'assign' && <label className="block">Item<select className={setupField} disabled={!choices?.writable || busy || review} value={selected}
      onChange={event => {setBaseline(undefined); setSelected(event.target.value); setError('');}}>
      <option value="">Choose an item</option>{choices?.items.filter(item => !item.assigned).map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
    </select></label>}
    {operation === 'move' && <label className="block">Destination company<select className={setupField} disabled={!baseline || busy || review} value={destination}
      onChange={event => setDestination(event.target.value)}>
      <option value="">Choose a company</option>{selectableCompanies.map(company => <option key={company.id} value={company.id}>{company.name} · {company.id}</option>)}
    </select></label>}
    {operation === 'unlink' && <p>Remove this item from this company? The Airtable record will be kept.</p>}
    {error && <p role="alert">{error}</p>}
    {!error && (!choices || selected && !baseline) && <p role="status">Reading Airtable…</p>}
    {error === airtableMappingCopy.partial && <p role="status">Review required</p>}
    {review && <button className={visitButton} onClick={reload}>Reload and review</button>}
    <button className={visitButton} disabled={!allowed} onClick={() => void submit()}>{busy ? 'Saving…' : labels[operation]}</button>
  </VisitSheet>;
}
