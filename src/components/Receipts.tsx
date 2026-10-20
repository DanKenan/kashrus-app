import React, { useEffect, useState } from 'react';
import { CheckCheck, X } from 'lucide-react';
import { ReaderList, ReceiptCount, fetchReaders } from '../lib/alerts';

// 5b — ✓✓ read receipts, admin and coordinator only (the server refuses
// everyone else). A count line under each item opens the reader list.
// Never colour alone: "All read" is said in words, not only in green.

export function ReceiptLine({ count, onOpen }: { count: ReceiptCount | undefined; onOpen: () => void }) {
  if (!count || count.total === 0) return null;
  const all = count.read >= count.total;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Read by ${count.read} of ${count.total}. Show who read it`}
      className="pressable inline-flex items-center gap-1.5 min-h-11 -ml-1 px-1 text-sm font-semibold cursor-pointer"
      style={{ color: all ? 'var(--ok)' : 'var(--ink-soft)' }}
    >
      <CheckCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
      {all ? `All ${count.total} read` : `${count.read}/${count.total} read`}
    </button>
  );
}

const ROLE_WORD: Record<string, string> = {
  admin: 'Admin',
  coordinator: 'Coordinator',
  mashgiach: 'Mashgiach',
  worker: 'Worker',
  owner: 'Owner',
};

/** The reader list, drawn over the sheet's body. Names and roles only. */
export function ReadersPanel({
  kind,
  id,
  venueId,
  title,
  onClose,
}: {
  kind: 'announcement' | 'alert';
  id: string;
  venueId: string;
  title: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ReaderList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    setData(null);
    setFailed(false);
    fetchReaders(kind, id, venueId, ctrl.signal)
      .then((d) => { if (!live) return; if (d) setData(d); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; ctrl.abort(); };
  }, [kind, id, venueId]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="absolute inset-0 z-10 bg-surface flex flex-col" role="region" aria-label="Who read it">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-line shrink-0">
        <h3 dir="auto" className="flex-1 min-w-0 text-base font-bold truncate">Who read “{title}”</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the reader list"
          className="pressable w-11 h-11 flex items-center justify-center rounded-lg hover:bg-sunken cursor-pointer shrink-0"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="overflow-y-auto flex-1 px-4 py-3">
        {failed ? (
          <p className="text-base text-ink-soft">Couldn't load the reader list. Close and try again.</p>
        ) : !data ? (
          <p className="text-base text-ink-faint">Loading…</p>
        ) : (
          <>
            <h4 className="text-sm font-bold text-ink-soft mb-1">Read ({data.read.length})</h4>
            <ul className="mb-4">
              {data.read.length === 0 && <li className="text-sm text-ink-faint py-2">Nobody yet.</li>}
              {data.read.map((p, i) => (
                <li key={`r${i}`} className="flex items-center gap-2 min-h-11 border-b border-line">
                  <CheckCheck className="w-4 h-4 shrink-0" style={{ color: 'var(--ok)' }} aria-hidden="true" />
                  <span dir="auto" className="flex-1 min-w-0 truncate text-base">{p.name}</span>
                  <span className="text-xs text-ink-faint shrink-0">{ROLE_WORD[p.role] || p.role}</span>
                  <span className="text-xs text-ink-soft shrink-0">{when(p.readAt)}</span>
                </li>
              ))}
            </ul>
            <h4 className="text-sm font-bold text-ink-soft mb-1">Not yet ({data.notYet.length})</h4>
            <ul>
              {data.notYet.map((p, i) => (
                <li key={`n${i}`} className="flex items-center gap-2 min-h-11 border-b border-line">
                  <span dir="auto" className="flex-1 min-w-0 truncate text-base text-ink-soft">{p.name}</span>
                  <span className="text-xs text-ink-faint shrink-0">{ROLE_WORD[p.role] || p.role}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
