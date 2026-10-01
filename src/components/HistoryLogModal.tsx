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
  const [selectedSnapshot, setSelectedSnapshot] = useState<DailySnapshot | null>(
    historyLogs.length > 0 ? historyLogs[0] : null
  );
  const [searchTerm, setSearchTerm] = useState('');

  if (!isOpen) return null;

  const currentEntries = selectedSnapshot?.entries.filter((entry) => {
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
    if (!selectedSnapshot) return;
    const headers = ['Date', 'Task Title', 'Category', 'Status', 'Completed', 'Completed By Name', 'Completed By Email', 'Time', 'Notes'];
    const rows = selectedSnapshot.entries.map((e) => [
      selectedSnapshot.date,
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
    link.setAttribute('download', `daily_tasks_archive_${selectedSnapshot.date}.csv`);
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
                  const isSelected = selectedSnapshot?.id === snap.id;
                  return (
                    <button
                      key={snap.id}
                      onClick={() => setSelectedSnapshot(snap)}
                      className={`w-full text-left p-2.5 rounded-xl text-xs transition flex flex-col gap-1 ${
                        isSelected
                          ? 'bg-surface tactile-1 border border-line text-ink'
                          : 'text-ink-soft hover:bg-surface/60'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold tnum">{snap.date}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tnum ${
                          snap.completionRate === 100 
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' 
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
          <div className="flex-1 flex flex-col overflow-hidden p-4">
            {selectedSnapshot ? (
              <>
                {/* Actions Toolbar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-line shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">
                      Archive: {selectedSnapshot.date}
                    </span>
                    <span className="text-xs text-ink-faint">
                      (Reset by {selectedSnapshot.resetBy})
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Search */}
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
                      <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-8 pr-3 py-1.5 text-xs rounded-xl bg-sunken border border-line text-ink placeholder-ink-faint focus:border-gold focus:outline-none"
                      />
                    </div>

                    {/* CSV Export */}
                    <button
                      id="export-csv-btn"
                      onClick={handleExportCSV}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl pressable bg-emerald-600 hover:bg-emerald-700 text-white tactile-1 transition"
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
                    <div className="space-y-2">
                      {currentEntries.map((entry) => {
                        const statusLower = entry.status.toLowerCase();
                        const isRemoved = /remov|delet|cancel/.test(statusLower);
                        const dotClass = entry.isCompleted
                          ? 'bg-emerald-500'
                          : isRemoved
                            ? 'bg-rose-500'
                            : 'bg-gold';
                        return (
                          <div
                            key={entry.id}
                            className="bg-surface tactile-1 border border-line rounded-xl p-3 flex flex-col sm:flex-row sm:items-start gap-2.5"
                          >
                            {/* Task + Category */}
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-ink text-xs">
                                {entry.taskTitle}
                              </div>
                              <span
                                className="cat-chip border text-[10px] font-bold px-1.5 py-0.5 rounded-full inline-flex mt-1"
                                style={categoryVars(entry.category)}
                              >
                                {entry.category}
                              </span>
                            </div>

                            {/* Status */}
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sunken border border-line text-[10px] font-bold uppercase text-ink-soft whitespace-nowrap self-start">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
                              {entry.status}
                            </span>

                            {/* Attributed Mashgiach / User */}
                            <div className="sm:w-40 shrink-0 text-xs text-ink-soft">
                              {entry.completedByName || entry.completedByEmail ? (
                                <div>
                                  <p className="font-medium text-ink truncate">{entry.completedByName || entry.completedByEmail}</p>
                                  <p className="text-[10px] text-ink-faint tnum">{formatExactTime(entry.completedAt)}</p>
                                </div>
                              ) : (
                                <span className="text-ink-faint italic">Unassigned</span>
                              )}
                            </div>

                            {/* Notes & Remarks */}
                            <div className="flex-1 min-w-0 text-xs text-ink-soft">
                              {entry.notes ? (
                                <p className="whitespace-pre-wrap">{entry.notes}</p>
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
