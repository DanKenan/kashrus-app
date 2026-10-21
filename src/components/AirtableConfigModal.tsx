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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-scrim backdrop-blur-sm overflow-y-auto animate-fade-in">
      <div className="bg-surface border border-line e3 rounded-2xl w-full max-w-2xl my-4 sm:my-8 overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-line/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-sunken text-ink-soft flex items-center justify-center e2 shrink-0">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink flex items-center gap-2">
                <span>Airtable Ingredients Integration</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-bold uppercase bg-gold-wash text-gold-ink border border-gold/30">
                  Live Sync
                </span>
              </h2>
              <p className="text-sm text-ink-soft">
                {venueName ? `Linked to factory: ${venueName}` : 'Kosher Agency Approved Raw Materials'}
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

        {/* Content */}
        <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-5">
          {statusMessage && (
            <div
              className={`p-3.5 rounded-xl text-xs flex items-center gap-2.5 ${
                statusMessage.type === 'success'
                  ? 'bg-ok-bg text-ok border border-ok'
                  : 'bg-bad-bg text-bad border border-bad'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-ok" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-bad" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Quick Explanation Banner */}
          <div className="p-4 rounded-2xl bg-gold-wash/60 border border-gold/30 text-xs text-ink space-y-1.5 e1">
            <div className="font-bold flex items-center gap-1.5 text-gold-ink">
              <Sparkles className="w-4 h-4 text-gold-deep" />
              <span>How Mashgichim Use Your Airtable Database:</span>
            </div>
            <p className="text-ink-soft leading-relaxed">
              When a factory submits raw materials and ingredients to your kosher agency, your approved Airtable table syncs directly into the assigned Mashgiach's dashboard. On-site at the factory, the Mashgiach verifies physical sacks/drums against these records, flags unauthorized ingredients, and submits compliance reports.
            </p>
          </div>

          {/* Form Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Airtable Base ID *
              </label>
              <div className="relative">
                <Table className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  required
                  placeholder="appXXXXXXXXXXXXXX"
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none font-mono bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
              <p className="text-sm text-ink-soft mt-1">
                Found in your Airtable URL: airtable.com/<b>app...</b>
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Table Name *
              </label>
              <input
                type="text"
                required
                placeholder="Approved Ingredients"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                className="w-full px-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
              />
              <p className="text-sm text-ink-soft mt-1">
                Exact name of the table tab in Airtable
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                Airtable View Name (Optional)
              </label>
              <div className="relative">
                <Eye className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="text"
                  placeholder="Grid view"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1 flex items-center justify-between">
                <span>Personal Access Token (PAT)</span>
                {config && (config as any).hasApiKey && (
                  <span className="text-xs text-ok font-bold tracking-normal">● Active</span>
                )}
              </label>
              <div className="relative">
                <Key className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-soft" />
                <input
                  type="password"
                  placeholder={(config as any)?.hasApiKey ? "●●●●●●●● (Token saved)" : "patXXXXXXXX.XXXXXX"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full pl-8.5 pr-3 py-2 border text-ink placeholder:text-ink-soft focus:outline-none font-mono bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                />
              </div>
              <p className="text-sm text-ink-soft mt-1">
                Generated in Airtable Developer Hub with <code className="bg-sunken border border-line px-1 py-0.5 rounded font-mono">data.records:read</code> scope
              </p>
            </div>
          </div>

          {/* Collapsible Column Field Mapping */}
          <div className="bg-sunken border border-line rounded-2xl overflow-hidden e1">
            <button
              type="button"
              onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-bold transition text-left cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              <span className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5 text-gold-deep" />
                <span>Customize Column / Field Names (Match your Airtable Header)</span>
              </span>
              <span className="text-xs text-gold-ink font-semibold">
                {isAdvancedOpen ? 'Hide Columns' : 'Customize Columns'}
              </span>
            </button>

            {isAdvancedOpen && (
              <div className="p-4 space-y-3 border-t border-line/70">
                <p className="text-sm text-ink-soft">
                  Specify the exact column names from your Airtable base so the application can map them accurately:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Ingredient Name Column
                    </label>
                    <input
                      type="text"
                      value={ingredientNameField}
                      onChange={(e) => setIngredientNameField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Supplier / Manufacturer Column
                    </label>
                    <input
                      type="text"
                      value={supplierField}
                      onChange={(e) => setSupplierField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Kosher Certification Body Column
                    </label>
                    <input
                      type="text"
                      value={agencyField}
                      onChange={(e) => setAgencyField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Kosher Designation (Parve / Dairy / Meat)
                    </label>
                    <input
                      type="text"
                      value={kosherStatusField}
                      onChange={(e) => setKosherStatusField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Lot / Batch Number Column
                    </label>
                    <input
                      type="text"
                      value={lotField}
                      onChange={(e) => setLotField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      Notes / Instructions Column
                    </label>
                    <input
                      type="text"
                      value={notesField}
                      onChange={(e) => setNotesField(e.target.value)}
                      className="w-full px-2.5 py-1.5 border text-ink focus:outline-none bg-surface border-line-control rounded-lg text-base focus:ring-2 focus:ring-gold/40 focus:border-gold"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sync status info */}
          {config?.lastSyncedAt && (
            <div className="flex items-center justify-between text-xs text-ink-soft pt-1">
              <span>Last synchronized with Airtable:</span>
              <span className="font-semibold text-ink-soft font-mono">
                {new Date(config.lastSyncedAt).toLocaleString()}
              </span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-line/70 gap-3">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl hover:brightness-95 e1 transition cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Syncing...' : 'Sync From Airtable Now'}</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold rounded-xl transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
              >
                Close
              </button>

              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-bold rounded-xl e2 hover:brightness-105 active:scale-[.98] transition cursor-pointer disabled:opacity-50 bg-gold-deep text-paper"
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
