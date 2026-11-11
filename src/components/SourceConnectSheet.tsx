import React, { useEffect, useId, useRef, useState } from 'react';
import { assigned, previewRows, summarizeValues, type SourceValue, type SourceSamples } from '../lib/sourcePreview';
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
  products: [['companyLink', 'Link to company'], ['name', 'Name'], ['brand', 'Brand (optional)'], ['code', 'Code / UPC'], ['certification', 'Certification'], ['agency', 'Certifying agency (if separate)'], ['status', 'Status'], ['symbolRequired', 'Symbol required'], ['plant', 'Plant / location (optional)']],
} as const;
const commaList = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
export function SourceConnectForm({ connection, onClose, onSaved }: Props) {
  const [baseId, setBaseId] = useState(connection.baseId || '');
  const [group1Label, setGroup1Label] = useState(connection.group1Label || 'Group 1');
  const [apiKey, setApiKey] = useState('');
  const [access, setAccess] = useState<'read' | 'readwrite'>(connection.access || 'read');
  const [mapping, setMapping] = useState<SourceMapping>(connection.mapping || emptyMapping());
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [samples, setSamples] = useState<SourceSamples | null>(null);
  const [storedValues, setStoredValues] = useState<SourceValue[]>([]);
  const [expandedValues, setExpandedValues] = useState<Record<string, boolean>>({});
  const [storedValueTotal, setStoredValueTotal] = useState(0);
  const [valueSearch, setValueSearch] = useState('');
  useEffect(() => {
    let active = true;
    if (connection.sourceType && connection.mapping) sourceRequest(`/api/sources/values?q=${encodeURIComponent(valueSearch)}`).then(result => {
      if (active) { setStoredValues(result.values || []); setStoredValueTotal(result.total || 0); }
    }).catch(() => {});
    return () => { active = false; };
  }, [valueSearch]);
  const [guessed, setGuessed] = useState<Record<string, number>>({});
  const [factoryValues, setFactoryValues] = useState((connection.mapping?.companies.factoryValues || []).join(', '));
  const [group1Values, setGroup1Values] = useState((connection.mapping?.group1Values || ['Group 1']).join(', '));
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
  const ready = !!baseId.trim() && mappingReady(mapping) && !!group1Label.trim() && group1Label.trim().length <= 30;
  const run = async (action: 'test' | 'save') => {
    if (lock.current || (action === 'save' && !ready)) return;
    lock.current = true; setBusy(action); setError(''); setMessage('');
    try {
      if (action === 'test') {
        const result = await sourceRequest('/api/sources/test', 'POST', payload());
        if (!result.ok) throw new Error("Couldn't test the connection. Try again.");
        setTables(result.tables || []);
        setSamples(result.samples ?? null);
        if (result.guess?.mapping) {
          const suggestion = { ...emptyMapping(), ...result.guess.mapping };
          const next = connection.mapping ? {
            ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues) },
            ingredients: { ...mapping.ingredients }, products: { ...mapping.products }, group1Values: commaList(group1Values),
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
          if (!next.group1Values.length) next.group1Values = suggestion.group1Values;
          setMapping(next); setFactoryValues((next.companies.factoryValues || []).join(', '));
          setGroup1Values(next.group1Values.join(', '));
          setGuessed(filled);
        } else setGuessed({});
        setAccess(result.access || 'read');
        setMessage(`Connected · ${result.access === 'readwrite' ? 'read and write' : 'read only'}`);
      } else {
        await sourceRequest('/api/sources/connection', 'PUT', { ...payload(), access, group1Label: group1Label.trim(), mapping: { ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues) }, group1Values: commaList(group1Values) } });
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
      <label htmlFor={`${id}-${path}`} className="block text-sm text-ink-soft">{label} {guessed[path] != null && <span aria-label={guessed[path] < 0.8 ? 'Check this guess' : undefined} className="rounded-md bg-sunken px-2 text-xs text-ink-soft">{guessed[path] < 0.8 ? 'Check' : 'Guessed'}</span>}</label>
      <select id={`${id}-${path}`} name={path} className={fieldClass} value={value} disabled={!!busy} required={['table', 'name', 'companyLink'].includes(field)} onChange={e => {
        setMapping(prev => ({ ...prev, [group]: field === 'table' ? { table: e.target.value, name: '', ...(group === 'companies' ? {} : { companyLink: '' }) } : { ...prev[group], [field]: e.target.value } }));
        setGuessed(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => field === 'table' ? !k.startsWith(`${group}.`) : k !== path)));
      }}>
        <option value="">— Not used —</option>
        {Array.from(new Set([...options, ...(value ? [value] : [])])).map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>;
  };
  const preview = (group: keyof typeof groups) => {
    const data = previewRows(samples || {}, { ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues) }, group1Values: commaList(group1Values) }, group, group1Label.trim() || 'Group 1');
    return <div className="min-w-0 space-y-2">
      <h4 className="text-sm font-semibold">Preview</h4>
      {!samples ? <p className="text-sm text-ink-soft">Press Test connection to see a preview.</p> : !data.rows.length ? <p className="text-sm text-ink-soft">No sample rows for this table.</p> : <div role="region" aria-label={`${group} preview`} tabIndex={0} className="max-w-full overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs text-ink"><thead className="bg-sunken"><tr>{data.header.map(label => <th key={label} scope="col" className="whitespace-nowrap p-2 text-left font-medium">{label}</th>)}</tr></thead>
          <tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className="max-w-48 break-words border-t border-line p-2">{cell}{data.chips[index]?.[column]?.map(chip => <span key={chip} className="flex min-h-6 items-center rounded-full bg-sunken px-2 text-xs text-ink-soft">{chip}</span>)}</td>)}</tr>)}</tbody></table>
      </div>}
    </div>;
  };
  const uses: Parameters<typeof summarizeValues>[0] = [];
  if (samples) for (const group of ['ingredients', 'products'] as const) {
    const config = mapping[group];
    for (const column of new Set([config.certification, config.status, config.agency].filter(Boolean)))
      for (const row of samples[config.table] || []) {
        const value = row.fields[column!]?.trim(); if (!value) continue;
        uses.push({ kind: group === 'ingredients' ? 'ingredient' : 'product', column: column!, value, id: row.id, name: row.fields[config.name] || '', brand: config.brand ? row.fields[config.brand] : undefined });
      }
  }
  const merged = new Map<string, (typeof storedValues)[number]>(storedValues.map(v => [JSON.stringify([v.kind, v.column, v.value]), v]));
  for (const v of summarizeValues(uses)) {
    const key = JSON.stringify([v.kind, v.column, v.value]);
    if (!merged.has(key)) merged.set(key, v);
  }
  const values = [...merged.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const editValue = (kind: 'ingredient' | 'product', column: string, value: string, change: object) => setMapping(prev => {
    const old = prev.valueAssignments as Record<string, any> || {};
    const scoped = Object.keys(old).every(k => ['ingredient', 'product'].includes(k)) ? old : { ingredient: old, product: old };
    return { ...prev, valueAssignments: { ...scoped, [kind]: { ...scoped[kind], [column]: { ...scoped[kind]?.[column], [value]: { ...scoped[kind]?.[column]?.[value], ...change } } } } };
  });
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="max-h-[90dvh] min-w-0 w-full max-w-2xl overflow-y-auto overflow-x-hidden rounded-t-2xl bg-surface p-4 text-ink tactile-4">
      <div className="flex items-center gap-4"><h2 id={`${id}-title`} className="flex-1 text-2xl font-semibold">Connect database</h2><button type="button" aria-label="Close" onClick={onClose} className={`${sourceButton} w-11 px-0 inline-flex items-center justify-center`}><X aria-hidden="true" className="h-5 w-5" /></button></div>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run('save'); }}>
        <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Source</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{['Airtable', 'Google Sheets', 'Excel', 'Supabase'].map((name, i) => <button key={name} type="button" disabled={i !== 0} aria-pressed={i === 0} className={sourceButton}>{name}{i !== 0 && <span className="block text-xs">Coming soon</span>}</button>)}</div></fieldset>
        <div><label htmlFor={`${id}-base`} className="block text-sm text-ink-soft">Base ID</label><input id={`${id}-base`} name="baseId" placeholder="app…" className={fieldClass} value={baseId} disabled={!!busy} onChange={e => { setBaseId(e.target.value); setTables([]); setSamples(null); setMessage(''); }} /></div>
        <div><label htmlFor={`${id}-key`} className="block text-sm text-ink-soft">Access key</label><input id={`${id}-key`} name="apiKey" type="password" autoComplete="off" className={fieldClass} value={apiKey} disabled={!!busy} onChange={e => setApiKey(e.target.value)} />{connection.hasKey && <p className="text-sm text-ink-soft">{`A key is saved (…${connection.keyHint?.slice(-4) || ''}). Leave empty to keep it.`}</p>}</div>
        <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Access</legend>{(['read', 'readwrite'] as const).map(value => <label key={value} className="flex min-h-11 items-center gap-2"><input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} />{value === 'read' ? 'Read only' : 'Read and write'}</label>)}<p className="text-sm text-ink-soft">Read only is enough for now. Read and write lets you manage your database from the app later.</p></fieldset>
        <button type="button" className={sourceButton} disabled={!!busy || !baseId.trim()} onClick={() => void run('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        {message && <p role="status" className="text-base text-ink">{message}</p>}
        <h3 className="text-xl font-semibold">Mapping</h3>
        {(Object.keys(groups) as (keyof typeof groups)[]).map(group => <fieldset key={group} className="min-w-0 space-y-3 rounded-xl border border-line p-4"><legend className="text-base">{group === 'companies' ? 'Companies' : group === 'ingredients' ? 'Ingredients' : 'Products'}</legend>{select(group, 'table', 'Table')}{groups[group].map(([field, label]) => select(group, field, label))}{group === 'companies' && <div><label htmlFor={`${id}-types`} className="block text-sm text-ink-soft">Which types are factories</label><input id={`${id}-types`} name="factoryValues" className={fieldClass} value={factoryValues} disabled={!!busy} onChange={e => setFactoryValues(e.target.value)} /></div>}{preview(group)}</fieldset>)}
        <fieldset className="space-y-4"><legend className="text-xl font-semibold">What each value means</legend>
          <p className="text-base text-ink-soft">Your database writes the certification in different ways. Tell the app once what each one means — it applies to every ingredient that uses it.</p>
          {Math.max(values.length, storedValueTotal) > 20 && <label className="block text-sm text-ink-soft">Search values<input className={fieldClass} name="valueSearch" value={valueSearch} onChange={e => setValueSearch(e.target.value)} /></label>}
          {values.filter(v => v.value.toLowerCase().includes(valueSearch.toLowerCase())).map(({ kind, column, value, count, usage }) => {
            const guess = assigned({ ...mapping, group1Values: commaList(group1Values) }, column, value, kind);
            return <div key={JSON.stringify([kind, column, value])} className="space-y-2 rounded-lg border border-line p-4">
              <p className="break-words text-base">{value} <span className="text-xs text-ink-soft">{kind === 'ingredient' ? 'Ingredients' : 'Products'} · {column} · {count}</span> {guess.dpm === 'dairy_equipment' && <span className="rounded-full bg-sunken px-2 text-xs text-ink-soft">DE</span>} {guess.confidence < 0.8 && <span className="text-xs text-ink-soft">Check</span>}</p>
              {(['ingredient', 'product'] as const).map(usedKind => {
                const used = usage?.[usedKind]; if (!used) return null;
                const key = JSON.stringify([kind, column, value, usedKind]);
                const expanded = expandedValues[key];
                const label = (item: { name: string; brand?: string }) => `${item.name}${item.brand ? ` (${item.brand})` : ''}`;
                return <div key={usedKind} className="space-y-2">
                  <p className="text-sm text-ink-soft">{`Used by ${used.count} ${usedKind === 'ingredient' ? (used.count === 1 ? 'ingredient' : 'ingredients') : (used.count === 1 ? 'product' : 'products')}`}</p>
                  <p className="break-words text-base">{used.items.slice(0, 3).map(label).join(' · ')}{used.count > 3 && <button type="button" className={sourceButton} aria-expanded={!!expanded} onClick={() => setExpandedValues(prev => ({ ...prev, [key]: !prev[key] }))}>{expanded ? 'Show less' : `+${used.count - 3}`}</button>}</p>
                  {expanded && <ul className="space-y-2 text-base">{used.items.map((item, index) => <li key={index} className="break-words">{label(item)}</li>)}{used.count > used.items.length && <li className="text-sm text-ink-soft">{`Showing ${used.items.length} of ${used.count}`}</li>}</ul>}
                </div>;
              })}
              <label className="block text-sm text-ink-soft">Agency<input className={fieldClass} value={guess.agency || ''} disabled={!!busy} onChange={e => editValue(kind, column, value, { agency: e.target.value })} /></label>
              <label className="block text-sm text-ink-soft">Dairy / DE / Pareve / Meat<select className={fieldClass} value={guess.dpm || ''} disabled={!!busy} onChange={e => editValue(kind, column, value, { dpm: e.target.value })}><option value="">—</option><option value="dairy">Dairy</option><option value="dairy_equipment">DE</option><option value="pareve">Pareve</option><option value="meat">Meat</option></select></label>
              <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={guess.group1 === true} disabled={!!busy} onChange={e => editValue(kind, column, value, { group1: e.target.checked })} />{group1Label.trim() || 'Group 1'}</label>
            </div>;
          })}
        </fieldset>
        <div><label htmlFor={`${id}-group1-label`} className="block text-sm text-ink-soft">Name for Group 1</label><input id={`${id}-group1-label`} name="group1Label" className={fieldClass} value={group1Label} maxLength={30} required disabled={!!busy} onChange={e => setGroup1Label(e.target.value)} /></div>
        <div><label htmlFor={`${id}-symbols`} className="block text-sm text-ink-soft">{`Values that mean ${group1Label.trim() || 'Group 1'}`}</label><input id={`${id}-symbols`} name="group1Values" className={fieldClass} value={group1Values} disabled={!!busy} onChange={e => setGroup1Values(e.target.value)} /></div>
        {error && <p role="alert" className="text-base text-bad">{error}</p>}
        <button type="submit" disabled={!!busy || !ready} className="pressable min-h-12 w-full rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  </div>;
}
