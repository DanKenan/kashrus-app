import React, { useEffect, useRef, useState } from 'react';
import { X, ScanFace, Pencil, Trash2, Plus, Info, Lock } from 'lucide-react';
import { ErrorBox } from './PasskeyOffer';
import {
  addPasskey, passkeyAddressLabel, cancelPasskeyPrompt, confirmPassword, currentAccountId, describeWhen, listPasskeys, platformPasskeyAvailable, removePasskey, renamePasskey,
  PasskeyError, PasskeyList, PasskeyRow, PASSKEY_TEXT as T,
} from '../lib/passkeys';

/** Item 11b-c (c): Face ID / passkeys in settings: add, rename, remove. */
export const PasskeysModal: React.FC<{ isOpen: boolean; userId: string; onClose: () => void; onChanged?: (l: PasskeyList) => void; onToast?: (msg: string) => void }> = ({ isOpen, userId, onClose, onChanged, onToast }) => {
  const [list, setList] = useState<PasskeyList | null>(null);
  const [platform, setPlatform] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [password, setPassword] = useState('');
  const [needPasswordToAdd, setNeedPasswordToAdd] = useState(false);

  // Each opening is one session of this dialog; every step of every action
  // stops once the dialog closes or the browser is signed in as someone else.
  const session = useRef(0);
  const inFlight = useRef(false);
  // Cancel ends the running action too (attempt number): nothing more is sent for it.
  const attempt = useRef(0);
  const guardFor = (s: number) => () => session.current === s && currentAccountId() === userId;
  useEffect(() => {
    session.current += 1;
    return () => { session.current += 1; if (inFlight.current) cancelPasskeyPrompt(); };
  }, [isOpen, userId]);

  const load = async (valid = guardFor(session.current)) => {
    try { const l = await listPasskeys(); if (!valid()) return; setList(l); onChanged?.(l); }
    catch (e: any) { if (valid()) setError(e?.message || T.offline); }
  };
  useEffect(() => {
    if (!isOpen) return;
    setList(null); setBusy(false);
    setError(null); setEditing(null); setRemoving(null); setPassword(''); setNeedPasswordToAdd(false);
    load(); platformPasskeyAvailable().then(setPlatform);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  if (!isOpen) return null;

  // One action at a time; v() is false once the dialog closed or the account changed.
  const run = async (fn: (v: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const sameDialog = guardFor(session.current);
    const mine = ++attempt.current;
    const v = () => sameDialog() && attempt.current === mine;
    if (!v()) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await fn(v); } catch (e: any) {
      if (!v() || (e instanceof PasskeyError && e.kind === 'stale')) return;
      if (e instanceof PasskeyError && e.kind === 'needPassword') { setNeedPasswordToAdd(true); return; }
      setError(e?.message || T.offline);
    } finally {
      if (attempt.current === mine) { inFlight.current = false; if (sameDialog()) setBusy(false); }
    }
  };
  const cancelAction = () => { attempt.current += 1; inFlight.current = false; setBusy(false); };
  const stop = () => new PasskeyError('stale', '');
  const add = () => run(async (v) => { await addPasskey({ stillValid: v }); if (!v()) throw stop(); setNeedPasswordToAdd(false); setPassword(''); onToast?.(T.addedToast); await load(v); });
  const addWithPassword = (ev: React.FormEvent) => { ev.preventDefault(); run(async (v) => { await confirmPassword(password); if (!v()) throw stop(); setPassword(''); setNeedPasswordToAdd(false); await addPasskey({ stillValid: v }); if (!v()) throw stop(); onToast?.(T.addedToast); await load(v); }); };
  const saveName = (ev: React.FormEvent) => { ev.preventDefault(); if (!editing) return; const e = editing; run(async (v) => { await renamePasskey(e.id, e.name.trim()); if (!v()) throw stop(); setEditing(null); await load(v); }); };
  const confirmRemove = (ev: React.FormEvent) => { ev.preventDefault(); if (!removing) return; const r = removing; run(async (v) => { await confirmPassword(password); if (!v()) throw stop(); await removePasskey(r.id, v); if (!v()) throw stop(); setRemoving(null); setPassword(''); onToast?.(T.removedToast); await load(v); }); };

  const rows = list?.passkeys ?? [];
  const full = rows.length >= 10;
  const btn = 'min-h-11 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-surface border border-line-control text-ink hover:bg-sunken cursor-pointer disabled:opacity-50';
  const pwInput = (
    <div className="relative">
      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint"><Lock className="w-4 h-4" /></div>
      <input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder={T.yourPassword}
        className="w-full pl-10 pr-3 py-2 text-base rounded-xl bg-surface border border-line-control text-ink placeholder-ink-faint focus:outline-none focus:border-gold" />
    </div>
  );

  return (
    <div data-passkeys-modal className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="passkeys-title">
      <div className="bg-surface rounded-2xl w-full max-w-md e3 border border-line overflow-hidden animate-slide-up">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-sunken text-ink-soft"><ScanFace className="w-5 h-5" /></div>
            <div>
              <h2 id="passkeys-title" className="text-sm font-bold text-ink">{T.listTitle}</h2>
              <p className="text-xs text-ink-soft">{T.listSubtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-3">
          {error && !removing && !needPasswordToAdd && <ErrorBox text={error} />}
          {!list && !error && <p className="text-xs text-ink-soft py-6 text-center">{T.loading}</p>}

          {list && rows.length === 0 && (
            <div className="py-5 text-center">
              <p className="text-sm font-semibold text-ink">{T.emptyTitle}</p>
              <p className="mt-1 text-xs text-ink-soft">{T.emptyBody}</p>
            </div>
          )}

          {rows.length > 0 && (
            <ul className="space-y-2" aria-label={T.listAria}>
              {rows.map((p) => (
                <li key={p.id} className="rounded-2xl bg-sunken border border-line p-3">
                  {editing?.id === p.id ? (
                    <form onSubmit={saveName} className="space-y-2">
                      <label className="block text-xs font-bold text-ink-soft" htmlFor={`pk-name-${p.id}`}>{T.nameLabel}</label>
                      <input id={`pk-name-${p.id}`} value={editing.name} maxLength={40} autoFocus required onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                        className="w-full px-3 py-2 text-base rounded-xl bg-surface border border-line-control text-ink focus:outline-none focus:border-gold" />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { cancelAction(); setEditing(null); }} className={btn}>{T.cancel}</button>
                        <button type="submit" disabled={busy || !editing.name.trim()} className="min-h-11 px-4 rounded-lg text-xs font-bold bg-gold-deep text-paper tactile-1 cursor-pointer disabled:opacity-50">{T.save}</button>
                      </div>
                    </form>
                  ) : removing?.id === p.id ? (
                    <form onSubmit={confirmRemove} className="space-y-2">
                      <p className="text-sm font-bold text-ink">{T.removeTitle(p.name)}</p>
                      <p className="text-xs text-ink-soft">{T.removeBody}</p>
                      {error && <ErrorBox text={error} />}
                      {pwInput}
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { cancelAction(); setRemoving(null); setPassword(''); setError(null); }} className={btn}>{T.cancel}</button>
                        <button type="submit" disabled={busy} className="min-h-11 px-4 rounded-lg text-xs font-bold bg-rose-600 text-white cursor-pointer disabled:opacity-50">{T.removeButton}</button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center gap-3">
                      <ScanFace className="w-5 h-5 text-gold-deep shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink truncate">{p.name}</p>
                        {passkeyAddressLabel(p.address) && <p data-passkey-address={p.address?.kind} className="text-xs text-ink-soft truncate">{passkeyAddressLabel(p.address)}</p>}
                        <p className="text-[11px] text-ink-faint">{T.added} {describeWhen(p.createdAt)} · {T.lastUsed} {describeWhen(p.lastUsedAt)}</p>
                      </div>
                      <button onClick={() => { setError(null); setEditing({ id: p.id, name: p.name }); }} className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-surface cursor-pointer" aria-label={T.rename(p.name)}><Pencil className="w-4 h-4" /></button>
                      <button onClick={() => { setError(null); setPassword(''); setRemoving(p); }} className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-rose-600 dark:text-rose-400 hover:bg-surface cursor-pointer" aria-label={T.remove(p.name)}><Trash2 className="w-4 h-4" /></button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {list && needPasswordToAdd && (
            <form onSubmit={addWithPassword} className="rounded-2xl bg-sunken border border-line p-3 space-y-2">
              <p className="text-xs text-ink-soft">{T.needPassword}</p>
              {error && <ErrorBox text={error} />}
              {pwInput}
              <div className="flex justify-end"><button type="submit" disabled={busy} className="min-h-11 px-4 rounded-lg text-xs font-bold bg-gold-deep text-paper tactile-1 cursor-pointer disabled:opacity-50">{T.continue}</button></div>
            </form>
          )}

          {list && list.canAdd && !needPasswordToAdd && !editing && !removing && (
            !platform ? (
              <div className="p-3 rounded-2xl bg-sunken border border-line text-xs text-ink-soft flex items-start gap-2"><Info className="w-4 h-4 shrink-0 mt-0.5 text-ink-faint" /><span>{T.unsupported}</span></div>
            ) : full ? (
              <div className="p-3 rounded-2xl bg-sunken border border-line text-xs text-ink-soft flex items-start gap-2"><Info className="w-4 h-4 shrink-0 mt-0.5 text-ink-faint" /><span>{T.limit}</span></div>
            ) : (
              <button onClick={add} disabled={busy} className="w-full py-3 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white text-sm font-bold tactile-2 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60">
                {busy && !editing && !removing ? (<><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /><span>{T.waiting}</span></>) : (<><Plus className="w-4 h-4" /><span>{T.addButton}</span></>)}
              </button>
            )
          )}
          {list && !list.canAdd && rows.length > 0 && (
            <p className="text-[11px] text-ink-faint">{T.unavailable}</p>
          )}
        </div>
      </div>
    </div>
  );
};
