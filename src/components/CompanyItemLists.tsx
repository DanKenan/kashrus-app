import React, { useEffect, useState } from 'react';
import { mappingReady, type SourceAttachment, type SourceConnection } from '../lib/sources';
import { CertificatePanel } from './CertificatePanel';
import { CompanyItemEditor } from './CompanyItemEditor';
import { VisitSheet, visitButton, visitRequest } from './FactoryVisitScreen';
import { setupField } from './MappingStep';

export type CompanyItemList = 'ingredients' | 'products';
type List = CompanyItemList;
type Row = { id:string; name:string; brand?:string; plant?:string; certifyingAgency?:string; statusRaw?:string; expiresOn?:string;
  dpm?:string; code?:string; symbolRequired?:boolean; symbolRaw?:string; attachments?:SourceAttachment[] };
type Lists = Record<List,Row[]> & { company?: {name:string; address?:string; type?:string}; attachments?:SourceAttachment[]; access:string; sourceType:string; status:string; recovery?:boolean; savedAt?:string };
const titles = { ingredients:'Ingredients', products:'Products' };
const noun = { ingredients:'ingredient', products:'product' };
const writableItems = (source: { sourceType: string | null; access?: string; status?: string }) =>
  source.sourceType === 'airtable' && source.access === 'readwrite' && source.status === 'ok';

export function itemListEditor(role: string, connection: SourceConnection | null, list: List) {
  if (role !== 'admin' || !connection) return undefined;
  if (connection.sheetsEditSections?.includes(list)) return 'sheet';
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
  useEffect(() => {
    let active = true;
    visitRequest(path + '/items').then(next => { if (active) {setData(next); setError('');} }).catch(e => {if (active) setError(e.message);});
    return () => { active = false; };
  }, [path,revision]);
  if (!data) return <p className="p-4" role="status">{error || 'Loading ingredients and products…'}</p>;
  const airtable = data.sourceType === 'airtable', docs = airtable && ['admin','coordinator'].includes(role);
  const live = data.status === 'ok', writable = writableItems(data);
  const admin = role === 'admin' && writable;
  const canEdit = admin || (role === 'admin' && airtable && data.access === 'readwrite' && !!data.recovery);
  const saved = (text:string) => {setMessage(text); onSaved();};
  const filenamePanel = (item:Row) => <CertificatePanel path={path + '/items/ingredients/' + encodeURIComponent(item.id) + '/documents'}
    files={item.attachments} writable={writable} onSaved={onSaved} />;
  const warning = airtable && !live ? (data.savedAt ? "Couldn't reach Airtable. Showing the last saved list from " +
      new Intl.DateTimeFormat('en-US',{timeZone,month:'short',day:'numeric'}).format(new Date(data.savedAt)) + ', ' +
      new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit'}).format(new Date(data.savedAt)) + '.' : "Couldn't reach Airtable.") : '';
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
    {docs && <section className={section}><h3 className="text-xl font-semibold">Letter of Certification (LOC)</h3>
      <CertificatePanel path={path+'/documents'} company files={data.attachments} writable={writable} onSaved={onSaved} /></section>}
    {(['ingredients','products'] as const).map(kind => <section key={kind} className={section}>
      <h3 className="text-xl font-semibold">{titles[kind]} ({data[kind].length})</h3>
      {!data[kind].length && <p>No {kind} listed for this company.</p>}
      <div className="flex flex-wrap gap-2"><button className={visitButton} onClick={() => {setList(kind);setSearch('');}}>View {kind}</button>
        {admin && <button className={visitButton} onClick={() => setEditor({list:kind})}>Add {noun[kind]}</button>}</div>
    </section>)}
    {message && !list && <p className={section} role="status">{message}</p>}
    {list && <VisitSheet title={titles[list]+' ('+data[list].length+')'} onClose={() => initialList && onListClose ? onListClose() : setList(null)}>
      {warning && <p role="status">{warning}</p>}
      <label className="block">Search by {noun[list]} name<input type="search" className={setupField} value={search} onChange={e => setSearch(e.target.value)} /></label>
      {admin && <button className={visitButton} onClick={() => setEditor({list})}>Add {noun[list]}</button>}
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
          {canEdit && <button className={visitButton} onClick={() => setEditor({list,id:item.id})}>Edit</button>}
        </li>)}</ul>
      {!data[list].length && <p>No {list} listed for this company.</p>}
      {!!search && !data[list].some(item => item.name.toLowerCase().includes(search.trim().toLowerCase())) && <p>No matching {list}.</p>}
    </VisitSheet>}
    {editor && <CompanyItemEditor path={path + '/items/' + editor.list} writable={editor.id ? canEdit : admin} recovery={!live} ingredient={editor.list === 'ingredients'} id={editor.id}
      files={data[editor.list].find(i => i.id === editor.id)?.attachments} onClose={() => setEditor(null)} onSaved={saved} />}
  </>;
}
