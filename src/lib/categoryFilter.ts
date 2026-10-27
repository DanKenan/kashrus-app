import { taskCategories } from './utils';

/**
 * Category chips on the task board: pick several at once (AND).
 * Don (Oct 27): "Opening Procedures" + "Bakery & Deli" shows only the tasks
 * that carry BOTH. No chip picked (an empty list) = every task, as before.
 */

/** "All" clears every pick; tapping a picked chip unpicks it; anything else adds it. */
export function toggleCategory(selected: readonly string[], cat: string): string[] {
  if (cat === 'all') return [];
  return selected.includes(cat) ? selected.filter((c) => c !== cat) : [...selected, cat];
}

/** True when the task carries every picked category (AND). Nothing picked = true. */
export function matchesCategories(
  task: { category?: string; categories?: string[] },
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  const cats = taskCategories(task);
  return selected.every((c) => cats.includes(c));
}

/** Drop picks whose category no longer exists on the board (keeps the same array when nothing changes). */
export function pruneCategories(selected: string[], available: readonly string[]): string[] {
  const kept = selected.filter((c) => available.includes(c));
  return kept.length === selected.length ? selected : kept;
}
