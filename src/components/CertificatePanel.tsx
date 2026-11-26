import React, { useId, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { SourceAttachment } from '../lib/sources';
import { visitButton, VisitSheet, visitRequest } from './FactoryVisitScreen';

const uncertain = 'Airtable may have received this PDF. Reload and review before trying again.';
type Baseline = { baseId: string; updatedAt: string; attachmentIds: string[]; configured: boolean; attachments: SourceAttachment[] };
export function CertificatePanel({ path, files, company, writable, onSaved }: {
  path: string; files?: SourceAttachment[]; company?: boolean; writable: boolean; onSaved(): void;
}) {
  const panelId = useId();
  const [target, setTarget] = useState<SourceAttachment | 'add' | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [review, setReview] = useState(false);
  const lock = useRef(false), operation = useRef('');
  const title = company ? 'Letter of Certification (LOC)' : 'Certification PDF';
  const pdfs = files?.filter(f => /\.pdf$/i.test(f.filename) && (!f.contentType || f.contentType === 'application/pdf'));
  async function open(id: string) {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const result = await visitRequest(path + '/' + encodeURIComponent(id) + '/open', {cache: 'no-store'});
      if (!tab) throw Error();
      tab.location.replace(result.url);
    } catch { tab?.close(); setMessage("Couldn't open the PDF from Airtable. Try again."); }
  }
  async function prepare(next: typeof target) {
    if (lock.current || !writable) return;
    lock.current = true;
    setReviewed(review);
    setTarget(next); setBaseline(null); setBusy(true); setMessage(''); setReview(false);
    operation.current = crypto.randomUUID();
    try {
      const record: Baseline = await visitRequest(path, {cache:'no-store'});
      if (!record.configured) throw Error('Certificate field not configured in Airtable source settings.');
      if (next && next !== 'add' && !record.attachmentIds.includes(next.id)) throw Error('These certificates changed in Airtable. Reload and review before replacing a file.');
      setBaseline(record);
    } catch (error: any) { setMessage(error.status >= 500 ? "Couldn't load the latest record from Airtable. Editing is unavailable until the connection works." : error.message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function save() {
    if (!file || !baseline || !target || lock.current || review || !writable) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      const response = await apiFetch(path, { method: 'POST', body: file, headers: {
        'Content-Type': 'application/pdf', 'X-Pdf-Name': encodeURIComponent(file.name), 'X-Operation-Id': operation.current,
        'X-Base-Id': baseline.baseId, 'X-Connection-Updated-At': baseline.updatedAt,
        'X-Attachment-Ids': JSON.stringify(baseline.attachmentIds), ...(target !== 'add' && {'X-Replace-Id': target.id}),
      }});
      const result = await response.json();
      if (!result.saved) {
        setMessage(result.error || uncertain);
        setReview(response.status === 409 || response.status >= 500);
        return;
      }
      setTarget(null); setFile(null); setMessage(result.warning || 'PDF saved in Airtable.'); onSaved();
    } catch { setReview(true); setMessage(uncertain); }
    finally { lock.current = false; setBusy(false); }
  }
  function choose(next?: File) {
    setMessage('');
    if (next && next.size > 5 * 1024 * 1024) { setFile(null); setMessage('PDF is too large. The maximum size is 5 MB.'); }
    else if (next && (!/\.pdf$/i.test(next.name) || next.type !== 'application/pdf')) { setFile(null); setMessage('Choose a valid PDF file.'); }
    else setFile(next ?? null);
  }
  const start = (next: typeof target) => { setFile(null); void prepare(next); };
  return <div className="min-w-0 space-y-2">
    {!company && <h5 className="text-sm font-semibold">{title}</h5>}
    {pdfs?.length ? pdfs.map((pdf,index) => <div key={pdf.id} className="space-y-1">
      <p id={panelId + index} className="break-all" dir="auto">{pdf.filename}</p>
      <p className="text-sm text-ink-soft">{company ? 'PDF stored in Airtable' : 'Certification document available'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={visitButton} aria-describedby={panelId + index} onClick={() => open(pdf.id)}>View PDF</button>
        {writable && <button type="button" className={visitButton} aria-describedby={panelId + index} onClick={() => start(pdf)}>Replace PDF</button>}
      </div>
    </div>) : <p>{!files ? 'Certificate field not configured in Airtable source settings.' : company ? 'No letter of certification on file.' : 'No certification PDF on file.'}</p>}
    {files && writable && <button type="button" className={visitButton} onClick={() => start('add')}>Add PDF</button>}
    {!target && message && <p role="status">{message}</p>}
    {target && <VisitSheet title={target === 'add' ? 'Add PDF' : 'Replace PDF'} onClose={() => { if (!busy) {setTarget(null); setMessage('');} }}>
      <h3 className="font-semibold">{title}</h3>
      {target !== 'add' && <><p className="break-all">{target.filename}</p><button className={visitButton} onClick={() => open(target.id)}>View PDF</button></>}
      {busy && !baseline && <p role="status">Loading certificate…</p>}
      {baseline && <label className="block space-y-2">Choose a PDF (up to 5 MB)
        <input className="block min-h-11 w-full min-w-0" type="file" accept="application/pdf,.pdf" disabled={busy || review} onChange={e => choose(e.target.files?.[0])} /></label>}
      {file && <p className="break-all">Selected file · {file.name}</p>}
      {message && <p role="status">{message}</p>}
      {reviewed && baseline && <section><h4 className="font-semibold">Current files in Airtable</h4><ul>
        {baseline.attachments.map(f => <li className="break-all" key={f.id}>{f.filename} · {f.id}</li>)}</ul></section>}
      {(review || !baseline && !busy) && <button className={visitButton} disabled={busy} onClick={() => prepare(target)}>Reload and review</button>}
      <button type="button" className={visitButton} disabled={!baseline || !file || busy || review} onClick={save}>{busy && baseline ? 'Saving…' : 'Save changes'}</button>
    </VisitSheet>}
  </div>;
}
