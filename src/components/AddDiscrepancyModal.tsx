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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1a120a]/60 backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line tactile-4 rounded-[28px] w-full max-w-xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-rose-100 dark:border-rose-950/60 bg-rose-50/60 dark:bg-rose-950/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-rose-500 to-rose-700 text-white flex items-center justify-center tactile-2 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink flex items-center gap-2">
                <span>Flag Unapproved Raw Material on Factory Floor</span>
              </h2>
              <p className="text-xs text-rose-700 dark:text-rose-300">
                Discrepancy discovered during physical plant inspection
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
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
              className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none font-mono"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
                className="w-full px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
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
              className="w-full px-3.5 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-3 border-t border-line/70">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-sunken border border-line text-ink-soft hover:border-line-strong transition cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-bold rounded-xl bg-gradient-to-b from-rose-500 to-rose-700 hover:brightness-105 active:scale-[.98] text-white tactile-2 transition cursor-pointer"
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
