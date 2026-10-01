import React, { useState, useEffect } from 'react';
import { 
  X, 
  Factory, 
  Database, 
  ShieldCheck, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Search, 
  Filter, 
  RefreshCw, 
  Plus, 
  FileText, 
  Layers, 
  ShieldAlert, 
  Clock, 
  Calendar, 
  Check, 
  ExternalLink,
  ChevronRight,
  Download,
  Building2,
  Sliders,
  Sparkles,
  Info
} from 'lucide-react';
import { 
  Venue, 
  User as UserType, 
  ApprovedIngredient, 
  UnapprovedDiscrepancy, 
  FactoryAuditReport, 
  AirtableConfig 
} from '../types';
import { AirtableConfigModal } from './AirtableConfigModal';
import { AddDiscrepancyModal } from './AddDiscrepancyModal';
import { SubmitAuditReportModal } from './SubmitAuditReportModal';

interface FactoryAuditHubModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVenue: Venue | null;
  currentUser: UserType | null;
  isAdmin?: boolean;
}

export const FactoryAuditHubModal: React.FC<FactoryAuditHubModalProps> = ({
  isOpen,
  onClose,
  currentVenue,
  currentUser,
  isAdmin = false,
}) => {
  const [activeTab, setActiveTab] = useState<'ingredients' | 'discrepancies' | 'reports'>('ingredients');
  const [ingredients, setIngredients] = useState<ApprovedIngredient[]>([]);
  const [discrepancies, setDiscrepancies] = useState<UnapprovedDiscrepancy[]>([]);
  const [reports, setReports] = useState<FactoryAuditReport[]>([]);
  const [airtableConfig, setAirtableConfig] = useState<AirtableConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [kosherStatusFilter, setKosherStatusFilter] = useState('all');
  const [verificationFilter, setVerificationFilter] = useState<'all' | 'verified_present' | 'unverified' | 'flagged'>('all');

  // Sub-modals
  const [isAirtableModalOpen, setIsAirtableModalOpen] = useState(false);
  const [isAddDiscrepancyOpen, setIsAddDiscrepancyOpen] = useState(false);
  const [isSubmitReportOpen, setIsSubmitReportOpen] = useState(false);
  const [selectedReportToView, setSelectedReportToView] = useState<FactoryAuditReport | null>(null);

  // Status feedback toast
  const [bannerToast, setBannerToast] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);

  const showToast = (text: string, type: 'success' | 'info' | 'error' = 'success') => {
    setBannerToast({ type, text });
    setTimeout(() => setBannerToast(null), 3500);
  };

  const loadData = async () => {
    if (!currentVenue) return;
    setIsLoading(true);
    try {
      // 1. Load Ingredients
      const ingRes = await fetch(`/api/ingredients?venueId=${currentVenue.id}&userEmail=${encodeURIComponent(currentUser?.email || '')}`);
      if (ingRes.ok) {
        const ingData = await ingRes.json();
        setIngredients(ingData.ingredients || []);
      }

      // 2. Load Airtable Config
      const atRes = await fetch(`/api/airtable/config?venueId=${currentVenue.id}&userEmail=${encodeURIComponent(currentUser?.email || '')}`);
      if (atRes.ok) {
        const atData = await atRes.json();
        setAirtableConfig(atData.config || null);
      }

      // 3. Load Reports
      const rptRes = await fetch(`/api/factory-reports?venueId=${currentVenue.id}&userEmail=${encodeURIComponent(currentUser?.email || '')}`);
      if (rptRes.ok) {
        const rptData = await rptRes.json();
        setReports(rptData.reports || []);
      }
    } catch (err) {
      console.error('Failed to load factory data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && currentVenue) {
      loadData();
    }
  }, [isOpen, currentVenue?.id]);

  if (!isOpen || !currentVenue) return null;

  // Filter ingredients
  const filteredIngredients = ingredients.filter((ing) => {
    const matchesSearch =
      ing.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (ing.brandOrSupplier && ing.brandOrSupplier.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (ing.kashrutAgency && ing.kashrutAgency.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (ing.lotOrBatch && ing.lotOrBatch.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesKosher =
      kosherStatusFilter === 'all' || ing.kosherStatus.toLowerCase() === kosherStatusFilter.toLowerCase();

    const matchesVerification =
      verificationFilter === 'all' ||
      (verificationFilter === 'verified_present' && ing.verificationStatus === 'verified_present') ||
      (verificationFilter === 'unverified' && (!ing.verificationStatus || ing.verificationStatus === 'unverified')) ||
      (verificationFilter === 'flagged' && ing.verificationStatus === 'flagged_discrepancy');

    return matchesSearch && matchesKosher && matchesVerification;
  });

  const verifiedPresentCount = ingredients.filter((i) => i.verificationStatus === 'verified_present').length;
  const verifiedPercentage = ingredients.length > 0 ? Math.round((verifiedPresentCount / ingredients.length) * 100) : 0;

  // Verification actions by Mashgiach
  const handleVerifyIngredient = async (ingredientId: string, status: 'verified_present' | 'verified_not_found' | 'unverified' | 'flagged_discrepancy') => {
    try {
      const res = await fetch(`/api/ingredients/${ingredientId}/verify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationStatus: status,
          userEmail: currentUser?.email,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setIngredients((prev) =>
          prev.map((i) => (i.id === ingredientId ? data.ingredient : i))
        );
        if (status === 'verified_present') {
          showToast(`Verified compliant: ${data.ingredient.name}`);
        } else if (status === 'flagged_discrepancy') {
          showToast(`Flagged discrepancy on raw material!`, 'error');
        }
      }
    } catch (err) {
      console.error('Failed to verify ingredient:', err);
    }
  };

  const handleSaveAirtableConfig = async (updated: Partial<AirtableConfig>) => {
    const res = await fetch('/api/airtable/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...updated,
        venueId: currentVenue.id,
        userEmail: currentUser?.email,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update Airtable settings');
    }
    const data = await res.json();
    setAirtableConfig(data.config);
  };

  const handleSyncAirtable = async () => {
    const res = await fetch('/api/airtable/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venueId: currentVenue.id,
        userEmail: currentUser?.email,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to sync Airtable ingredients');
    }
    const data = await res.json();
    setIngredients(data.ingredients || []);
    showToast(`Pulled ${data.count} approved ingredients from Airtable!`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#1a120a]/60 backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line tactile-4 rounded-[28px] w-full max-w-5xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between px-6 py-4.5 border-b border-line/70 bg-sunken/50 gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center tactile-2 shrink-0">
              <Factory className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-ink">
                  Factory Kashrut & Airtable Ingredients Audit
                </h2>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-gold-wash text-gold-ink border border-gold/30">
                  Industrial Plant
                </span>
              </div>
              <p className="text-xs text-ink-faint flex items-center gap-1.5 mt-0.5">
                <Building2 className="w-3.5 h-3.5 text-ink-faint" />
                <span className="font-semibold text-ink-soft">{currentVenue.name}</span>
                <span>•</span>
                <span>Assigned Mashgiach: {currentUser?.name}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto">
            {/* Airtable Sync Button */}
            <button
              onClick={() => setIsAirtableModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl text-amber-700 dark:text-amber-300 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/50 dark:hover:bg-amber-900/50 border border-amber-200 dark:border-amber-800 transition cursor-pointer tactile-1"
              title="Configure or sync Airtable database"
            >
              <Database className="w-3.5 h-3.5 text-amber-600" />
              <span>Airtable Database</span>
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast Banner */}
        {bannerToast && (
          <div className={`px-6 py-2 text-xs font-semibold flex items-center justify-between shrink-0 animate-fade-in ${
            bannerToast.type === 'error'
              ? 'bg-rose-500 text-white'
              : bannerToast.type === 'info'
              ? 'bg-gold-deep text-white'
              : 'bg-emerald-600 text-white'
          }`}>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{bannerToast.text}</span>
            </span>
            <button onClick={() => setBannerToast(null)} className="cursor-pointer text-white/80 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Plant Inspection Dashboard Summary Bar */}
        <div className="px-6 py-3.5 bg-sunken/50 border-b border-line/70 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-ink-faint font-medium">Approved Materials: </span>
              <span className="font-bold text-ink">{ingredients.length} items</span>
            </div>
            <div>
              <span className="text-ink-faint font-medium">Floor Verified: </span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {verifiedPresentCount} ({verifiedPercentage}%)
              </span>
            </div>
            {discrepancies.length > 0 && (
              <div className="flex items-center gap-1 text-rose-600 dark:text-rose-400 font-bold bg-rose-50 dark:bg-rose-950/40 px-2 py-0.5 rounded-lg border border-rose-200 dark:border-rose-900/50">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{discrepancies.length} Unapproved Item(s) Flagged</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsAddDiscrepancyOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/50 border border-rose-200 dark:border-rose-800/80 transition cursor-pointer tactile-2"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
              <span>Flag Unapproved Raw Material</span>
            </button>

            <button
              onClick={() => setIsSubmitReportOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold text-white bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 active:scale-[.98] tactile-2 transition cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Submit Inspection Report</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 py-2.5 border-b border-line/70 bg-surface shrink-0">
          <div className="inline-flex items-center gap-1 bg-sunken rounded-full p-1 max-w-full overflow-x-auto">
            <button
              onClick={() => setActiveTab('ingredients')}
              className={`py-1.5 px-3.5 text-xs font-bold rounded-full flex items-center gap-2 transition cursor-pointer whitespace-nowrap ${
                activeTab === 'ingredients'
                  ? 'bg-gradient-to-b from-gold to-gold-deep text-white tactile-2'
                  : 'text-ink-faint hover:text-ink'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Approved Ingredients Matrix</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                activeTab === 'ingredients'
                  ? 'bg-white/25 text-white'
                  : 'bg-surface text-ink-faint border border-line/70'
              }`}>
                {ingredients.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('discrepancies')}
              className={`py-1.5 px-3.5 text-xs font-bold rounded-full flex items-center gap-2 transition cursor-pointer whitespace-nowrap ${
                activeTab === 'discrepancies'
                  ? 'bg-gradient-to-b from-gold to-gold-deep text-white tactile-2'
                  : 'text-ink-faint hover:text-ink'
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
              <span>Unapproved Materials Log</span>
              {discrepancies.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-black">
                  {discrepancies.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('reports')}
              className={`py-1.5 px-3.5 text-xs font-bold rounded-full flex items-center gap-2 transition cursor-pointer whitespace-nowrap ${
                activeTab === 'reports'
                  ? 'bg-gradient-to-b from-gold to-gold-deep text-white tactile-2'
                  : 'text-ink-faint hover:text-ink'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>Official Factory Reports</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                activeTab === 'reports'
                  ? 'bg-white/25 text-white'
                  : 'bg-surface text-ink-faint border border-line/70'
              }`}>
                {reports.length}
              </span>
            </button>
          </div>
        </div>

        {/* Tab 1: Approved Ingredients Matrix */}
        {activeTab === 'ingredients' && (
          <div className="flex-1 flex flex-col min-h-0 p-6 overflow-hidden">
            {/* Search and Filters Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4 shrink-0">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-faint" />
                <input
                  type="text"
                  placeholder="Search raw material name, supplier, lot #, or kosher agency..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-faint focus:border-gold focus:ring-2 focus:ring-gold/20 outline-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={kosherStatusFilter}
                  onChange={(e) => setKosherStatusFilter(e.target.value)}
                  className="px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink-soft font-semibold cursor-pointer focus:border-gold outline-none"
                >
                  <option value="all">All Kosher Types</option>
                  <option value="parve">Parve</option>
                  <option value="dairy">Dairy</option>
                  <option value="meat">Meat</option>
                  <option value="cholov yisroel">Cholov Yisroel</option>
                  <option value="pas yisroel">Pas Yisroel</option>
                </select>

                <select
                  value={verificationFilter}
                  onChange={(e) => setVerificationFilter(e.target.value as any)}
                  className="px-3 py-2 text-xs rounded-xl bg-sunken border border-line text-ink-soft font-semibold cursor-pointer focus:border-gold outline-none"
                >
                  <option value="all">All Verification States</option>
                  <option value="verified_present">✓ Verified Present</option>
                  <option value="unverified">⏳ Unverified / Pending</option>
                  <option value="flagged">⚠ Flagged Discrepancy</option>
                </select>
              </div>
            </div>

            {/* Ingredients Table */}
            <div className="flex-1 overflow-y-auto border border-line rounded-[20px] bg-surface tactile-1">
              {filteredIngredients.length === 0 ? (
                <div className="p-12 text-center text-ink-faint">
                  <Database className="w-10 h-10 mx-auto mb-2 text-ink-faint" />
                  <p className="text-sm font-bold text-ink-soft">
                    No matching approved raw materials found.
                  </p>
                  <p className="text-xs text-ink-faint mt-1">
                    Try adjusting search terms or click "Airtable Database" to pull the latest ingredients.
                  </p>
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-sunken text-ink-soft border-b border-line sticky top-0 z-10 font-bold uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Raw Material / Ingredient</th>
                      <th className="py-2.5 px-3">Manufacturer / Supplier</th>
                      <th className="py-2.5 px-3">Kosher Agency</th>
                      <th className="py-2.5 px-3">Designation</th>
                      <th className="py-2.5 px-3">Lot / Batch</th>
                      <th className="py-2.5 px-3">Floor Audit Status</th>
                      <th className="py-2.5 px-3 text-right">Mashgiach Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {filteredIngredients.map((item) => {
                      const isVerified = item.verificationStatus === 'verified_present';
                      const isFlagged = item.verificationStatus === 'flagged_discrepancy';

                      return (
                        <tr 
                          key={item.id} 
                          className={`hover:bg-sunken/60 transition ${
                            isVerified ? 'bg-emerald-50/20 dark:bg-emerald-950/10' : ''
                          }`}
                        >
                          <td className="py-3 px-3">
                            <div className="font-bold text-ink">
                              {item.name}
                            </div>
                            {item.notes && (
                              <div className="text-[11px] text-ink-faint mt-0.5 line-clamp-1 italic">
                                {item.notes}
                              </div>
                            )}
                          </td>

                          <td className="py-3 px-3 text-ink-soft">
                            {item.brandOrSupplier || '—'}
                          </td>

                          <td className="py-3 px-3">
                            <span className="font-semibold text-ink-soft">
                              {item.kashrutAgency || 'HKC Approved'}
                            </span>
                          </td>

                          <td className="py-3 px-3">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                              item.kosherStatus === 'Dairy'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
                                : item.kosherStatus === 'Meat'
                                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                                : item.kosherStatus === 'Cholov Yisroel'
                                ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300'
                                : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            }`}>
                              {item.kosherStatus}
                            </span>
                          </td>

                          <td className="py-3 px-3 font-mono text-[11px] text-ink-faint">
                            {item.lotOrBatch || '—'}
                          </td>

                          <td className="py-3 px-3">
                            {isVerified ? (
                              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-bold">
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Present on Floor</span>
                              </div>
                            ) : isFlagged ? (
                              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400 font-bold">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>Discrepancy</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 text-ink-faint font-medium">
                                <Clock className="w-3.5 h-3.5 shrink-0" />
                                <span>Pending Check</span>
                              </div>
                            )}
                            {item.verifiedByName && (
                              <div className="text-[10px] text-ink-faint">
                                by {item.verifiedByName}
                              </div>
                            )}
                          </td>

                          <td className="py-3 px-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              {isVerified ? (
                                <button
                                  onClick={() => handleVerifyIngredient(item.id, 'unverified')}
                                  className="px-2 py-1 text-[11px] rounded-lg bg-sunken border border-line text-ink-soft hover:border-line-strong transition cursor-pointer"
                                  title="Reset check state"
                                >
                                  Undo
                                </button>
                              ) : (
                                <>
                                  <button
                                    onClick={() => handleVerifyIngredient(item.id, 'verified_present')}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition cursor-pointer tactile-2"
                                    title="Mark present & verified in factory"
                                  >
                                    <Check className="w-3 h-3" />
                                    <span>Verify</span>
                                  </button>

                                  <button
                                    onClick={() => handleVerifyIngredient(item.id, 'flagged_discrepancy')}
                                    className="p-1 rounded-lg text-ink-faint hover:text-rose-600 hover:bg-rose-500/10 transition cursor-pointer"
                                    title="Flag discrepancy"
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Unapproved Materials Log */}
        {activeTab === 'discrepancies' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-ink">
                  Physical Plant Unauthorized Materials Log
                </h3>
                <p className="text-xs text-ink-faint">
                  Ingredients, processing aids, or flavorings found in the factory that are NOT on the agency-approved list.
                </p>
              </div>

              <button
                onClick={() => setIsAddDiscrepancyOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 hover:brightness-105 active:scale-[.98] transition cursor-pointer tactile-2"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Log Unapproved Material</span>
              </button>
            </div>

            {discrepancies.length === 0 ? (
              <div className="p-12 text-center border border-dashed border-line rounded-[20px] bg-sunken/50">
                <ShieldCheck className="w-12 h-12 mx-auto mb-2 text-emerald-500" />
                <h4 className="text-sm font-bold text-ink-soft">
                  Clean Slate: No Unauthorized Materials Reported
                </h4>
                <p className="text-xs text-ink-faint max-w-md mx-auto mt-1">
                  Mashgiach inspections have not found unapproved chemicals, raw materials, or non-kosher products on this facility's floor.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {discrepancies.map((disc) => (
                  <div 
                    key={disc.id} 
                    className="p-4 rounded-[20px] border border-rose-200 dark:border-rose-900/50 bg-rose-50/40 dark:bg-rose-950/20 space-y-2 tactile-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full uppercase bg-rose-100 text-rose-800 dark:bg-rose-900/80 dark:text-rose-200">
                          {disc.severity} Violation
                        </span>
                        <h4 className="text-sm font-bold text-ink">
                          {disc.name}
                        </h4>
                      </div>
                      <span className="text-[11px] text-ink-faint font-mono">
                        {new Date(disc.reportedAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-ink-soft">
                      <div>
                        <span className="text-ink-faint">Supplier:</span> {disc.brandOrSupplier || 'Unknown'}
                      </div>
                      <div>
                        <span className="text-ink-faint">Location:</span> {disc.locationInFactory}
                      </div>
                      <div>
                        <span className="text-ink-faint">Action:</span> {disc.actionTaken}
                      </div>
                    </div>

                    <p className="text-xs text-ink-soft bg-surface/80 p-2.5 rounded-lg border border-rose-100 dark:border-rose-900/30">
                      {disc.notes}
                    </p>

                    <div className="text-[10px] text-ink-faint flex items-center justify-between pt-1">
                      <span>Reported by Mashgiach: {disc.reportedByName}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Official Factory Reports */}
        {activeTab === 'reports' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-ink">
                  Factory Audit Reports Archive
                </h3>
                <p className="text-xs text-ink-faint">
                  Transmitted inspection summaries, signed Mashgiach logs, and Rabbinic conclusions.
                </p>
              </div>

              <button
                onClick={() => setIsSubmitReportOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-gradient-to-b from-gold to-gold-deep hover:brightness-105 active:scale-[.98] tactile-2 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>File New Inspection Report</span>
              </button>
            </div>

            {reports.length === 0 ? (
              <div className="p-12 text-center border border-dashed border-line rounded-[20px] bg-sunken/50">
                <FileText className="w-12 h-12 mx-auto mb-2 text-ink-faint" />
                <h4 className="text-sm font-bold text-ink-soft">
                  No Audit Reports Filed Yet
                </h4>
                <p className="text-xs text-ink-faint max-w-md mx-auto mt-1">
                  Once the Mashgiach verifies floor ingredients, click "Submit Inspection Report" to archive official findings.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {reports.map((rpt) => (
                  <div
                    key={rpt.id}
                    className="p-4 rounded-[20px] border border-line bg-surface hover:border-line-strong transition space-y-2.5 tactile-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className={`text-[10px] font-black uppercase px-2.5 py-0.5 rounded-full ${
                          rpt.status === 'passed'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            : rpt.status === 'critical_violation_found'
                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                        }`}>
                          {rpt.status.replace(/_/g, ' ')}
                        </span>
                        <h4 className="text-sm font-bold text-ink">
                          Audit on {rpt.auditDate} ({rpt.startTime} – {rpt.endTime})
                        </h4>
                      </div>

                      <div className="text-xs text-ink-faint font-mono">
                        Report #{rpt.id.slice(-6)}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <div className="p-2 rounded-xl bg-sunken">
                        <span className="text-ink-faint block text-[10px]">Approved Checked:</span>
                        <span className="font-bold text-ink">{rpt.totalApprovedChecked} items</span>
                      </div>

                      <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40">
                        <span className="text-emerald-600 block text-[10px]">Verified Present:</span>
                        <span className="font-bold text-emerald-800 dark:text-emerald-200">{rpt.totalPresent} items</span>
                      </div>

                      <div className="p-2 rounded-xl bg-rose-50 dark:bg-rose-950/40">
                        <span className="text-rose-600 block text-[10px]">Unapproved Found:</span>
                        <span className="font-bold text-rose-800 dark:text-rose-200">{rpt.totalDiscrepancies}</span>
                      </div>

                      <div className="p-2 rounded-xl bg-sunken">
                        <span className="text-ink-faint block text-[10px]">Plant QA Escort:</span>
                        <span className="font-bold text-ink truncate block">{rpt.factoryRepresentative || 'QA Manager'}</span>
                      </div>
                    </div>

                    <p className="text-xs text-ink-soft leading-relaxed italic border-l-2 border-gold pl-3 py-0.5">
                      "{rpt.summaryNotes}"
                    </p>

                    <div className="flex items-center justify-between text-[11px] text-ink-faint pt-1 border-t border-line/70">
                      <span>Mashgiach Signoff: {rpt.mashgiachName}</span>
                      {rpt.signatureTimestamp && (
                        <span>Signed {new Date(rpt.signatureTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-line/70 bg-sunken/50 flex items-center justify-between text-xs text-ink-faint shrink-0">
          <span>Hartford Kashrut Commission (HKC) • Industrial Manufacturing Compliance Engine</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl font-bold bg-sunken border border-line text-ink-soft hover:border-line-strong transition cursor-pointer"
          >
            Done
          </button>
        </div>

      </div>

      {/* Sub-modals */}
      <AirtableConfigModal
        isOpen={isAirtableModalOpen}
        onClose={() => setIsAirtableModalOpen(false)}
        config={airtableConfig}
        venueName={currentVenue.name}
        venueId={currentVenue.id}
        onSaveConfig={handleSaveAirtableConfig}
        onSyncNow={handleSyncAirtable}
        isAdmin={isAdmin}
      />

      <AddDiscrepancyModal
        isOpen={isAddDiscrepancyOpen}
        onClose={() => setIsAddDiscrepancyOpen(false)}
        currentUser={currentUser}
        onAddDiscrepancy={(d) => {
          setDiscrepancies((prev) => [d, ...prev]);
          showToast(`Logged unapproved item: ${d.name}`, 'error');
        }}
      />

      <SubmitAuditReportModal
        isOpen={isSubmitReportOpen}
        onClose={() => setIsSubmitReportOpen(false)}
        venue={currentVenue}
        currentUser={currentUser}
        ingredients={ingredients}
        discrepancies={discrepancies}
        onSubmitSuccess={(report) => {
          setReports((prev) => [report, ...prev]);
          setActiveTab('reports');
          showToast('Official Factory Inspection Report submitted successfully!');
        }}
      />
    </div>
  );
};
