import { AggregateField } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentDeps } from './food-service-store.ts';
import type { createFeesStore } from './fees-store.ts';

const minute = 60_000;
const lifetime = 24 * 60 * minute;
export const feePushTimeout = 10_000;
export const eventCollection = 'inspectionFeeChanges';
export const feeKey = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('base64url');

type Delivery = {
  target: string; state: 'pending' | 'sent' | 'unavailable' | 'failed'; attempts: number;
  next: number; lease?: string; reason?: string;
};
type Recipient = { admin: string; readAt: string | null; deliveries: Delivery[] | null; discoverAt?: number; discoveryAttempts?: number };
export type FeeChangeEvent = {
  id: string; agency: string; report: string; companyId: string; company: string; actorId: string; actor: string;
  oldRate: number | null; newRate: number; at: string; recipients: Recipient[];
  due?: number; pendingSince?: number; failed: number; exhausted: number;
};
const inboxCursor = (e: { at: string; id: string }) => e.at + '|' + e.id;
export function newFeeChange(fields: Omit<FeeChangeEvent, 'id' | 'recipients' | 'due' | 'pendingSince' | 'failed' | 'exhausted'>, admins: string[]): FeeChangeEvent {
  const recipients = [...new Set(admins)].map(admin => ({ admin, readAt: null, deliveries: null }));
  const id = feeKey(fields.agency, fields.report, randomUUID());
  return { ...fields, id, recipients, failed: 0, exhausted: 0,
    ...Object.fromEntries(recipients.map(r => ['inbox_' + feeKey(fields.agency, r.admin), inboxCursor({ at: fields.at, id })])),
    ...(recipients.length ? { due: Date.parse(fields.at), pendingSince: Date.parse(fields.at) } : {}) };
}

