import React from 'react';
import { Users, User, Lock } from 'lucide-react';
import { whoSeesLabel } from '../lib/whoSees';

export function WhoSeesTag({ label, kiosk = false }: { kiosk?: boolean; label: ReturnType<typeof whoSeesLabel> }) {
  const Icon = label.icon === 'private' ? Lock : label.icon === 'person' ? User : Users;
  return <span title={label.title} className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-sunken px-2 py-1 text-ink-soft ${kiosk ? 'text-base' : 'text-xs'}`}><Icon className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{label.text}</span>{label.title && <span className="sr-only">{label.title}</span>}</span>;
}
