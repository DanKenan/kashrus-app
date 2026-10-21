import React, { useEffect, useState } from 'react';
import { hebrewDateFor } from '../lib/hebrewDate';
import { zoneCityLabel } from '../lib/workday';

export function HeaderDateLine({ timeZone, className = '' }: { timeZone: string; className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      setNow(current);
      clearTimeout(timer);
      timer = setTimeout(tick, 60000 - current.getTime() % 60000 + 50);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, []);

  const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone,
    ...(Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone ? { timeZoneName: 'short' as const } : {}),
  });
  const h = hebrewDateFor(now, timeZone);
  const hint = h.basis === 'midnight'
    ? `Hebrew date, changes at midnight (${zoneCityLabel(timeZone)}; no location for sunset)`
    : `Hebrew date, changes at sunset (approximate, ${zoneCityLabel(timeZone)})`;

  return (
    <div data-header-date-line className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0 text-[0.6875rem] leading-[1.35] text-ink-faint ${className}`}>
      <span className="font-semibold"><span className="whitespace-nowrap">{date}</span> · <span className="whitespace-nowrap">{time}</span></span>
      {h.text && <span dir="rtl" lang="he" className="font-hebrew whitespace-nowrap text-[0.75rem] text-ink-soft" title={hint} aria-label={`${hint}: ${h.text}`}>
        <span className="sm:hidden">{h.textShort}</span><span className="hidden sm:inline">{h.text}</span>
      </span>}
    </div>
  );
}
