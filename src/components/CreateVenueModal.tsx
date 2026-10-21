import React, { useState } from 'react';
import {
  X,
  Building2,
  ShieldCheck,
  MapPin,
  User,
  CheckCircle2,
  Truck,
  PenLine,
} from 'lucide-react';
import { Venue } from '../types';
import { apiFetch } from '../lib/api';
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE, timeZoneLabel } from '../lib/workday';

interface CreateVenueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVenueCreated: (venue: Venue) => void;
  adminEmail: string;
  agencyName?: string;
  agencySeal?: string;
  /** Item 6: the agency's zone (absent = America/New_York), shown as the default. */
  agencyTimeZone?: string;
}

export const CreateVenueModal: React.FC<CreateVenueModalProps> = ({
  isOpen,
  onClose,
  onVenueCreated,
  adminEmail,
  agencyName,
  agencySeal,
  agencyTimeZone,
}) => {
  const [name, setName] = useState('');
  // Item 6: '' = same as the agency (no own zone stored).
  const [timeZone, setTimeZone] = useState('');
  const [category, setCategory] = useState('Industrial');
  const [customCategory, setCustomCategory] = useState('');
  const [address, setAddress] = useState('');
  const [certification, setCertification] = useState(
    agencyName 
      ? `${agencyName}${agencySeal ? ` - ${agencySeal}` : ' - Supervised Kosher'}`
      : 'Hartford Kashrut Commission (HKC) - Glatt Meat & Parve'
  );
  const templateType = 'blank' as const;

  // Venue Owner credentials
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim()) {
      setErrorMessage('Please enter a name for the kosher venue.');
      return;
    }

    if (category === 'Other' && !customCategory.trim()) {
      setErrorMessage('Please write your custom category name.');
      return;
    }

    const finalCategory = category === 'Other'
      ? customCategory.trim()
      : category.trim();

    if (ownerEmail.trim() && !ownerPassword.trim()) {
      setErrorMessage('Please specify an initial password for the venue owner.');
      return;
    }

    try {
      setIsLoading(true);
      const res = await apiFetch('/api/venues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          category: finalCategory,
          address: address.trim(),
          certification: certification.trim(),
          ownerName: ownerName.trim() || undefined,
          ownerEmail: ownerEmail.trim() || undefined,
          ownerPassword: ownerPassword.trim() || undefined,
          templateType,
          userEmail: adminEmail,
          ...(timeZone ? { timeZone } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create new venue platform.');
      }

      onVenueCreated(data.venue);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Error occurred while creating venue platform.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div 
      id="create-venue-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-2xl rounded-2xl e3 animate-slide-up border border-line overflow-hidden my-8">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gold-wash text-gold-ink flex items-center justify-center e2">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                Set Up New Kosher Venue Platform
              </h2>
              <p className="text-sm text-ink-soft">
                Create an isolated operational platform with mashgichim, owner audit portal, and compliance logs.
              </p>
            </div>
          </div>
          <button aria-label="Close"
            id="close-create-venue-modal-btn"
            onClick={onClose}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error notification */}
        {errorMessage && (
          <div className="mx-6 mt-4 p-3.5 rounded-xl bg-bad-bg border border-bad text-xs text-bad ">
            {errorMessage}
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          
          {/* Section 1: Venue Details */}
          <div className="space-y-3.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-gold-deep" />
              <span>1. Kosher Establishment Profile</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Establishment Name *
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Establishment Name"
                  className="w-full px-3.5 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Establishment Type
                </label>
                <select
                  id="venue-category-select"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                  }}
                  className="w-full px-3.5 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                >
                  <option value="Industrial">Industrial / Factory Plant (Airtable & Audits)</option>
                  <option value="Food Service">Food Service</option>
                  <option value="Restaurant">Restaurant</option>
                  <option value="Catering">Catering</option>
                  <option value="Bakery">Bakery</option>
                  <option value="Other">Other (Create your own category...)</option>
                </select>
              </div>

              {category === 'Other' && (
                <div className="sm:col-span-2 p-3.5 rounded-xl bg-gold-wash/60 border border-gold/40 e1 space-y-1.5 animate-fade-in">
                  <div className="flex items-center justify-between">
                    <label 
                      htmlFor="venue-custom-category-input"
                      className="text-xs font-bold text-gold-ink flex items-center gap-1.5"
                    >
                      <PenLine className="w-3.5 h-3.5 text-gold-deep" />
                      <span>Custom Category *</span>
                    </label>
                  </div>
                  <input
                    id="venue-custom-category-input"
                    type="text"
                    required
                    autoFocus
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    placeholder="Category Name"
                    className="w-full px-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Address
                </label>
                <div className="relative">
                  <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Address"
                    className="w-full pl-8.5 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="venue-timezone-select" className="block text-xs font-semibold text-ink-soft mb-1">
                  Time zone
                </label>
                <select
                  id="venue-timezone-select"
                  data-venue-timezone
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                  className="w-full px-3.5 py-2 focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                >
                  <option value="">Same as agency ({timeZoneLabel(agencyTimeZone || DEFAULT_TIME_ZONE)})</option>
                  {COMMON_TIME_ZONES.map((z) => (
                    <option key={z.tz} value={z.tz}>
                      {timeZoneLabel(z.tz)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-sm text-ink-soft">The venue's day, "today" and the daily reset at midnight follow this zone.</p>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Certification
                </label>
                <div className="relative">
                  <ShieldCheck className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ok" />
                  <input
                    type="text"
                    value={certification}
                    onChange={(e) => setCertification(e.target.value)}
                    placeholder="Certification Standard"
                    className="w-full pl-8.5 pr-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                  />
                </div>
              </div>
            </div>
          </div>
          {/* Section 3: Venue Owner Account Provisioning */}
          <div className="space-y-3 pt-2 border-t border-line">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-gold-deep" />
              <span>3. Establish Venue Owner Account (Optional)</span>
            </h3>
            <p className="text-sm text-ink-soft">
              The owner logs into their isolated platform in read-only audit mode to review shift progress and history logs.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Owner Full Name
                </label>
                <input
                  type="text"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Full Name"
                  className="w-full px-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Owner Email
                </label>
                <input
                  type="email"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="Email"
                  className="w-full px-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full px-3 py-2 placeholder-ink-faint focus:outline-none min-w-0 bg-surface border border-line-control rounded-lg text-base text-ink focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-line flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="pressable px-5 py-2 text-xs font-bold rounded-xl hover:brightness-105 e2 flex items-center gap-1.5 disabled:opacity-50 cursor-pointer bg-gold-deep text-paper"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-paper border-t-transparent rounded-full animate-spin" />
                  <span>Configuring Venue...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Create Venue Platform</span>
                </>
              )}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};
