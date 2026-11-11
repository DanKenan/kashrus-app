import { createAgencyDocument, type DocumentDeps } from './food-service-store.ts';
export type Seen = { at: string; by: string; byName: string };
export type FollowUp = { note: string; by: string; byName: string; at: string };
export type InboxDoc = { seen: Record<string, Seen>; followUp: Record<string, FollowUp>; updatedAt: string };
export const olderThan90 = (submittedAt: string, now: Date) => now.getTime() - Date.parse(submittedAt) > 90 * 86400000;
export function inboxStatus(doc: InboxDoc, report: { id: string; submittedAt: string }, now: Date) {
  const seen = Object.hasOwn(doc.seen, report.id) ? doc.seen[report.id] : null;
  const followUp = Object.hasOwn(doc.followUp, report.id) ? doc.followUp[report.id] : null;
  return { status: followUp ? 'follow_up' as const : seen || olderThan90(report.submittedAt, now) ? 'seen' as const : 'new' as const, seenBy: seen ? { name: seen.byName, at: seen.at } : null, followUp: followUp ? { note: followUp.note, byName: followUp.byName, at: followUp.at } : null };
}
export function createInboxStore(deps: DocumentDeps & { submittedAt(agency: string, id: string): string | undefined }) {
  const base = createAgencyDocument<InboxDoc>(deps, 'inspectionInbox', () => ({ seen: {}, followUp: {}, updatedAt: '' }));
  const submitted = new Map<string, string>();
  const dirty = new Map<string, Set<string>>(), persisted = new Map<string, InboxDoc>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), lastFlush = new Map<string, number>();
  async function ensure(a: string) { await base.ensure(a); if (!persisted.has(a)) persisted.set(a, structuredClone(base.doc(a))); }
  function schedule(a: string) {
    if (timers.has(a)) return;
    const delay = Math.max(10_000, (lastFlush.get(a) ?? 0) + 10_000 - deps.now().getTime());
    const timer = setTimeout(() => { timers.delete(a); void flushAgency(a).catch(() => schedule(a)); }, delay); timer.unref(); timers.set(a, timer);
  }
  async function mark(a: string, report: { id: string; submittedAt: string }, user: { id: string; name: string }) {
    return base.locked(a, async () => {
      const before = base.doc(a);
      if (Object.hasOwn(before.seen, report.id) || olderThan90(report.submittedAt, deps.now())) return false;
      const next = structuredClone(before); next.seen[report.id] = { at: deps.now().toISOString(), by: user.id, byName: user.name }; next.updatedAt = deps.now().toISOString();
      base.check(next); base.install(a, next);
      submitted.set(JSON.stringify([a, report.id]), report.submittedAt);
      if (!dirty.has(a)) dirty.set(a, new Set()); dirty.get(a)!.add(report.id); schedule(a); return true;
    });
  }
  async function flushAgency(a: string, force = false) {
    return base.locked(a, async () => {
      if (!dirty.get(a)?.size) return 0;
      if (!force && lastFlush.has(a) && deps.now().getTime() - lastFlush.get(a)! < 10_000) { schedule(a); return 0; }
      const next = structuredClone(base.doc(a));
      for (const [id, entry] of Object.entries(next.seen)) {
        const submittedAt = submitted.get(JSON.stringify([a, id])) ?? deps.submittedAt(a, id);
        if (olderThan90(submittedAt ?? entry.at, deps.now())) delete next.seen[id];
      }
      next.updatedAt = deps.now().toISOString();
      const before = persisted.get(a)!;
      await base.persist(a, before, next); persisted.set(a, structuredClone(next)); base.install(a, next); dirty.delete(a); lastFlush.set(a, deps.now().getTime()); return 1;
    });
  }
  async function followUp(a: string, report: { id: string; submittedAt: string }, user: { id: string; name: string }, on: boolean, note: string) {
    return base.locked(a, async () => {
      const next = structuredClone(base.doc(a)), before = persisted.get(a)!;
      if (on) next.followUp[report.id] = { note, by: user.id, byName: user.name, at: deps.now().toISOString() };
      else { delete next.followUp[report.id]; if (!next.seen[report.id] && !olderThan90(report.submittedAt, deps.now())) next.seen[report.id] = { at: deps.now().toISOString(), by: user.id, byName: user.name }; }
      next.updatedAt = deps.now().toISOString();
      // Follow-up persists only its own paths; pending seen stays debounced.
      const saved = { ...next, seen: structuredClone(before.seen) };
      if (!on && next.seen[report.id]) saved.seen[report.id] = next.seen[report.id];
      base.check(next);
      await base.persist(a, before, saved); persisted.set(a, structuredClone(saved)); base.install(a, next);
    });
  }
  return { ensure, boot: async (agencies: string[]) => { await Promise.allSettled([...new Set(agencies)].map(ensure)); }, ready: base.ready, doc: base.doc, mark, followUp, status: (a: string, r: { id: string; submittedAt: string }) => inboxStatus(base.doc(a), r, deps.now()), flush: async (force = false) => { let writes = 0; for (const a of dirty.keys()) writes += await flushAgency(a, force); return writes; } };
}
