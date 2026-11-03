export interface PickerTime { hour: number; minute: number; ampm: 'AM' | 'PM' }

export function nextFullHour(nowMinutes: number): PickerTime {
  const hour = (Math.floor(nowMinutes / 60) + 1) % 24;
  return { hour: hour % 12 || 12, minute: 0, ampm: hour < 12 ? 'AM' : 'PM' };
}
