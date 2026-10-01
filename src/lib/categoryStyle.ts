import type { CSSProperties } from 'react';
import type { Task, User } from '../types';

/**
 * Deterministic category color system.
 *
 * Every category name hashes to a stable OKLCH hue, so any category the
 * admin creates — "Opening Procedures", "Closing Procedures", or anything
 * invented next month — automatically gets a distinct, consistent look with
 * zero configuration. Pair with the `.cat-*` classes in index.css by
 * spreading `categoryVars(name)` onto the element's `style`.
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

/** Stable OKLCH hue for a category name. */
export function categoryHue(name: string): number {
  return CATEGORY_HUES[hashName(name) % CATEGORY_HUES.length];
}

/** Inline style carrying the category hue for `.cat-*` classes. */
export function categoryVars(name: string): CSSProperties {
  return { '--cat-h': String(categoryHue(name)) } as CSSProperties;
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
