import React, { useEffect, useId, useRef, useState } from 'react';
import { assigned, builtinFieldKeys, previewRows, summarizeValues, type SourceValue, type SourceSamples } from '../lib/sourcePreview';
import { ChevronDown, Plus, X } from 'lucide-react';
import { emptyMapping, mappingReady, sourceRequest, type SourceConnection, type SourceMapping, type SourceTable } from '../lib/sources';

export const sourceButton = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const helpButton = 'pressable inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line-control bg-surface text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const removeButton = 'pressable min-h-11 shrink-0 rounded-md px-2 text-sm text-ink-soft hover:bg-sunken focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const mappingFieldClass = 'min-h-11 w-full min-w-0 rounded-md border border-line-control bg-sunken px-3 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const fieldClass = 'min-h-11 w-full min-w-0 rounded-lg border border-line-control bg-surface px-3 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';
interface Props { isOpen: boolean; connection: SourceConnection; onClose: () => void; onSaved: () => void }
export function SourceConnectSheet(props: Props) {
  return props.isOpen ? <SourceConnectForm {...props} /> : null;
}
export const sourceMatchingFields = {
  companies: [['name', 'Name'], ['type', 'Type'], ['brand', 'Brand (optional)'], ['plant', 'Plant / location (optional)']],
  ingredients: [['companyLink', 'Link to company'], ['name', 'Name'], ['brand', 'Brand (optional)'], ['certification', 'Certification'], ['agency', 'Certifying agency (if separate)'], ['status', 'Dairy / pareve / meat status'], ['plant', 'Plant / location (optional)'], ['expiresOn', 'Expiration (optional)']],
  products: [['companyLink', 'Link to company'], ['name', 'Name'], ['brand', 'Brand (optional)'], ['code', 'Code / UPC'], ['certification', 'Certification'], ['agency', 'Certifying agency (if separate)'], ['status', 'Status'], ['symbolRequired', 'Symbol required'], ['plant', 'Plant / location (optional)']],
} as const;
const groups = sourceMatchingFields;
const sectionTabs = { companies: 'Companies', ingredients: 'Schedule A', products: 'Schedule B' } as const;
const mappingGroups = Object.keys(groups) as (keyof typeof groups)[];
const commaList = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
const builtinKeys = (group: keyof typeof groups): string[] => [...builtinFieldKeys[group], ...(group === 'products' ? [] : ['locAttachment'])];
const settingsKeys = ['factoryValues', 'foodServiceValues', 'valueAssignments', 'group1Values', 'hidden'];
// A custom label that matches a built-in key, a settings key, or a built-in
// display name is reserved for that section. A reserved row keeps its column
// in draft state while the label is reserved, and Save is blocked until the
// label is valid again, so a mapped row can never vanish silently from the
// Save payload.
const reservedDraftLabel = (group: keyof typeof groups, label: string) => {
  const trimmed = label.trim();
  return !!trimmed && (builtinKeys(group).includes(trimmed) || settingsKeys.includes(trimmed) || groups[group].some(([, display]) => display === trimmed));
};
type HiddenMap = Partial<Record<'companies' | 'ingredients' | 'products', string[]>>;
const savedHidden = (m?: SourceMapping): HiddenMap => (m as (SourceMapping & { hidden?: HiddenMap }) | undefined)?.hidden ?? {};
// A stored hidden list is only trusted for optional fields; anything else in
// it is ignored, and a hidden field must not keep a column mapping.
const normalizedHidden = (m?: SourceMapping): Record<string, string[]> => {
  const hidden = savedHidden(m);
  const out: Record<string, string[]> = {};
  for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
    const optional: string[] = groups[group].filter(([field]) => !['table', 'name', 'companyLink'].includes(field)).map(([field]) => field);
    // A stored hidden section that is not an array (for example a string)
    // is treated as empty so the sheet still opens.
    const list = Array.isArray(hidden[group]) ? hidden[group] : [];
    out[group] = [...new Set(list.filter(field => optional.includes(field)))];
  }
  return out;
};
const sectionName = (group: keyof typeof groups) => group === 'companies' ? 'Companies' : group === 'ingredients' ? 'Ingredients/Schedule A' : 'Products/Schedule B';
const extraKeys = (mapping: SourceMapping | undefined, group: keyof typeof groups) => {
  if (!mapping) return [] as string[];
  const built = new Set(builtinKeys(group));
  const values = mapping[group] as unknown as Record<string, unknown>;
  return Object.keys(values).filter(key => !built.has(key) && typeof values[key] === 'string');
};
export function SourceConnectForm({ connection, onClose, onSaved }: Props) {
  const [section, setSection] = useState<keyof typeof groups>(connection.mapping ? 'ingredients' : 'companies');
  const [showSettings, setShowSettings] = useState(!connection.mapping || !connection.baseId);
  const [showRemoved, setShowRemoved] = useState(false);
  const [baseId, setBaseId] = useState(connection.baseId || '');
  const [group1Label, setGroup1Label] = useState(connection.group1Label || 'Group 1');
  const [apiKey, setApiKey] = useState('');
  const [access, setAccess] = useState<'read' | 'readwrite'>(connection.access || 'read');
  const [mapping, setMapping] = useState<SourceMapping>(() => {
    const base = connection.mapping || emptyMapping();
    const next = { ...base, companies: { ...base.companies }, ingredients: { ...base.ingredients }, products: { ...base.products } };
    const hidden = normalizedHidden(connection.mapping);
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      const rec = next[group] as unknown as Record<string, unknown>;
      for (const key of Object.keys(rec)) if (!builtinKeys(group).includes(key) && !settingsKeys.includes(key)) delete rec[key];
      for (const field of hidden[group] || []) delete rec[field];
    }
    return next;
  });
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [samples, setSamples] = useState<SourceSamples | null>(null);
  const [storedValues, setStoredValues] = useState<SourceValue[]>([]);
  const [expandedValues, setExpandedValues] = useState<Record<string, boolean>>({});
  const [storedValueTotal, setStoredValueTotal] = useState(0);
  const [valueSearch, setValueSearch] = useState('');
  useEffect(() => {
    let active = true;
    setStoredValues([]);
    if (connection.sourceType === 'airtable' && connection.mapping) sourceRequest(`/api/sources/values?q=${encodeURIComponent(valueSearch)}`).then(result => {
      if (active && Array.isArray(result.values)) {
        setStoredValues(result.values);
        setStoredValueTotal(typeof result.total === 'number' ? result.total : 0);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [valueSearch]);
  const [guessed, setGuessed] = useState<Record<string, number>>({});
  const [foodServiceValues, setFoodServiceValues] = useState((connection.mapping?.companies.foodServiceValues || []).join(', '));
  const [factoryValues, setFactoryValues] = useState((connection.mapping?.companies.factoryValues || []).join(', '));
  const [group1Values, setGroup1Values] = useState((connection.mapping?.group1Values || ['Group 1']).join(', '));
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [helpBase, setHelpBase] = useState(false);
  const [helpKey, setHelpKey] = useState(false);
  const [removed, setRemoved] = useState<Record<string, string[]>>(() => normalizedHidden(connection.mapping));
  const [added, setAdded] = useState<Record<string, { id: number; label: string }[]>>(() => ({
    companies: extraKeys(connection.mapping, 'companies').map((label, i) => ({ id: i + 1, label })),
    ingredients: extraKeys(connection.mapping, 'ingredients').map((label, i) => ({ id: i + 1, label })),
    products: extraKeys(connection.mapping, 'products').map((label, i) => ({ id: i + 1, label })),
  }));
  const [extraColumns, setExtraColumns] = useState<Record<string, Record<number, string>>>(() => {
    const out: Record<string, Record<number, string>> = {};
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      const values = connection.mapping?.[group] as unknown as Record<string, string> | undefined;
      out[group] = {};
      extraKeys(connection.mapping, group).forEach((label, i) => { if (!reservedDraftLabel(group, label)) out[group][i + 1] = values?.[label] || ''; });
    }
    return out;
  });
  const extraLabelRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const addButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingFocus = useRef<{ kind: 'extra' | 'add'; key: string } | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = pendingFocus.current.kind === 'extra' ? extraLabelRefs.current[pendingFocus.current.key] : addButtonRefs.current[pendingFocus.current.key];
    pendingFocus.current = null;
    target?.focus();
  });
  const validDraftLabel = (group: keyof typeof groups, label: string) => !!label && !reservedDraftLabel(group, label);
  // One eligibility rule for saving and for duplicate checks: a draft row
  // only counts once it has a valid label and a column picked.
  const draftRow = (group: keyof typeof groups, row: { id: number; label: string }) => {
    const label = row.label.trim();
    const column = (extraColumns[group] || {})[row.id] || '';
    if (!label || !column || !validDraftLabel(group, label)) return null;
    return { label, column };
  };
  const draftEntries = (group: keyof typeof groups): Record<string, string> => {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const row of added[group] || []) {
      const entry = draftRow(group, row);
      if (!entry || seen.has(entry.label)) continue;
      seen.add(entry.label);
      out[entry.label] = entry.column;
    }
    return out;
  };
  const duplicateLabels = (group: keyof typeof groups): string[] => {
    const seen = new Set<string>(); const dupes = new Set<string>();
    for (const row of added[group] || []) {
      const entry = draftRow(group, row);
      if (!entry) continue;
      if (seen.has(entry.label)) dupes.add(entry.label); else seen.add(entry.label);
    }
    return [...dupes];
  };
  // A row whose label is reserved while it still holds a column must never
  // reach Save: the column is kept in draft state, and Save is blocked
  // until the label is valid again.
  const reservedMapped = (group: keyof typeof groups): string[] => {
    const out: string[] = [];
    for (const row of added[group] || []) {
      const column = (extraColumns[group] || {})[row.id] || '';
      if (column && reservedDraftLabel(group, row.label)) out.push(row.label.trim());
    }
    return out;
  };
  const withDrafts = (base: SourceMapping): SourceMapping => {
    const { hidden: _hidden, ...rest } = base as SourceMapping & { hidden?: HiddenMap };
    const next = { ...rest, companies: { ...base.companies }, ingredients: { ...base.ingredients }, products: { ...base.products } };
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      for (const [label, column] of Object.entries(draftEntries(group))) (next[group] as unknown as Record<string, string>)[label] = column;
    }
    return next;
  };
  const lock = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const baseHelpButton = useRef<HTMLButtonElement>(null);
  const keyHelpButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from<HTMLElement>(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || [])
      .filter(control => !control.closest('[hidden], fieldset:disabled'));
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
  const clearSchema = () => { setTables([]); setSamples(null); setMessage(''); };
  const payload = () => ({ sourceType: 'airtable', baseId: baseId.trim(), ...(apiKey ? { apiKey } : {}) });
  const ready = !!baseId.trim() && mappingReady(mapping) && !!group1Label.trim() && group1Label.trim().length <= 30;
  const run = async (action: 'test' | 'save') => {
    if (lock.current || (action === 'save' && !ready)) return;
    lock.current = true; setBusy(action); setError(''); setMessage('');
    try {
      if (action === 'test') {
        clearSchema();
        const result = await sourceRequest('/api/sources/test', 'POST', payload());
        if (!result.ok) throw new Error("Couldn't test the connection. Try again.");
        setTables(result.tables || []);
        setSamples(result.samples ?? null);
        if (result.guess?.mapping) {
          const suggestion = { ...emptyMapping(), ...result.guess.mapping };
          const next = connection.mapping ? {
            ...mapping, companies: { ...mapping.companies, factoryValues: commaList(factoryValues), ...(foodServiceValues || mapping.companies.foodServiceValues ? { foodServiceValues: commaList(foodServiceValues) } : {}) },
            ingredients: { ...mapping.ingredients }, products: { ...mapping.products }, group1Values: commaList(group1Values),
          } : suggestion;
          const filled: Record<string, number> = {};
          for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
            const values = next[group] as unknown as Record<string, string | string[]>;
            for (const [field, value] of Object.entries(suggestion[group])) {
              if ((removed[group] || []).includes(field) || field === 'locAttachment' && values[field] === '') continue;
              if (!connection.mapping || !values[field]?.length) {
                values[field] = value as string | string[];
                const path = `${group}.${field}`;
                if (result.guess.guessed?.[path] != null) filled[path] = result.guess.guessed[path];
              }
            }
          }
          for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
            for (const field of removed[group] || []) delete (next[group] as unknown as Record<string, unknown>)[field];
          }
          if (!next.group1Values.length) next.group1Values = suggestion.group1Values;
          setFoodServiceValues((next.companies.foodServiceValues || []).join(', ')); setMapping(next); setFactoryValues((next.companies.factoryValues || []).join(', '));
          setGroup1Values(next.group1Values.join(', '));
          setGuessed(filled);
        } else setGuessed({});
        setAccess(result.access || 'read');
        setMessage(`Connected · ${result.access === 'readwrite' ? 'read and write' : 'read only'}`);
      } else {
        const unlabeledSection = mappingGroups.find(group => added[group].some(row => extraColumns[group][row.id] && !row.label.trim()));
        if (unlabeledSection) { setError(`Enter a field label in ${sectionName(unlabeledSection)}.`); return; }
        const dupes = mappingGroups.flatMap(group => duplicateLabels(group).map(label => `${label} (${sectionName(group)})`));
        if (dupes.length) { setError(`Each field name must be used once in a section: ${dupes.join(', ')}.`); return; }
        const reserved = mappingGroups.flatMap(group => reservedMapped(group).map(label => `${label} (${sectionName(group)})`));
        if (reserved.length) { setError(`A field name that is already used cannot hold a column: ${reserved.join(', ')}.`); return; }
        const merged = withDrafts(mapping);
        await sourceRequest('/api/sources/connection', 'PUT', { ...payload(), access, group1Label: group1Label.trim(), mapping: { ...merged, companies: { ...merged.companies, factoryValues: commaList(factoryValues), ...(foodServiceValues || merged.companies.foodServiceValues ? { foodServiceValues: commaList(foodServiceValues) } : {}) }, group1Values: commaList(group1Values), ...(removed.companies.length || removed.ingredients.length || removed.products.length ? { hidden: removed } : {}) } });
        setApiKey(''); onSaved(); onClose();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save. Try again."); }
    finally { lock.current = false; setBusy(null); }
  };
  const select = (group: keyof typeof groups, field: string, label: string, opts?: { onRemove?: () => void }) => {
    const values = mapping[group] as unknown as Record<string, string>;
    const table = tables.find(t => t.name === values.table);
    const fallback = field === 'locAttachment' && group === 'companies' && table?.name === 'Establishments' ? 'LOC'
      : field === 'locAttachment' && group === 'ingredients' && table?.name === 'Ingredients List' ? 'Attachments' : '';
    const value = values[field] ?? (table?.fieldTypes?.[fallback] === 'multipleAttachments' ? fallback : '');
    const options = field === 'table' ? tables.map(t => t.name) : table?.columns.filter(name =>
      (table.fieldTypes?.[name] === 'multipleAttachments') === (field === 'locAttachment')) || [];
    const path = `${group}.${field}`;
    const control = <select id={`${id}-${path}`} name={path} className={mappingFieldClass} value={value} disabled={!!busy} required={['table', 'name', 'companyLink'].includes(field)} onChange={e => {
        if (field === 'table') {
          setMapping(prev => ({ ...prev, [group]: { table: e.target.value, name: '', ...(group === 'companies' ? {} : { companyLink: '' }) } }));
        } else if (!e.target.value && !requiredField(field) && field !== 'locAttachment') {
          setMapping(prev => {
            const rec = { ...(prev[group] as unknown as Record<string, string>) };
            delete rec[field];
            return { ...prev, [group]: rec as unknown as SourceMapping[keyof typeof groups] };
          });
        } else {
          setMapping(prev => ({ ...prev, [group]: { ...prev[group], [field]: e.target.value } }));
        }
        setGuessed(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => field === 'table' ? !k.startsWith(`${group}.`) : k !== path)));
        if (field === 'table') setRemoved(prev => ({ ...prev, [group]: [] }));
        if (field === 'table') setExtraColumns(prev => ({ ...prev, [group]: {} }));
      }}>
        <option value="">— Not used —</option>
        {Array.from(new Set([...options, ...(value && (!table?.fieldTypes || options.includes(value)) ? [value] : [])])).map(v => <option key={v} value={v}>{v}</option>)}
      </select>;
    return <div key={field} className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${id}-${path}`} className="min-w-0 break-words text-sm text-ink-soft">{label} {guessed[path] != null && <span aria-label={guessed[path] < 0.8 ? 'Check this guess' : undefined} className="rounded-md bg-sunken px-2 text-xs text-ink-soft">{guessed[path] < 0.8 ? 'Check' : 'Guessed'}</span>}</label>
        {opts?.onRemove && <button type="button" aria-label={`Remove ${label} from ${sectionName(group)}`} className={removeButton} disabled={!!busy} onClick={opts.onRemove}>Remove</button>}
      </div>
      {control}
    </div>;
  };
  const requiredField = (field: string) => ['table', 'name', 'companyLink'].includes(field);
  const removeField = (group: keyof typeof groups, field: string) => {
    setMapping(prev => {
      const rec = { ...(prev[group] as unknown as Record<string, string>) };
      delete rec[field];
      return { ...prev, [group]: rec as unknown as SourceMapping[keyof typeof groups] };
    });
    setRemoved(prev => ({ ...prev, [group]: [...(prev[group] || []), field] }));
    setGuessed(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== `${group}.${field}`)));
    pendingFocus.current = { kind: 'add', key: group };
  };
  const restoreField = (group: keyof typeof groups, field: string) => {
    setMapping(prev => {
      const rec = { ...(prev[group] as unknown as Record<string, string>) };
      delete rec[field];
      return { ...prev, [group]: rec as unknown as SourceMapping[keyof typeof groups] };
    });
    setRemoved(prev => ({ ...prev, [group]: (prev[group] || []).filter(f => f !== field) }));
    pendingFocus.current = { kind: 'add', key: group };
  };
  const addField = (group: keyof typeof groups) => {
    const rows = added[group] || [];
    const nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    setAdded(prev => ({ ...prev, [group]: [...(prev[group] || []), { id: nextId, label: '' }] }));
    pendingFocus.current = { kind: 'extra', key: `${group}-${nextId}` };
  };
  const renameExtra = (group: keyof typeof groups, row: { id: number; label: string }, nextLabel: string) => {
    // The column stays in draft state while the label is typed, even when
    // the label passes through a reserved value: clearing it here would
    // silently drop the mapping once the label is valid again.
    setAdded(prev => ({ ...prev, [group]: (prev[group] || []).map(r => r.id === row.id ? { ...r, label: nextLabel } : r) }));
  };
  const removeExtra = (group: keyof typeof groups, row: { id: number; label: string }) => {
    setAdded(prev => ({ ...prev, [group]: (prev[group] || []).filter(r => r.id !== row.id) }));
    setExtraColumns(prev => {
      const rec = { ...(prev[group] || {}) };
      delete rec[row.id];
      return { ...prev, [group]: rec };
    });
    pendingFocus.current = { kind: 'add', key: group };
  };
  const extraRow = (group: keyof typeof groups, row: { id: number; label: string }) => {
    const label = row.label.trim();
    const reserved = reservedDraftLabel(group, label);
    const taken = !!label && (reserved || (added[group] || []).some(r => r.id !== row.id && r.label.trim() === label));
    const values = mapping[group] as unknown as Record<string, string>;
    const value = (extraColumns[group] || {})[row.id] || '';
    const table = tables.find(t => t.name === values.table);
    const options = table?.columns.filter(name => table.fieldTypes?.[name] !== 'multipleAttachments') || [];
    return <div key={row.id} className="min-w-0 space-y-3 rounded-lg border border-line p-4">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${id}-${group}-extra-${row.id}`} className="text-sm text-ink-soft">Field label</label>
          <button type="button" aria-label={`Remove ${label || 'field'} from ${sectionName(group)}`} className={removeButton} disabled={!!busy} onClick={() => removeExtra(group, row)}>Remove</button>
        </div>
        <input id={`${id}-${group}-extra-${row.id}`} name={`${group}.extra.${row.id}.label`} className={mappingFieldClass} value={row.label} maxLength={200} disabled={!!busy} ref={el => { extraLabelRefs.current[`${group}-${row.id}`] = el; }} onChange={e => renameExtra(group, row, e.target.value)} />
        {taken && <p className="text-sm text-ink-soft">That name is already used in this section.</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-${group}-extra-${row.id}-column`} className="block text-sm text-ink-soft">Airtable field</label>
        <select id={`${id}-${group}-extra-${row.id}-column`} name={`${group}.extra.${row.id}`} className={mappingFieldClass} value={value} disabled={!!busy || !label || reserved} onChange={e => {
          setExtraColumns(prev => ({ ...prev, [group]: { ...(prev[group] || {}), [row.id]: e.target.value } }));
        }}>
          <option value="">— Not used —</option>
          {Array.from(new Set([...options, ...(value && (!table?.fieldTypes || options.includes(value)) ? [value] : [])])).map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
    </div>;
  };
  const preview = (group: keyof typeof groups) => {
    const merged = withDrafts(mapping);
    const data = previewRows(samples || {}, { ...merged, companies: { ...merged.companies, factoryValues: commaList(factoryValues), ...(foodServiceValues || merged.companies.foodServiceValues ? { foodServiceValues: commaList(foodServiceValues) } : {}) }, group1Values: commaList(group1Values) }, group, group1Label.trim() || 'Group 1');
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
        const rawValue = row.fields[column!];
        const value = typeof rawValue === 'string' ? rawValue.trim() : typeof rawValue === 'number' ? String(rawValue) : '';
        if (!value) continue;
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
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="flex max-h-[95dvh] w-full min-w-0 max-w-2xl flex-col rounded-t-xl bg-surface text-ink tactile-4">
      <div className="flex shrink-0 items-center gap-4 border-b border-line px-4 py-2 sm:px-6"><h2 id={`${id}-title`} className="flex-1 text-2xl font-semibold">Connect database</h2><button type="button" aria-label="Close" onClick={onClose} className={`${sourceButton} w-11 px-0 inline-flex items-center justify-center`}><X aria-hidden="true" className="h-5 w-5" /></button></div>
      <form className="flex min-h-0 flex-col" onSubmit={e => { e.preventDefault(); void run('save'); }}>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:px-6">
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-expanded={showSettings} aria-controls={`${id}-connection-settings`} className={`${sourceButton} inline-flex items-center gap-2`} disabled={!!busy} onClick={() => setShowSettings(open => !open)}>
              Connection settings <ChevronDown aria-hidden="true" className={`size-5 ${showSettings ? 'rotate-180' : ''}`} />
            </button>
            <div id={`${id}-connection-settings`} hidden={!showSettings} className="w-full space-y-4">
              <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Source</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{['Airtable', 'Google Sheets', 'Excel', 'Supabase'].map((name, i) => <button key={name} type="button" disabled={i !== 0} aria-pressed={i === 0} className={sourceButton}>{name}{i !== 0 && <span className="block text-xs">Coming soon</span>}</button>)}</div></fieldset>
              <div>
                <div className="flex items-center gap-2"><label htmlFor={`${id}-base`} className="block text-sm text-ink-soft">Base ID</label><button type="button" ref={baseHelpButton} aria-label="How to find your Base ID" aria-expanded={helpBase} aria-controls={`${id}-base-help`} className={helpButton} disabled={!!busy} onClick={() => setHelpBase(v => !v)}>?</button></div>
                <input id={`${id}-base`} name="baseId" placeholder="app…" className={fieldClass} value={baseId} disabled={!!busy} onChange={e => { setBaseId(e.target.value); clearSchema(); }} />
                {helpBase && <div id={`${id}-base-help`} className="mt-2 space-y-2 rounded-lg border border-line bg-sunken p-3">
                  <ol className="list-decimal space-y-1 pl-5 text-base text-ink-soft">
                    <li>Open your base in Airtable in a browser.</li>
                    <li>Look at the address bar.</li>
                    <li>Copy from <code className="font-mono">app</code> up to the next slash. That is your Base ID.</li>
                  </ol>
                  <button type="button" aria-label="Close Base ID help" className={sourceButton} disabled={!!busy} onClick={() => { setHelpBase(false); baseHelpButton.current?.focus(); }}>Close</button>
                </div>}
              </div>
              <div>
                <div className="flex items-center gap-2"><label htmlFor={`${id}-key`} className="block text-sm text-ink-soft">Access key</label><button type="button" ref={keyHelpButton} aria-label="How to find your access key" aria-expanded={helpKey} aria-controls={`${id}-key-help`} className={helpButton} disabled={!!busy} onClick={() => setHelpKey(v => !v)}>?</button></div>
                <input id={`${id}-key`} name="apiKey" type="password" autoComplete="off" className={fieldClass} value={apiKey} disabled={!!busy} onChange={e => { setApiKey(e.target.value); clearSchema(); }} />{connection.hasKey && <p className="text-sm text-ink-soft">{`A key is saved (…${connection.keyHint?.slice(-4) || ''}). Leave empty to keep it.`}</p>}
                {helpKey && <div id={`${id}-key-help`} className="mt-2 space-y-2 rounded-lg border border-line bg-sunken p-3">
                  <ol className="list-decimal space-y-1 pl-5 text-base text-ink-soft">
                    <li>In Airtable, tap your profile picture, then Builder Hub, then Personal access tokens.</li>
                    <li>Tap Create token and name it, for example Shutfey.</li>
                    <li>Tap Add a scope and add <code className="font-mono">data.records:read</code> and <code className="font-mono">schema.bases:read</code>. Add <code className="font-mono">data.records:write</code> only if you chose Read and write.</li>
                    <li>Tap Add a base and pick your base.</li>
                    <li>Tap Create token and copy it right away. Airtable shows it only once.</li>
                  </ol>
                  <p className="text-base text-ink-soft">If you cannot find Builder Hub, open <a className="text-gold-deep underline" href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer">airtable.com/create/tokens</a>.</p>
                  <button type="button" aria-label="Close access key help" className={sourceButton} disabled={!!busy} onClick={() => { setHelpKey(false); keyHelpButton.current?.focus(); }}>Close</button>
                </div>}
              </div>
              <fieldset disabled={!!busy}><legend className="text-sm text-ink-soft">Access</legend>{(['read', 'readwrite'] as const).map(value => <label key={value} className="flex min-h-11 items-center gap-2"><input type="radio" name="access" value={value} checked={access === value} onChange={() => setAccess(value)} />{value === 'read' ? 'Read only' : 'Read and write'}</label>)}<p className="text-sm text-ink-soft">Read only is enough for now. Read and write lets you manage your database from the app later.</p></fieldset>
            </div>
            <button type="button" className={sourceButton} disabled={!!busy || !baseId.trim()} onClick={() => void run('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          </div>
          {message && <p role="status" className="text-base text-ink">{message}</p>}
          <section aria-labelledby={`${id}-mapping-title`} className="space-y-3 border-t border-line pt-4">
            <h3 id={`${id}-mapping-title`} className="text-xl font-semibold">Mapping</h3>
            <div role="group" aria-label="Mapping section" className="flex flex-wrap gap-2">
              {mappingGroups.map(group => <button key={group} type="button" aria-pressed={section === group} aria-controls={`${id}-mapping-${group}`} className={`${sourceButton} aria-pressed:border-ink aria-pressed:bg-sunken`} onClick={() => { setSection(group); setShowRemoved(false); }}>{sectionTabs[group]}</button>)}
            </div>
            {mappingGroups.map(group => <fieldset key={group} id={`${id}-mapping-${group}`} hidden={section !== group} disabled={section !== group} className="min-w-0 space-y-4 rounded-xl border border-line px-4 pb-4">
              <legend className="px-1 text-base font-semibold">{sectionName(group)}</legend>
              {select(group, 'table', 'Table')}
              <div className="space-y-2 border-t border-line pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-base font-semibold">Fields</h4>
                  <button type="button" aria-label={`Add field to ${sectionName(group)}`} className={`${sourceButton} inline-flex items-center gap-2`} disabled={!!busy} ref={el => { addButtonRefs.current[group] = el; }} onClick={() => addField(group)}><Plus aria-hidden="true" className="size-5" />Add field</button>
                </div>
                <p className="text-base text-ink-soft">{tables.length ? 'Choose the Airtable field that supplies each value.' : 'Test the connection to load the available Airtable fields.'}</p>
                {added[group].length > 0 && <div className="space-y-3">{added[group].map(row => extraRow(group, row))}</div>}
                <div className="space-y-3">
                  {group !== 'companies' && mapping[group].certification && <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" checked={mapping.certificationOrganizations?.[group] ??
                      (group === 'ingredients' && mapping[group].table === 'Ingredients List' && mapping[group].certification === 'Certification')}
                      onChange={e => setMapping(m => ({...m, certificationOrganizations:{...m.certificationOrganizations,[group]:e.target.checked}}))} />
                    Certification column contains certifying agency names</label>}
                  {group !== 'products' && select(group, 'locAttachment', group === 'companies' ? 'Letter of Certification (LOC)' : 'Certification PDF')}
                  {groups[group].filter(([field]) => !removed[group].includes(field)).map(([field, label]) => select(group, field, label, requiredField(field) ? undefined : { onRemove: () => removeField(group, field) }))}
                </div>
                {removed[group].length > 0 && <>
                  <button type="button" aria-expanded={showRemoved} aria-controls={`${id}-removed-${group}`} className={sourceButton} disabled={!!busy} onClick={() => setShowRemoved(open => !open)}>Hidden fields ({removed[group].length})</button>
                  <div id={`${id}-removed-${group}`} hidden={!showRemoved} className="space-y-2">
                    {removed[group].map(field => {
                      const label = groups[group].find(([key]) => key === field)?.[1] || field;
                      return <div key={field} className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 break-words text-sm text-ink-soft">{label} (hidden)</p>
                        <button type="button" aria-label={`Restore ${label} in ${sectionName(group)}`} className={sourceButton} disabled={!!busy} onClick={() => restoreField(group, field)}>Restore</button>
                      </div>;
                    })}
                  </div>
                </>}
              </div>
              {group === 'companies' && <>
                <div><label htmlFor={`${id}-types`} className="block text-sm text-ink-soft">Which types are factories</label><input id={`${id}-types`} name="factoryValues" className={fieldClass} value={factoryValues} disabled={!!busy} onChange={e => setFactoryValues(e.target.value)} /></div>
                <label className="block text-sm text-ink-soft">Which types are food service places<input name="foodServiceValues" className={fieldClass} value={foodServiceValues} disabled={!!busy} onChange={e => setFoodServiceValues(e.target.value)} /></label>
              </>}
              {preview(group)}
            </fieldset>)}
          </section>
          <fieldset className="space-y-4"><legend className="text-xl font-semibold">What each value means</legend>
            <p className="text-base text-ink-soft">Your database writes the certification in different ways. Tell the app once what each one means — it applies to every ingredient that uses it.</p>
            {(valueSearch || Math.max(values.length, storedValueTotal) > 20) && <label className="block text-sm text-ink-soft">Search values<input className={fieldClass} name="valueSearch" value={valueSearch} onChange={e => setValueSearch(e.target.value)} /></label>}
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
        </div>
        <div className="shrink-0 space-y-2 border-t border-line bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6">
          {error && <p role="alert" className="max-h-24 overflow-y-auto break-words text-base text-bad">{error}</p>}
          <button type="submit" disabled={!!busy || !ready} className="pressable min-h-12 w-full rounded-lg bg-gold-deep px-4 text-base font-semibold text-paper focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  </div>;
}
