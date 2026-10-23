// Item 12b-c: the Pool tab (plan v6 7; Don Oct 22 + 23). Admin sees members,
// invites and contacts; owners/coordinators see members (name + last venue) and
// the borrow list, and tick people into their OWN venues only.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, Mail, Phone, UserPlus, X } from 'lucide-react';
import type { User, Venue } from '../types';
import {
  POOL_TEXT, type BorrowPerson, type OpenWork, type PoolContact, type PoolData, type PoolMember,
  contactStatusLine, createContact, deleteContact, editContact, inviteContact, inviteStatusLine, loadBorrow, loadPool,
  makeMain, memberWhereLine, moveToPool, ownVenuesForPool, parseOpenWork, pickedForSubmit, poolErrorText, previewVersion, tickIn, validateAddForm,
} from '../lib/pool';
import { END_DATE_TEXT, addDays, dayWords, serverNowMs, ymdIn, zoneForVenue } from '../lib/venueEndDates';
import { InviteLinkCard } from './InviteLinkCard';

export const POOL_UPDATED_EVENT = 'shutfey:pool-updated';

/** Loads the Pool (and, for owners/coordinators, the borrow list); reloads on POOL_UPDATED and on `refreshKey`. */
export function usePool(enabled: boolean, withBorrow: boolean, refreshKey?: unknown) {
  const [data, setData] = useState<PoolData | null>(null);
  const [borrow, setBorrow] = useState<BorrowPerson[] | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    const [p, b] = await Promise.all([loadPool(), withBorrow ? loadBorrow() : Promise.resolve(null)]);
    if (mine !== seq.current) return;
    setFailed(p === null);
    if (p) setData(p);
    setBorrow(b);
  }, [enabled, withBorrow]);
  useEffect(() => {
    if (!enabled) { setData(null); setBorrow(null); return; }
    void reload();
  }, [enabled, reload, refreshKey]);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const on = () => { void reload(); };
    window.addEventListener(POOL_UPDATED_EVENT, on);
    return () => window.removeEventListener(POOL_UPDATED_EVENT, on);
  }, [enabled, reload]);
  return { data, borrow, failed, reload };
}

const btn = 'min-h-11 px-3 rounded-xl bg-surface border border-line-control text-sm text-ink font-semibold hover:bg-sunken pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const btnGold = 'min-h-11 px-4 rounded-xl bg-gold-deep text-paper text-sm font-semibold pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'w-full min-h-11 px-3 rounded-lg bg-surface border border-line-control text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold';

/** Open sheets, newest last: only the top one answers Escape / Tab. */
const sheetStack: object[] = [];

