import React from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showSubtitle?: boolean;
  className?: string;
  lightMode?: boolean;
  agencyName?: string;
  agencyShortCode?: string;
}

export const ShutfeyLogo: React.FC<LogoProps> = ({
  size = 'md',
  showSubtitle = true,
  className = '',
  agencyName,
  agencyShortCode,
}) => {
  const iconSizes = {
    sm: 'w-7 h-7 sm:w-8 sm:h-8',
    md: 'w-8 h-8 sm:w-9 sm:h-9',
    lg: 'w-10 h-10 sm:w-12 sm:h-12',
    xl: 'w-14 h-14 sm:w-16 sm:h-16',
  };

  const titleSizes = {
    sm: 'text-xs sm:text-sm font-extrabold',
    md: 'text-sm sm:text-base font-extrabold tracking-tight',
    lg: 'text-lg sm:text-xl font-black tracking-tight',
    xl: 'text-xl sm:text-2xl md:text-3xl font-black tracking-tight',
  };

  const subSizes = {
    sm: 'text-[9px]',
    md: 'text-[10px]',
    lg: 'text-xs',
    xl: 'text-xs sm:text-sm',
  };

  return (
    <div className={`flex items-center gap-2 sm:gap-2.5 min-w-0 ${className}`}>
      {/* Shutfey brand mark */}
      <div className="shrink-0 text-ink">
        {/* D2 master mark (direction B): ink ring opened at the top, gold check breaking out.
            Master paths identical to public/brand/shutfey-mark.svg; currentColor = ink token
            (cream at night), var(--gold) flips with .dark — one drawing serves both themes. */}
        <svg viewBox="0 0 100 100" className={iconSizes[size]} role="img" aria-label="Shutfey">
          <path d="M80.68,42.63 A34,34 0 1 1 53.90,18.52" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
          <path d="M31,54 L45,69 L84,28" fill="none" stroke="var(--gold)" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Brand wordmark */}
      <div className="flex flex-col justify-center min-w-0 overflow-hidden">
        <div className="flex items-center gap-1 sm:gap-1.5 flex-nowrap">
          <span className={`${titleSizes[size]} text-ink leading-tight font-sans whitespace-nowrap`}>
            Shutfey
          </span>
          <span className={`${titleSizes[size]} text-gold leading-tight font-sans whitespace-nowrap ${size === 'sm' ? 'hidden xl:inline' : ''}`} aria-hidden="true">·</span>
          <span dir="rtl" className={`${titleSizes[size]} text-ink leading-tight font-hebrew whitespace-nowrap ${size === 'sm' ? 'hidden xl:inline' : ''}`}>
            שותפי
          </span>
          {agencyShortCode ? (
            <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-gold-wash text-gold-ink border border-gold/40 shrink-0">
              {agencyShortCode}
            </span>
          ) : (
            <span className="hidden xs:inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded bg-gold-wash text-gold-ink border border-gold/40 shrink-0">
              PRO
            </span>
          )}
        </div>
        {showSubtitle && (
          <p className={`${subSizes[size]} font-medium text-ink-soft truncate leading-tight mt-0.5 ${size === 'sm' ? 'hidden sm:block' : ''}`}>
            {agencyName ? agencyName : 'Compliance & Shift Operations'}
          </p>
        )}
      </div>
    </div>
  );
};
