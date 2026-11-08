import React, { useState } from 'react';
import { Check } from 'lucide-react';
import type { Task } from '../types';
import { apiWrite } from '../lib/api';

export function TaskChecklist({ task, canFill, onUpdated, kiosk = false }: {
  task: Task;
  canFill: boolean;
  onUpdated?: (task: Task) => void;
  kiosk?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const items = task.checklistItems || [];
  const count = items.filter((_, item) => task.checklistTicks?.some((tick) => tick.item === item)).length;
  const toggle = async (item: number, ticked: boolean) => {
    if (!canFill || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await apiWrite<Task>(`/api/tasks/${task.id}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item, ticked }),
      });
      if (result.ok) onUpdated?.(result.data);
      else setError(result.error || "Couldn't save. Check the connection and try again.");
    } catch {
      setError("Couldn't save. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  };
  return <div className={`task-checklist${kiosk ? ' task-checklist-kiosk' : ''}`}>
    <div className="checklist-progress">
      <progress max={items.length || 1} value={count} aria-label="Checklist progress" />
      <p className={task.isCompleted ? 'text-ok' : 'text-ink-soft'} aria-live="polite"><strong>{count} of {items.length}</strong>{task.isCompleted ? ' · Done' : ''}{saving ? ' · Saving…' : ''}</p>
    </div>
    <ul>{items.map((label, item) => {
      const tick = task.checklistTicks?.find((entry) => entry.item === item);
      const content = <><span className="checklist-box" aria-hidden="true">{tick && <Check className="w-6 h-6" />}</span><span className="checklist-label"><span dir="auto">{label}</span>{tick && <span className="checklist-attribution"><bdi>{tick.byName?.trim().split(/\s+/)[0] || tick.byEmail || 'Someone'}</bdi> · {new Date(tick.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>}{!tick && canFill && <span className="checklist-hint">Tap when done</span>}</span></>;
      return <li key={item}>{canFill ? <button type="button" role="checkbox" aria-checked={!!tick} aria-label={label} disabled={saving} onClick={() => toggle(item, !tick)} className="checklist-row pressable">{content}</button> : <div role="checkbox" aria-checked={!!tick} aria-readonly="true" aria-label={label} className="checklist-row">{content}</div>}</li>;
    })}</ul>
    {error && <p role="alert" className="text-bad">{error}</p>}
  </div>;
}
