import type { Shift } from '../types';
import { shiftOccurrenceDay, shiftPeopleOn } from './shifts';
import { shiftAssigneeLabel } from './shiftTaskDay';

type Person = { id?: string; email?: string; name: string };
export interface WhoSeesContext {
  viewer?: { id?: string; email?: string } | null;
  mode: 'editor' | 'own' | 'kiosk';
  shiftsById: ReadonlyMap<string, Shift>;
  roster: ReadonlyArray<Person>;
  todayYmd: string | null;
  todayWeekday: number | null;
  nowMinutes: number | null;
}
export function whoSeesLabel(task: { venueId?: string; shiftId?: string | null; assignedTo?: string[]; isPrivate?: boolean }, ctx: WhoSeesContext): { text: string; icon: 'shift' | 'everyone' | 'person' | 'private'; title?: string } {
  const candidate = task.shiftId ? ctx.shiftsById.get(task.shiftId) : undefined;
  const shift = candidate && (!task.venueId || candidate.venueId === task.venueId) ? candidate : undefined;
  if (task.shiftId && !shift && ctx.mode !== 'own') return { text: 'Shift (removed)', icon: 'shift' };
  if (shift) {
    const name = shift.name;
    const occurrence = ctx.todayYmd !== null && ctx.todayWeekday !== null && ctx.nowMinutes !== null
      ? shiftOccurrenceDay(shift, ctx.todayYmd, ctx.todayWeekday, ctx.nowMinutes) : null;
    const onShift = !!occurrence && !!ctx.viewer?.id && shiftPeopleOn(shift, occurrence).includes(ctx.viewer.id);
    const label = shift ? shiftAssigneeLabel(shift, ctx.mode === 'editor', ctx.todayYmd, ctx.todayWeekday, ctx.nowMinutes, ctx.roster) : `${name} shift`;
    const today = label.indexOf(' · today:');
    return { text: ctx.mode === 'own' && onShift ? `Because you're on ${name}` : `${name} shift${today >= 0 ? label.slice(today) : ''}`, icon: 'shift' };
  }
  const assigned = (task.assignedTo || []).map((s) => s.trim()).filter(Boolean);
  if (!assigned.length || assigned.some((s) => s.toLowerCase() === 'all')) return { text: ctx.mode === 'own' ? 'For everyone' : 'Everyone', icon: 'everyone' };
  const names = assigned.map((email) => {
    const name = ctx.roster.find((p) => p.email?.trim().toLowerCase() === email.toLowerCase())?.name;
    return (name || email).split('@')[0];
  });
  const people = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  const me = ctx.viewer?.email?.trim().toLowerCase();
  const text = ctx.mode === 'own' && assigned.some((s) => s.toLowerCase() === me) ? 'Assigned to you'
    : ctx.mode === 'kiosk' ? people : task.isPrivate ? `Only ${people}` : `Assigned to ${people}`;
  return { text, icon: task.isPrivate ? 'private' : 'person', ...(task.isPrivate ? { title: 'Private: only them, admins and coordinators' } : {}) };
}
