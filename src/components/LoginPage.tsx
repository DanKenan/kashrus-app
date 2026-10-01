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
  UserPlus
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
    <div className="min-h-screen bg-paper text-ink flex flex-col justify-between transition-colors relative overflow-hidden">
      
      {/* Subtle Background Ambience */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[350px] bg-gold/10 blur-3xl pointer-events-none rounded-full" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[300px] bg-indigo-500/10 dark:bg-indigo-600/10 blur-2xl pointer-events-none rounded-full" />

      {/* Top Bar with Brand & Theme Toggle */}
      <header className="relative z-10 w-full px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between max-w-7xl mx-auto">
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

      {/* Main Authentication Card */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-6 sm:py-10 sm:px-6">
        <div className={`w-full transition-all duration-300 ${authMode === 'signup' ? 'max-w-xl' : 'max-w-md'}`}>
          
          {/* Card Frame */}
          <div className="bg-surface/95 backdrop-blur-md rounded-3xl p-6 sm:p-8 tactile-5 border border-line">
            
            {/* Header / Brand Emblem */}
            <div className="text-center mb-5">
              <div className="flex justify-center mb-3">
                <KeepingKosherLogo size="lg" showSubtitle={false} />
              </div>
              <h1 className="text-xl sm:text-2xl font-black tracking-tight text-ink">
                {authMode === 'signup' ? 'Kosher Agency Registration' : 'Kosher Shift & Daily Board'}
              </h1>
              <p className="text-xs text-ink-faint mt-1 max-w-sm mx-auto">
                {authMode === 'signup'
                  ? 'Set up a private, isolated portal for your Kosher Agency or Vaad to supervise venues, mashgichim staff, and checklists.'
                  : 'Sign in to access daily shift assignments, temperature logs, and kosher compliance checklists.'}
              </p>
            </div>

            {/* Segmented Mode Switcher (Sign In vs Register Agency) */}
            <div className="flex p-1 mb-6 rounded-2xl bg-sunken border border-line">
              <button
                type="button"
                id="auth-tab-login"
                onClick={() => {
                  setAuthMode('login');
                  setErrorMessage(null);
                }}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  authMode === 'login'
                    ? 'bg-surface text-gold-deep tactile-1'
                    : 'text-ink-faint hover:text-ink'
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
                    ? 'bg-surface text-gold-deep tactile-1'
                    : 'text-ink-faint hover:text-ink'
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
                    <label className="block text-xs font-bold text-ink-soft mb-1.5">
                      Email
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                        <Mail className="w-4 h-4" />
                      </div>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        autoComplete="email"
                        className="w-full pl-10 pr-3 py-2.5 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-ink-soft mb-1.5">
                      Password
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                        <Lock className="w-4 h-4" />
                      </div>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        autoComplete="current-password"
                        className="w-full pl-10 pr-10 py-2.5 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:outline-none focus:border-gold transition"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-ink-faint hover:text-ink-soft  cursor-pointer"
                        aria-label="Toggle password visibility"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full mt-2 py-3 px-4 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white text-xs sm:text-sm font-bold tactile-2 flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
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
                <div className="mt-5 p-3 rounded-2xl bg-gold-wash border border-gold/40 flex items-center justify-between text-xs">
                  <div className="text-left">
                    <p className="font-bold text-gold-ink text-[11px]">
                      Kosher Agency / Vaad Administrator?
                    </p>
                    <p className="text-[10px] text-gold-deep">
                      Launch a dedicated platform for your organization.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('signup');
                      setErrorMessage(null);
                    }}
                    className="shrink-0 px-2.5 py-1 rounded-lg bg-gradient-to-b from-gold to-gold-deep text-white font-bold text-[11px] hover:brightness-105 transition cursor-pointer"
                  >
                    Register Agency
                  </button>
                </div>

                {/* Security Guarantee */}
                <div className="mt-5 pt-4 border-t border-line/70 text-center">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-sunken border border-line text-[11px] text-ink-faint">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Multi-Agency Tenant Data Isolation</span>
                  </div>
                  <p className="text-[11px] text-ink-faint mt-2">
                    Each kosher agency and supervised venue operates in an isolated environment. Mashgichim and owners only access their authorized facilities.
                  </p>
                </div>

                {/* Quick Demo Accounts for Multi-Venue Testing */}
                <div className="mt-5 pt-4 border-t border-dashed border-line">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                      Quick Access Demo Accounts (HKC)
                    </span>
                    <span className="text-[10px] text-gold-deep font-medium">Click to fill</span>
                  </div>
                  
                  {/* Admin & Coordinator quick logins */}
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEmail('kenan@hartfordkashrut.org');
                        setPassword('admin123');
                        setErrorMessage(null);
                      }}
                      className="p-2 rounded-xl bg-gold-wash hover:bg-gold-wash border border-gold/40 hover:border-gold text-left transition text-xs flex items-center justify-between cursor-pointer"
                    >
                      <div>
                        <div className="font-bold text-gold-ink flex items-center gap-1 text-[11px]">
                          <ShieldCheck className="w-3.5 h-3.5 text-gold-deep shrink-0" />
                          <span>Admin</span>
                        </div>
                        <div className="text-[10px] text-gold-deep">Kenan (Full Control)</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setEmail('coordinator@hartfordkashrut.org');
                        setPassword('coord123');
                        setErrorMessage(null);
                      }}
                      className="p-2 rounded-xl bg-sunken hover:bg-line/40 border border-line hover:border-line-strong text-left transition text-xs flex items-center justify-between cursor-pointer"
                    >
                      <div>
                        <div className="font-bold text-ink flex items-center gap-1 text-[11px]">
                          <ShieldCheck className="w-3.5 h-3.5 text-gold-deep shrink-0" />
                          <span>Coordinator</span>
                        </div>
                        <div className="text-[10px] text-ink-soft">Rabbi Levy (Add Tasks)</div>
                      </div>
                    </button>
                  </div>

                  {/* Venue-Specific Quick Accounts Grid */}
                  <div className="space-y-1.5 text-xs">
                    {/* Crown Market */}
                    <div className="p-2 rounded-xl bg-sunken border border-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-faint mb-1 flex items-center gap-1">
                        <Building2 className="w-3 h-3 text-gold-deep" />
                        The Crown Market (Facility 1)
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEmail('owner@crownmarket.com');
                            setPassword('owner123');
                            setErrorMessage(null);
                          }}
                          className="flex-1 py-1 px-2 rounded-lg bg-surface hover:bg-sunken border border-line text-[11px] font-medium text-purple-700 dark:text-purple-300 transition text-center cursor-pointer"
                        >
                          Owner (Audit Only)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEmail('alex@company.com');
                            setPassword('worker123');
                            setErrorMessage(null);
                          }}
                          className="flex-1 py-1 px-2 rounded-lg bg-surface hover:bg-sunken border border-line text-[11px] font-medium text-emerald-700 dark:text-emerald-300 transition text-center cursor-pointer"
                        >
                          Alex (Mashgiach)
                        </button>
                      </div>
                    </div>

                    {/* Hartford Kosher Bakery */}
                    <div className="p-2 rounded-xl bg-sunken border border-line">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-faint mb-1 flex items-center gap-1">
                        <Building2 className="w-3 h-3 text-gold-deep" />
                        Hartford Kosher Bakery (Facility 2)
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEmail('owner@hartfordbakery.com');
                            setPassword('owner123');
                            setErrorMessage(null);
                          }}
                          className="flex-1 py-1 px-2 rounded-lg bg-surface hover:bg-sunken border border-line text-[11px] font-medium text-purple-700 dark:text-purple-300 transition text-center cursor-pointer"
                        >
                          Owner (Audit Only)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEmail('sarah@hartfordbakery.com');
                            setPassword('worker123');
                            setErrorMessage(null);
                          }}
                          className="flex-1 py-1 px-2 rounded-lg bg-surface hover:bg-sunken border border-line text-[11px] font-medium text-emerald-700 dark:text-emerald-300 transition text-center cursor-pointer"
                        >
                          Sarah (Mashgiach)
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

          </div>

          {/* Facility Highlights / System Status */}
          <div className="mt-5 space-y-3 px-2">
            <PWAInstallButton variant="banner" />
            <div className="grid grid-cols-2 gap-3 text-[11px] text-ink-faint">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-gold-deep shrink-0" />
                <span>Real-time multi-tenant sync</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-gold-deep shrink-0" />
                <span>Personalized Agency Portals</span>
              </div>
            </div>
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 w-full px-6 py-4 text-center text-xs text-ink-faint dark:text-ink-soft border-t border-line/60">
        KeepingKosher Multi-Agency Kashrut Operations &copy; {new Date().getFullYear()} &bull; All Rights Reserved
      </footer>
    </div>
  );
};

