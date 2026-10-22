import type { Task, User } from '../types';

/**
 * QA2 #29: one tap on a signed task used to remove someone else's sign-off
 * with no question. Undoing a sign-off now asks first when it was signed by
 * somebody else ("Undo Rivka Admin's sign-off?"). Undoing your own stays one
 * tap. Returns the signer's name when a confirm is needed, else null.
 */
export function signoffUndoBy(task: Task | undefined, me: User | null, nextCompleted: boolean): string | null {
  if (!task || !task.isCompleted || nextCompleted) return null;
  const byEmail = (task.updatedByEmail || '').trim().toLowerCase();
  const byName = (task.updatedByName || '').trim();
  if (!byEmail && !byName) return null;
  const myEmail = (me?.email || '').trim().toLowerCase();
  if (byEmail && myEmail && byEmail === myEmail) return null;
  if (!byEmail && byName && me?.name && byName === me.name.trim()) return null;
  return byName || 'someone else';
}

export const signoffUndoTitle = (who: string) => (who === 'someone else' ? "Undo someone else's sign-off?" : `Undo ${who}'s sign-off?`);
export const SIGNOFF_UNDO_TEXT = 'The task goes back to not done, and their name and time come off it.';
