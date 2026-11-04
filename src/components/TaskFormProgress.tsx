import React from 'react';
import { Pencil } from 'lucide-react';

const names = ['What', 'When', 'Who'];
interface Props {
  step: number;
  count: number;
  summaries: string[];
  onEdit: (step: number) => void;
}
export function TaskFormProgress({ step, count, summaries, onEdit }: Props) {
  return <>
    <nav aria-label="Task steps" className="task-form-progress">
      {names.map((name, i) => <React.Fragment key={name}>
        {i > 0 && <span aria-hidden="true" className={`task-form-connector ${i <= step ? 'is-done' : ''}`} />}
        <span aria-current={step === i ? 'step' : undefined} data-step-name={name} className={`task-form-step ${i === step ? 'is-current' : i < step ? 'is-done' : ''}`}>
          <span aria-hidden="true" className="task-form-step-number">{i < step ? '✓' : i + 1}</span>
          <span className="task-form-step-name">{i === 0 && step > 0 && count > 1 ? `${count} tasks` : name}</span>
        </span>
      </React.Fragment>)}
    </nav>
    {names.slice(0, step).map((name, i) => <button key={name} type="button" aria-label={`Edit ${name}`} onClick={() => onEdit(i)} className="task-form-summary pressable">
      <span aria-hidden="true" className="task-form-summary-number">{i + 1}</span>
      <span className="task-form-summary-name">{name}</span>
      <span className="task-form-summary-value">{i === 1 && <span aria-hidden="true" className="task-when-summary-dot" />}{summaries[i]}</span>
      <Pencil aria-hidden="true" className="w-4 h-4 shrink-0 text-ink-soft" />
    </button>)}
  </>;
}
