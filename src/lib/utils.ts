export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ');
}

export function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return 'Not yet';
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 30) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return `${diffDay}d ago`;
  } catch {
    return 'Recently';
  }
}

export function formatExactTime(isoString: string | null): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function getInitials(name: string): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const DAYS_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDaysOfWeek(days: number[]): string {
  if (!days || days.length === 0 || days.length === 7) return 'Every day';
  if (days.length === 5 && days.every((d) => [1, 2, 3, 4, 5].includes(d))) return 'Mon - Fri';
  if (days.length === 2 && days.every((d) => [0, 6].includes(d))) return 'Weekends';
  return days
    .slice()
    .sort()
    .map((d) => DAYS_MAP[d])
    .join(', ');
}

export function formatTaskSchedule(task: {
  scheduleType?: 'recurring' | 'specific_dates';
  daysOfWeek?: number[];
  specificDates?: string[];
}): string {
  if (task.scheduleType === 'specific_dates') {
    if (!task.specificDates || task.specificDates.length === 0) return 'No dates set';
    if (task.specificDates.length === 1) {
      const [y, m, d] = task.specificDates[0].split('-');
      if (!y || !m || !d) return task.specificDates[0];
      const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    if (task.specificDates.length <= 3) {
      return task.specificDates
        .map((ds) => {
          const [, m, d] = ds.split('-');
          return `${m}/${d}`;
        })
        .join(', ');
    }
    return `${task.specificDates.length} specific dates`;
  }
  return formatDaysOfWeek(task.daysOfWeek || [0, 1, 2, 3, 4, 5, 6]);
}
