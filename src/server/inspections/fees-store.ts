import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
import { addDays } from './schedule.ts';
import type { FeesDoc } from './fees.ts';
export function createFeesStore(deps: DocumentDeps) {
  const store = createAgencyDocument<FeesDoc>(deps, 'inspectionFees', () => ({ settings: { feeEditors: 'admins' }, places: {}, accountant: null, lastSent: null, decisions: {}, updatedAt: '' }));
  // Called under the local agency lock. The transaction coordinates independent instances.
  async function claim(agency: string, from: string, to: string, monthToDate = false): Promise<string | null> {
    if (deps.staged()) throw Object.assign(Error('Writes blocked'), { status: 503 });
    const at = deps.now().toISOString();
    const checkpoint = (previous: FeesDoc['lastSent']) => { const start = !monthToDate && previous && previous.periodEnd >= from ? addDays(previous.periodEnd, 1) : from; return { at, periodEnd: to, key: `${agency}|${start}|${to}` }; };
    if (deps.db()) {
      const ref = deps.db().collection('inspectionFees').doc(agency);
      const result = await deps.db().runTransaction(async (tx: any) => {
        const current = (await tx.get(ref)).data();
        if (current?.lastSent?.periodEnd >= to) return { claimed: false, lastSent: current.lastSent };
        const lastSent = checkpoint(current?.lastSent);
        store.check({ ...store.doc(agency), ...current, lastSent, updatedAt: at });
        tx.set(ref, { lastSent, updatedAt: at }, { merge: true });
        return { claimed: true, lastSent };
      });
      store.install(agency, { ...store.doc(agency), lastSent: result.lastSent });
      return result.claimed ? result.lastSent.key : null;
    }
    if (store.doc(agency).lastSent && store.doc(agency).lastSent!.periodEnd >= to) return null;
    const lastSent = checkpoint(store.doc(agency).lastSent);
    const prepared = store.stage(agency, next => { next.lastSent = lastSent; });
    if (prepared) { await store.persistLocal(agency, prepared.next); store.install(agency, prepared.next); }
    return lastSent.key;
  }
  return { ...store, claim };
}
