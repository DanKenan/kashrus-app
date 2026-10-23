import { SITE_TEXT, phoneLinks, siteDisplayName, welcomeShortName, type SiteAgency } from '../../lib/site';

/**
 * Puts the agency's own words into the welcome page's empty data-w-* slots:
 * textContent and attributes only (never markup). Called before the demos
 * snapshot their markup, so every demo reset keeps the agency's text.
 */
export function fillWelcome(root: HTMLElement, agency: SiteAgency, host: string): void {
  const name = siteDisplayName(agency);
  const short = welcomeShortName(agency);
  const phone = phoneLinks(agency.contactPhone);
  const set = (sel: string, text: string) => root.querySelectorAll<HTMLElement>(sel).forEach((el) => { el.textContent = text; });
  set('[data-w-name]', name);
  set('[data-w-short]', short);
  set('[data-w-signin]', SITE_TEXT.signIn(name));
  set('[data-w-host]', host);
  root.querySelectorAll<HTMLElement>('[data-w-toplabel]').forEach((el) => el.setAttribute('aria-label', `${name}, top`));
  root.querySelectorAll<HTMLElement>('[data-w-if-phone]').forEach((el) => { el.hidden = !phone; });
  root.querySelectorAll<HTMLElement>('[data-w-if-nophone]').forEach((el) => { el.hidden = !!phone; });
  if (phone) {
    root.querySelectorAll<HTMLAnchorElement>('a[data-w-tel]').forEach((a) => { a.setAttribute('href', phone.tel); a.textContent = `Call ${phone.display}`; });
    root.querySelectorAll<HTMLAnchorElement>('a[data-w-sms]').forEach((a) => a.setAttribute('href', phone.sms));
  }
  // The big logo at the top speaks for the page; the other copies are decoration.
  root.querySelectorAll<HTMLElement>('[data-w-logo]').forEach((el) => {
    if (el.classList.contains('big-seal')) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', `${name} logo`); }
    else el.setAttribute('aria-hidden', 'true');
  });
}
