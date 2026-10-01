import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, X, Check, RotateCcw } from 'lucide-react';

interface MonthlyCalendarPickerProps {
  selectedDates: string[]; // ['YYYY-MM-DD', ...]
  onToggleDate: (dateStr: string) => void;
  onClearAll: () => void;
  onSelectToday: () => void;
  onSelectTomorrow: () => void;
}

export const MonthlyCalendarPicker: React.FC<MonthlyCalendarPickerProps> = ({
  selectedDates,
  onToggleDate,
  onClearAll,
  onSelectToday,
  onSelectTomorrow,
}) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState<number>(today.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(today.getMonth()); // 0-indexed

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((prev) => prev - 1);
    } else {
      setViewMonth((prev) => prev - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((prev) => prev + 1);
    } else {
      setViewMonth((prev) => prev + 1);
    }
  };

  const handleJumpToToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  };

  // Compute days in current month
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sun, 1 = Mon ...
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Create grid cells
  const dayCells = [];
  for (let i = 0; i < firstDayOfMonth; i++) {
    dayCells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    dayCells.push(d);
  }

  const formatChipDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-');
    if (!y || !m || !d) return dateStr;
    const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    return dateObj.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    });
  };

  // Sort selected dates chronologically
  const sortedSelected = [...selectedDates].sort();

  return (
    <div className="bg-sunken rounded-2xl border border-line p-3.5 space-y-3">
      {/* Calendar Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarIcon className="w-4 h-4 text-gold-deep" />
          <span className="font-bold text-ink text-xs sm:text-sm">
            {monthNames[viewMonth]} {viewYear}
          </span>
          {(viewMonth !== today.getMonth() || viewYear !== today.getFullYear()) && (
            <button
              type="button"
              onClick={handleJumpToToday}
              className="text-[10px] text-gold-deep hover:underline font-semibold"
            >
              (Current)
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="p-1.5 rounded-lg text-ink-soft hover:bg-surface transition pressable"
            title="Previous Month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleNextMonth}
            className="p-1.5 rounded-lg text-ink-soft hover:bg-surface transition pressable"
            title="Next Month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Weekday Labels */}
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-ink-faint uppercase tracking-wider">
        <span>Sun</span>
        <span>Mon</span>
        <span>Tue</span>
        <span>Wed</span>
        <span>Thu</span>
        <span>Fri</span>
        <span>Sat</span>
      </div>

      {/* Calendar Days Grid */}
      <div className="grid grid-cols-7 gap-1">
        {dayCells.map((dayNum, index) => {
          if (dayNum === null) {
            return <div key={`empty-${index}`} className="h-8 sm:h-9" />;
          }

          const dateString = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
          const isSelected = selectedDates.includes(dateString);
          const isToday = dateString === todayStr;

          return (
            <button
              key={dateString}
              type="button"
              onClick={() => onToggleDate(dateString)}
              className={`h-8 sm:h-9 rounded-xl text-xs font-semibold tnum flex flex-col items-center justify-center relative transition pressable ${
                isSelected
                  ? 'bg-gold text-white tactile-1 font-bold ring-1 ring-gold/30'
                  : isToday
                  ? 'bg-surface text-gold-deep border border-gold/40 font-bold'
                  : 'bg-surface text-ink-soft hover:bg-sunken border border-line/60'
              }`}
            >
              <span>{dayNum}</span>
              {isSelected ? (
                <span className="w-1 h-1 rounded-full bg-white mt-0.5" />
              ) : isToday ? (
                <span className="w-1 h-1 rounded-full bg-gold mt-0.5" />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Quick Selection Helpers */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-line/60 text-xs">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={onSelectToday}
            className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-surface hover:bg-sunken text-ink-soft transition border border-line pressable"
          >
            + Today
          </button>
          <button
            type="button"
            onClick={onSelectTomorrow}
            className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-surface hover:bg-sunken text-ink-soft transition border border-line pressable"
          >
            + Tomorrow
          </button>
        </div>

        {selectedDates.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> Clear dates ({selectedDates.length})
          </button>
        )}
      </div>

      {/* Selected Dates Display Chips */}
      {sortedSelected.length > 0 ? (
        <div className="pt-1.5 space-y-1">
          <div className="text-[11px] font-bold text-ink-soft">
            Assigned on ({sortedSelected.length} {sortedSelected.length === 1 ? 'day' : 'days'}):
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {sortedSelected.map((ds) => (
              <span
                key={ds}
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-semibold bg-gold-wash text-gold-ink border border-gold/40"
              >
                <Check className="w-3 h-3" />
                <span>{formatChipDate(ds)}</span>
                <button
                  type="button"
                  onClick={() => onToggleDate(ds)}
                  className="hover:text-rose-600 ml-0.5"
                  title="Remove this date"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-gold-deep bg-gold-wash p-2 rounded-xl border border-gold/40">
          ⚠️ Please click one or more days on the calendar above to assign this task.
        </div>
      )}
    </div>
  );
};
