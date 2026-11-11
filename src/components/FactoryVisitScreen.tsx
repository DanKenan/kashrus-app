import React, { useEffect, useRef, useState } from 'react';
import { apiFetch, sessionCredentialKey } from '../lib/api';
import { ANSWER_PHOTO_MAX_CHARS, compressPhoto } from './TaskAnswerPhoto';
import { acceptReport, buildPayload, draftKey, markLabels, newDraft, queueReport, readOutbox, removeOutbox, restoreDraft, retryDue, retryResult, saveDraft, setMark, storeOutbox, visitCounts, visitScope, type DraftEditor, type Factory, type FactoryList, type Kind, type MarkStatus, type OffListItem, type OutboxEntry, type SentReport, type VisitDraft, type VisitItem } from '../lib/inspectionVisit';

export const visitButton = 'pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 py-2 text-base font-semibold text-ink focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50';
const primary = 'pressable min-h-12 w-full rounded-xl bg-gold-deep px-4 py-3 text-base font-semibold text-paper disabled:opacity-50';
const input = 'min-h-11 w-full rounded-lg border border-line-control bg-sunken p-3 text-base text-ink focus-visible:ring-2 focus-visible:ring-gold';
export const visitTime = (time: string, timeZone: string) => time ? new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time)) : '—';
export function VisitCounts({ counts }: { counts: ReturnType<typeof visitCounts> }) {
  return <p className="text-base text-ink-soft tabular-nums">Checked: {counts.checked} · No longer used by the company: {counts.not_used} · Alerts: {counts.alert} · Off-list items: {counts.offList}</p>;
}
export function SourceText({ item }: { item: Pick<VisitItem, 'name' | 'brand' | 'code' | 'certificationRaw' | 'statusRaw'> }) {
  return <div className="space-y-2">{[item.name, item.brand, item.code, item.certificationRaw, item.statusRaw].map((text, index) => text ? <p dir="auto" key={index} className="whitespace-pre-wrap break-words text-base">{text}</p> : null)}</div>;
}
/** Shared accessible sheet; restore focus and keep keyboard focus inside the active dialog. */
export function VisitSheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from<HTMLElement>(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []);
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
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
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim"><div ref={root} role="dialog" aria-modal="true" aria-label={title} className="max-h-[90dvh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-t-2xl bg-surface p-4 text-ink tactile-4"><div className="flex items-center gap-4"><h2 className="min-w-0 flex-1 break-words text-2xl font-semibold">{title}</h2><button type="button" className={`${visitButton} h-11 w-11 shrink-0 px-0`} aria-label="Close" onClick={onClose}>×</button></div>{children}</div></div>;
}
export async function visitRequest(path: string, options?: RequestInit) {
  const response = await apiFetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
const changed = () => window.dispatchEvent(new Event('inspection-outbox'));
const sending = new Set<string>();
/** Mounted while signed in, even when the visit screen is closed. Scoped to this membership. */
export function VisitOutbox({ userId, agencyId }: { key?: string; userId: string; agencyId: string }) {
  const scope = visitScope(userId, agencyId);
  useEffect(() => {
    let active = true;
    const credential = sessionCredentialKey();
    const controller = new AbortController();
    const run = async () => {
      if (!active || sessionCredentialKey() !== credential || sending.has(scope)) return;
      sending.add(scope);
      try {
        for (const entry of readOutbox(localStorage, scope)) {
          if (!active || sessionCredentialKey() !== credential) break;
          if (!retryDue(entry, Date.now())) continue;
          const timeout = new AbortController();
          const abort = () => timeout.abort();
          controller.signal.addEventListener('abort', abort);
          const timer = setTimeout(abort, 25_000);
          try {
            const response = await apiFetch('/api/visits/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.draft), signal: timeout.signal });
            const body = await response.json().catch(() => ({}));
            if (!active || sessionCredentialKey() !== credential) break;
            if (response.status === 200 || response.status === 201) acceptReport(localStorage, scope, entry, body);
            else storeOutbox(localStorage, scope, retryResult(entry, response.status, body.error || `Request failed (${response.status}).`, Date.now()));
          } catch (error) {
            if (active && sessionCredentialKey() === credential) storeOutbox(localStorage, scope, retryResult(entry, 0, error instanceof Error ? error.message : 'Connection unavailable.', Date.now()));
          } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
          changed();
        }
      } catch { if (active) window.dispatchEvent(new Event('inspection-storage-error')); }
      finally { sending.delete(scope); }
    };
    void run();
    const trigger = () => { void run(); };
    window.addEventListener('online', trigger); window.addEventListener('focus', trigger); window.addEventListener('inspection-send', trigger);
    const timer = setInterval(trigger, 60_000);
    return () => { active = false; controller.abort(); clearInterval(timer); window.removeEventListener('online', trigger); window.removeEventListener('focus', trigger); window.removeEventListener('inspection-send', trigger); };
  }, [scope]);
  return null;
}
function PhotoField({ photo, onChange, onBusy }: { photo?: string; onChange(photo?: string): void; onBusy(busy: boolean): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <div className="space-y-2"><label className="block text-base">Optional photo<input aria-label="Optional photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className={`${input} block`} onChange={async event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setBusy(true); onBusy(true); setError('');
    try { const value = await compressPhoto(file); if (value.length > ANSWER_PHOTO_MAX_CHARS) throw new Error('Choose a smaller photo.'); if (alive.current) onChange(value); }
    catch { if (alive.current) setError('The photo could not be added. Choose a smaller photo and try again.'); }
    finally { if (alive.current) { setBusy(false); onBusy(false); } }
  }} /></label>{busy && <p role="status">Preparing photo…</p>}{error && <p role="alert">{error}</p>}{photo && <><img src={photo} alt="Attached photo" className="max-h-48 rounded-lg" /><button type="button" className={visitButton} onClick={() => onChange(undefined)}>Remove photo</button></>}</div>;
}
export function ItemSheet({ initial: row, alert, onSave, onChange, onClose }: { initial: OffListItem; alert: boolean; onSave(row: OffListItem): string | void; onChange(row: OffListItem): void; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const setRow = onChange;
  const [error, setError] = useState('');
  return <VisitSheet title={alert ? 'Alert' : 'Item not on the list'} onClose={onClose}><form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!alert && !row.name.trim()) { setError('Add an item name.'); return; } if (alert && !row.note?.trim() && !row.photo) { setError('An Alert needs a note or photo.'); return; } const failure = onSave(row); if (failure) setError(failure); }}>
    {!alert && <><label className="block">Name<input name="off-list-name" required maxLength={200} className={input} value={row.name} onChange={e => setRow({ ...row, name: e.target.value })} /></label><label className="block">Brand (optional)<input maxLength={200} className={input} value={row.brand || ''} onChange={e => setRow({ ...row, brand: e.target.value })} /></label></>}
    <label className="block">{alert ? 'Note (required unless you add a photo)' : 'Note (optional)'}<textarea name="item-note" maxLength={1000} className={input} value={row.note || ''} onChange={e => setRow({ ...row, note: e.target.value })} /></label><PhotoField onBusy={setBusy} photo={row.photo} onChange={photo => setRow({ ...row, photo })} />{error && <p role="alert" className="text-bad">{error}</p>}<button disabled={busy} className={primary} type="submit">Save item</button></form></VisitSheet>;
}
export function ItemSection({ title, kind, items, draft, onMark, onEdit }: { title: string; kind: Kind; items: VisitItem[]; draft: VisitDraft; onMark(kind: Kind, itemId: string, status: MarkStatus): void; onEdit(kind: Kind, itemId: string): void }) {
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('All');
  return <section className="space-y-4"><h3 className="text-xl font-semibold">{title}</h3><label className="block">Search {title}<input name={`search-${kind}`} type="search" className={input} value={query} onChange={e => setQuery(e.target.value)} /></label><label className="block">Filter {title}<select className={input} value={filter} onChange={e => setFilter(e.target.value)}>{['All', 'Marked', 'Alerts', 'Unmarked'].map(value => <option key={value}>{value}</option>)}</select></label><ul className="space-y-2">{items.filter(item => {
    const mark = draft.marks.find(row => row.kind === kind && row.itemId === item.id);
    return [item.name, item.brand, item.certificationRaw, item.code, item.statusRaw].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (filter === 'All' || filter === 'Marked' && !!mark || filter === 'Alerts' && mark?.status === 'alert' || filter === 'Unmarked' && !mark);
  }).map(item => { const mark = draft.marks.find(row => row.kind === kind && row.itemId === item.id); return <li key={item.id} className="space-y-3 rounded-xl border border-line bg-surface p-4"><SourceText item={item} /><div className="flex flex-wrap gap-2">{(Object.keys(markLabels) as MarkStatus[]).map(status => <button key={status} type="button" aria-pressed={mark?.status === status} className={`${visitButton} ${mark?.status === status ? 'bg-sunken' : ''}`} onClick={() => onMark(kind, item.id, status)}>{mark?.status === status && '✓ '}{markLabels[status]}</button>)}</div>{mark?.note && <p dir="auto" className="whitespace-pre-wrap break-words">{mark.note}</p>}{mark?.status === 'alert' && <button className={visitButton} type="button" onClick={() => onEdit(kind, item.id)}>Edit Alert</button>}</li>; })}</ul>{items.length === 0 && <p>No items.</p>}</section>;
}
interface Props { key?: string; userId: string; agencyId: string; timeZone: string; onClose(): void }
export function FactoryVisitScreen({ userId, agencyId, timeZone, onClose }: Props) {
  const scope = visitScope(userId, agencyId);
  const [factories, setFactories] = useState<Factory[] | null>(null);
  const [query, setQuery] = useState(''); const [list, setList] = useState<FactoryList | null>(null);
  const [draft, setDraft] = useState<VisitDraft | null>(null);
  const [review, setReview] = useState(false); const [restored, setRestored] = useState(false); const [listChanged, setListChanged] = useState(false);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [sent, setSent] = useState<SentReport | null>(null);
  const [sheet, setSheet] = useState<DraftEditor | null>(null);
  const generation = useRef(0);
  const draftRef = useRef(draft); draftRef.current = draft;
  const update = (next: VisitDraft) => {
    try { buildPayload(next, ANSWER_PHOTO_MAX_CHARS); saveDraft(localStorage, scope, next); setDraft(next); setError(''); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'The draft could not be saved on this phone.'); return false; }
  };
  useEffect(() => {
    let active = true;
    void visitRequest('/api/visits/factories').then(body => { if (active) setFactories(body.companies); }).catch(e => { if (active) setError(e.message); });
    const sync = () => {
      try {
        const next = readOutbox(localStorage, scope); setEntries(next);
        const receipt = next.find(entry => entry.draft.clientReportId === draftRef.current?.clientReportId && entry.sent);
        if (receipt?.sent) { setSent(receipt.sent); setDraft(null); }
      } catch { setError('The saved reports could not be opened on this phone.'); }
    };
    const storageError = () => setError('Reports could not be saved on this phone. Keep this screen open and try again.');
    sync(); window.addEventListener('inspection-outbox', sync); window.addEventListener('storage', sync); window.addEventListener('inspection-storage-error', storageError);
    return () => { active = false; generation.current++; window.removeEventListener('inspection-outbox', sync); window.removeEventListener('storage', sync); window.removeEventListener('inspection-storage-error', storageError); };
  }, [scope]);
  const open = async (companyId: string) => {
    const request = ++generation.current; setLoading(true); setError('');
    try {
      const next: FactoryList = await visitRequest(`/api/visits/factories/${encodeURIComponent(companyId)}`);
      if (generation.current !== request) return;
      const saved = restoreDraft(localStorage, scope, next);
      const value = saved?.draft || newDraft(next, crypto.randomUUID(), new Date().toISOString());
      saveDraft(localStorage, scope, value); setList(next); setDraft(value); setRestored(!!saved); setListChanged(!!saved?.listChanged); setReview(false); setSent(null); setSheet(value.editor || null);
    } catch (e) { if (generation.current === request) setError(e instanceof Error ? e.message : 'Could not open the factory.'); }
    finally { if (generation.current === request) setLoading(false); }
  };
  const pending = entries.find(entry => entry.draft.clientReportId === draft?.clientReportId && !entry.sent);
  const waiting = entries.filter(entry => !entry.sent);
  const editSheet = (editor: DraftEditor | null) => {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, editor: editor || undefined };
    try { saveDraft(localStorage, scope, next); setDraft(next); setSheet(editor); }
    catch { setError('The draft could not be saved on this phone.'); }
  };
  const editAlert = (kind: Kind, itemId: string) => {
    const previous = draft?.marks.find(row => row.kind === kind && row.itemId === itemId);
    editSheet({ kind, itemId, initial: { name: '', note: previous?.note || '', photo: previous?.photo } });
  };
  const mark = (kind: Kind, itemId: string, status: MarkStatus) => {
    if (!draft || pending) return;
    const previous = draft.marks.find(row => row.kind === kind && row.itemId === itemId);
    if (previous?.status === status) update(setMark(draft, kind, itemId, null));
    else if (status === 'alert') editSheet({ kind, itemId, initial: { name: '', note: '', photo: undefined } });
    else update(setMark(draft, kind, itemId, { status }));
  };
  const send = () => {
    if (!draft || pending) return;
    try { queueReport(localStorage, scope, buildPayload(draft, ANSWER_PHOTO_MAX_CHARS)); setEntries(readOutbox(localStorage, scope)); setError(''); changed(); window.dispatchEvent(new Event('inspection-send')); }
    catch (e) { setError(e instanceof Error ? e.message : 'The report could not be saved on this phone.'); }
  };
  const edit = (entry: OutboxEntry) => { removeOutbox(localStorage, scope, entry.draft.clientReportId); setEntries(readOutbox(localStorage, scope)); setReview(false); changed(); };
  return <div role="dialog" aria-modal="true" aria-label="Factory visit" onKeyDown={event => { if (event.key === 'Escape' && !sheet) onClose(); }} className="fixed inset-0 z-50 overflow-y-auto bg-paper text-ink"><div className="mx-auto max-w-2xl space-y-6 p-4 pb-80"><div className="flex items-center gap-4"><button type="button" aria-label="Close" className={`${visitButton} h-11 w-11 px-0`} onClick={onClose}>×</button><h2 className="text-2xl font-semibold">Factory visit</h2></div>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-bad">{error}</p>}
    {sent ? <section className="space-y-4"><h3 className="text-2xl font-semibold">We got it</h3><p>{visitTime(sent.report.submittedAt, timeZone)}</p><VisitCounts counts={sent.report.counts} />{sent.fee !== null && <p>Your fee for this visit: {new Intl.NumberFormat(undefined, { style: 'currency', currency: sent.fee.currency }).format(sent.fee.amount)}</p>}<button type="button" className={visitButton} onClick={() => { setSent(null); setList(null); }}>Back to factories</button></section>
    : list && draft ? <>
      <button type="button" className={visitButton} onClick={() => { setList(null); setDraft(null); setReview(false); setSheet(null); }}>Back to factories</button><h3 dir="auto" className="whitespace-pre-wrap break-words text-2xl font-semibold">{list.company.name}</h3><p>List updated {visitTime(list.refreshedAt, timeZone)}</p>{restored && <p role="status">Draft restored</p>}{listChanged && <p role="status">The list changed; marks for items still on the list were kept.</p>}
      {pending ? <section className="space-y-4"><p role="status">{pending.stopped ? pending.error : 'Saved on this phone — it will be sent automatically'}</p>{pending.stopped && <button type="button" className={visitButton} onClick={() => edit(pending)}>Edit</button>}<VisitCounts counts={visitCounts(draft)} /></section> : <>
      {review ? <section className="space-y-4"><h3 className="text-xl font-semibold">Review</h3><VisitCounts counts={visitCounts(draft)} /><button type="button" className={visitButton} onClick={() => setReview(false)}>Edit visit</button>{(['alert', 'not_used', 'checked'] as MarkStatus[]).map(status => <section key={status} className="space-y-2"><h4 className="text-xl font-semibold">{markLabels[status]}</h4>{draft.marks.filter(row => row.status === status).map(row => { const item = (row.kind === 'ingredient' ? list.ingredients : list.products).find(item => item.id === row.itemId); return <div key={`${row.kind}:${row.itemId}`} className="space-y-2 rounded-xl border border-line p-4">{item && <SourceText item={item} />}<p dir="auto" className="whitespace-pre-wrap break-words">{row.note}</p>{row.photo && <img src={row.photo} alt="Alert photo" className="max-h-48 rounded-lg" />}</div>; })}</section>)}<label className="block">Report note<textarea name="report-note" maxLength={4000} className={input} value={draft.note} onChange={e => update({ ...draft, note: e.target.value })} /></label></section> : <><ItemSection title="Ingredients" kind="ingredient" items={list.ingredients} draft={draft} onMark={mark} onEdit={editAlert} /><ItemSection title="Products" kind="product" items={list.products} draft={draft} onMark={mark} onEdit={editAlert} /></>}
      <section className="space-y-2"><h3 className="text-xl font-semibold">Off-list items</h3>{draft.offList.map((row, index) => <div key={index} className="space-y-2 rounded-xl border border-line p-4"><p dir="auto" className="whitespace-pre-wrap break-words">{row.name}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.brand}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.note}</p>{row.photo && <img src={row.photo} alt="Off-list item photo" className="max-h-48 rounded-lg" />}<button type="button" className={visitButton} onClick={() => editSheet({ index, initial: row })}>Edit item</button><button type="button" className={visitButton} onClick={() => update({ ...draft, offList: draft.offList.filter((_, i) => i !== index) })}>Remove item</button></div>)}</section>
      {!sheet && <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface p-4"><div className="mx-auto max-w-2xl space-y-2"><VisitCounts counts={visitCounts(draft)} />{!review && <button type="button" className={visitButton} onClick={() => editSheet({ initial: { name: '', brand: '', note: '' } })}>Add item not on the list</button>}<button type="button" className={primary} onClick={review ? send : () => setReview(true)}>{review ? 'Send report' : 'Review and send'}</button></div></footer>}
      </>}
    </> : <section className="space-y-4">{waiting.length > 0 && <p role="status">Waiting to send ({waiting.length})</p>}{waiting.map(entry => <div key={entry.draft.clientReportId} className="space-y-2"><p>{factories?.find(row => row.id === entry.draft.companyId)?.name || entry.draft.companyId}</p>{entry.stopped && <p role="alert">{entry.error}</p>}<button type="button" className={visitButton} onClick={() => void open(entry.draft.companyId)}>{entry.stopped ? 'Edit report' : 'View waiting report'}</button></div>)}{entries.filter(entry => entry.sent).map(entry => <button key={entry.draft.clientReportId} className={visitButton} type="button" onClick={() => setSent(entry.sent!)}>We got it · {entry.sent!.report.companyName} · {visitTime(entry.sent!.report.submittedAt, timeZone)}</button>)}<label className="block">Search factories<input name="factory-search" type="search" className={input} value={query} onChange={e => setQuery(e.target.value)} /></label>{loading || factories === null ? <p role="status">Loading factories…</p> : <ul className="space-y-2">{factories.filter(row => [row.name, row.brand, row.plant].some(value => value?.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).map(row => <li key={row.id}><button disabled={loading} type="button" className={`${visitButton} w-full space-y-2 p-4 text-left`} onClick={() => void open(row.id)}><p dir="auto" className="whitespace-pre-wrap break-words text-xl">{row.name}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.brand}</p><p dir="auto" className="whitespace-pre-wrap break-words">{row.plant}</p><p>{row.ingredientCount} ingredients · {row.productCount} products</p></button></li>)}</ul>}</section>}
    {sheet && draft && <ItemSheet initial={sheet.initial} alert={!!sheet.kind} onClose={() => editSheet(null)} onChange={row => editSheet({ ...sheet, initial: row })} onSave={row => {
      const next = sheet.kind && sheet.itemId ? setMark(draft, sheet.kind, sheet.itemId, { status: 'alert', note: row.note, photo: row.photo }) : { ...draft, offList: sheet.index === undefined ? [...draft.offList, row] : draft.offList.map((value, index) => index === sheet.index ? row : value) };
      if (update({ ...next, editor: undefined })) { setSheet(null); return; }
      return 'The item could not be saved. Check the report limits (up to 4 photos) and phone storage.';
    }} />}
  </div></div>;
}
