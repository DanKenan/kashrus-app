// QA2 #31 (batch C): "Notify again" — POST /api/events/:id/notify sends the
// assignment push to the event's current assignee only. Nothing is written.
import { apiFetch } from './api';

export const NOTIFY_FALLBACK_TEXT = "Couldn't notify them. Please try again.";
export const NOTIFY_OFFLINE_TEXT = "Couldn't connect. Please try again.";
export const NOTIFY_NO_DEVICE_TEXT = 'They have no phone with notifications on.';

export interface NotifyResult { ok: boolean; message: string }

export async function notifyEventAssignee(eventId: string, name?: string | null): Promise<NotifyResult> {
  let res: Response;
  try {
    res = await apiFetch(`/api/events/${encodeURIComponent(eventId)}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    return { ok: false, message: NOTIFY_OFFLINE_TEXT };
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok) {
    const attempted = typeof data?.attempted === 'number' ? data.attempted : typeof data?.sent === 'number' ? data.sent : null;
    if (attempted === 0) return { ok: true, message: NOTIFY_NO_DEVICE_TEXT };
    const who = (name || '').trim();
    return { ok: true, message: who ? `Sent to ${who} again.` : 'Sent again.' };
  }
  const words = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : '';
  return { ok: false, message: words || NOTIFY_FALLBACK_TEXT };
}
