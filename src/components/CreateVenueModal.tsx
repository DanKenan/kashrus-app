import React, { useEffect, useState } from 'react';
import {
  X,
  Building2,
  MapPin,
  User,
  CheckCircle2,
  PenLine,
} from 'lucide-react';
import { KosherAgency, Venue } from '../types';
import { apiFetch, apiWrite, versionFromResponse } from '../lib/api';
import { certificationLabel, normalizeOption, validateOptions } from '../lib/certOptions';
import { CertificationOptionsSheet } from './CertificationOptionsSheet';
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE, timeZoneLabel } from '../lib/workday';
import { fullInviteLink } from '../lib/invites';
import { InviteLinkCard } from './InviteLinkCard';

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
  agencyTimeZone,
}) => {
  const [name, setName] = useState('');
  // Item 6: '' = same as the agency (no own zone stored).
  const [timeZone, setTimeZone] = useState('');
  const [category, setCategory] = useState('Restaurant');
  const [customCategory, setCustomCategory] = useState('');
  const [address, setAddress] = useState('');
  const [shownList, setShownList] = useState<string[]>([]);
  const [optionsVersion, setOptionsVersion] = useState<number | undefined>();
  const [currentAgencyName, setCurrentAgencyName] = useState(agencyName || '');
  const [selected, setSelected] = useState<number | 'other' | null>(null);
  const [other, setOther] = useState('');
  const [saveForNextTime, setSaveForNextTime] = useState(false);
  const [choicesLoading, setChoicesLoading] = useState(true);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [editingChoices, setEditingChoices] = useState(false);
  const [venueCreated, setVenueCreated] = useState(false);
  const [saveChoiceError, setSaveChoiceError] = useState<string | null>(null);
  const detail = selected === 'other' ? other : selected === null ? '' : shownList[selected] || '';
  const certification = certificationLabel(currentAgencyName, detail);
  const templateType = 'blank' as const;

  // Venue Owner credentials
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Item 10i: the new owner's invite link (shown once, never stored).
  const [ownerInvite, setOwnerInvite] = useState<{ link: string; forWhom: string } | null>(null);
  const [choicePending, setChoicePending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setShownList([]);
    setOptionsVersion(undefined);
    setCurrentAgencyName(agencyName || '');
    setSelected(null);
    setOther('');
    setSaveForNextTime(false);
    setVenueCreated(false);
    setSaveChoiceError(null);
    setErrorMessage(null);
    setOwnerInvite(null);
    setChoicePending(false);
    setEditingChoices(false);
    setChoicesLoading(true);
    setChoicesError(null);
    const load = async () => {
      try {
        const res = await apiFetch('/api/agencies/current');
        const version = versionFromResponse(res);
        const data: { agency: KosherAgency; error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't load certification choices.");
        if (!active) return;
        setShownList(data.agency.certificationOptions || ['Glatt meat', 'Dairy', 'DE', 'Parve']);
        setOptionsVersion(version);
        setCurrentAgencyName(data.agency.name || agencyName || '');
      } catch (error) {
        if (active) setChoicesError(error instanceof Error ? error.message : "Couldn't load certification choices.");
      } finally {
        if (active) setChoicesLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [isOpen, agencyName]);

  if (!isOpen) return null;

  const openChoices = async () => {
    setChoicesLoading(true);
    setChoicesError(null);
    try {
      const res = await apiFetch('/api/agencies/current');
      const version = versionFromResponse(res);
      const data: { agency: KosherAgency; error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load certification choices.");
      setShownList(data.agency.certificationOptions || ['Glatt meat', 'Dairy', 'DE', 'Parve']);
      setOptionsVersion(version);
      setCurrentAgencyName(data.agency.name || agencyName || '');
      setSelected(null);
      setEditingChoices(true);
    } catch (error) {
      setChoicesError(error instanceof Error ? error.message : "Couldn't load certification choices.");
    } finally {
      setChoicesLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || venueCreated || choicesLoading || choicesError) return;
    setErrorMessage(null);
    if (selected === 'other') {
      const validation = validateOptions([other]);
      if (validation) { setErrorMessage(validation); return; }
    }

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

    try {
      setIsLoading(true);
      const res = await apiFetch('/api/venues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          category: finalCategory,
          address: address.trim(),
          certification,
          ...(normalizeOption(detail) ? { certificationDetail: normalizeOption(detail) } : {}),
          ownerName: ownerName.trim() || undefined,
          ownerEmail: ownerEmail.trim() || undefined,
          templateType,
          userEmail: adminEmail,
          ...(timeZone ? { timeZone } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Couldn't create the venue.");
      }

      // Item 10i: with Phase C ON a new owner email comes back as an invite link.
      const ownerLink = fullInviteLink(data.ownerInviteLink);
      if (ownerLink) {
        const who = data.ownerInvite && typeof data.ownerInvite === 'object' ? data.ownerInvite : {};
        setOwnerInvite({ link: ownerLink, forWhom: who.name && who.email ? `${who.name} (${who.email})` : String(who.email || ownerEmail.trim()) });
      }
      setVenueCreated(true);
      onVenueCreated(data.venue);
      if (selected === 'other' && saveForNextTime) {
        setChoicePending(true);
        try {
          const version = versionFromResponse(res);
          if (version === undefined) throw new Error('The venue response did not include a version.');
          const result = await apiWrite('/api/agency/certification-options', {
            method: 'PUT',
            expectedVersion: version,
            body: JSON.stringify({ options: [...shownList, normalizeOption(other)], expectedOptions: shownList }),
          });
          if (!result.ok) throw new Error(result.error || "Couldn't save the new choice.");
        } catch (error) {
          setSaveChoiceError(error instanceof Error ? error.message : "Couldn't save the new choice.");
          return;
        } finally {
          setChoicePending(false);
        }
      }
      if (ownerLink) return; // stay open: the admin copies the owner's link first
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || "Couldn't create the venue. Please try again.");
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
                New venue
              </h2>
              <p className="text-sm text-ink-soft">
                Each venue has its own tasks, team and history.
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
        {venueCreated && ownerInvite ? (
          <div className="p-6 space-y-4">
            <h3 className="text-base font-semibold text-ink">Venue created</h3>
            <InviteLinkCard
              link={ownerInvite.link}
              forWhom={ownerInvite.forWhom}
              hint="Send this link to the venue owner."
              onDone={choicePending ? undefined : onClose}
            />
            {(choicePending || saveChoiceError) && (
              <p role="status" className="text-sm text-ink-soft">
                {saveChoiceError ? `The new choice wasn't saved for next time: ${saveChoiceError}` : 'Saving the new choice…'}
              </p>
            )}
          </div>
        ) : venueCreated ? (
          <div className="p-6 space-y-4">
            <h3 className="text-base font-semibold text-ink">Venue created</h3>
            <p role="status" className="text-sm text-ink-soft">
              {saveChoiceError ? `Venue created. The new choice wasn't saved for next time: ${saveChoiceError}` : 'Saving the new choice…'}
            </p>
            {saveChoiceError && <button type="button" onClick={onClose}
              className="pressable min-h-11 rounded-xl bg-gold-deep px-4 text-base font-semibold text-paper">Done</button>}
          </div>
        ) : <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          
          {/* Section 1: Venue Details */}
          <div className="space-y-3.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-gold-deep" />
              <span>1. Venue details</span>
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
                  <option value="Industrial">Factory / plant</option>
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

              <div className="sm:col-span-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span id="certification-details-label" className="text-xs font-semibold text-ink-soft">Certification details</span>
                  <button type="button" disabled={choicesLoading || !!choicesError || isLoading}
                    onClick={openChoices}
                    className="pressable min-h-11 rounded-lg border border-line-control bg-surface px-3 text-sm text-ink disabled:opacity-50">Edit choices</button>
                </div>
                {choicesLoading && <p role="status" className="text-sm text-ink-soft">Loading certification choices…</p>}
                {choicesError && <p role="alert" className="text-sm text-ink">{choicesError}</p>}
                <div role="radiogroup" aria-labelledby="certification-details-label" className="space-y-2">
                  {shownList.map((option, index) => (
                    <label key={index} className="flex min-h-11 items-center gap-3 rounded-lg border border-line-control bg-surface px-3 text-base text-ink">
                      <input type="radio" name="certification-detail" checked={selected === index} disabled={isLoading}
                        onChange={() => setSelected(index)} />
                      {option}
                    </label>
                  ))}
                  <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line-control bg-surface px-3 text-base text-ink">
                    <input type="radio" name="certification-detail" checked={selected === 'other'} disabled={choicesLoading || !!choicesError || isLoading}
                      onChange={() => setSelected('other')} />
                    Other
                  </label>
                </div>
                {selected === 'other' && (
                  <div className="space-y-2">
                    <label htmlFor="other-certification" className="block text-sm text-ink-soft">Other certification</label>
                    <input id="other-certification" value={other} disabled={isLoading} onChange={(event) => setOther(event.target.value)}
                      className="min-h-11 w-full rounded-lg border border-line-control bg-sunken px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-gold" />
                    <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                      <input type="checkbox" checked={saveForNextTime} disabled={isLoading} onChange={(event) => setSaveForNextTime(event.target.checked)} />
                      Save for next time
                    </label>
                  </div>
                )}
                <p aria-live="polite" className="text-sm text-ink-soft">Venue will show: {certification}</p>
              </div>
            </div>
          </div>
          {/* Section 3: Venue Owner Account Provisioning */}
          <div className="space-y-3 pt-2 border-t border-line">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-soft flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-gold-deep" />
              <span>2. Venue owner account (optional)</span>
            </h3>
            <p className="text-sm text-ink-soft">
              The owner can sign in to see this venue's tasks and history (read only).
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            </div>
            <p data-invite-mode-note className="text-sm text-ink-soft">
              No password needed. For a new owner you'll get a link to send them, and they choose their own password.
            </p>
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
              disabled={isLoading || choicesLoading || !!choicesError}
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
                  <span>Create venue</span>
                </>
              )}
            </button>
          </div>

        </form>}
        {editingChoices && <CertificationOptionsSheet options={shownList} versionAtOpen={optionsVersion}
          onClose={() => setEditingChoices(false)} onSaved={(options) => { setShownList(options); setSelected(null); }} />}
      </div>
    </div>
  );
};
