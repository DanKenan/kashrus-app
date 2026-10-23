import React, { useEffect, useRef } from 'react';
import { UpdateAppButton } from '../UpdateAppButton';
import markup from './home.html?raw';
import './home.css';
import { runHomeDemos } from './homeDemos';

/**
 * The public home page on the shared Shutfey address (approved v2 design,
 * shutfey-v2.sites.tab.bot). Loaded lazily (its own JS + CSS file) and only
 * for a signed-out visitor who is not on a kiosk tablet, an agency's own
 * address or the installed app — see showHomeLanding in lib/homeRoute.ts.
 *
 * The markup is a static, repo-owned string (no user data). Its CSS is scoped
 * under .shf-home; the demos run only inside this element and stop when it
 * unmounts.
 */
interface HomeLandingProps {
  /** "Sign in" in the top bar: today's sign-in screen. */
  onSignIn: () => void;
}

export function enterKioskSetup(): void {
  // Same as the previous home screen's "Set up this device as a venue kiosk".
  try {
    localStorage.setItem('kiosk_mode', '1');
  } catch {
    // ignore
  }
  window.location.href = `${window.location.pathname}?kiosk=1`;
}

const HomeLanding: React.FC<HomeLandingProps> = ({ onSignIn }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const signInRef = useRef(onSignIn);
  signInRef.current = onSignIn;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    document.body.classList.add('shf-home-on');
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stopDemos = runHomeDemos(root, reduce);
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const link = target?.closest?.('a');
      if (!link || !root.contains(link)) return;
      if (link.hasAttribute('data-signin')) {
        event.preventDefault();
        signInRef.current();
        return;
      }
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#')) {
        // In-page links scroll; the address bar stays "/".
        event.preventDefault();
        const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth';
        if (href === '#top') {
          window.scrollTo({ top: 0, behavior });
          return;
        }
        const dest = root.querySelector<HTMLElement>(href);
        if (dest) {
          dest.scrollIntoView({ behavior, block: 'start' });
          if (link.classList.contains('skip')) {
            dest.setAttribute('tabindex', '-1');
            dest.focus({ preventScroll: true });
          }
        }
      }
    };
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('click', onClick);
      stopDemos();
      document.body.classList.remove('shf-home-on');
    };
  }, []);

  return (
    <div ref={rootRef} className="shf-home" data-home-landing>
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <div className="shf-home-tools">
        <button type="button" className="shf-home-kiosk" onClick={enterKioskSetup}>
          Set up this device as a venue kiosk →
        </button>
        <div className="shf-home-update">
          <UpdateAppButton />
        </div>
      </div>
    </div>
  );
};

export default HomeLanding;
