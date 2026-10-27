import { useEffect, useState, useSyncExternalStore } from 'react';
import { getDesktopModeState, minWidthQuery, subscribeDesktopMode } from './desktopMode';

/** True while the viewport is at least `px` wide (follows rotation and resizes).
 *  On a phone in "Desktop site" mode with the fix on, the phone's own width counts. */
export function useMinWidth(px: number): boolean {
  const dm = useSyncExternalStore(subscribeDesktopMode, getDesktopModeState, getDesktopModeState);
  const query = dm.fixed ? minWidthQuery(px) : `(min-width: ${px}px)`;
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [ok, setOk] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setOk(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return ok;
}
