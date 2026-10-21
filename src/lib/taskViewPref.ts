/**
 * D4b: which task view (table or cards) the main Tasks screen opens on.
 *
 * Phone = narrower than 640 px (Tailwind's sm breakpoint, the same line the
 * phone layout, the sticky first column and the scroll hint use).
 * - Phones open on cards unless the person picked the table on a phone
 *   before; that pick is remembered on this device.
 * - 640–767 px keeps today's behaviour: opens on cards, nothing stored.
 * - 768 px and wider keeps today's behaviour: opens on the table.
 * A pick is stored only from the person's own tap on the cards/table switch
 * on a phone, never on load or resize.
 */
export type TaskViewMode = 'table' | 'cards';

export const PHONE_MAX_WIDTH = 640;
export const CARDS_DEFAULT_MAX_WIDTH = 768;
export const TASK_VIEW_STORAGE_KEY = 'shutfey_phone_task_view';

export function isPhoneWidth(width: number): boolean {
  return width < PHONE_MAX_WIDTH;
}

/** Pure: the view to open on, from the screen width and the stored phone pick. */
export function initialTaskView(width: number, saved: string | null | undefined): TaskViewMode {
  if (isPhoneWidth(width)) return saved === 'table' || saved === 'cards' ? saved : 'cards';
  return width < CARDS_DEFAULT_MAX_WIDTH ? 'cards' : 'table';
}

/** Reads the stored phone pick (null when none or storage is blocked). */
export function readPhoneTaskView(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(TASK_VIEW_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

/** Remembers a pick the person made on a phone; picks on wider screens are not stored. */
export function rememberPhoneTaskView(mode: TaskViewMode, width: number): void {
  if (!isPhoneWidth(width)) return;
  try {
    window.localStorage.setItem(TASK_VIEW_STORAGE_KEY, mode);
  } catch {
    /* storage blocked (private mode): the pick lasts for this visit only */
  }
}
