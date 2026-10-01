import React, { useState } from 'react';
import { 
  X, 
  FileText, 
  CheckCircle2, 
  AlertTriangle, 
  ShieldAlert, 
  Clock, 
  User, 
  Send, 
  Check, 
  Info,
  Building2,
  Calendar
} from 'lucide-react';
import { ApprovedIngredient, UnapprovedDiscrepancy, FactoryAuditReport, Venue, User as UserType } from '../types';

interface SubmitAuditReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  venue: Venue | null;
  currentUser: UserType | null;
  ingredients: ApprovedIngredient[];
  discrepancies: UnapprovedDiscrepancy[];
  onSubmitSuccess: (report: FactoryAuditReport) => void;
}

export const SubmitAuditReportModal: React.FC<SubmitAuditReportModalProps> = ({
  isOpen,
  onClose,
  venue,
  currentUser,
  ingredients,
  discrepancies,
  onSubmitSuccess,
}) => {
  const [startTime, setStartTime] = useState('08:30 AM');
  const [endTime, setEndTime] = useState('14:30 PM');
  const [factoryRepresentative, setFactoryRepresentative] = useState('QA Plant Manager');
  const [summaryNotes, setSummaryNotes] = useState('');
  const [mashgiachSigned, setMashgiachSigned] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const totalIngredients = ingredients.length;
  const verifiedPresentCount = ingredients.filter((i) => i.verificationStatus === 'verified_present').length;
  const discrepancyCount = discrepancies.length;

  const defaultStatus: 'passed' | 'passed_with_notes' | 'critical_violation_found' = 
    discrepancyCount > 0 
      ? 'critical_violation_found' 
      : verifiedPresentCount === totalIngredients 
      ? 'passed' 
      : 'passed_with_notes';

  const [status, setStatus] = useState<'passed' | 'passed_with_notes' | 'critical_violation_found'>(defaultStatus);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!venue) return;

    setIsSubmitting(true);
    setError(null);

    const auditedIngredients = ingredients.map((i) => ({
      ingredientId: i.id,
      name: i.name,
      brandOrSupplier: i.brandOrSupplier,
      status: (i.verificationStatus || 'unverified') as any,
      notes: i.verificationNotes,
    }));

    try {
      const res = await fetch('/api/factory-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId: venue.id,
          auditDate: new Date().toISOString().split('T')[0],
          startTime,
          endTime,
          factoryRepresentative,
          auditedIngredients,
          discrepancies,
          summaryNotes: summaryNotes.trim() || 'Comprehensive plant raw materials walkthrough completed.',
          status,
          mashgiachSigned,
          userEmail: currentUser?.email,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit factory audit report.');
      }

      onSubmitSuccess(data.report);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error submitting report.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1a120a]/60 backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line tactile-4 rounded-[28px] w-full max-w-2xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2 shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                Submit Official Factory Kashrut Audit Report
              </h2>
              <p className="text-xs text-ink-faint">
                {venue?.name} • Hartford Kashrut Commission (HKC)
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
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5">
          {error && (
            <div className="p-3.5 rounded-xl text-xs bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Audit Metrics Overview */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3.5 rounded-[20px] bg-sunken border border-line text-center tactile-2">
              <div className="text-xl font-black text-ink">
                {totalIngredients}
              </div>
              <div className="text-[11px] text-ink-faint font-medium">
                Approved Raw Materials
              </div>
            </div>

            <div className="p-3.5 rounded-[20px] bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-center tactile-2">
              <div className="text-xl font-black text-emerald-600 dark:text-emerald-400">
                {verifiedPresentCount}
              </div>
              <div className="text-[11px] text-emerald-800 dark:text-emerald-300 font-medium">
                Verified Compliant
              </div>
            </div>

            <div className={`p-3.5 rounded-[20px] border text-center tactile-2 ${
              discrepancyCount > 0 
                ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/80 text-rose-800 dark:text-rose-300'
                : 'bg-sunken border-line text-ink-soft'
            }`}>
              <div className={`text-xl font-black ${discrepancyCount > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-ink'}`}>
                {discrepancyCount}
              </div>
              <div className="text-[11px] font-medium">
                Unapproved Discrepancies
              </div>
            </div>
          </div>

          {/* Audit Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                Inspection Shift Start
              </label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                <input
                  type="text"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  placeholder="08:30 AM"
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                Inspection Shift End
              </label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                <input
                  type="text"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  placeholder="14:30 PM"
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                Factory Escort / QA Contact
              </label>
              <div className="relative">
                <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                <input
                  type="text"
                  value={factoryRepresentative}
                  onChange={(e) => setFactoryRepresentative(e.target.value)}
                  placeholder="QA Director / Escort"
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
                />
              </div>
            </div>
          </div>

          {/* Audit Determination / Status */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
              Final Kashrut Determination
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setStatus('passed')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'passed'
                    ? 'border-emerald-500 bg-emerald-50/80 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100 ring-1 ring-emerald-500'
                    : 'bg-sunken border-line hover:border-line-strong tactile-1'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">100% Passed</div>
                  <div className="text-[10px] text-ink-faint">
                    All floor materials strictly adhere to approved list.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setStatus('passed_with_notes')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'passed_with_notes'
                    ? 'border-amber-500 bg-amber-50/80 dark:bg-amber-950/40 text-amber-900 dark:text-amber-100 ring-1 ring-amber-500'
                    : 'bg-sunken border-line hover:border-line-strong tactile-1'
                }`}
              >
                <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Passed with Notes</div>
                  <div className="text-[10px] text-ink-faint">
                    Minor inquiry or missing document resolved with QA.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setStatus('critical_violation_found')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'critical_violation_found'
                    ? 'border-rose-500 bg-rose-50/80 dark:bg-rose-950/40 text-rose-900 dark:text-rose-100 ring-1 ring-rose-500'
                    : 'bg-sunken border-line hover:border-line-strong tactile-1'
                }`}
              >
                <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Violation / Quarantined</div>
                  <div className="text-[10px] text-ink-faint">
                    Unapproved raw material found and removed from line.
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Rabbinic & Mashgiach Summary Notes */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
              Mashgiach Observations & Rabbinic Report
            </label>
            <textarea
              rows={4}
              required
              value={summaryNotes}
              onChange={(e) => setSummaryNotes(e.target.value)}
              placeholder="Detail your walk-through observations: storage bay conditions, bulk railcar unloading, CIP sanitization temperatures, packaging lines, and any items questioned or confirmed with plant management..."
              className="w-full px-3.5 py-2.5 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
            />
          </div>

          {/* Mashgiach Signature Block */}
          <div className="p-3.5 rounded-[20px] bg-sunken border border-line tactile-1 flex items-center justify-between">
            <label className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={mashgiachSigned}
                onChange={(e) => setMashgiachSigned(e.target.checked)}
                className="w-4 h-4 rounded accent-gold"
              />
              <span>I hereby certify this report accurately reflects the physical state of the factory</span>
            </label>
            <span className="text-[11px] font-mono text-ink-faint">
              {currentUser?.name || 'Assigned Mashgiach'}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-line/70">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold rounded-xl text-ink-soft hover:bg-sunken transition cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-xs font-bold rounded-xl bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 active:scale-[.98] text-white tactile-2 transition cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Transmitting Report...' : 'File Official Report to Agency'}</span>
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
