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
import { ShutfeyLogo } from './ShutfeyLogo';
import { LandingBackButton } from './LandingPage';
import { User as UserType } from '../types';
import { AgencySignupForm } from './AgencySignupForm';
import { PWAInstallButton } from './PWAInstallButton';
import { ForgotPasswordModal } from './ForgotPasswordModal';
import { apiFetch, setSessionToken } from '../lib/api';
import { signInErrorText } from '../lib/venueRemoved';
import { activateMembership, cleanMemberships, isChooseAnswer, Membership } from '../lib/memberships';
import { getRoleLabel } from '../lib/permissions';

interface LoginPageProps {
  onLoginSuccess: (user: UserType) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  /** Which tab to show first when arriving from the landing page. */
  initialMode?: 'login' | 'signup';
  /** Return to the public home page. */
  onBack?: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  darkMode,
  onToggleDarkMode,
  initialMode,
  onBack,
}) => {
  const [authMode, setAuthMode] = useState<'login' | 'signup'>(initialMode || 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // First-run admin setup: no password exists yet → show the create-password form.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  // 10g: an email with several agencies signs in, then picks which one to open.
  const [chooser, setChooser] = useState<{ token: string; memberships: Membership[] } | null>(null);

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
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(signInErrorText(data, 'Authentication failed. Please check your email and password.'));
      }

      // First-run setup: admin has no password yet → create it now.
      if (data.needsSetup) {
        setNeedsSetup(true);
        setIsLoading(false);
        return;
      }

      // 10g: several agencies under this login -> the person picks one. The
      // choose token is NOT a session; it is kept only in this screen.
      if (isChooseAnswer(data)) {
        const list = cleanMemberships(data.memberships);
        if (list.length > 0) {
          setChooser({ token: data.token, memberships: list });
          setPassword('');
          return;
        }
        throw new Error('User profile could not be verified.');
      }

      if (data.token) {
        setSessionToken(data.token);
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

  const openMembership = async (membershipId: string) => {
    if (!chooser || isLoading) return;
    setErrorMessage(null);
    setIsLoading(true);
    const r = await activateMembership(chooser.token, membershipId);
    setIsLoading(false);
    if (r.ok && r.token && r.user) {
      setSessionToken(r.token);
      setChooser(null);
      onLoginSuccess(r.user);
      return;
    }
    setErrorMessage(r.error || 'Please sign in again.');
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (setupPassword.trim().length < 8) {
      setErrorMessage('Please choose a password of at least 8 characters.');
      return;
    }
    if (setupPassword !== setupConfirm) {
      setErrorMessage('The two passwords do not match.');
      return;
    }
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), newPassword: setupPassword.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Setup failed. Please try again.');
      if (data.token) setSessionToken(data.token);
      if (data.user) onLoginSuccess(data.user);
      else throw new Error('Setup complete but sign-in failed. Please sign in.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Setup failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col justify-between transition-colors relative overflow-hidden">
      
      {/* Subtle Background Ambience */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[350px] bg-gold/10 blur-3xl pointer-events-none rounded-full" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[300px] bg-emerald-500/10 blur-2xl pointer-events-none rounded-full" />

      {/* Top Bar with Brand & Theme Toggle */}
      <header className="relative z-10 w-full px-4 sm:px-6 py-4 sm:py-5 flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          {onBack && <LandingBackButton onBack={onBack} />}
          <ShutfeyLogo size="sm" showSubtitle={true} />
        </div>
        
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
                <ShutfeyLogo size="lg" showSubtitle={false} />
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
            ) : chooser ? (
              /* 10g: pick which agency to open */
              <div data-login-chooser className="space-y-4">
                <div className="text-center">
                  <h2 className="text-lg font-black text-ink">Which agency?</h2>
                  <p className="text-sm text-ink-soft mt-1">{email.trim()} is in more than one agency. You can switch any time from the menu.</p>
                </div>
                {errorMessage && (
                  <div role="alert" className="p-3 rounded-2xl bg-bad-bg border border-bad text-sm text-bad flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{errorMessage}</span>
                  </div>
                )}
                <div className="space-y-2">
                  {chooser.memberships.map((m) => (
                    <button
                      key={m.membershipId}
                      type="button"
                      data-membership={m.membershipId}
                      disabled={isLoading}
                      onClick={() => { void openMembership(m.membershipId); }}
                      className="w-full min-h-11 py-3 px-4 rounded-xl bg-surface border border-line text-left flex items-center gap-3 hover:bg-sunken disabled:opacity-50 cursor-pointer"
                    >
                      <Building2 className="w-5 h-5 shrink-0 text-gold-ink" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink break-words">{m.agencyName}</span>
                        {m.role && <span className="block text-sm text-ink-soft">{getRoleLabel(m.role)}</span>}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => { setChooser(null); setErrorMessage(null); }}
                  className="w-full min-h-11 py-3 px-4 rounded-xl bg-surface border border-line text-ink text-sm font-bold hover:bg-sunken cursor-pointer"
                >
                  Back to sign in
                </button>
              </div>
            ) : needsSetup ? (
              /* First-run admin setup: create the admin password */
              <>
                {errorMessage && (
                  <div className="mb-5 p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5 animate-shake">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
                    <span>{errorMessage}</span>
                  </div>
                )}
                <form onSubmit={handleSetupSubmit} className="space-y-4">
                  <div className="p-3.5 rounded-2xl bg-gold-wash border border-gold/40 text-xs text-ink-soft">
                    <span className="font-bold text-ink">Welcome — let's secure your account.</span>
                    <br />
                    Create a strong password for {email.trim() || 'the admin account'}. You'll use it to sign in from now on.
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-ink-soft mb-1">New password (min 8 characters)</label>
                    <input
                      type="password"
                      value={setupPassword}
                      onChange={(e) => setSetupPassword(e.target.value)}
                      placeholder="Choose a strong password"
                      className="w-full px-3 py-2.5 text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-ink-soft mb-1">Confirm password</label>
                    <input
                      type="password"
                      value={setupConfirm}
                      onChange={(e) => setSetupConfirm(e.target.value)}
                      placeholder="Repeat the password"
                      className="w-full px-3 py-2.5 text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-3 px-4 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 text-sm font-bold flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
                  >
                    {isLoading ? 'Setting up…' : 'Create password & sign in'}
                  </button>
                </form>
              </>
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

                {/* Forgot password link */}
                <button
                  onClick={() => setShowForgot(true)}
                  className="mt-3 w-full text-center text-xs text-gold-deep hover:text-gold-ink font-semibold transition cursor-pointer"
                >
                  Forgot your password?
                </button>

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
        Shutfey Multi-Agency Kashrut Operations &copy; {new Date().getFullYear()} &bull; All Rights Reserved
      </footer>

      {showForgot && (
        <ForgotPasswordModal
          onClose={() => setShowForgot(false)}
          onSuccess={(user, token) => {
            if (token) setSessionToken(token);
            onLoginSuccess(user);
          }}
        />
      )}
    </div>
  );
};

