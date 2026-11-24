import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Lock, X } from 'lucide-react';
import { detectKioskDevice, KIOSK_DEVICE_ORDER, KIOSK_LOCK_GUIDES, type DetectedKioskDevice, type KioskDeviceFamily } from '../lib/kioskGuide';
import { KioskDeviceMockup, KioskVideoWalkthrough } from './KioskVideoWalkthrough';

interface LockGuideProps {
  isOpen: boolean;
  onClose: () => void;
  initialDevice?: KioskDeviceFamily;
  pairedVenueName?: string | null;
  onDoneToKiosk?: () => void;
}

interface GuideDialogProps {
  titleId: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

export function KioskGuideDialog({ titleId, title, subtitle, onClose, children, footer }: GuideDialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]');
      if (!focusable?.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!panel.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) closeButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    closeButton.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = originalOverflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const content = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim p-2 sm:p-5"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-description`}
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink e3 sm:max-h-[90dvh]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div>
            <h2 id={titleId} className="text-xl font-bold">{title}</h2>
            <p id={`${titleId}-description`} className="mt-1 text-sm text-ink-soft">{subtitle}</p>
          </div>
          <button ref={closeButton} type="button" aria-label="Close" onClick={onClose}
            className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-xl border border-line-control bg-surface hover:bg-sunken">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:px-6">{children}</div>
        <footer className="shrink-0 space-y-1 border-t border-line bg-surface p-3 sm:px-6">{footer}</footer>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export function KioskGuideDeviceSwitcher({ detected, selected, onSelect }: {
  detected: DetectedKioskDevice;
  selected: KioskDeviceFamily;
  onSelect: (device: KioskDeviceFamily) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ${detected.detected ? 'bg-ok-bg text-ok' : 'bg-sunken text-ink-soft'}`}>
          {detected.detected && <Check size={14} aria-hidden="true" />}
          {detected.detected ? `Detected: ${detected.detectedLabel}` : 'Choose your device'}
        </span>
        <span className="text-ink-soft">Different device? Switch below</span>
      </div>
      {!detected.detected && <p className="text-xs text-warn">Device not recognized. iPhone / iPad is only an example; select your actual device before following the steps.</p>}
      <div role="group" aria-label="Device type" className="flex flex-wrap gap-1.5">
        {KIOSK_DEVICE_ORDER.map((family) => (
          <button key={family} type="button" aria-pressed={family === selected} onClick={() => onSelect(family)}
            className={`min-h-11 rounded-full px-3 text-xs font-bold ${family === selected ? 'bg-gold-deep text-paper' : 'border border-line bg-sunken text-ink hover:border-line-strong'}`}>
            {KIOSK_LOCK_GUIDES[family].switcherLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

export const kioskGuidePrimary = 'min-h-11 w-full rounded-xl bg-gold-deep px-4 py-2 text-sm font-bold text-paper';

export function KioskLockGuideModal({ isOpen, ...props }: LockGuideProps) {
  return isOpen ? createElement(LockGuide, { ...props, key: props.initialDevice ?? 'detected' }) : null;
}

function LockGuide({ onClose, initialDevice, pairedVenueName, onDoneToKiosk }: Omit<LockGuideProps, 'isOpen'>) {
  const [detected] = useState(detectKioskDevice);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice ?? detected.family);
  const guide = KIOSK_LOCK_GUIDES[selectedDevice];
  const isPaired = pairedVenueName !== undefined;
  return (
    <KioskGuideDialog titleId="kiosk-lock-guide-title" title="Device access settings for Shutfey"
      subtitle="Use the strongest restriction supported by your device. Full screen alone is not a security lock." onClose={onClose}
      footer={<>
        <button type="button" className={kioskGuidePrimary} onClick={isPaired ? onDoneToKiosk ?? onClose : onClose}>
          {isPaired ? 'Done — Go to Kiosk Screen' : 'Done'}
        </button>
        {isPaired && <button type="button" onClick={onClose} className="min-h-11 w-full rounded-xl text-sm font-bold text-ink-soft hover:bg-sunken">Skip for now</button>}
      </>}>
      {isPaired && <p className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-3 py-1 text-sm font-semibold text-ok">
        <Check size={16} aria-hidden="true" /> Paired to {pairedVenueName || 'this venue'}
      </p>}
      <KioskGuideDeviceSwitcher detected={detected} selected={selectedDevice} onSelect={setSelectedDevice} />
      <KioskVideoWalkthrough mode="device" device={selectedDevice} />
      <ol className="space-y-3">
        {guide.steps.map((step) => (
          <li key={step.stepNumber} className="space-y-3 rounded-2xl border border-line bg-sunken p-4">
            <h3 className="flex items-center gap-2 font-bold">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gold-wash text-xs text-gold-deep">{step.stepNumber}</span>
              {step.title}
            </h3>
            <KioskDeviceMockup device={selectedDevice} step={step} />
            <p className="text-sm text-ink-soft">{step.description}</p>
          </li>
        ))}
      </ol>
      <aside className="flex items-start gap-2 rounded-2xl border border-gold/40 bg-warn-bg p-3.5 text-warn">
        <Lock size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div><h3 className="font-bold">{guide.unlockTitle}</h3><p className="mt-1 text-sm">{guide.unlockText}</p></div>
      </aside>
    </KioskGuideDialog>
  );
}
