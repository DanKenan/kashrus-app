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
 * - Object arguments are serialized with sensitive keys redacted, and free
 *   text (string args, error messages, stacks) is scrubbed for known
 *   credential shapes (Bearer tokens, Google/ GitHub tokens, JWTs,
 *   key=value pairs with sensitive keys). This redacts known shapes — it
 *   cannot identify arbitrary secret-bearing strings, so callers must still
 *   avoid logging raw request bodies, documents, or credentials.
 *
 * Only erasable TypeScript syntax is used (no enums/namespaces) so this file
 * loads under plain `node` type-stripping as well as tsx/esbuild.
 */

export type LogSeverity = 'ERROR' | 'WARNING' | 'INFO';

// Cloud Run services set K_SERVICE; Cloud Run jobs set CLOUD_RUN_JOB instead.
const ON_GCP: boolean = !!process.env.K_SERVICE || !!process.env.CLOUD_RUN_JOB;

// Redact known secret shapes from log output. Two layers:
// 1. Object keys that look like credentials/tokens/secrets have their values
//    redacted (covers nested objects — the JSON replacer recurses).
// 2. Free text (string args, error messages, stack traces) is scrubbed for
//    credential shapes: Bearer tokens, Google/GitHub tokens, JWTs, and
//    key=value pairs with sensitive keys.
// This redacts KNOWN shapes; it cannot identify arbitrary secret-bearing
// strings. Callers must still avoid logging raw request bodies, Firestore
// documents, or credentials.
const SENSITIVE_KEY =
  /(token|password|secret|credential|api[-_]?key|private[-_]?key|auth|session|cookie|pin|jwt|pepper|vapid|code[-_]?hash|reset[-_]?code|verification[-_]?code)/i;

const TEXT_SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, // Authorization: Bearer <token>
  /Basic\s+[A-Za-z0-9+/]+=*/gi, // Authorization: Basic <base64 credentials>
  /\bya29\.[A-Za-z0-9\-_]+/g, // Google OAuth access token
  /\b(ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, // GitHub tokens
  /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g, // JWT
];

// Key names scrubbed in free text — derived from SENSITIVE_KEY so the two
// can never drift out of line.
const TEXT_SENSITIVE_KEY = new RegExp(`(?:${SENSITIVE_KEY.source})`, 'i');

function scrubText(text: string): string {
  let out = text;
  for (const re of TEXT_SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[redacted]');
  }
  // key=value or key: value where the key looks sensitive
  // (e.g. "password=hunter2", "apiKey: abc123", "sessionId=example123")
  out = out.replace(
    new RegExp(
      `([A-Za-z0-9_.-]*?${TEXT_SENSITIVE_KEY.source}[A-Za-z0-9_.-]*\\s*[:=]\\s*)([^\\s,;}"]+)`,
      'gi'
    ),
    '$1[redacted]'
  );
  return out;
}

function argToText(value: unknown): string {
  if (typeof value === 'string') return scrubText(value);
  if (value instanceof Error) return scrubText(`${value.name}: ${value.message}`);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (key, v) => {
        if (key && SENSITIVE_KEY.test(key)) return '[redacted]';
        if (typeof v === 'string') return scrubText(v);
        return v;
      });
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
    // Keep message+stack (Don debugs alerts from them), scrubbed for
    // credential shapes — an exception's text can carry a token.
    entry.error = {
      message: scrubText(err.message),
      stack: typeof err.stack === 'string' ? scrubText(err.stack) : err.stack,
    };
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
