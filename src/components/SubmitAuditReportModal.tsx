import React, { useState, useEffect, useRef } from 'react';
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
import { formatClockTime } from '../lib/clockTime';
import { apiFetch } from '../lib/api';

/** QA2 #6: a plain reason when filing the report fails (never a silent no-op). */
export function reportFailText(status: number, serverText?: unknown): string {
  if (status === 403) {
    return "Your account can't file this report. Ask your agency admin.";
  }
  if (typeof serverText === 'string' && serverText.trim()) return serverText.trim();
  if (status === 0) return "The report wasn't sent. Check your connection and try again.";
  return 'The report could not be filed. Please try again.';
}

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
  const [startTime, setStartTime] = useState('8:30 AM');
  const [endTime, setEndTime] = useState('2:30 PM');
  const [factoryRepresentative, setFactoryRepresentative] = useState('');
  const [summaryNotes, setSummaryNotes] = useState('');
  // QA2 #12: nothing is pre-filled or pre-ticked; the person ticks the box themselves.
  const [mashgiachSigned, setMashgiachSigned] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  const totalIngredients = ingredients.length;
  const verifiedPresentCount = ingredients.filter((i) => i.verificationStatus === 'verified_present').length;
  const discrepancyCount = discrepancies.length;

  const defaultStatus: 'passed' | 'passed_with_notes' | 'critical_violation_found' = 
    discrepancyCount > 0 
      ? 'critical_violation_found' 
      : verifiedPresentCount === totalIngredients 
      ? 'passed' 
      : 'passed_with_notes';

  const [status, setStatus] = useState<'passed' | 'passed_with_notes' | 'critical_violation_found'>(() => defaultStatus);

  useEffect(() => {
    if (isOpen) setStatus(defaultStatus);
  }, [isOpen]);

  if (!isOpen) return null;

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
      const res = await apiFetch('/api/factory-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId: venue.id,
          auditDate: new Date().toISOString().split('T')[0],
          startTime: formatClockTime(startTime),
          endTime: formatClockTime(endTime),
          factoryRepresentative,
          auditedIngredients,
          discrepancies,
          summaryNotes: summaryNotes.trim() || 'Comprehensive plant raw materials walkthrough completed.',
          status,
          mashgiachSigned,
          userEmail: currentUser?.email,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(reportFailText(res.status, data?.error));
      }

      onSubmitSuccess(data.report);
      onClose();
    } catch (err: any) {
      setError(err?.message || reportFailText(0));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line e3 rounded-2xl w-full max-w-2xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-sunken text-ink-soft flex items-center justify-center e2 shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                Submit Official Factory Kashrut Audit Report
              </h2>
              <p className="text-sm text-ink-soft">
                {venue?.name} • Hartford Kashrut Commission (HKC)
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
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5">
          {/* Audit Metrics Overview */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3.5 rounded-2xl bg-sunken border border-line text-center e2">
              <div className="text-xl font-bold text-ink">
                {totalIngredients}
              </div>
              <div className="text-xs text-ink-soft font-medium">
                Approved Raw Materials
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-ok-bg border border-ok text-center e2">
              <div className="text-xl font-bold text-ok">
                {verifiedPresentCount}
              </div>
              <div className="text-xs text-ok font-medium">
                Verified Compliant
              </div>
            </div>

            <div className={`p-3.5 rounded-2xl border text-center e2 ${
              discrepancyCount > 0 
                ? 'bg-bad-bg border-bad text-bad'
                : 'bg-sunken border-line text-ink-soft'
            }`}>
              <div className={`text-xl font-bold ${discrepancyCount > 0 ? 'text-bad' : 'text-ink'}`}>
                {discrepancyCount}
              </div>
              <div className="text-xs font-medium">
                Unapproved Discrepancies
              </div>
            </div>
          </div>

          {/* Audit Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Inspection Shift Start
              </label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  onBlur={() => setStartTime((t) => formatClockTime(t))}
                  placeholder="8:30 AM"
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Inspection Shift End
              </label>
              <div className="relative">
                <Clock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  onBlur={() => setEndTime((t) => formatClockTime(t))}
                  placeholder="2:30 PM"
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Plant contact (optional)
              </label>
              <div className="relative">
                <User className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  value={factoryRepresentative}
                  onChange={(e) => setFactoryRepresentative(e.target.value)}
                  placeholder="Name"
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>
          </div>

          {/* Audit Determination / Status */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
              Final Kashrut Determination
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setStatus('passed')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'passed'
                    ? 'border-ok bg-ok-bg text-ok ring-1 ring-ok'
                    : 'bg-surface border-line-control text-ink hover:bg-sunken e1'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 text-ok shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">100% Passed</div>
                  <div className="text-xs text-ink-soft">
                    All floor materials strictly adhere to approved list.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setStatus('passed_with_notes')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'passed_with_notes'
                    ? 'border-warn bg-warn-bg text-warn ring-1 ring-warn'
                    : 'bg-surface border-line-control text-ink hover:bg-sunken e1'
                }`}
              >
                <Info className="w-4 h-4 text-warn shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Passed with Notes</div>
                  <div className="text-xs text-ink-soft">
                    Minor inquiry or missing document resolved with QA.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setStatus('critical_violation_found')}
                className={`p-3 rounded-xl border text-left flex items-start gap-2.5 transition cursor-pointer ${
                  status === 'critical_violation_found'
                    ? 'border-bad bg-bad-bg text-bad ring-1 ring-bad'
                    : 'bg-surface border-line-control text-ink hover:bg-sunken e1'
                }`}
              >
                <ShieldAlert className="w-4 h-4 text-bad shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold">Violation / Quarantined</div>
                  <div className="text-xs text-ink-soft">
                    Unapproved raw material found and removed from line.
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Rabbinic & Mashgiach Summary Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
              Mashgiach Observations & Rabbinic Report
            </label>
            <textarea
              rows={4}
              required
              value={summaryNotes}
              onChange={(e) => setSummaryNotes(e.target.value)}
              placeholder="Detail your walk-through observations: storage bay conditions, bulk railcar unloading, CIP sanitization temperatures, packaging lines, and any items questioned or confirmed with plant management..."
              className="w-full px-3.5 py-2.5 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
            />
          </div>

          {/* Mashgiach Signature Block */}
          <div className="p-3.5 rounded-2xl bg-sunken border border-line e1 flex items-center justify-between">
            <label className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={mashgiachSigned}
                onChange={(e) => setMashgiachSigned(e.target.checked)}
                className="w-4 h-4 accent-gold cursor-pointer"
              />
              <span>I hereby certify this report accurately reflects the physical state of the factory</span>
            </label>
            <span className="text-xs font-mono text-ink-soft">
              {currentUser?.name || 'Assigned Mashgiach'}
            </span>
          </div>

          {/* QA2 #6: the error shows right above the button that was tapped
              (it used to sit at the top of this long, scrolled form). */}
          {error && (
            <div ref={errorRef} role="alert" className="p-3.5 rounded-xl text-xs bg-bad-bg text-bad border border-bad flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-bad shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Actions */}
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
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-xs font-bold rounded-xl hover:brightness-105 active:scale-[.98] e2 transition cursor-pointer disabled:opacity-50 bg-gold-deep text-paper"
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