export type FeePush = {
  targets(agency: string, admin: string): Promise<string[]>;
  send(event: FeeChangeEvent, admin: string, target: string, topic: string, canSend: () => boolean): Promise<'accepted' | 'unavailable' | 'deferred'>;
};
function summarize(event: FeeChangeEvent) {
  const times: number[] = [];
  event.failed = 0;
  event.exhausted = 0;
  for (const r of event.recipients) {
    if (!r.deliveries) times.push(r.discoverAt ?? Date.parse(event.at));
    for (const d of r.deliveries ?? []) {
      if (d.state === 'pending') times.push(d.next);
      if (d.state === 'failed') { event.failed++; if (d.reason === 'exhausted') event.exhausted++; }
    }
  }
  if (times.length) {
    event.due = Math.min(...times);
    event.pendingSince = Date.parse(event.at);
  } else {
    delete event.due;
    delete event.pendingSince;
  }
}
function status(r: Recipient) {
  const ds = r.deliveries;
  if (!ds || ds.some(d => d.state === 'pending')) return 'Pending';
  if (ds.some(d => d.state === 'failed')) return 'Push failed';
  if (ds.some(d => d.state === 'sent')) return 'Sent to push service';
  return 'Push unavailable';
}
function retryDelay(error: any, now: number, attempts: number) {
  const header = error?.headers?.['retry-after'];
  const retry = header == null ? 0 : /^\d+$/.test(String(header)) ? Number(header) * 1000 : Date.parse(header) - now;
  return Math.max(Number.isFinite(retry) ? retry : 0, ([1, 5, 15, 60][attempts - 1] ?? 360) * minute);
}
export function createFeeChangeWorker(deps: DocumentDeps, fees: ReturnType<typeof createFeesStore>, push: FeePush) {
  const collection = () => deps.db().collection(eventCollection);
  const clock = () => deps.now().getTime();
  async function mutate(agency: string, id: string, change: (event: FeeChangeEvent) => boolean) {
    if (deps.staged()) throw Error('Writes blocked');
    if (deps.db()) {
      const ref = collection().doc(id);
      return deps.db().runTransaction(async (tx: any) => {
        const event: FeeChangeEvent | undefined = (await tx.get(ref)).data();
        if (!event || event.agency !== agency || !change(event)) return false;
        summarize(event);
        tx.set(ref, event);
        return true;
      });
    }
    let changed = false;
    await fees.update(agency, next => {
      const event = next.events?.[id];
      if (event && event.agency === agency && change(event)) { summarize(event); changed = true; }
    });
    return changed;
  }
  async function inbox(agency: string, admin: string, before?: string) {
    // Recipient-specific single-field index, ordered by time without a composite index.
    const field = 'inbox_' + feeKey(agency, admin);
    let rows: FeeChangeEvent[];
    if (deps.db()) {
      let query = collection().orderBy(field, 'desc');
      if (before) query = query.startAfter(before);
      rows = (await query.limit(21).get()).docs.map((d: any) => d.data());
    } else {
      rows = Object.values(fees.doc(agency).events ?? {})
        .filter(e => e.recipients.some(r => r.admin === admin) && (!before || inboxCursor(e) < before))
        .sort((a, b) => inboxCursor(a) > inboxCursor(b) ? -1 : 1);
    }
    const events = rows.filter(e => e.agency === agency && e.recipients.some(r => r.admin === admin)).slice(0, 20).map(e => {
        const r = e.recipients.find(r => r.admin === admin)!;
        return { id: e.id, company: e.company, actor: e.actor, oldRate: e.oldRate, newRate: e.newRate,
          at: e.at, report: e.report, readAt: r.readAt, status: status(r) };
      });
    return { events, nextCursor: rows.length > 20 && events.length ? inboxCursor(events[events.length - 1]) : null };
  }
  async function markRead(agency: string, id: string, admin: string) {
    return mutate(agency, id, event => {
      const r = event.recipients.find(r => r.admin === admin);
      if (!r) return false;
      r.readAt ??= deps.now().toISOString();
      return true;
    });
  }
  async function deliver(event: FeeChangeEvent, r: Recipient, target: string) {
    const token = randomUUID(), deadline = Date.parse(event.at) + lifetime;
    const find = (e: FeeChangeEvent) => e.recipients.find(x => x.admin === r.admin)?.deliveries?.find(d => d.target === target);
    let expires = 0;
    const claimed = await mutate(event.agency, event.id, current => {
      const d = find(current), now = clock();
      if (!d || d.state !== 'pending' || d.next > now) return false;
      if (now >= deadline) { d.state = 'failed'; d.reason = 'exhausted'; delete d.lease; return true; }
      expires = now + 2 * minute;
      d.lease = token; d.next = expires; d.attempts++;
      return true;
    });
    if (!claimed || clock() >= deadline) return;
    const canSend = () => !deps.staged() && clock() + feePushTimeout < Math.min(expires, deadline);
    let result: 'accepted' | 'unavailable' | 'deferred' | 'error', error: any;
    try { result = await push.send(event, r.admin, target, feeKey(event.agency, event.id, r.admin).slice(0, 32), canSend); }
    catch (e) { result = 'error'; error = e; }
    await mutate(event.agency, event.id, current => {
      const d = find(current);
      if (!d || d.lease !== token) return false;
      delete d.lease;
      if (result === 'accepted') d.state = 'sent';
      else if (result === 'unavailable') d.state = 'unavailable';
      else if (result === 'deferred') d.next = Math.min(deadline, clock() + minute);
      else {
        const code = Number(error?.statusCode);
        if ((code >= 400 && code < 500 && ![408, 425, 429].includes(code)) || clock() >= deadline) {
          d.state = 'failed'; d.reason = clock() >= deadline ? 'exhausted' : 'rejected';
        } else d.next = Math.min(deadline, clock() + retryDelay(error, clock(), d.attempts));
      }
      return true;
    });
  }
  async function process(event: FeeChangeEvent) {
    for (const r of event.recipients) {
      let ds = r.deliveries;
      if (!ds) {
        const now = clock(), deadline = Date.parse(event.at) + lifetime;
        if ((r.discoverAt ?? 0) > now) continue;
        if (now >= deadline) {
          ds = [{ target: '', state: 'failed', next: now, attempts: 0, reason: 'exhausted' }];
        } else {
          try {
            const targets = [...new Set(await push.targets(event.agency, r.admin))];
            ds = targets.map(target => ({ target, state: 'pending', next: now, attempts: 0 }));
          } catch (error) {
            await mutate(event.agency, event.id, current => {
              const row = current.recipients.find(x => x.admin === r.admin);
              if (!row || row.deliveries || (row.discoverAt ?? 0) > now) return false;
              row.discoveryAttempts = (row.discoveryAttempts ?? 0) + 1;
              row.discoverAt = Math.min(deadline, now + retryDelay(error, now, row.discoveryAttempts));
              return true;
            });
            continue;
          }
        }
        const initialized = await mutate(event.agency, event.id, current => {
          const row = current.recipients.find(x => x.admin === r.admin);
          if (!row || row.deliveries) return false;
          row.deliveries = ds;
          return true;
        });
        if (!initialized) continue;
      }
      for (const d of ds) if (d.state === 'pending' && d.next <= clock()) await deliver(event, r, d.target);
    }
  }
  async function sweep(agencies: string[]) {
    let all: FeeChangeEvent[] = [];
    if (!deps.db()) for (const agency of agencies) {
      await fees.ensure(agency);
      all.push(...Object.values(fees.doc(agency).events ?? {}));
    }
    const due: FeeChangeEvent[] = deps.db()
      ? (await collection().where('due', '<', clock() + 1).limit(50).get()).docs.map((d: any) => d.data())
      : all.filter(e => e.due !== undefined && e.due <= clock()).sort((a,b) => a.due! - b.due!).slice(0,50);
    for (const event of due) await process(event);
    if (!deps.db()) all = agencies.flatMap(a => Object.values(fees.doc(a).events ?? {}));
    const oldestPending = deps.db()
      ? (await collection().orderBy('pendingSince').limit(1).get()).docs[0]?.data().pendingSince
      : all.filter(e => e.pendingSince !== undefined).sort((a,b) => a.pendingSince! - b.pendingSince!)[0]?.pendingSince;
    async function count(field: 'failed' | 'exhausted') {
      if (!deps.db()) return all.reduce((sum, e) => sum + e[field], 0);
      const query = collection().where(field, '>=', 1);
      if (typeof query.aggregate === 'function')
        return (await query.aggregate({ total: AggregateField.sum(field) }).get()).data().total;
      const { docs } = await query.select(field).get();
      return docs.reduce((sum: number, d: any) => sum + d.data()[field], 0);
    }
    const [failedDeliveries, exhaustedDeliveries] = await Promise.all([count('failed'), count('exhausted')]);
    return { processed: due.length, oldestPendingAt: oldestPending == null ? null : new Date(oldestPending).toISOString(), failedDeliveries, exhaustedDeliveries };
  }
  return { sweep, inbox, markRead };
}
