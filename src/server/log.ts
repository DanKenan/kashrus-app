/**
 * Tiny structured logger for the Shutfey server.
 *
 * WHY THIS EXISTS: Cloud Run assigns severity DEFAULT to plain-text stdout/stderr
 * lines. It only records a real severity when the app writes ONE line of JSON per
 * log call with special fields (see https://cloud.google.com/run/docs/logging —
 * "Write structured logs": `severity` and `message` are special fields). Without
 * this, no log-based alert can key on severity>=ERROR — every alert filter would
 * have to match on text alone.
 *
 * Behavior:
 * - On Google Cloud (K_SERVICE set for Cloud Run services, CLOUD_RUN_JOB set for
 *   Cloud Run jobs — jobs do NOT set K_SERVICE) each call writes exactly one
 *   JSON line: {"severity":"ERROR","message":"...","component":"shutfey-server",
 *   "error":{"message","stack"}}. The logging agent turns `severity` into the
 *   entry's severity and keeps the text in jsonPayload.message.
 * - Locally (neither env var set) it passes args straight through to
 *   console.error / console.warn / console.log so dev output stays readable.
 *
 * Rules the implementation follows:
 * - Exactly one line per call: JSON.stringify escapes embedded newlines, so even
 *   a stack trace in the message cannot split the entry across lines.
 * - Error objects are never silently dropped: the first Error argument becomes
 *   the structured `error: {message, stack}` field (JSON.stringify(new Error())
 *   is `{}` — message/stack are non-enumerable, so they are extracted by hand),
 *   and every argument is also folded into the human-readable `message` text.
 * - Message prefixes are preserved verbatim ("[alert-test] TEST ALERT",
 *   "[consistency] ERROR", "[commitOrRespond:<label>]") so existing log-filter
 *   text terms keep matching.
 * - Object arguments are serialized with sensitive keys redacted — any key
 *   matching token/password/secret/credential/api-key/auth/session/cookie/pin/jwt
 *   becomes "[redacted]", so a log line can never carry credentials or tokens.
 *
 * Only erasable TypeScript syntax is used (no enums/namespaces) so this file
 * loads under plain `node` type-stripping as well as tsx/esbuild.
 */

export type LogSeverity = 'ERROR' | 'WARNING' | 'INFO';

// Cloud Run services set K_SERVICE; Cloud Run jobs set CLOUD_RUN_JOB instead.
const ON_GCP: boolean = !!process.env.K_SERVICE || !!process.env.CLOUD_RUN_JOB;

// Never let a log line carry secrets: any object key that looks like a
// credential, token, or secret has its value redacted before serialization.
// (ChatGPT review requirement: the serializer must never dump request bodies,
// Firestore documents, tokens, or credentials.)
const SENSITIVE_KEY = /(token|password|secret|credential|api[-_]?key|private[-_]?key|auth|session|cookie|pin|jwt)/i;

function argToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (key, v) =>
        key && SENSITIVE_KEY.test(key) ? '[redacted]' : v
      );
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function firstErrorOf(args: unknown[]): Error | undefined {
  for (const a of args) {
    if (a instanceof Error) return a;
  }
  return undefined;
}

function emit(severity: LogSeverity, args: unknown[]): void {
  if (!ON_GCP) {
    // Local dev: plain readable console output, original args untouched.
    if (severity === 'ERROR') console.error(...args);
    else if (severity === 'WARNING') console.warn(...args);
    else console.log(...args);
    return;
  }
  const text = args.map(argToText).join(' ');
  const entry: Record<string, unknown> = {
    severity,
    message: text,
    component: 'shutfey-server',
  };
  const err = firstErrorOf(args);
  if (err) {
    entry.error = { message: err.message, stack: err.stack };
  }
  const line = JSON.stringify(entry);
  if (severity === 'ERROR') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  error: (...args: unknown[]): void => emit('ERROR', args),
  warn: (...args: unknown[]): void => emit('WARNING', args),
  info: (...args: unknown[]): void => emit('INFO', args),
};
