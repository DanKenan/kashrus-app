import React, { useEffect, useLayoutEffect, useRef } from 'react';
import markup from './welcome.html?raw';
import '../home/home.css';
import './welcome.css';
import { runHomeDemos } from '../home/homeDemos';
import { WELCOME_SCRIPTS } from './welcomeDemos';
import { useSiteLogo, type SiteAgency } from '../../lib/site';
import { fillWelcome } from './welcomeFill';

/**
 * The welcome page on an agency's own address (the approved
 * preview, Oct 23), for that agency's team: how to sign in, add
 * Face ID, see tasks, Sign & Complete, read updates, add to home screen, use
 * the venue tablet, and whom to call. General for every agency: its name,
 * short name, logo and phone come from /api/site (agency settings), never
 * from code. Loaded lazily, only for a signed-out visitor in a normal
 * browser on an agency address (App.tsx).
 *
 * The markup is a static repo-owned string; agency values go in with
 * textContent / attributes only. Text is filled before the demos start, so
 * every demo reset (which restores the snapshot) keeps it. The logo is a CSS
 * background (--w-logo, a validated data: URL from loadSiteLogo), so it
 * survives resets and may arrive late.
 */
interface AgencyWelcomeProps {
  agency: SiteAgency;
  /** "Sign in" buttons: today's branded sign-in. */
  onSignIn: () => void;
}

const AgencyWelcome: React.FC<AgencyWelcomeProps> = ({ agency, onSignIn }) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const signInRef = useRef(onSignIn);
  signInRef.current = onSignIn;
  const logo = useSiteLogo(agency.logoRev);

  // Agency text first (layout effect: before paint and before the demos snapshot).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root) fillWelcome(root, agency, typeof window !== 'undefined' ? window.location.hostname : '');
  }, [agency]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!logo) {
      root.classList.remove('w-has-logo');
      root.style.removeProperty('--w-logo');
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      root.style.setProperty('--w-logo-ar', String(Math.min(4, Math.max(0.25, ar))));
      // loadSiteLogo only returns data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=] (no quotes possible).
      root.style.setProperty('--w-logo', `url("${logo}")`);
      root.classList.add('w-has-logo');
    };
    img.onerror = () => { if (live) root.classList.remove('w-has-logo'); };
    img.src = logo;
    return () => { live = false; };
  }, [logo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    document.body.classList.add('shf-home-on');
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stopDemos = runHomeDemos(root, reduce, WELCOME_SCRIPTS);
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
    <div ref={rootRef} className="shf-home shf-welc" data-agency-welcome>
      <div dangerouslySetInnerHTML={{ __html: markup }} />
    </div>
  );
};

export default AgencyWelcome;
