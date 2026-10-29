import React from 'react';
import { BellRing, X } from 'lucide-react';
import { PUSH_PROMPT_TEXT, type PushPromptKind } from '../lib/pushPrompt';

// PUSHALWAYS: the phone banner for people whose phone gets no alerts yet.
// "Turn on" is the one tap the phone needs (its permission prompt); the
// iPhone browser and a blocked phone get a short how-to instead.
export function PushPrompt({
  kind,
  busy,
  onTurnOn,
  onDismiss,
}: {
  kind: PushPromptKind;
  busy: boolean;
  onTurnOn: () => void;
  onDismiss: () => void;
}) {
  return (
    <div data-push-prompt={kind} role="status" className="bg-sunken border-b border-line-control text-ink">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3">
        <BellRing className="w-5 h-5 shrink-0 text-gold-deep" />
        <p className="text-sm font-semibold flex-1 min-w-0 leading-snug">{PUSH_PROMPT_TEXT[kind]}</p>
        {kind === 'turn-on' && (
          <button
            type="button"
            onClick={onTurnOn}
            disabled={busy}
            className="pressable shrink-0 px-3 h-11 flex items-center rounded-lg bg-gold-deep text-surface dark:text-paper text-sm font-bold cursor-pointer disabled:opacity-60"
          >
            {busy ? '…' : 'Turn on'}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Not now"
          className="pressable shrink-0 w-11 h-11 flex items-center justify-center rounded-lg bg-surface border border-line-control text-ink hover:bg-sunken cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
