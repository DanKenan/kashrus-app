/**
 * K1 — kiosk code hand-off helpers (client only, zero cost).
 *
 * The admin's OWN phone apps send the code: a wa.me link, an sms: link, the
 * system share sheet, or the clipboard. Nothing is sent by the server and
 * nothing is stored: the digits live only in the one-time dialog's state.
 */

/** A random 4-digit code from the browser's CSPRNG, skipping the obvious
 * ones (all the same digit, straight runs like 1234 / 9876).
 * D3c (ChatGPT's #46 review): after 50 rejected picks it THROWS — there is
 * no fixed fallback code. The caller shows a message and saves nothing. */
export class KioskCodeGenerationError extends Error {
  constructor() {
    super("Couldn't make a code. Try again, or type one.");
    this.name = 'KioskCodeGenerationError';
  }
}

export function generateKioskCode(): string {
  const weak = (c: string) =>
    /^(\d)\1{3}$/.test(c) || '0123456789'.includes(c) || '9876543210'.includes(c);
  const buf = new Uint32Array(1);
  for (let i = 0; i < 50; i++) {
    crypto.getRandomValues(buf);
    const code = String(buf[0] % 10000).padStart(4, '0');
    if (!weak(code)) return code;
  }
  throw new KioskCodeGenerationError();
}

export const KIOSK_CODE_PATTERN = /^[0-9]{4,6}$/;

/** The ready-made message (gender-neutral, rule U). */
export function kioskCodeMessage(code: string): string {
  return `Your Shutfey kiosk code is ${code}. On the tablet, tap your name and enter it.`;
}

/**
 * Mirror of the server's normalizePhoneNumber (server.ts): E.164 or null.
 * "" → "" (clear). 10 digits → +1 (US), 11 digits starting 1 → +1…
 */
export function normalizePhone(raw: string): string | null {
  let p = (raw || '').trim();
  if (p === '') return '';
  if (p.length > 32) return null;
  p = p.replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^\d{10}$/.test(p)) p = '+1' + p;
  else if (/^1\d{10}$/.test(p)) p = '+' + p;
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
}

/** Opens WhatsApp on the admin's phone, on that person's chat, text typed. */
export function whatsappHref(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`;
}

/** Opens Messages with the number and text filled in ("?&body=" works on
 * both iOS and Android). */
export function smsHref(phoneE164: string, text: string): string {
  return `sms:${phoneE164}?&body=${encodeURIComponent(text)}`;
}

export function canWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function';
}

/** Copy to the clipboard; falls back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
