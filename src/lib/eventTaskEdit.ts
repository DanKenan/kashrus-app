// EVENTEDIT (Don, Oct 28 2026): change an event task's wording.
// PATCH /api/events/:id/tasks/:taskId { title, description } — the server checks
// who may (the people who may edit an ordinary task at that venue) and answers
// the saved event. Refusals come back in the server's words.
import { apiWrite } from './api';
import type { KosherEvent } from '../types';

export const EVENT_TASK_TITLE_MAX = 200;
export const EVENT_TASK_DESCRIPTION_MAX = 1000;

/** ok with the saved event, or not ok with a message to show by the form. */
export interface EventTaskEditResult {
  ok: boolean;
  event?: KosherEvent;
  message?: string;
}

export async function editEventTask(
  eventId: string,
  taskId: string,
  changes: { title: string; description: string },
): Promise<EventTaskEditResult> {
  const title = changes.title.trim();
  if (!title) return { ok: false, message: 'Give the task a name.' };
  try {
    const r = await apiWrite<{ event?: KosherEvent }>(
      `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: changes.description.trim() }),
      },
    );
    if (!r.ok || !r.data?.event) return { ok: false, message: r.error || "Couldn't save the task. Please try again." };
    return { ok: true, event: r.data.event };
  } catch {
    return { ok: false, message: "Couldn't save the task. Please try again." };
  }
}
