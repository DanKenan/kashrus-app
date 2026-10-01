import React, { useState } from 'react';
import { 
  X, 
  Database, 
  Key, 
  Table, 
  Eye, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink, 
  Sliders, 
  HelpCircle,
  Layers,
  Sparkles
} from 'lucide-react';
import { AirtableConfig } from '../types';

interface AirtableConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AirtableConfig | null;
  venueName?: string;
  venueId?: string;
  onSaveConfig: (updated: Partial<AirtableConfig>) => Promise<void>;
  onSyncNow: () => Promise<void>;
  isAdmin?: boolean;
}

export const AirtableConfigModal: React.FC<AirtableConfigModalProps> = ({
  isOpen,
  onClose,
  config,
  venueName,
  venueId,
  onSaveConfig,
  onSyncNow,
  isAdmin = true,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [baseId, setBaseId] = useState(config?.baseId || '');
  const [tableName, setTableName] = useState(config?.tableName || 'Approved Ingredients');
  const [viewName, setViewName] = useState(config?.viewName || 'Grid view');
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // Field mappings
  const [ingredientNameField, setIngredientNameField] = useState(
    config?.fieldNameMapping?.ingredientName || 'Ingredient Name'
  );
  const [supplierField, setSupplierField] = useState(
    config?.fieldNameMapping?.brandOrSupplier || 'Manufacturer / Supplier'
  );
  const [agencyField, setAgencyField] = useState(
    config?.fieldNameMapping?.kashrutAgency || 'Kosher Certification Body'
  );
  const [kosherStatusField, setKosherStatusField] = useState(
    config?.fieldNameMapping?.kosherStatus || 'Kosher Designation'
  );
  const [lotField, setLotField] = useState(
    config?.fieldNameMapping?.lotNumber || 'Lot / Batch Number'
  );
  const [notesField, setNotesField] = useState(
    config?.fieldNameMapping?.notes || 'Mashgiach Notes'
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await onSaveConfig({
        baseId: baseId.trim(),
        tableName: tableName.trim(),
        viewName: viewName.trim(),
        apiKey: apiKey.trim() || undefined,
        fieldNameMapping: {
          ingredientName: ingredientNameField.trim(),
          brandOrSupplier: supplierField.trim(),
          kashrutAgency: agencyField.trim(),
          kosherStatus: kosherStatusField.trim(),
          lotNumber: lotField.trim(),
          notes: notesField.trim(),
        },
      });
      setStatusMessage({ type: 'success', text: 'Airtable connection settings updated successfully!' });
      setApiKey('');
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to save Airtable settings.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    setStatusMessage(null);
    try {
      await onSyncNow();
      setStatusMessage({ type: 'success', text: 'Ingredients pulled from Airtable database!' });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Sync failed.' });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs overflow-y-auto animate-fade-in">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 my-8 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-100 dark:border-slate-800 shrink-0 bg-slate-50/70 dark:bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center border border-orange-500/20">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <span>Airtable Ingredients Integration</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300">
                  Live Sync
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {venueName ? `Linked to factory: ${venueName}` : 'Kosher Agency Approved Raw Materials'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-5">
          {statusMessage && (
            <div
              className={`p-3.5 rounded-xl text-xs flex items-center gap-2.5 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Quick Explanation Banner */}
          <div className="p-4 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900/40 text-xs text-blue-900 dark:text-blue-200 space-y-1.5">
            <div className="font-bold flex items-center gap-1.5 text-blue-800 dark:text-blue-300">
              <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>How Mashgichim Use Your Airtable Database:</span>
            </div>
            <p className="text-blue-700/90 dark:text-blue-300/90 leading-relaxed">
              When a factory submits raw materials and ingredients to your kosher agency, your approved Airtable table syncs directly into the assigned Mashgiach's dashboard. On-site at the factory, the Mashgiach verifies physical sacks/drums against these records, flags unauthorized ingredients, and submits compliance reports.
            </p>
          </div>

          {/* Form Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Airtable Base ID *
              </label>
              <div className="relative">
                <Table className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  required
                  placeholder="appXXXXXXXXXXXXXX"
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono"
                />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Found in your Airtable URL: airtable.com/<b>app...</b>
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Table Name *
              </label>
              <input
                type="text"
                required
                placeholder="Approved Ingredients"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <p className="text-[10px] text-slate-400 mt-1">
                Exact name of the table tab in Airtable
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Airtable View Name (Optional)
              </label>
              <div className="relative">
                <Eye className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Grid view"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center justify-between">
                <span>Personal Access Token (PAT)</span>
                {config && (config as any).hasApiKey && (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">● Active</span>
                )}
              </label>
              <div className="relative">
                <Key className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="password"
                  placeholder={(config as any)?.hasApiKey ? "●●●●●●●● (Token saved)" : "patXXXXXXXX.XXXXXX"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 text-xs rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono"
                />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Generated in Airtable Developer Hub with <code className="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">data.records:read</code> scope
              </p>
            </div>
          </div>

          {/* Collapsible Column Field Mapping */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
              className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-800/50 text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-left cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-orange-500" />
                <span>Customize Column / Field Names (Match your Airtable Header)</span>
              </span>
              <span className="text-[11px] text-orange-600 dark:text-orange-400 font-semibold">
                {isAdvancedOpen ? 'Hide Columns' : 'Customize Columns'}
              </span>
            </button>

            {isAdvancedOpen && (
              <div className="p-4 space-y-3 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Specify the exact column names from your Airtable base so the application can map them accurately:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Ingredient Name Column
                    </label>
                    <input
                      type="text"
                      value={ingredientNameField}
                      onChange={(e) => setIngredientNameField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Supplier / Manufacturer Column
                    </label>
                    <input
                      type="text"
                      value={supplierField}
                      onChange={(e) => setSupplierField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Kosher Certification Body Column
                    </label>
                    <input
                      type="text"
                      value={agencyField}
                      onChange={(e) => setAgencyField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Kosher Designation (Parve / Dairy / Meat)
                    </label>
                    <input
                      type="text"
                      value={kosherStatusField}
                      onChange={(e) => setKosherStatusField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Lot / Batch Number Column
                    </label>
                    <input
                      type="text"
                      value={lotField}
                      onChange={(e) => setLotField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">
                      Notes / Instructions Column
                    </label>
                    <input
                      type="text"
                      value={notesField}
                      onChange={(e) => setNotesField(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sync status info */}
          {config?.lastSyncedAt && (
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1">
              <span>Last synchronized with Airtable:</span>
              <span className="font-semibold text-slate-700 dark:text-slate-200 font-mono">
                {new Date(config.lastSyncedAt).toLocaleString()}
              </span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800 gap-3">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-950/50 hover:bg-orange-100 dark:hover:bg-orange-900/50 border border-orange-200 dark:border-orange-800 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Syncing...' : 'Sync From Airtable Now'}</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                Close
              </button>

              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-bold rounded-xl bg-orange-600 hover:bg-orange-700 text-white shadow-md shadow-orange-600/20 transition cursor-pointer disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </form>

      </div>
    </div>
  );
};
