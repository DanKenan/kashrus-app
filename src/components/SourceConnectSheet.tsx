import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { emptyMapping, mappingReady, sourceRequest, type SourceConnection, type SourceMapping, type SourceTable } from '../lib/sources';

export const sourceButton = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const fieldClass = 'min-h-11 w-full min-w-0 rounded-lg border border-line-control bg-surface px-3 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';
interface Props { isOpen: boolean; connection: SourceConnection; onClose: () => void; onSaved: () => void }
export function SourceConnectSheet(props: Props) {
  return props.isOpen ? <SourceConnectForm {...props} /> : null;
}
const groups = {
  companies: [['name', 'Name'], ['type', 'Type'], ['brand', 'Brand (optional)'], ['plant', 'Plant / location (optional)']],
  ingredients: [['companyLink', 'Link to company'], ['name', 'Name'], ['brand', 'Brand (optional)'], ['certification', 'Certification'], ['agency', 'Certifying agency (if separate)'], ['status', 'Dairy / pareve / meat status'], ['plant', 'Plant / location (optional)'], ['expiresOn', 'Expiration (optional)']],
  products: [['companyLink', 'Link to company'], ['name', 'Name'], ['brand', 'Brand (optional)'], ['code', 'Code / UPC'], ['status', 'Status'], ['symbolRequired', 'Symbol required'], ['plant', 'Plant / location (optional)']],
} as const;
const commaList = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
export function SourceConnectForm({ connection, onClose, onSaved }: Props) {
  const [baseId, setBaseId] = useState(connection.baseId || '');
  const [apiKey, setApiKey] = useState('');
  const [access, setAccess] = useState<'read' | 'readwrite'>(connection.access || 'read');
  const [mapping, setMapping] = useState<SourceMapping>(connection.mapping || emptyMapping());
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [guessed, setGuessed] = useState<Record<string, number>>({});
  const [factoryValues, setFactoryValues] = useState((connection.mapping?.companies.factoryValues || []).join(', '));
  const [noSymbolValues, setNoSymbolValues] = useState((connection.mapping?.noSymbolValues || ['Group 1']).join(', '));
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from<HTMLElement>(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || []);
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const items = controls(); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (!root.current?.contains(event.target as Node)) controls()[0]?.focus(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus); previous?.focus(); };
  }, []);
  const payload = () => ({ sourceType: 'airtable', baseId: baseId.trim(), ...(apiKey ? { apiKey } : {}) });
  const ready = !!baseId.trim() && mappingReady(mapping);
  const run = async (action: 'test' | 'save') => {
    if (lock.current || (action === 'save' && !ready)) return;
    lock.current = true; setBusy(action); setError(''); setMessage('');
    try {
      if (action === 'test') {
        const result = await sourceRequest('/api/sources/test', 'POST', payload());
        if (!result.ok) throw new Error("Couldn't test the connection. Try again.");
        setTables(result.tables || []);
        if (result.guess?.mapping) {
          const suggestion = { ...emptyMapping(), ...result.guess.mapping };
          const next = connection.mapping ? {
            ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues) },
            ingredients: { ...mapping.ingredients }, products: { ...mapping.products }, noSymbolValues: commaList(noSymbolValues),
          } : suggestion;
          const filled: Record<string, number> = {};
          for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
            const values = next[group] as unknown as Record<string, string | string[]>;
            for (const [field, value] of Object.entries(suggestion[group])) {
              if (!connection.mapping || !values[field]?.length) {
                values[field] = value as string | string[];
                const path = `${group}.${field}`;
                if (result.guess.guessed?.[path] != null) filled[path] = result.guess.guessed[path];
              }
            }
          }
          if (!next.noSymbolValues.length) next.noSymbolValues = suggestion.noSymbolValues;
          setMapping(next); setFactoryValues((next.companies.factoryValues || []).join(', '));
          setNoSymbolValues(next.noSymbolValues.join(', '));
          setGuessed(filled);
        } else setGuessed({});
        setAccess(result.access || 'read');
        setMessage(`Connected · ${result.access === 'readwrite' ? 'read and write' : 'read only'}`);
      } else {
        await sourceRequest('/api/sources/connection', 'PUT', { ...payload(), access, mapping: { ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues) }, noSymbolValues: commaList(noSymbolValues) } });
        setApiKey(''); onSaved(); onClose();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save. Try again."); }
    finally { lock.current = false; setBusy(null); }
  };
  const select = (group: keyof typeof groups, field: string, label: string) => {
    const values = mapping[group] as unknown as Record<string, string>;
    const value = values[field] || '';
    const options = field === 'table' ? tables.map(t => t.name) : tables.find(t => t.name === values.table)?.columns || [];
    const path = `${group}.${field}`;
    return <div key={field} className="min-w-0">
      <label htmlFor={`${id}-${path}`} className="block text-sm text-ink-soft">{label} {guessed[path] != null && <span className="rounded-md bg-sunken px-2 text-xs text-ink-soft">Guessed</span>}</label>
      <select id={`${id}-${path}`} name={path} className={fieldClass} value={value} disabled={!!busy} required={['table', 'name', 'companyLink'].includes(field)} onChange={e => {
        setMapping(prev => ({ ...prev, [group]: field === 'table' ? { table: e.target.value, name: '', ...(group === 'companies' ? {} : { companyLink: '' }) } : { ...prev[group], [field]: e.target.value } }));
        setGuessed(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => field === 'table' ? !k.startsWith(`${group}.`) : k !== path)));
      }}>
        <option value="">— Not used —</option>
        {Array.from(new Set([...options, ...(value ? [value] : [])])).map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>;
  };
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-surface p-4 text-ink tactile-4">
      <div className="flex items-center gap-4"><h2 id={`${id}-title`} className="flex-1 text-2xl font-semibold">Connect database</h2><button type="button" aria-label="Close" onClick={onClose} className={`${sourceButton} w-11 px-0 inline-flex items-center justify-center`}><X aria-hidden="true" className="h-5 w-5" /></button></div>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run('save'); }}>
        <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Source</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{['Airtable', 'Google Sheets', 'Excel', 'Supabase'].map((name, i) => <button key={name} type="button" disabled={i !== 0} aria-pressed={i === 0} className={sourceButton}>{name}{i !== 0 && <span className="block text-xs">Coming soon</span>}</button>)}</div></fieldset>
        <div><label htmlFor={`${id}-base`} className="block text-sm text-ink-soft">Base ID</label><input id={`${id}-base`} name="baseId" placeholder="app…" className={fieldClass} value={baseId} disabled={!!busy} onChange={e => { setBaseId(e.target.value); setTables([]); setMessage(''); }} /></div>
        <div><label htmlFor={`${id}-key`} className="block text-sm text-ink-soft">Access key</label><input id={`${id}-key`} name="apiKey" type="password" autoComplete="off" className={fieldClass} value={apiKey} disabled={!!busy} onChange={e => setApiKey(e.target.value)} />{connection.hasKey && <p className="text-sm text-ink-soft">{`A key is saved (…${connection.keyHint?.slice(-4) || ''}). Leave empty to keep it.`}</p>}</div>
        <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Access</legend>{(['read', 'readwrite'] as const).map(value => <label key={value} className="flex min-h-11 items-center gap-2"><input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} />{value === 'read' ? 'Read only' : 'Read and write'}</label>)}<p className="text-sm text-ink-soft">Read only is enough for now. Read and write lets you manage your database from the app later.</p></fieldset>
        <button type="button" className={sourceButton} disabled={!!busy || !baseId.trim()} onClick={() => void run('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        {message && <p role="status" className="text-base text-ink">{message}</p>}
        <h3 className="text-xl font-semibold">Mapping</h3>
        {(Object.keys(groups) as (keyof typeof groups)[]).map(group => <fieldset key={group} className="min-w-0 space-y-3 rounded-xl border border-line p-4"><legend className="text-base">{group === 'companies' ? 'Companies' : group === 'ingredients' ? 'Ingredients' : 'Products'}</legend>{select(group, 'table', 'Table')}{groups[group].map(([field, label]) => select(group, field, label))}{group === 'companies' && <div><label htmlFor={`${id}-types`} className="block text-sm text-ink-soft">Which types are factories</label><input id={`${id}-types`} name="factoryValues" className={fieldClass} value={factoryValues} disabled={!!busy} onChange={e => setFactoryValues(e.target.value)} /></div>}</fieldset>)}
        <div><label htmlFor={`${id}-symbols`} className="block text-sm text-ink-soft">No symbol needed values</label><input id={`${id}-symbols`} name="noSymbolValues" className={fieldClass} value={noSymbolValues} disabled={!!busy} onChange={e => setNoSymbolValues(e.target.value)} /><p className="text-sm text-ink-soft">Ingredients certified this way are kosher with no symbol (like salt).</p></div>
        {error && <p role="alert" className="text-base text-bad">{error}</p>}
        <button type="submit" disabled={!!busy || !ready} className="pressable min-h-12 w-full rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  </div>;
}
