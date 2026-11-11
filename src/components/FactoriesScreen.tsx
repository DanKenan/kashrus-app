import React, { useEffect, useRef, useState } from 'react';
import { FactoryItemChip } from './FactoryItemChip';
import { InspectionReportsInbox } from './InspectionReportsInbox';
import { VisitScheduleEditor } from './VisitScheduleEditor';
import { visitRequest } from './FactoryVisitScreen';
import { calendarDate, displayDate, overdueDaysText, type ScheduleData, type ScheduleCompany } from '../lib/visitSchedule';
import { X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { sourceRequest, sourceStatus, type SourceConnection } from '../lib/sources';
import { SourceConnectSheet, sourceButton } from './SourceConnectSheet';
interface Factory { id: string; name: string; brand?: string; plant?: string; ingredientCount: number; productCount: number }
interface Props { isOpen: boolean; onClose: () => void; timeZone: string; role?: string }
export function FactoriesScreen({ isOpen, onClose, timeZone, role = 'admin' }: Props) {
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);
  const [scheduleFailed, setScheduleFailed] = useState(false);
  const [scheduleReload, setScheduleReload] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setScheduleFailed(false);
    if (!isOpen) { setScheduleData(null); setEditing(null); return; }
    void visitRequest('/api/inspections/schedule').then(data => { if (active && data.settings && data.people) setScheduleData(data); }).catch(() => { if (active) { if (role === 'coordinator') setScheduleFailed(true); else setError("Couldn't load visit schedules. Try again."); } });
    return () => { active = false; };
  }, [isOpen, scheduleReload]);
  const updateCompany = (company: ScheduleCompany) => setScheduleData(data => data && ({ ...data, companies: data.companies.map(row => row.id === company.id ? company : row) }));
  const [connection, setConnection] = useState<SourceConnection | null>(null);
  const [visitGroup1Label, setVisitGroup1Label] = useState('Group 1');
  const [companies, setCompanies] = useState<Factory[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<Factory | null>(null);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const refreshingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!isOpen) { setSettings(false); setReportsOpen(false); setSelectedCompany(null); return; }
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
        if (role !== 'admin') {
          const result = await visitRequest('/api/visits/factories');
          if (generation.current === request) { setCompanies(result.companies || []); setVisitGroup1Label(result.group1Label ?? 'Group 1'); }
          return;
        }
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
  }, [isOpen, reload, role]);
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
      {role === 'coordinator' && <p className="text-base text-ink-soft">Showing the companies assigned to you.</p>}
      {role === 'admin' && scheduleData && <VisitScheduleSettings data={scheduleData} onSaved={settings => setScheduleData(data => data && ({ ...data, settings }))} />}
      <p role="status" className="break-words text-base text-ink-soft">{role === 'coordinator' ? '' : connection ? sourceStatus(connection, timeZone) : 'Loading factories…'}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={sourceButton} onClick={() => setReportsOpen(true)}>Reports</button>{role === 'admin' && <><button type="button" className={sourceButton} disabled={refreshing || !connection?.sourceType} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh now'}</button><button type="button" className={sourceButton} disabled={!connection} onClick={() => setSettings(true)}>Settings</button></>}</div>
      {role === 'coordinator' && scheduleFailed && <p role="alert" className="text-base"><button type="button" className={sourceButton} onClick={() => setScheduleReload(k => k + 1)}>Couldn't load visit schedules. Try again</button></p>}
      {error && <p role="alert" className="break-words text-base text-bad">{error}</p>}
      {role === 'admin' && connection && !connection.sourceType ? <div className="space-y-4 rounded-xl border border-line bg-surface p-6 text-center"><p className="text-base">Connect your database to see your factories here.</p><button type="button" onClick={() => setSettings(true)} className="pressable min-h-12 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper">Connect</button></div> : <ul className="space-y-2">{[...companies].sort((a, b) => a.name.localeCompare(b.name)).map(company => <li key={company.id}><div className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4"><button type="button" onClick={() => setSelectedCompany(company)} className="pressable min-h-11 w-full space-y-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
        <h3 dir="auto" className="break-words text-xl font-semibold">{company.name}</h3>
        {(company.brand || company.plant) && <p dir="auto" className="break-words text-base text-ink-soft">{[company.brand, company.plant].filter(Boolean).join(' / ')}</p>}
        <p className="text-base text-ink-soft">{company.ingredientCount} ingredients · {company.productCount} products</p>
        {(() => { const row = scheduleData?.companies.find(row => row.id === company.id); if (role === 'coordinator' && !row) return <dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">{['Last visit', 'Next due', 'Overdue'].map(label => <div key={label}><dt>{label}</dt><dd aria-label="Not loaded yet">—</dd></div>)}</dl>; return <><dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft"><div><dt>Last visit</dt><dd>{row?.lastVisit ? `${displayDate(calendarDate(row.lastVisit.at, scheduleData!.timeZone), scheduleData!.today)} · ${row.lastVisit.mashgiachName}` : 'None yet'}</dd></div><div><dt>Next due</dt><dd>{row?.nextDue ? displayDate(row.nextDue, scheduleData!.today) : 'No schedule'}</dd></div><div><dt>Overdue</dt><dd>{row?.status === 'overdue' ? `⚠ Yes · ${overdueDaysText(row.overdueDays)}` : 'No'}</dd></div></dl>{row?.mute && (row.mute.until === null || row.mute.until >= scheduleData!.today) && <span className="text-xs text-ink-soft">Alerts off</span>}</>; })()}
      </button>{(role === 'coordinator' || scheduleData?.companies.some(row => row.id === company.id)) && <button type="button" className={sourceButton} disabled={role === 'coordinator' && !scheduleData?.companies.some(row => row.id === company.id)} onClick={() => setEditing(company.id)}>Visit schedule</button>}</div></li>)}</ul>}
    </div>
    {editing && scheduleData && <VisitScheduleEditor key={editing} company={scheduleData.companies.find(row => row.id === editing)!} data={scheduleData} isAdmin={role === 'admin'} onSaved={updateCompany} onClose={() => setEditing(null)} />}
    {reportsOpen && <InspectionReportsInbox timeZone={timeZone} onClose={() => setReportsOpen(false)} />}
    {selectedCompany && <CompanyItemsSheet isAdmin={role === 'admin'} company={selectedCompany} group1Label={role === 'admin' ? connection?.group1Label || 'Group 1' : visitGroup1Label} onClose={() => setSelectedCompany(null)} />}
    {role === 'admin' && connection && <SourceConnectSheet isOpen={settings} connection={connection} onClose={() => setSettings(false)} onSaved={() => setReload(k => k + 1)} />}
  </div>;
}

interface FactoryItem { certificationRaw?: string; statusRaw?: string; agencyRaw?: string; confidence?: number; id: string; name: string; agency: string; dpm: string | null; group1: boolean; group1Source: 'source' | 'admin' }
export function CompanyItemsSheet({ company, group1Label, onClose, isAdmin = true }: { isAdmin?: boolean; company: Pick<Factory, 'id' | 'name'>; group1Label: string; onClose(): void }) {
  const [items, setItems] = useState<{ ingredients: FactoryItem[]; products: FactoryItem[] } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const lock = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setItems(null); setError('');
    const request = isAdmin ? sourceRequest(`/api/factories/${encodeURIComponent(company.id)}/items`) : visitRequest(`/api/visits/factories/${encodeURIComponent(company.id)}`);
    void request.then(result => { if (active) setItems(result); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [company.id, isAdmin]);
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
    if (!isAdmin || lock.current) return;
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
        return <li key={item.id} className="space-y-2 rounded-lg border border-line p-4"><p dir="auto" className="break-words text-base">{item.name}</p><div className="space-y-2">{[item.certificationRaw, item.statusRaw, item.agencyRaw].filter(Boolean).map((value, index) => <p key={index} className="break-words text-base">{value}</p>)}<div className="flex flex-wrap gap-2">{[item.agency ? `Agency: ${item.agency}` : '', item.dpm === 'dairy_equipment' ? 'DE' : item.dpm ? item.dpm[0].toUpperCase() + item.dpm.slice(1) : '', item.confidence !== undefined && item.confidence < 0.8 ? 'Check' : ''].filter(Boolean).map(chip => <FactoryItemChip key={chip}>{chip}</FactoryItemChip>)}</div></div><p className="text-base">{group1Label}: {item.group1 ? 'Yes' : '—'} {item.group1Source === 'admin' && '(set by admin)'}</p>{isAdmin && <div className="flex flex-wrap gap-2"><button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, !item.group1)}>{saving === `${kind}:${item.id}` ? 'Saving…' : item.group1 ? `Remove ${group1Label}` : `Mark as ${group1Label}`}</button>{item.group1Source === 'admin' && <button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, null)}>Use source value</button>}</div>}</li>;
      })}</ul></section>)}
    </div>
  </div>;
}

