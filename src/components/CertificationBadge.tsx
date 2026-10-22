import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { certificationLabel, normalizeOption } from '../lib/certOptions';

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
  iconClassName: string;
}
export function CertificationBadge({ certification, certificationDetail, agencyName, agencyShortCode, logoSrc, iconClassName }: CertificationBadgeProps) {
  const prefix = `${agencyName} — `;
  const detail = normalizeOption(certificationDetail?.trim() ? certificationDetail : agencyName && certification.startsWith(prefix) ? certification.slice(prefix.length) : '');
  const consistent = !!agencyName && !!detail && certification === certificationLabel(agencyName, detail);
  const withLogo = !!logoSrc && consistent;
  const text = withLogo ? detail : (NO_LOGO_WORDING as string) === 'shortCode' && consistent && agencyShortCode ? `${agencyShortCode} — ${detail}` : certification;
  // Don (Oct 21, 7:36 PM): with a logo and NO certification type picked (the stored
  // text is just the agency name), show only the logo: no name, no detail.
  if (logoSrc && !detail && !!agencyName && certification === certificationLabel(agencyName, '')) {
    return <img src={logoSrc} alt={agencyName} className="h-[20px] w-auto max-w-[80px] object-contain" />;
  }
  // Match the directory's existing span; Stats passes only the icon class and
  // uses the same inner content without adding a wrapper around the icon.
  return <>{withLogo ? <img src={logoSrc!} alt={agencyName} className="h-[20px] w-auto max-w-[80px] object-contain" /> : <ShieldCheck className={iconClassName} />}<span dir="auto" className="min-w-0 break-words">{text}</span></>;
}
