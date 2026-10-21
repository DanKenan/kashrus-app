/** Normalize display spacing without changing the option's case. */
export function normalizeOption(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export function validateOptions(list: readonly unknown[]): string | null {
  if (list.length > 25) return 'Use no more than 25 choices.';
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') return 'Each choice must be text.';
    if (/[\u0000-\u001f\u007f-\u009f]/.test(item)) return 'Choices cannot contain control characters.';
    const option = normalizeOption(item);
    if (!option || option.length > 60) return 'Each choice must be between 1 and 60 characters.';
    const key = option.toLowerCase();
    if (seen.has(key)) return 'Each choice must be unique (ignoring case).';
    seen.add(key);
  }
  return null;
}

/** The single source of truth for the venue's certification label. */
export function certificationLabel(agencyName: string, detail: string): string {
  const option = normalizeOption(detail);
  return option ? `${agencyName} — ${option}` : agencyName;
}
