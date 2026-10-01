import React, { useState } from 'react';
import { 
  X, 
  Building2, 
  ShieldCheck, 
  MapPin, 
  User, 
  Sparkles, 
  CheckCircle2, 
  Utensils, 
  Coffee, 
  Truck, 
  FileText,
  PenLine
} from 'lucide-react';
import { Venue } from '../types';

interface CreateVenueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVenueCreated: (venue: Venue) => void;
  adminEmail: string;
  agencyName?: string;
  agencySeal?: string;
}

export const CreateVenueModal: React.FC<CreateVenueModalProps> = ({
  isOpen,
  onClose,
  onVenueCreated,
  adminEmail,
  agencyName,
  agencySeal,
}) => {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Food Service');
  const [customCategory, setCustomCategory] = useState('');
  const [address, setAddress] = useState('');
  const [certification, setCertification] = useState(
    agencyName 
      ? `${agencyName}${agencySeal ? ` - ${agencySeal}` : ' - Supervised Kosher'}`
      : 'Hartford Kashrut Commission (HKC) - Glatt Meat & Parve'
  );
  const [templateType, setTemplateType] = useState<'restaurant' | 'bakery' | 'catering' | 'blank'>('restaurant');

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
      const res = await fetch('/api/venues', {
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs animate-fade-in overflow-y-auto"
    >
      <div className="bg-surface w-full max-w-2xl rounded-2xl tactile-4 animate-slide-up border border-line overflow-hidden my-8">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line bg-sunken">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                Set Up New Kosher Venue Platform
              </h2>
              <p className="text-xs text-ink-soft">
                Create an isolated operational platform with mashgichim, owner audit portal, and compliance logs.
              </p>
            </div>
          </div>
          <button
            id="close-create-venue-modal-btn"
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error notification */}
        {errorMessage && (
          <div className="mx-6 mt-4 p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
            {errorMessage}
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          
          {/* Section 1: Venue Details */}
          <div className="space-y-3.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-faint flex items-center gap-1.5">
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
                  className="w-full px-3.5 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
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
                    const val = e.target.value;
                    setCategory(val);
                    if (val === 'Bakery') setTemplateType('bakery');
                    else if (val === 'Catering') setTemplateType('catering');
                    else if (val === 'Restaurant' || val === 'Food Service') setTemplateType('restaurant');
                  }}
                  className="w-full px-3.5 py-2 text-xs rounded-xl bg-sunken border border-line text-ink focus:border-gold focus:outline-none"
                >
                  <option value="Food Service">Food Service</option>
                  <option value="Restaurant">Restaurant</option>
                  <option value="Industrial">Industrial</option>
                  <option value="Catering">Catering</option>
                  <option value="Bakery">Bakery</option>
                  <option value="Other">Other (Create your own category...)</option>
                </select>
              </div>

              {category === 'Other' && (
                <div className="sm:col-span-2 p-3.5 rounded-xl bg-gold-wash/60 border border-gold/40 tactile-1 space-y-1.5 animate-fade-in">
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
                    className="w-full px-3 py-2 text-xs rounded-lg bg-surface border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Address
                </label>
                <div className="relative">
                  <MapPin className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Address"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                  />
                </div>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-ink-soft mb-1">
                  Certification
                </label>
                <div className="relative">
                  <ShieldCheck className="w-3.5 h-3.5 absolute left-3 top-2.5 text-emerald-500" />
                  <input
                    type="text"
                    value={certification}
                    onChange={(e) => setCertification(e.target.value)}
                    placeholder="Certification Standard"
                    className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Starter Task Template */}
          <div className="space-y-3 pt-2 border-t border-line">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-faint flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-gold-deep" />
              <span>2. Seed Starter Shift Assignments</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setTemplateType('restaurant')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer lift ${
                  templateType === 'restaurant'
                    ? 'border-gold/60 bg-gold-wash/60 text-ink ring-1 ring-gold/40 tactile-1'
                    : 'border-line hover:border-line-strong'
                }`}
              >
                <Utensils className="w-4 h-4 text-gold-deep shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Restaurant & Deli Standard</div>
                  <div className="text-[11px] text-ink-soft">
                    5 starter tasks: Deliveries, walk-in cooler temps, meat/dairy sanitization, FIFO expiration, lockout.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTemplateType('bakery')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer lift ${
                  templateType === 'bakery'
                    ? 'border-gold/60 bg-gold-wash/60 text-ink ring-1 ring-gold/40 tactile-1'
                    : 'border-line hover:border-line-strong'
                }`}
              >
                <Coffee className="w-4 h-4 text-gold-deep shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Bakery & Cafe Standard</div>
                  <div className="text-[11px] text-ink-soft">
                    5 starter tasks: Pas Yisroel ignition check, flour sifting log, dairy/parve sheet segregation, stickers.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTemplateType('catering')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer lift ${
                  templateType === 'catering'
                    ? 'border-purple-500 bg-purple-50/70 dark:bg-purple-950/40 text-purple-900 dark:text-purple-100 ring-1 ring-purple-500 tactile-1'
                    : 'border-line hover:border-line-strong'
                }`}
              >
                <Truck className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Catering & Events Standard</div>
                  <div className="text-[11px] text-ink-soft">
                    4 starter tasks: Mashgiach tamper seal inspection, Cambro hot holding temp log, return manifest.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTemplateType('blank')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer lift ${
                  templateType === 'blank'
                    ? 'border-line-strong bg-sunken text-ink ring-1 ring-line-strong tactile-1'
                    : 'border-line hover:border-line-strong'
                }`}
              >
                <FileText className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Blank Slate Platform</div>
                  <div className="text-[11px] text-ink-soft">
                    Start with an empty board and craft assignments from scratch via the "+ New Assignment" button.
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Section 3: Venue Owner Account Provisioning */}
          <div className="space-y-3 pt-2 border-t border-line">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-faint flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-gold-deep" />
              <span>3. Establish Venue Owner Account (Optional)</span>
            </h3>
            <p className="text-[11px] text-ink-soft">
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
                  className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
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
                  className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
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
                  className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-line flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl text-ink-soft hover:text-ink hover:bg-sunken transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="pressable px-5 py-2 text-xs font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 text-white tactile-2 flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {isLoading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
