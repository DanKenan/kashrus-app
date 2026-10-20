// 5b — Alerts data layer (the server calls them incidents). REST is the
// authority; payloads carry names only (no emails, no media bytes — media is
// fetched on demand). Status changes are idempotent transitions, so they
// send the latest document version and retry once on a version conflict.
import { apiFetch, apiWrite, getLastKnownVersion } from './api';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface AlertItem {
  id: string;
  agencyId?: string;
  venueId: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  status: AlertStatus;
  createdAt: string;
  linkedTaskId?: string;
  reporterName: string;
  acknowledgedAt?: string;
  acknowledgedByName?: string;
  resolvedAt?: string;
  resolvedByName?: string;
  hasPhoto: boolean;
  hasVoice: boolean;
  mine: boolean;
  /** Q4: set by GET /api/incidents only — a recipient has read my alert. */
  seenByRecipient?: boolean;
}

export interface ReceiptCount { id: string; read: number; total: number }
export interface Receipts { announcements: Record<string, ReceiptCount>; alerts: Record<string, ReceiptCount> }
export interface ReaderList {
  id: string;
  total: number;
  read: { name: string; role: string; readAt: string }[];
  notYet: { name: string; role: string }[];
}

export const ALERT_PHOTO_MAX_CHARS = 120_000;
export const ALERT_VOICE_MAX_CHARS = 90_000;
export const ALERT_TITLE_MAX = 140;
export const ALERT_DESCRIPTION_MAX = 2000;
export const ALERT_VOICE_MAX_SECONDS = 30;

export async function fetchAlerts(venueId: string, signal?: AbortSignal): Promise<AlertItem[]> {
  const res = await apiFetch(`/api/incidents?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return [];
  const d = await res.json();
  return Array.isArray(d.incidents) ? d.incidents : [];
}

export async function fetchAlertMedia(id: string, signal?: AbortSignal): Promise<{ photoData: string | null; voiceNoteData: string | null } | null> {
  const res = await apiFetch(`/api/incidents/${encodeURIComponent(id)}/media`, { signal });
  if (!res.ok) return null;
  return res.json();
}

export interface RaiseAlertInput {
  venueId: string;
  title: string;
  description: string;
  severity: AlertSeverity;
  photoData?: string;
  voiceNoteData?: string;
  /** One per compose, reused on retry: the server turns a retry into the same alert. */
  clientRef: string;
}

export interface RaiseResult { ok: boolean; alert?: AlertItem; tooLarge?: boolean; budget?: boolean; error?: string }

export async function raiseAlert(input: RaiseAlertInput): Promise<RaiseResult> {
  const result = await apiWrite('/api/incidents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (result.ok && result.data?.incident) return { ok: true, alert: result.data.incident };
  // 413 = an attachment over the cap; 503 SIZE_LIMIT = the shared record is
  // full. Either way the alert itself can still go without attachments.
  const tooLarge = result.status === 413 || (result.status === 503 && /SIZE_LIMIT/.test(String((result as any).code || result.error || '')));
  // A12: MEDIA_BUDGET = the venue's stored media is full (the file itself is within the cap).
  const budget = result.status === 413 && /MEDIA_BUDGET/.test(String((result as any).code || ''));
  return { ok: false, tooLarge, budget, error: result.error || 'Could not send the alert.' };
}

async function transition(id: string, action: 'acknowledge' | 'resolve'): Promise<{ ok: boolean; alert?: AlertItem; error?: string }> {
  const attempt = () =>
    apiWrite(`/api/incidents/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: getLastKnownVersion() }),
    });
  let r = await attempt();
  // An idempotent transition carries no form data: a version conflict only
  // means someone else wrote meanwhile. The 409 response refreshed the known
  // version (X-State-Version), so one retry is safe.
  if (!r.ok && r.status === 409) r = await attempt();
  if (r.ok && r.data?.incident) return { ok: true, alert: r.data.incident };
  return { ok: false, error: r.error || 'Could not update the alert.' };
}
export const acknowledgeAlert = (id: string) => transition(id, 'acknowledge');
export const resolveAlert = (id: string) => transition(id, 'resolve');

export async function fetchReceipts(venueId: string, signal?: AbortSignal): Promise<Receipts | null> {
  const res = await apiFetch(`/api/updates/receipts?venueId=${encodeURIComponent(venueId)}`, { signal });
  if (!res.ok) return null;
  const d = await res.json();
  const toMap = (list: any) =>
    Object.fromEntries((Array.isArray(list) ? list : []).map((x: ReceiptCount) => [x.id, x]));
  return { announcements: toMap(d.announcements), alerts: toMap(d.alerts) };
}

export async function fetchReaders(kind: 'announcement' | 'alert', id: string, venueId: string, signal?: AbortSignal): Promise<ReaderList | null> {
  const res = await apiFetch(
    `/api/updates/receipts/${kind}/${encodeURIComponent(id)}?venueId=${encodeURIComponent(venueId)}`,
    { signal },
  );
  if (!res.ok) return null;
  return res.json();
}

export async function fetchAlertMute(signal?: AbortSignal): Promise<string | null | undefined> {
  const res = await apiFetch('/api/updates/alert-mute', { signal });
  if (!res.ok) return undefined;
  return (await res.json()).mutedUntil ?? null;
}

export async function setAlertMute(minutes: number): Promise<string | null | undefined> {
  const res = await apiFetch('/api/updates/alert-mute', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  });
  if (!res.ok) return undefined;
  return (await res.json()).mutedUntil ?? null;
}

/** Minutes from now until the next 7:00 local (the "until morning" mute), capped at 24 h. */
export function minutesUntilMorning(now = new Date()): number {
  const t = new Date(now);
  t.setHours(7, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.min(24 * 60, Math.max(1, Math.round((t.getTime() - now.getTime()) / 60000)));
}

/** Mirrors the server (rule BC): acknowledge = admin, or a coordinator of this venue. */
export function alertCanAcknowledge(a: AlertItem, role: string, viewerVenueIds: string[]): boolean {
  if (a.status !== 'open') return false;
  if (role === 'admin') return true;
  return role === 'coordinator' && viewerVenueIds.includes(a.venueId);
}

/** Mirrors the server: resolve = admin, this venue's coordinator, or on-site
 * mashgiach/worker who can fill tasks. */
export function alertCanResolve(a: AlertItem, role: string, viewerVenueIds: string[], canFillTasks: boolean): boolean {
  if (a.status === 'resolved') return false;
  if (role === 'admin') return true;
  if (!viewerVenueIds.includes(a.venueId)) return false;
  if (role === 'coordinator') return true;
  return (role === 'mashgiach' || role === 'worker') && canFillTasks;
}
