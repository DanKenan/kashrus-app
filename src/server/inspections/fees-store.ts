import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
import { eventCollection, newFeeChange } from './fee-change-events.ts';
import { addDays } from './schedule.ts';
import type { FeesDoc } from './fees.ts';
export function createFeesStore(deps: DocumentDeps) {
  const empty = (): FeesDoc => ({ settings: { feeEditors: 'admins' }, places: {}, accountant: null, lastSent: null, decisions: {}, updatedAt: '' });
  const store = createAgencyDocument<FeesDoc>(deps, 'inspectionFees', empty);
  type Change = { agency: string; report: string; companyId: string; company: string; actorId: string; actor: string;
    coordinator: boolean; newRate: number; inherited: number | null; admins: string[] };
  async function recordChange(input: Change) {
    const { agency, report, companyId, company, actorId, actor, coordinator, newRate, inherited, admins } = input;
    return store.locked(agency, async () => {
      const at = deps.now().toISOString();
      const decide = (before: FeesDoc) => {
        if (coordinator && before.settings.feeEditors !== 'admins_and_coordinators')
          return { error: 'Forbidden', status: 403 } as const;
        const previous = before.decisions[report];
        if (coordinator && previous?.setFee) {
          if (previous.by === actorId && previous.amount === newRate) return { decided: previous } as const;
          return { error: 'This report fee change has already been recorded', status: 409 } as const;
        }
        const old = Object.hasOwn(before.places, companyId) ? before.places[companyId] : null;
        const oldRate = old?.mashgiach?.amount ?? inherited;
        if (previous?.setFee && previous.by === actorId && previous.amount === newRate && oldRate === newRate)
          return { decided: previous } as const;
        const decided = { amount: newRate, setFee: true as const, by: actorId, byName: actor, at };
        const next = { ...before, decisions: { ...before.decisions, [report]: decided }, updatedAt: at };
        if (oldRate !== newRate) next.places = { ...before.places, [companyId]: {
          company: old?.company ?? null, mashgiach: { amount: newRate }, updatedBy: actorId, updatedAt: at,
        } };
        const event = coordinator && oldRate !== newRate
          ? newFeeChange({ agency, report, company, companyId, actor, actorId, oldRate, newRate, at }, admins) : null;
        return { decided, next, event } as const;
      };
      let result: ReturnType<typeof decide>;
      if (deps.db()) {
        const ref = deps.db().collection('inspectionFees').doc(agency);
        const committed = await deps.db().runTransaction(async (tx: any) => {
          const current = { ...empty(), ...(await tx.get(ref)).data() };
          const result = decide(current);
          if (result.next) {
            store.check(result.next);
            tx.set(ref, result.next);
            if (result.event) tx.set(deps.db().collection(eventCollection).doc(result.event.id), result.event);
          }
          return { result, current };
        });
        result = committed.result;
        store.install(agency, result.next ?? committed.current);
      } else {
        result = decide(store.doc(agency));
        if (result.next) {
          if (result.event) result.next.events = { ...result.next.events, [result.event.id]: result.event };
          store.check(result.next);
          await store.persistLocal(agency, result.next);
          store.install(agency, result.next);
        }
      }
      return result.error ? { error: result.error, status: result.status } : { decided: result.decided };
    });
  }
  // Called under the local agency lock. The transaction coordinates independent instances.
  async function claim(agency: string, from: string, to: string, after?: { observedAt: string | null; newestReportId: string }): Promise<{ key: string; previous: FeesDoc['lastSent'] } | null> {
    if (deps.staged()) throw Object.assign(Error('Writes blocked'), { status: 503 });
    const at = deps.now().toISOString();
    const afterKey = after ? `${agency}|after_report|${after.newestReportId}` : null;
    const checkpoint = (previous: FeesDoc['lastSent']) => {
      const start = !after && previous && previous.periodEnd >= from ? addDays(previous.periodEnd, 1) : from;
      return { at, periodEnd: to, key: afterKey ?? `${agency}|${start}|${to}` };
    };
    const eligible = (previous: FeesDoc['lastSent']) => after
      ? (previous?.at ?? null) === after.observedAt && previous?.key !== afterKey
      : !previous || previous.periodEnd < to;
    if (deps.db()) {
      const ref = deps.db().collection('inspectionFees').doc(agency);
      const result = await deps.db().runTransaction(async (tx: any) => {
        const current = (await tx.get(ref)).data(), previous: FeesDoc['lastSent'] = current?.lastSent ?? null;
        if (!eligible(previous)) return { claimed: false, lastSent: previous, previous };
        const lastSent = checkpoint(previous);
        store.check({ ...store.doc(agency), ...current, lastSent, updatedAt: at });
        tx.set(ref, { lastSent, updatedAt: at }, { merge: true });
        return { claimed: true, lastSent, previous };
      });
      store.install(agency, { ...store.doc(agency), lastSent: result.lastSent });
      return result.claimed ? { key: result.lastSent.key, previous: result.previous } : null;
    }
    const previous = store.doc(agency).lastSent;
    if (!eligible(previous)) return null;
    const lastSent = checkpoint(previous);
    const prepared = store.stage(agency, next => { next.lastSent = lastSent; });
    if (prepared) { await store.persistLocal(agency, prepared.next); store.install(agency, prepared.next); }
    return { key: lastSent.key, previous };
  }
  async function restore(agency: string, claim: { key: string; previous: FeesDoc['lastSent'] }) {
    // Only on a send failure; one merge write, without reading the document again.
    const prepared = store.stage(agency, next => {
      if (next.lastSent?.key === claim.key) next.lastSent = claim.previous;
    });
    if (!prepared) return;
    await store.persist(agency, prepared.before, prepared.next);
    store.install(agency, prepared.next);
  }
  return { ...store, claim, restore, recordChange };
}
