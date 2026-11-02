import { noteQuotaError } from './read-meter.ts';

/** Retry short transaction blips ourselves; never retry quota at either layer. */
export async function runFirestoreTransaction<T>(
  db: any,
  fn: (tx: any) => Promise<T>,
  hooks: { beforeAttempt?: () => void } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.runTransaction(async (tx: any) => {
        hooks.beforeAttempt?.();
        return fn(tx);
      }, { maxAttempts: 1 });
    } catch (err: any) {
      if (noteQuotaError(err)) throw err;
      const code = String(err?.code ?? err?.status ?? '').toUpperCase().replaceAll('_', '-');
      const retryable = ['10', '409', '14', '4', '13', '1', '2', 'ABORTED', 'UNAVAILABLE',
        'DEADLINE-EXCEEDED', 'INTERNAL', 'CANCELLED', 'UNKNOWN'].includes(code) ||
        (['3', 'INVALID-ARGUMENT'].includes(code) && /transaction has expired/i.test(String(err?.message)));
      if (!retryable || attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 100 * 1.5 ** attempt * (0.5 + Math.random()))));
    }
  }
}
