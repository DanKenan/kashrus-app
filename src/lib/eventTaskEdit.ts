// EVENTEDIT (Don, Oct 28 2026): change an event task's wording.
// PATCH /api/events/:id/tasks/:taskId — only the fields the person changed, each
// with the wording they saw when they opened the form (baseTitle /
// baseDescription), so a change someone else saved meanwhile answers 409 instead
// of being overwritten. The server checks who may (the people who may edit an
// ordinary task at that venue) and answers the saved event. Refusals come back
// in the server's words.
import { apiWrite } from './api';
import type { KosherEvent } from '../types';

export const EVENT_TASK_TITLE_MAX = 200;
export const EVENT_TASK_DESCRIPTION_MAX = 1000;

/** ok with the saved event (or `unchanged` when nothing was edited), or not ok with a message to show by the form. */
export interface EventTaskEditResult {
  ok: boolean;
  unchanged?: boolean;
  event?: KosherEvent;
  message?: string;
}

export interface EventTaskWording {
  title: string;
  description: string;
}

export async function editEventTask(
  eventId: string,
  taskId: string,
  changes: EventTaskWording,
  base: EventTaskWording,
): Promise<EventTaskEditResult> {
  const title = changes.title.trim();
  const description = changes.description.trim();
  if (!title) return { ok: false, message: 'Give the task a name.' };
  const body: Record<string, string> = {};
  if (title !== base.title) {
    body.title = title;
    body.baseTitle = base.title;
  }
  if (description !== base.description) {
    body.description = description;
    body.baseDescription = base.description;
  }
  if (Object.keys(body).length === 0) return { ok: true, unchanged: true };
  try {
    const r = await apiWrite<{ event?: KosherEvent }>(
      `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok || !r.data?.event) return { ok: false, message: r.error || "Couldn't save the task. Please try again." };
    return { ok: true, event: r.data.event };
  } catch {
    return { ok: false, message: "Couldn't save the task. Please try again." };
  }
}
