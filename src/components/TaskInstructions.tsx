import React, { useState } from 'react';
import { ScrollText, ChevronDown, ChevronUp } from 'lucide-react';

/** INSTRBOLD (Don, Oct 27): the task's instructions stand out on the card so a mashgiach can't miss them. */
export const INSTRUCTIONS_HEADING = 'Inspection Instructions & Halachic Notes';

/** Long notes start clamped to 4 lines with "Show all"; short ones always show in full. */
export const isLongInstructions = (text: string): boolean =>
  text.length > 180 || text.split('\n').length > 4;

interface TaskInstructionsProps {
  text?: string | null;
}

/** Tinted box with an ink accent bar, a bold heading with an icon, and ink body text. Renders nothing when empty. */
export const TaskInstructions: React.FC<TaskInstructionsProps> = ({ text }) => {
  const [open, setOpen] = useState(false);
  const body = (text || '').trim();
  if (!body) return null;
  const long = isLongInstructions(body);
  return (
    <section
      data-task-instructions
      aria-label={INSTRUCTIONS_HEADING}
      className="mt-2 rounded-lg bg-sunken border border-line border-l-4 border-l-ink px-3 py-2.5"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-bold text-ink">
        <ScrollText className="w-4 h-4 shrink-0" aria-hidden />
        <span>{INSTRUCTIONS_HEADING}</span>
      </h4>
      <p
        dir="auto"
        className={`mt-1 text-sm font-medium text-ink leading-relaxed whitespace-pre-line break-words ${long && !open ? 'line-clamp-4' : ''}`}
      >
        {body}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="pressable mt-0.5 min-h-11 inline-flex items-center gap-1 text-xs font-semibold text-ink-soft hover:text-ink cursor-pointer"
        >
          {open ? <ChevronUp className="w-4 h-4" aria-hidden /> : <ChevronDown className="w-4 h-4" aria-hidden />}
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </section>
  );
};
