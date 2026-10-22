/** Normalize display spacing without changing the option's case. */
export function normalizeOption(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export function sanitizeOptions(list: readonly unknown[]):
  | { ok: true; options: string[] }
  | { ok: false; error: string } {
  if (list.length > 100) return { ok: false, error: 'Use no more than 100 items.' };
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') return { ok: false, error: 'Each choice must be text.' };
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(item)) {
      return { ok: false, error: 'Choices cannot contain control characters.' };
    }
    const option = normalizeOption(item);
    if (!option || option.length > 60) {
      return { ok: false, error: 'Each choice must be between 1 and 60 characters.' };
    }
    const key = option.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  if (options.length > 25) return { ok: false, error: 'Use no more than 25 choices.' };
  return { ok: true, options };
}

export function validateOptions(list: readonly unknown[]): string | null {
  const result = sanitizeOptions(list);
  return result.ok === false ? result.error : null;
}

/** The single source of truth for the venue's certification label. */
export function certificationLabel(agencyName: string, detail: string): string {
  const option = normalizeOption(detail);
  return option ? `${agencyName} — ${option}` : agencyName;
}

/** The picker's built-in choices (the server's defaults when an agency saved none). */
export const DEFAULT_CERT_OPTIONS: readonly string[] = ['Glatt meat', 'Dairy', 'DE', 'Parve'];

const sameText = (a: string, b: string) => normalizeOption(a).toLocaleLowerCase('en-US') === normalizeOption(b).toLocaleLowerCase('en-US');

/** What follows the agency name in legacy stored text, split at the joining dash (null = no such form). */
function legacyTail(stored: string, agencyName: string, sep: RegExp): string | null {
  const text = normalizeOption(stored);
  const name = normalizeOption(agencyName);
  if (!name || text.length <= name.length || !sameText(text.slice(0, name.length), name)) return null;
  const m = sep.exec(text.slice(name.length));
  return m ? normalizeOption(m[1]) : null;
}

/**
 * Display only: how a venue's stored certification text reads against its agency.
 * Returns the certification detail ('' = no type picked) when the stored text is
 * consistent with the agency, or null when it is not (show the stored text as is).
 *  (a) legacy: the agency name twice, joined by ' - ', ' – ', ' — ' or '-' (trim,
 *      ignore case) -> no type picked;
 *  today's forms (exactly as before): '<agency name>' and '<agency name> — <detail>';
 *  (b) legacy: '<agency name> <hyphen, en dash or em dash> <detail>' where the detail
 *      is one of the agency's options (spacing and case ignored) -> that option.
 * Stored venue data is never rewritten.
 */
export function readCertification(
  certification: string,
  agencyName: string | undefined,
  certificationDetail?: string,
  options: readonly string[] = DEFAULT_CERT_OPTIONS,
): string | null {
  if (!agencyName) return null;
  const stored = typeof certification === 'string' ? certification : '';
  const given = certificationDetail?.trim() ? normalizeOption(certificationDetail) : '';
  // (a) the agency name twice (spaced hyphen / en dash / em dash, or a bare hyphen).
  const doubled = legacyTail(stored, agencyName, /^(?: [-\u2013\u2014] | ?- ?)(.+)$/);
  if (!given && doubled !== null && sameText(doubled, agencyName)) return '';
  // Today's forms (unchanged).
  const prefix = `${agencyName} — `;
  const derived = given || (stored.startsWith(prefix) ? normalizeOption(stored.slice(prefix.length)) : '');
  if (derived && stored === certificationLabel(agencyName, derived)) return derived;
  if (!given && stored === certificationLabel(agencyName, '')) return '';
  // (b) '<agency name> <spaced dash> <one of the agency's options>'.
  const tail = legacyTail(stored, agencyName, /^ [-\u2013\u2014] (.+)$/);
  if (tail === null) return null;
  const option = options.find((o) => typeof o === 'string' && !!normalizeOption(o) && sameText(o, tail));
  if (!option) return null;
  if (given) return sameText(given, option) ? given : null;
  return normalizeOption(option);
}
