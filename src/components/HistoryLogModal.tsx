import { ProgressRing } from './ProgressRing';
import React, { useState } from 'react';
import { X, Calendar, Download, Search } from 'lucide-react';
import { DailySnapshot } from '../types';
import { formatExactTime } from '../lib/utils';
import { categoryVars } from '../lib/categoryStyle';

interface HistoryLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  historyLogs: DailySnapshot[];
}

export const HistoryLogModal: React.FC<HistoryLogModalProps> = ({
  isOpen,
  onClose,
  historyLogs,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeSnapshot = historyLogs.find((s) => s.id === selectedId) ?? historyLogs[0] ?? null;
  const [searchTerm, setSearchTerm] = useState('');

  if (!isOpen) return null;

  const currentEntries = activeSnapshot?.entries.filter((entry) => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      entry.taskTitle.toLowerCase().includes(q) ||
      (entry.completedByName || '').toLowerCase().includes(q) ||
      (entry.completedByEmail || '').toLowerCase().includes(q) ||
      (entry.notes || '').toLowerCase().includes(q) ||
      entry.category.toLowerCase().includes(q)
    );
  }) || [];

  const handleExportCSV = () => {
    if (!activeSnapshot) return;
    const headers = ['Date', 'Task Title', 'Category', 'Status', 'Completed', 'Completed By Name', 'Completed By Email', 'Time', 'Notes'];
    const rows = activeSnapshot.entries.map((e) => [
      activeSnapshot.date,
      `"${e.taskTitle.replace(/"/g, '""')}"`,
      `"${e.category}"`,
      e.status,
      e.isCompleted ? 'YES' : 'NO',
      `"${e.completedByName || ''}"`,
      `"${e.completedByEmail || ''}"`,
      e.completedAt ? new Date(e.completedAt).toLocaleTimeString() : '',
      `"${(e.notes || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `daily_tasks_archive_${activeSnapshot.date}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-surface rounded-2xl w-full max-w-4xl tactile-5 animate-slide-up border border-line my-8 overflow-hidden flex flex-col max-h-[88vh] transition-colors">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="text-base font-bold text-ink flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gold-deep" />
              Daily Task History & Audit Log
            </h2>
            <p className="text-xs text-ink-soft">
              Review retained past daily board records, mashgiach sign-offs, and compliance notes.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-faint hover:text-ink"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body: Left Sidebar (dates) + Right Panel (entries) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          
          {/* Left: Date Snapshots List */}
          <div className="w-full md:w-64 border-r border-line p-3 overflow-y-auto shrink-0 bg-sunken/50">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-faint block mb-2 px-2">
              Archived Board Days
            </span>
            {historyLogs.length === 0 ? (
              <p className="text-xs text-ink-faint px-2 py-4">No archives recorded yet.</p>
            ) : (
              <div className="space-y-1">
                {historyLogs.map((snap) => {
                  const isSelected = activeSnapshot?.id === snap.id;
                  return (
                    <button
                      key={snap.id}
                      onClick={() => setSelectedId(snap.id)}
                      className={`w-full text-left p-2.5 rounded-xl text-xs transition flex flex-col gap-1 ${
                        isSelected
                          ? 'bg-surface tactile-1 border border-line text-ink'
                          : 'text-ink-soft hover:bg-surface/60'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2 w-full">
                        <span data-ledger-day-ring className="shrink-0"><ProgressRing done={snap.completedTasks} total={snap.totalTasks} size={24} /></span>
                        <span className="font-bold tnum min-w-0 break-words flex-1">{snap.date}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tnum ${
                          snap.completionRate === 100 
                            ? 'bg-ok-bg text-ok'
                            : 'bg-gold-wash text-gold-ink'
                        }`}>
                          {snap.completionRate}%
                        </span>
                      </div>
                      <span className="text-[10px] text-ink-faint tnum">
                        {snap.completedTasks}/{snap.totalTasks} completed
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Selected Date Audit Trail */}
          <div className="min-w-0 flex-1 flex flex-col overflow-hidden p-4">
            {activeSnapshot ? (
              <>
                {/* Actions Toolbar */}
                <div className="flex flex-col sm:flex-row sm:items-center flex-wrap justify-between gap-3 pb-3 border-b border-line shrink-0">
                  <div className="flex flex-wrap min-w-0 break-words items-center gap-2">
                    <span className="text-sm font-bold text-ink">
                      Archive: {activeSnapshot.date}
                    </span>
                    <span className="text-xs text-ink-faint">
                      (Reset by {activeSnapshot.resetBy})
                    </span>
                  </div>

                  <div className="flex flex-wrap min-w-0 items-center gap-2">
                    {/* Search */}
                    <div className="relative min-w-0 max-w-full">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
                      <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full min-w-0 pl-8 pr-3 py-1.5 text-base rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                      />
                    </div>

                    {/* CSV Export */}
                    <button
                      id="export-csv-btn"
                      onClick={handleExportCSV}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl pressable bg-ok-bg hover:bg-sunken text-ok tactile-1 transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export CSV</span>
                    </button>
                  </div>
                </div>

                {/* Audit Entries */}
                <div className="flex-1 overflow-y-auto mt-3">
                  {currentEntries.length === 0 ? (
                    <p className="text-xs text-ink-faint text-center py-8">
                      No log entries found.
                    </p>
                  ) : (
                    <div className="min-w-0">
                      <div className="hidden sm:grid sm:grid-cols-[96px_160px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line py-2 text-xs font-semibold uppercase tracking-wider text-ink-soft">
                        <span className="min-w-0 break-words">Time</span><span className="min-w-0 break-words">Person</span><span className="min-w-0 break-words">What happened</span><span className="min-w-0 break-words">Notes</span>
                      </div>
                      {currentEntries.map((entry) => {
                        const statusLower = entry.status.toLowerCase();
                        const isRemoved = /remov|delet|cancel/.test(statusLower);
                        const dotClass = entry.isCompleted
                          ? 'bg-ok'
                          : isRemoved
                            ? 'bg-bad'
                            : 'bg-gold';
                        return (
                          <div
                            key={entry.id}
                            data-ledger-row
                            className="min-w-0 border-b border-line py-3 grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[96px_160px_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"
                          >
                            <div className="min-w-0 tnum text-ink-soft break-words">
                              {(entry.completedByName || entry.completedByEmail) && <>{formatExactTime(entry.completedAt)}<span className="sm:hidden"> ·</span></>}
                            </div>
                            <div dir="auto" className="min-w-0 break-words text-ink-soft">
                              {entry.completedByName || entry.completedByEmail ? (
                                <span className="font-medium text-ink">{entry.completedByName || entry.completedByEmail}</span>
                              ) : (
                                <span className="text-ink-faint italic">Unassigned</span>
                              )}
                            </div>
                            <div className="col-span-2 sm:col-span-1 min-w-0">
                              <div dir="auto" className="font-semibold text-ink break-words">
                                {entry.taskTitle}
                              </div>
                              <div className="flex flex-wrap items-start gap-2 mt-1">
                                <span
                                  className="cat-chip border text-[10px] font-bold px-1.5 py-0.5 rounded-full inline-flex min-w-0 break-words"
                                  style={categoryVars(entry.category)}
                                >
                                  {entry.category}
                                </span>
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sunken border border-line text-[10px] font-bold uppercase text-ink-soft min-w-0 break-words">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
                                  <span className="min-w-0 break-words">{entry.status}</span>
                                </span>
                              </div>
                            </div>
                            <div className="col-span-2 sm:col-span-1 min-w-0 text-ink-soft break-words">
                              {entry.notes ? (
                                <p dir="auto" className="whitespace-pre-wrap break-words">{entry.notes}</p>
                              ) : (
                                <span className="text-ink-faint italic">No notes</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-ink-faint text-xs">
                Select a date archive to view details.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-line bg-sunken/50 text-right shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-xl pressable bg-sunken border border-line text-ink-soft hover:text-ink"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
