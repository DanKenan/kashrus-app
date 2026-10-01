import React from 'react';
import {
  ClipboardCheck,
  Factory,
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  Sun,
  Moon,
  LogIn,
  Building2,
} from 'lucide-react';
import { KeepingKosherLogo } from './KeepingKosherLogo';
import { PWAInstallButton } from './PWAInstallButton';
import { User as UserType } from '../types';

interface LandingPageProps {
  /** Persisted session from a previous visit (shown as "Welcome back"). Null when none. */
  savedUser: UserType | null;
  onContinueAs: () => void;
  onUseDifferentAccount: () => void;
  onSignIn: () => void;
  onRegister: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

const FEATURES = [
  {
    icon: ClipboardCheck,
    title: 'Daily Shift Roster',
    body: 'Opening and locking procedures, checklists, and mashgiach sign-offs — one board per venue.',
  },
  {
    icon: Factory,
    title: 'Factory Audit Hub',
    body: 'Approved-ingredient matrix, floor discrepancy log, and official kashrut audit reports.',
  },
  {
    icon: ShieldCheck,
    title: 'Multi-Agency Isolation',
    body: 'Each agency and venue operates in its own isolated environment with role-based access.',
  },
];

export const LandingPage: React.FC<LandingPageProps> = ({
  savedUser,
  onContinueAs,
  onUseDifferentAccount,
  onSignIn,
  onRegister,
  darkMode,
  onToggleDarkMode,
}) => {
  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col transition-colors relative overflow-hidden">
      {/* Warm ambience */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[380px] bg-gold/10 blur-3xl pointer-events-none rounded-full" />
      <div className="absolute bottom-0 right-0 w-[420px] h-[320px] bg-emerald-500/10 blur-2xl pointer-events-none rounded-full" />

      {/* Top bar */}
      <header className="relative z-10 w-full px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between max-w-6xl mx-auto">
        <KeepingKosherLogo size="sm" showSubtitle={true} />
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface/80 border border-line text-[11px] font-medium text-ink-soft backdrop-blur-sm">
            <ShieldCheck className="w-3.5 h-3.5 text-gold-deep" />
            <span>Multi-Agency Kashrut Network</span>
          </div>
          <PWAInstallButton />
          <button
            type="button"
            onClick={onToggleDarkMode}
            className="p-2 sm:p-2.5 rounded-xl bg-surface border border-line text-ink-soft hover:text-ink tactile-1 transition cursor-pointer"
            aria-label="Toggle dark mode"
          >
            {darkMode ? <Sun className="w-4 h-4 text-gold" /> : <Moon className="w-4 h-4 text-ink-soft" />}
          </button>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-10 sm:py-14 w-full max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-center max-w-2xl">
          <h1 className="sr-only">KeepingKosher — Kosher operations platform</h1>
          <KeepingKosherLogo size="xl" showSubtitle={false} />
          <p className="mt-6 text-sm sm:text-base text-ink-soft leading-relaxed">
            The daily operations board for kosher agencies, mashgichim, and venues —
            shift rosters, compliance checklists, and factory audits in one warm, tactile workspace.
          </p>
        </div>

        {/* Session / auth cards */}
        <div className="mt-8 w-full max-w-2xl">
          {savedUser ? (
            <div className="bg-surface border border-line tactile-3 rounded-[28px] p-6 sm:p-8 animate-fade-in">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center text-xl font-bold tactile-2 shrink-0">
                  {(savedUser.name || savedUser.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Welcome back</p>
                  <p className="text-lg font-bold text-ink truncate">{savedUser.name || savedUser.email}</p>
                  <p className="text-xs text-ink-faint truncate">{savedUser.agencyName || 'KeepingKosher'}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onContinueAs}
                className="mt-6 w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white font-bold text-sm tactile-2 hover:brightness-105 active:scale-[.99] transition cursor-pointer"
              >
                Continue to Dashboard
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={onUseDifferentAccount}
                className="mt-3 w-full inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-2xl text-xs font-semibold text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5" />
                Use a different account
              </button>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3 sm:gap-4 animate-fade-in">
              <button
                type="button"
                onClick={onSignIn}
                className="group bg-surface border border-line tactile-3 rounded-[24px] p-6 text-left hover:border-gold/50 transition cursor-pointer"
              >
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2">
                  <LogIn className="w-5 h-5" />
                </div>
                <p className="mt-4 font-bold text-ink">Staff Sign In</p>
                <p className="mt-1 text-xs text-ink-faint leading-relaxed">
                  Mashgichim, coordinators, and venue owners — open your shift board.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-gold-deep">
                  Sign in
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </span>
              </button>
              <button
                type="button"
                onClick={onRegister}
                className="group bg-surface border border-line tactile-3 rounded-[24px] p-6 text-left hover:border-gold/50 transition cursor-pointer"
              >
                <div className="w-11 h-11 rounded-2xl bg-sunken border border-line text-gold-deep flex items-center justify-center tactile-1">
                  <Building2 className="w-5 h-5" />
                </div>
                <p className="mt-4 font-bold text-ink">Register Agency</p>
                <p className="mt-1 text-xs text-ink-faint leading-relaxed">
                  Kosher agencies and vaadim — launch a dedicated platform for your organization.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-gold-deep">
                  Get started
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Feature strip */}
        <div className="mt-10 grid sm:grid-cols-3 gap-3 w-full max-w-4xl">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-surface/70 border border-line/70 rounded-[20px] p-5 tactile-1">
              <f.icon className="w-5 h-5 text-gold-deep" />
              <p className="mt-3 text-sm font-bold text-ink">{f.title}</p>
              <p className="mt-1 text-xs text-ink-faint leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 w-full px-4 py-5 text-center">
        <p className="text-[11px] text-ink-faint">
          Hartford Kashrut Commission (HKC) • KeepingKosher — Institutional Kashrus Oversight
        </p>
      </footer>
    </div>
  );
};

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
