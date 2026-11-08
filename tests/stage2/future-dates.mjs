// Anchor real-clock-created tasks safely before the test's first occurrence.
// Calendar arithmetic uses the venue zone; UTC offsets may change across DST.
export function futureWeekday(timeZone, weekday) {
  const parts = (date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const now = parts(new Date());
  const anchor = new Date(`${now.year}-${now.month}-${now.day}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + 3);
  anchor.setUTCDate(anchor.getUTCDate() + (weekday - anchor.getUTCDay() + 7) % 7);
  const date = (days = 0) => new Date(anchor.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const at = (days, time) => {
    const wall = Date.parse(`${date(days)}T${time}Z`);
    let instant = wall;
    for (let i = 0; i < 3; i++) {
      const p = parts(new Date(instant));
      const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      instant += wall - local;
    }
    return new Date(instant).toISOString();
  };
  return { date, at };
}
