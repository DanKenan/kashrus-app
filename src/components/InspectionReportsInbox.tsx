import React, { useEffect, useRef, useState } from 'react';
import { markLabels, type Mark, type OffListItem, type ReportSummary, type VisitItem } from '../lib/inspectionVisit';
import { SourceText, VisitCounts, VisitSheet, visitButton, visitRequest, visitTime, useVisitFocus } from './FactoryVisitScreen';
export interface ReportDetail extends ReportSummary {
  note: string;
  marks: (Omit<Mark, 'photo'> & { hasPhoto: boolean; item: Pick<VisitItem, 'name' | 'brand' | 'code' | 'certificationRaw' | 'statusRaw'> })[];
  offList: (Omit<OffListItem, 'photo'> & { hasPhoto: boolean })[];
}
export function InspectionReportDetail({ id, timeZone, onClose }: { key?: string; id: string; timeZone: string; onClose(): void }) {
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [photos, setPhotos] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState(''); const [loadingPhotos, setLoadingPhotos] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void visitRequest(`/api/inspections/reports/${encodeURIComponent(id)}`).then(body => { if (alive.current) setReport(body.report); }).catch(e => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; };
  }, [id]);
  const loadPhotos = async () => {
    if (loadingPhotos || photos || !report?.photoCount) return;
    setLoadingPhotos(true); setError('');
    try { const body = await visitRequest(`/api/inspections/reports/${encodeURIComponent(id)}/photos`); if (alive.current) setPhotos(body.photos); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not load photos.'); }
    finally { if (alive.current) setLoadingPhotos(false); }
  };
  const photo = (key: string, hasPhoto: boolean) => hasPhoto ? photos?.[key] ? <a href={photos[key]} target="_blank" rel="noreferrer" aria-label="Open report photo" className="inline-flex min-h-11 min-w-11"><img alt="Report photo" src={photos[key]} className="max-h-48 rounded-lg" /></a> : <p className="text-ink-soft">Photo attached</p> : null;
  return <VisitSheet title="Report details" onClose={onClose}>{error && <p role="alert" className="whitespace-pre-wrap break-words text-bad">{error}</p>}{!report ? <p role="status">Loading report…</p> : <>
    <h3 dir="auto" className="whitespace-pre-wrap break-words text-xl font-semibold">{report.companyName}</h3><p dir="auto" className="whitespace-pre-wrap break-words">{report.mashgiachName}</p><p>Submitted {visitTime(report.submittedAt, timeZone)}</p><p>Started {visitTime(report.startedAt, timeZone)}</p><VisitCounts counts={report.counts} />{report.listChanged && <p>List changed</p>}<p dir="auto" className="whitespace-pre-wrap break-words">{report.note}</p>
    {report.photoCount > 0 && !photos && <button type="button" className={visitButton} disabled={loadingPhotos} onClick={() => void loadPhotos()}>{loadingPhotos ? 'Loading photos…' : 'Load photos'}</button>}
    {(['alert', 'not_used', 'checked'] as const).map(status => <section key={status} className="space-y-2"><h3 className="text-xl font-semibold">{status === 'alert' ? '⚠ Alerts' : markLabels[status]}</h3>{report.marks.map((mark, index) => mark.status === status && <div key={index} className="space-y-2 rounded-xl border border-line p-4"><p>{mark.kind === 'ingredient' ? 'Ingredient' : 'Product'}</p><SourceText item={mark.item} /><p dir="auto" className="whitespace-pre-wrap break-words">{mark.note}</p>{photo(`mark:${index}`, mark.hasPhoto)}</div>)}</section>)}
    <section className="space-y-2"><h3 className="text-xl font-semibold">Off-list items</h3>{report.offList.map((row, index) => <div key={index} className="space-y-2 rounded-xl border border-line p-4"><p dir="auto" className="whitespace-pre-wrap break-words">{row.name}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.brand}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.note}</p>{photo(`off:${index}`, row.hasPhoto)}</div>)}</section>
  </>}</VisitSheet>;
}
export function InspectionReportsInbox({ timeZone, onClose }: { timeZone: string; onClose(): void }) {
  const root = useVisitFocus(onClose);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [more, setMore] = useState(true);
  const active = useRef(true); const lock = useRef(false);
  const load = async (before?: string) => {
    if (lock.current) return; lock.current = true; setLoading(true); setError('');
    try {
      const body = await visitRequest(`/api/inspections/reports?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (active.current) { setReports(current => [...(before ? current : []), ...body.reports].filter((row, index, all) => all.findIndex(item => item.id === row.id) === index)); setMore(body.reports.length === 50); }
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'Could not load reports.'); }
    finally { lock.current = false; if (active.current) setLoading(false); }
  };
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
  return <div ref={root} role="dialog" aria-modal="true" aria-label="Reports" className="fixed inset-0 z-50 overflow-y-auto bg-paper text-ink"><div className="mx-auto max-w-2xl space-y-4 p-4 pb-24"><div className="flex items-center gap-4"><button type="button" aria-label="Close" className={`${visitButton} h-11 w-11 px-0`} onClick={onClose}>×</button><h2 className="text-2xl font-semibold">Reports</h2></div>{error && <p role="alert" className="whitespace-pre-wrap break-words text-bad">{error}</p>}<ul className="space-y-2">{reports.map(report => <li key={report.id}><button type="button" className={`${visitButton} w-full space-y-2 p-4 text-left`} onClick={() => setSelected(report.id)}><h3 dir="auto" className="whitespace-pre-wrap break-words text-xl font-semibold">{report.companyName}</h3><p dir="auto" className="whitespace-pre-wrap break-words">{report.mashgiachName}</p><p>{visitTime(report.submittedAt, timeZone)}</p><VisitCounts counts={report.counts} />{report.hasAlerts && <span className="inline-flex rounded-full bg-warn-bg px-3 py-2 text-warn">⚠ Alert</span>}{report.listChanged && <p>List changed</p>}</button></li>)}</ul>{loading && <p role="status">Loading reports…</p>}{!loading && !error && !reports.length && <p>No reports yet.</p>}{more && <button type="button" className={visitButton} disabled={loading} onClick={() => void load(reports.length ? JSON.stringify({ submittedAt: reports.at(-1)!.submittedAt, id: reports.at(-1)!.id }) : undefined)}>{error ? 'Try again' : 'Load more'}</button>}{selected && <InspectionReportDetail key={selected} id={selected} timeZone={timeZone} onClose={() => setSelected(null)} />}</div></div>;
}