/** A small accessible dialog shell (Escape closes; focus stays inside). */
function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId?: string }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    const controls = () => Array.from(el.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')) as HTMLElement[];
    controls()[0]?.focus();
    const token = {};
    sheetStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== token) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if (e.key === 'Tab') {
        const c = controls(); const first = c[0]; const last = c[c.length - 1];
        if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const at = sheetStack.indexOf(token);
      if (at >= 0) sheetStack.splice(at, 1);
      if (prev?.isConnected) prev.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-scrim backdrop-blur-sm animate-fade-in">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} data-pool-sheet={testId}
        className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-surface border border-line e3 p-4 animate-slide-up">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 id={titleId} className="text-base font-semibold text-ink min-w-0 break-words">{title}</h2>
          <button type="button" onClick={onClose} aria-label={POOL_TEXT.close}
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken pressable cursor-pointer">
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- Add / edit a contact (admin) ------------------------------------------

export function AddToPoolSheet({ contact, onClose, onDone }: { contact?: PoolContact | null; onClose: () => void; onDone: (msg: string, link?: { link: string; name: string }) => void }) {
  const [f, setF] = useState({ name: contact?.name || '', phone: contact?.phone || '', email: contact?.email || '', note: contact?.note || '' });
  const [sendNow, setSendNow] = useState(!contact);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF((p) => ({ ...p, [k]: e.target.value })); setShared(null); };
  const submit = async (confirmShared: boolean) => {
    const invalid = validateAddForm(f, !contact && sendNow);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try {
      const r = contact ? await editContact(contact, f, confirmShared) : await createContact(f, confirmShared);
      if (!r.ok) {
        if (r.code === 'POOL_PHONE_SHARED') { setShared(String((r.data as any)?.displayName || 'someone in your agency')); return; }
        setError(poolErrorText(r)); return;
      }
      const saved: PoolContact | null = (r.data as any)?.contact || null;
      if (!contact && sendNow && saved) {
        const inv = await inviteContact({ ...saved, status: saved.status || 'details' } as PoolContact);
        if (inv.ok && typeof (inv.data as any)?.link === 'string') {
          onDone(POOL_TEXT.added(saved.name), { link: (inv.data as any).link, name: saved.name });
          return;
        }
        onDone(`${POOL_TEXT.added(saved.name)} ${poolErrorText(inv)}`);
        return;
      }
      onDone(contact ? `${f.name.trim()} was updated.` : POOL_TEXT.added(f.name.trim()));
    } finally { setBusy(false); }
  };
  return (
    <Sheet title={contact ? `${POOL_TEXT.edit} ${contact.name}` : POOL_TEXT.addTitle} onClose={onClose} testId="add">
      <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} className="space-y-3">
        <label className="block text-sm font-semibold text-ink-soft">{POOL_TEXT.name}
          <input data-pool-name className={`${input} mt-1`} value={f.name} onChange={set('name')} maxLength={80} autoComplete="off" />
        </label>
        <label className="block text-sm font-semibold text-ink-soft">{POOL_TEXT.phone}
          <input data-pool-phone className={`${input} mt-1`} value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="off" />
        </label>
        <label className="block text-sm font-semibold text-ink-soft">{POOL_TEXT.email}
          <input data-pool-email className={`${input} mt-1`} type="email" value={f.email} onChange={set('email')} autoComplete="off" />
        </label>
        <p className="text-sm text-ink-soft">{POOL_TEXT.oneRequired}</p>
        <label className="block text-sm font-semibold text-ink-soft">{POOL_TEXT.note}
          <textarea data-pool-note className={`${input} mt-1 py-2`} rows={2} value={f.note} onChange={set('note')} maxLength={140} />
          <span className="block font-normal text-sm text-ink-soft mt-1">{POOL_TEXT.noteHint}</span>
        </label>
        {!contact && (
          <fieldset className="grid grid-cols-2 gap-2" aria-label="Invite">
            {[true, false].map((v) => (
              <label key={String(v)} className={`min-h-11 flex items-center justify-center gap-2 px-2 rounded-xl border text-sm font-semibold cursor-pointer ${sendNow === v ? 'border-gold bg-gold-wash text-gold-ink' : 'border-line-control text-ink'}`}>
                <input type="radio" name="pool-send" className="sr-only" checked={sendNow === v} onChange={() => setSendNow(v)} />
                {v ? POOL_TEXT.sendInviteNow : POOL_TEXT.justKeepDetails}
              </label>
            ))}
          </fieldset>
        )}
        {shared && (
          <div role="alert" data-pool-shared className="p-3 rounded-xl bg-sunken border border-line text-base text-ink space-y-2">
            <p>{POOL_TEXT.phoneShared(shared)}</p>
            <button type="button" className={btn} disabled={busy} onClick={() => void submit(true)}>{POOL_TEXT.addAnyway}</button>
          </div>
        )}
        {error && <p role="alert" className="text-base text-ink">{error}</p>}
        <button type="submit" disabled={busy} className={`${btnGold} w-full min-h-12`}>
          {contact ? POOL_TEXT.save : sendNow ? POOL_TEXT.sendInviteNow : POOL_TEXT.addButton}
        </button>
      </form>
    </Sheet>
  );
}

// ---- Tick a venue (owner / coordinator: additions to their own venues only) --

