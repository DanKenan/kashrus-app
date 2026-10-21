/**
 * Item V1 (Don, Oct 21 9:25 AM): certification picker, server side.
 * Per-agency saved "Certification details" options. Pure helpers.
 *
 * Fail closed: a malformed request is refused whole (never a partial write);
 * a malformed STORED value projects as the defaults.
 */
export const DEFAULT_CERT_OPTIONS: readonly string[] = ['Glatt meat', 'Dairy', 'DE', 'Parve'];
export const CERT_OPTION_MAX_LEN = 60;
export const CERT_OPTIONS_MAX = 25;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type CertOptionsResult = { ok: true; options: string[] } | { ok: false; error: string };

/** Validate + normalise a requested list (trim, collapse spaces, case-insensitive de-dupe keeping the first). */
export function sanitizeCertOptions(input: unknown): CertOptionsResult {
  if (!Array.isArray(input)) return { ok: false, error: 'options must be a list of text labels.' };
  if (input.length > CERT_OPTIONS_MAX * 4) return { ok: false, error: `At most ${CERT_OPTIONS_MAX} options.` };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each option must be text.' };
    if (CONTROL.test(raw)) return { ok: false, error: 'An option contains a character that is not allowed.' };
    const v = raw.trim().replace(/\s+/g, ' ');
    if (!v) return { ok: false, error: 'An option cannot be empty.' };
    if (v.length > CERT_OPTION_MAX_LEN) return { ok: false, error: `Each option can be at most ${CERT_OPTION_MAX_LEN} characters.` };
    const key = v.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  if (out.length > CERT_OPTIONS_MAX) return { ok: false, error: `At most ${CERT_OPTIONS_MAX} options.` };
  return { ok: true, options: out };
}

/** The list every client sees: the stored list when it is valid and already normalised, else the defaults. */
export function effectiveCertOptions(agency: any): string[] {
  const stored = agency && typeof agency === 'object' ? agency.certificationOptions : undefined;
  if (stored === undefined) return [...DEFAULT_CERT_OPTIONS];
  const r = sanitizeCertOptions(stored);
  if (!r.ok || r.options.length !== (stored as unknown[]).length) return [...DEFAULT_CERT_OPTIONS];
  return r.options;
}

/** Same list, order included (for the stale-baseline check). */
export function sameCertOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
