import React, { useRef, useState } from 'react';
import type { PlaceKind } from '../lib/foodService';
import { foodWrite } from './ChecklistTemplatesScreen';
import { visitButton } from './FactoryVisitScreen';

export function PlaceKindFlip({ companyId, currentKind, disabled, onChanged, onError }: {
  companyId: string;
  currentKind: PlaceKind;
  disabled?: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function flip() {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onError('');
    try {
      const ids = [companyId];
      await foodWrite('/api/food-service/marked', 'PUT', currentKind === 'factory'
        ? { add: ids, factoryRemove: ids }
        : { factoryAdd: ids, remove: ids });
      onChanged();
    } catch {
      onError('The change was not saved. Try again.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <button type="button" className={visitButton} disabled={disabled || busy} onClick={() => void flip()}>
    {currentKind === 'factory' ? 'Mark as food service' : 'Mark as a factory'}
  </button>;
}
