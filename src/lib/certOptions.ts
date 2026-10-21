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
