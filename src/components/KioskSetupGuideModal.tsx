import { createElement, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Grid2X2, QrCode } from 'lucide-react';
import { detectKioskDevice, KIOSK_LOCK_GUIDES, type KioskDeviceFamily } from '../lib/kioskGuide';
import { KioskGuideDeviceSwitcher, KioskGuideDialog, kioskGuidePrimary } from './KioskLockGuideModal';
import { KioskOverviewMockup, KioskVideoWalkthrough } from './KioskVideoWalkthrough';

interface SetupGuideProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenLockGuide: (device: KioskDeviceFamily) => void;
  initialDevice?: KioskDeviceFamily;
}

function SetupStep({ number, title, emphasized = false, children }: {
  number: number; title: string; emphasized?: boolean; children: ReactNode;
}) {
  return (
    <li className={`space-y-3 rounded-2xl border bg-sunken p-4 ${emphasized ? 'border-gold' : 'border-line'}`}>
      <h3 className="flex items-center gap-2 font-bold">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gold-wash text-xs text-gold-deep">{number}</span>
        {title}
      </h3>
      {children}
    </li>
  );
}

export function KioskSetupGuideModal({ isOpen, ...props }: SetupGuideProps) {
  return isOpen ? createElement(SetupGuide, { ...props, key: props.initialDevice ?? 'detected' }) : null;
}

function SetupGuide({ onClose, initialDevice, onOpenLockGuide }: Omit<SetupGuideProps, 'isOpen'>) {
  const [detected] = useState(detectKioskDevice);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice ?? detected.family);
  const activeGuide = KIOSK_LOCK_GUIDES[selectedDevice];
  return (
    <KioskGuideDialog titleId="kiosk-setup-guide-title" title="Kiosk setup guide"
      subtitle="Everything to set up, lock, and run a kiosk on any device." onClose={onClose}
      footer={<button type="button" className="min-h-11 w-full rounded-xl border border-line-control bg-surface text-sm font-bold text-ink hover:bg-sunken" onClick={onClose}>Done</button>}>
      <KioskGuideDeviceSwitcher detected={detected} selected={selectedDevice} onSelect={setSelectedDevice} />
      <KioskVideoWalkthrough mode="overview" />
      <ol className="space-y-3">
        <SetupStep number={1} title="Install Shutfey full-screen">
          <div className="grid items-center gap-3 sm:grid-cols-[auto_1fr]">
            <KioskOverviewMockup visual="install" />
            <div className="text-sm text-ink-soft">
              <p className="font-semibold text-ink">Hides browser tabs &amp; address bar</p>
              <p className="mt-1">{activeGuide.installTip}</p>
            </div>
          </div>
        </SetupStep>
        <SetupStep number={2} title="Enter kiosk mode & pair to a venue">
          <KioskOverviewMockup visual="pair" />
          <p className="text-sm text-ink-soft">On the kiosk device, choose Menu → Enter kiosk mode. On your phone or laptop, open Kiosk tablets, enter the displayed code, and select the venue.</p>
        </SetupStep>
        <SetupStep number={3} title={`Lock this device (${activeGuide.switcherLabel})`} emphasized>
          <p className="text-sm text-ink-soft">{activeGuide.hubSummary}</p>
          <button type="button" className={`${kioskGuidePrimary} inline-flex items-center justify-center gap-2`} onClick={() => onOpenLockGuide(selectedDevice)}>
            Open visual lock &amp; unlock steps <ArrowRight size={16} aria-hidden="true" />
          </button>
        </SetupStep>
        <SetupStep number={4} title="How staff sign in">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl border border-line bg-surface p-3">
              <QrCode size={19} className="mb-1 text-gold-deep" aria-hidden="true" />
              <p className="font-bold">Scan QR code</p>
              <p className="text-ink-soft">Fastest — staff scan with their phone</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <Grid2X2 size={19} className="mb-1 text-gold-deep" aria-hidden="true" />
              <p className="font-bold">4–6 digit PIN</p>
              <p className="text-ink-soft">Tap “Use your code instead”</p>
            </div>
          </div>
          <p className="text-sm text-ink-soft">Auto signs out after 5 minutes of inactivity so the next worker starts fresh.</p>
        </SetupStep>
        <SetupStep number={5} title="Keep it running & unpair">
          <ul className="space-y-2 text-sm text-ink-soft">
            {[
              'Keep it plugged in and set screen auto-lock to Never or the longest available setting.',
              'Use a regular browser window. Private or Incognito mode forgets pairing on restart.',
              'Unpair anytime from Menu → Kiosk tablets → Unpair.',
            ].map((item) => <li key={item} className="flex items-start gap-2"><Check size={16} className="mt-0.5 shrink-0 text-gold-deep" aria-hidden="true" />{item}</li>)}
          </ul>
        </SetupStep>
      </ol>
    </KioskGuideDialog>
  );
}