function VisitScheduleSettings({ data, onSaved }: { data: ScheduleData; onSaved(settings: ScheduleData['settings']): void }) {
  const [settings, setSettings] = useState(data.settings), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  return <details className="rounded-xl border border-line bg-surface p-4"><summary className="min-h-11 cursor-pointer text-base">Visit schedule settings</summary><form className="space-y-4" onSubmit={async event => { event.preventDefault(); if (lock.current) return; const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== data.settings[key as keyof typeof settings])); if (!Object.keys(patch).length) return; lock.current = true; setBusy(true); setError(''); try { const result = await visitRequest('/api/inspections/schedule/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); onSaved(result.settings); } catch { setError("Couldn't save. Check the connection and try again."); } finally { lock.current = false; setBusy(false); } }}><fieldset disabled={busy}><legend>Count the next visit from:</legend>{([['last_visit', 'The last visit', 'Next visit = last visit + the time you set'], ['planned', 'The planned dates', 'Visits follow fixed planned dates, even if one was late']] as const).map(([value, label, hint]) => <label key={value} className="block py-2"><span className="flex min-h-11 items-center gap-2"><input type="radio" name="countFrom" checked={settings.countFrom === value} onChange={() => setSettings({ ...settings, countFrom: value })} />{label}</span><span className="text-sm text-ink-soft">{hint}</span></label>)}</fieldset><fieldset disabled={busy}><legend>Mashgichim can also visit companies not assigned to them</legend>{[true, false].map(value => <label key={String(value)} className="flex min-h-11 items-center gap-2"><input type="radio" name="seeAll" checked={settings.mashgichimSeeAll === value} onChange={() => setSettings({ ...settings, mashgichimSeeAll: value })} />{value ? 'Yes' : 'No'}</label>)}</fieldset>{error && <p role="alert" className="text-bad">{error}</p>}<button type="submit" className={sourceButton} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></form></details>;
}
