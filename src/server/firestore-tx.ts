import { noteQuotaError } from './read-meter.ts';

/** Retry short transaction blips ourselves; never retry quota at either layer. */
export async function runFirestoreTransaction<T>(
  db: any,
  fn: (tx: any) => Promise<T>,
  hooks: { beforeAttempt?: () => void } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let callbackResolved = false;
    try {
      return await db.runTransaction(async (tx: any) => {
        hooks.beforeAttempt?.();
        const result = await fn(tx);
        callbackResolved = true;
        return result;
      }, { maxAttempts: 1 });
    } catch (err: any) {
      if (noteQuotaError(err)) throw err;
      const code = String(err?.code ?? err?.status ?? '').toUpperCase().replaceAll('_', '-');
      const notApplied = ['10', '409', 'ABORTED'].includes(code) ||
        (['3', 'INVALID-ARGUMENT'].includes(code) && /transaction has expired/i.test(String(err?.message)));
      // A failed commit response may hide a successful write. Only replay the
      // callback after commit when the server confirmed it was not applied.
      const retryable = notApplied || (!callbackResolved &&
        ['14', '4', '13', '1', '2', 'UNAVAILABLE', 'DEADLINE-EXCEEDED',
          'INTERNAL', 'CANCELLED', 'UNKNOWN'].includes(code));
      if (!retryable || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 100 * 1.5 ** attempt * (0.5 + Math.random()))));
    }
  }
}
