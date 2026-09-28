import React, { useState } from 'react';
import { X, Calendar, Download, CheckCircle2, Search, ArrowLeft, Clock, FileSpreadsheet } from 'lucide-react';
import { DailySnapshot } from '../types';
import { formatExactTime } from '../lib/utils';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-4xl shadow-2xl border border-slate-200 dark:border-slate-800 my-8 overflow-hidden flex flex-col max-h-[88vh] transition-colors">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-500" />
              Daily Task History & Audit Log
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Review retained past daily board records, mashgiach sign-offs, and compliance notes.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body: Left Sidebar (dates) + Right Panel (entries) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          
          {/* Left: Date Snapshots List */}
          <div className="w-full md:w-64 border-r border-slate-100 dark:border-slate-800 p-3 overflow-y-auto shrink-0 bg-slate-50/50 dark:bg-slate-900/40">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-2 px-2">
              Archived Board Days
            </span>
            {historyLogs.length === 0 ? (
              <p className="text-xs text-slate-400 px-2 py-4">No archives recorded yet.</p>
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
                          ? 'bg-white dark:bg-slate-800 shadow-xs border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold">{snap.date}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          snap.completionRate === 100 
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' 
                            : 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300'
                        }`}>
                          {snap.completionRate}%
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400">
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
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900 dark:text-white">
                      Archive: {selectedSnapshot.date}
                    </span>
                    <span className="text-xs text-slate-400">
                      (Reset by {selectedSnapshot.resetBy})
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Search */}
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-8 pr-3 py-1.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                      />
                    </div>

                    {/* CSV Export */}
                    <button
                      id="export-csv-btn"
                      onClick={handleExportCSV}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export CSV</span>
                    </button>
                  </div>
                </div>

                {/* Audit Entries Table */}
                <div className="flex-1 overflow-y-auto mt-3">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 dark:border-slate-800 pb-2">
                        <th className="py-2 px-2">Task</th>
                        <th className="py-2 px-2">Status</th>
                        <th className="py-2 px-2">Attributed Mashgiach / User</th>
                        <th className="py-2 px-2">Notes & Remarks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {currentEntries.map((entry) => (
                        <tr key={entry.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                          <td className="py-2.5 px-2 align-top">
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {entry.taskTitle}
                            </div>
                            <span className="text-[10px] text-slate-400">{entry.category}</span>
                          </td>
                          <td className="py-2.5 px-2 align-top">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              entry.isCompleted
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                            }`}>
                              {entry.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-2 align-top text-slate-700 dark:text-slate-300">
                            {entry.completedByName || entry.completedByEmail ? (
                              <div>
                                <p className="font-medium text-slate-900 dark:text-white">{entry.completedByName || entry.completedByEmail}</p>
                                <p className="text-[10px] text-slate-400">{formatExactTime(entry.completedAt)}</p>
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">Unassigned</span>
                            )}
                          </td>
                          <td className="py-2.5 px-2 align-top text-slate-600 dark:text-slate-400 max-w-[200px]">
                            {entry.notes ? (
                              <p className="whitespace-pre-wrap">{entry.notes}</p>
                            ) : (
                              <span className="text-slate-400 italic">No notes</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-xs">
                Select a date archive to view details.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-right shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 text-slate-800 dark:text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
