import { ItemAgency } from './CompanyItemLists';
import { CompanyScreen } from './CompanyScreen';
import { CompanyRemovalSheet, companyRemovalRequest } from './CompanyInfoSheet';
import { FeesAccountantSettings } from './FeesAccountantSettings';
import { PayScreen } from './PayScreen';
import { yearlyVisits } from '../lib/fees';
import React, { useEffect, useRef, useState } from 'react';
import { FactoryItemChip } from './FactoryItemChip';
import { InspectionReportDetail, InspectionReportsInbox } from './InspectionReportsInbox';
import { VisitScheduleEditor } from './VisitScheduleEditor';
import { VisitSheet, visitRequest, visitTime } from './FactoryVisitScreen';
import { calendarDate, displayDate, overdueDaysText, type ScheduleData, type ScheduleCompany } from '../lib/visitSchedule';
import { Plus, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { sourceRequest, sourceStatus, type SourceConnection } from '../lib/sources';
import { sourceButton } from './SourceConnectSheet';
import { SourcesSheet } from './SourcesSheet';
import { SheetRecordEditor, SheetRecordList, sheetSectionNames } from './SheetRecordEditor';
import type { SourceSection } from '../lib/sourcePreview';
import { SourceCompanyEditor } from './SourceCompanyEditor';
import { canEdit, lastReadText, providers } from '../lib/sourcesSetup';
import type { ReportSummary } from '../lib/inspectionVisit';
interface Factory { archived?: boolean; removalPending?: boolean; companyFee?: number; address?: string; type?: string; id: string; name: string; brand?: string; plant?: string; ingredientCount: number; productCount: number }
interface Props { isOpen: boolean; onClose: () => void; timeZone: string; role?: string }
export function FactoriesScreen({ isOpen: requestedOpen, onClose: requestedClose, timeZone, role = 'admin' }: Props) {
  const [oauthReturn, setOauthReturn] = useState(() => typeof window !== 'undefined' && role === 'admin' && ['google_sheets', 'excel'].includes(new URLSearchParams(window.location.search).get('sources') || ''));
  const isOpen = requestedOpen || oauthReturn;
  const onClose = () => { setOauthReturn(false); if (oauthReturn) { const url = new URL(window.location.href); url.searchParams.delete('sources'); url.searchParams.delete('signin'); window.history.replaceState(null, '', url); } requestedClose(); };
  const [sheetList, setSheetList] = useState<SourceSection | null>(null);
  const [sheetRecord, setSheetRecord] = useState<{ section: SourceSection; row?: Pick<Factory, 'id' | 'name'> } | null>(null);
  const [companyEditor, setCompanyEditor] = useState(false);
  const [companyScreen, setCompanyScreen] = useState<Factory | null>(null);
  const [feesSettings, setFeesSettings] = useState(false), [payOpen, setPayOpen] = useState(false);
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
  const sheetSections = role === 'admin' && connection?.sourceType === 'google_sheets' ? connection.sheetsEditSections : undefined;
  const [selectedCompany, setSelectedCompany] = useState<Factory | null>(null);
  const [reportsOpen, setReportsOpen] = useState<{ companyId?: string; companyName?: string } | null>(null);
  const [reportDetail, setReportDetail] = useState<string | null>(null);
  const [recentReports, setRecentReports] = useState<ReportSummary[] | null>(null);
  const [reportError, setReportError] = useState(false);
  const [reportsReload, setReportsReload] = useState(0);
  const [archived, setArchived] = useState(false);
  const [removal, setRemoval] = useState<Factory | null>(null);
  const [companyChange, setCompanyChange] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [addHelp, setAddHelp] = useState(false);
  const restoreLock = useRef(false);
  const companiesHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setRecentReports(null); setReportError(false);
    void (async () => {
      const reports: ReportSummary[] = [];
      const query = new URLSearchParams({ limit: '3', more: '1' });
      do {
        const page = await visitRequest(`/api/inspections/reports?${query}`);
        if (!active) return;
        reports.push(...page.reports);
        if (!page.nextCursor || reports.length >= 3) break;
        query.set('before', JSON.stringify(page.nextCursor));
      } while (active);
      if (active) setRecentReports(reports.slice(0, 3));
    })().catch(() => { if (active) setReportError(true); });
    return () => { active = false; };
  }, [isOpen, reportsReload, role]);
  const [settings, setSettings] = useState(oauthReturn);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const refreshingRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (!isOpen) { setSettings(false); setReportsOpen(null); setReportDetail(null); setRemoval(null); setArchived(false); setCompanyChange(''); setAddHelp(false); setCompanyEditor(false); setCompanyScreen(null); setFeesSettings(false); setPayOpen(false); setSelectedCompany(null); setSheetList(null); setSheetRecord(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const schedule = (current: SourceConnection) => {
      if ((current.status !== 'recovering' && (current.status !== 'never' || polls >= 10)) || generation.current !== request) return;
      timer = setTimeout(async () => {
        if (generation.current !== request) return;
        polls += 1;
        let next = current;
        try {
          if (current.status === 'recovering') {
            const saved = await sourceRequest('/api/sources/connection');
            if (generation.current !== request) return;
            if (saved.status === 'recovering') schedule(saved);
            else setReload(k => k + 1);
            return;
          }
          const result = await sourceRequest('/api/factories');
          if (generation.current !== request) return;
          next = { ...current, ...result.status };
          setConnection(next); setCompanies(next.status === 'never' ? [] : result.companies || []); setError('');
        } catch (e) {
          if (generation.current !== request) return;
          setError(e instanceof Error ? e.message : "Couldn't load factories. Try again.");
        }
        schedule(next);
      }, polls >= 10 ? 30000 : 3000);
    };
    setCompanies([]); setError('');
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
        if (next.sourceType && next.status !== 'recovering') {
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
  const addCompany = () => {
    if (sheetSections?.includes('companies')) setSheetRecord({ section: 'companies' });
    else if (canEdit(role, connection)) setCompanyEditor(true);
    else setAddHelp(true);
  };
  const showArchived = () => {
    setArchived(true);
    companiesHeading.current?.focus();
  };
  const companyChanged = (change: string) => {
    setCompanyScreen(null); setRemoval(null); setCompanyChange(change);
    setReload(k => k + 1); setScheduleReload(k => k + 1);
  };
  const restore = async (company: Factory) => {
    if (!connection?.companySource || restoreLock.current) return;
    restoreLock.current = true; setRestoring(company.id); setError('');
    try {
      await companyRemovalRequest(company.id, connection.companySource, 'restore');
      companyChanged('Company restored');
    } catch (error) { setError((error as Error).message); }
    finally { restoreLock.current = false; setRestoring(null); }
  };
  const scheduleSections = sheetSections?.filter(section => section !== 'companies') ?? [];
  if (!isOpen) return null;
  return <div role="dialog" aria-modal="true" aria-label="Factories" className="fixed inset-0 z-50 overflow-y-auto bg-paper text-ink" data-factories>
    <div className="mx-auto max-w-2xl space-y-6 px-4 pt-4 pb-24">
      <header className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Close" onClick={onClose} className={`${sourceButton} flex h-11 w-11 shrink-0 items-center justify-center px-0`}><X aria-hidden="true" className="h-5 w-5" /></button>
        <h2 className="min-w-0 flex-1 text-2xl font-semibold">Factories</h2>
        {role === 'admin' && <button type="button" onClick={addCompany} className="pressable inline-flex min-h-12 items-center gap-2 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"><Plus aria-hidden="true" className="h-5 w-5" />Add company</button>}
      </header>
      <section aria-labelledby="recent-visit-reports" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="recent-visit-reports" className="text-xl font-semibold">Recent visit reports</h3>
          <button type="button" className={sourceButton} onClick={() => setReportsOpen({})}>View all reports</button>
        </div>
        {reportError ? <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
          <p role="alert" className="text-bad">Couldn't load visit reports.</p>
          <button type="button" className={sourceButton} onClick={() => setReportsReload(k => k + 1)}>Try again</button>
        </div> : !recentReports ? <div role="status" className="space-y-2">
          <span className="sr-only">Loading reports…</span>
          {[0, 1, 2].map(i => <div key={i} aria-hidden="true" className="h-16 rounded-xl border border-line bg-sunken" />)}
        </div> : recentReports.length ? <ul className="divide-y divide-line rounded-xl border border-line bg-surface tactile-1">
          {recentReports.map(report => <li key={report.id}>
            <button type="button" className="pressable block min-h-11 w-full rounded-xl p-4 text-left focus-visible:ring-2 focus-visible:ring-gold" onClick={() => setReportDetail(report.id)}>
              <span dir="auto" className="block truncate font-semibold">{report.companyName}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft"><time dateTime={report.startedAt}>{visitTime(report.startedAt, timeZone)}</time><span dir="auto" className="min-w-0 truncate">{report.mashgiachName}</span>{(report.followUp || report.status === 'follow_up') && <span className="rounded-full bg-warn-bg px-2 py-1 text-xs font-semibold text-warn">Needs follow-up</span>}</span>
            </button>
          </li>)}
        </ul> : <p className="text-ink-soft">No visit reports yet</p>}
      </section>
      <section aria-labelledby="factory-companies" className="space-y-4">
        <h3 ref={companiesHeading} tabIndex={-1} id="factory-companies" className="text-xl font-semibold">Companies</h3>
        {role === 'coordinator' && <p className="text-base text-ink-soft">Showing the companies assigned to you.</p>}
        {role === 'admin' && <div className="flex flex-wrap gap-2" role="group" aria-label="Company views">
          <button type="button" className={`${sourceButton} aria-pressed:bg-sunken`} aria-pressed={!archived} onClick={() => setArchived(false)}>Active</button>
          <button type="button" className={`${sourceButton} aria-pressed:bg-sunken`} aria-pressed={archived} onClick={() => setArchived(true)}>Archived</button>
        </div>}
        {companyChange && <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-good-bg p-4 text-good">
          <p>{companyChange}</p>
          {companyChange === 'Company archived' && <button type="button" className={sourceButton} onClick={showArchived}>View archived companies</button>}
        </div>}
        {scheduleFailed && <p role="alert"><button type="button" className={sourceButton} onClick={() => setScheduleReload(k => k + 1)}>Couldn't load visit schedules. Try again</button></p>}
        {error && <p role="alert" className="break-words text-base text-bad">{error}</p>}
        {role === 'admin' && connection && !connection.sourceType ? <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
          <p>Connect your database to see your factories here.</p><button type="button" onClick={() => setSettings(true)} className={sourceButton}>Connect</button>
        </div> : <ul className="space-y-2">{companies.filter(company => !!company.archived === archived).sort((a, b) => a.name.localeCompare(b.name)).map(company => <li key={company.id}><div className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4"><button type="button" disabled={company.removalPending} onClick={() => setSelectedCompany(company)} className="pressable min-h-11 w-full space-y-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
        <h3 dir="auto" className="break-words text-xl font-semibold">{company.name}</h3>
        {(company.brand || company.plant) && <p dir="auto" className="break-words text-base text-ink-soft">{[company.brand, company.plant].filter(Boolean).join(' / ')}</p>}
        {!company.removalPending && <p className="text-base text-ink-soft">{company.ingredientCount} ingredients · {company.productCount} products</p>}
        {companyVisitDates(company, scheduleData, role === 'coordinator')}
      </button>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={sourceButton} onClick={() => setReportsOpen({ companyId: company.id, companyName: company.name })}>View visit reports</button>
        {!company.archived && (role === 'coordinator' || scheduleData?.companies.some(row => row.id === company.id)) && <button type="button" className={sourceButton} disabled={role === 'coordinator' && !scheduleData?.companies.some(row => row.id === company.id)} onClick={() => setEditing(company.id)}>Visit schedule</button>}
        {company.removalPending ? <button type="button" className={sourceButton} onClick={() => setRemoval(company)}>Continue permanent removal</button> :
          company.archived && <button type="button" className={sourceButton} disabled={restoring !== null} onClick={() => void restore(company)}>{restoring === company.id ? 'Saving…' : 'Restore company'}</button>}
      </div>
      {!company.removalPending && <button type="button" onClick={() => setCompanyScreen(company)}
        className="pressable block min-h-12 w-full rounded-xl border border-line-control bg-sunken px-4 py-2 text-left text-ink focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2">
        <span className="block font-semibold">Company</span>
        <span className="block text-sm text-ink-soft">Everything about this company</span>
      </button>}
      {scheduleData && !(scheduleData.companies.find(row => row.id === company.id)?.lastVisit || scheduleData.archivedLastVisits?.[company.id]) &&
        !recentReports?.some(report => report.companyId === company.id) && !company.removalPending && <p className="text-ink-soft">No visit reports yet</p>}
      </div></li>)}</ul>}
        {archived && !companies.some(company => company.archived) && <p className="text-ink-soft">No archived companies.</p>}
        {!!sheetSections?.length && <section className="space-y-2">
          <h4 className="font-semibold">Manage source records</h4>
          <div className="flex flex-wrap gap-2">
            {sheetSections.includes('companies') && <button type="button" className={sourceButton} onClick={() => setSheetList('companies')}>Companies</button>}
            {scheduleSections.map(section => <button key={section} type="button" className={sourceButton} onClick={() => setSheetList(section)}>{sheetSectionNames[section]}</button>)}
          </div>
        </section>}
      </section>
      {role === 'admin' && <section aria-labelledby="factory-settings" className="space-y-4">
        <h3 id="factory-settings" className="text-xl font-semibold">Settings</h3>
        <section className="space-y-2 rounded-xl border border-line bg-surface p-4 tactile-1">
          <h4 className="font-semibold">Visit scheduling</h4>
          <p className="text-ink-soft">Choose how Shutfey calculates the next visit and whether mashgichim can visit companies they aren't assigned to.</p>
          {scheduleData ? <VisitScheduleSettings data={scheduleData} onSaved={settings => setScheduleData(data => data && ({ ...data, settings }))} /> :
            <button type="button" disabled className={sourceButton}>Visit schedule settings</button>}
        </section>
        <section className="space-y-2 rounded-xl border border-line bg-surface p-4 tactile-1">
          <h4 className="font-semibold">Fees and payments</h4>
          <button type="button" className={sourceButton} onClick={() => setPayOpen(true)}>Pay</button>
          <p className="text-ink-soft">Review amounts and payments</p>
          <button type="button" className={sourceButton} onClick={() => setFeesSettings(true)}>Fees and accountant</button>
          <p className="text-ink-soft">Manage fee rules and accountant settings.</p>
        </section>
        <section className="space-y-2 rounded-xl border border-line bg-surface p-4 tactile-1">
          <h4 className="font-semibold">Connected data</h4>
          <p role="status" className="break-words text-ink-soft">{connection ? sourceStatus(connection, timeZone) : 'Loading factories…'}</p>
          <p className="text-ink-soft">{lastReadText(connection?.refreshedAt, timeZone)}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={sourceButton} disabled={!connection} onClick={() => setSettings(true)}>Source settings</button>
            <button type="button" className={sourceButton} disabled={refreshing || !connection?.sourceType || connection.status === 'recovering'} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh company data'}</button>
          </div>
        </section>
      </section>}
    </div>
    {addHelp && <VisitSheet title="Add company" onClose={() => setAddHelp(false)}>
      <p>{connection?.sourceType === 'google_sheets'
        ? 'Enable editing for Companies in Source settings to add companies from Shutfey.'
        : 'Connect a source that supports adding companies and enable write access in Source settings.'}</p>
      <button type="button" className={sourceButton} disabled={!connection} onClick={() => { setAddHelp(false); setSettings(true); }}>Open source settings</button>
    </VisitSheet>}
    {companyScreen && <CompanyScreen key={`${role}:${companyScreen.id}`} company={companyScreen} timeZone={timeZone} role={role} connection={connection}
      yearlyCount={yearlyVisits(scheduleData?.companies.find(c => c.id === companyScreen.id)?.schedule, scheduleData?.today.slice(0, 4) || '')}
      onClose={() => setCompanyScreen(null)}
      onSourceSaved={() => { setReload(k => k + 1); setScheduleReload(k => k + 1); }}
      onRemove={role === 'admin' && connection?.companySource ? (name) => setRemoval({ ...companyScreen, name }) : undefined} />}
    {removal && connection?.companySource && <CompanyRemovalSheet company={removal} source={connection.companySource}
      sourceName={providers.find(p => p.id === connection.sourceType)?.name ?? 'Connected source'}
      onClose={() => setRemoval(null)} onChanged={companyChanged} onPending={() => { setCompanyScreen(null); setReload(k => k + 1); setScheduleReload(k => k + 1); }} />}
    {role === 'admin' && feesSettings && <FeesAccountantSettings role={role} onClose={() => setFeesSettings(false)} />}
    {role === 'admin' && payOpen && <PayScreen role={role} timeZone={timeZone} onClose={() => setPayOpen(false)} />}
    {editing && scheduleData?.companies.some(row => row.id === editing) && <VisitScheduleEditor key={editing} company={scheduleData.companies.find(row => row.id === editing)!} data={scheduleData} isAdmin={role === 'admin'} onSaved={updateCompany} onClose={() => setEditing(null)} />}
    {reportsOpen && <InspectionReportsInbox timeZone={timeZone}
      initialFilters={reportsOpen.companyId ? { companyId: reportsOpen.companyId } : undefined}
      initialCompanyName={reportsOpen.companyName} onClose={() => { setReportsOpen(null); setReportsReload(k => k + 1); }} />}
    {reportDetail && <InspectionReportDetail key={reportDetail} id={reportDetail} timeZone={timeZone} onClose={() => setReportDetail(null)}
      onUpdated={report => setRecentReports(rows => rows?.map(row => row.id === report.id ? report : row) ?? null)} />}
    {selectedCompany && <CompanyItemsSheet isAdmin={role === 'admin'} company={selectedCompany} group1Label={role === 'admin' ? connection?.group1Label || 'Group 1' : visitGroup1Label} onClose={() => setSelectedCompany(null)} />}
    {canEdit(role, connection) && companyEditor && <SourceCompanyEditor company={{ name: '' }} source={providers.find(p => p.id === connection?.sourceType)?.name || ''} onClose={() => setCompanyEditor(false)} onSaved={() => { setReload(k => k + 1); setScheduleReload(k => k + 1); }} />}
    {sheetList && sheetSections?.includes(sheetList) && !sheetRecord &&
      <SheetRecordList section={sheetList} onClose={() => setSheetList(null)}
        onChoose={row => setSheetRecord({ section: sheetList, row })}
        onAdd={() => setSheetRecord({ section: sheetList })} />}
    {sheetRecord && sheetSections?.includes(sheetRecord.section) &&
      <SheetRecordEditor key={sheetRecord.row?.id ?? sheetRecord.section} {...sheetRecord} onClose={() => setSheetRecord(null)}
        onSaved={() => { setReload(k => k + 1); setScheduleReload(k => k + 1); }} />}
    {role === 'admin' && connection && <React.Fragment key={connection.status === 'recovering' ? 'recovery' : 'setup'}><SourcesSheet timeZone={timeZone} isOpen={settings} connection={connection} onClose={() => setSettings(false)} onSaved={() => setReload(k => k + 1)} /></React.Fragment>}
  </div>;
}

function companyVisitDates(company: Factory, data: ScheduleData | null, coordinator: boolean) {
  const row = data?.companies.find(row => row.id === company.id);
  const last = company.archived ? data?.archivedLastVisits?.[company.id] : row?.lastVisit;
  const lastLabel = last && data
    ? `${displayDate(calendarDate(last.at, data.timeZone), data.today)} · ${last.mashgiachName}`
    : 'None yet';
  if (company.removalPending) return null;
  if (coordinator && !row) return <dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">
    {['Last visit', 'Next due', 'Overdue'].map(label => <div key={label}><dt>{label}</dt><dd aria-label="Not loaded yet">—</dd></div>)}
  </dl>;
  return <>
    <dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">
      <div><dt>Last visit</dt><dd>{lastLabel}</dd></div>
      {!company.archived && <>
        <div><dt>Next due</dt><dd>{row?.nextDue && data ? displayDate(row.nextDue, data.today) : 'No schedule'}</dd></div>
        <div><dt>Overdue</dt><dd>{row?.status === 'overdue' ? `⚠ Yes · ${overdueDaysText(row.overdueDays)}` : 'No'}</dd></div>
      </>}
    </dl>
    {row?.mute && data && (row.mute.until === null || row.mute.until >= data.today) && <span className="text-xs text-ink-soft">Alerts off</span>}
  </>;
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
        return <li key={item.id} className="space-y-2 rounded-lg border border-line p-4"><p dir="auto" className="break-words text-base">{item.name}</p><div className="space-y-2"><ItemAgency agency={item.agency} />{item.certificationRaw && item.certificationRaw.trim() !== item.agency?.trim() && <p className="break-words text-base">{item.certificationRaw}</p>}{item.statusRaw && <p className="break-words text-base">{item.statusRaw}</p>}<div className="flex flex-wrap gap-2">{[item.dpm === 'dairy_equipment' ? 'DE' : item.dpm ? item.dpm[0].toUpperCase() + item.dpm.slice(1) : '', item.confidence !== undefined && item.confidence < 0.8 ? 'Check' : ''].filter(Boolean).map(chip => <FactoryItemChip key={chip}>{chip}</FactoryItemChip>)}</div></div><p className="text-base">{group1Label}: {item.group1 ? 'Yes' : '—'} {item.group1Source === 'admin' && '(set by admin)'}</p>{isAdmin && <div className="flex flex-wrap gap-2"><button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, !item.group1)}>{saving === `${kind}:${item.id}` ? 'Saving…' : item.group1 ? `Remove ${group1Label}` : `Mark as ${group1Label}`}</button>{item.group1Source === 'admin' && <button type="button" className={sourceButton} disabled={saving !== null} onClick={() => void mark(kind, item, null)}>Use source value</button>}</div>}</li>;
      })}</ul></section>)}
    </div>
  </div>;
}

