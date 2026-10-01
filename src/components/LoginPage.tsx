import React, { useState } from 'react';
import { 
  Mail, 
  Lock, 
  Eye, 
  EyeOff, 
  LogIn, 
  AlertCircle, 
  ShieldCheck, 
  Sun, 
  Moon, 
  CheckCircle2, 
  Building2,
  Sparkles,
  UserPlus,
  Factory
} from 'lucide-react';
import { KeepingKosherLogo } from './KeepingKosherLogo';
import { User as UserType } from '../types';
import { AgencySignupForm } from './AgencySignupForm';
import { PWAInstallButton } from './PWAInstallButton';

interface LoginPageProps {
  onLoginSuccess: (user: UserType) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  darkMode,
  onToggleDarkMode,
}) => {
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    if (!trimmedEmail || !trimmedPassword) {
      setErrorMessage('Please enter both your work email and password.');
      return;
    }

    try {
      setIsLoading(true);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed. Please check your email and password.');
      }

      if (data.user) {
        onLoginSuccess(data.user);
      } else {
        throw new Error('User profile could not be verified.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Unable to sign in. Please verify your network and credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-slate-100 to-blue-50/40 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950/30 text-slate-900 dark:text-slate-100 flex flex-col justify-between transition-colors relative overflow-hidden">
      
      {/* Subtle Background Ambience */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[350px] bg-blue-500/10 dark:bg-blue-600/10 blur-3xl pointer-events-none rounded-full" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[300px] bg-indigo-500/10 dark:bg-indigo-600/10 blur-2xl pointer-events-none rounded-full" />

      {/* Top Bar with Brand & Theme Toggle */}
      <header className="relative z-10 w-full px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between max-w-7xl mx-auto">
        <KeepingKosherLogo size="sm" showSubtitle={true} />
        
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/80 dark:bg-slate-900/80 border border-slate-200/80 dark:border-slate-800 text-[11px] font-medium text-slate-600 dark:text-slate-400 backdrop-blur-xs">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Multi-Agency Kashrut Network</span>
          </div>

          <PWAInstallButton />

          <button
            type="button"
            onClick={onToggleDarkMode}
            className="p-2 sm:p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white shadow-xs transition cursor-pointer"
            aria-label="Toggle dark mode"
          >
            {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
          </button>
        </div>
      </header>

      {/* Main Authentication Card */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-6 sm:py-10 sm:px-6">
        <div className={`w-full transition-all duration-300 ${authMode === 'signup' ? 'max-w-xl' : 'max-w-md'}`}>
          
          {/* Card Frame */}
          <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-3xl p-6 sm:p-8 shadow-2xl border border-slate-200/80 dark:border-slate-800/90 ring-1 ring-slate-900/5 dark:ring-white/5">
            
            {/* Header / Brand Emblem */}
            <div className="text-center mb-5">
              <div className="flex justify-center mb-3">
                <KeepingKosherLogo size="lg" showSubtitle={false} />
              </div>
              <h1 className="text-xl sm:text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                {authMode === 'signup' ? 'Kosher Agency Registration' : 'Kosher Shift & Daily Board'}
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                {authMode === 'signup'
                  ? 'Set up a private, isolated portal for your Kosher Agency or Vaad to supervise venues, mashgichim staff, and checklists.'
                  : 'Sign in to access daily shift assignments, temperature logs, and kosher compliance checklists.'}
              </p>
            </div>

            {/* Segmented Mode Switcher (Sign In vs Register Agency) */}
            <div className="flex p-1 mb-6 rounded-2xl bg-slate-100 dark:bg-slate-800/80 border border-slate-200/80 dark:border-slate-700/80">
              <button
                type="button"
                id="auth-tab-login"
                onClick={() => {
                  setAuthMode('login');
                  setErrorMessage(null);
                }}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  authMode === 'login'
                    ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Staff Sign In</span>
              </button>
              <button
                type="button"
                id="auth-tab-signup"
                onClick={() => {
                  setAuthMode('signup');
                  setErrorMessage(null);
                }}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  authMode === 'signup'
                    ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Sign Up Kosher Agency</span>
              </button>
            </div>

            {authMode === 'signup' ? (
              /* Agency Sign Up Flow */
              <AgencySignupForm
                onSuccess={(user) => {
                  onLoginSuccess(user);
                }}
                onSwitchToLogin={() => {
                  setAuthMode('login');
                  setErrorMessage(null);
                }}
              />
            ) : (
              /* Standard Staff Sign In Flow */
              <>
                {/* Error Message */}
                {errorMessage && (
                  <div className="mb-5 p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5 animate-shake">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Login Form */}
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                      Email
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                        <Mail className="w-4 h-4" />
                      </div>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        autoComplete="email"
                        className="w-full pl-10 pr-3 py-2.5 text-xs sm:text-sm rounded-xl bg-slate-50/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                      Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                        <Lock className="w-4 h-4" />
                      </div>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        autoComplete="current-password"
                        className="w-full pl-10 pr-10 py-2.5 text-xs sm:text-sm rounded-xl bg-slate-50/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                        aria-label="Toggle password visibility"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full mt-2 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs sm:text-sm font-bold shadow-lg shadow-blue-600/25 flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
                  >
                    {isLoading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Verifying Credentials...</span>
                      </>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4" />
                        <span>Sign In to Shift Board</span>
                      </>
                    )}
                  </button>
                </form>

                {/* Callout to register new agency */}
                <div className="mt-5 p-3 rounded-2xl bg-blue-50/60 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/40 flex items-center justify-between text-xs">
                  <div className="text-left">
                    <p className="font-bold text-blue-900 dark:text-blue-200 text-[11px]">
                      Kosher Agency / Vaad Administrator?
                    </p>
                    <p className="text-[10px] text-blue-700 dark:text-blue-300">
                      Launch a dedicated platform for your organization.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('signup');
                      setErrorMessage(null);
                    }}
                    className="shrink-0 px-2.5 py-1 rounded-lg bg-blue-600 text-white font-bold text-[11px] hover:bg-blue-700 transition cursor-pointer"
                  >
                    Register Agency
                  </button>
                </div>

                {/* Security Guarantee */}
                <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800/80 text-center">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-700/60 text-[11px] text-slate-500 dark:text-slate-400">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Multi-Agency Tenant Data Isolation</span>
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2">
                    Each kosher agency and supervised venue operates in an isolated environment. Mashgichim and owners only access their authorized facilities.
                  </p>
                </div>

              </>
            )}

          </div>

          {/* Facility Highlights / System Status */}
          <div className="mt-5 space-y-3 px-2">
            <PWAInstallButton variant="banner" />
            <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span>Real-time multi-tenant sync</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span>Personalized Agency Portals</span>
              </div>
            </div>
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 w-full px-6 py-4 text-center text-xs text-slate-400 dark:text-slate-600 border-t border-slate-200/60 dark:border-slate-800/60">
        KeepingKosher Multi-Agency Kashrut Operations &copy; {new Date().getFullYear()} &bull; All Rights Reserved
      </footer>
    </div>
  );
};

