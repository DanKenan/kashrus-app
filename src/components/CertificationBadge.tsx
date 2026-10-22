import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { readCertification } from '../lib/certOptions';

// Don (Oct 21): with no logo, show '<short code> — <detail>' (e.g. 'HKC — Glatt meat').
// Use the stored label (full name) when the agency has no short code or the stored
// label doesn't match the current agency name + detail. Display only; stored venue
// text is never rewritten.
export const NO_LOGO_WORDING: 'stored' | 'shortCode' = 'shortCode';
interface CertificationBadgeProps {
  certification: string;
  certificationDetail?: string;
  agencyName?: string;
  agencyShortCode?: string;
  logoSrc?: string | null;
  /** The agency's certification options, when the caller has them (default: the picker's built-in list). */
  certificationOptions?: readonly string[];
  iconClassName: string;
}
export function CertificationBadge({ certification, certificationDetail, agencyName, agencyShortCode, logoSrc, certificationOptions, iconClassName }: CertificationBadgeProps) {
  // Legacy stored text (e.g. the agency name twice joined by ' - ') reads like today's forms.
  const read = readCertification(certification, agencyName, certificationDetail, certificationOptions);
  const detail = read || '';
  const consistent = !!agencyName && !!detail;
  const noType = read === '';
  const withLogo = !!logoSrc && consistent;
  const text = withLogo ? detail : (NO_LOGO_WORDING as string) === 'shortCode' && consistent && agencyShortCode ? `${agencyShortCode} — ${detail}` : noType && agencyName ? agencyName : certification;
  // Don (Oct 21, 7:36 PM): with a logo and NO certification type picked (the stored
  // text is just the agency name), show only the logo: no name, no detail.
  if (logoSrc && noType && !!agencyName) {
    return <img src={logoSrc} alt={agencyName} className="h-[20px] w-auto max-w-[80px] object-contain" />;
  }
  // Match the directory's existing span; Stats passes only the icon class and
  // uses the same inner content without adding a wrapper around the icon.
  return <>{withLogo ? <img src={logoSrc!} alt={agencyName} className="h-[20px] w-auto max-w-[80px] object-contain" /> : <ShieldCheck className={iconClassName} />}<span dir="auto" className="min-w-0 break-words">{text}</span></>;
}
