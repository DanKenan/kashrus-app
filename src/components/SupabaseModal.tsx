import React, { useState } from 'react';
import { X, Database, Copy, Check, Shield, Zap, Terminal, Download } from 'lucide-react';
import { SUPABASE_SQL_SCHEMA } from '../lib/sqlSchema';
import { getSupabaseConfig, saveSupabaseConfig, clearSupabaseConfig } from '../lib/supabaseClient';

interface SupabaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SupabaseModal: React.FC<SupabaseModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'sql' | 'rls' | 'connect'>('sql');
  const [copied, setCopied] = useState(false);
  
  const config = getSupabaseConfig();
  const [urlInput, setUrlInput] = useState(config.url || '');
  const [keyInput, setKeyInput] = useState(config.anonKey || '');
  const [saveSuccess, setSaveSuccess] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(SUPABASE_SQL_SCHEMA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSQL = () => {
    const element = document.createElement('a');
    const file = new Blob([SUPABASE_SQL_SCHEMA], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = 'workpulse_supabase_schema.sql';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    saveSupabaseConfig(urlInput, keyInput);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  const handleClear = () => {
    clearSupabaseConfig();
    setUrlInput('');
    setKeyInput('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs overflow-y-auto animate-fade-in">
      <div className="bg-surface rounded-2xl w-full max-w-4xl tactile-5 border border-line my-8 overflow-hidden flex flex-col max-h-[88vh] animate-slide-up">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                Supabase Backend Integration & SQL Schema
              </h2>
              <p className="text-xs text-ink-soft">
                Production-ready PostgreSQL tables, RLS security policies, real-time replication, and midnight triggers.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 px-6 border-b border-line bg-sunken/60 text-xs font-semibold shrink-0">
          <button
            onClick={() => setActiveTab('sql')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'sql'
                ? 'border-emerald-600 text-emerald-600 dark:text-emerald-400'
                : 'border-transparent text-ink-faint hover:text-ink'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" /> Complete SQL Migration
          </button>
          <button
            onClick={() => setActiveTab('rls')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'rls'
                ? 'border-emerald-600 text-emerald-600 dark:text-emerald-400'
                : 'border-transparent text-ink-faint hover:text-ink'
            }`}
          >
            <Shield className="w-3.5 h-3.5" /> RLS Policies & Roles
          </button>
          <button
            onClick={() => setActiveTab('connect')}
            className={`py-3 px-3 border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'connect'
                ? 'border-emerald-600 text-emerald-600 dark:text-emerald-400'
                : 'border-transparent text-ink-faint hover:text-ink'
            }`}
          >
            <Zap className="w-3.5 h-3.5" /> Live Connection & Keys
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6 text-xs text-ink-soft">
          
          {/* TAB 1: Complete SQL Schema */}
          {activeTab === 'sql' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-ink">
                    One-Click PostgreSQL Migration Script
                  </p>
                  <p className="text-ink-soft text-[11px]">
                    Paste this into the Supabase SQL Editor (Dashboard → SQL Editor) to provision all 4 tables, triggers, and replication.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDownloadSQL}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line bg-surface hover:bg-sunken text-ink-soft pressable font-medium cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" /> Download .sql
                  </button>

                  <button
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg pressable bg-emerald-600 hover:bg-emerald-700 text-white font-medium tactile-1 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied to Clipboard!' : 'Copy SQL'}</span>
                  </button>
                </div>
              </div>

              <div className="rounded-xl overflow-hidden border border-line bg-slate-950 text-slate-200 font-mono text-[11px] p-4 max-h-96 overflow-y-auto leading-relaxed">
                <pre>{SUPABASE_SQL_SCHEMA}</pre>
              </div>
            </div>
          )}

          {/* TAB 2: RLS Policies & Roles */}
          {activeTab === 'rls' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/40">
                <h4 className="font-bold text-emerald-900 dark:text-emerald-300 text-sm mb-1 flex items-center gap-1.5">
                  <Shield className="w-4 h-4" /> Row Level Security (RLS) Architecture
                </h4>
                <p className="text-emerald-800/90 dark:text-emerald-300/80 text-xs leading-relaxed">
                  The schema enforces granular security at the database engine level. Even if a user attempts direct database queries, PostgreSQL restricts access based on their authenticated user role in <code>public.profiles</code>.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-line bg-sunken">
                  <h5 className="font-bold text-ink mb-2">Admin Permissions:</h5>
                  <ul className="space-y-1.5 list-disc pl-4 text-ink-soft">
                    <li>Create, update, and delete task definitions in <code>tasks</code></li>
                    <li>Assign tasks to all team members or specific worker emails</li>
                    <li>Execute manual and scheduled daily board resets</li>
                    <li>Query and export all historical archive snapshots in <code>history_logs</code></li>
                    <li>View live presence and audit trails for all workers</li>
                  </ul>
                </div>

                <div className="p-4 rounded-xl border border-line bg-sunken">
                  <h5 className="font-bold text-ink mb-2">Worker Permissions:</h5>
                  <ul className="space-y-1.5 list-disc pl-4 text-ink-soft">
                    <li>View active tasks assigned to the team or to their specific email</li>
                    <li>Mark completion status (Yes/No, Toggle, Status dropdown, Checkbox)</li>
                    <li>Write and update details in the multi-line <code>notes</code> field</li>
                    <li>Cannot delete or edit task configuration parameters</li>
                    <li>Automated attribution records their authenticated identity on update</li>
                  </ul>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-line bg-surface">
                <h5 className="font-bold text-ink mb-1">Scheduled Midnight Reset Trigger:</h5>
                <p className="text-ink-soft mb-2">
                  The stored procedure <code>archive_and_reset_daily_tasks()</code> automatically:
                </p>
                <ol className="list-decimal pl-5 space-y-1 text-ink-soft">
                  <li>Copies previous day's completions & notes into <code>history_logs</code>.</li>
                  <li>Wipes previous day transient entries in <code>daily_task_completions</code>.</li>
                  <li>Initializes fresh pending records for today with zero status.</li>
                </ol>
              </div>
            </div>
          )}

          {/* TAB 3: Live Connection & Credentials */}
          {activeTab === 'connect' && (
            <div className="space-y-4 max-w-xl">
              <p className="text-ink-soft">
                Connect your external Supabase project to authenticate users and persist tasks directly to Supabase cloud. If left unconfigured, the app operates using the built-in real-time WebSocket server.
              </p>

              <form onSubmit={handleSaveConfig} className="space-y-3">
                <div>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Supabase Project URL
                  </label>
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://xyzcompany.supabase.co"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink font-mono focus:outline-none focus:border-gold transition-colors"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-ink-soft mb-1">
                    Supabase Anon Public API Key
                  </label>
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    className="w-full text-xs px-3 py-2 rounded-xl border border-line bg-sunken text-ink font-mono focus:outline-none focus:border-gold transition-colors"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl pressable bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer"
                  >
                    Save & Connect Supabase
                  </button>
                  {config.isConfigured && (
                    <button
                      type="button"
                      onClick={handleClear}
                      className="px-4 py-2 rounded-xl bg-sunken hover:brightness-95 text-ink-soft font-semibold pressable cursor-pointer"
                    >
                      Disconnect / Use Server State
                    </button>
                  )}
                </div>

                {saveSuccess && (
                  <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mt-2">
                    ✓ Configuration saved! Supabase client initialized.
                  </p>
                )}
              </form>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken text-right shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-surface border border-line text-ink-soft hover:brightness-95 pressable cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
