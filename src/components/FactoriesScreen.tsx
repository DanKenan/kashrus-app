import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { sourceRequest, sourceStatus, type SourceConnection } from '../lib/sources';
import { SourceConnectSheet, sourceButton } from './SourceConnectSheet';
interface Factory { id: string; name: string; brand?: string; plant?: string; ingredientCount: number; productCount: number }
interface Props { isOpen: boolean; onClose: () => void; timeZone: string }
export function FactoriesScreen({ isOpen, onClose, timeZone }: Props) {
  const [connection, setConnection] = useState<SourceConnection | null>(null);
  const [companies, setCompanies] = useState<Factory[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<Factory | null>(null);
  const [settings, setSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const refreshingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!isOpen) { setSettings(false); setSelectedCompany(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const schedule = (current: SourceConnection) => {
      if (current.status !== 'never' || polls >= 10 || generation.current !== request) return;
      timer = setTimeout(async () => {
        if (generation.current !== request) return;
        polls += 1;
        let next = current;
        try {
          const result = await sourceRequest('/api/factories');
          if (generation.current !== request) return;
          next = { ...current, ...result.status };
          setConnection(next); setCompanies(next.status === 'never' ? [] : result.companies || []); setError('');
        } catch (e) {
          if (generation.current !== request) return;
          setError(e instanceof Error ? e.message : "Couldn't load factories. Try again.");
        }
        schedule(next);
      }, 3000);
    };
    setConnection(null); setCompanies([]); setError('');
    void (async () => {
      try {
        const response = await apiFetch('/api/sources/connection');
        const next = response.status === 404 ? { sourceType: null } : await response.json();
        if (response.status !== 404 && (!response.ok || next.error && !next.sourceType)) throw new Error(next.error || "Couldn't load the connection. Try again.");
        let list: Factory[] = [];
        let status = {};
        if (next.sourceType) {
          const result = await sourceRequest('/api/factories');
          list = result.companies || [];
          status = result.status || {};
        }
        if (generation.current !== request) return;
        const current = { ...next, ...status };
        setConnection(current); setCompanies(current.status === 'never' ? [] : list);
        schedule(current);
      } catch (e) { if (generation.current === request) setError(e instanceof Error ? e.message : "Couldn't load factories. Try again."); }
    })();
    return () => { generation.current += 1; clearTimeout(timer); };
  }, [isOpen, reload]);
  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true); setError('');
    const request = generation.current;
    try {
      await sourceRequest('/api/sources/refresh', 'POST');
      if (generation.current === request) setReload(k => k + 1);
    } catch (e) { if (generation.current === request) setError(e instanceof Error ? e.message : "Couldn't refresh. Try again."); }
    finally { refreshingRef.current = false; setRefreshing(false); }
  };
  if (!isOpen) return null;
  return <div role="dialog" aria-modal="true" aria-label="Factories" className="fixed inset-0 z-50 overflow-y-auto bg-paper text-ink" data-factories>
    <div className="mx-auto max-w-2xl space-y-4 px-4 pt-3 pb-24">
      <div className="flex items-center gap-2"><button type="button" aria-label="Close" onClick={onClose} className={`${sourceButton} flex h-11 w-11 shrink-0 items-center justify-center px-0`}><X aria-hidden="true" className="h-5 w-5" /></button><h2 className="min-w-0 flex-1 text-2xl font-semibold">Factories</h2></div>
      <p role="status" className="break-words text-base text-ink-soft">{connection ? sourceStatus(connection, timeZone) : 'Loading factories…'}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={sourceButton} disabled={refreshing || !connection?.sourceType} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh now'}</button><button type="button" className={sourceButton} disabled={!connection} onClick={() => setSettings(true)}>Settings</button></div>
      {error && <p role="alert" className="break-words text-base text-bad">{error}</p>}
      {connection && !connection.sourceType ? <div className="space-y-4 rounded-xl border border-line bg-surface p-6 text-center"><p className="text-base">Connect your database to see your factories here.</p><button type="button" onClick={() => setSettings(true)} className="pressable min-h-12 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper">Connect</button></div> : <ul className="space-y-2">{[...companies].sort((a, b) => a.name.localeCompare(b.name)).map(company => <li key={company.id}><button type="button" onClick={() => setSelectedCompany(company)} className="pressable min-h-11 w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"><div className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4">
        <h3 dir="auto" className="break-words text-xl font-semibold">{company.name}</h3>
        {(company.brand || company.plant) && <p dir="auto" className="break-words text-base text-ink-soft">{[company.brand, company.plant].filter(Boolean).join(' / ')}</p>}
        <p className="text-base text-ink-soft">{company.ingredientCount} ingredients · {company.productCount} products</p>
        <dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">{['Last visit', 'Next due', 'Overdue'].map(label => <div key={label} className="flex gap-2"><dt>{label}</dt><dd aria-label="Not scheduled yet">—</dd></div>)}</dl>
      </div></button></li>)}</ul>}
    </div>
    {selectedCompany && <CompanyItemsSheet company={selectedCompany} group1Label={connection?.group1Label || 'Group 1'} onClose={() => setSelectedCompany(null)} />}
    {connection && <SourceConnectSheet isOpen={settings} connection={connection} onClose={() => setSettings(false)} onSaved={() => setReload(k => k + 1)} />}
  </div>;
}

