import type { CSSProperties } from 'react';
import type { Task, User } from '../types';

/**
 * Deterministic category color system.
 *
 * The picker offers Opening Procedures / Locking Procedures plus the
 * user's own custom categories (name + hand-picked color, saved per
 * user). Anything else a category is ever called still hashes to a
 * stable OKLCH hue, so legacy or future categories automatically get a
 * distinct, consistent look with zero configuration. Pair with the
 * `.cat-*` classes in index.css by spreading `categoryVars(name)` onto
 * the element's `style`.
 */

const CATEGORY_HUES = [
  72,   // amber / gold
  48,   // orange
  28,   // rust
  8,    // ember red
  348,  // rose
  322,  // magenta
  292,  // plum
  268,  // violet
  242,  // blue
  214,  // azure
  188,  // teal
  158,  // jade
  128,  // green
  100,  // lime olive
] as const;

function hashName(name: string): number {
  const n = (name || '').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < n.length; i++) {
    h = ((h << 5) + h + n.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Stable OKLCH hue for a category name. Custom categories (chosen by the
 *  user in the task form) win over the hash so a hand-picked color sticks. */
export function categoryHue(name: string): number {
  const custom = customHueFor(name, activeCustomCategories);
  if (custom !== undefined) return custom;
  return CATEGORY_HUES[hashName(name) % CATEGORY_HUES.length];
}

/** Inline style carrying the category hue for `.cat-*` classes. */
export function categoryVars(name: string): CSSProperties {
  return { '--cat-h': String(categoryHue(name)) } as CSSProperties;
}

/** Inline style with an explicit hue (used by the color swatch picker). */
export function categoryVarsForHue(hue: number): CSSProperties {
  return { '--cat-h': String(hue) } as CSSProperties;
}

/* ------------------------------------------------------------------
   Custom categories — the "Other" box.
   The admin picks Opening Procedures / Locking Procedures, or taps
   Other, types a name, and picks a color from a curated palette. The
   choice is saved per user and offered again next time; custom entries
   can be deleted from the picker.
------------------------------------------------------------------ */

export const PRESET_CATEGORIES = ['Opening Procedures', 'Locking Procedures'] as const;

/** Curated palette for hand-picked category colors — systematic, warm-safe. */
export const CATEGORY_PALETTE = [
  348, // rose
  18,  // ember
  48,  // marigold
  92,  // olive
  142, // green
  172, // teal
  205, // sky
  238, // blue
  268, // violet
  305, // magenta
] as const;

export interface CustomCategory {
  name: string;
  hue: number;
}

const customKey = (email: string) => `kk_custom_categories:${email.trim().toLowerCase()}`;

export function loadCustomCategories(email?: string | null): CustomCategory[] {
  if (!email || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(customKey(email));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c) => c && typeof c.name === 'string' && typeof c.hue === 'number')
      .map((c) => ({ name: c.name.trim(), hue: c.hue }))
      .filter((c) => c.name.length > 0);
  } catch {
    return [];
  }
}

function persistCustomCategories(email: string, list: CustomCategory[]): void {
  try {
    localStorage.setItem(customKey(email), JSON.stringify(list));
  } catch {
    /* storage full or unavailable — custom categories just won't persist */
  }
}

/** Add or replace a custom category; returns the updated list. */
export function saveCustomCategory(email: string, cat: CustomCategory): CustomCategory[] {
  const name = cat.name.trim();
  if (!name) return loadCustomCategories(email);
  const list = loadCustomCategories(email).filter(
    (c) => c.name.toLowerCase() !== name.toLowerCase()
  );
  list.push({ name, hue: cat.hue });
  persistCustomCategories(email, list);
  setActiveCustomCategories(list);
  return list;
}

/** Remove a custom category; returns the updated list. */
export function deleteCustomCategory(email: string, name: string): CustomCategory[] {
  const list = loadCustomCategories(email).filter(
    (c) => c.name.toLowerCase() !== name.trim().toLowerCase()
  );
  persistCustomCategories(email, list);
  setActiveCustomCategories(list);
  return list;
}

function customHueFor(name: string, list: CustomCategory[]): number | undefined {
  const n = (name || '').trim().toLowerCase();
  if (!n) return undefined;
  return list.find((c) => c.name.toLowerCase() === n)?.hue;
}

/**
 * Module-level active list for render paths (cards, pills, table rows)
 * that call `categoryVars(name)` without user context. The app refreshes
 * it on login, logout, and whenever custom categories change.
 */
let activeCustomCategories: CustomCategory[] = [];

export function setActiveCustomCategories(list: CustomCategory[]): void {
  activeCustomCategories = list;
}

export function refreshCustomCategories(email?: string | null): void {
  setActiveCustomCategories(loadCustomCategories(email));
}

/**
 * True when the admin designated this task specifically for this user —
 * i.e. their email is in `assignedTo` and it isn't a blanket "everyone"
 * assignment. These are the tasks that should visually pop for the
 * mashgiach over the scattered team-wide list.
 */
export function isDirectlyAssigned(task: Task, user: User | null): boolean {
  if (!user?.email) return false;
  if (task.assignedTo.includes('all')) return false;
  const me = user.email.toLowerCase();
  return task.assignedTo.some((e) => e.toLowerCase() === me);
}

/** True when the task is visible to the user at all (mine tab logic). */
export function isVisibleToUser(task: Task, user: User | null): boolean {
  if (task.assignedTo.includes('all')) return true;
  if (!user?.email) return false;
  const me = user.email.toLowerCase();
  return task.assignedTo.some((e) => e.toLowerCase() === me);
}