export function PoolTickSheet({ person, borrowFrom, venues, agencyTimeZone, onClose, onDone }: {
  person: { id: string; name: string; venueRevision?: number };
  /** Set for a borrow: the person's main venue name; the end date is then required. */
  borrowFrom?: string | null;
  venues: Venue[];
  agencyTimeZone?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const required = typeof borrowFrom === 'string';
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const todayOf = (v: Venue) => ymdIn(serverNowMs(), zoneForVenue(v, agencyTimeZone));
  // Only venues still offered now count (a coordinator's scope can shrink while this is open).
  const offeredKey = venues.map((v) => v.id).join(',');
  useEffect(() => {
    setPicked((p) => {
      const keep = pickedForSubmit(p, venues);
      if (keep.length === Object.keys(p).length) return p;
      const n: Record<string, string | null> = {};
      for (const k of keep) n[k.venueId] = k.lastDay;
      return n;
    });
  }, [offeredKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const picks = pickedForSubmit(picked, venues);
  const ids = picks.map((x) => x.venueId);
  const missingEnd = required && picks.some((x) => !x.lastDay);
  const rev = Number.isInteger(person.venueRevision) ? person.venueRevision! : null;
  const save = async () => {
    const now = pickedForSubmit(picked, venues);
    if (now.length === 0 || (required && now.some((x) => !x.lastDay)) || rev === null) return;
    setBusy(true); setError(null);
    try {
      const r = await tickIn(person.id, rev, now);
      if (r.ok) { onDone(`${person.name}: venue saved.`); return; }
      setError(poolErrorText(r));
    } finally { setBusy(false); }
  };
  return (
    <Sheet title={POOL_TEXT.tickTitle(person.name)} onClose={onClose} testId="tick">
      <p className="text-base text-ink-soft mb-3">{required ? POOL_TEXT.tickIntroBorrow(borrowFrom || '') : POOL_TEXT.tickIntro}</p>
      {venues.length === 0 && <p className="text-base text-ink">{POOL_TEXT.noYourVenues}</p>}
      <div className="space-y-2">
        {venues.map((v) => {
          const on = Object.prototype.hasOwnProperty.call(picked, v.id);
          const day = picked[v.id] ?? null;
          const today = todayOf(v);
          const words = day ? dayWords(day, today) : null;
          return (
            <div key={v.id} data-venue-row={v.id} className="rounded-xl border border-line-control">
              <label className="min-h-11 flex items-center gap-2 px-3 py-2 text-base text-ink cursor-pointer">
                <input type="checkbox" checked={on} disabled={busy} className="w-5 h-5 accent-ink"
                  onChange={(e) => setPicked((p) => {
                    const n = { ...p };
                    if (e.target.checked) n[v.id] = required ? today : null; else delete n[v.id];
                    return n;
                  })} />
                <span className="min-w-0 break-words">{v.name}</span>
              </label>
              {on && (
                <div data-end-date className="px-3 pb-3 pl-10 space-y-2">
                  {day && words ? (
                    <>
                      <p className="text-sm text-ink leading-snug">
                        <CalendarDays aria-hidden="true" className="inline w-4 h-4 mr-1 -mt-0.5 text-ink-soft" />
                        <span className="font-semibold">{END_DATE_TEXT.untilTitle(words.long)}</span>
                        <span className="text-ink-soft"> ({END_DATE_TEXT.through(words.full)})</span>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`pt-${v.id}`}>{required ? POOL_TEXT.endRequired : END_DATE_TEXT.endDateLabel} at {v.name}</label>
                        <input id={`pt-${v.id}`} type="date" value={day} min={today} max={addDays(today, 366)} required disabled={busy}
                          onChange={(e) => { const x = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(x)) setPicked((p) => ({ ...p, [v.id]: x })); }}
                          className="min-h-11 px-3 rounded-lg bg-surface border border-line-control text-base text-ink tnum" />
                        {!required && (
                          <button type="button" disabled={busy} onClick={() => setPicked((p) => ({ ...p, [v.id]: null }))}
                            className="min-h-11 px-1 text-sm text-ink-soft underline underline-offset-2 cursor-pointer">{END_DATE_TEXT.removeEndDate}</button>
                        )}
                      </div>
                      {required && <p className="text-sm text-ink-soft">{POOL_TEXT.endRequired}</p>}
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-ink-soft">{END_DATE_TEXT.noEndDate}</span>
                      <button type="button" disabled={busy} onClick={() => setPicked((p) => ({ ...p, [v.id]: today }))} className={`${btn} inline-flex items-center gap-1.5`}>
                        <CalendarDays aria-hidden="true" className="w-4 h-4" />{END_DATE_TEXT.addEndDate}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-4 text-base text-ink">{error}</p>}
      <button type="button" onClick={() => void save()} disabled={busy || ids.length === 0 || missingEnd || rev === null}
        className={`${btnGold} mt-4 w-full min-h-12 text-base`}>{POOL_TEXT.save}</button>
    </Sheet>
  );
}

// ---- Move to Pool / Make main (admin; dry run shows open work first) --------

export function PoolMoveDialog({ mode, person, venues, onClose, onDone }: {
  mode: 'move' | 'make-main';
  person: { id: string; name: string; venueId?: string; venueRevision?: number };
  venues: Venue[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [venueId, setVenueId] = useState('');
  const [keepOld, setKeepOld] = useState(true);
  const [work, setWork] = useState<OpenWork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The version and choice the shown open-work list was computed at; the confirm sends exactly these.
  const preview = useRef<{ version: number | undefined; venueId: string; keepOld: boolean } | null>(null);
  const rev = Number.isInteger(person.venueRevision) ? person.venueRevision! : null;
  const oldMain = person.venueId ? venues.find((v) => v.id === person.venueId) : undefined;
  const run = async (dry: boolean): Promise<void> => {
    if (rev === null || (mode === 'make-main' && !venueId)) return;
    const shown = preview.current;
    if (!dry && (!shown || shown.venueId !== venueId || shown.keepOld !== keepOld)) return;
    const version = dry ? previewVersion() : shown!.version;
    setBusy(true); setError(null);
    let again = false;
    try {
      const r = mode === 'move' ? await moveToPool(person.id, rev, dry, version) : await makeMain(person.id, rev, venueId, keepOld, dry, version);
      if (r.ok && dry) { preview.current = { version, venueId, keepOld }; setWork(parseOpenWork(r.data)); }
      else if (r.ok) onDone(mode === 'move' ? `${person.name} is in the Pool now.` : `${venues.find((v) => v.id === venueId)?.name || 'The venue'} is ${person.name}'s main venue now.`);
      else if (!dry && r.code === 'VERSION_CONFLICT') {
        // Something changed after the preview: show the fresh list and ask again.
        preview.current = null; setWork(null); again = true;
      } else setError(poolErrorText(r));
    } finally { setBusy(false); }
    if (again) { await run(true); setError(POOL_TEXT.previewChanged); }
  };
  useEffect(() => { if (mode === 'move') void run(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode === 'make-main' && venueId) { preview.current = null; setWork(null); void run(true); } }, [venueId, keepOld]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => venues.find((v) => v.id === id)?.name || '';
  return (
    <Sheet title={mode === 'move' ? POOL_TEXT.moveTitle(person.name) : POOL_TEXT.makeMainTitle(person.name)} onClose={onClose} testId={mode}>
      <p className="text-base text-ink-soft mb-3">{mode === 'move' ? POOL_TEXT.moveBody : POOL_TEXT.makeMainBody}</p>
      {mode === 'make-main' && (
        <div className="space-y-3 mb-3">
          <label className="block text-sm font-semibold text-ink-soft">{POOL_TEXT.chooseVenue}
            <select data-make-main-venue className={`${input} mt-1`} value={venueId} onChange={(e) => setVenueId(e.target.value)} disabled={busy}>
              <option value="">{POOL_TEXT.chooseVenue}</option>
              {venues.filter((v) => v.id !== person.venueId).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          {oldMain && (
            <label className="min-h-11 flex items-center gap-2 text-base text-ink">
              <input type="checkbox" className="w-5 h-5 accent-ink" checked={keepOld} onChange={(e) => setKeepOld(e.target.checked)} disabled={busy} />
              {POOL_TEXT.keepOldMain(oldMain.name)}
            </label>
          )}
        </div>
      )}
      {busy && !work && <p className="text-base text-ink-soft">{POOL_TEXT.checking}</p>}
      {work && (
        <div data-open-work className="p-3 rounded-xl bg-sunken border border-line text-base text-ink">
          {work.tasks.length === 0 && work.events.length === 0 ? <p>{POOL_TEXT.noOpenWork}</p> : (
            <>
              <p className="font-semibold">{POOL_TEXT.openWorkTitle}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {work.tasks.length > 0 && <li>{POOL_TEXT.openTasks(work.tasks.length)}: {work.tasks.slice(0, 3).map((t) => `${t.title} (${name(t.venueId)})`).join(', ')}{work.tasks.length > 3 ? '…' : ''}</li>}
                {work.events.length > 0 && <li>{POOL_TEXT.openEvents(work.events.length)}: {work.events.slice(0, 3).map((e) => `${e.title} (${name(e.venueId)})`).join(', ')}{work.events.length > 3 ? '…' : ''}</li>}
              </ul>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-base text-ink">{error}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className={btn} onClick={onClose} disabled={busy}>{POOL_TEXT.cancel}</button>
        <button type="button" data-confirm className={btnGold} disabled={busy || !work || rev === null} onClick={() => void run(false)}>
          {mode === 'move' ? POOL_TEXT.confirmMove : POOL_TEXT.confirmMakeMain}
        </button>
      </div>
    </Sheet>
  );
}

// ---- The panel ---------------------------------------------------------------

interface PoolPanelProps {
  currentUser: User;
  venues: Venue[];
  pool: ReturnType<typeof usePool>;
  /** Admin: open the existing venue sheet for this person (by id, from the roster). */
  onAdminTick?: (member: PoolMember) => void;
  /** Admin: open the kiosk code sheet for this person. */
  onCode?: (personId: string) => void;
}

export function PoolPanel({ currentUser, venues, pool, onAdminTick, onCode }: PoolPanelProps) {
  const isAdmin = currentUser.role === 'admin';
  const { data, borrow, failed, reload } = pool;
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PoolContact | null>(null);
  const [removing, setRemoving] = useState<PoolContact | null>(null);
  const [tick, setTick] = useState<{ person: { id: string; name: string; venueRevision?: number }; borrowFrom?: string } | null>(null);
  const [mainFor, setMainFor] = useState<PoolMember | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const own = ownVenuesForPool(currentUser, venues);
  const tz = currentUser.agencyTimeZone;
  const done = (msg: string, l?: { link: string; name: string }) => {
    setNotice(msg); setLink(l || null);
    setAdding(false); setEditing(null); setTick(null); setMainFor(null); setRemoving(null);
    void reload();
  };
  const sendInvite = async (c: PoolContact) => {
    setBusyId(c.id);
    try {
      const r = await inviteContact(c);
      if (r.ok && typeof (r.data as any)?.link === 'string') done(`${POOL_TEXT.sendInvite}: ${c.name}`, { link: (r.data as any).link, name: c.name });
      else { setNotice(poolErrorText(r)); void reload(); }
    } finally { setBusyId(null); }
  };
  const remove = async (c: PoolContact) => {
    setBusyId(c.id);
    try {
      const r = await deleteContact(c);
      if (r.ok) done(`${c.name} was removed from the Pool.`); else { setNotice(poolErrorText(r)); setRemoving(null); void reload(); }
    } finally { setBusyId(null); }
  };

  const rowCls = 'p-4 flex flex-col gap-2 bg-surface';
  const avatar = (n: string) => (
    <div className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-paper shrink-0" style={{ backgroundColor: 'var(--gold-deep)' }}>{(n || '?').charAt(0).toUpperCase()}</div>
  );

  return (
    <div data-pool-panel className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-base text-ink-soft min-w-0 flex-1">{isAdmin ? POOL_TEXT.poolIntro : POOL_TEXT.poolIntroManager}</p>
        {isAdmin && (
          <button type="button" data-pool-add onClick={() => { setNotice(null); setLink(null); setAdding(true); }} className={`${btnGold} inline-flex items-center gap-2`}>
            <UserPlus aria-hidden="true" className="w-4 h-4" />{POOL_TEXT.addButton}
          </button>
        )}
      </div>
      {notice && <p role="status" data-pool-notice className="p-3 rounded-xl bg-ok-bg border border-ok text-base text-ink">{notice}</p>}
      {link && <InviteLinkCard link={link.link} forWhom={link.name} onDone={() => setLink(null)} doneLabel={POOL_TEXT.close} />}
      {failed && !data && (
        <div role="alert" className="p-4 rounded-xl border border-line text-base text-ink flex items-center justify-between gap-2">
          <span>{POOL_TEXT.loadFailed}</span>
          <button type="button" className={btn} onClick={() => void reload()}>{POOL_TEXT.retry}</button>
        </div>
      )}
      {data && (
        <div data-pool-list className="divide-y divide-line border border-line rounded-2xl overflow-hidden">
          {data.members.length + data.invites.length + data.contacts.length === 0 && (
            <p className="p-6 text-center text-base text-ink-soft">{isAdmin ? POOL_TEXT.empty : POOL_TEXT.emptyManager}</p>
          )}
          {data.members.map((m) => (
            <div key={m.id} data-pool-member={m.id} className={rowCls}>
              <div className="flex items-center gap-3 min-w-0">
                {avatar(m.name)}
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-ink break-words">{m.name}</p>
                  <p className="text-sm text-ink-soft break-words">
                    {memberWhereLine(m, venues, tz)}
                    {isAdmin && typeof m.hasKioskPin === 'boolean' && <> · {m.hasKioskPin ? POOL_TEXT.codeSet : POOL_TEXT.noCode}</>}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-[52px]">
                {isAdmin ? (
                  <>
                    {onAdminTick && <button type="button" className={btn} onClick={() => onAdminTick(m)}>{POOL_TEXT.tickVenue}</button>}
                    {onCode && <button type="button" className={btn} onClick={() => onCode(m.id)}>{m.hasKioskPin ? POOL_TEXT.resetCode : POOL_TEXT.setCode}</button>}
                    <button type="button" className={btn} onClick={() => setMainFor(m)}>{POOL_TEXT.makeMain}</button>
                  </>
                ) : (
                  <button type="button" className={btn} disabled={own.length === 0} onClick={() => setTick({ person: m })}>{POOL_TEXT.tickVenue}</button>
                )}
              </div>
            </div>
          ))}
          {isAdmin && data.invites.map((i) => (
            <div key={i.id} data-pool-invite={i.id} className={rowCls}>
              <div className="flex items-center gap-3 min-w-0">
                {avatar(i.name)}
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-ink break-words">{i.name}</p>
                  <p className="text-sm text-ink-soft break-words">{inviteStatusLine(i, tz)} · {i.email}</p>
                </div>
              </div>
            </div>
          ))}
          {isAdmin && data.contacts.map((c) => (
            <div key={c.id} data-pool-contact={c.id} className={`${rowCls} ${busyId === c.id ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-3 min-w-0">
                {avatar(c.name)}
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-ink break-words">{c.name}</p>
                  <p className="text-sm text-ink-soft break-words">{contactStatusLine(c, tz)}</p>
                  {(c.phone || c.email) && (
                    <p className="text-sm text-ink-soft break-words flex flex-wrap gap-x-3">
                      {c.phone && <span className="inline-flex items-center gap-1"><Phone aria-hidden="true" className="w-3.5 h-3.5" />{c.phone}</span>}
                      {c.email && <span className="inline-flex items-center gap-1 break-all"><Mail aria-hidden="true" className="w-3.5 h-3.5" />{c.email}</span>}
                    </p>
                  )}
                  {c.note && <p className="text-sm text-ink-soft italic break-words">{c.note}</p>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-[52px]">
                {c.status === 'invited'
                  ? <button type="button" className={btn} onClick={() => void sendInvite(c)}>{POOL_TEXT.sendAgain}</button>
                  : <button type="button" className={btn} disabled={!c.email} title={!c.email ? POOL_TEXT.inviteNeedsEmail : undefined} onClick={() => void sendInvite(c)}>{POOL_TEXT.sendInvite}</button>}
                <button type="button" className={btn} onClick={() => { setNotice(null); setEditing(c); }}>{POOL_TEXT.edit}</button>
                <button type="button" className={btn} onClick={() => setRemoving(c)}>{POOL_TEXT.remove}</button>
              </div>
              {c.status === 'details' && !c.email && <p className="text-sm text-ink-soft pl-[52px]">{POOL_TEXT.inviteNeedsEmail}</p>}
            </div>
          ))}
        </div>
      )}

      {!isAdmin && borrow && (
        <section data-borrow-list aria-label={POOL_TEXT.borrowTitle} className="space-y-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-ink-soft">{POOL_TEXT.borrowTitle}</h3>
          <p className="text-base text-ink-soft">{POOL_TEXT.borrowIntro}</p>
          <div className="divide-y divide-line border border-line rounded-2xl overflow-hidden">
            {borrow.length === 0 && <p className="p-6 text-center text-base text-ink-soft">{POOL_TEXT.borrowEmpty}</p>}
            {borrow.map((b) => (
              <div key={b.id} data-borrow-person={b.id} className="p-4 flex items-center gap-3 bg-surface">
                {avatar(b.name)}
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-ink break-words">{b.name}</p>
                  <p className="text-sm text-ink-soft break-words">{POOL_TEXT.borrowFrom(b.homeVenueName)}</p>
                </div>
                <button type="button" className={btn} disabled={own.length === 0} onClick={() => setTick({ person: b, borrowFrom: b.homeVenueName })}>{POOL_TEXT.borrowButton}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {(adding || editing) && <AddToPoolSheet contact={editing} onClose={() => { setAdding(false); setEditing(null); }} onDone={done} />}
      {tick && <PoolTickSheet person={tick.person} borrowFrom={tick.borrowFrom} venues={own} agencyTimeZone={tz} onClose={() => setTick(null)} onDone={done} />}
      {mainFor && <PoolMoveDialog mode="make-main" person={mainFor} venues={venues} onClose={() => setMainFor(null)} onDone={done} />}
      {removing && (
        <Sheet title={POOL_TEXT.removeTitle(removing.name)} onClose={() => setRemoving(null)} testId="remove">
          <p className="text-base text-ink-soft">{POOL_TEXT.removeBody}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" className={btn} onClick={() => setRemoving(null)}>{POOL_TEXT.cancel}</button>
            <button type="button" data-confirm className={btnGold} disabled={busyId === removing.id} onClick={() => void remove(removing)}>{POOL_TEXT.remove}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** Owners have no Team list: the Pool opens on its own. */
export function PoolModal({ isOpen, onClose, currentUser, venues, refreshKey }: { isOpen: boolean; onClose: () => void; currentUser: User; venues: Venue[]; refreshKey?: unknown }) {
  // refreshKey = the roster (USERS_UPDATED): names, revisions and the borrow list stay current (RV1 P2).
  const pool = usePool(isOpen, true, refreshKey);
  if (!isOpen) return null;
  return (
    <Sheet title={POOL_TEXT.poolTitle} onClose={onClose} testId="pool-modal">
      <PoolPanel currentUser={currentUser} venues={venues} pool={pool} />
    </Sheet>
  );
}
