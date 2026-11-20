import { feeKey, type FeePush } from './fee-change-events.ts';

type Subscription = { userId?: string; agencyId?: string; endpoint: string; keys: { p256dh: string; auth: string } };
export function createFeeChangePush(deps: {
  eligible(agency: string, admin: string): Promise<Subscription[]>;
  send(sub: Subscription, payload: string, topic: string): Promise<{ statusCode: number }>;
  prune(sub: Subscription): Promise<void>;
}): FeePush {
  const key = (s: Subscription) => feeKey(s.endpoint, s.keys.p256dh, s.keys.auth);
  return {
    async targets(agency, admin) { return (await deps.eligible(agency, admin)).map(key); },
    async send(event, admin, target, topic, canSend) {
      const sub = (await deps.eligible(event.agency, admin)).find(s => key(s) === target);
      if (!sub) return 'unavailable';
      const payload = JSON.stringify({ title: 'Factory visit fee changed', body: event.company + ' — changed by ' + event.actor,
        data: { eventId: event.id, tag: topic } });
      try {
        // Eligibility may require a slow read. Reserve time for the provider call inside the lease.
        if (!canSend()) return 'deferred';
        const response = await deps.send(sub, payload, topic);
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw Object.assign(Error('Push service rejected request'), { statusCode: response.statusCode });
        return 'accepted';
      } catch (error: any) {
        if (![404, 410].includes(error?.statusCode)) throw error;
        await deps.prune(sub);
        return 'unavailable';
      }
    },
  };
}