function VisitScheduleSettings({ data, onSaved }: { data: ScheduleData; onSaved(settings: ScheduleData['settings']): void }) {
  const [settings, setSettings] = useState(data.settings), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== data.settings[key as keyof typeof settings]));
    if (!Object.keys(patch).length) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await visitRequest('/api/inspections/schedule/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      onSaved(result.settings);
    } catch { setError("Couldn't save. Check the connection and try again."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <details className="rounded-lg border border-line-control p-2">
    <summary className="pressable min-h-11 cursor-pointer rounded-md px-2 py-2 text-base font-semibold focus-visible:ring-2 focus-visible:ring-gold">Visit schedule settings</summary>
    <form className="space-y-4 p-2" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>Count the next visit from:</legend>
        {([
          ['last_visit', 'From the last visit', 'Counts from when the visit happened.'],
          ['planned', 'From the planned date', 'Keeps the schedule on its original dates even when a visit is late.'],
        ] as const).map(([value, label, hint]) => <label key={value} className="flex min-h-11 items-start gap-2 py-2">
          <input type="radio" className="mt-1" name="countFrom" checked={settings.countFrom === value} onChange={() => setSettings({ ...settings, countFrom: value })} />
          <span>{label}<span className="block text-sm text-ink-soft">{hint}</span></span>
        </label>)}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Mashgichim can also visit companies not assigned to them</legend>
        {[true, false].map(value => <label key={String(value)} className="flex min-h-11 items-start gap-2 py-2">
          <input type="radio" className="mt-1" name="seeAll" checked={settings.mashgichimSeeAll === value} onChange={() => setSettings({ ...settings, mashgichimSeeAll: value })} />
          {value ? 'Yes — mashgichim can see and visit all companies' : 'No — mashgichim can only see and visit companies assigned to them'}
        </label>)}
      </fieldset>
      {error && <p role="alert" className="text-bad">{error}</p>}
      <button type="submit" className={sourceButton} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
    </form>
  </details>;
}
