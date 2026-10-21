import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { certificationLabel, normalizeOption } from '../lib/certOptions';

// Don is choosing between the full agency name (stored text, default) and
// "<short code> — <detail>"; switching this one line to 'shortCode' shows the
// short code in the no-logo case when the label is consistent.
export const NO_LOGO_WORDING: 'stored' | 'shortCode' = 'stored';
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
  // Match the directory's existing span; Stats passes only the icon class and
  // uses the same inner content without adding a wrapper around the icon.
  return <>{withLogo ? <img src={logoSrc!} alt={agencyName} className="h-[20px] w-auto max-w-[80px] object-contain" /> : <ShieldCheck className={iconClassName} />}<span dir="auto" className="min-w-0 break-words">{text}</span></>;
}
