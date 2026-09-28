import React from 'react';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showSubtitle?: boolean;
  className?: string;
  lightMode?: boolean;
  agencyName?: string;
  agencyShortCode?: string;
}

export const KeepingKosherLogo: React.FC<LogoProps> = ({
  size = 'md',
  showSubtitle = true,
  className = '',
  agencyName,
  agencyShortCode,
}) => {
  const iconSizes = {
    sm: 'w-7 h-7 sm:w-8 sm:h-8 rounded-xl',
    md: 'w-8 h-8 sm:w-9 sm:h-9 rounded-2xl',
    lg: 'w-10 h-10 sm:w-12 sm:h-12 rounded-2xl',
    xl: 'w-14 h-14 sm:w-16 sm:h-16 rounded-2xl',
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
      {/* Brand Emblem Shield */}
      <div
        className={`${iconSizes[size]} shrink-0 bg-gradient-to-br from-blue-700 via-indigo-700 to-slate-900 flex items-center justify-center shadow-md shadow-blue-900/20 ring-2 ring-blue-500/20 text-white relative overflow-hidden`}
      >
        <svg
          viewBox="0 0 40 40"
          className="w-full h-full p-1"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Shield Outline */}
          <path
            d="M20 4L7 9V18C7 26.5 12.5 34.5 20 37C27.5 34.5 33 26.5 33 18V9L20 4Z"
            fill="url(#shieldGrad)"
            stroke="#93c5fd"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          {/* Inner Circle */}
          <circle cx="20" cy="19" r="9" stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="2 1.5" />
          {/* Letter K */}
          <path
            d="M16.5 13.5V24.5M16.5 19H18.5L23 13.5M18 19L23.5 24.5"
            stroke="#ffffff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <defs>
            <linearGradient id="shieldGrad" x1="7" y1="4" x2="33" y2="37" gradientUnits="userSpaceOnUse">
              <stop stopColor="#1e3a8a" />
              <stop offset="1" stopColor="#0f172a" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* Brand Typographic Identity */}
      <div className="flex flex-col justify-center min-w-0 overflow-hidden">
        <div className="flex items-center gap-1 sm:gap-1.5 flex-nowrap">
          <span className={`${titleSizes[size]} text-slate-900 dark:text-white leading-tight font-sans whitespace-nowrap`}>
            Keeping<span className="text-blue-600 dark:text-blue-400">Kosher</span>
          </span>
          {agencyShortCode ? (
            <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border border-blue-300/60 dark:border-blue-700/50 shrink-0">
              {agencyShortCode}
            </span>
          ) : (
            <span className="hidden xs:inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-300/60 dark:border-amber-700/50 shrink-0">
              PRO
            </span>
          )}
        </div>
        {showSubtitle && (
          <p className={`${subSizes[size]} font-medium text-slate-500 dark:text-slate-400 truncate leading-tight mt-0.5 ${size === 'sm' ? 'hidden sm:block' : ''}`}>
            {agencyName ? agencyName : 'Compliance & Shift Operations'}
          </p>
        )}
      </div>
    </div>
  );
};
