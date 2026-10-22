import React, { useRef, useState } from 'react';
import { 
  ShieldCheck, 
  Mail, 
  Lock, 
  User, 
  MapPin, 
  Store, 
  Eye, 
  EyeOff, 
  AlertCircle,
  ArrowRight,
  PenLine
} from 'lucide-react';
import { User as UserType } from '../types';
import { apiFetch, setSessionToken } from '../lib/api';
import { registerIntoExistingAccount } from '../lib/registerExisting';

interface AgencySignupFormProps {
  onSuccess: (user: UserType) => void;
  onSwitchToLogin: () => void;
}

export const AgencySignupForm: React.FC<AgencySignupFormProps> = ({
  onSuccess,
  onSwitchToLogin,
}) => {
  // Agency Information
  const [agencyName, setAgencyName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [region, setRegion] = useState('');
  const [phone, setPhone] = useState('');

  // Primary Administrator
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Initial Venue / Facility
  const [initialVenueName, setInitialVenueName] = useState('');
  const [initialVenueCategory, setInitialVenueCategory] = useState('Food Service');
  const [customVenueCategory, setCustomVenueCategory] = useState('');
  const [initialVenueAddress, setInitialVenueAddress] = useState('');
  // 10M part 1: "I already have a Shutfey account" adds the new agency to that account.
  const [hasAccount, setHasAccount] = useState(false);
  // One id per form, kept across retries, so a repeated tap never makes a second agency.
  const operationIdRef = useRef<string>(
    `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
  // (seedTemplateTasks removed — the generated tasks were generic/random)

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auto-generate shortCode if empty when agencyName changes
  const handleAgencyNameChange = (val: string) => {
    setAgencyName(val);
    if (!shortCode || shortCode.length <= 4) {
      const words = val.trim().split(/\s+/);
      if (words.length > 1) {
        const acronym = words.map((w) => w[0]).join('').toUpperCase().slice(0, 5);
        if (acronym.length >= 2) setShortCode(acronym);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const cleanAgencyName = agencyName.trim();
    const cleanAdminEmail = adminEmail.trim().toLowerCase();
    const cleanAdminName = adminName.trim();
    const cleanAdminPassword = adminPassword.trim();
    const cleanVenueName = initialVenueName.trim();

    if (!cleanAgencyName) {
      setErrorMessage('Please enter your Kosher Agency or Vaad name.');
      return;
    }
    if (hasAccount) {
      if (!cleanAdminEmail || !cleanAdminPassword) {
        setErrorMessage('Please enter the email and password you already sign in with.');
        return;
      }
    } else if (!cleanAdminEmail || !cleanAdminName || !cleanAdminPassword) {
      setErrorMessage('Please provide administrator name, work email, and a secure password.');
      return;
    }
    if (!hasAccount && cleanAdminPassword.length < 6) {
      setErrorMessage('Administrator password must be at least 6 characters.');
      return;
    }
    if (!cleanVenueName) {
      setErrorMessage('Please specify an initial supervised venue or restaurant name.');
      return;
    }

    if (initialVenueCategory === 'Other' && !customVenueCategory.trim()) {
      setErrorMessage('Please write your custom category name.');
      return;
    }

    const finalCategory = initialVenueCategory === 'Other'
      ? customVenueCategory.trim()
      : initialVenueCategory;

    try {
      setIsLoading(true);
      if (hasAccount) {
        const r = await registerIntoExistingAccount({
          agencyName: cleanAgencyName,
          shortCode: shortCode.trim() || undefined,
          region: region.trim() || undefined,
          contactPhone: phone.trim() || undefined,
          initialVenueName: cleanVenueName,
          initialVenueCategory: finalCategory,
          email: cleanAdminEmail,
          password: cleanAdminPassword, // trimmed, exactly as the sign-in page sends it
          operationId: operationIdRef.current,
        });
        if (!r.ok) throw new Error(r.data.error || 'Could not add the agency. Please try again.');
        if (typeof r.data.token === 'string' && r.data.token) setSessionToken(r.data.token);
        if (r.data.user) onSuccess(r.data.user);
        else throw new Error('Agency added, but your profile could not be loaded. Please sign in.');
        return;
      }
      const res = await apiFetch('/api/agencies/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyName: cleanAgencyName,
          shortCode: shortCode.trim() || undefined,
          region: region.trim() || undefined,
          phone: phone.trim() || undefined,
          adminName: cleanAdminName,
          adminEmail: cleanAdminEmail,
          adminPassword: cleanAdminPassword,
          initialVenueName: cleanVenueName,
          initialVenueCategory: finalCategory,
          initialVenueAddress: initialVenueAddress.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Registration failed. Please verify your details.');
      }

      if (data.token) setSessionToken(data.token);
      if (data.user) {
        onSuccess(data.user);
      } else {
        throw new Error('Agency registered, but user profile could not be initialized.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to establish kosher agency account.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errorMessage && (
        <div className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5 animate-shake">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* 10M part 1: new account, or add this agency to an account you already have */}
      <div data-signup-mode={hasAccount ? 'existing' : 'new'} className="p-1 rounded-2xl bg-sunken border border-line grid grid-cols-2 gap-1">
        <button
          type="button"
          data-signup-mode-new
          aria-pressed={!hasAccount}
          onClick={() => { setHasAccount(false); setErrorMessage(null); }}
          className={`py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition ${!hasAccount ? 'bg-surface text-gold-deep tactile-1' : 'text-ink-faint hover:text-ink'}`}
        >
          New Shutfey account
        </button>
        <button
          type="button"
          data-signup-mode-existing
          aria-pressed={hasAccount}
          onClick={() => { setHasAccount(true); setErrorMessage(null); }}
          className={`py-2 px-2 rounded-xl text-[11px] sm:text-xs font-bold transition ${hasAccount ? 'bg-surface text-gold-deep tactile-1' : 'text-ink-faint hover:text-ink'}`}
        >
          I already have a Shutfey account
        </button>
      </div>

      {/* Step 1: Kosher Agency Organization Details */}
      <div className="p-4 rounded-2xl bg-surface tactile-3 border border-line space-y-3.5 animate-fade-in">
        <div className="flex items-center gap-2 text-ink">
          <div className="w-6 h-6 rounded-lg bg-gold-wash text-gold-deep flex items-center justify-center font-bold text-xs">
            1
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            Kosher Agency Organization
          </h3>
        </div>

        <div>
          <label className="block text-[11px] font-bold text-ink-soft mb-1">
            Agency Name *
          </label>
          <div className="relative">
            <ShieldCheck className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              required
              value={agencyName}
              onChange={(e) => handleAgencyNameChange(e.target.value)}
              placeholder="Agency Name"
              className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              Acronym
            </label>
            <input
              type="text"
              value={shortCode}
              onChange={(e) => setShortCode(e.target.value.toUpperCase())}
              placeholder="e.g. HKC, cRc, OU, COR, STAR-K"
              maxLength={8}
              className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition uppercase"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              Region / City
            </label>
            <div className="relative">
              <MapPin className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="Region / City"
                className="w-full pl-8 pr-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Step 2: Primary Rabbinical Administrator */}
      <div className="p-4 rounded-2xl bg-surface tactile-3 border border-line space-y-3.5 animate-fade-in">
        <div className="flex items-center gap-2 text-ink">
          <div className="w-6 h-6 rounded-lg bg-gold-wash text-gold-deep flex items-center justify-center font-bold text-xs">
            2
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            {hasAccount ? 'Your Shutfey account' : 'Agency Administrator'}
          </h3>
        </div>
        {hasAccount && (
          <p data-existing-account-note className="text-[11px] text-ink-soft leading-relaxed">
            Use the email and password you already sign in with. This agency is added to that same account, with you as its admin. You keep one sign-in, and the app asks which agency to open.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {!hasAccount && (
          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              Full Name *
            </label>
            <div className="relative">
              <User className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="Full Name"
                className="w-full pl-8 pr-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
              />
            </div>
          </div>
          )}

          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              {hasAccount ? 'Your email *' : 'Email *'}
            </label>
            <div className="relative">
              <Mail className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="email"
                required
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="Email"
                className="w-full pl-8 pr-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-bold text-ink-soft mb-1">
            {hasAccount ? 'Your password *' : 'Password *'}
          </label>
          <div className="relative">
            <Lock className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder="Password"
              className="w-full pl-8 pr-9 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Step 3: Initial Supervised Venue / Facility */}
      <div className="p-4 rounded-2xl bg-surface tactile-3 border border-line space-y-3.5 animate-fade-in">
        <div className="flex items-center gap-2 text-ink">
          <div className="w-6 h-6 rounded-lg bg-gold-wash text-gold-deep flex items-center justify-center font-bold text-xs">
            3
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            Initial Venue
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              Venue Name *
            </label>
            <div className="relative">
              <Store className="w-3.5 h-3.5 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                value={initialVenueName}
                onChange={(e) => setInitialVenueName(e.target.value)}
                placeholder="Venue Name"
                className="w-full pl-8 pr-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-ink-soft mb-1">
              Classification
            </label>
            <select
              id="agency-initial-venue-category-select"
              value={initialVenueCategory}
              onChange={(e) => setInitialVenueCategory(e.target.value)}
              className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink focus:border-gold focus:outline-none transition"
            >
              <option value="Food Service">Food Service</option>
              <option value="Restaurant">Restaurant</option>
              <option value="Industrial">Industrial</option>
              <option value="Catering">Catering</option>
              <option value="Bakery">Bakery</option>
              <option value="Other">Other (Create your own category...)</option>
            </select>
          </div>
        </div>

        {initialVenueCategory === 'Other' && (
          <div className="p-3.5 rounded-xl bg-gold-wash border border-gold/40 space-y-1.5 animate-fade-in">
            <div className="flex items-center justify-between">
              <label 
                htmlFor="agency-custom-category-input"
                className="text-[11px] font-bold text-gold-ink flex items-center gap-1.5"
              >
                <PenLine className="w-3.5 h-3.5 text-gold-deep" />
                <span>Custom Category *</span>
              </label>
            </div>
            <input
              id="agency-custom-category-input"
              type="text"
              required
              autoFocus
              value={customVenueCategory}
              onChange={(e) => setCustomVenueCategory(e.target.value)}
              placeholder="Category Name"
              className="w-full px-3 py-2 text-xs sm:text-sm rounded-lg bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
            />
          </div>
        )}

        {!hasAccount && (
        <div>
          <label className="block text-[11px] font-bold text-ink-soft mb-1">
            Address (Optional)
          </label>
          <input
            type="text"
            value={initialVenueAddress}
            onChange={(e) => setInitialVenueAddress(e.target.value)}
            placeholder="Address"
            className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none transition"
          />
        </div>
        )}

        {/* Seed Template Checkbox — removed: the generated tasks were generic/random */}
      </div>

      {/* Isolation Guarantee */}
      <div className="p-3 rounded-xl bg-gold-wash border border-gold/40 flex items-start gap-2.5 text-xs text-ink-soft">
        <ShieldCheck className="w-4 h-4 text-gold-deep shrink-0 mt-0.5" />
        <div>
          <span className="font-bold text-ink">Strict Agency Tenant Isolation:</span> Your agency will have its own private, personal portal. Only your appointed administrators, venue owners, and mashgichim workers can access your facilities.
        </div>
      </div>

      {/* Action Buttons */}
      <div className="space-y-2.5 pt-2">
        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-3 px-4 rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white tactile-2 text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
        >
          {isLoading ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>Establishing Agency & Portal...</span>
            </>
          ) : (
            <>
              <span>{hasAccount ? 'Add Agency to My Account' : 'Create Agency Account & Launch Portal'}</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>

        <div className="text-center">
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="text-xs text-ink-faint hover:text-gold-deep transition"
          >
            Already have an account? <span className="font-bold text-gold-deep">Sign in here</span>
          </button>
        </div>
      </div>
    </form>
  );
};
