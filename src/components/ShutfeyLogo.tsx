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
  // Heights are the box sizes the component has always used; the mark is 1.28:1,
  // so the width follows the height (width = height x 1.28).
  const iconSizes = {
    sm: 'h-7 sm:h-8',
    md: 'h-8 sm:h-9',
    lg: 'h-10 sm:h-12',
    xl: 'h-14 sm:h-16',
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
      {/* Shutfey brand mark — Don's drawing (Oct 14, 2026): three partners above the pot,
          with the check. Traced to SVG and recoloured in D2 (V3: ink / gold-deep / gold;
          night: cream / gold-deep / gold). The day and night files swap on the .dark class,
          so every call site works unchanged. No tile and no ring: the SVG has no background. */}
      <div className="shrink-0">
        <img
          src="/brand/shutfey-mark.svg"
          alt="Shutfey"
          draggable={false}
          className={`${iconSizes[size]} w-auto dark:hidden`}
        />
        <img
          src="/brand/shutfey-mark-night.svg"
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`${iconSizes[size]} w-auto hidden dark:block`}
        />
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
