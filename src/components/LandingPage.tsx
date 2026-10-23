import React from 'react';
import { ArrowLeft } from 'lucide-react';

// The public home page itself is src/components/home/HomeLanding.tsx (lazy).
// The sign-in form's "Home" link (LoginPage) goes back to it.
export const LandingBackButton: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    type="button"
    onClick={onBack}
    className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink transition cursor-pointer"
  >
    <ArrowLeft className="w-3.5 h-3.5" />
    Home
  </button>
);
