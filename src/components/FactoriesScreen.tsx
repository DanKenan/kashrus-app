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
  const [settings, setSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const refreshingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!isOpen) { setSettings(false); return; }
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
          setConnection(next); setCompanies(result.companies || []); setError('');
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
        setConnection(current); setCompanies(list);
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
      {connection && !connection.sourceType ? <div className="space-y-4 rounded-xl border border-line bg-surface p-6 text-center"><p className="text-base">Connect your database to see your factories here.</p><button type="button" onClick={() => setSettings(true)} className="pressable min-h-12 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper">Connect</button></div> : <ul className="space-y-2">{[...companies].sort((a, b) => a.name.localeCompare(b.name)).map(company => <li key={company.id} className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4">
        <h3 dir="auto" className="break-words text-xl font-semibold">{company.name}</h3>
        {(company.brand || company.plant) && <p dir="auto" className="break-words text-base text-ink-soft">{[company.brand, company.plant].filter(Boolean).join(' / ')}</p>}
        <p className="text-base text-ink-soft">{company.ingredientCount} ingredients · {company.productCount} products</p>
        <dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">{['Last visit', 'Next due', 'Overdue'].map(label => <div key={label} className="flex gap-2"><dt>{label}</dt><dd aria-label="Not scheduled yet">—</dd></div>)}</dl>
      </li>)}</ul>}
    </div>
    {connection && <SourceConnectSheet isOpen={settings} connection={connection} onClose={() => setSettings(false)} onSaved={() => setReload(k => k + 1)} />}
  </div>;
}
