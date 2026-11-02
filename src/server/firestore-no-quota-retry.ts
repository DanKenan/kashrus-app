const INSTALLED = Symbol.for('writecut.firestore-no-quota-retry');

/** Remove quota retries at the Commit RPC layer, below transaction retries.
 * Capture the current method so write-meter wrappers compose in either order.
 * The stage2 mock has no batch() and is left untouched.
 */
export function installNoQuotaRetry(db: any): void {
  if (!db || typeof db.batch !== 'function') return;
  const batch = db.batch();
  if (!batch || typeof batch._commit !== 'function') return;
  let prototype = Object.getPrototypeOf(batch);
  while (prototype && !Object.prototype.hasOwnProperty.call(prototype, '_commit')) {
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!prototype || Object.prototype.hasOwnProperty.call(prototype, INSTALLED)) return;
  const previous = prototype._commit;
  prototype._commit = function (this: any, commitOptions?: any, ...args: any[]) {
    // Transaction.commit supplies this key even for write-only transactions
    // with no ID. Do not let GAX replay an ambiguously applied transaction.
    const transaction = Object.prototype.hasOwnProperty.call(commitOptions ?? {}, 'transactionId');
    const retryCodes = (Array.isArray(commitOptions?.retryCodes) ? commitOptions.retryCodes : [14])
      .filter((code: number) => code !== 8 && !(transaction && code === 14));
    return previous.call(this, { ...commitOptions, retryCodes }, ...args);
  };
  Object.defineProperty(prototype, INSTALLED, { value: true });
}
