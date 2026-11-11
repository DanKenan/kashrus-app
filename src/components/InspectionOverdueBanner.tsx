import React, { useEffect, useState } from 'react';
import { visitButton, visitRequest } from './FactoryVisitScreen';
import { displayDate } from '../lib/visitSchedule';
type Alert = { companyId: string; companyName: string; nextDue: string; overdueDays: number; muted: boolean };
export function InspectionOverdueBanner({ membership, onOpen }: { key?: string; membership: string; onOpen(): void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]), [dismissed, setDismissed] = useState('');
  const key = `inspection-overdue:${membership}`;
  useEffect(() => {
    let active = true, last = -Infinity;
    setAlerts([]);
    try { setDismissed(localStorage.getItem(key) || ''); } catch { setDismissed(''); }
    const load = () => {
      if (document.visibilityState === 'hidden' || Date.now() - last < 600_000) return;
      last = Date.now();
      void visitRequest('/api/inspections/alerts').then(body => { if (active) setAlerts(body.alerts || []); }).catch(() => {});
    };
    load(); document.addEventListener('visibilitychange', load);
    return () => { active = false; document.removeEventListener('visibilitychange', load); };
  }, [key]);
  const visible = alerts.filter(alert => !alert.muted);
  const signature = JSON.stringify(alerts.map(alert => `${alert.companyId}:${alert.nextDue}`).sort());
  if (!visible.length || signature === dismissed) return null;
  return <aside aria-label="Overdue visits" className="mx-4 mt-4 space-y-2 rounded-xl border border-line bg-surface p-4 text-base text-ink"><div className="flex items-start gap-2"><p className="flex-1">⚠ {visible.length === 1 ? '1 company is' : `${visible.length} companies are`} overdue for a visit</p><button type="button" aria-label="Close" className={`${visitButton} h-11 w-11 shrink-0 px-0`} onClick={() => { setDismissed(signature); try { localStorage.setItem(key, signature); } catch { /* Dismiss for this session. */ } }}>×</button></div>{visible.slice(0, 3).map(alert => <p key={alert.companyId} dir="auto" className="whitespace-pre-wrap break-words">{alert.companyName} — due {displayDate(alert.nextDue)}</p>)}<button type="button" className={visitButton} onClick={onOpen}>See companies</button></aside>;
}
