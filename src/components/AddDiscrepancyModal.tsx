import React, { useState } from 'react';
import { 
  X, 
  AlertTriangle, 
  MapPin, 
  Tag, 
  Building, 
  FileText, 
  ShieldAlert, 
  Plus, 
  AlertCircle
} from 'lucide-react';
import { UnapprovedDiscrepancy, User as UserType } from '../types';

interface AddDiscrepancyModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserType | null;
  onAddDiscrepancy: (discrepancy: UnapprovedDiscrepancy) => void;
}

export const AddDiscrepancyModal: React.FC<AddDiscrepancyModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onAddDiscrepancy,
}) => {
  const [name, setName] = useState('');
  const [brandOrSupplier, setBrandOrSupplier] = useState('');
  const [kashrutSymbolFound, setKashrutSymbolFound] = useState('None / No Symbol Visible');
  const [lotOrBatch, setLotOrBatch] = useState('');
  const [locationInFactory, setLocationInFactory] = useState('Staging Racks Near Blending Line');
  const [severity, setSeverity] = useState<'critical' | 'warning' | 'inquiry'>('warning');
  const [actionTaken, setActionTaken] = useState('Quarantined with red Mashgiach tamper tape');
  const [notes, setNotes] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newDiscrepancy: UnapprovedDiscrepancy = {
      id: `disc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: name.trim(),
      brandOrSupplier: brandOrSupplier.trim() || undefined,
      kashrutSymbolFound: kashrutSymbolFound.trim() || undefined,
      lotOrBatch: lotOrBatch.trim() || undefined,
      locationInFactory: locationInFactory.trim() || 'Factory Floor',
      severity,
      actionTaken: actionTaken.trim() || 'Quarantined for Rabbinic review',
      notes: notes.trim(),
      reportedAt: new Date().toISOString(),
      reportedByName: currentUser?.name || 'Factory Mashgiach',
      reportedByEmail: currentUser?.email || 'mashgiach@hartfordkashrut.org',
    };

    onAddDiscrepancy(newDiscrepancy);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line e3 rounded-2xl w-full max-w-xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-bad bg-bad-bg shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-sunken text-ink-soft flex items-center justify-center e2 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink flex items-center gap-2">
                <span>Flag Unapproved Raw Material on Factory Floor</span>
              </h2>
              <p className="text-sm text-bad">
                Discrepancy discovered during physical plant inspection
              </p>
            </div>
          </div>

          <button aria-label="Close"
            onClick={onClose}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-soft mb-1">
              Unapproved Raw Material / Ingredient Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Artificial Strawberry Flavoring #409, Gelatin Binder, Non-kosher Lecithin"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Manufacturer / Supplier
              </label>
              <input
                type="text"
                placeholder="Vendor label on barrel/box"
                value={brandOrSupplier}
                onChange={(e) => setBrandOrSupplier(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Kashrut Seal Visible on Packaging
              </label>
              <input
                type="text"
                placeholder="e.g. None, Unrecognized Hechsher, 'K'"
                value={kashrutSymbolFound}
                onChange={(e) => setKashrutSymbolFound(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Lot / Batch Number
              </label>
              <input
                type="text"
                placeholder="LOT-XXXXXX"
                value={lotOrBatch}
                onChange={(e) => setLotOrBatch(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none font-mono bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Location in Factory Plant
              </label>
              <input
                type="text"
                placeholder="e.g. Blending line 2 staging, Dry storage bay D"
                value={locationInFactory}
                onChange={(e) => setLocationInFactory(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Severity Level
              </label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as any)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              >
                <option value="critical">Critical (Treif / Non-Kosher on Active Line)</option>
                <option value="warning">Warning (Unapproved Item on Staging Racks)</option>
                <option value="inquiry">Inquiry (Document Missing / LoC Expired)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-soft mb-1">
                Immediate Action Taken by Mashgiach
              </label>
              <input
                type="text"
                value={actionTaken}
                onChange={(e) => setActionTaken(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-soft mb-1">
              Mashgiach Discovery Notes & Details
            </label>
            <textarea
              rows={3}
              required
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe where the barrel was discovered, quantity (e.g. three 55-gallon drums), explanation provided by plant manager, and steps taken to halt addition into kosher batch..."
              className="w-full px-3.5 py-2 border text-ink placeholder:text-ink-soft outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-line/70">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              Cancel
            </button>

            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-bold rounded-xl hover:brightness-105 active:scale-[.98] e2 transition cursor-pointer bg-gold-deep text-paper"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Log Discrepancy & Quarantine</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
