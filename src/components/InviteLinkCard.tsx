import React, { useRef, useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';

// Item 10i: the invite link the admin sends, with a Copy button. The link
// works once and for 7 days (server INVITE_TTL_MS); it is shown only here,
// right after it is made, and never stored by the app.
interface InviteLinkCardProps {
  link: string;
  /** Who it is for, e.g. "Dana Cohen (dana@example.org)". */
  forWhom?: string;
  /** Default: "Send this link to the person." */
  hint?: string;
  onDone?: () => void;
  doneLabel?: string;
}

export const InviteLinkCard: React.FC<InviteLinkCardProps> = ({ link, forWhom, hint, onDone, doneLabel }) => {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('yes');
    } catch {
      // No clipboard access: select the text so it can be copied by hand.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopied('no');
    }
  };

  return (
    <div data-invite-link-card className="p-4 rounded-2xl bg-ok-bg border border-ok space-y-3 text-sm">
      <div className="flex items-start gap-2">
        <Link2 className="w-4 h-4 shrink-0 mt-0.5 text-ok" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-bold text-ink">Invite link ready</p>
          {forWhom && <p className="text-ink-soft break-words">For {forWhom}</p>}
        </div>
      </div>
      <p className="text-ink">{hint || 'Send this link to the person.'} They open it and choose their own password.</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <label htmlFor="invite-link-input" className="sr-only">Invite link</label>
        <input
          id="invite-link-input"
          ref={inputRef}
          type="text"
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 px-3 py-2 bg-surface border border-line-control rounded-lg text-base text-ink font-mono focus:outline-none focus:ring-2 focus:ring-gold/40 focus:border-gold"
        />
        <button
          type="button"
          data-invite-copy
          onClick={copy}
          className="pressable min-h-11 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 e1 cursor-pointer shrink-0 bg-gold-deep text-paper"
        >
          {copied === 'yes' ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
          <span>{copied === 'yes' ? 'Copied' : 'Copy link'}</span>
        </button>
      </div>
      <p role="status" className="text-ink-soft">
        {copied === 'yes' ? 'Link copied.' : copied === 'no' ? "Couldn't copy here. The link is selected; copy it by hand." : 'The link works once, for 7 days.'}
      </p>
      {onDone && (
        <button
          type="button"
          data-invite-done
          onClick={onDone}
          className="min-h-11 px-4 rounded-xl font-semibold bg-surface border border-line text-ink hover:bg-sunken cursor-pointer"
        >
          {doneLabel || 'Done'}
        </button>
      )}
    </div>
  );
};
