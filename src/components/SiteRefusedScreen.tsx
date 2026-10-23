// Domains PR B (client, plan 2g/2h): the agency's own sign-in brand, and the
// "not on this address" screens (WRONG_SITE / SITE_NOT_SET_UP).
import React, { useState } from 'react';
import { ExternalLink, ArrowLeft } from 'lucide-react';
import { ShutfeyLogo } from './ShutfeyLogo';
import { SITE_TEXT, siteDisplayName, useSiteLogo, type SiteAgency, type SiteRefusalCode } from '../lib/site';

/** The agency's logo (from its settings), or its name in large text when it has none. */
export function SiteBrand({ agency, size = 'lg' }: { agency: SiteAgency; size?: 'md' | 'lg' }) {
  const src = useSiteLogo(agency.logoRev);
  const [failed, setFailed] = useState<string | null>(null);
  const name = siteDisplayName(agency);
  if (src && failed !== src) {
    return <img data-site-logo src={src} alt={name} onError={() => setFailed(src)}
      className={`${size === 'lg' ? 'max-h-28' : 'max-h-16'} max-w-[85%] w-auto object-contain mx-auto`} />;
  }
  return <p data-site-name className={`${size === 'lg' ? 'text-3xl sm:text-4xl' : 'text-2xl'} font-black tracking-tight text-ink break-words leading-tight`}>{name}</p>;
}

/** The site agency's logo as shown (null = none, not loaded yet, or it failed to draw). */
export function useSiteBrandLogo(agency: SiteAgency | null | undefined): { logo: string | null; onLogoError: () => void } {
  const src = useSiteLogo(agency?.logoRev ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const logo = agency && src && failed !== src ? src : null;
  return { logo, onLogoError: () => setFailed(logo) };
}

/**
 * The top of the invite page on an agency's own address: its logo, or, with
 * no logo, its name in large text; then the small "Powered by Shutfey".
 */
export function SiteInviteHeader({ agency, logo, onLogoError }: { agency: SiteAgency; logo: string | null; onLogoError: () => void }) {
  const name = siteDisplayName(agency);
  return (
    <div data-site-brand className="text-center mb-5">
      {logo ? (
        <div className="flex justify-center mb-2">
          <img data-site-logo src={logo} alt={name} onError={onLogoError} className="max-h-28 max-w-[85%] w-auto object-contain mx-auto" />
        </div>
      ) : (
        <p data-site-name className="text-3xl sm:text-4xl font-black tracking-tight text-ink break-words leading-tight">{name}</p>
      )}
      <div className="mt-1"><PoweredByShutfey /></div>
    </div>
  );
}

/** True when the invite's agency is the site agency (so its name is already shown large above). */
export function inviteAgencyIsSite(inviteAgencyName: string | null | undefined, agency: SiteAgency): boolean {
  const n = (x: string | null | undefined) => (x || '').trim().toLowerCase();
  const a = n(inviteAgencyName);
  return !!a && (a === n(agency.name) || a === n(agency.brandName));
}

/**
 * The top of the agency's own sign-in page: its logo + "<name> sign-in", or,
 * with no logo, the name in large text + "Sign in" (the name is not said twice).
 */
export function SiteSignInHeader({ agency }: { agency: SiteAgency }) {
  const src = useSiteLogo(agency.logoRev);
  const [failed, setFailed] = useState<string | null>(null);
  const name = siteDisplayName(agency);
  const logo = src && failed !== src ? src : null;
  return (
    <div data-site-brand className="text-center mb-6">
      {logo ? (
        <>
          <div className="flex justify-center mb-4">
            <img data-site-logo src={logo} alt={name} onError={() => setFailed(logo)} className="max-h-28 max-w-[85%] w-auto object-contain mx-auto" />
          </div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-ink">{SITE_TEXT.signIn(name)}</h1>
        </>
      ) : (
        <>
          <h1 data-site-name className="text-3xl sm:text-4xl font-black tracking-tight text-ink break-words leading-tight">{name}</h1>
          <p className="mt-2 text-lg font-bold text-ink-soft">{SITE_TEXT.signInPlain}</p>
        </>
      )}
      <div className="mt-1"><PoweredByShutfey /></div>
    </div>
  );
}

export function PoweredByShutfey() {
  return <p data-powered-by className="text-xs text-ink-faint">{SITE_TEXT.poweredBy}</p>;
}

interface SiteRefusedScreenProps {
  code: SiteRefusalCode;
  /** The agency of THIS address (from /api/site), when the server named one. */
  agency: SiteAgency | null;
  /** The Shutfey address, from the server only. */
  sharedOrigin: string | null;
  /** WRONG_SITE only: back to this address's sign-in (someone who picked the wrong account). */
  onBack?: () => void;
}

export function SiteRefusedScreen({ code, agency, sharedOrigin, onBack }: SiteRefusedScreenProps) {
  const wrong = code === 'WRONG_SITE';
  const title = wrong ? SITE_TEXT.wrongSiteTitle(agency ? siteDisplayName(agency) : null) : SITE_TEXT.notSetUpTitle;
  const body = wrong ? SITE_TEXT.wrongSiteBody : SITE_TEXT.notSetUpBody;
  return (
    <div data-site-refused={code} className="min-h-screen bg-paper text-ink flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-md bg-surface rounded-3xl p-6 sm:p-8 tactile-5 border border-line text-center">
        <div className="mb-5 flex justify-center">
          {agency ? <SiteBrand agency={agency} size="md" /> : <ShutfeyLogo size="lg" showSubtitle={false} />}
        </div>
        <h1 className="text-xl font-black tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-base text-ink-soft">{body}</p>
        {sharedOrigin ? (
          <a data-go-shared href={sharedOrigin + '/'} rel="noopener"
            className="pressable mt-6 min-h-12 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper focus:outline-none focus:ring-2 focus:ring-gold/40">
            <span>{SITE_TEXT.goShared}</span>
            <ExternalLink className="w-4 h-4" />
          </a>
        ) : (
          <p className="mt-6 text-sm text-ink-soft">{SITE_TEXT.noLink}</p>
        )}
        {wrong && onBack && (
          <button type="button" data-site-back onClick={onBack}
            className="pressable mt-3 min-h-11 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-line-control bg-surface px-4 text-sm font-semibold text-ink hover:bg-sunken">
            <ArrowLeft className="w-4 h-4" />
            <span>{SITE_TEXT.backToSignIn}</span>
          </button>
        )}
        {agency && <div className="mt-6"><PoweredByShutfey /></div>}
      </div>
    </div>
  );
}
