/**
 * Item 8x: Clean Slate is removed (no route writes these flags any more), but
 * stored data may still carry agencies[].cleanSlateAt from before. This is the
 * read side only, unchanged from the former src/server/clean-slate.ts.
 */

/** The per-agency cleared state the client sees (never the legacy global). */
export function agencyIsCleared(agencies: any[], agencyId: string): boolean {
  const a = (Array.isArray(agencies) ? agencies : []).find((x) => x && x.id === agencyId);
  return !!(a && typeof a.cleanSlateAt === 'string' && a.cleanSlateAt);
}