interface FactoryItem { certificationRaw?: string; statusRaw?: string; agencyRaw?: string; confidence?: number; id: string; name: string; agency: string; dpm: string | null; group1: boolean; group1Source: 'source' | 'admin' }
export function CompanyItemsSheet({ company, group1Label, onClose }: { company: Pick<Factory, 'id' | 'name'>; group1Label: string; onClose(): void }) {
  const [items, setItems] = useState<{ ingredients: FactoryItem[]; products: FactoryItem[] } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const lock = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setItems(null); setError('');
    void sourceRequest(`/api/factories/${encodeURIComponent(company.id)}/items`).then(result => { if (active) setItems(result); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [company.id]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from<HTMLButtonElement>(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const buttons = controls(), first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const focus = (event: FocusEvent) => { if (!root.current?.contains(event.target as Node)) controls()[0]?.focus(); };
    document.addEventListener('keydown', key, true); document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus); previous?.focus(); };
  }, []);
  const mark = async (kind: 'ingredient' | 'product', item: FactoryItem, group1: boolean | null) => {
    if (lock.current) return;
    lock.current = true; setSaving(`${kind}:${item.id}`); setError('');
    try {
      const result = await sourceRequest('/api/sources/group1', 'PUT', { kind, itemId: item.id, group1 });
      const key = kind === 'ingredient' ? 'ingredients' : 'products';
      setItems(current => current && { ...current, [key]: current[key].map(row => row.id === item.id ? result.item : row) });
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save. Try again."); }
    finally { lock.current = false; setSaving(null); }
  };
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim">
    <div ref={root} role="dialog" aria-modal="true" aria-label={`${company.name} — ingredients`} className="max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-t-2xl bg-surface p-4 text-ink tactile-4">
      <div className="flex items-center gap-4"><h2 dir="auto" className="min-w-0 flex-1 break-words text-2xl font-semibold">{company.name} — ingredients</h2><button type="button" aria-label="Close" className={`${sourceButton} w-11 px-0`} onClick={onClose}><X aria-hidden="true" className="mx-auto h-5 w-5" /></button></div>
      {error && <p role="alert" className="text-base text-bad">{error}</p>}
      {!items ? <p role="status" className="text-base text-ink-soft">Loading ingredients…</p> : (['ingredients', 'products'] as const).map(key => <section key={key} className="space-y-2"><h3 className="text-xl font-semibold">{key === 'ingredients' ? 'Ingredients' : 'Products'}</h3>{!items[key].length && <p className="text-base text-ink-soft">{key === 'ingredients' ? 'No ingredients.' : 'No products.'}</p>}<ul className="space-y-2">{items[key].map(item => {
        const kind = key === 'ingredients' ? 'ingredient' : 'product';
        return <li key={item.id} className="space-y-2 rounded-lg border border-line p-4"><p dir="auto" className="break-words text-base">{item.name}</p><div className="space-y-2">{[item.certificationRaw, item.statusRaw, item.agencyRaw].filter(Boolean).map((value, index) => <p key={index} className="break-words text-base">{value}</p>)}<div className="flex flex-wrap gap-2">{[item.agency ? `Agency: ${item.agency}` : '', item.dpm === 'dairy_equipment' ? 'DE' : item.dpm ? item.dpm[0].toUpperCase() + item.dpm.slice(1) : '', item.confidence !== undefined && item.confidence < 0.8 ? 'Check' : ''].filter(Boolean).map(chip => <span key={chip} className="inline-flex min-h-6 items-center rounded-full bg-sunken px-2 text-xs text-ink-soft">{chip}</span>)}</div></div><p className="text-base">{group1Label}: {item.group1 ? 'Yes' : '—'} {item.group1Source === 'admin' && '(set by admin)'}</p><div className="flex flex-wrap gap-2"><button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, !item.group1)}>{saving === `${kind}:${item.id}` ? 'Saving…' : item.group1 ? `Remove ${group1Label}` : `Mark as ${group1Label}`}</button>{item.group1Source === 'admin' && <button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, null)}>Use source value</button>}</div></li>;
      })}</ul></section>)}
    </div>
  </div>;
}
