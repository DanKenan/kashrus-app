import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
import { addDays } from './schedule.ts';
import type { FeesDoc } from './fees.ts';
export function createFeesStore(deps: DocumentDeps) {
  const store = createAgencyDocument<FeesDoc>(deps, 'inspectionFees', () => ({ settings: { feeEditors: 'admins' }, places: {}, accountant: null, lastSent: null, decisions: {}, updatedAt: '' }));
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
  return { ...store, claim, restore };
}
