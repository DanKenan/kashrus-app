export const ANY_TIME_LABEL = 'Any time';

export function isAnyTimeText(text: unknown): boolean {
  return typeof text === 'string' && text.trim().toLowerCase() === 'any time';
}

export function isAnyTimeTask(task: { targetTime?: unknown } | null | undefined): boolean {
  return isAnyTimeText(task?.targetTime);
}

export function normalizeAnyTimeTask<T extends object>(task: T): T {
  if (!isAnyTimeTask(task)) return task;
  return {
    ...task,
    targetTime: ANY_TIME_LABEL,
    targetTimeMinutes: undefined,
    targetTime2: undefined,
    targetTime2Minutes: undefined,
    enableOverdueAlert: false,
  };
}
